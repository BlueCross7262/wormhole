import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId, SyncState } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { sha256, blobName } from "./hash.js";
import { normalizeSettingsForSync } from "./settings-merge.js";

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;
const tmpDirs: string[] = [];

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Replica {
  engine: SyncEngine;
  home: string;
  stateDir: string;
  machineId: MachineId;
  config: Config;
}

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-merge-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function buildConfig(home: string, stateDir: string, include: string[] = [".claude/**"]): Config {
  return {
    stateDir,
    home,
    remote: {
      url: "http://mock.invalid",
      username: "",
      password: "",
      remoteBaseDir: "/claude-sync",
    },
    targets: {
      include,
      exclude: [],
    },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  } as unknown as Config;
}

function makeReplica(
  remote: MockWebdavRemote,
  label: string,
  machineId: MachineId,
  include?: string[],
): Replica {
  const home = mkTmp(`${label}-home`);
  const stateDir = path.join(home, ".claude-sync");
  const config = buildConfig(home, stateDir, include);
  const deps: EngineDeps = {
    config,
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
  };
  const engine = new SyncEngine(deps);
  return { engine, home, stateDir, machineId, config };
}

async function writeHomeFile(replica: Replica, logicalKey: string, content: string): Promise<void> {
  const abs = path.join(replica.home, ...logicalKey.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function readHomeFile(replica: Replica, logicalKey: string): Promise<string> {
  const abs = path.join(replica.home, ...logicalKey.split("/"));
  return fs.readFile(abs, "utf-8");
}

async function homeFileExists(replica: Replica, logicalKey: string): Promise<boolean> {
  const abs = path.join(replica.home, ...logicalKey.split("/"));
  return fs.access(abs).then(() => true).catch(() => false);
}

async function readStateFile(replica: Replica): Promise<SyncState> {
  try {
    const raw = await fs.readFile(path.join(replica.stateDir, "state.json"), "utf-8");
    return JSON.parse(raw) as SyncState;
  } catch {
    return {};
  }
}

function baseSnapshotAbsPath(replica: Replica, logicalKey: string): string {
  return path.join(replica.stateDir, "base", sha256(logicalKey));
}

async function readBaseSnapshotRaw(replica: Replica, logicalKey: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(baseSnapshotAbsPath(replica, logicalKey));
  } catch {
    return null;
  }
}

function enginePrivate(replica: Replica): {
  downloadBlob(key: string): Promise<Buffer | null>;
} {
  return replica.engine as unknown as {
    downloadBlob(key: string): Promise<Buffer | null>;
  };
}

async function putRemoteBlobPlain(remote: MockWebdavRemote, key: string, plaintext: string): Promise<void> {
  const armored = await sharedCrypto.encrypt(plaintext);
  await remote.put(`blobs/${blobName(key)}`, armored);
}

const SETTINGS_KEY = ".claude/settings.json";
const CONFIG_KEY = ".claude/wormhole-config.json";

describe("M1: 서로 다른 키 충돌 -> merge 는 합집합 채택, base=remotePlain, syncedHash=entry.contentHash", () => {
  test("M1", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m1-a", "machine-a");
    const b = makeReplica(remote, "m1-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ shared: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ shared: "v1", onlyB: "bVal" }));
    await b.engine.push();

    const homeFwd = a.home.split(/[\\/]/).join("/");
    const A_LOCAL = {
      shared: "v1",
      onlyA: "aVal",
      tildeCmd: "~/x",
      backslashCmd: `${a.home}\\sub\\dir\\file.js`,
    };
    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify(A_LOCAL));
    const origLocalBytes = await readHomeFile(a, SETTINGS_KEY);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem, "precondition: conflict must exist");

    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [], "no fallback expected for disjoint-key merge");
    assert.ok(result.backupDir, "backupDir must be set");
    const backupBytes = await fs.readFile(
      path.join(result.backupDir as string, ...SETTINGS_KEY.split("/")),
      "utf-8",
    );
    assert.equal(backupBytes, origLocalBytes, "backup must equal pre-merge local bytes");

    const afterLocalRaw = await readHomeFile(a, SETTINGS_KEY);
    const afterLocalObj = JSON.parse(afterLocalRaw) as Record<string, unknown>;
    assert.deepEqual(
      afterLocalObj,
      {
        shared: "v1",
        onlyA: "aVal",
        onlyB: "bVal",
        tildeCmd: `${homeFwd}/x`,
        backslashCmd: `${homeFwd}/sub/dir/file.js`,
      },
      "merged local must be exact union with home-path realization",
    );

    const remotePlainAfter = await enginePrivate(a).downloadBlob(SETTINGS_KEY);
    assert.ok(remotePlainAfter, "remote blob must exist");
    const baseBytes = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.ok(baseBytes, "base snapshot must exist");
    assert.deepEqual(baseBytes, remotePlainAfter, "base snapshot bytes must equal remote blob plain bytes exactly");

    const stateAfter = await readStateFile(a);
    assert.equal(
      stateAfter[SETTINGS_KEY]?.syncedHash,
      conflictItem!.remoteHash,
      "syncedHash must equal entry.contentHash (remote), not a locally-recomputed hash",
    );
    assert.equal(stateAfter[SETTINGS_KEY]?.syncedGeneration, conflictItem!.remoteGeneration);

    const syncResult = await a.engine.syncAtomic({ pluginsDir: a.home, policy: "preserve-both" });
    if (syncResult.aborted) {
      throw new Error(`M1: syncAtomic blocked after merge resolve, reason: ${(syncResult as { reason: string }).reason}`);
    }

    const statusAfterPush = await a.engine.status();
    const itemAfterPush = statusAfterPush.items.find((i) => i.logicalKey === SETTINGS_KEY);
    assert.ok(itemAfterPush);
    const expectedHash = normalizeSettingsForSync(afterLocalRaw, a.home).hash;
    assert.equal(itemAfterPush!.remoteHash, expectedHash, "remote contentHash must equal A's normalized hash");

    await b.engine.pull();
    const bLocalRaw = await readHomeFile(b, SETTINGS_KEY);
    const bNorm = normalizeSettingsForSync(bLocalRaw, b.home);
    const aNorm = normalizeSettingsForSync(afterLocalRaw, a.home);
    assert.equal(bNorm.hash, aNorm.hash, "B local must equal A local on shared-subset basis");

    const aStatusFinal = await a.engine.status();
    const bStatusFinal = await b.engine.status();
    assert.equal(aStatusFinal.conflicts.length, 0);
    assert.equal(bStatusFinal.conflicts.length, 0);
  });
});

