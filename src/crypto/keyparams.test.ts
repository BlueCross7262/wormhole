import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCryptoReady, type EnsureCryptoArgs } from "./keyparams.js";
import { AgeCrypto } from "./age.js";
import { type KdfParams } from "./kdf.js";
import type { RemoteStore } from "../webdav/client.js";
import { resolvePassphrase, type PassphraseSourceConfig } from "./passphrase.js";

// 테스트 비용을 낮추기 위한 약한 KDF 파라미터(scrypt N 을 낮춰 빠르게 돌린다).
// keyparams 의 계약(센티넬 검증/salt 라운드트립)은 파라미터 세기와 무관하다.
const FAST: KdfParams = { N: 1 << 8, r: 8, p: 1 };
const SENTINEL_PLAINTEXT = "wormhole passphrase verification v1";

// ensureCryptoReady 가 실제로 호출하는 RemoteStore 표면은 getTextIfExists + putAtomic 뿐이다.
// 네트워크 없이 메모리로 대체한다.
class FakeRemote {
  store = new Map<string, string>();
  putCalls: Array<{ path: string; machineId: string }> = [];

  async getTextIfExists(p: string): Promise<string | null> {
    return this.store.has(p) ? (this.store.get(p) as string) : null;
  }

  async putAtomic(p: string, data: string | Buffer, machineId: string): Promise<void> {
    this.putCalls.push({ path: p, machineId });
    this.store.set(p, typeof data === "string" ? data : data.toString("utf-8"));
  }
}

function makeRemote(): RemoteStore {
  return new FakeRemote() as unknown as RemoteStore;
}

describe("ensureCryptoReady — 최초 기기(부트스트랩)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-kp-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("원격에 keyparams 가 없으면 새로 생성(created:true) + recipient 반환", async () => {
    const remote = makeRemote();
    const crypto = new AgeCrypto();
    const args: EnsureCryptoArgs = {
      remote,
      crypto,
      passphrase: "correct horse battery staple",
      params: FAST,
      derivedKeyPath: path.join(dir, "derived.key"),
      machineId: "machine-A",
    };

    const result = await ensureCryptoReady(args);

    assert.equal(result.created, true);
    assert.ok(result.recipient.startsWith("age1"), `recipient 형식 이상: ${result.recipient}`);
    assert.equal(result.recipient, crypto.recipient);
  });

  test("생성된 keyparams.json 의 스키마/필드가 계약과 일치", async () => {
    const remote = makeRemote() as unknown as FakeRemote;
    const crypto = new AgeCrypto();
    await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto,
      passphrase: "pw-schema",
      params: FAST,
      derivedKeyPath: path.join(dir, "derived.key"),
      machineId: "machine-A",
    });

    const raw = remote.store.get("keyparams.json");
    assert.ok(raw, "keyparams.json 이 원격에 기록되지 않음");
    const kp = JSON.parse(raw as string);

    assert.equal(kp.version, 1);
    assert.equal(kp.kdf, "scrypt");
    assert.equal(kp.N, FAST.N);
    assert.equal(kp.r, FAST.r);
    assert.equal(kp.p, FAST.p);
    assert.ok(typeof kp.saltB64 === "string" && kp.saltB64.length > 0, "saltB64 누락");
    assert.ok(
      typeof kp.sentinel === "string" && kp.sentinel.includes("BEGIN AGE"),
      "sentinel 이 armored age 암호문이 아님",
    );
  });

  test("putAtomic 이 올바른 경로/machineId 로 1회 호출된다", async () => {
    const remote = makeRemote() as unknown as FakeRemote;
    const crypto = new AgeCrypto();
    await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto,
      passphrase: "pw-put",
      params: FAST,
      derivedKeyPath: path.join(dir, "derived.key"),
      machineId: "machine-XYZ",
    });

    assert.equal(remote.putCalls.length, 1);
    assert.equal(remote.putCalls[0].path, "keyparams.json");
    assert.equal(remote.putCalls[0].machineId, "machine-XYZ");
  });

  test("파생 키가 derivedKeyPath 에 캐시된다(passphrase 원문은 저장 안 함)", async () => {
    const keyPath = path.join(dir, "nested", "derived.key");
    const remote = makeRemote();
    const crypto = new AgeCrypto();
    await ensureCryptoReady({
      remote,
      crypto,
      passphrase: "super-secret-passphrase",
      params: FAST,
      derivedKeyPath: keyPath,
      machineId: "machine-A",
    });

    const cached = await fsp.readFile(keyPath, "utf-8");
    assert.ok(cached.includes("AGE-SECRET-KEY-1"), "캐시 파일에 age identity 가 없음");
    assert.ok(
      !cached.includes("super-secret-passphrase"),
      "캐시 파일에 passphrase 원문이 노출됨(보안 계약 위반)",
    );
  });
});

