import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { ManifestStore } from "./manifest.js";

const REMOTE_BASE = "/claude-sync";

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cs-descope-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildConfig(home: string, stateDir: string, include: string[]): Config {
  return {
    stateDir,
    home,
    remote: {
      url: "http://mock.invalid",
      username: "",
      password: "",
      remoteBaseDir: REMOTE_BASE,
    },
    crypto: {
      passphraseEnv: "CLAUDE_SYNC_PASSPHRASE",
      passphraseFile: path.join(stateDir, "passphrase"),
      derivedKeyPath: path.join(stateDir, "age-key.txt"),
      kdfN: 2,
      kdfR: 8,
      kdfP: 1,
    },
    targets: {
      include,
      exclude: [],
    },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  };
}

function makeEngine(
  remote: MockWebdavRemote,
  home: string,
  stateDir: string,
  machineId: MachineId,
  include: string[],
  backoff: number[] = [],
): SyncEngine {
  const config = buildConfig(home, stateDir, include);
  const deps: EngineDeps = {
    config,
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
    casRetryBackoffMs: backoff,
  };
  return new SyncEngine(deps);
}

async function writeFile(home: string, logicalKey: string, content: string): Promise<void> {
  const abs = path.join(home, ...logicalKey.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function readRemoteManifest(remote: MockWebdavRemote, home: string, stateDir: string) {
  const config = buildConfig(home, stateDir, []);
  const store = new ManifestStore(remote.asRemoteStore(), sharedCrypto, config, []);
  return store.read();
}

describe("de-scope-only push — manifest 원격 반영", () => {
  test("de-scope-only run 이 manifestGeneration 전진 + scopeExcluded=true 기록", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("gen");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");

    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    const firstPush = await engine1.push();
    assert.deepEqual(firstPush.pushed, [SKILL_KEY], "첫 push 에서 skill-a 포함");
    const genAfterFirstPush = firstPush.manifestGeneration as number;

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    const descopePush = await engine2.push();

    assert.ok(
      (descopePush.manifestGeneration as number) > genAfterFirstPush,
      `de-scope-only push 가 manifest 를 써야 함 (gen ${genAfterFirstPush} → ${descopePush.manifestGeneration})`,
    );

    const manifest = await readRemoteManifest(remote, home, stateDir);
    assert.ok(manifest !== null, "remote manifest 존재");
    const entry = manifest!.entries[SKILL_KEY];
    assert.ok(entry !== undefined, "skill-a 엔트리 존재");
    assert.equal(entry.scopeExcluded, true, "skill-a 가 scopeExcluded=true 로 마킹됨");
  });

  test("de-scope 스킬은 push.deleted 목록에 없음", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("notdel");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");

    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    await engine1.push();

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    const descopePush = await engine2.push();

    assert.ok(!descopePush.deleted.includes(SKILL_KEY), "skill-a 가 deleted 에 없어야 함");
  });

  test("마커 재추가(내용 변경) → sync 재개 + scopeExcluded 해제 + 원격 신내용 반영", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("react-mod");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    await engine1.push();
    const v1 = (await readRemoteManifest(remote, home, stateDir))!.entries[SKILL_KEY].contentHash;

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    await engine2.push();

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A v2\n");
    const engine3 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    const rescopePush = await engine3.push();

    assert.ok(rescopePush.pushed.includes(SKILL_KEY), "마커 재추가 → 재push 로 sync 재개");
    const entry = (await readRemoteManifest(remote, home, stateDir))!.entries[SKILL_KEY];
    assert.ok(!entry.scopeExcluded, "scopeExcluded 해제됨");
    assert.notEqual(entry.contentHash, v1, "원격이 v2 내용으로 갱신됨");
    assert.equal(entry.deleted, false, "삭제 아님");
  });

  test("마커 재추가(내용 동일) → sync 재개 + scopeExcluded 해제", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("react-same");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    await engine1.push();

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    await engine2.push();

    const engine3 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    const rescopePush = await engine3.push();

    assert.ok(rescopePush.pushed.includes(SKILL_KEY), "동일 내용도 재push 로 flag 해제");
    const entry = (await readRemoteManifest(remote, home, stateDir))!.entries[SKILL_KEY];
    assert.ok(!entry.scopeExcluded, "scopeExcluded 해제됨");
  });

  test("de-scope 변경 없는 sync 는 여전히 조기 return — manifest 재쓰기 없음", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("idem");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");

    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    const firstPush = await engine1.push();

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    const secondPush = await engine2.push();

    assert.equal(
      secondPush.manifestGeneration,
      firstPush.manifestGeneration,
      "변경 없는 sync 는 manifest generation 불변",
    );
  });

  test("de-scoped(scopeExcluded) 원격 엔트리 pull — 로컬 스킬 파일 삭제 전파 없음", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("pull-nodel");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";
    const absSkill = path.join(home, ...SKILL_KEY.split("/"));

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    await engine1.push();

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    await engine2.push();
    assert.equal(existsSync(absSkill), true, "de-scope 후 로컬 파일 보존");

    const engine3 = makeEngine(remote, home, stateDir, "machine-a", []);
    const pullResult = await engine3.pull();

    assert.equal(existsSync(absSkill), true, "pull 후에도 로컬 파일 보존 (삭제 전파 없음)");
    assert.ok(!pullResult.removed.includes(SKILL_KEY), "pull removed 목록에 skill-a 없음");
  });

  test("dry-run push 는 로컬 state 를 파괴하지 않음 — 이후 실제 push 가 scopeExcluded 기록", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("dryrun");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"]);
    await engine1.push();

    const engine2 = makeEngine(remote, home, stateDir, "machine-a", []);
    await engine2.push({ dryRun: true });

    const engine3 = makeEngine(remote, home, stateDir, "machine-a", []);
    await engine3.push();

    const entry = (await readRemoteManifest(remote, home, stateDir))!.entries[SKILL_KEY];
    assert.equal(entry.scopeExcluded, true, "dry-run 후 실제 push 도 scopeExcluded 기록");
  });

  test("de-scope push 가 CAS 충돌(weak-ETag) 재시도 후에도 scopeExcluded 기록", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("casretry");
    const stateDir = path.join(home, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";
    const MANIFEST_PATH = `${REMOTE_BASE}/manifest.json.age`;

    await writeFile(home, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    const engine1 = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/skill-a/**"], [1, 1, 1, 1, 1]);
    await engine1.push();

    remote.markWeak(MANIFEST_PATH, 3);
    const engine2 = makeEngine(remote, home, stateDir, "machine-a", [], [1, 1, 1, 1, 1]);
    await engine2.push();

    assert.ok(remote.calls.putIfMatch >= 2, `CAS 재시도 발생해야 함 (putIfMatch=${remote.calls.putIfMatch})`);
    const entry = (await readRemoteManifest(remote, home, stateDir))!.entries[SKILL_KEY];
    assert.equal(entry.scopeExcluded, true, "CAS 재시도 후에도 scopeExcluded 기록됨");
  });

  test("마커 있는 로컬 + 원격 scopeExcluded 를 pull — 로컬 미변경, 원격 flag 미변경", async () => {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp("pmp-a");
    const stateA = path.join(homeA, ".claude-sync");
    const homeB = mkTmp("pmp-b");
    const stateB = path.join(homeB, ".claude-sync");
    const SKILL_KEY = ".claude/skills/skill-a/SKILL.md";
    const absB = path.join(homeB, ...SKILL_KEY.split("/"));

    await writeFile(homeA, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill A\n");
    await makeEngine(remote, homeA, stateA, "machine-a", [".claude/skills/skill-a/**"]).push();
    await makeEngine(remote, homeA, stateA, "machine-a", []).push();

    await writeFile(homeB, SKILL_KEY, "---\nwormhole-sync: true\n---\n# Skill B local\n");
    const engineB = makeEngine(remote, homeB, stateB, "machine-b", [".claude/skills/skill-a/**"]);
    const pullRes = await engineB.pull();

    assert.equal(existsSync(absB), true, "B 로컬 파일 보존");
    const content = await fs.readFile(absB, "utf-8");
    assert.ok(content.includes("Skill B local"), "B 로컬 내용 미변경(원격이 덮어쓰지 않음)");
    assert.ok(!pullRes.removed.includes(SKILL_KEY), "pull removed 에 없음");
    assert.ok(!pullRes.applied.includes(SKILL_KEY), "pull applied 에 없음(scopeExcluded 라 미적용)");
    const entry = (await readRemoteManifest(remote, homeA, stateA))!.entries[SKILL_KEY];
    assert.equal(entry.scopeExcluded, true, "원격 scopeExcluded flag 미변경");
  });
});
