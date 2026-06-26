import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runDoctor } from "./doctor.js";
import { logger } from "./logger.js";
import { start as startWebdav } from "../test/webdav-harness.mjs";
import { RemoteStore, classifyEtag } from "./webdav/client.js";
import { AgeCrypto } from "./crypto/age.js";
import { ensureCryptoReady, KEYPARAMS_REMOTE } from "./crypto/keyparams.js";
import { ManifestStore } from "./sync/manifest.js";
import { loadConfig } from "./config.js";
import { classifyLock } from "./sync/lock.js";
import { readMachineIdIfExists } from "./sync/machine.js";

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
    fs.writeFileSync(path.join(stateDir, "machine-id"), "regress-machine", "utf-8");

    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);

    const result = await runDoctor(logger);

    const fails = result.checks.filter((c) => c.status === "fail");
    assert.deepEqual(
      fails,
      [],
      `fail 이 없어야 함. 실제: ${JSON.stringify(result.checks, null, 2)}`,
    );
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 9, `최소 9 체크 기대, 실제 ${result.checks.length}`);
    assert.equal(findCheck(result, "ETag").status, "ok");
    assert.equal(findCheck(result, "락").status, "ok");
    assert.equal(findCheck(result, "machine-id").status, "ok");
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

describe("classifyEtag — 단위", () => {
  test("strong etag", () => {
    assert.equal(classifyEtag("abc"), "strong");
    assert.equal(classifyEtag('"x"'), "strong");
  });
  test("weak etag", () => {
    assert.equal(classifyEtag('W/"x"'), "weak");
    assert.equal(classifyEtag('w/"x"'), "weak");
  });
  test("none cases", () => {
    assert.equal(classifyEtag(null), "none");
    assert.equal(classifyEtag(undefined), "none");
    assert.equal(classifyEtag(""), "none");
    assert.equal(classifyEtag("  "), "none");
  });
});

describe("classifyLock — 단위", () => {
  const now = Date.now();
  const defaultTtlMs = 30000;

  test("null → none", () => {
    assert.equal(classifyLock(null, now, "me", defaultTtlMs).state, "none");
  });
  test("bad json → corrupt", () => {
    assert.equal(classifyLock("{bad", now, "me", defaultTtlMs).state, "corrupt");
  });
  test("machineId 타입 오류 → corrupt", () => {
    assert.equal(classifyLock('{"machineId":1,"acquiredAt":1}', now, "me", defaultTtlMs).state, "corrupt");
  });
  test("미래 acquiredAt → corrupt", () => {
    const info = JSON.stringify({ machineId: "x", acquiredAt: now + 10 * 60 * 1000 });
    assert.equal(classifyLock(info, now, "me", defaultTtlMs).state, "corrupt");
  });
  test("만료 → expired", () => {
    const info = JSON.stringify({ machineId: "x", acquiredAt: now - 100000, ttlMs: 30000 });
    assert.equal(classifyLock(info, now, "me", defaultTtlMs).state, "expired");
  });
  test("자기 소유 → self", () => {
    const info = JSON.stringify({ machineId: "me", acquiredAt: now, ttlMs: 30000 });
    assert.equal(classifyLock(info, now, "me", defaultTtlMs).state, "self");
  });
  test("타 머신 → held", () => {
    const info = JSON.stringify({ machineId: "me", acquiredAt: now, ttlMs: 30000 });
    assert.equal(classifyLock(info, now, "other", defaultTtlMs).state, "held");
  });
});

describe("readMachineIdIfExists — 단위", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-machineid-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("파일 존재 → id 반환", async () => {
    fs.writeFileSync(path.join(tmpDir, "machine-id"), "test-id-1234", "utf-8");
    const id = await readMachineIdIfExists(tmpDir);
    assert.equal(id, "test-id-1234");
  });

  test("파일 부재 → null", async () => {
    const id = await readMachineIdIfExists(tmpDir);
    assert.equal(id, null);
  });

  test("빈 파일 → null", async () => {
    fs.writeFileSync(path.join(tmpDir, "machine-id"), "", "utf-8");
    const id = await readMachineIdIfExists(tmpDir);
    assert.equal(id, null);
  });
});