describe("ensureCryptoReady — 신규 기기 검증(센티넬)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-kp-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 최초 기기가 원격에 keyparams 를 만들고, 그 원격을 신규 기기가 재사용하는 시나리오.
  async function bootstrap(passphrase: string): Promise<FakeRemote> {
    const remote = new FakeRemote();
    const crypto = new AgeCrypto();
    await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto,
      passphrase,
      params: FAST,
      derivedKeyPath: path.join(dir, "device1.key"),
      machineId: "device-1",
    });
    return remote;
  }

  test("동일 passphrase → 센티넬 복호 성공 → created:false", async () => {
    const remote = await bootstrap("shared-passphrase");

    // 신규 기기: 같은 원격, 같은 passphrase, 새 crypto 인스턴스.
    const crypto2 = new AgeCrypto();
    const result = await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto: crypto2,
      passphrase: "shared-passphrase",
      params: FAST,
      derivedKeyPath: path.join(dir, "device2.key"),
      machineId: "device-2",
    });

    assert.equal(result.created, false, "기존 원격을 재사용했으므로 created 는 false 여야 함");
    assert.equal(result.recipient, crypto2.recipient);
  });

  test("두 기기의 recipient 가 동일(동일 salt/passphrase → 동일 키)", async () => {
    const remote = await bootstrap("shared-passphrase");
    const stored = JSON.parse(remote.store.get("keyparams.json") as string);

    const crypto2 = new AgeCrypto();
    const result = await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto: crypto2,
      passphrase: "shared-passphrase",
      params: FAST,
      derivedKeyPath: path.join(dir, "device2.key"),
      machineId: "device-2",
    });

    // 같은 salt + 같은 passphrase → 결정적으로 같은 identity → 같은 recipient.
    assert.ok(result.recipient.startsWith("age1"));
    // salt 가 라운드트립으로 보존되어야 두 기기가 같은 키를 얻는다.
    assert.equal(typeof stored.saltB64, "string");
  });

  test("다른 passphrase → 센티넬 복호 실패 → throw(검증 실패)", async () => {
    const remote = await bootstrap("the-right-passphrase");

    const crypto2 = new AgeCrypto();
    await assert.rejects(
      ensureCryptoReady({
        remote: remote as unknown as RemoteStore,
        crypto: crypto2,
        passphrase: "a-completely-wrong-passphrase",
        params: FAST,
        derivedKeyPath: path.join(dir, "device2.key"),
        machineId: "device-2",
      }),
      /passphrase 검증 실패/,
    );
  });

  test("salt 라운드트립: 신규 기기는 저장된 salt 를 그대로 사용한다", async () => {
    const remote = await bootstrap("salt-rt-pass");
    const before = JSON.parse(remote.store.get("keyparams.json") as string);

    const crypto2 = new AgeCrypto();
    await ensureCryptoReady({
      remote: remote as unknown as RemoteStore,
      crypto: crypto2,
      passphrase: "salt-rt-pass",
      params: FAST,
      derivedKeyPath: path.join(dir, "device2.key"),
      machineId: "device-2",
    });

    // 신규 기기는 원격을 읽기만 하므로 salt/keyparams 가 변하지 않아야 한다.
    const after = JSON.parse(remote.store.get("keyparams.json") as string);
    assert.equal(after.saltB64, before.saltB64);
    assert.equal(after.sentinel, before.sentinel);
    assert.equal(remote.putCalls.length, 1, "신규 기기는 putAtomic 을 호출하면 안 됨");
  });
});