describe("M2: 같은 leaf 키 다른 값 -> leaf-conflict 폴백, 로컬/베이스 불변, sidecar = 원격 shared subset 원문", () => {
  test("M2", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m2-a", "machine-a");
    const b = makeReplica(remote, "m2-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "from-b" }));
    await b.engine.push();

    const A_CONTENT = JSON.stringify({ theme: "from-a" });
    await writeHomeFile(a, SETTINGS_KEY, A_CONTENT);

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "leaf-conflict", conflictKeys: ["theme"] },
    ]);

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, A_CONTENT, "local bytes must be unchanged");

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(sidecarPath).then(() => true).catch(() => false), "sidecar must exist");
    const sidecarBytes = await fs.readFile(sidecarPath, "utf-8");
    const remotePlain = await enginePrivate(a).downloadBlob(SETTINGS_KEY);
    assert.equal(sidecarBytes, remotePlain!.toString("utf-8"), "sidecar must equal remote normalized shared subset");

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore, "state must be unchanged");
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore, "base must be unchanged");
  });
});

describe("M3: 비-settings 파일 충돌에 merge -> not-settings 폴백, 로컬/state 불변", () => {
  test("M3", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m3-a", "machine-a");
    const b = makeReplica(remote, "m3-b", "machine-b");
    const FILE_KEY = ".claude/skills/foo.md";

    await writeHomeFile(b, FILE_KEY, "b-remote\n");
    await b.engine.push();

    await writeHomeFile(a, FILE_KEY, "a-local\n");

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem);

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: FILE_KEY, reason: "not-settings", conflictKeys: [] },
    ]);

    const afterLocal = await readHomeFile(a, FILE_KEY);
    assert.equal(afterLocal, "a-local\n");

    const absPath = path.join(a.home, ...FILE_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(sidecarPath).then(() => true).catch(() => false));
    assert.equal(await fs.readFile(sidecarPath, "utf-8"), "b-remote\n");

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

