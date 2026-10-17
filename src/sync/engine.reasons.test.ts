import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import { ReasonStore } from "./reasons-store.js";
import { PENDING_DIFF_TOTAL } from "./reasons.js";
import { sha256 } from "./hash.js";
import { PreconditionFailedError } from "../webdav/client.js";
import type { RemoteStore } from "../webdav/client.js";
import type { Config, LogicalKey, MachineId, Manifest } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";

let sharedCrypto: AgeCrypto;
const tmpDirs: string[] = [];

before(async () => {
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(await age.generateIdentity());
});

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

interface Replica {
  engine: SyncEngine;
  home: string;
  machineId: MachineId;
}

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-rs-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function buildConfig(home: string, stateDir: string): Config {
  return {
    stateDir,
    home,
    remote: { url: "http://mock.invalid", username: "", password: "", remoteBaseDir: "/claude-sync" },
    targets: { include: [".claude/**"], exclude: [] },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  } as unknown as Config;
}

function makeReplica(remote: RemoteStore, label: string, machineId: MachineId): Replica {
  const home = mkTmp(`${label}-home`);
  const stateDir = path.join(home, ".claude-sync");
  const deps: EngineDeps = {
    config: buildConfig(home, stateDir),
    crypto: sharedCrypto,
    remote,
    machineId,
    casRetryBackoffMs: [0],
  };
  return { engine: new SyncEngine(deps), home, machineId };
}

async function writeHomeFile(r: Replica, key: string, content: string): Promise<void> {
  const abs = path.join(r.home, ...key.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function removeHomeFile(r: Replica, key: string): Promise<void> {
  await fs.rm(path.join(r.home, ...key.split("/")), { force: true });
}

async function readRemoteManifest(remote: MockWebdavRemote): Promise<Manifest> {
  const got = await remote.asRemoteStore().getTextWithETag("/claude-sync/manifest.json.age");
  assert.ok(got, "원격 매니페스트가 있어야 한다");
  return JSON.parse(await sharedCrypto.decryptToString(got!.text)) as Manifest;
}

function storeFor(remote: MockWebdavRemote): ReasonStore {
  return new ReasonStore({ remote: remote.asRemoteStore(), crypto: sharedCrypto, machineId: "reader" });
}

async function logReasons(remote: MockWebdavRemote, key: string): Promise<string[]> {
  const entry = (await readRemoteManifest(remote)).entries[key]!;
  assert.ok(entry.reasonsRef, "reasonsRef 가 있어야 한다");
  const loaded = await storeFor(remote).loadLog(key as LogicalKey, entry.reasonsRef!);
  assert.equal(loaded.kind, "ok");
  return loaded.kind === "ok" ? loaded.items.map((i) => i.reason) : [];
}

function reasonBlobKeys(remote: MockWebdavRemote): string[] {
  return remote.keys().filter((k) => k.startsWith("blobs/r-"));
}

function wrapRemote(remote: MockWebdavRemote, over: Partial<RemoteStore>): RemoteStore {
  const wrapped = Object.create(remote.asRemoteStore()) as RemoteStore;
  Object.assign(wrapped, over);
  return wrapped;
}

function plugins(r: Replica): string {
  return path.join(r.home, ".claude", "plugins");
}

const KEY = ".claude/note.md";

describe("push — 이유 기록", () => {
  test("이유를 실으면 이력 blob 과 reasonsRef 가 기록된다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "push", "machine-a");
    await writeHomeFile(a, KEY, "one\n");

    const result = await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });

    assert.deepEqual(result.reasons, { recorded: [KEY], unchanged: [], rejected: [] });
    const entry = (await readRemoteManifest(remote)).entries[KEY]!;
    assert.equal(entry.reasonsRef!.count, 1);
    assert.equal(entry.reasonsRef!.lastGeneration, 1);
    assert.equal(reasonBlobKeys(remote).length, 1);
    assert.deepEqual(await logReasons(remote, KEY), ["R1"]);
  });

  test("이유를 쓰지 않는 push 는 결과와 매니페스트에 이유 흔적이 없다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "plain", "machine-a");
    await writeHomeFile(a, KEY, "one\n");

    const result = await a.engine.push();

    assert.equal("reasons" in result, false);
    assert.equal("pending" in result, false);
    assert.equal("reasonsRef" in (await readRemoteManifest(remote)).entries[KEY]!, false);
    assert.deepEqual(reasonBlobKeys(remote), []);
  });

  test("push 되지 않은 키는 not-pushed 이고 기록하지 않는다(변경 없음 조기 반환 포함)", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "nopush", "machine-a");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push();
    const gen = (await readRemoteManifest(remote)).manifestGeneration;

    const result = await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "late" }] });

    assert.deepEqual(result.reasons, {
      recorded: [],
      unchanged: [],
      rejected: [{ logicalKey: KEY, code: "not-pushed" }],
    });
    assert.equal((await readRemoteManifest(remote)).manifestGeneration, gen);
    assert.deepEqual(reasonBlobKeys(remote), []);
  });

  test("sync 모드는 입력의 contentHash 를 무시한다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "hash", "machine-a");
    await writeHomeFile(a, KEY, "one\n");

    const result = await a.engine.push({
      reasons: [{ logicalKey: KEY, reason: "R1", contentHash: sha256("unrelated") }],
    });

    assert.deepEqual(result.reasons!.recorded, [KEY]);
  });

  test("이력이 generation 마다 누적된다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "accum", "machine-a");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });
    await writeHomeFile(a, KEY, "two\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R2" }] });

    assert.deepEqual(await logReasons(remote, KEY), ["R1", "R2"]);
    assert.equal(reasonBlobKeys(remote).length, 1, "옛 이력 blob 은 커밋 뒤 지워진다");
  });

  test("syncAtomic 으로도 이유가 전달된다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "atomic", "machine-a");
    await writeHomeFile(a, KEY, "one\n");

    const result = await a.engine.syncAtomic({
      pluginsDir: plugins(a),
      reasons: [{ logicalKey: KEY, reason: "via sync" }],
    });

    assert.equal(result.aborted, false);
    if (!result.aborted) assert.deepEqual(result.push.reasons!.recorded, [KEY]);
    assert.deepEqual(await logReasons(remote, KEY), ["via sync"]);
  });
});

