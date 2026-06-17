import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jobManager, type JobRecord, type JobStatus } from "./job-manager.js";

// JobManager 클래스는 export 되지 않으므로 singleton jobManager 로 테스트.
// 각 테스트는 start() 가 반환한 rec 객체 참조와 get(jobId) 로 격리한다.

describe("jobManager.start() — worker resolves", () => {
  test("returns JobRecord immediately with status=running", () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise<unknown>((res) => {
      resolve = res;
    });

    const rec = jobManager.start("push", () => pending);

    assert.equal(typeof rec.jobId, "string");
    assert.ok(rec.jobId.length > 0);
    assert.equal(rec.kind, "push");
    assert.equal(rec.status, "running");
    assert.equal(rec.result, null);
    assert.equal(rec.error, null);
    assert.equal(rec.finishedAt, null);
    assert.ok(typeof rec.startedAt === "string" && rec.startedAt.length > 0);

    resolve(undefined);
  });

  test("status transitions to completed after worker resolves", async () => {
    const worker = Promise.resolve({ synced: 3 });
    const rec = jobManager.start("push", () => worker);

    await worker;
    await Promise.resolve();

    assert.equal(rec.status, "completed");
    assert.deepEqual(rec.result, { synced: 3 });
    assert.equal(rec.error, null);
    assert.ok(typeof rec.finishedAt === "string");
  });

  test("get(jobId) returns the same record after completion", async () => {
    const worker = Promise.resolve(42);
    const rec = jobManager.start("pull", () => worker);
    await worker;
    await Promise.resolve();

    const fetched = jobManager.get(rec.jobId);
    assert.ok(fetched !== null);
    assert.equal(fetched.jobId, rec.jobId);
    assert.equal(fetched.status, "completed");
    assert.equal(fetched.result, 42);
  });

  test("worker resolving undefined — result is undefined, status completed", async () => {
    const worker = Promise.resolve(undefined);
    const rec = jobManager.start("push", () => worker);
    await worker;
    await Promise.resolve();

    assert.equal(rec.status, "completed");
    assert.equal(rec.result, undefined);
  });
});

describe("jobManager.start() — worker rejects", () => {
  test("status becomes failed and error message is captured", async () => {
    const err = new Error("sync exploded");
    const worker = Promise.reject(err);
    worker.catch(() => {});

    const rec = jobManager.start("push", () => worker);
    try { await worker; } catch { /* expected */ }
    await Promise.resolve();

    assert.equal(rec.status, "failed");
    assert.equal(rec.error, "sync exploded");
    assert.equal(rec.result, null);
    assert.ok(typeof rec.finishedAt === "string");
  });

  test("rejection does not become unhandled — result stays null", async () => {
    const worker = Promise.reject(new Error("kaboom"));
    worker.catch(() => {});
    const rec = jobManager.start("pull", () => worker);
    try { await worker; } catch { /* expected */ }
    await Promise.resolve();

    assert.equal(rec.status, "failed");
    assert.equal(rec.result, null);
  });

  test("error string is the Error.message, not [object Object]", async () => {
    const worker = Promise.reject(new Error("detailed message"));
    worker.catch(() => {});
    const rec = jobManager.start("push", () => worker);
    try { await worker; } catch { /* expected */ }
    await Promise.resolve();

    assert.equal(rec.error, "detailed message");
    assert.notEqual(rec.error, "[object Object]");
  });
});

describe("jobManager.get() — unknown jobId", () => {
  test("returns null for a non-existent UUID", () => {
    const result = jobManager.get("00000000-0000-0000-0000-000000000000");
    assert.equal(result, null);
  });

  test("returns null for empty string", () => {
    assert.equal(jobManager.get(""), null);
  });
});

describe("concurrent jobs — distinct jobIds and independent results", () => {
  test("two concurrent jobs get distinct jobIds", () => {
    let res1!: (v: unknown) => void;
    let res2!: (v: unknown) => void;
    const p1 = new Promise<unknown>((r) => { res1 = r; });
    const p2 = new Promise<unknown>((r) => { res2 = r; });

    const rec1 = jobManager.start("push", () => p1);
    const rec2 = jobManager.start("pull", () => p2);

    assert.notEqual(rec1.jobId, rec2.jobId);

    res1(undefined);
    res2(undefined);
  });

  test("two concurrent jobs resolve to independent results", async () => {
    const p1 = Promise.resolve("result-A");
    const p2 = Promise.resolve("result-B");

    const rec1 = jobManager.start("push", () => p1);
    const rec2 = jobManager.start("pull", () => p2);

    await p1;
    await p2;
    await Promise.resolve();

    assert.equal(rec1.status, "completed");
    assert.equal(rec2.status, "completed");
    assert.equal(rec1.result, "result-A");
    assert.equal(rec2.result, "result-B");
    assert.notEqual(rec1.jobId, rec2.jobId);
  });

  test("one job failing does not affect the sibling job", async () => {
    const failing = Promise.reject(new Error("partial failure"));
    failing.catch(() => {});
    const passing = Promise.resolve("ok");

    const recFail = jobManager.start("push", () => failing);
    const recOk = jobManager.start("pull", () => passing);

    try { await failing; } catch { /* expected */ }
    await passing;
    await Promise.resolve();

    assert.equal(recFail.status, "failed");
    assert.equal(recFail.error, "partial failure");

    assert.equal(recOk.status, "completed");
    assert.equal(recOk.result, "ok");
  });
});