describe("M4: 원격삭제 vs 로컬수정 settings.json -> deleted 폴백, marker 생성, 로컬/베이스 불변", () => {
  test("M4", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m4-a", "machine-a");
    const b = makeReplica(remote, "m4-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    const absPathB = path.join(b.home, ...SETTINGS_KEY.split("/"));
    await fs.unlink(absPathB);
    await b.engine.push();

    const A_CONTENT = JSON.stringify({ theme: "a-modified" });
    await writeHomeFile(a, SETTINGS_KEY, A_CONTENT);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);
    assert.equal(conflictItem!.isDeletionConflict, true, "precondition: deletion conflict");

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const result = await a.engine.resolve("merge");
    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "deleted", conflictKeys: [] },
    ]);

    const absPathA = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const markerPath = `${absPathA}.conflict-deleted-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(markerPath).then(() => true).catch(() => false), "deletion marker must exist");

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, A_CONTENT, "local bytes must be unchanged");

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore);
  });
});

describe("M5: base 부재(초기 동기화 이전) -> {} 로 3-way, 서로 다른 키 추가는 머지 성공", () => {
  test("M5", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m5-a", "machine-a");
    const b = makeReplica(remote, "m5-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ onlyB: "bVal" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ onlyA: "aVal" }));

    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.equal(baseBefore, null, "precondition: no base snapshot before initial sync");

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "precondition: conflict");

    const result = await a.engine.resolve("merge");
    assert.deepEqual(result.mergeFallbacks, []);

    const afterLocal = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(afterLocal, { onlyA: "aVal", onlyB: "bVal" });
  });
});

describe("M6: 로컬 settings.json 깨진 JSON -> local-unparseable 폴백, 바이트 불변, sidecar 생성", () => {
  test("M6", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m6-a", "machine-a");
    const b = makeReplica(remote, "m6-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "v1" }));
    await b.engine.push();

    const BROKEN = "{ not valid json";
    await writeHomeFile(a, SETTINGS_KEY, BROKEN);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "local-unparseable", conflictKeys: [] },
    ]);

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, BROKEN);

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(sidecarPath).then(() => true).catch(() => false));

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

describe("M10: 2라운드 base 회귀 — 로컬전용 키가 다음 라운드에서 원격삭제로 오분류되지 않음", () => {
  test("M10", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m10-a", "machine-a");
    const b = makeReplica(remote, "m10-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ base: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ base: "v1", x: "xVal" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ base: "v1", k1: "k1Val" }));

    const pre1 = await a.engine.status();
    assert.ok(pre1.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "round1 precondition: conflict");

    const r1 = await a.engine.resolve("merge");
    assert.deepEqual(r1.mergeFallbacks, []);

    const afterA1 = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(afterA1, { base: "v1", k1: "k1Val", x: "xVal" }, "round1: union of A's k1 and B's x");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ base: "v1", x: "xVal", y: "yVal" }));
    await b.engine.push();

    const pre2 = await a.engine.status();
    assert.ok(pre2.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "round2 precondition: conflict");

    const r2 = await a.engine.resolve("merge");
    assert.deepEqual(r2.mergeFallbacks, []);

    const afterA2 = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(
      afterA2,
      { base: "v1", k1: "k1Val", x: "xVal", y: "yVal" },
      "round2: k1 must survive (base was remotePlain, not merged result) and y must merge in",
    );
  });
});

describe("M11: 머지 결과가 원격과 정확히 같아지면 다음 status 가 unchanged, push 없음", () => {
  test("M11", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m11-a", "machine-a");
    const b = makeReplica(remote, "m11-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "base" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "changed", extra: "X" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "base", extra: "X" }));

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "precondition: conflict");

    const result = await a.engine.resolve("merge");
    assert.deepEqual(result.mergeFallbacks, []);

    const afterLocal = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(afterLocal, { p: "changed", extra: "X" });

    const statusAfter = await a.engine.status();
    const item = statusAfter.items.find((i) => i.logicalKey === SETTINGS_KEY);
    assert.ok(item);
    assert.equal(item!.kind, "unchanged", "merge result identical to remote must classify as unchanged");

    const pushResult = await a.engine.push();
    assert.equal(pushResult.pushed.includes(SETTINGS_KEY), false, "no upload needed for unchanged key");
  });
});

describe("M12: keys 필터 지정 시 지정 키만 처리, 나머지 무변경", () => {
  test("M12", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m12-a", "machine-a");
    const b = makeReplica(remote, "m12-b", "machine-b");
    const OTHER_KEY = ".claude/other.md";

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await writeHomeFile(b, OTHER_KEY, "b-other\n");
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "bx" }));
    await writeHomeFile(b, OTHER_KEY, "b-other-v2\n");
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "v1", y: "ay" }));
    await writeHomeFile(a, OTHER_KEY, "a-other\n");

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY));
    assert.ok(pre.conflicts.some((c) => c.logicalKey === OTHER_KEY));

    const otherStateBefore = await readStateFile(a);
    const otherBaseBefore = await readBaseSnapshotRaw(a, OTHER_KEY);
    const otherLocalBefore = await readHomeFile(a, OTHER_KEY);

    const result = await a.engine.resolve("merge", [SETTINGS_KEY]);

    assert.deepEqual(result.mergeFallbacks, []);
    assert.deepEqual(result.resolved, [SETTINGS_KEY]);

    const settingsAfter = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(settingsAfter, { p: "v1", x: "bx", y: "ay" });

    const otherLocalAfter = await readHomeFile(a, OTHER_KEY);
    assert.equal(otherLocalAfter, otherLocalBefore, "OTHER_KEY local bytes must be unchanged");

    const otherStateAfter = await readStateFile(a);
    assert.deepEqual(otherStateAfter[OTHER_KEY], otherStateBefore[OTHER_KEY], "OTHER_KEY state must be unchanged");

    const otherBaseAfter = await readBaseSnapshotRaw(a, OTHER_KEY);
    assert.deepEqual(otherBaseAfter, otherBaseBefore, "OTHER_KEY base must be unchanged");

    const finalStatus = await a.engine.status();
    assert.ok(
      finalStatus.conflicts.some((c) => c.logicalKey === OTHER_KEY),
      "OTHER_KEY conflict must remain untouched",
    );
  });
});

describe("M13: syncAtomic({ policy: \"merge\" }) e2e — 락 경로를 실제로 타고 머지 후 push 까지 완료", () => {
  test("M13", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m13-a", "machine-a");
    const b = makeReplica(remote, "m13-b", "machine-b");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "ax" }));
    await a.engine.push();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", y: "by" }));

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY),
      "precondition: conflict must exist before syncAtomic",
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "merge" });
    if (result.aborted) {
      throw new Error(`M13: syncAtomic blocked, reason: ${(result as { reason: string }).reason}`);
    }
    assert.equal(result.aborted, false);

    const bLocal = JSON.parse(await readHomeFile(b, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(bLocal, { p: "v1", x: "ax", y: "by" }, "B 로컬은 두 변경의 합집합이어야 한다(merge 채택)");

    const c = makeReplica(remote, "m13-c", "machine-c");
    await c.engine.pull();
    const cLocal = JSON.parse(await readHomeFile(c, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(cLocal, { p: "v1", x: "ax", y: "by" }, "syncAtomic 이 머지 결과를 실제로 push 했어야 한다");

    const bStatus = await b.engine.status();
    assert.equal(bStatus.conflicts.length, 0, "머지+push 이후 잔존 충돌이 없어야 한다");
  });
});

describe("M14: 혼합 배치 — settings 는 머지, md 는 not-settings 폴백. syncAtomic 은 잔존 충돌로 차단, md 만 남음", () => {
  test("M14", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m14-a", "machine-a");
    const b = makeReplica(remote, "m14-b", "machine-b");
    const MD_KEY = ".claude/skills/note.md";

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "bx" }));
    await writeHomeFile(b, MD_KEY, "b-note\n");
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "v1", y: "ay" }));
    await writeHomeFile(a, MD_KEY, "a-note\n");

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY));
    assert.ok(pre.conflicts.some((c) => c.logicalKey === MD_KEY));

    const result = await a.engine.resolve("merge");
    assert.equal(result.mergeFallbacks?.length, 1);
    assert.equal(result.mergeFallbacks?.[0]?.logicalKey, MD_KEY);
    assert.equal(result.mergeFallbacks?.[0]?.reason, "not-settings");

    const settingsAfter = JSON.parse(await readHomeFile(a, SETTINGS_KEY)) as Record<string, unknown>;
    assert.deepEqual(settingsAfter, { p: "v1", x: "bx", y: "ay" });

    const stateAfter = await readStateFile(a);
    assert.ok(stateAfter[SETTINGS_KEY], "settings state must be updated (adopted)");

    const syncResult = await a.engine.syncAtomic({ pluginsDir: a.home, policy: "preserve-both" });
    assert.equal(syncResult.aborted, true, "잔존 충돌(MD_KEY)로 차단돼야 함");
    const blocked = syncResult as { aborted: true; reason: string; conflicts: { logicalKey: string }[] };
    assert.equal(blocked.reason, "conflicts");
    assert.deepEqual(blocked.conflicts.map((c) => c.logicalKey), [MD_KEY]);
  });
});

describe("M15: wormhole-config.json 은 isConfigJsonKey 강제로 merge 정책에서도 latest-wins 경로를 탄다(mergeFallbacks 없음)", () => {
  test("M15", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m15-a", "machine-a");
    const b = makeReplica(remote, "m15-b", "machine-b");

    await writeHomeFile(a, CONFIG_KEY, JSON.stringify({ serverUrl: "https://a.example.com" }));
    await a.engine.push();

    await writeHomeFile(b, CONFIG_KEY, JSON.stringify({ serverUrl: "https://b.example.com" }));

    const pre = await b.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === CONFIG_KEY), "precondition: conflict must exist");

    const result = await b.engine.resolve("merge");

    assert.deepEqual(
      result.mergeFallbacks,
      [],
      "config-json key bypasses the merge branch entirely via isConfigJsonKey forcing latest-wins",
    );

    const afterLocal = JSON.parse(await readHomeFile(b, CONFIG_KEY)) as Record<string, unknown>;
    assert.deepEqual(
      afterLocal,
      { serverUrl: "https://a.example.com" },
      "latest-wins forced: remote (A) content adopted verbatim, not merged",
    );

    const stateAfter = await readStateFile(b);
    assert.ok(stateAfter[CONFIG_KEY], "latest-wins path updates state");
  });
});

describe("M16: 원격 blob 이상 — 부재/0바이트/JSON 배열", () => {
  test("M16a: blob 부재 -> blob-missing, resolved 미포함, state 불변, sidecar 없음", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m16a-a", "machine-a");
    const b = makeReplica(remote, "m16a-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "a-local" }));

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    await remote.deleteFile(`blobs/${blobName(SETTINGS_KEY)}`);

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "blob-missing", conflictKeys: [] },
    ]);
    assert.deepEqual(result.resolved, [], "blob-missing must not mark key resolved");

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.equal(
      await fs.access(sidecarPath).then(() => true).catch(() => false),
      false,
      "no sidecar for blob-missing",
    );

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });

  test("M16b: 원격 blob 0바이트 -> remote-unparseable, sidecar = 0바이트 원문", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m16b-a", "machine-a");
    const b = makeReplica(remote, "m16b-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "a-local" }));

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    await putRemoteBlobPlain(remote, SETTINGS_KEY, "");

    const result = await a.engine.resolve("merge");
    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "remote-unparseable", conflictKeys: [] },
    ]);

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    const sidecarBytes = await fs.readFile(sidecarPath);
    assert.equal(sidecarBytes.length, 0, "sidecar must be exactly the 0-byte remote blob");
  });

  test("M16c: 원격 blob 이 JSON 배열 -> remote-unparseable, sidecar = 배열 원문", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m16c-a", "machine-a");
    const b = makeReplica(remote, "m16c-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "a-local" }));

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    await putRemoteBlobPlain(remote, SETTINGS_KEY, "[]");

    const result = await a.engine.resolve("merge");
    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "remote-unparseable", conflictKeys: [] },
    ]);

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    const sidecarText = await fs.readFile(sidecarPath, "utf-8");
    assert.equal(sidecarText, "[]");
  });
});

describe("M19: permissions.allow 배열을 양측이 다른 항목으로 확장하면 leaf-conflict 폴백(배열은 leaf)", () => {
  test("M19", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m19-a", "machine-a");
    const b = makeReplica(remote, "m19-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ permissions: { allow: ["Bash", "Read"] } }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ permissions: { allow: ["Bash", "Write"] } }));

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY));

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.equal(result.mergeFallbacks?.length, 1);
    assert.deepEqual(result.mergeFallbacks?.[0], {
      logicalKey: SETTINGS_KEY,
      reason: "leaf-conflict",
      conflictKeys: ["permissions.allow"],
    });

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

describe("M21: 원격 settings 가 미설치 플러그인 참조 + 로컬과 머지 가능 -> install-prereq 폴백", () => {
  test("M21", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m21-a", "machine-a");
    const b = makeReplica(remote, "m21-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(
      b,
      SETTINGS_KEY,
      JSON.stringify({ p: "v1", enabledPlugins: { "foo@bar": true } }),
    );
    await b.engine.push();

    const A_CONTENT = JSON.stringify({ p: "v1", extra: "aVal" });
    await writeHomeFile(a, SETTINGS_KEY, A_CONTENT);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.equal(result.mergeFallbacks?.length, 1);
    assert.equal(result.mergeFallbacks?.[0]?.logicalKey, SETTINGS_KEY);
    assert.equal(result.mergeFallbacks?.[0]?.reason, "install-prereq");
    assert.deepEqual(result.mergeFallbacks?.[0]?.missing, ["foo@bar"]);

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, A_CONTENT, "local file must remain unchanged on install-prereq fallback");

    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(sidecarPath).then(() => true).catch(() => false));

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

describe("M23: scope 밖 키가 충돌 목록에 있어도 runResolve 는 scope 필터 없이 sidecar 를 생성한다(현 동작 고정)", () => {
  test("M23", async () => {
    const remote = new MockWebdavRemote();
    const FILE_KEY = ".claude/scoped-out/note.md";

    const aHome = mkTmp("m23-a-home");
    const aStateDir = path.join(aHome, ".claude-sync");
    const machineIdA: MachineId = "machine-a";

    const wideConfig = buildConfig(aHome, aStateDir, [".claude/**"]);
    const narrowConfig = buildConfig(aHome, aStateDir, [".claude/other-only/**"]);

    const wideDeps: EngineDeps = {
      config: wideConfig,
      crypto: sharedCrypto,
      remote: remote.asRemoteStore(),
      machineId: machineIdA,
    };
    const narrowDeps: EngineDeps = {
      config: narrowConfig,
      crypto: sharedCrypto,
      remote: remote.asRemoteStore(),
      machineId: machineIdA,
    };
    const wideEngine = new SyncEngine(wideDeps);
    const narrowEngine = new SyncEngine(narrowDeps);
    const aReplica: Replica = {
      engine: wideEngine,
      home: aHome,
      stateDir: aStateDir,
      machineId: machineIdA,
      config: wideConfig,
    };

    const b = makeReplica(remote, "m23-b", "machine-b");

    await writeHomeFile(aReplica, FILE_KEY, "a-v1\n");
    await wideEngine.push();

    await b.engine.pull();
    await writeHomeFile(b, FILE_KEY, "b-v2\n");
    await b.engine.push();

    const preNarrow = await narrowEngine.status();
    const conflictItem = preNarrow.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem, "precondition: key still surfaces as conflict even though scope-excluded");

    const result = await narrowEngine.resolve("merge");

    assert.equal(result.mergeFallbacks?.length, 1);
    assert.equal(result.mergeFallbacks?.[0]?.logicalKey, FILE_KEY);
    assert.equal(result.mergeFallbacks?.[0]?.reason, "not-settings");

    const absPath = path.join(aHome, ...FILE_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(
      await fs.access(sidecarPath).then(() => true).catch(() => false),
      "sidecar created despite scope exclusion — no scope gate in runResolve",
    );
  });
});

describe("M24: 머지 채택 중 base 쓰기 실패 -> 로컬 롤백 + state 복원 + adopt-failed 폴백. 같은 배치의 config-json 은 정상 반영", () => {
  test("M24", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m24-a", "machine-a");
    const b = makeReplica(remote, "m24-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    const stateAfterPull = await readStateFile(a);
    const prevSettingsEntry = stateAfterPull[SETTINGS_KEY];
    assert.ok(prevSettingsEntry, "precondition: A must have a prior settings state entry");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "bx" }));
    await b.engine.push();

    const A_SETTINGS_CONTENT = JSON.stringify({ p: "v1", y: "ay" });
    await writeHomeFile(a, SETTINGS_KEY, A_SETTINGS_CONTENT);

    await writeHomeFile(b, CONFIG_KEY, JSON.stringify({ serverUrl: "https://b.example.com" }));
    await b.engine.push();
    await writeHomeFile(a, CONFIG_KEY, JSON.stringify({ serverUrl: "https://a.example.com" }));

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "precondition: settings conflict");
    assert.ok(pre.conflicts.some((c) => c.logicalKey === CONFIG_KEY), "precondition: config-json conflict");

    const baseSnapPath = baseSnapshotAbsPath(a, SETTINGS_KEY);
    await fs.rm(baseSnapPath, { force: true });
    await fs.mkdir(baseSnapPath, { recursive: true });
    await fs.writeFile(path.join(baseSnapPath, "blocker.txt"), "x");

    const result = await a.engine.resolve("merge");

    assert.equal(
      result.mergeFallbacks?.some((f) => f.logicalKey === SETTINGS_KEY && f.reason === "adopt-failed"),
      true,
      "settings.json must fall back with adopt-failed after the injected write failure",
    );

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, A_SETTINGS_CONTENT, "settings.json must be rolled back to pre-merge content");

    const stateAfter = await readStateFile(a);
    assert.deepEqual(
      stateAfter[SETTINGS_KEY],
      prevSettingsEntry,
      "settings state entry must be restored to its prior value, not deleted",
    );

    const configAfter = JSON.parse(await readHomeFile(a, CONFIG_KEY)) as Record<string, unknown>;
    assert.deepEqual(configAfter, { serverUrl: "https://b.example.com" }, "config-json in the same batch must still adopt normally");
    assert.ok(stateAfter[CONFIG_KEY], "config-json state entry must be set (writeState actually ran)");
  });
});

describe("M26: 로컬 settings.json 파일 부재 상태에서 충돌 -> local-missing 폴백, 로컬 파일 미생성", () => {
  test("M26", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m26-a", "machine-a");
    const b = makeReplica(remote, "m26-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    const absPathA = path.join(a.home, ...SETTINGS_KEY.split("/"));
    await fs.unlink(absPathA);

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "bx" }));
    await b.engine.push();

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);
    assert.equal(conflictItem!.isDeletionConflict, true);

    const stateBefore = await readStateFile(a);
    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, [
      { logicalKey: SETTINGS_KEY, reason: "local-missing", conflictKeys: [] },
    ]);

    assert.equal(await homeFileExists(a, SETTINGS_KEY), false, "local file must not be created");

    const sidecarPath = `${absPathA}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.ok(await fs.access(sidecarPath).then(() => true).catch(() => false));

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

