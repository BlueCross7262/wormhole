import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runDoctor } from "./doctor.js";
import { logger } from "./logger.js";
import { start as startWebdav } from "../test/webdav-harness.mjs";
import { RemoteStore } from "./webdav/client.js";
import { AgeCrypto } from "./crypto/age.js";
import { ensureCryptoReady } from "./crypto/keyparams.js";
import { ManifestStore } from "./sync/manifest.js";
import { loadConfig } from "./config.js";

// runDoctor 는 인자 없는 loadConfig() 를 내부 호출하므로 순수 fake 주입이 어렵다.
// 대신 격리된 HOME/stateDir + config.json + WORMHOLE_CONFIG/WEBDAV_* env override +
// 인메모리 WebDAV 하네스로 통합테스트 성격으로 검증한다(Scout TEST_HARNESS 방안 1).

// loadConfig 의 .env 주입은 기존 process.env 키를 보존하므로, 실머신 ~/.wormhole/.env
// 가 새어 들어와도 우리가 세팅한 WEBDAV_*/WORMHOLE_* 가 우선한다. 그래도 안전을 위해
// 빈 isolated .env 를 쓸 수는 없다(runDoctor 는 dotEnvPath 인자를 받지 않음) — 대신
// WORMHOLE_CONFIG 로 우리 config 를, 그리고 env 로 모든 비밀을 명시 주입한다.

const MANAGED_ENV_KEYS = [
  "WEBDAV_URL",
  "WEBDAV_USER",
  "WEBDAV_PASS",
  "WORMHOLE_PASSPHRASE",
  "WORMHOLE_PASSPHRASE_FILE",
  "WORMHOLE_KEYCHAIN_SERVICE",
  "WORMHOLE_CONFIG",
  "WORMHOLE_SYNC_INCLUDE",
  "WORMHOLE_SYNC_EXCLUDE",
];

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of MANAGED_ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of MANAGED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
function clearManagedEnv(): void {
  for (const k of MANAGED_ENV_KEYS) delete process.env[k];
}

const FAST_KDF = { N: 256, r: 8, p: 1 };
const USERNAME = "doctoruser";
const PASSPHRASE = "doctor-correct-passphrase";

interface Harness {
  url: string;
  close: () => Promise<void>;
}

let tmpRoot: string;

function writeConfig(stateDir: string, remoteUrl: string): string {
  const cfg = {
    stateDir,
    remote: {
      url: remoteUrl,
      username: USERNAME,
      password: process.env["WEBDAV_PASS"] ?? "",
    },
    crypto: {
      passphraseEnv: "WORMHOLE_PASSPHRASE",
      kdfN: FAST_KDF.N,
      kdfR: FAST_KDF.r,
      kdfP: FAST_KDF.p,
    },
  };
  const p = path.join(stateDir, "config.json");
  fs.writeFileSync(p, JSON.stringify(cfg), "utf-8");
  return p;
}

function findCheck(
  result: { checks: Array<{ name: string; status: string; detail: string }> },
  needle: string,
): { name: string; status: string; detail: string } {
  const c = result.checks.find((x) => x.name.includes(needle));
  assert.ok(c, `체크를 찾을 수 없음: ${needle} (있는 것: ${result.checks.map((x) => x.name).join(", ")})`);
  return c;
}

// 원격 vault 를 실제로 부트스트랩한다(keyparams + manifest 생성).
// runDoctor 의 Check4/5 가 ok 가 되려면 원격에 keyparams 와 manifest 가 있어야 한다.
async function bootstrapVault(remoteUrl: string, stateDir: string): Promise<void> {
  const config = await loadConfig(writeConfig(stateDir, remoteUrl));
  const remote = new RemoteStore(config.remote, logger);
  await remote.ensureDir(config.remote.remoteBaseDir);
  await remote.ensureDir(`${config.remote.remoteBaseDir}/blobs`);
  const crypto = new AgeCrypto(logger);
  await ensureCryptoReady({
    remote,
    crypto,
    passphrase: PASSPHRASE,
    params: { N: config.crypto.kdfN, r: config.crypto.kdfR, p: config.crypto.kdfP },
    derivedKeyPath: config.crypto.derivedKeyPath,
    machineId: "bootstrap-machine",
    logger,
  });
  // manifest 1회 write 로 manifestGeneration 노출.
  const manifests = new ManifestStore(remote, crypto, config, [0]);
  const empty = ManifestStore.empty("bootstrap-machine");
  await manifests.write(empty, null, "bootstrap-machine");
}

describe("runDoctor — 정상 환경(부트스트랩된 vault)", () => {
  let h: Harness;

  before(() => {
    snapshotEnv();
  });
  after(() => {
    restoreEnv();
  });

  beforeEach(async () => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-"));
    h = await startWebdav(0);
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("부트스트랩된 vault + 올바른 passphrase → ok:true, fail 0건", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    await bootstrapVault(h.url, stateDir);

    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);

    const result = await runDoctor(logger);

    const fails = result.checks.filter((c) => c.status === "fail");
    assert.deepEqual(
      fails,
      [],
      `fail 이 없어야 함. 실제: ${JSON.stringify(result.checks, null, 2)}`,
    );
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 6, `최소 6 체크 기대, 실제 ${result.checks.length}`);
  });

  test("체크 결과는 {name,status,detail} 형태이며 status 는 ok/fail/warn 중 하나", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    await bootstrapVault(h.url, stateDir);
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);

    const result = await runDoctor(logger);
    for (const c of result.checks) {
      assert.equal(typeof c.name, "string");
      assert.equal(typeof c.detail, "string");
      assert.ok(["ok", "fail", "warn"].includes(c.status), `status 이상: ${c.status}`);
    }
  });
});

describe("runDoctor — 실패 환경", () => {
  let h: Harness;

  before(() => {
    snapshotEnv();
  });
  after(() => {
    restoreEnv();
  });

  beforeEach(async () => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-fail-"));
    h = await startWebdav(0);
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("config.json 없음 → config 체크 fail + ok:false", async () => {
    const missing = path.join(tmpRoot, "does-not-exist", "config.json");
    process.env["WORMHOLE_CONFIG"] = missing;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;

    const result = await runDoctor(logger);

    assert.equal(result.ok, false);
    const cfg = result.checks[0];
    assert.equal(cfg.status, "fail");
    assert.match(cfg.detail, /config\.json/);
  });

  test("틀린 passphrase → vault 정합 체크 fail + ok:false", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    // 올바른 passphrase 로 vault 부트스트랩.
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    await bootstrapVault(h.url, stateDir);

    // 이제 doctor 는 틀린 passphrase 로 실행.
    process.env["WORMHOLE_PASSPHRASE"] = "totally-wrong-passphrase";
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);

    const result = await runDoctor(logger);

    assert.equal(result.ok, false);
    const integrity = findCheck(result, "정합");
    assert.equal(integrity.status, "fail");
  });

  test("빈 vault(미초기화) → 정합/상태 체크는 warn, ok 는 유지(true)", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });

    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);

    const result = await runDoctor(logger);

    // 빈 vault 는 keyparams/manifest 가 없으므로 정합/상태가 warn 이지만 fail 은 아님.
    const fails = result.checks.filter((c) => c.status === "fail");
    assert.deepEqual(fails, [], `빈 vault 에서 fail 발생: ${JSON.stringify(fails)}`);
    assert.equal(result.ok, true);
    const integrity = findCheck(result, "정합");
    assert.equal(integrity.status, "warn");
  });
});