describe("pull — 이유 노출", () => {
  test("두 번째 머신 pull 에 이유가 실린다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "pa", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "pb", "machine-b");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });

    const pull = await b.engine.pull();

    assert.deepEqual(pull.applied, [KEY]);
    assert.equal(pull.reasons![KEY]!.items[0]!.reason, "R1");
    assert.equal(pull.reasons![KEY]!.omitted, 0);
  });

  test("baseline 이후 항목만 보인다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "fa", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "fb", "machine-b");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });
    await b.engine.pull();
    await writeHomeFile(a, KEY, "two\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R2" }] });

    const pull = await b.engine.pull();

    assert.deepEqual(pull.reasons![KEY]!.items.map((i) => i.reason), ["R2"]);
  });

  test("원격에 이유가 없으면 결과에 reasons 키가 없다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "na", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "nb", "machine-b");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push();

    const pull = await b.engine.pull();

    assert.equal("reasons" in pull, false);
  });

  test("삭제 이유는 removed 와 함께 실린다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "da", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "db", "machine-b");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push();
    await b.engine.pull();
    await removeHomeFile(a, KEY);

    const push = await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "obsolete" }] });
    const pull = await b.engine.pull();

    assert.deepEqual(push.reasons!.recorded, [KEY]);
    assert.deepEqual(pull.removed, [KEY]);
    assert.equal(pull.reasons![KEY]!.items[0]!.reason, "obsolete");
  });

  test("손상된 이력 blob 이어도 pull 은 계속되고 이유만 빠진다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "ca", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "cb", "machine-b");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });
    await remote.putAtomic(reasonBlobKeys(remote)[0]!, "garbage", "x");

    const pull = await b.engine.pull();

    assert.deepEqual(pull.applied, [KEY]);
    assert.equal("reasons" in pull, false);
  });
});