describe("M7: planResolve dryRun 의 merge preview 정확도 — M1/M2 상황 재현", () => {
  test("M7a: 합집합 머지 가능 상황 -> mergeable=true, conflictKeys=[], plannedCopyPath=null, fs/state/base 무변경", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m7a-a", "machine-a");
    const b = makeReplica(remote, "m7a-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ shared: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ shared: "v1", onlyB: "bVal" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ shared: "v1", onlyA: "aVal" }));
    const localBytesBefore = await readHomeFile(a, SETTINGS_KEY);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const result = await a.engine.resolve("merge", undefined, { dryRun: true });

    assert.equal(result.mergeFallbacks, undefined, "dryRun must not populate mergeFallbacks");
    assert.ok(result.preview, "preview must be present on dryRun");
    const item = result.preview!.find((p) => p.logicalKey === SETTINGS_KEY);
    assert.ok(item);
    assert.equal(item!.mergeable, true);
    assert.deepEqual(item!.conflictKeys, []);
    assert.equal(item!.plannedCopyPath, null);
    assert.equal(item!.copyPathUncertain, false);
    assert.equal(item!.deletionConflict, false);
    assert.equal(item!.localHash, conflictItem!.localHash);
    assert.equal(item!.remoteHash, conflictItem!.remoteHash);
    assert.equal(item!.remoteMachineId, conflictItem!.remoteMachineId);
    assert.equal(item!.remoteGeneration, conflictItem!.remoteGeneration);

    const localBytesAfter = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(localBytesAfter, localBytesBefore, "dryRun must not touch local file");
    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.equal(
      await fs.access(sidecarPath).then(() => true).catch(() => false),
      false,
      "dryRun must not create sidecar",
    );
    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore);
  });

  test("M7b: leaf 충돌 상황 -> mergeable=false, conflictKeys=[그키], plannedCopyPath=사이드카 절대경로, fs/state/base 무변경", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m7b-a", "machine-a");
    const b = makeReplica(remote, "m7b-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "from-b" }));
    await b.engine.push();

    const A_CONTENT = JSON.stringify({ theme: "from-a" });
    await writeHomeFile(a, SETTINGS_KEY, A_CONTENT);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const result = await a.engine.resolve("merge", undefined, { dryRun: true });

    assert.ok(result.preview);
    const item = result.preview!.find((p) => p.logicalKey === SETTINGS_KEY);
    assert.ok(item);
    assert.equal(item!.mergeable, false);
    assert.deepEqual(item!.conflictKeys, ["theme"]);
    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const expectedSidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.equal(item!.plannedCopyPath, expectedSidecarPath);
    assert.equal(item!.copyPathUncertain, false);

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(afterLocal, A_CONTENT, "dryRun must not touch local file");
    assert.equal(
      await fs.access(expectedSidecarPath).then(() => true).catch(() => false),
      false,
      "dryRun must not create sidecar",
    );
    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore);
  });
});