describe("ensureCryptoReady — 원격 손상/비호환 처리", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-kp-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function baseArgs(remote: FakeRemote): EnsureCryptoArgs {
    return {
      remote: remote as unknown as RemoteStore,
      crypto: new AgeCrypto(),
      passphrase: "pw",
      params: FAST,
      derivedKeyPath: path.join(dir, "d.key"),
      machineId: "m",
    };
  }

  test("JSON 파싱 불가한 원격 → 명확한 에러", async () => {
    const remote = new FakeRemote();
    remote.store.set("keyparams.json", "{ not valid json");
    await assert.rejects(ensureCryptoReady(baseArgs(remote)), /파싱 실패/);
  });

  test("스키마 위반(필드 누락) 원격 → 구조 검증 실패 에러", async () => {
    const remote = new FakeRemote();
    // sentinel/saltB64 누락 → KeyParamsSchema.safeParse 실패.
    remote.store.set("keyparams.json", JSON.stringify({ version: 1, kdf: "scrypt" }));
    await assert.rejects(ensureCryptoReady(baseArgs(remote)), /구조 검증 실패/);
  });

  test("kdf 가 'scrypt' 가 아니면 거부", async () => {
    const remote = new FakeRemote();
    remote.store.set(
      "keyparams.json",
      JSON.stringify({
        version: 1,
        kdf: "argon2",
        saltB64: "AAAA",
        N: 256,
        r: 8,
        p: 1,
        sentinel: "x",
      }),
    );
    await assert.rejects(ensureCryptoReady(baseArgs(remote)), /구조 검증 실패/);
  });
});

// =====================================================================
// passphrase 모듈: 주입 우선순위 env > 파일 > keychain
// =====================================================================