describe("JobRecord shape", () => {
  test("completed record has all required fields with correct types", async () => {
    const worker = Promise.resolve("shape-check");
    const rec = jobManager.start("push", () => worker);
    await worker;
    await Promise.resolve();

    const r: JobRecord = rec;
    assert.equal(typeof r.jobId, "string");
    assert.ok(r.kind === "push" || r.kind === "pull");
    const validStatuses: JobStatus[] = ["running", "completed", "failed"];
    assert.ok(validStatuses.includes(r.status));
    assert.equal(typeof r.startedAt, "string");
    assert.ok(r.finishedAt === null || typeof r.finishedAt === "string");
  });
});

describe("jobManager.list()", () => {
  test("list() includes a running job immediately after start", () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise<unknown>((res) => { resolve = res; });

    const rec = jobManager.start("push", () => pending);
    const jobs = jobManager.list();

    assert.ok(jobs.some((j) => j.jobId === rec.jobId), "list() should contain the new job");
    resolve(undefined);
  });

  test("list() includes a completed job after worker resolves", async () => {
    const worker = Promise.resolve("listed-result");
    const rec = jobManager.start("pull", () => worker);
    await worker;
    await Promise.resolve();

    const jobs = jobManager.list();
    const found = jobs.find((j) => j.jobId === rec.jobId);
    assert.ok(found !== undefined, "list() should contain the completed job");
    assert.equal(found!.status, "completed");
  });

  test("list() includes a failed job after worker rejects", async () => {
    const err = new Error("list-fail");
    const worker = Promise.reject(err);
    worker.catch(() => {});

    const rec = jobManager.start("push", () => worker);
    try { await worker; } catch { /* expected */ }
    await Promise.resolve();

    const jobs = jobManager.list();
    const found = jobs.find((j) => j.jobId === rec.jobId);
    assert.ok(found !== undefined, "list() should contain the failed job");
    assert.equal(found!.status, "failed");
    assert.equal(found!.error, "list-fail");
  });

  test("list() returns independent snapshot — mutations do not affect stored record", async () => {
    const worker = Promise.resolve("snap");
    const rec = jobManager.start("push", () => worker);
    await worker;
    await Promise.resolve();

    const snap = jobManager.list();
    const item = snap.find((j) => j.jobId === rec.jobId);
    assert.ok(item !== undefined);
    assert.equal(item, rec, "list() items are the same object references as start() returned");
  });
});

describe("jobManager — #prune evicts oldest finished jobs beyond maxJobs(100)", () => {
  test("101st job start triggers prune: oldest completed job is evicted", async () => {
    const completed: string[] = [];

    for (let i = 0; i < 100; i++) {
      const w = Promise.resolve(i);
      const r = jobManager.start("push", () => w);
      await w;
      await Promise.resolve();
      completed.push(r.jobId);
    }

    const firstEvicted = completed[0];
    assert.ok(jobManager.get(firstEvicted) !== null, "job 0 should still exist before prune");

    const trigger = Promise.resolve("trigger");
    jobManager.start("pull", () => trigger);
    await trigger;
    await Promise.resolve();

    assert.equal(
      jobManager.get(firstEvicted),
      null,
      "oldest completed job should be evicted after 101st start"
    );
  });

  test("prune preserves running jobs — only completed/failed are evicted", async () => {
    let releaseRunning!: (v: unknown) => void;
    const runningP = new Promise<unknown>((res) => { releaseRunning = res; });
    const runningRec = jobManager.start("push", () => runningP);

    for (let i = 0; i < 100; i++) {
      const w = Promise.resolve(i);
      const r = jobManager.start("push", () => w);
      await w;
      await Promise.resolve();
    }

    const triggerP = Promise.resolve("prune-trigger");
    jobManager.start("pull", () => triggerP);
    await triggerP;
    await Promise.resolve();

    assert.ok(
      jobManager.get(runningRec.jobId) !== null,
      "running job must survive prune"
    );
    assert.equal(runningRec.status, "running");

    releaseRunning(undefined);
  });
});
