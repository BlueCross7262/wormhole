import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import { resolveSkillsInclude } from "../config.js";
import type { Config, MachineId } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { ManifestStore } from "./manifest.js";

const REMOTE_BASE = "/claude-sync";
const KEYWORD = "wormhole-sync";
const MARKED = `---\n${KEYWORD}: true\n---\n# Skill\n`;

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cs-skilldel-${label}-`));
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
    skills_keyword: KEYWORD,
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
): SyncEngine {
  const deps: EngineDeps = {
    config: buildConfig(home, stateDir, include),
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
    casRetryBackoffMs: [],
  };
  return new SyncEngine(deps);
}

async function writeFile(home: string, logicalKey: string, content: string): Promise<void> {
  const abs = path.join(home, ...logicalKey.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function absOf(home: string, logicalKey: string): string {
  return path.join(home, ...logicalKey.split("/"));
}

async function readRemoteManifest(remote: MockWebdavRemote, home: string, stateDir: string) {
  const config = buildConfig(home, stateDir, []);
  const store = new ManifestStore(remote.asRemoteStore(), sharedCrypto, config, []);
  return store.read();
}

describe("marker 스킬 삭제 전파", () => {
  test("스킬 파일이 로컬에서 사라지면 tombstone 으로 전파된다", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("tomb");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/skills/skill-a/SKILL.md";

    await writeFile(home, KEY, MARKED);
    const first = await makeEngine(remote, home, stateDir, "machine-a", [
      ".claude/skills/skill-a/**",
    ]).push();
    assert.deepEqual(first.pushed, [KEY], "첫 push 에 스킬 포함");

    await fs.rm(path.join(home, ".claude", "skills", "skill-a"), {
      recursive: true,
      force: true,
    });

    const second = await makeEngine(remote, home, stateDir, "machine-a", []).push();
    assert.deepEqual(second.deleted, [KEY], "삭제가 push.deleted 에 포함");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.equal(entry.deleted, true, "원격 엔트리가 tombstone");
    assert.ok(!entry.scopeExcluded, "scopeExcluded 로 마킹되지 않음");
  });

  test("파일이 남은 채 스코프만 빠지면 scopeExcluded 유지(de-scope 계약)", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("descope");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/skills/skill-b/SKILL.md";

    await writeFile(home, KEY, MARKED);
    await makeEngine(remote, home, stateDir, "machine-a", [
      ".claude/skills/skill-b/**",
    ]).push();

    const second = await makeEngine(remote, home, stateDir, "machine-a", []).push();
    assert.deepEqual(second.deleted, [], "de-scope 는 삭제가 아님");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.equal(entry.scopeExcluded, true, "scopeExcluded 마킹 유지");
    assert.ok(!entry.deleted, "tombstone 아님");
  });

  test("tombstone 을 받은 다른 머신은 로컬 파일을 지우고 재업로드하지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp("crossa");
    const homeB = mkTmp("crossb");
    const stateA = path.join(homeA, ".claude-sync");
    const stateB = path.join(homeB, ".claude-sync");
    const KEY = ".claude/skills/skill-c/SKILL.md";

    await writeFile(homeA, KEY, MARKED);
    await makeEngine(remote, homeA, stateA, "machine-a", [
      ".claude/skills/skill-c/**",
    ]).push();

    const pullB = await makeEngine(remote, homeB, stateB, "machine-b", []).pull();
    assert.ok(pullB.applied.includes(KEY), "B 가 스킬을 구독으로 받음");
    assert.ok(existsSync(absOf(homeB, KEY)), "B 로컬에 파일 존재");

    const includeB = resolveSkillsInclude(homeB, KEYWORD);
    assert.deepEqual(includeB, [".claude/skills/skill-c/**"], "받은 파일의 마커로 B 스코프 확장");

    await fs.rm(path.join(homeA, ".claude", "skills", "skill-c"), {
      recursive: true,
      force: true,
    });
    const delPush = await makeEngine(remote, homeA, stateA, "machine-a", []).push();
    assert.deepEqual(delPush.deleted, [KEY], "A 가 tombstone 기록");

    const pullB2 = await makeEngine(remote, homeB, stateB, "machine-b", includeB).pull();
    assert.ok(pullB2.removed.includes(KEY), "B pull 이 삭제 적용");
    assert.ok(!existsSync(absOf(homeB, KEY)), "B 로컬 파일 제거됨");

    const includeB2 = resolveSkillsInclude(homeB, KEYWORD);
    assert.deepEqual(includeB2, [], "파일이 사라져 B 스코프에서도 빠짐");

    const pushB = await makeEngine(remote, homeB, stateB, "machine-b", includeB2).push();
    assert.deepEqual(pushB.pushed, [], "B 가 재업로드하지 않음");
    assert.deepEqual(pushB.deleted, [], "B 가 중복 tombstone 을 쓰지 않음");
  });

  test("scopeExcluded 엔트리는 파일을 보유한 머신의 재publish 로 해제된다", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("republish");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/skills/skill-d/SKILL.md";
    const INCLUDE = [".claude/skills/skill-d/**"];

    await writeFile(home, KEY, MARKED);
    await makeEngine(remote, home, stateDir, "machine-a", INCLUDE).push();
    await makeEngine(remote, home, stateDir, "machine-a", []).push();

    const republish = await makeEngine(remote, home, stateDir, "machine-a", INCLUDE).push();
    assert.ok(republish.pushed.includes(KEY), "재publish 로 업로드");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.ok(!entry.scopeExcluded, "scopeExcluded 해제");
    assert.ok(!entry.deleted, "tombstone 아님");
  });

  test("비스킬 키는 파일이 없어도 scopeExcluded 로만 남는다", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("nonskill");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/hud/custom-hud.mjs";

    await writeFile(home, KEY, "export default 1;\n");
    await makeEngine(remote, home, stateDir, "machine-a", [".claude/hud/**"]).push();

    await fs.rm(absOf(home, KEY), { force: true });

    const second = await makeEngine(remote, home, stateDir, "machine-a", []).push();
    assert.deepEqual(second.deleted, [], "비스킬 키는 삭제 전파 대상 아님");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.equal(entry.scopeExcluded, true, "scopeExcluded 마킹");
    assert.ok(!entry.deleted, "tombstone 아님");
  });

  test("마커 제거(unpublish)는 스코프에서만 빠지고 tombstone 이 되지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("unpublish");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/skills/skill-e/SKILL.md";

    await writeFile(home, KEY, MARKED);
    const include = resolveSkillsInclude(home, KEYWORD);
    assert.deepEqual(include, [".claude/skills/skill-e/**"], "마커가 있으면 include 에 들어감");
    await makeEngine(remote, home, stateDir, "machine-a", include).push();

    await writeFile(home, KEY, "---\nname: skill-e\n---\n# Skill E\n");
    const reresolved = resolveSkillsInclude(home, KEYWORD);
    assert.deepEqual(reresolved, [], "마커를 지우면 include 에서 빠짐");

    const second = await makeEngine(remote, home, stateDir, "machine-a", reresolved).push();
    assert.deepEqual(second.deleted, [], "unpublish 는 삭제가 아님");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.equal(entry.scopeExcluded, true, "scopeExcluded 마킹");
    assert.ok(!entry.deleted, "tombstone 아님");
  });

  test("경로에 디렉터리가 있는 비정상 상태는 삭제로 판정하지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const home = mkTmp("dirpath");
    const stateDir = path.join(home, ".claude-sync");
    const KEY = ".claude/skills/skill-f/SKILL.md";

    await writeFile(home, KEY, MARKED);
    await makeEngine(remote, home, stateDir, "machine-a", [
      ".claude/skills/skill-f/**",
    ]).push();

    const abs = absOf(home, KEY);
    await fs.rm(abs, { force: true });
    await fs.mkdir(abs, { recursive: true });

    const second = await makeEngine(remote, home, stateDir, "machine-a", []).push();
    assert.deepEqual(second.deleted, [], "디렉터리 점유는 삭제 전파 대상 아님");

    const manifest = await readRemoteManifest(remote, home, stateDir);
    const entry = manifest!.entries[KEY];
    assert.equal(entry.scopeExcluded, true, "scopeExcluded 마킹");
    assert.ok(!entry.deleted, "tombstone 아님");
  });
});
