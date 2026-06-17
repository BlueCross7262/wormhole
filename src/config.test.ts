import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadConfig,
  resolveConfig,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
  DEFAULT_SETTINGS_LOCAL_KEYS,
} from "./config.js";

// ── env 격리 헬퍼 ──────────────────────────────────────────────
// applyEnvOverrides 가 참조하는 모든 CLAUDE_SYNC_* 키 + 설정파일 경로 키.
const MANAGED_ENV_KEYS = [
  "CLAUDE_SYNC_WEBDAV_URL",
  "CLAUDE_SYNC_WEBDAV_USER",
  "CLAUDE_SYNC_WEBDAV_PASS",
  "CLAUDE_SYNC_PASSPHRASE_FILE",
  "CLAUDE_SYNC_KEYCHAIN_SERVICE",
  "CLAUDE_SYNC_PASSPHRASE",
  "CLAUDE_SYNC_CONFIG",
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

let tmpRoot: string;

before(() => {
  snapshotEnv();
});

after(() => {
  restoreEnv();
});

beforeEach(() => {
  // 각 테스트 진입 시 관리 env 를 깨끗이 비워 결정적·순서무관 보장.
  clearManagedEnv();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfigFile(obj: unknown): string {
  const p = path.join(tmpRoot, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf-8");
  return p;
}

// 최소 유효 raw config: remote.url 만 있으면 zod 통과.
function minimalRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remote: { url: "https://file.example.com/dav" },
    ...extra,
  };
}

// ── 1. env-over-config precedence (remote) ────────────────────

describe("loadConfig — env overrides file for remote.*", () => {
  test("WEBDAV_URL/USER/PASS env values win over file values", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://from-file.example.com/dav",
        username: "fileUser",
        password: "filePass",
        remoteBaseDir: "/custom-base",
      },
    });

    process.env["CLAUDE_SYNC_WEBDAV_URL"] = "https://from-env.example.com/dav";
    process.env["CLAUDE_SYNC_WEBDAV_USER"] = "envUser";
    process.env["CLAUDE_SYNC_WEBDAV_PASS"] = "envPass";

    const cfg = await loadConfig(cfgPath);

    assert.equal(cfg.remote.url, "https://from-env.example.com/dav");
    assert.equal(cfg.remote.username, "envUser");
    assert.equal(cfg.remote.password, "envPass");
    // env 가 건드리지 않은 필드는 파일 값 유지.
    assert.equal(cfg.remote.remoteBaseDir, "/custom-base");
  });

  test("partial env override: only URL set, user/pass fall back to file", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://from-file.example.com/dav",
        username: "fileUser",
        password: "filePass",
      },
    });

    process.env["CLAUDE_SYNC_WEBDAV_URL"] = "https://only-url-env.example.com/dav";

    const cfg = await loadConfig(cfgPath);

    assert.equal(cfg.remote.url, "https://only-url-env.example.com/dav");
    assert.equal(cfg.remote.username, "fileUser");
    assert.equal(cfg.remote.password, "filePass");
  });
});

describe("resolveConfig — env overrides injected raw for remote.*", () => {
  test("env wins over raw object remote values", () => {
    process.env["CLAUDE_SYNC_WEBDAV_URL"] = "https://env-direct.example.com/dav";
    process.env["CLAUDE_SYNC_WEBDAV_USER"] = "directEnvUser";
    process.env["CLAUDE_SYNC_WEBDAV_PASS"] = "directEnvPass";

    const cfg = resolveConfig({
      remote: {
        url: "https://raw.example.com/dav",
        username: "rawUser",
        password: "rawPass",
      },
    });

    assert.equal(cfg.remote.url, "https://env-direct.example.com/dav");
    assert.equal(cfg.remote.username, "directEnvUser");
    assert.equal(cfg.remote.password, "directEnvPass");
  });
});

describe("loadConfig — env overrides file for crypto source metadata", () => {
  test("PASSPHRASE_FILE / KEYCHAIN_SERVICE env win over file values", async () => {
    const cfgPath = writeConfigFile({
      remote: { url: "https://file.example.com/dav" },
      crypto: {
        passphraseFile: "/abs/file/passphrase",
        keychainService: "file-keychain-service",
      },
    });

    const envPassFile = path.join(tmpRoot, "env-passphrase");
    process.env["CLAUDE_SYNC_PASSPHRASE_FILE"] = envPassFile;
    process.env["CLAUDE_SYNC_KEYCHAIN_SERVICE"] = "env-keychain-service";

    const cfg = await loadConfig(cfgPath);

    // passphraseFile: 절대경로면 그대로(확장만), env 값으로 대체.
    assert.equal(cfg.crypto.passphraseFile, envPassFile);
    assert.equal(cfg.crypto.keychainService, "env-keychain-service");
  });
});

// ── 2. absent env: file values untouched ──────────────────────

