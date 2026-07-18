import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { ManifestStore } from "./manifest.js";
import { resolveSkillsInclude } from "../config.js";

const REMOTE_BASE = "/claude-sync";
const SKILL_KEY = ".claude/skills/foo/SKILL.md";
const SKILL_BODY = "---\nwormhole-sync: true\n---\n# Foo Skill\nbody\n";

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cs-skillsub-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildConfig(
  home: string,
  stateDir: string,
  include: string[],
  opts?: { skillsKeyword?: string; exclude?: string[] },
): Config {
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
      exclude: opts?.exclude ?? [],
    },
    skills_keyword: opts?.skillsKeyword,
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
  opts?: { skillsKeyword?: string; exclude?: string[] },
): SyncEngine {
  const config = buildConfig(home, stateDir, include, opts);
  const deps: EngineDeps = {
    config,
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
    casRetryBackoffMs: [],
    // production loadConfig 미러: marker 모드면 pull 이후 디스크에서 스킬 include 재해석.
    reloadConfig: async () =>
      buildConfig(
        home,
        stateDir,
        opts?.skillsKeyword ? resolveSkillsInclude(home, opts.skillsKeyword) : include,
        opts,
      ),
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

// 머신 A 가 marker 스킬을 vault 로 push 한다.
async function seedVaultWithSkill(remote: MockWebdavRemote): Promise<void> {
  const home = mkTmp("a");
  const stateDir = path.join(home, ".claude-sync");
  await writeFile(home, SKILL_KEY, SKILL_BODY);
  const engineA = makeEngine(remote, home, stateDir, "machine-a", [".claude/skills/foo/**"]);
  const pushed = await engineA.push();
  assert.deepEqual(pushed.pushed, [SKILL_KEY], "머신 A 가 foo 를 vault 로 push");
}

describe("remote-only 스킬 구독 — marker 모드 pull materialize", () => {
  test("로컬 부재 vault 스킬을 marker 모드 머신이 pull 로 받고, 같은 사이클 push 가 de-scope 하지 않는다", async () => {
    const remote = new MockWebdavRemote();
    await seedVaultWithSkill(remote);

    // 머신 B: foo 로컬 부재 + marker 모드(include 에 foo 글로브 없음).
    const homeB = mkTmp("b");
    const stateDirB = path.join(homeB, ".claude-sync");
    const engineB = makeEngine(remote, homeB, stateDirB, "machine-b", [], {
      skillsKeyword: "wormhole-sync",
    });

    // CLI 와 동일한 순서: 동일 엔진 인스턴스로 pull → push.
    const pull = await engineB.pull();
    assert.ok(pull.applied.includes(SKILL_KEY), "pull 이 foo 를 적용해야 함");
    assert.equal(
      readFileSync(absOf(homeB, SKILL_KEY), "utf-8"),
      SKILL_BODY,
      "foo 가 정확한 내용으로 로컬에 materialize",
    );

    await engineB.push();

    // 핵심: 같은 사이클 push 의 stale-include purge 가 foo 를 unpublish 하면 안 된다.
    const manifest = await readRemoteManifest(remote, homeB, stateDirB);
    assert.ok(manifest, "manifest 존재");
    assert.ok(manifest!.entries[SKILL_KEY], "manifest 에 foo 엔트리 존재");
    assert.ok(
      !manifest!.entries[SKILL_KEY].deleted,
      "foo 가 tombstone 되면 안 됨",
    );
    assert.ok(
      !manifest!.entries[SKILL_KEY].scopeExcluded,
      "foo 가 scopeExcluded 되면 안 됨 (de-scope 회귀)",
    );
  });

  test("전파: B 가 받은 뒤 또 다른 marker 머신 C 도 vault 에서 foo 를 받는다", async () => {
    const remote = new MockWebdavRemote();
    await seedVaultWithSkill(remote);

    const homeB = mkTmp("b2");
    const stateDirB = path.join(homeB, ".claude-sync");
    const engineB = makeEngine(remote, homeB, stateDirB, "machine-b", [], {
      skillsKeyword: "wormhole-sync",
    });
    await engineB.pull();
    await engineB.push();

    const homeC = mkTmp("c");
    const stateDirC = path.join(homeC, ".claude-sync");
    const engineC = makeEngine(remote, homeC, stateDirC, "machine-c", [], {
      skillsKeyword: "wormhole-sync",
    });
    const pullC = await engineC.pull();
    assert.ok(pullC.applied.includes(SKILL_KEY), "머신 C 도 foo 를 pull");
    assert.equal(readFileSync(absOf(homeC, SKILL_KEY), "utf-8"), SKILL_BODY);
  });

  test("멱등: 두 번째 pull 은 foo 를 재적용하지 않고 파일도 유지", async () => {
    const remote = new MockWebdavRemote();
    await seedVaultWithSkill(remote);

    const homeB = mkTmp("b3");
    const stateDirB = path.join(homeB, ".claude-sync");
    const engineB = makeEngine(remote, homeB, stateDirB, "machine-b", [], {
      skillsKeyword: "wormhole-sync",
    });
    await engineB.pull();
    await engineB.push();

    const secondPull = await engineB.pull();
    assert.ok(!secondPull.applied.includes(SKILL_KEY), "재적용 없음");
    assert.ok(existsSync(absOf(homeB, SKILL_KEY)), "foo 파일 유지");
  });

  test("가드: marker 모드 아님(skills_keyword 미설정) + 스킬 미포함 include 는 vault 스킬을 구독하지 않는다", async () => {
    const remote = new MockWebdavRemote();
    await seedVaultWithSkill(remote);

    const homeD = mkTmp("d");
    const stateDirD = path.join(homeD, ".claude-sync");
    const engineD = makeEngine(remote, homeD, stateDirD, "machine-d", []);
    const pullD = await engineD.pull();
    assert.ok(!pullD.applied.includes(SKILL_KEY), "비-marker 모드는 foo 를 받지 않음");
    assert.ok(!existsSync(absOf(homeD, SKILL_KEY)), "foo 파일 없음");
  });

  test("가드: marker 모드라도 exclude 로 배제한 스킬은 pull 하지 않는다", async () => {
    const remote = new MockWebdavRemote();
    await seedVaultWithSkill(remote);

    const homeE = mkTmp("e");
    const stateDirE = path.join(homeE, ".claude-sync");
    const engineE = makeEngine(remote, homeE, stateDirE, "machine-e", [], {
      skillsKeyword: "wormhole-sync",
      exclude: [".claude/skills/foo/**"],
    });
    const pullE = await engineE.pull();
    assert.ok(!pullE.applied.includes(SKILL_KEY), "exclude 된 스킬은 구독 제외");
    assert.ok(!existsSync(absOf(homeE, SKILL_KEY)), "foo 파일 없음");
  });
});
