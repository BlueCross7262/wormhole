import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { AsyncMutex, RemoteLock, withLock } from "./lock.js";
import { loadOrCreateMachineId } from "./machine.js";
import { PreconditionFailedError } from "../webdav/client.js";
import type { LockInfo, MachineId } from "../types.js";

// ---------------------------------------------------------------------------
// 인메모리 RemoteStore 스텁 (WebDAV 네트워크 없이 RemoteLock 격리 테스트)
// ---------------------------------------------------------------------------

interface StoreEntry {
  text: string;
  etag: string;
}

let etagCounter = 0;

class FakeRemoteStore {
  private store: Map<string, StoreEntry> = new Map();

  async getTextWithETag(
    p: string,
  ): Promise<{ text: string; etag: string | null } | null> {
    const entry = this.store.get(p);
    if (!entry) return null;
    return { text: entry.text, etag: entry.etag };
  }

  async putIfNoneMatch(p: string, data: string, _machineId: string): Promise<void> {
    if (this.store.has(p)) {
      throw new PreconditionFailedError("already exists", 412);
    }
    this.store.set(p, { text: data, etag: String(++etagCounter) });
  }

  async putIfMatch(
    p: string,
    data: string,
    etag: string | null,
    _machineId: string,
  ): Promise<void> {
    if (etag === null) {
      this.store.set(p, { text: data, etag: String(++etagCounter) });
      return;
    }
    const entry = this.store.get(p);
    if (!entry || entry.etag !== etag) {
      throw new PreconditionFailedError("etag mismatch", 412);
    }
    this.store.set(p, { text: data, etag: String(++etagCounter) });
  }

  async deleteFile(p: string): Promise<void> {
    this.store.delete(p);
  }

  clear(): void {
    this.store.clear();
  }

  raw(p: string): StoreEntry | undefined {
    return this.store.get(p);
  }
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeConfig(
  ttlMs: number,
  acquireRetries: number,
  acquireRetryDelayMs: number,
) {
  return {
    lock: { ttlMs, acquireRetries, acquireRetryDelayMs },
  } as unknown as import("../types.js").Config;
}

// ---------------------------------------------------------------------------
// describe: machine
// ---------------------------------------------------------------------------

describe("loadOrCreateMachineId", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-machine-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("비어 있지 않은 ID를 반환한다", async () => {
    const id = await loadOrCreateMachineId(tmpDir);
    assert.ok(id.length > 0, "machine id must be non-empty");
  });

  test("같은 stateDir 로 두 번 호출하면 같은 ID를 반환한다(안정성)", async () => {
    const dir = path.join(tmpDir, "stable");
    const id1 = await loadOrCreateMachineId(dir);
    const id2 = await loadOrCreateMachineId(dir);
    assert.equal(id1, id2);
  });

  test("파일에 기록된 UUID 형식이다", async () => {
    const dir = path.join(tmpDir, "uuid-check");
    const id = await loadOrCreateMachineId(dir);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(id, uuidRe);
  });

  test("서로 다른 tmpDir 는 서로 다른 ID를 생성한다(독립성)", async () => {
    const dir1 = path.join(tmpDir, "sep1");
    const dir2 = path.join(tmpDir, "sep2");
    const id1 = await loadOrCreateMachineId(dir1);
    const id2 = await loadOrCreateMachineId(dir2);
    assert.notEqual(id1, id2);
  });

  test("machine-id 파일이 이미 존재하면 파일 내용을 그대로 사용한다", async () => {
    const dir = path.join(tmpDir, "preexist");
    await fs.mkdir(dir, { recursive: true });
    const fixed = "fixed-machine-id-value";
    await fs.writeFile(path.join(dir, "machine-id"), fixed, "utf-8");
    const id = await loadOrCreateMachineId(dir);
    assert.equal(id, fixed);
  });

  test("stateDir 가 없으면 자동 생성한다", async () => {
    const dir = path.join(tmpDir, "nonexistent", "nested");
    const id = await loadOrCreateMachineId(dir);
    assert.ok(id.length > 0);
    const exists = await fs.stat(dir).then(() => true).catch(() => false);
    assert.ok(exists, "stateDir should have been created");
  });

  // machine.ts line 13: id.length > 0 가 false 인 경로 — 파일이 존재하지만 내용이 비어있음.
  // trim 후 길이가 0 이므로 return 을 건너뛰고 새 UUID 를 생성·저장해야 한다.
  test("machine-id 파일이 비어 있으면 새 UUID 를 생성하고 파일을 덮어쓴다", async () => {
    const dir = path.join(tmpDir, "empty-id");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "machine-id"), "   \n", "utf-8");

    const id = await loadOrCreateMachineId(dir);
    assert.ok(id.length > 0, "빈 파일에서 새 id 가 생성되어야 한다");

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(id, uuidRe, "생성된 id 는 UUID 형식이어야 한다");

    const written = (await fs.readFile(path.join(dir, "machine-id"), "utf-8")).trim();
    assert.equal(written, id, "생성된 id 가 파일에 저장되어야 한다");
  });
});