describe("loadConfig — absent env leaves file values untouched", () => {
  test("no CLAUDE_SYNC_WEBDAV_* env → file remote values preserved", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://untouched.example.com/dav",
        username: "fileOnlyUser",
        password: "fileOnlyPass",
        remoteBaseDir: "/base",
      },
    });

    // env 는 beforeEach 에서 이미 비워짐 — 명시적 재확인.
    assert.equal(process.env["CLAUDE_SYNC_WEBDAV_URL"], undefined);

    const cfg = await loadConfig(cfgPath);

    assert.equal(cfg.remote.url, "https://untouched.example.com/dav");
    assert.equal(cfg.remote.username, "fileOnlyUser");
    assert.equal(cfg.remote.password, "fileOnlyPass");
    assert.equal(cfg.remote.remoteBaseDir, "/base");
  });

  test("no crypto env → file passphraseFile / keychainService preserved", async () => {
    // OS 절대경로를 사용해 isAbsolute 분기를 타게 함(확장만, stateDir resolve 안 함).
    const filePassphrase = path.join(tmpRoot, "file", "configured", "passphrase");
    const cfgPath = writeConfigFile({
      remote: { url: "https://x.example.com/dav" },
      crypto: {
        passphraseFile: filePassphrase,
        keychainService: "file-only-keychain",
      },
    });

    const cfg = await loadConfig(cfgPath);

    // 절대경로이므로 expandTilde 후 그대로 유지(stateDir 기준 resolve 안 됨).
    assert.equal(cfg.crypto.passphraseFile, filePassphrase);
    assert.equal(cfg.crypto.keychainService, "file-only-keychain");
  });
});

// ── 3. passphrase plaintext NEVER injected into config ────────

describe("passphrase plaintext is never present on config object", () => {
  // crypto 가 노출해도 되는 키 화이트리스트(메타데이터/파생 경로/KDF 파라미터만).
  const ALLOWED_CRYPTO_KEYS = new Set([
    "passphraseEnv",
    "passphraseFile",
    "keychainService",
    "derivedKeyPath",
    "kdfN",
    "kdfR",
    "kdfP",
  ]);

  test("env passphrase set, but config carries only source metadata (no plaintext)", () => {
    // 환경변수로 실제 passphrase 평문을 넣어도 config 에 새어나오면 안 됨.
    const SECRET = "super-secret-plaintext-passphrase";
    process.env["CLAUDE_SYNC_PASSPHRASE"] = SECRET;
    process.env["CLAUDE_SYNC_PASSPHRASE_FILE"] = "/some/passphrase/file";
    process.env["CLAUDE_SYNC_KEYCHAIN_SERVICE"] = "my-keychain";

    const cfg = resolveConfig({ remote: { url: "https://x.example.com/dav" } });

    // crypto 객체에 평문 passphrase 를 담는 필드가 없음.
    const cryptoKeys = Object.keys(cfg.crypto);
    for (const k of cryptoKeys) {
      assert.ok(
        ALLOWED_CRYPTO_KEYS.has(k),
        `unexpected crypto key leaked: "${k}"`,
      );
    }
    assert.ok(!("passphrase" in cfg.crypto), "crypto must not have a 'passphrase' field");

    // 소스 메타데이터(env 이름/파일경로/keychain service)만 존재.
    assert.equal(cfg.crypto.passphraseEnv, "CLAUDE_SYNC_PASSPHRASE");
    assert.equal(cfg.crypto.keychainService, "my-keychain");

    // 평문 SECRET 이 config 전체 직렬화 어디에도 등장하지 않음.
    const serialized = JSON.stringify(cfg);
    assert.ok(
      !serialized.includes(SECRET),
      "plaintext passphrase must never appear anywhere in the config",
    );
  });

  test("passphraseEnv name in config, not its resolved value", () => {
    // 커스텀 env 이름을 지정하고 그 env 에 평문을 넣어도 이름만 저장.
    const SECRET = "another-plaintext";
    process.env["CLAUDE_SYNC_PASSPHRASE"] = SECRET;

    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      crypto: { passphraseEnv: "CLAUDE_SYNC_PASSPHRASE" },
    });

    assert.equal(cfg.crypto.passphraseEnv, "CLAUDE_SYNC_PASSPHRASE");
    assert.ok(!JSON.stringify(cfg).includes(SECRET));
  });
});

// ── 4. tilde (~) expansion + derived path defaults ────────────

