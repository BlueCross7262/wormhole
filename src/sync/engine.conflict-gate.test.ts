import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId, ConflictDetail, PushResult } from "../types.js";
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
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-cg-${label}-`));
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

const FILE_KEY = ".claude/test-conflict.txt";
const CONFIG_KEY = ".claude/wormhole-config.json";
const SETTINGS_KEY = ".claude/settings.json";

describe("H1: 차단된 sync 는 무손실(manifestGeneration 불변)", () => {
  test("H1a: 비충돌 로컬 수정 형제 키 있어도 manifestGeneration 불변", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h1a-a", "machine-a");
    const b = makeReplica(remote, "h1a-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "a-initial\n");
    await writeHomeFile(a, ".claude/sibling.txt", "sibling-v1\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, FILE_KEY, "a-modified\n");
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-modified\n");
    await writeHomeFile(b, ".claude/sibling.txt", "sibling-b-local\n");

    const statusBefore = await b.engine.status();
    assert.ok(
      statusBefore.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: conflict must exist for FILE_KEY",
    );
    const genBefore = statusBefore.manifestGeneration;

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "syncAtomic should be blocked");
    assert.equal((result as { reason: string }).reason, "conflicts");

    const statusAfter = await b.engine.status();
    assert.equal(
      statusAfter.manifestGeneration,
      genBefore,
      "manifestGeneration must not advance when push is blocked",
    );
  });

  test("H1b: 비충돌 로컬 삭제 형제 키 있어도 manifestGeneration 불변", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h1b-a", "machine-a");
    const b = makeReplica(remote, "h1b-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "a-initial\n");
    await writeHomeFile(a, ".claude/deleteme.txt", "to-be-deleted\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, FILE_KEY, "a-modified\n");
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-modified\n");
    const deleteAbs = path.join(b.home, ".claude", "deleteme.txt");
    await fs.unlink(deleteAbs);

    const statusBefore = await b.engine.status();
    assert.ok(
      statusBefore.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: conflict must exist for FILE_KEY",
    );
    const genBefore = statusBefore.manifestGeneration;

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "syncAtomic should be blocked");

    const statusAfter = await b.engine.status();
    assert.equal(
      statusAfter.manifestGeneration,
      genBefore,
      "manifestGeneration must not advance when push is blocked",
    );
  });
});

describe("H4: settings.json/.claude.json 차단, wormhole-config.json 비차단", () => {
  test("H4a: settings.json 발산 충돌 → syncAtomic 차단", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h4a-a", "machine-a");
    const b = makeReplica(remote, "h4a-b", "machine-b");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ testKey: "from-a", shared: 1 }));
    await a.engine.push();

    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ testKey: "from-b", shared: 1 }));

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY),
      `precondition: conflict must exist for ${SETTINGS_KEY}`,
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "settings.json hard-conflict should block syncAtomic");
    assert.equal(
      (result as { reason: string }).reason,
      "conflicts",
      "reason must be 'conflicts'",
    );
  });

  test("H4b: 차단 후 settings.json 로컬 파일 바이트 불변", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h4b-a", "machine-a");
    const b = makeReplica(remote, "h4b-b", "machine-b");

    const B_CONTENT = JSON.stringify({ testKey: "from-b", shared: 1 });
    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ testKey: "from-a", shared: 1 }));
    await a.engine.push();
    await writeHomeFile(b, SETTINGS_KEY, B_CONTENT);

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === SETTINGS_KEY),
      "precondition: conflict must exist",
    );

    await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    const afterContent = await readHomeFile(b, SETTINGS_KEY);
    assert.equal(afterContent, B_CONTENT, "local settings.json byte content must be unchanged after block");
  });

  test("H4c: wormhole-config.json 충돌 → syncAtomic 비차단(auto-resolve)", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h4c-a", "machine-a");
    const b = makeReplica(remote, "h4c-b", "machine-b");

    await writeHomeFile(a, CONFIG_KEY, JSON.stringify({ serverUrl: "https://a.example.com" }));
    await a.engine.push();

    await writeHomeFile(b, CONFIG_KEY, JSON.stringify({ serverUrl: "https://b.example.com" }));

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      `precondition: conflict must exist for ${CONFIG_KEY}`,
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(
      result.aborted,
      false,
      "wormhole-config.json conflict must NOT block syncAtomic (auto-resolves via latest-wins)",
    );
  });
});

describe("H5: 사이드카 .conflict-* 파일 스캐너 제외", () => {
  test("H5a: preserve-both 생성 사이드카가 status().items 에 나타나지 않아야 함", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h5a-a", "machine-a");
    const b = makeReplica(remote, "h5a-b", "machine-b");

    const A_CONTENT = "a-remote-content\n";
    await writeHomeFile(a, FILE_KEY, A_CONTENT);
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-local-content\n");

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: conflict must exist",
    );

    const blockResult = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    assert.equal(blockResult.aborted, true, "precondition: must be blocked");

    const sidecarKey = `${FILE_KEY}.conflict-machine-a-1`;

    const statusAfter = await b.engine.status();
    assert.equal(
      statusAfter.items.some((i) => i.logicalKey === sidecarKey),
      false,
      `sidecar '${sidecarKey}' must NOT appear in status().items — scanner should exclude .conflict-* files`,
    );
  });

  test("H5b: preserve-both 생성 사이드카가 push.pushed 에 포함되지 않아야 함", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h5b-a", "machine-a");
    const b = makeReplica(remote, "h5b-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "a-remote-content\n");
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-local-content\n");

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: conflict must exist",
    );

    const blockResult = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    assert.equal(blockResult.aborted, true, "precondition: preserve-both must block");

    const sidecarKey = `${FILE_KEY}.conflict-machine-a-1`;

    const latestWinsResult = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "latest-wins" });
    if (latestWinsResult.aborted) {
      throw new Error(`H5b precondition: latest-wins syncAtomic must not be blocked, got reason: ${(latestWinsResult as { reason: string }).reason}`);
    }

    assert.equal(
      latestWinsResult.push.pushed.some((k) => k === sidecarKey),
      false,
      `sidecar '${sidecarKey}' must NOT appear in push.pushed — scanner should exclude .conflict-* files`,
    );
  });
});

describe("H6: 차단 중에도 비충돌 원격 변경은 로컬에 반영", () => {
  test("H6: pull 시 비충돌 키 로컬 반영, 차단 후 해당 파일 내용 == 원격", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h6-a", "machine-a");
    const b = makeReplica(remote, "h6-b", "machine-b");

    const CONFLICT_KEY = FILE_KEY;
    const NOCONFLICT_KEY = ".claude/noconflict.txt";

    await writeHomeFile(a, CONFLICT_KEY, "initial\n");
    await writeHomeFile(a, NOCONFLICT_KEY, "nc-v1\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, CONFLICT_KEY, "a-v2\n");
    await writeHomeFile(a, NOCONFLICT_KEY, "nc-v2\n");
    await a.engine.push();

    await writeHomeFile(b, CONFLICT_KEY, "b-local\n");

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === CONFLICT_KEY),
      "precondition: conflict must exist for CONFLICT_KEY",
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "syncAtomic should be blocked due to conflict");

    const ncContent = await readHomeFile(b, NOCONFLICT_KEY);
    assert.equal(ncContent, "nc-v2\n", "non-conflict key must be pulled to remote content");

    const statusAfter = await b.engine.status();
    const ncItem = statusAfter.items.find((i) => i.logicalKey === NOCONFLICT_KEY);
    assert.ok(ncItem, "NOCONFLICT_KEY must appear in status items");
    assert.equal(ncItem.kind, "unchanged", "non-conflict key must be 'unchanged' after pull");
  });
});

describe("H7: blocked.conflicts 필드 기대값 정확성(실 엔진)", () => {
  test("H7: ConflictDetail 필드 전부 기대값 assert", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h7-a", "machine-a");
    const b = makeReplica(remote, "h7-b", "machine-b");

    const A_CONTENT = "a-known-content\n";
    const B_CONTENT = "b-known-content\n";

    await writeHomeFile(a, FILE_KEY, A_CONTENT);
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, B_CONTENT);

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: conflict must exist",
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "syncAtomic must be blocked");
    assert.equal((result as { reason: string }).reason, "conflicts");

    const blockedResult = result as { aborted: true; reason: "conflicts"; conflicts: ConflictDetail[] };
    assert.equal(blockedResult.conflicts.length, 1, "exactly one conflict");

    const cDetail = blockedResult.conflicts[0];
    assert.equal(cDetail.logicalKey, FILE_KEY, "logicalKey must match");

    const expectedLocalHash = sha256(B_CONTENT);
    const expectedRemoteHash = sha256(A_CONTENT);
    assert.equal(cDetail.localHash, expectedLocalHash, "localHash must be sha256(B's content)");
    assert.equal(cDetail.remoteHash, expectedRemoteHash, "remoteHash must be sha256(A's content)");

    assert.equal(cDetail.remoteMachineId, "machine-a", "remoteMachineId must be machine-a");
    assert.equal(cDetail.remoteGeneration, 1, "remoteGeneration must be 1 (first push)");

    const expectedAbsPath = path.join(b.home, ...FILE_KEY.split("/"));
    const expectedCopyPath = `${expectedAbsPath}.conflict-machine-a-1`;
    assert.equal(cDetail.copyPath, expectedCopyPath, "copyPath must match expected sidecar path");
    assert.ok(existsSync(cDetail.copyPath), "copyPath file must exist on disk");
  });

  test("H7-b: 충돌 2건 각 copyPath 가 해당 키에 1:1 매핑(미스조인 없음)", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h7b-a", "machine-a");
    const b = makeReplica(remote, "h7b-b", "machine-b");

    const KEY_1 = ".claude/conflict-mis-join-1.txt";
    const KEY_2 = ".claude/conflict-mis-join-2.txt";

    await writeHomeFile(a, KEY_1, "a-content-key1\n");
    await writeHomeFile(a, KEY_2, "a-content-key2\n");
    await a.engine.push();

    await writeHomeFile(b, KEY_1, "b-content-key1\n");
    await writeHomeFile(b, KEY_2, "b-content-key2\n");

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "must be blocked with 2 conflicts");
    const blockedResult = result as { aborted: true; reason: "conflicts"; conflicts: ConflictDetail[] };
    assert.equal(blockedResult.conflicts.length, 2, "exactly two conflicts");

    const detail1 = blockedResult.conflicts.find((c) => c.logicalKey === KEY_1);
    const detail2 = blockedResult.conflicts.find((c) => c.logicalKey === KEY_2);
    assert.ok(detail1, "conflict for KEY_1 must exist");
    assert.ok(detail2, "conflict for KEY_2 must exist");

    const expectedPath1 = `${path.join(b.home, ...KEY_1.split("/"))}.conflict-machine-a-1`;
    const expectedPath2 = `${path.join(b.home, ...KEY_2.split("/"))}.conflict-machine-a-1`;

    assert.equal(detail1.copyPath, expectedPath1, "KEY_1 copyPath must map to KEY_1 sidecar, not KEY_2");
    assert.equal(detail2.copyPath, expectedPath2, "KEY_2 copyPath must map to KEY_2 sidecar, not KEY_1");
    assert.ok(existsSync(detail1.copyPath), "KEY_1 sidecar must exist on disk");
    assert.ok(existsSync(detail2.copyPath), "KEY_2 sidecar must exist on disk");
  });
});

describe("H9: blocked.conflicts 키셋 = 일반 충돌 키만(config 키 제외)", () => {
  test("H9: wormhole-config.json 충돌 키는 반환 conflicts 에서 제외", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "h9-a", "machine-a");
    const b = makeReplica(remote, "h9-b", "machine-b");

    await writeHomeFile(a, FILE_KEY, "a-content\n");
    await writeHomeFile(a, CONFIG_KEY, JSON.stringify({ url: "https://a.example" }));
    await a.engine.push();

    await writeHomeFile(b, FILE_KEY, "b-content\n");
    await writeHomeFile(b, CONFIG_KEY, JSON.stringify({ url: "https://b.example" }));

    const pre = await b.engine.status();
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === FILE_KEY),
      "precondition: regular conflict must exist",
    );
    assert.ok(
      pre.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      "precondition: config conflict must exist",
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });

    assert.equal(result.aborted, true, "syncAtomic must be blocked");
    assert.equal((result as { reason: string }).reason, "conflicts");

    const blockedResult = result as { aborted: true; reason: "conflicts"; conflicts: ConflictDetail[] };

    const conflictKeys = blockedResult.conflicts.map((c) => c.logicalKey).sort();
    assert.deepEqual(
      conflictKeys,
      [FILE_KEY].sort(),
      "blocked conflicts must contain ONLY the regular conflict key, not config key",
    );
  });
});