// ---------------------------------------------------------------------------
// describe: AsyncMutex
// ---------------------------------------------------------------------------

describe("AsyncMutex", () => {
  test("runExclusive는 fn의 반환값을 그대로 반환한다", async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    assert.equal(result, 42);
  });

  test("동시에 여러 fn이 큐잉되면 순차 실행된다", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    await Promise.all([
      mutex.runExclusive(async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
        order.push(1);
      }),
      mutex.runExclusive(async () => {
        order.push(2);
      }),
      mutex.runExclusive(async () => {
        order.push(3);
      }),
    ]);

    assert.deepEqual(order, [1, 2, 3]);
  });

  test("fn이 예외를 던져도 다음 큐 항목이 실행된다", async () => {
    const mutex = new AsyncMutex();
    const results: string[] = [];

    await Promise.all([
      mutex.runExclusive(async () => {
        throw new Error("oops");
      }).catch(() => results.push("error")),
      mutex.runExclusive(async () => {
        results.push("ok");
      }),
    ]);

    assert.deepEqual(results, ["error", "ok"]);
  });

  test("fn 예외는 호출자에게 전파된다", async () => {
    const mutex = new AsyncMutex();
    await assert.rejects(
      () => mutex.runExclusive(async () => { throw new Error("propagate"); }),
      /propagate/,
    );
  });
});

// ---------------------------------------------------------------------------
// describe: RemoteLock – acquire / release
// ---------------------------------------------------------------------------

describe("RemoteLock – acquire / release", () => {
  let store: FakeRemoteStore;
  const machineA = "machine-A" as MachineId;

  beforeEach(() => {
    store = new FakeRemoteStore();
  });

  test("락이 없을 때 acquire는 true를 반환한다", async () => {
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    const ok = await lock.acquire();
    assert.equal(ok, true);
  });

  test("acquire 후 lock.json에 자기 machineId가 기록된다", async () => {
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    await lock.acquire();
    const entry = store.raw("lock.json");
    assert.ok(entry, "lock.json should exist");
    const info = JSON.parse(entry!.text) as LockInfo;
    assert.equal(info.machineId, machineA);
  });

  test("release 후에는 lock.json이 삭제된다", async () => {
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    await lock.acquire();
    await lock.release();
    const entry = store.raw("lock.json");
    assert.equal(entry, undefined);
  });

  test("타머신이 유효 락을 보유하면 재시도 0회 시 false를 반환한다", async () => {
    const machineB = "machine-B" as MachineId;
    const lockB = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineB,
    );
    await lockB.acquire();

    const lockA = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    const ok = await lockA.acquire();
    assert.equal(ok, false);
  });

  test("acquireRetries 횟수만큼 재시도 후 false를 반환한다", async () => {
    const machineB = "machine-B" as MachineId;
    const lockB = new RemoteLock(
      store as never,
      makeConfig(60_000, 0, 0),
      machineB,
    );
    await lockB.acquire();

    const lockA = new RemoteLock(
      store as never,
      makeConfig(60_000, 2, 1),
      machineA,
    );
    const ok = await lockA.acquire();
    assert.equal(ok, false);
  });

  test("만료된 락은 다른 머신이 탈취할 수 있다", async () => {
    const machineB = "machine-B" as MachineId;
    const lockB = new RemoteLock(
      store as never,
      makeConfig(1, 0, 0),
      machineB,
    );
    await lockB.acquire();

    await new Promise<void>((r) => setTimeout(r, 5));

    const lockA = new RemoteLock(
      store as never,
      makeConfig(60_000, 0, 0),
      machineA,
    );
    const ok = await lockA.acquire();
    assert.equal(ok, true, "expired lock should be takeable");

    const entry = store.raw("lock.json");
    const info = JSON.parse(entry!.text) as LockInfo;
    assert.equal(info.machineId, machineA, "new owner should be machineA");
  });

  test("자기 소유 락은 재획득(갱신)할 수 있다", async () => {
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    await lock.acquire();
    const ok = await lock.acquire();
    assert.equal(ok, true);

    const entry = store.raw("lock.json");
    const info = JSON.parse(entry!.text) as LockInfo;
    assert.equal(info.machineId, machineA);
  });

  test("release는 타머신 락을 건드리지 않는다", async () => {
    const machineB = "machine-B" as MachineId;
    const lockB = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineB,
    );
    await lockB.acquire();

    const lockA = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    await lockA.release();

    const entry = store.raw("lock.json");
    assert.ok(entry, "machine-B lock must survive machine-A release call");
    const info = JSON.parse(entry!.text) as LockInfo;
    assert.equal(info.machineId, machineB);
  });

  test("락이 없을 때 release는 에러 없이 끝난다", async () => {
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      machineA,
    );
    await assert.doesNotReject(() => lock.release());
  });
});