describe("resolvePassphrase — 주입 우선순위", () => {
  let dir: string;
  const SNAPSHOT_KEYS = ["CS_TEST_PASSPHRASE"];
  let saved: Record<string, string | undefined>;

  before(() => {
    saved = {};
    for (const k of SNAPSHOT_KEYS) saved[k] = process.env[k];
  });

  after(() => {
    for (const k of SNAPSHOT_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-pp-"));
    delete process.env.CS_TEST_PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CS_TEST_PASSPHRASE;
  });

  function cfg(overrides: Partial<PassphraseSourceConfig> = {}): PassphraseSourceConfig {
    return {
      env: "CS_TEST_PASSPHRASE",
      file: path.join(dir, "passphrase"),
      ...overrides,
    };
  }

  async function writePassFile(p: string, contents: string): Promise<void> {
    await fsp.writeFile(p, contents, { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") await fsp.chmod(p, 0o600);
  }

  test("env 설정 시 env 값을 사용한다(source:env)", async () => {
    process.env.CS_TEST_PASSPHRASE = "from-env-secret";
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "from-env-secret");
    assert.equal(res.source, "env");
  });

  test("env 값 앞뒤 공백은 trim 된다", async () => {
    process.env.CS_TEST_PASSPHRASE = "  spaced-secret  ";
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "spaced-secret");
    assert.equal(res.source, "env");
  });

  test("env 가 공백뿐이면 무시하고 다음 소스(파일)로 폴백", async () => {
    process.env.CS_TEST_PASSPHRASE = "   ";
    const file = path.join(dir, "passphrase");
    await writePassFile(file, "file-secret\n");
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "file-secret");
    assert.equal(res.source, "file");
  });

  test("env 없고 파일만 있으면 파일 값 사용(source:file)", async () => {
    const file = path.join(dir, "passphrase");
    await writePassFile(file, "file-only-secret\n");
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "file-only-secret");
    assert.equal(res.source, "file");
  });

  test("둘 다 있으면 env 가 파일을 이긴다", async () => {
    process.env.CS_TEST_PASSPHRASE = "env-wins";
    const file = path.join(dir, "passphrase");
    await writePassFile(file, "file-loses\n");
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "env-wins");
    assert.equal(res.source, "env");
  });

  test("파일의 주석(#)/빈 줄은 건너뛰고 첫 실값 줄을 반환", async () => {
    const file = path.join(dir, "passphrase");
    await writePassFile(file, "# comment\n\n   \nreal-secret\nignored-second\n");
    const res = await resolvePassphrase(cfg());
    assert.equal(res.passphrase, "real-secret");
    assert.equal(res.source, "file");
  });

  test("어느 소스에도 없으면 명확한 에러를 던진다", async () => {
    // env 미설정, 파일 부재(존재하지 않는 경로), keychain 미지정.
    await assert.rejects(
      resolvePassphrase(cfg({ file: path.join(dir, "does-not-exist") })),
      /passphrase 를 찾을 수 없음/,
    );
  });

  test("에러 메시지에 env 이름과 파일 경로가 포함된다", async () => {
    const missingFile = path.join(dir, "nope");
    await assert.rejects(resolvePassphrase(cfg({ file: missingFile })), (err: Error) => {
      assert.match(err.message, /CS_TEST_PASSPHRASE/);
      assert.ok(err.message.includes(missingFile), "에러 메시지에 파일 경로 누락");
      return true;
    });
  });

  test("keychainService 미설정 시 에러 메시지에 keychain 언급 없음", async () => {
    await assert.rejects(resolvePassphrase(cfg()), (err: Error) => {
      assert.doesNotMatch(err.message, /keychain service/);
      return true;
    });
  });

  test("빈 파일(실값 줄 없음)이면 파일을 건너뛰어 결국 에러", async () => {
    const file = path.join(dir, "passphrase");
    await writePassFile(file, "# only comments\n\n");
    await assert.rejects(resolvePassphrase(cfg()), /passphrase 를 찾을 수 없음/);
  });
});

// =====================================================================
// passphrase 모듈: 추가 에러 브랜치 커버리지
// - readPassphraseFile 의 catch 경로(파일 읽기 오류 → null)
// - readPassphraseFile 의 POSIX loose-permission warn 경로
// - readKeychain 의 catch 경로(logger.debug 호출 후 null 반환)
// =====================================================================

