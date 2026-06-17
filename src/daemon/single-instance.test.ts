import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { SingleInstanceLock } from "./single-instance.js";
import type { LockPayload } from "./single-instance.js";

// ---------------------------------------------------------------------------
// 헬퍼: 락 파일을 직접 작성(테스트가 holder 를 위조하기 위함).
// ---------------------------------------------------------------------------

async function writePayload(lockPath: string, payload: LockPayload): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf-8");
}

async function readRaw(lockPath: string): Promise<string> {
  return fs.readFile(lockPath, "utf-8");
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// describe: SingleInstanceLock
// ---------------------------------------------------------------------------

describe("SingleInstanceLock", () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-test-"));
    lockPath = path.join(tmpDir, "daemon.lock");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("빈 경로에서 acquire 는 true 를 반환하고 올바른 payload 를 기록한다", async () => {
    const lock = new SingleInstanceLock(lockPath);
    const ok = await lock.acquire();
    assert.equal(ok, true);

    assert.ok(await exists(lockPath), "lock file should exist after acquire");
    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.hostname, os.hostname());
    assert.ok(payload.startedAt.length > 0, "startedAt should be set");
    assert.ok(payload.heartbeatAt.length > 0, "heartbeatAt should be set");
    // ISO 문자열이어야 한다.
    assert.ok(!Number.isNaN(Date.parse(payload.startedAt)));
    assert.ok(!Number.isNaN(Date.parse(payload.heartbeatAt)));
  });

  test("살아있는 동일 호스트 holder 가 점유 중이면 acquire 는 false 를 반환한다", async () => {
    // process.pid 는 이 프로세스 = 확실히 살아있는 '다른' holder 로 위조.
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      hostname: os.hostname(),
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    const ok = await lock.acquire();
    assert.equal(ok, false, "live same-host holder must block acquire");

    // 락 파일 내용이 변경되지 않아야 한다(탈취 안 함).
    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.heartbeatAt, now, "holder payload must be untouched");
  });

  test("stale 락(오래된 heartbeat)은 탈취(reclaim)된다", async () => {
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: past,
      heartbeatAt: past,
      hostname: os.hostname(),
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 1000 });
    const ok = await lock.acquire();
    assert.equal(ok, true, "stale lock should be reclaimed");

    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.pid, process.pid);
    assert.notEqual(payload.heartbeatAt, past, "heartbeat must be refreshed");
  });

  test("죽은 pid 의 락은 탈취된다 (ESRCH)", async () => {
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: 999_999, // 존재할 가능성이 극히 낮은 pid → process.kill(pid,0) ESRCH.
      startedAt: now,
      heartbeatAt: now,
      hostname: os.hostname(),
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    const ok = await lock.acquire();
    assert.equal(ok, true, "dead-pid lock should be reclaimed");

    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.pid, process.pid);
  });

  test("호스트명 불일치 락은 탈취된다 (다른 머신의 pid 는 무의미)", async () => {
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: process.pid, // 같은 살아있는 pid 라도 호스트가 다르면 무의미.
      startedAt: now,
      heartbeatAt: now,
      hostname: "other-host",
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    const ok = await lock.acquire();
    assert.equal(ok, true, "hostname mismatch should be reclaimed");

    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.hostname, os.hostname());
  });

  test("손상된 락 파일은 탈취 가능하다", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "not-json{{{", "utf-8");

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    const ok = await lock.acquire();
    assert.equal(ok, true, "corrupt lock should be reclaimed");

    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.pid, process.pid);
  });

  test("heartbeat 는 heartbeatAt 을 더 최신 값으로 갱신한다", async () => {
    const lock = new SingleInstanceLock(lockPath);
    await lock.acquire();

    const before = await lock.read();
    assert.ok(before !== null);
    // 시계 분해능 회피: 과거값으로 강제 후 heartbeat 가 갱신함을 확인.
    const stale = new Date(Date.now() - 60_000).toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: before!.startedAt,
      heartbeatAt: stale,
      hostname: os.hostname(),
    });

    await lock.heartbeat();

    const after = await lock.read();
    assert.ok(after !== null);
    assert.ok(
      Date.parse(after!.heartbeatAt) > Date.parse(stale),
      "heartbeat must advance heartbeatAt",
    );
    // startedAt 은 보존되어야 한다.
    assert.equal(after!.startedAt, before!.startedAt);
  });

  test("heartbeat 는 소유자가 아니면 no-op (타 holder 를 건드리지 않음)", async () => {
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      hostname: "other-host",
    });

    const lock = new SingleInstanceLock(lockPath);
    await lock.heartbeat();

    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.heartbeatAt, now, "non-owner heartbeat must be no-op");
    assert.equal(payload.hostname, "other-host");
  });

  test("release 는 자기 소유 락 파일을 삭제하고 read 는 null 이 된다", async () => {
    const lock = new SingleInstanceLock(lockPath);
    await lock.acquire();
    assert.ok(await exists(lockPath));

    await lock.release();
    assert.equal(await exists(lockPath), false, "self-owned lock must be removed");
    assert.equal(await lock.read(), null);
  });

  test("release 는 타 holder 락을 건드리지 않는다", async () => {
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      hostname: "other-host",
    });

    const lock = new SingleInstanceLock(lockPath);
    await lock.release();

    assert.ok(await exists(lockPath), "other holder lock must survive release");
    const payload = JSON.parse(await readRaw(lockPath)) as LockPayload;
    assert.equal(payload.hostname, "other-host");
  });

  test("release 는 락 파일이 없어도 에러 없이 끝난다(멱등)", async () => {
    const lock = new SingleInstanceLock(lockPath);
    await assert.doesNotReject(() => lock.release());
  });

  test("read 는 락 파일이 없으면 null 을 반환한다", async () => {
    const lock = new SingleInstanceLock(lockPath);
    assert.equal(await lock.read(), null);
  });

  test("read 는 손상된 락 파일에서 null 을 반환한다", async () => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "}{not-json", "utf-8");
    const lock = new SingleInstanceLock(lockPath);
    assert.equal(await lock.read(), null);
  });

  test("read 는 유효한 락 파일의 payload 를 반환한다", async () => {
    const now = new Date().toISOString();
    const written: LockPayload = {
      pid: 4242,
      startedAt: now,
      heartbeatAt: now,
      hostname: "host-x",
    };
    await writePayload(lockPath, written);

    const lock = new SingleInstanceLock(lockPath);
    const payload = await lock.read();
    assert.ok(payload !== null);
    assert.equal(payload!.pid, 4242);
    assert.equal(payload!.hostname, "host-x");
    assert.equal(payload!.startedAt, now);
  });

  test("isHeld 는 신선한 자기 락에서 true, release 후 false 이다", async () => {
    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    await lock.acquire();
    assert.equal(await lock.isHeld(), true, "fresh self lock should be held");

    await lock.release();
    assert.equal(await lock.isHeld(), false, "released lock not held");
  });

  test("isHeld 는 stale 락에서 false 이다", async () => {
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    await writePayload(lockPath, {
      pid: process.pid,
      startedAt: past,
      heartbeatAt: past,
      hostname: os.hostname(),
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 1000 });
    assert.equal(await lock.isHeld(), false, "stale lock must not be held");
  });

  test("isHeld 는 죽은 pid 락에서 false 이다", async () => {
    const now = new Date().toISOString();
    await writePayload(lockPath, {
      pid: 999_999,
      startedAt: now,
      heartbeatAt: now,
      hostname: os.hostname(),
    });

    const lock = new SingleInstanceLock(lockPath, { ttlMs: 120_000 });
    assert.equal(await lock.isHeld(), false, "dead-pid lock must not be held");
  });

  // single-instance.ts line 53: acquire 의 wx open 에서 EEXIST 가 아닌 에러 → 즉시 rethrow.
  // 락 파일 경로의 부모 디렉터리가 없으면 ENOENT 로 실패하므로 이를 이용한다.
  test("acquire: 디렉터리 없이 wxopen 실패(ENOENT) → 에러 rethrow", async () => {
    const deepPath = path.join(tmpDir, "does", "not", "exist", "daemon.lock");
    const lock = new SingleInstanceLock(deepPath);
    // acquire 는 먼저 mkdir 로 부모를 만들므로 실제로 ENOENT 가 나지 않는다.
    // 대신 lockPath 자체를 디렉터리로 만들어두면 wx open 이 EISDIR 로 실패한다.
    const dirAsLock = path.join(tmpDir, "dir-as-lock");
    await fs.mkdir(dirAsLock, { recursive: true });
    // dirAsLock 을 락 경로로 쓰면 open("wx") 이 EISDIR(또는 EEXIST) 로 실패한다.
    // EEXIST 면 정상 흐름(기존 holder 검사)이므로 다른 비-EEXIST 에러를 유발해야 한다.
    // 가장 깨끗한 방법: lockPath 내부에 또 다른 디렉터리를 만들어 부모는 있지만
    // 파일명 자체가 이미 디렉터리인 상황 → EISDIR.
    const lockAsDir = path.join(tmpDir, "lock-is-dir");
    await fs.mkdir(lockAsDir, { recursive: true });
    const lockInside = new SingleInstanceLock(lockAsDir);
    // lockAsDir 자체가 디렉터리이므로 open(lockAsDir, "wx") 는 EISDIR 발생.
    // EISDIR 은 "EEXIST" 가 아니므로 line 55 의 throw err 경로를 탄다.
    await assert.rejects(
      () => lockInside.acquire(),
      (err: NodeJS.ErrnoException) => {
        assert.ok(err.code !== undefined, "에러 코드가 있어야 한다");
        assert.notEqual(err.code, "EEXIST", "EEXIST 면 이 경로를 타지 않는다");
        return true;
      },
    );
  });
});
