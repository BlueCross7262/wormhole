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
import type { Config, Logger, MachineId } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { blobName } from "./hash.js";

const REMOTE_BASE = "/claude-sync";
const KEYWORD = "wormhole-sync";
const MARKED = `---\n${KEYWORD}: true\n---\n# Skill\n`;
const AGENTS_INCLUDE = [".claude/CLAUDE.md", ".claude/agents/**"];

let sharedCrypto: AgeCrypto;

before(async () => {
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(await age.generateIdentity());
});

const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cs-emptydir-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

interface Opts {
  keyword?: string;
  logger?: Logger;
}

function buildConfig(home: string, include: string[], keyword?: string): Config {
  const stateDir = path.join(home, ".claude-sync");
  return {
    stateDir,
    home,
    remote: { url: "http://mock.invalid", username: "", password: "", remoteBaseDir: REMOTE_BASE },
    crypto: {
      passphraseEnv: "CLAUDE_SYNC_PASSPHRASE",
      passphraseFile: path.join(stateDir, "passphrase"),
      derivedKeyPath: path.join(stateDir, "age-key.txt"),
      kdfN: 2,
      kdfR: 8,
      kdfP: 1,
    },
    targets: { include, exclude: ["**/*.log"] },
    ...(keyword ? { skills_keyword: keyword } : {}),
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  };
}