describe("M22: preview 정확도 — home 밖 사이드카 가드, blob 다운로드 실패, 실행 결과와의 일치", () => {
  test("M22a: sidecarPath 가 home 밖으로 계산되면(가드 발동) plannedCopyPath=null, copyPathUncertain=false", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m22a-a", "machine-a");
    const b = makeReplica(remote, "m22a-b", "machine-b");
    const FILE_KEY = ".claude/skills/foo.md";

    await writeHomeFile(b, FILE_KEY, "b-remote\n");
    await b.engine.push();
    await writeHomeFile(a, FILE_KEY, "a-local\n");

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem);

    const outsideDir = mkTmp("m22a-outside");
    const outsideAbsPath = path.join(outsideDir, "foo.md");
    const enginePatched = a.engine as unknown as { safeAbsPath: (k: string) => string | null };
    const originalSafeAbsPath = enginePatched.safeAbsPath.bind(a.engine);
    enginePatched.safeAbsPath = (key: string) => (key === FILE_KEY ? outsideAbsPath : originalSafeAbsPath(key));

    try {
      const result = await a.engine.resolve("merge", undefined, { dryRun: true });
      assert.ok(result.preview);
      const item = result.preview!.find((p) => p.logicalKey === FILE_KEY);
      assert.ok(item, "item must be present in preview despite guard trip");
      assert.equal(item!.plannedCopyPath, null);
      assert.equal(item!.copyPathUncertain, false);
      assert.equal(item!.mergeable, null);
      assert.deepEqual(item!.conflictKeys, []);
    } finally {
      enginePatched.safeAbsPath = originalSafeAbsPath;
    }
  });

  test("M22b: settings key 의 blob 다운로드 실패 -> mergeable=null, copyPathUncertain=true, plannedCopyPath=null, fs/state/base 무변경", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m22b-a", "machine-a");
    const b = makeReplica(remote, "m22b-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();

    const A_CONTENT = JSON.stringify({ p: "a-local" });
    await writeHomeFile(a, SETTINGS_KEY, A_CONTENT);

    const pre = await a.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem);

    await remote.deleteFile(`blobs/${blobName(SETTINGS_KEY)}`);

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const result = await a.engine.resolve("merge", undefined, { dryRun: true });
    assert.ok(result.preview);
    const item = result.preview!.find((p) => p.logicalKey === SETTINGS_KEY);
    assert.ok(item);
    assert.equal(item!.mergeable, null);
    assert.equal(item!.copyPathUncertain, true);
    assert.equal(item!.plannedCopyPath, null);
    assert.deepEqual(item!.conflictKeys, []);

    const localAfter = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(localAfter, A_CONTENT, "dryRun must not touch local file");
    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));
    const sidecarPath = `${absPath}.conflict-${conflictItem!.remoteMachineId}-${conflictItem!.remoteGeneration}`;
    assert.equal(
      await fs.access(sidecarPath).then(() => true).catch(() => false),
      false,
      "dryRun must not create sidecar",
    );
    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore);
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore);
  });

  test("M22c: leaf-conflict dryRun 의 plannedCopyPath 가 실제 resolve 의 conflictCopies 경로와 일치", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m22c-a", "machine-a");
    const b = makeReplica(remote, "m22c-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ theme: "from-b" }));
    await b.engine.push();

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ theme: "from-a" }));

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY));

    const dryRunResult = await a.engine.resolve("merge", undefined, { dryRun: true });
    assert.ok(dryRunResult.preview);
    const previewItem = dryRunResult.preview!.find((p) => p.logicalKey === SETTINGS_KEY);
    assert.ok(previewItem);
    assert.equal(previewItem!.mergeable, false);
    assert.ok(previewItem!.plannedCopyPath, "preview must predict a sidecar path");

    const realResult = await a.engine.resolve("merge");
    const realCopy = realResult.conflictCopies.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(realCopy);
    assert.equal(previewItem!.plannedCopyPath, realCopy!.copyPath, "predicted path must match actual sidecar path");
  });
});

