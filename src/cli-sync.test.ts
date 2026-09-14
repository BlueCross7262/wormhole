import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";

import { SyncEngine } from "./sync/engine.js";
import type { EngineDeps } from "./sync/engine.js";
import { AgeCrypto } from "./crypto/age.js";
import type { Config, MachineId } from "./types.js";
import { MockWebdavRemote } from "./test-helpers/mock-webdav.js";
import { runSyncCommand } from "./cli-sync.js";

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
}

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-clisync-${label}-`));
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
  } as unknown as Config;
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
  return { engine, home, stateDir };
}

async function writeHomeFile(replica: Replica, logicalKey: string, content: string): Promise<void> {
  const abs = path.join(replica.home, ...logicalKey.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

const SETTINGS_KEY = ".claude/settings.json";

describe("M20: CLI sync 설치 배리어 — installed_plugins.json 이 참조를 못 채우는 상태에서 push 차단", () => {
  test("M20: A 가 미설치 플러그인 참조 settings.json 을 push, B 가 runSyncCommand → aborted:missing-plugins + exitCode 1", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m20-a", "machine-a");
    const b = makeReplica(remote, "m20-b", "machine-b");

    await writeHomeFile(
      a,
      SETTINGS_KEY,
      JSON.stringify({ enabledPlugins: { "foo@bar": true } }),
    );
    await a.engine.push();

    const { payload, exitCode } = await runSyncCommand(b.engine, { policy: "preserve-both" });

    assert.equal(exitCode, 1, "설치 배리어에 걸리면 exitCode 는 1이어야 한다");
    assert.equal(payload.aborted, true, "aborted 는 true 여야 한다");
    assert.equal(payload.reason, "missing-plugins", "reason 은 missing-plugins 여야 한다");
    assert.deepEqual(payload.missing, ["foo@bar"], "missing 목록에 미설치 플러그인 키가 그대로 담긴다");

    const bLocalExists = await fs
      .access(path.join(b.home, ...SETTINGS_KEY.split("/")))
      .then(() => true)
      .catch(() => false);
    assert.equal(bLocalExists, false, "설치 배리어에 걸리면 pull 도 실행되지 않아 로컬 파일이 생기지 않는다");
  });

  test("M20: 설치 배리어·충돌이 모두 없으면 exitCode 0, aborted:false", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m20h-a", "machine-a");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ p: "v1" }));

    const { payload, exitCode } = await runSyncCommand(a.engine, { policy: "preserve-both" });

    assert.equal(exitCode, 0);
    assert.equal(payload.aborted, false);
  });
});

describe("M20b: 로컬이 이미 제거한 플러그인 요구는 설치 배리어에서 제외", () => {
  test("M20b: base 에 있던 플러그인을 로컬이 끈 뒤 sync → aborted 없이 push 되어 원격 요구가 사라진다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m20b-a", "machine-a");
    const b = makeReplica(remote, "m20b-b", "machine-b");

    const withPlugin = JSON.stringify({ enabledPlugins: { "foo@bar": true }, p: "v1" });
    await writeHomeFile(a, SETTINGS_KEY, withPlugin);
    await a.engine.push();

    // B 가 그 플러그인을 설치한 상태로 동기화 → base 스냅샷에 foo@bar 가 들어간다.
    const marketplaceDir = path.join(b.home, "marketplaces", "bar");
    await fs.mkdir(marketplaceDir, { recursive: true });
    const pluginsDir = path.join(b.home, ".claude", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ plugins: { "foo@bar": [{ version: "1.0.0" }] } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginsDir, "known_marketplaces.json"),
      JSON.stringify({ bar: { installLocation: marketplaceDir } }),
      "utf-8",
    );

    const first = await runSyncCommand(b.engine, { policy: "preserve-both" });
    assert.equal(first.exitCode, 0, "설치된 상태의 첫 sync 는 통과해야 한다");
    assert.equal(first.payload.aborted, false);

    // 플러그인 제거를 재현: 로컬 settings 에서 키를 끄고 레지스트리에서도 지운다.
    await writeHomeFile(b, SETTINGS_KEY, JSON.stringify({ enabledPlugins: {}, p: "v1" }));
    await fs.writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ plugins: {} }),
      "utf-8",
    );
    await fs.writeFile(path.join(pluginsDir, "known_marketplaces.json"), JSON.stringify({}), "utf-8");

    const second = await runSyncCommand(b.engine, { policy: "preserve-both" });

    assert.equal(second.payload.aborted, false, "로컬이 이미 끈 요구는 배리어 대상이 아니다");
    assert.equal(second.exitCode, 0, "exitCode 는 0 이어야 한다");
    assert.ok(
      second.payload.aborted === false && second.payload.push.pushed.includes(SETTINGS_KEY),
      "제거를 담은 settings.json 이 push 되어야 한다",
    );

    const c = makeReplica(remote, "m20b-c", "machine-c");
    const cSync = await runSyncCommand(c.engine, { policy: "preserve-both" });
    assert.equal(
      cSync.payload.aborted,
      false,
      "원격에서 요구가 사라졌으므로 플러그인 없는 머신도 통과한다",
    );
  });

  test("M20b: base 에 없던 새 요구는 로컬이 안 켰어도 여전히 차단된다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "m20bn-a", "machine-a");
    const b = makeReplica(remote, "m20bn-b", "machine-b");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ enabledPlugins: {}, p: "v1" }));
    await a.engine.push();

    const first = await runSyncCommand(b.engine, { policy: "preserve-both" });
    assert.equal(first.payload.aborted, false, "요구가 없으면 통과한다");

    await writeHomeFile(a, SETTINGS_KEY, JSON.stringify({ enabledPlugins: { "foo@bar": true }, p: "v2" }));
    await a.engine.push();

    const second = await runSyncCommand(b.engine, { policy: "preserve-both" });

    assert.equal(second.payload.aborted, true, "원격이 새로 추가한 요구는 그대로 차단한다");
    assert.equal(second.payload.aborted === true && second.payload.reason, "missing-plugins");
    assert.deepEqual(
      second.payload.aborted === true && second.payload.reason === "missing-plugins"
        ? second.payload.missing
        : null,
      ["foo@bar"],
    );
  });
});