function makeEngine(
  remote: MockWebdavRemote,
  home: string,
  machineId: MachineId,
  include: string[],
  opts: Opts = {},
): SyncEngine {
  const deps: EngineDeps = {
    config: buildConfig(home, include, opts.keyword),
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
    casRetryBackoffMs: [],
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
  return new SyncEngine(deps);
}

function absOf(home: string, logicalPath: string): string {
  return path.join(home, ...logicalPath.split("/"));
}

async function writeFile(home: string, key: string, content: string): Promise<void> {
  const abs = absOf(home, key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function recordingLogger(): { logger: Logger; infos: string[] } {
  const infos: string[] = [];
  const noop = (): void => {};
  return { infos, logger: { debug: noop, info: (m: string) => infos.push(m), warn: noop, error: noop } };
}

function failBlobAfterDelay(remote: MockWebdavRemote, key: string): () => void {
  const failing = `blobs/${blobName(key)}`;
  const real = remote.getTextIfExists.bind(remote);
  (remote as unknown as { getTextIfExists: typeof remote.getTextIfExists }).getTextIfExists =
    async (p: string): Promise<string | null> => {
      remote.calls.getTextIfExists += 1;
      if (p === failing) {
        await new Promise((r) => setTimeout(r, 200));
        throw new Error("injected download failure");
      }
      const raw = remote.rawGet(p);
      return raw ? raw.toString("utf-8") : null;
    };
  return () => {
    (remote as unknown as { getTextIfExists: typeof real }).getTextIfExists = real;
  };
}

async function pullExpectingFailure(engine: SyncEngine): Promise<void> {
  await assert.rejects(() => engine.pull(), /injected download failure/);
}

describe("sync 뒤 빈 폴더 정리", () => {
  test("T1 marker 스킬 tombstone pull 은 스킬 폴더를 지우고 .claude/skills 는 남긴다", async () => {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp("t1a");
    const homeB = mkTmp("t1b");
    const KEY = ".claude/skills/skill-c/SKILL.md";
    const opt = { keyword: KEYWORD };

    await writeFile(homeA, KEY, MARKED);
    await makeEngine(remote, homeA, "machine-a", [".claude/skills/skill-c/**"], opt).push();
    await makeEngine(remote, homeB, "machine-b", [], opt).pull();
    const includeB = resolveSkillsInclude(homeB, KEYWORD);

    await fs.rm(absOf(homeA, ".claude/skills/skill-c"), { recursive: true, force: true });
    await makeEngine(remote, homeA, "machine-a", [], opt).push();

    const { logger, infos } = recordingLogger();
    const res = await makeEngine(remote, homeB, "machine-b", includeB, { ...opt, logger }).pull();

    assert.ok(res.removed.includes(KEY));
    assert.equal(existsSync(absOf(homeB, ".claude/skills/skill-c")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/skills")), true);
    assert.ok(
      infos.some((m) => m.includes("빈 폴더 삭제 dir=.claude/skills/skill-c")),
      `info 로그에 삭제 폴더가 있어야 한다: ${JSON.stringify(infos)}`,
    );
  });

  async function forceDownSetup(label: string) {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp(`${label}a`);
    const homeB = mkTmp(`${label}b`);
    await writeFile(homeA, ".claude/CLAUDE.md", "a\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();
    await writeFile(homeB, ".claude/agents/x/y/a.md", "local only\n");
    return { remote, homeB };
  }

  test("T2 forceDownload 가 지운 파일의 빈 부모를 경계 직전까지 지운다", async () => {
    const { remote, homeB } = await forceDownSetup("t2");
    const res = await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).forceDownload();

    assert.ok(res.removed.includes(".claude/agents/x/y/a.md"));
    assert.equal(existsSync(absOf(homeB, ".claude/agents/x")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents")), true);
  });

  test("T3 범위 밖 파일이 남은 폴더는 지우지 않는다", async () => {
    const { remote, homeB } = await forceDownSetup("t3");
    await writeFile(homeB, ".claude/agents/x/keep.log", "keep\n");
    await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).forceDownload();

    assert.equal(existsSync(absOf(homeB, ".claude/agents/x/y")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/x/keep.log")), true);
  });

  test("T4 사용자가 만든 빈 폴더는 지우지 않는다", async () => {
    const { remote, homeB } = await forceDownSetup("t4");
    await fs.mkdir(absOf(homeB, ".claude/agents/empty-user"), { recursive: true });
    await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).forceDownload();

    assert.equal(existsSync(absOf(homeB, ".claude/agents/x")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/empty-user")), true);
  });

  async function rollbackSetup(label: string, newKey: string) {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp(`${label}a`);
    const homeB = mkTmp(`${label}b`);
    await writeFile(homeA, ".claude/CLAUDE.md", "v1\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();
    await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).pull();
    await writeFile(homeA, newKey, "new\n");
    await writeFile(homeA, ".claude/agents/zz.md", "fail\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();
    return { remote, homeB };
  }

  test("T5 rollback 은 이번 실행에서 만든 두 단계 폴더를 지운다", async () => {
    const newKey = ".claude/agents/n/m/new.md";
    const { remote, homeB } = await rollbackSetup("t5", newKey);
    const restore = failBlobAfterDelay(remote, ".claude/agents/zz.md");
    try {
      await pullExpectingFailure(makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE));
    } finally {
      restore();
    }

    assert.equal(existsSync(absOf(homeB, newKey)), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/n")), false);
  });

  test("T5b rollback 은 실행 전부터 있던 빈 폴더를 지우지 않는다", async () => {
    const newKey = ".claude/agents/pre/new.md";
    const { remote, homeB } = await rollbackSetup("t5b", newKey);
    await fs.mkdir(absOf(homeB, ".claude/agents/pre"), { recursive: true });
    const restore = failBlobAfterDelay(remote, ".claude/agents/zz.md");
    try {
      await pullExpectingFailure(makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE));
    } finally {
      restore();
    }

    assert.equal(existsSync(absOf(homeB, newKey)), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/pre")), true);
  });

  test("T6 resolve latest-wins 가 원격 삭제를 채택하면 빈 부모를 지운다", async () => {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp("t6a");
    const homeB = mkTmp("t6b");
    const KEY = ".claude/agents/x/a.md";
    await writeFile(homeA, KEY, "base\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();
    await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).pull();

    await fs.rm(absOf(homeA, KEY));
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();
    await writeFile(homeB, KEY, "local edit\n");

    const res = await makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE).resolve("latest-wins");

    assert.deepEqual(res.resolved, [KEY]);
    assert.equal(existsSync(absOf(homeB, KEY)), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/x")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents")), true);
  });

  test("T8 같은 engine 의 다음 pull rollback 은 이전 실행이 만든 폴더를 지우지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const homeA = mkTmp("t8a");
    const homeB = mkTmp("t8b");
    await writeFile(homeA, ".claude/agents/p/a.md", "a\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();

    const engineB = makeEngine(remote, homeB, "machine-b", AGENTS_INCLUDE);
    await engineB.pull();
    await fs.rm(absOf(homeB, ".claude/agents/p/a.md"));

    await writeFile(homeA, ".claude/agents/p/b.md", "b\n");
    await writeFile(homeA, ".claude/agents/zz.md", "fail\n");
    await makeEngine(remote, homeA, "machine-a", AGENTS_INCLUDE).push();

    const restore = failBlobAfterDelay(remote, ".claude/agents/zz.md");
    try {
      await pullExpectingFailure(engineB);
    } finally {
      restore();
    }

    assert.equal(existsSync(absOf(homeB, ".claude/agents/p/b.md")), false);
    assert.equal(existsSync(absOf(homeB, ".claude/agents/p")), true);
  });
});