describe("tilde expansion + derived path defaults", () => {
  test("'~/...'-style stateDir expands to home (os.homedir basis)", () => {
    // stateDir 의 ~ 는 os.homedir() 기준으로 확장.
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      stateDir: "~/my-sync-state",
    });

    const expected = path.resolve(path.join(os.homedir(), "my-sync-state"));
    assert.equal(cfg.stateDir, expected);
  });

  test("'~/...'-style passphraseFile + derivedKeyPath expand using config home", () => {
    // home 필드를 tmp 로 지정하면 passphraseFile/derivedKeyPath 의 ~ 는 그 home 기준.
    const fakeHome = path.join(tmpRoot, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });

    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      home: fakeHome,
      stateDir: path.join(tmpRoot, "state"),
      crypto: {
        passphraseFile: "~/secrets/passphrase",
        derivedKeyPath: "~/secrets/age-key.txt",
      },
    });

    assert.equal(cfg.crypto.passphraseFile, path.join(fakeHome, "secrets", "passphrase"));
    assert.equal(cfg.crypto.derivedKeyPath, path.join(fakeHome, "secrets", "age-key.txt"));
  });

  test("empty passphraseFile defaults to <stateDir>/passphrase", () => {
    const stateDir = path.join(tmpRoot, "state-default");
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      stateDir,
      // crypto 생략 → passphraseFile/derivedKeyPath 빈 문자열 기본값.
    });

    assert.equal(cfg.crypto.passphraseFile, path.join(cfg.stateDir, "passphrase"));
  });

  test("empty derivedKeyPath defaults to <stateDir>/age-key.txt", () => {
    const stateDir = path.join(tmpRoot, "state-default2");
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      stateDir,
    });

    assert.equal(cfg.crypto.derivedKeyPath, path.join(cfg.stateDir, "age-key.txt"));
  });

  test("relative passphraseFile resolves against stateDir", () => {
    // 비절대·비틸드 경로는 stateDir 기준 상대로 해석.
    const stateDir = path.join(tmpRoot, "state-rel");
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      stateDir,
      crypto: { passphraseFile: "nested/pass" },
    });

    assert.equal(cfg.crypto.passphraseFile, path.resolve(cfg.stateDir, "nested", "pass"));
  });
});

// ── 5. Zod defaults applied when omitted ──────────────────────

describe("Zod schema defaults populate omitted fields", () => {
  test("minimal config gets DEFAULT_INCLUDE / DEFAULT_EXCLUDE / DEFAULT_SETTINGS_LOCAL_KEYS", () => {
    const cfg = resolveConfig({ remote: { url: "https://x.example.com/dav" } });

    assert.deepEqual(cfg.targets.include, DEFAULT_INCLUDE);
    assert.deepEqual(cfg.targets.exclude, DEFAULT_EXCLUDE);
    assert.deepEqual(cfg.settingsLocalKeys, DEFAULT_SETTINGS_LOCAL_KEYS);
  });

  test("other schema defaults: remote subfields, crypto KDF, selfMcp, conflictPolicy, autoSync, lock", () => {
    const cfg = resolveConfig({ remote: { url: "https://x.example.com/dav" } });

    // remote defaults
    assert.equal(cfg.remote.username, "");
    assert.equal(cfg.remote.password, "");
    assert.equal(cfg.remote.remoteBaseDir, "/claude-sync");

    // crypto defaults
    assert.equal(cfg.crypto.passphraseEnv, "CLAUDE_SYNC_PASSPHRASE");
    assert.equal(cfg.crypto.kdfN, 1 << 16);
    assert.equal(cfg.crypto.kdfR, 8);
    assert.equal(cfg.crypto.kdfP, 1);
    // 미지정 keychainService 는 optional → undefined.
    assert.equal(cfg.crypto.keychainService, undefined);

    // top-level defaults
    assert.deepEqual(cfg.selfMcpServerNames, ["claude-sync"]);
    assert.equal(cfg.conflictPolicy, "preserve-both");

    // autoSync defaults
    assert.equal(cfg.autoSync.enabled, false);
    assert.equal(cfg.autoSync.debounceMs, 2000);
    assert.equal(cfg.autoSync.pullIntervalMs, 300_000);

    // lock defaults
    assert.equal(cfg.lock.ttlMs, 30_000);
    assert.equal(cfg.lock.acquireRetries, 3);
    assert.equal(cfg.lock.acquireRetryDelayMs, 1000);
  });

  test("loadConfig with missing file falls back to schema defaults (no remote.url) → throws on required url", async () => {
    // 존재하지 않는 파일 → fileRaw {} → remote.url 누락 → zod min(1) 실패.
    const missing = path.join(tmpRoot, "does-not-exist.json");
    await assert.rejects(() => loadConfig(missing));
  });

  test("CLAUDE_SYNC_CONFIG env points loadConfig at the tmp file", async () => {
    const cfgPath = writeConfigFile({ remote: { url: "https://via-env-config.example.com/dav" } });
    process.env["CLAUDE_SYNC_CONFIG"] = cfgPath;

    // 인자 없이 호출 → CLAUDE_SYNC_CONFIG 경로 사용.
    const cfg = await loadConfig();

    assert.equal(cfg.remote.url, "https://via-env-config.example.com/dav");
    assert.deepEqual(cfg.targets.include, DEFAULT_INCLUDE);
  });
});
