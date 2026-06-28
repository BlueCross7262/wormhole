import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId, PushResult } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { sha256 } from "./hash.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-ours-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function buildConfig(home: string, stateDir: string): Config {
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
      include: [".claude/**"],
      exclude: [],
    },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  };
}

function makeReplica(remote: MockWebdavRemote, label: string, machineId: MachineId): Replica {
  const home = mkTmp(`${label}-home`);
  const stateDir = path.join(home, ".claude-sync");
  const config = buildConfig(home, stateDir);
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

const FILE_KEY = ".claude/ours-test-file.txt";

describe("H2: ours 해소 후 원격 contentHash = sha256(로컬), 로컬 파일 불변", () => {
  test("H2: resolve(ours) + syncAtomic → 원격 = 로컬 내용, 로컬 파일 바이트 불변", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h2-a", "machine-a");
    const b = makeReplica(remote, "h2-b", "machine-b");
    const c = makeReplica(remote, "h2-c", "machine-c");

    const REMOTE_CONTENT = "a-remote-content\n";
    const LOCAL_CONTENT = "b-local-wins\n";

    await writeHomeFile(a, FILE_KEY, "initial\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, FILE_KEY, REMOTE_CONTENT);
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, LOCAL_CONTENT);

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((con) => con.logicalKey === FILE_KEY),
      "precondition: conflict must exist",
    );

    await b.engine.resolve("ours");

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    if (result.aborted) {
      throw new Error(`H2: syncAtomic blocked after ours resolve, reason: ${(result as { reason: string }).reason}`);
    }

    const bLocalContent = await readHomeFile(b, FILE_KEY);
    assert.equal(bLocalContent, LOCAL_CONTENT, "B's local file must be unchanged after ours resolve");

    await c.engine.pull();
    const cContent = await readHomeFile(c, FILE_KEY);
    assert.equal(cContent, LOCAL_CONTENT, "remote must have B's local content (ours provenance)");
    assert.notEqual(cContent, REMOTE_CONTENT, "remote must NOT have A's content");

    assert.equal(sha256(cContent), sha256(LOCAL_CONTENT), "remote contentHash must equal sha256(localContent)");
    assert.notEqual(sha256(cContent), sha256(REMOTE_CONTENT), "remote contentHash must NOT equal sha256(remoteContent)");
  });
});

describe("H3: ours 후 push → entries[key].generation === genBefore + 1 (엔트리 레벨)", () => {
  test("H3: resolve(ours) + syncAtomic → remoteGeneration === conflictGen + 1", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h3-a", "machine-a");
    const b = makeReplica(remote, "h3-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "initial\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, FILE_KEY, "a-v2\n");
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-local\n");

    const pre = await b.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem, "precondition: conflict must exist");

    const genBefore = conflictItem.remoteGeneration;

    await b.engine.resolve("ours");

    const afterResolve = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    if (afterResolve.aborted) {
      throw new Error(`H3: syncAtomic blocked after ours resolve, reason: ${(afterResolve as { reason: string }).reason}`);
    }

    const statusAfter = await b.engine.status();
    const item = statusAfter.items.find((i) => i.logicalKey === FILE_KEY);
    assert.ok(item, "FILE_KEY must appear in status items after push");
    assert.equal(
      item.remoteGeneration,
      genBefore + 1,
      `entry-level generation must be genBefore(${genBefore}) + 1`,
    );
  });
});