// ---------------------------------------------------------------------------
// describe: RemoteLock – CAS 경쟁 시나리오
// ---------------------------------------------------------------------------

describe("RemoteLock – CAS 경쟁 (PreconditionFailedError)", () => {
  test("putIfNoneMatch 가 PreconditionFailed 를 던지면 재시도 후 false를 반환한다", async () => {
    const store = new FakeRemoteStore();
    const machineA = "machine-A" as MachineId;

    let callCount = 0;
    const patchedStore = {
      ...store,
      getTextWithETag: store.getTextWithETag.bind(store),
      putIfNoneMatch: async (_p: string, _d: string, _m: string) => {
        callCount++;
        throw new PreconditionFailedError("race", 412);
      },
      putIfMatch: store.putIfMatch.bind(store),
      deleteFile: store.deleteFile.bind(store),
    };

    const lock = new RemoteLock(
      patchedStore as never,
      makeConfig(5000, 1, 1),
      machineA,
    );
    const ok = await lock.acquire();
    assert.equal(ok, false);
    assert.equal(callCount, 2, "should try once + 1 retry = 2 calls");
  });
});

// ---------------------------------------------------------------------------
// describe: RemoteLock – read()
// ---------------------------------------------------------------------------

describe("RemoteLock – read()", () => {
  test("락 파일 없을 때 null을 반환한다", async () => {
    const store = new FakeRemoteStore();
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    const info = await lock.read();
    assert.equal(info, null);
  });

  test("손상된 JSON 이면 null을 반환한다", async () => {
    const store = new FakeRemoteStore();
    store["store"].set("lock.json", { text: "not-json{{{", etag: "1" });
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    const info = await lock.read();
    assert.equal(info, null);
  });

  test("유효한 lock.json은 LockInfo를 반환한다", async () => {
    const store = new FakeRemoteStore();
    const lockInfo: LockInfo = {
      machineId: "m" as MachineId,
      acquiredAt: Date.now(),
      ttlMs: 5000,
    };
    store["store"].set("lock.json", {
      text: JSON.stringify(lockInfo),
      etag: "1",
    });
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    const info = await lock.read();
    assert.ok(info !== null);
    assert.equal(info!.machineId, "m");
  });
});

// ---------------------------------------------------------------------------
// describe: withLock
// ---------------------------------------------------------------------------

describe("withLock", () => {
  test("acquire 성공 시 fn을 실행하고 결과를 반환한다", async () => {
    const store = new FakeRemoteStore();
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    const result = await withLock(lock, async () => "done");
    assert.equal(result, "done");
  });

  test("fn 완료 후 자동 release 된다", async () => {
    const store = new FakeRemoteStore();
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    await withLock(lock, async () => "ok");
    const entry = store.raw("lock.json");
    assert.equal(entry, undefined, "lock should be released after withLock");
  });

  test("fn이 예외를 던져도 release를 호출한다", async () => {
    const store = new FakeRemoteStore();
    const lock = new RemoteLock(
      store as never,
      makeConfig(5000, 0, 0),
      "m" as MachineId,
    );
    await assert.rejects(
      () => withLock(lock, async () => { throw new Error("fn-error"); }),
      /fn-error/,
    );
    const entry = store.raw("lock.json");
    assert.equal(entry, undefined, "lock must be released even on fn error");
  });

  test("acquire 실패 시 Error를 던진다", async () => {
    const store = new FakeRemoteStore();
    const machineB = "machine-B" as MachineId;
    const lockB = new RemoteLock(
      store as never,
      makeConfig(60_000, 0, 0),
      machineB,
    );
    await lockB.acquire();

    const lock = new RemoteLock(
      store as never,
      makeConfig(60_000, 0, 0),
      "machine-A" as MachineId,
    );
    await assert.rejects(
      () => withLock(lock, async () => "never"),
      /failed to acquire remote lock/,
    );
  });
});