describe("resolvePassphrase — file read error branches", () => {
  let dir: string;
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.CS_TEST_PASSPHRASE;
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.CS_TEST_PASSPHRASE;
    else process.env.CS_TEST_PASSPHRASE = savedEnv;
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-pp-err-"));
    delete process.env.CS_TEST_PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CS_TEST_PASSPHRASE;
  });

  function cfg(overrides: Partial<PassphraseSourceConfig> = {}): PassphraseSourceConfig {
    return {
      env: "CS_TEST_PASSPHRASE",
      file: path.join(dir, "passphrase"),
      ...overrides,
    };
  }

  // readPassphraseFile catch 브랜치: stat/readFile 실패 → null 반환 → 다음 소스로.
  // 파일이 아예 없는 경우 fs.stat 이 ENOENT 를 던지므로 catch → null → throw.
  test("readPassphraseFile: 존재하지 않는 파일은 catch 경로(→null)를 타며 에러로 폴백", async () => {
    const nonexistent = path.join(dir, "does-not-exist");
    await assert.rejects(
      resolvePassphrase(cfg({ file: nonexistent })),
      /passphrase 를 찾을 수 없음/,
    );
  });

  // readPassphraseFile catch 브랜치: directory 를 파일로 stat 할 수 있지만
  // readFile 은 EISDIR 로 실패 → catch → null 반환.
  test("readPassphraseFile: 디렉터리 경로는 readFile EISDIR → catch → null 폴백", async () => {
    const dirPath = path.join(dir, "is-a-dir");
    fs.mkdirSync(dirPath, { recursive: true });
    await assert.rejects(
      resolvePassphrase(cfg({ file: dirPath })),
      /passphrase 를 찾을 수 없음/,
    );
  });

  // POSIX 전용: loose-permission(0o644) warn 경로.
  // Windows 에서는 mode 비트가 무의미하므로 skip.
  test("readPassphraseFile: POSIX 에서 0644 파일은 warn 을 발행하지만 값은 반환한다", async () => {
    if (process.platform === "win32") return;

    const filePath = path.join(dir, "passphrase-loose");
    fs.writeFileSync(filePath, "loose-secret\n", "utf-8");
    fs.chmodSync(filePath, 0o644);

    const warnMessages: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => { warnMessages.push(msg); },
      error: () => {},
    };

    const res = await resolvePassphrase(cfg({ file: filePath }), logger);
    assert.equal(res.passphrase, "loose-secret");
    assert.equal(res.source, "file");
    assert.ok(
      warnMessages.some((m) => m.includes("느슨함")),
      `warn 이 발행되지 않음. 실제 warn: ${JSON.stringify(warnMessages)}`,
    );
  });

  // readKeychain catch 브랜치: secret-tool 미설치/실패 → logger.debug 후 null 반환.
  // keychainService 가 있어도 env/file 이 모두 없으면 최종 throw.
  test("readKeychain: secret-tool 실패 시 debug 로그 후 null → 최종 에러", async () => {
    const debugMessages: string[] = [];
    const logger = {
      debug: (msg: string) => { debugMessages.push(msg); },
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const c = cfg({
      file: path.join(dir, "no-file"),
      keychainService: "nonexistent-service-xyz",
    });

    await assert.rejects(
      resolvePassphrase(c, logger),
      /passphrase 를 찾을 수 없음/,
    );
    // secret-tool 실패 시 debug 메시지가 발행되어야 한다(catch 브랜치 통과 확인).
    assert.ok(
      debugMessages.some((m) => m.includes("keychain 조회 실패")),
      `keychain 실패 debug 로그 없음. 실제 debug: ${JSON.stringify(debugMessages)}`,
    );
  });
});

describe("resolvePassphrase — keychain 폴백(플랫폼 의존)", () => {
  let dir: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env.CS_TEST_PASSPHRASE;
  });

  after(() => {
    if (saved === undefined) delete process.env.CS_TEST_PASSPHRASE;
    else process.env.CS_TEST_PASSPHRASE = saved;
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-kc-"));
    delete process.env.CS_TEST_PASSPHRASE;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CS_TEST_PASSPHRASE;
  });

  // Windows(및 secret-tool 미설치 환경)에서는 readKeychain 이 null 을 반환하므로
  // env/파일이 모두 없으면 keychainService 가 설정돼 있어도 최종적으로 에러로 떨어진다.
  // 이 테스트는 "keychain 조회 실패가 크래시가 아니라 graceful null 폴백"임을 검증한다.
  test("secret-tool 미설치 시 keychain 은 graceful 실패 → 최종 에러(크래시 아님)", async () => {
    const cfg: PassphraseSourceConfig = {
      env: "CS_TEST_PASSPHRASE",
      file: path.join(dir, "does-not-exist"),
      keychainService: "wormhole-test-service-nonexistent",
    };
    await assert.rejects(resolvePassphrase(cfg), /passphrase 를 찾을 수 없음/);
  });

  test("keychainService 설정 시 에러 메시지에 service 이름이 포함된다", async () => {
    const cfg: PassphraseSourceConfig = {
      env: "CS_TEST_PASSPHRASE",
      file: path.join(dir, "does-not-exist"),
      keychainService: "my-kc-service",
    };
    await assert.rejects(resolvePassphrase(cfg), (err: Error) => {
      assert.match(err.message, /keychain service my-kc-service/);
      return true;
    });
  });
});
