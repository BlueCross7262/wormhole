import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createDaemon } from "./runner.js";

// ---------------------------------------------------------------------------
// 페이크: 호출 순서를 calls 배열에 기록한다. 실 FS/네트워크 없음.
// ---------------------------------------------------------------------------

interface FakeAutoSync {
  start(): Promise<void>;
  stop(): Promise<void>;
  startCount: number;
  stopCount: number;
}

interface FakeLock {
  acquire(): Promise<boolean>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  heartbeatCount: number;
  releaseCount: number;
}

function makeFakeAutoSync(calls: string[]): FakeAutoSync {
  return {
    startCount: 0,
    stopCount: 0,
    async start() {
      this.startCount++;
      calls.push("autoSync.start");
    },
    async stop() {
      this.stopCount++;
      calls.push("autoSync.stop");
    },
  };
}

function makeFakeLock(calls: string[], acquireResult: boolean): FakeLock {
  return {
    heartbeatCount: 0,
    releaseCount: 0,
    async acquire() {
      calls.push("lock.acquire");
      return acquireResult;
    },
    async heartbeat() {
      this.heartbeatCount++;
      calls.push("lock.heartbeat");
    },
    async release() {
      this.releaseCount++;
      calls.push("lock.release");
    },
  };
}

// 마이크로태스크 큐를 비워 await 체인이 정착하도록 한다(타이머 아님).
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------

describe("createDaemon", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
  });

  describe("start", () => {
    test("acquire=true → acquire 후 autoSync.start, 순서 보장", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 10_000 });

      await daemon.start();

      assert.equal(autoSync.startCount, 1);
      const acquireIdx = calls.indexOf("lock.acquire");
      const startIdx = calls.indexOf("autoSync.start");
      assert.ok(acquireIdx >= 0, "acquire 호출됨");
      assert.ok(startIdx >= 0, "autoSync.start 호출됨");
      assert.ok(acquireIdx < startIdx, "acquire 가 autoSync.start 보다 먼저");

      await daemon.shutdown();
    });

    test("heartbeat 인터벌이 스케줄되어 최소 1회 발화", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      // 아주 짧은 인터벌로 비-플래키하게 1회 발화 확인.
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 1 });

      await daemon.start();
      // 인터벌(1ms)이 발화하고 heartbeat 의 마이크로태스크가 정착할 때까지 대기.
      await new Promise((r) => setTimeout(r, 15));
      await flush();

      assert.ok(lock.heartbeatCount >= 1, "heartbeat 최소 1회 발화");

      await daemon.shutdown();
    });

    test("acquire=false → throw, autoSync.start 미호출", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, false);
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 10_000 });

      await assert.rejects(
        () => daemon.start(),
        /another daemon instance is already running/,
      );
      assert.equal(autoSync.startCount, 0, "autoSync.start 미호출");
      assert.ok(calls.includes("lock.acquire"));
      assert.ok(!calls.includes("autoSync.start"));
    });
  });

  describe("shutdown", () => {
    test("autoSync.stop 후 lock.release, 순서 보장", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 10_000 });

      await daemon.start();
      calls.length = 0; // start 흔적 제거 후 shutdown 순서만 검사.
      await daemon.shutdown();

      assert.equal(autoSync.stopCount, 1);
      assert.equal(lock.releaseCount, 1);
      const stopIdx = calls.indexOf("autoSync.stop");
      const releaseIdx = calls.indexOf("lock.release");
      assert.ok(stopIdx >= 0 && releaseIdx >= 0);
      assert.ok(stopIdx < releaseIdx, "stop 이 release 보다 먼저");
    });

    test("shutdown 후 heartbeat 더 이상 발화하지 않음(타이머 정리)", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 1 });

      await daemon.start();
      await daemon.shutdown();
      const after = lock.heartbeatCount;

      await new Promise((r) => setTimeout(r, 15));
      await flush();

      assert.equal(lock.heartbeatCount, after, "shutdown 후 heartbeat 증가 없음");
    });

    test("멱등성 — 두 번째 shutdown 은 안전한 no-op", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      const daemon = createDaemon({ autoSync, lock, heartbeatIntervalMs: 10_000 });

      await daemon.start();
      await daemon.shutdown();
      await daemon.shutdown();

      assert.equal(autoSync.stopCount, 1, "stop 은 1회만");
      assert.equal(lock.releaseCount, 1, "release 는 1회만");
    });

    test("start 없이 shutdown 호출해도 안전", async () => {
      const autoSync = makeFakeAutoSync(calls);
      const lock = makeFakeLock(calls, true);
      const daemon = createDaemon({ autoSync, lock });

      await daemon.shutdown();

      assert.equal(autoSync.stopCount, 1);
      assert.equal(lock.releaseCount, 1);
    });
  });
});