describe("M27: 병합 채택 직전 로컬 파일 외부 변경 감지 -> adopt-failed 폴백, 동시 로컬 변경 보존, 백업은 머지 입력 바이트와 일치", () => {
  test("M27", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m27-a", "machine-a");
    const b = makeReplica(remote, "m27-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1", x: "bx" }));
    await b.engine.push();

    const A_MERGE_INPUT = JSON.stringify({ p: "v1", y: "ay" });
    await writeHomeFile(a, SETTINGS_KEY, A_MERGE_INPUT);

    const pre = await a.engine.status();
    assert.ok(pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY), "precondition: conflict");

    const stateBefore = await readStateFile(a);
    const baseBefore = await readBaseSnapshotRaw(a, SETTINGS_KEY);

    const RACE_CONTENT = JSON.stringify({ p: "v1", y: "ay", raceKey: "injected-during-merge" });
    const absPath = path.join(a.home, ...SETTINGS_KEY.split("/"));

    const enginePatched = a.engine as unknown as {
      readBaseSnapshotJson(key: string): Promise<Record<string, unknown> | null>;
    };
    const original = enginePatched.readBaseSnapshotJson.bind(a.engine);
    let raceInjected = false;
    enginePatched.readBaseSnapshotJson = async (key: string) => {
      const value = await original(key);
      if (key === SETTINGS_KEY && !raceInjected) {
        raceInjected = true;
        await fs.writeFile(absPath, RACE_CONTENT, "utf-8");
      }
      return value;
    };

    const result = await a.engine.resolve("merge");
    enginePatched.readBaseSnapshotJson = original;

    assert.equal(raceInjected, true, "precondition: race must have been injected mid-merge");
    assert.deepEqual(
      result.mergeFallbacks,
      [{ logicalKey: SETTINGS_KEY, reason: "adopt-failed", conflictKeys: [] }],
      "external local change between merge-input read and write must abort adoption",
    );

    const afterLocal = await readHomeFile(a, SETTINGS_KEY);
    assert.equal(
      afterLocal,
      RACE_CONTENT,
      "concurrent local write mid-merge must survive untouched, not be silently overwritten by the stale merge result",
    );

    assert.ok(result.backupDir, "backupDir must be set — backupFile runs before the pre-write consistency check");
    const backupBytes = await fs.readFile(
      path.join(result.backupDir as string, ...SETTINGS_KEY.split("/")),
      "utf-8",
    );
    assert.equal(
      backupBytes,
      A_MERGE_INPUT,
      "backup must equal the exact bytes used as merge input, not a fresh disk re-read at backup time",
    );

    const stateAfter = await readStateFile(a);
    assert.deepEqual(stateAfter, stateBefore, "state must remain unchanged when adoption is aborted");
    const baseAfter = await readBaseSnapshotRaw(a, SETTINGS_KEY);
    assert.deepEqual(baseAfter, baseBefore, "base snapshot must remain unchanged when adoption is aborted");
  });
});

describe("M28: 원격 manifest 없음(첫 동기화 이전) -> resolve(merge) early return, mergeFallbacks=[]", () => {
  test("M28", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m28-a", "machine-a");

    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, []);
    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.conflictCopies, []);
    assert.equal(result.backupDir, null);
  });
});

describe("M29: 충돌 0건 -> resolve(merge) early return, mergeFallbacks=[]", () => {
  test("M29", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m29-a", "machine-a");
    const b = makeReplica(remote, "m29-b", "machine-b");

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ p: "v1" }));
    await b.engine.push();
    await a.engine.pull();

    const pre = await a.engine.status();
    assert.equal(pre.conflicts.length, 0, "precondition: no conflicts");

    const result = await a.engine.resolve("merge");

    assert.deepEqual(result.mergeFallbacks, []);
    assert.deepEqual(result.resolved, []);
  });
});