describe("runDoctor — CAS/ETag 체크 통합", () => {
  let h: Harness;

  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(async () => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-etag-"));
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("strong harness + bootstrap → ETag 체크 ok", async () => {
    h = await startWebdav(0, { etagMode: "strong" });
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    await bootstrapVault(h.url, stateDir);
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "ETag").status, "ok");
  });

  test("빈 vault → ETag 체크 warn(미초기화)", async () => {
    h = await startWebdav(0, { etagMode: "strong" });
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "ETag").status, "warn");
  });

  test("weak ETag harness + keyparams 업로드 → ETag 체크 warn", async () => {
    h = await startWebdav(0, { etagMode: "weak" });
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const cfg = await loadConfig(writeConfig(stateDir, h.url));
    const remote = new RemoteStore(cfg.remote, logger);
    await remote.ensureDir(cfg.remote.remoteBaseDir);
    const minKeyparams = JSON.stringify({ salt: "x", saltB64: "dGVzdA==", N: 256, r: 8, p: 1, sentinel: "x" });
    await remote.put(KEYPARAMS_REMOTE, minKeyparams);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "ETag").status, "warn");
  });

  test("no ETag harness + keyparams 업로드 → ETag 체크 warn", async () => {
    h = await startWebdav(0, { etagMode: "none" });
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WEBDAV_URL"] = h.url;
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WEBDAV_PASS"] = "doctor-webdav-pass";
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const cfg = await loadConfig(writeConfig(stateDir, h.url));
    const remote = new RemoteStore(cfg.remote, logger);
    await remote.ensureDir(cfg.remote.remoteBaseDir);
    const minKeyparams = JSON.stringify({ salt: "x", saltB64: "dGVzdA==", N: 256, r: 8, p: 1, sentinel: "x" });
    await remote.put(KEYPARAMS_REMOTE, minKeyparams);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "ETag").status, "warn");
  });
});

describe("runDoctor — 원격 락 상태 체크 통합", () => {
  let h: Harness;

  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(async () => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-lock-"));
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

  async function setupRemote(stateDir: string): Promise<RemoteStore> {
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const cfg = await loadConfig(writeConfig(stateDir, h.url));
    const remote = new RemoteStore(cfg.remote, logger);
    await remote.ensureDir(cfg.remote.remoteBaseDir);
    return remote;
  }

  test("lock held by other → warn + holder slice 포함", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "machine-id"), "my-machine", "utf-8");
    const remote = await setupRemote(stateDir);
    await remote.put("lock.json", JSON.stringify({ machineId: "other-machine", acquiredAt: Date.now(), ttlMs: 30000 }));
    const result = await runDoctor(logger);
    const c = findCheck(result, "락");
    assert.equal(c.status, "warn");
    assert.ok(c.detail.includes("other-ma"), `detail 에 holder slice 포함: ${c.detail}`);
  });

  test("lock self → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "machine-id"), "my-machine", "utf-8");
    const remote = await setupRemote(stateDir);
    await remote.put("lock.json", JSON.stringify({ machineId: "my-machine", acquiredAt: Date.now(), ttlMs: 30000 }));
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "락").status, "ok");
  });

  test("lock expired → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const remote = await setupRemote(stateDir);
    await remote.put("lock.json", JSON.stringify({ machineId: "old-machine", acquiredAt: Date.now() - 100000, ttlMs: 30000 }));
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "락").status, "ok");
  });

  test("lock corrupt → warn, doctor throw 안함", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const remote = await setupRemote(stateDir);
    await remote.put("lock.json", "{broken json");
    let result: Awaited<ReturnType<typeof runDoctor>>;
    await assert.doesNotReject(async () => {
      result = await runDoctor(logger);
    });
    assert.equal(findCheck(result!, "락").status, "warn");
  });

  test("lock none → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    await setupRemote(stateDir);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "락").status, "ok");
  });
});

describe("runDoctor — machine-id 체크 통합", () => {
  let h: Harness;

  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(async () => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-mid-"));
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

  test("machine-id 있음 → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "machine-id"), "test-mid-1234", "utf-8");
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const result = await runDoctor(logger);
    const c = findCheck(result, "machine-id");
    assert.equal(c.status, "ok");
    assert.ok(c.detail.includes("test-mid"), `detail 에 slice 포함: ${c.detail}`);
  });

  test("machine-id 없음 → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfig(stateDir, h.url);
    const result = await runDoctor(logger);
    assert.equal(findCheck(result, "machine-id").status, "warn");
  });
});

// ── 이주완전성 체크 4종 (config 기반, 네트워크 불필요) ─────────────