describe("H8: ours 원격삭제 해소", () => {
  test("H8a: resolve(ours) on deletion-conflict → status 키 kind === 'added'", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h8a-a", "machine-a");
    const b = makeReplica(remote, "h8a-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "initial\n");
    await a.engine.push();
    await b.engine.pull();

    const absPathA = path.join(a.home, ...FILE_KEY.split("/"));
    await fs.unlink(absPathA);
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-keeps-this\n");

    const pre = await b.engine.status();
    const conflictItem = pre.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem, "precondition: deletion conflict must exist");
    assert.equal(conflictItem.isDeletionConflict, true, "precondition: must be deletion conflict");

    await b.engine.resolve("ours");

    const statusAfter = await b.engine.status();
    const item = statusAfter.items.find((i) => i.logicalKey === FILE_KEY);
    assert.ok(item, "FILE_KEY must appear in status items after ours resolve");
    assert.equal(
      item.kind,
      "added",
      "kind must be 'added' after ours on deletion-conflict — local file survives, base removed",
    );
    assert.equal(
      statusAfter.conflicts.some((c) => c.logicalKey === FILE_KEY),
      false,
      "conflict must be cleared after ours resolve",
    );
  });

  test("H8b: ours 원격삭제 후 syncAtomic → 원격 엔트리 deleted=false, contentHash=sha256(로컬), generation=tombstone+1", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h8b-a", "machine-a");
    const b = makeReplica(remote, "h8b-b", "machine-b");
    const c = makeReplica(remote, "h8b-c", "machine-c");

    const LOCAL_CONTENT = "b-resurrects-this\n";

    await writeHomeFile(a, FILE_KEY, "initial\n");
    await a.engine.push();
    await b.engine.pull();

    const absPathA = path.join(a.home, ...FILE_KEY.split("/"));
    await fs.unlink(absPathA);
    await a.engine.push();

    const preDeleteStatus = await b.engine.status();
    const tombstoneItem = preDeleteStatus.items.find((i) => i.logicalKey === FILE_KEY);
    assert.ok(tombstoneItem, "precondition: item must exist showing remote deletion");
    const tombstoneGen = tombstoneItem.remoteGeneration;
    assert.ok(tombstoneGen !== null, "precondition: tombstone generation must be known");

    await writeHomeFile(b, FILE_KEY, LOCAL_CONTENT);

    const prePull = await b.engine.status();
    const conflictItem = prePull.conflicts.find((c) => c.logicalKey === FILE_KEY);
    assert.ok(conflictItem, "precondition: deletion conflict must exist");

    await b.engine.resolve("ours");

    const afterResolve = await b.engine.status();
    const resolvedItem = afterResolve.items.find((i) => i.logicalKey === FILE_KEY);
    assert.ok(resolvedItem, "precondition: FILE_KEY must appear after ours resolve");
    assert.equal(resolvedItem.kind, "added", "precondition: H8a — kind must be 'added'");

    const syncResult = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    if (syncResult.aborted) {
      throw new Error(`H8b: syncAtomic blocked unexpectedly, reason: ${(syncResult as { reason: string }).reason}`);
    }

    await c.engine.pull();
    const cContent = await readHomeFile(c, FILE_KEY);
    assert.equal(
      cContent,
      LOCAL_CONTENT,
      "remote must have B's local content after ours push (deleted=false, resurrected)",
    );

    const cStatusAfter = await c.engine.status();
    const cItem = cStatusAfter.items.find((i) => i.logicalKey === FILE_KEY);
    assert.ok(cItem, "C must see the file after B's push");
    assert.equal(cItem.kind, "unchanged", "file must be 'unchanged' in C after pull");
    assert.equal(
      cItem.remoteGeneration,
      (tombstoneGen as number) + 1,
      `entry generation must be tombstone generation(${tombstoneGen}) + 1`,
    );
  });
});

describe("H4d: settings.json ours 원격삭제 stale-base 클린업", () => {
  const SETTINGS_KEY = ".claude/settings.json";

  test("H4d-a: resolve(ours) 후 readBaseSnapshotJson(settings.json) === null (stale-base 회귀 방어)", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h4d-a-a", "machine-a");
    const b = makeReplica(remote, "h4d-a-b", "machine-b");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ apiKeyHelper: "initial" }));
    await a.engine.push();
    await b.engine.pull();

    const absPathA = path.join(a.home, ...SETTINGS_KEY.split("/"));
    await fs.unlink(absPathA);
    await a.engine.push();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ apiKeyHelper: "b-keeps-this" }));

    const prePull = await b.engine.status();
    const conflictItem = prePull.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem, "precondition: deletion conflict must exist for settings.json");

    const enginePrivate = b.engine as unknown as {
      readBaseSnapshotJson(key: string): Promise<Record<string, unknown> | null>;
    };
    const baseBefore = await enginePrivate.readBaseSnapshotJson(SETTINGS_KEY);
    assert.notEqual(baseBefore, null, "precondition: base snapshot must exist before resolve — regression guard proves removeBaseSnapshot is load-bearing");

    await b.engine.resolve("ours");

    const baseAfter = await enginePrivate.readBaseSnapshotJson(SETTINGS_KEY);
    assert.equal(baseAfter, null, "base snapshot must be null after resolve(ours) — removeBaseSnapshot must have run for settings.json");
  });

  test("H4d-b: ours 원격삭제 후 syncAtomic → 원격 settings.json 콘텐츠 == 로컬 (stale-base 오염 없음)", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h4d-b-a", "machine-a");
    const b = makeReplica(remote, "h4d-b-b", "machine-b");
    const c = makeReplica(remote, "h4d-b-c", "machine-c");

    const LOCAL_OBJ = { apiKeyHelper: "b-keeps-this" };
    const LOCAL_CONTENT = JSON.stringify(LOCAL_OBJ);

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ apiKeyHelper: "initial" }));
    await a.engine.push();
    await b.engine.pull();

    const absPathA = path.join(a.home, ...SETTINGS_KEY.split("/"));
    await fs.unlink(absPathA);
    await a.engine.push();

    await writeHomeFile(b, SETTINGS_KEY, LOCAL_CONTENT);

    const prePull = await b.engine.status();
    const conflictItem = prePull.conflicts.find((c) => c.logicalKey === SETTINGS_KEY);
    assert.ok(conflictItem, "precondition: deletion conflict must exist");

    await b.engine.resolve("ours");

    const syncResult = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    if (syncResult.aborted) {
      throw new Error(`H4d-b: syncAtomic blocked unexpectedly, reason: ${(syncResult as { reason: string }).reason}`);
    }

    await c.engine.pull();
    const cContent = await readHomeFile(c, SETTINGS_KEY);
    assert.deepEqual(
      JSON.parse(cContent),
      LOCAL_OBJ,
      "remote settings.json must equal B's local content — no stale-base 3-way merge corruption",
    );
  });
});
