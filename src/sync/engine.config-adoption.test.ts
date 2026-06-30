import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";

const CONFIG_KEY = ".claude/wormhole-config.json";

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

const tmpDirs: string[] = [];

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cs-cfg-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

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
    crypto: {
      passphraseEnv: "CLAUDE_SYNC_PASSPHRASE",
      passphraseFile: path.join(stateDir, "passphrase"),
      derivedKeyPath: path.join(stateDir, "age-key.txt"),
      kdfN: 2,
      kdfR: 8,
      kdfP: 1,
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

function makeReplica(remote: MockWebdavRemote, label: string, machineId: MachineId, withReload = false): Replica {
  const home = mkTmp(`${label}-home`);
  const stateDir = path.join(home, ".claude-sync");
  const config = buildConfig(home, stateDir);
  const deps: EngineDeps = {
    config,
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
    ...(withReload
      ? {
          reloadConfig: async () => {
            const abs = path.join(home, ".claude", "wormhole-config.json");
            const raw = JSON.parse(await fs.readFile(abs, "utf-8"));
            return { ...config, targets: raw.targets };
          },
        }
      : {}),
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

describe("config key adoption — per-key latest-wins override", () => {
  test("신규머신 채택: config conflict 가 preserve-both 정책에도 latest-wins 로 해소", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "adopt-a", "machine-a");
    const b = makeReplica(remote, "adopt-b", "machine-b");

    await writeHomeFile(a, CONFIG_KEY, "shared-v2\n");
    await a.engine.push();

    await writeHomeFile(b, CONFIG_KEY, "local-template\n");

    const status = await b.engine.status();
    assert.ok(
      status.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      `expected conflict for ${CONFIG_KEY}`,
    );

    const result = await b.engine.resolve("preserve-both");

    assert.ok(result.resolved.includes(CONFIG_KEY));
    assert.equal(await readHomeFile(b, CONFIG_KEY), "shared-v2\n");
    assert.equal(
      result.conflictCopies.filter((c) => c.logicalKey === CONFIG_KEY).length,
      0,
      "config key should not produce a sidecar",
    );

    const afterStatus = await b.engine.status();
    assert.ok(
      !afterStatus.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      "config conflict should be resolved (watermark advanced)",
    );
  });

  test("회귀: 비-config 키는 preserve-both 정책 그대로 사이드카 생성", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "reg-a", "machine-a");
    const b = makeReplica(remote, "reg-b", "machine-b");

    await writeHomeFile(a, ".claude/CLAUDE.md", "base-v1\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, ".claude/CLAUDE.md", "A-edit-v2\n");
    await a.engine.push();
    await writeHomeFile(b, ".claude/CLAUDE.md", "B-edit-vX\n");

    const result = await b.engine.resolve("preserve-both");

    assert.equal(await readHomeFile(b, ".claude/CLAUDE.md"), "B-edit-vX\n");
    assert.equal(result.conflictCopies.length, 1);
    assert.equal(result.conflictCopies[0].logicalKey, ".claude/CLAUDE.md");
  });

  test("혼합: config 채택 + 비-config 사이드카, writeState 영속화", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "mix-a", "machine-a");
    const b = makeReplica(remote, "mix-b", "machine-b");

    await writeHomeFile(a, ".claude/CLAUDE.md", "base-v1\n");
    await a.engine.push();
    await b.engine.pull();

    await writeHomeFile(a, CONFIG_KEY, "shared-config\n");
    await writeHomeFile(a, ".claude/CLAUDE.md", "A-edit-v2\n");
    await a.engine.push();

    await writeHomeFile(b, CONFIG_KEY, "local-template\n");
    await writeHomeFile(b, ".claude/CLAUDE.md", "B-edit-vX\n");

    const result = await b.engine.resolve("preserve-both");

    assert.equal(await readHomeFile(b, CONFIG_KEY), "shared-config\n");
    assert.ok(!result.conflictCopies.some((c) => c.logicalKey === CONFIG_KEY));

    assert.equal(await readHomeFile(b, ".claude/CLAUDE.md"), "B-edit-vX\n");
    assert.ok(result.conflictCopies.some((c) => c.logicalKey === ".claude/CLAUDE.md"));

    const status = await b.engine.status();
    assert.ok(!status.conflicts.some((c) => c.logicalKey === CONFIG_KEY), "config should be converged");
    assert.ok(status.conflicts.some((c) => c.logicalKey === ".claude/CLAUDE.md"), "CLAUDE.md conflict still open");
  });

  test("sync 후 config 수렴 — 영구 conflict 루프 없음", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "idm-a", "machine-a");
    const b = makeReplica(remote, "idm-b", "machine-b");

    await writeHomeFile(a, CONFIG_KEY, "shared-config\n");
    await a.engine.push();

    await writeHomeFile(b, CONFIG_KEY, "local-template\n");

    const syncResult = await b.engine.syncAtomic({ pluginsDir: b.home });
    assert.equal((syncResult as { aborted: boolean }).aborted, false);

    assert.equal(await readHomeFile(b, CONFIG_KEY), "shared-config\n");

    const status = await b.engine.status();
    assert.ok(
      !status.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      "after sync, config should be converged with no conflict",
    );

    const syncResult2 = await b.engine.syncAtomic({ pluginsDir: b.home });
    assert.equal((syncResult2 as { aborted: boolean }).aborted, false);
    const status2 = await b.engine.status();
    assert.ok(
      !status2.conflicts.some((c) => c.logicalKey === CONFIG_KEY),
      "second sync: still converged, no infinite conflict loop",
    );
  });

  test("same-cycle: config 가 새 include 를 추가하면 그 파일이 같은 pull 로 내려온다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "sc-a", "machine-a");
    const b = makeReplica(remote, "sc-b", "machine-b", true);

    const wideConfig = JSON.stringify({ targets: { include: [".claude/wormhole-config.json", ".claude/skills/**"], exclude: [] } });
    await writeHomeFile(a, CONFIG_KEY, wideConfig);
    await writeHomeFile(a, ".claude/skills/new-skill/SKILL.md", "new skill body\n");
    await a.engine.push();

    b.config.targets = { include: [".claude/wormhole-config.json"], exclude: [] };

    await b.engine.pull();

    assert.ok(
      await homeFileExists(b, ".claude/skills/new-skill/SKILL.md"),
      "new-skill 은 same-cycle 에 내려와야 한다(2-pass). 1-pass 면 부재(버그).",
    );
    assert.equal(await readHomeFile(b, ".claude/skills/new-skill/SKILL.md"), "new skill body\n");
  });
});