describe("충돌 — 원격 이유 노출", () => {
  async function conflictSetup(label: string) {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), `${label}a`, "machine-a");
    const b = makeReplica(remote.asRemoteStore(), `${label}b`, "machine-b");
    await writeHomeFile(a, KEY, "base\n");
    await a.engine.push();
    await b.engine.pull();
    await writeHomeFile(a, KEY, "from-a\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "RA" }] });
    await writeHomeFile(b, KEY, "from-b\n");
    return { remote, a, b };
  }

  test("latest-wins 로 자동 해소된 충돌의 이유가 pull.reasons 에 있다", async () => {
    const { b } = await conflictSetup("lw");

    const result = await b.engine.syncAtomic({ pluginsDir: plugins(b), policy: "latest-wins" });

    assert.equal(result.aborted, false);
    if (!result.aborted) {
      assert.equal(result.pull.reasons![KEY]!.items[0]!.reason, "RA");
    }
  });

  test("충돌로 중단된 sync 의 ConflictDetail 에 remoteReasons 가 있다", async () => {
    const { b } = await conflictSetup("ab");

    const result = await b.engine.syncAtomic({ pluginsDir: plugins(b), policy: "preserve-both" });

    assert.equal(result.aborted, true);
    if (result.aborted && result.reason === "conflicts") {
      assert.equal(result.conflicts[0]!.remoteReasons!.items[0]!.reason, "RA");
    }
  });

  test("resolve 미리보기에 remoteReasons 가 있다", async () => {
    const { b } = await conflictSetup("pv");

    const out = await b.engine.resolve("preserve-both", undefined, { dryRun: true });

    assert.equal(out.preview![0]!.remoteReasons!.items[0]!.reason, "RA");
  });

  test("이유가 없는 충돌의 미리보기에는 remoteReasons 키가 없다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "nra", "machine-a");
    const b = makeReplica(remote.asRemoteStore(), "nrb", "machine-b");
    await writeHomeFile(a, KEY, "base\n");
    await a.engine.push();
    await b.engine.pull();
    await writeHomeFile(a, KEY, "from-a\n");
    await a.engine.push();
    await writeHomeFile(b, KEY, "from-b\n");

    const out = await b.engine.resolve("preserve-both", undefined, { dryRun: true });

    assert.equal("remoteReasons" in out.preview![0]!, false);
  });
});