// config 기반 체크는 WebDAV 연결 없이 config 로드 후 즉시 판단한다.
// 죽은 URL(http://127.0.0.1:1) 을 사용하면 config 체크는 통과, WebDAV 연결은 fail(스킵),
// 이후 config 기반 체크들은 정상 실행된다.
const DEAD_URL = "http://127.0.0.1:1";

function writeConfigFull(
  stateDir: string,
  remoteUrl: string,
  extra: Record<string, unknown>,
): string {
  const cfg: Record<string, unknown> = {
    stateDir,
    remote: {
      url: remoteUrl,
      username: USERNAME,
      password: "pass",
    },
    crypto: {
      passphraseEnv: "WORMHOLE_PASSPHRASE",
      kdfN: FAST_KDF.N,
      kdfR: FAST_KDF.r,
      kdfP: FAST_KDF.p,
    },
    ...extra,
  };
  const p = path.join(stateDir, "config.json");
  fs.writeFileSync(p, JSON.stringify(cfg), "utf-8");
  return p;
}

describe("runDoctor — 이주완전성 체크 (2) include 글로브 절대경로 리터럴", () => {
  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(() => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-abspath-"));
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("include 에 home-prefix 절대경로(C:/Users/x) → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: ["C:/Users/testuser/.claude/CLAUDE.md", ".claude/settings.json"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "절대경로");
    assert.equal(c.status, "warn", `home-prefix 절대경로면 warn. detail: ${c.detail}`);
  });

  test("include 에 비-home 절대경로(C:/Program Files/nodejs/node.exe) → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/CLAUDE.md", "C:/Program Files/nodejs/node.exe"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "절대경로");
    assert.equal(c.status, "warn", `비-home 절대경로면 warn. detail: ${c.detail}`);
  });

  test("include 에 상대경로만 → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/CLAUDE.md", ".claude/settings.json"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "절대경로");
    assert.equal(c.status, "ok", `상대경로만 있으면 ok. detail: ${c.detail}`);
  });
});

describe("runDoctor — 이주완전성 체크 (3) stateDir 동기화 범위 유출", () => {
  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(() => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-stdir-"));
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("stateDir 하위가 include 글로브에 매칭 → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateDirName = path.basename(stateDir);
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      home: tmpRoot,
      stateDir,
      targets: {
        include: [".claude/CLAUDE.md", `${stateDirName}/**`],
      },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "stateDir");
    assert.equal(c.status, "warn", `stateDir 유출 시 warn. detail: ${c.detail}`);
  });

  test("stateDir 가 include 범위 밖 → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      home: tmpRoot,
      stateDir,
      targets: { include: [".claude/CLAUDE.md", ".claude/settings.json"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "stateDir");
    assert.equal(c.status, "ok", `stateDir 범위 밖이면 ok. detail: ${c.detail}`);
  });
});

describe("runDoctor — 이주완전성 체크 (4) shared subset PAT/TOKEN/SECRET 패턴", () => {
  before(() => { snapshotEnv(); });
  after(() => { restoreEnv(); });

  beforeEach(() => {
    clearManagedEnv();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-doctor-secret-"));
    process.env["WEBDAV_USER"] = USERNAME;
    process.env["WORMHOLE_PASSPHRASE"] = PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("include 에 *_TOKEN 패턴 글로브 → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/CLAUDE.md", "**/*_TOKEN"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "시크릿");
    assert.equal(c.status, "warn", `*_TOKEN 패턴 시 warn. detail: ${c.detail}`);
  });

  test("include 에 *_PAT 패턴 글로브 → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/settings.json", "secrets/*_PAT"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "시크릿");
    assert.equal(c.status, "warn", `*_PAT 패턴 시 warn. detail: ${c.detail}`);
  });

  test("include 에 *_SECRET 패턴 글로브 → warn", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/CLAUDE.md", "env/*_SECRET"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "시크릿");
    assert.equal(c.status, "warn", `*_SECRET 패턴 시 warn. detail: ${c.detail}`);
  });

  test("include 에 시크릿 패턴 없음 → ok", async () => {
    const stateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env["WORMHOLE_CONFIG"] = writeConfigFull(stateDir, DEAD_URL, {
      targets: { include: [".claude/CLAUDE.md", ".claude/settings.json"] },
    });
    const result = await runDoctor(logger);
    const c = findCheck(result, "시크릿");
    assert.equal(c.status, "ok", `시크릿 패턴 없으면 ok. detail: ${c.detail}`);
  });
});