describe("pushReasons", () => {
  async function pushed(label: string) {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), `${label}a`, "machine-a");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push();
    const entry = (await readRemoteManifest(remote)).entries[KEY]!;
    return { remote, a, hash: entry.contentHash };
  }

  test("이미 올라간 버전에 이유를 덧붙이고 엔트리 generation 은 그대로다", async () => {
    const { remote, a, hash } = await pushed("late");
    const before = await readRemoteManifest(remote);

    const result = await a.engine.pushReasons([{ logicalKey: KEY, reason: "late", contentHash: hash }]);

    assert.deepEqual(result.recorded, [KEY]);
    assert.equal(result.dryRun, false);
    const after = await readRemoteManifest(remote);
    assert.equal(after.entries[KEY]!.generation, before.entries[KEY]!.generation);
    assert.equal(after.manifestGeneration, before.manifestGeneration + 1);
    assert.equal(result.manifestGeneration, after.manifestGeneration);
    assert.deepEqual(await logReasons(remote, KEY), ["late"]);
  });

  test("다른 머신 pull 에서 덧붙인 이유가 보인다", async () => {
    const { remote, a, hash } = await pushed("see");
    const b = makeReplica(remote.asRemoteStore(), "seeb", "machine-b");
    await a.engine.pushReasons([{ logicalKey: KEY, reason: "late", contentHash: hash }]);

    const pull = await b.engine.pull();

    assert.equal(pull.reasons![KEY]!.items[0]!.reason, "late");
  });

  test("같은 이유를 다시 주면 unchanged 이고 매니페스트를 쓰지 않는다", async () => {
    const { remote, a, hash } = await pushed("idem");
    const input = [{ logicalKey: KEY, reason: "late", contentHash: hash }];
    await a.engine.pushReasons(input);
    const gen = (await readRemoteManifest(remote)).manifestGeneration;

    const result = await a.engine.pushReasons(input);

    assert.deepEqual(result.unchanged, [KEY]);
    assert.deepEqual(result.recorded, []);
    assert.equal((await readRemoteManifest(remote)).manifestGeneration, gen);
  });

  test("contentHash 가 원격 엔트리와 다르면 stale-hash 로 거부한다", async () => {
    const { remote, a } = await pushed("stale");
    const gen = (await readRemoteManifest(remote)).manifestGeneration;

    const result = await a.engine.pushReasons([
      { logicalKey: KEY, reason: "late", contentHash: sha256("old") },
    ]);

    assert.deepEqual(result.rejected, [{ logicalKey: KEY, code: "stale-hash" }]);
    assert.equal((await readRemoteManifest(remote)).manifestGeneration, gen);
    assert.deepEqual(reasonBlobKeys(remote), []);
  });

  test("contentHash 가 없으면 hash-required, 엔트리가 없으면 no-entry", async () => {
    const { a, hash } = await pushed("rej");

    const result = await a.engine.pushReasons([
      { logicalKey: KEY, reason: "late" },
      { logicalKey: ".claude/ghost.md", reason: "x", contentHash: hash },
    ]);

    assert.deepEqual(result.rejected, [
      { logicalKey: ".claude/ghost.md", code: "no-entry" },
      { logicalKey: KEY, code: "hash-required" },
    ]);
  });

  test("dry-run 은 원격에 아무것도 쓰지 않는다", async () => {
    const { remote, a, hash } = await pushed("dry");
    const keysBefore = remote.keys();
    const puts = remote.calls.putAtomic + remote.calls.putIfMatch;

    const result = await a.engine.pushReasons(
      [{ logicalKey: KEY, reason: "late", contentHash: hash }],
      { dryRun: true },
    );

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.recorded, [KEY]);
    assert.deepEqual(remote.keys(), keysBefore);
    assert.equal(remote.calls.putAtomic + remote.calls.putIfMatch, puts);
  });

  test("두 번째 이유를 덧붙이면 옛 이력 blob 은 커밋 뒤 지워지고 하나만 남는다", async () => {
    const { remote, a, hash } = await pushed("two");
    await a.engine.pushReasons([{ logicalKey: KEY, reason: "first", contentHash: hash }]);
    const first = reasonBlobKeys(remote);

    await a.engine.pushReasons([{ logicalKey: KEY, reason: "second", contentHash: hash }]);

    const second = reasonBlobKeys(remote);
    assert.equal(second.length, 1);
    assert.notDeepEqual(second, first);
    assert.deepEqual(await logReasons(remote, KEY), ["first", "second"]);
  });

  test("매니페스트 쓰기가 실패하면 옛 이력 blob 과 포인터가 그대로다", async () => {
    const { remote, a, hash } = await pushed("fail");
    await a.engine.pushReasons([{ logicalKey: KEY, reason: "first", contentHash: hash }]);
    const refBefore = (await readRemoteManifest(remote)).entries[KEY]!.reasonsRef;
    const blobsBefore = reasonBlobKeys(remote);
    const failing = wrapRemote(remote, {
      putIfMatch: async () => {
        throw new PreconditionFailedError("forced", 412);
      },
    });
    const c = makeReplica(failing, "failc", "machine-c");

    await assert.rejects(() =>
      c.engine.pushReasons([{ logicalKey: KEY, reason: "second", contentHash: hash }]),
    );

    assert.deepEqual((await readRemoteManifest(remote)).entries[KEY]!.reasonsRef, refBefore);
    for (const k of blobsBefore) assert.ok(remote.has(k), `옛 blob 이 남아야 한다: ${k}`);
  });

  test("CAS 재시도 때 다른 머신이 커밋한 이력 항목이 남는다", async () => {
    const { remote, hash } = await pushed("cas");
    const b = makeReplica(remote.asRemoteStore(), "casb", "machine-b");
    let injected = false;
    const base = remote.asRemoteStore();
    const racing = wrapRemote(remote, {
      putIfMatch: async (p: string, data: string | Buffer, etag: string | null, machineId: string) => {
        if (!injected && p.endsWith("manifest.json.age")) {
          injected = true;
          await (b.engine as unknown as {
            runPushReasons: (i: unknown[], dry: boolean) => Promise<unknown>;
          }).runPushReasons([{ logicalKey: KEY, reason: "from-b", contentHash: hash }], false);
        }
        return base.putIfMatch(p, data, etag, machineId);
      },
    });
    const c = makeReplica(racing, "casc", "machine-c");

    const result = await c.engine.pushReasons([{ logicalKey: KEY, reason: "from-c", contentHash: hash }]);

    assert.equal(injected, true);
    assert.deepEqual(result.recorded, [KEY]);
    assert.deepEqual((await logReasons(remote, KEY)).sort(), ["from-b", "from-c"]);
  });

  test("이력 blob 읽기가 I/O 오류면 시도가 실패하고 기존 이력이 그대로다", async () => {
    const { remote, a, hash } = await pushed("io");
    await a.engine.pushReasons([{ logicalKey: KEY, reason: "first", contentHash: hash }]);
    const refBefore = (await readRemoteManifest(remote)).entries[KEY]!.reasonsRef;
    const base = remote.asRemoteStore();
    const flaky = wrapRemote(remote, {
      getTextIfExists: async (p: string) => {
        if (p.startsWith("blobs/r-")) throw Object.assign(new Error("reset"), { status: 503 });
        return base.getTextIfExists(p);
      },
    });
    const c = makeReplica(flaky, "ioc", "machine-c");

    await assert.rejects(() =>
      c.engine.pushReasons([{ logicalKey: KEY, reason: "second", contentHash: hash }]),
    );

    assert.deepEqual((await readRemoteManifest(remote)).entries[KEY]!.reasonsRef, refBefore);
    assert.deepEqual(await logReasons(remote, KEY), ["first"]);
  });
});

describe("force-up", () => {
  test("이력 blob 도 지운다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "fu", "machine-a");
    await writeHomeFile(a, KEY, "one\n");
    await a.engine.push({ reasons: [{ logicalKey: KEY, reason: "R1" }] });
    assert.equal(reasonBlobKeys(remote).length, 1);

    await a.engine.forceUpload();

    assert.deepEqual(reasonBlobKeys(remote), []);
    assert.equal("reasonsRef" in (await readRemoteManifest(remote)).entries[KEY]!, false);
  });
});

describe("push dry-run — pending", () => {
  test("includePending 일 때만 pending 이 있고 kind 별 해시를 담는다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "pend", "machine-a");
    await writeHomeFile(a, ".claude/keep.md", "keep\n");
    await writeHomeFile(a, ".claude/gone.md", "gone\n");
    await a.engine.push();
    await writeHomeFile(a, ".claude/keep.md", "keep\nchanged\n");
    await removeHomeFile(a, ".claude/gone.md");
    await writeHomeFile(a, ".claude/new.md", "new\n");

    const plain = await a.engine.push({ dryRun: true });
    const withPending = await a.engine.push({ dryRun: true, includePending: true });

    assert.equal("pending" in plain, false);
    const byKey = Object.fromEntries(withPending.pending!.map((p) => [p.logicalKey, p]));
    assert.equal(byKey[".claude/keep.md"]!.kind, "modified");
    assert.equal(byKey[".claude/keep.md"]!.contentHash, sha256("keep\nchanged\n"));
    assert.equal(byKey[".claude/keep.md"]!.changeDiff!.format, "unified");
    assert.equal(byKey[".claude/new.md"]!.kind, "added");
    assert.equal(byKey[".claude/gone.md"]!.kind, "deleted");
    assert.equal(byKey[".claude/gone.md"]!.contentHash, null);
  });

  test("diff 본문 총량이 예산을 넘지 않고 넘친 키는 pruned 로 표시한다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote.asRemoteStore(), "budget", "machine-a");
    for (let i = 0; i < 40; i++) {
      const lines = Array.from({ length: 200 }, (_, n) => `line ${n} of file ${i}`).join("\n");
      await writeHomeFile(a, `.claude/f${String(i).padStart(2, "0")}.md`, lines);
    }

    const result = await a.engine.push({ dryRun: true, includePending: true });

    const pending = result.pending!;
    assert.equal(pending.length, 40);
    const total = pending.reduce((s, p) => s + Buffer.byteLength(p.changeDiff?.text ?? ""), 0);
    assert.ok(total <= PENDING_DIFF_TOTAL, `total=${total}`);
    const pruned = pending.filter((p) => p.changeDiff?.pruned === true);
    assert.ok(pruned.length > 0);
    for (const p of pruned) assert.equal(p.changeDiff!.text, "");
    assert.deepEqual(
      pending.map((p) => p.logicalKey),
      [...pending.map((p) => p.logicalKey)].sort(),
    );
  });
});
