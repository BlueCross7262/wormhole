import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadConfig,
  resolveConfig,
  loadDotEnvIntoProcess,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
} from "./config.js";

// ── env 격리 헬퍼 ──────────────────────────────────────────────
// applyEnvOverrides 가 참조하는 모든 WORMHOLE_* 키 + 설정파일 경로 키.
const MANAGED_ENV_KEYS = [
  "WEBDAV_URL",
  "WEBDAV_USER",
  "WEBDAV_PASS",
  "WORMHOLE_PASSPHRASE_FILE",
  "WORMHOLE_KEYCHAIN_SERVICE",
  "WORMHOLE_PASSPHRASE",
  "WORMHOLE_CONFIG",
  "WORMHOLE_SYNC_INCLUDE",
  "WORMHOLE_SYNC_EXCLUDE",
];

const savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of MANAGED_ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function clearManagedEnv(): void {
  for (const k of MANAGED_ENV_KEYS) delete process.env[k];
}

let tmpRoot: string;
let isolatedEnv: string;

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
  // 머신의 실제 ~/.wormhole/.env 가 loadConfig 의 process.env 주입 경로로
  // 새어 들어오는 것을 막기 위해, 각 테스트는 격리된 빈 .env 를 dotEnvPath 로 넘긴다.
  isolatedEnv = path.join(tmpRoot, ".env.isolated");
  fs.writeFileSync(isolatedEnv, "", "utf-8");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfigFile(obj: unknown): string {
  const p = path.join(tmpRoot, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf-8");
  return p;
}

// 최소 유효 raw config: url + username 이 있으면 loadConfig 통과.
// (remoteBaseDir 는 명시 안 하면 username 에서 "/" + username 으로 도출되므로 username 필수.)
function minimalRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remote: { url: "https://file.example.com/dav", username: "wormhole" },
    ...extra,
  };
}

// ── 1. env-over-config precedence (remote) ────────────────────

describe("loadConfig — env overrides file for remote.*", () => {
  test("WEBDAV_URL/USER/PASS env win over file; USER overrides username", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://from-file.example.com/dav",
        username: "fileUser",
        password: "filePass",
        remoteBaseDir: "/custom-base",
      },
    });

    process.env["WEBDAV_URL"] = "https://from-env.example.com/dav";
    process.env["WEBDAV_USER"] = "envUser";
    process.env["WEBDAV_PASS"] = "envPass";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

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

    process.env["WEBDAV_URL"] = "https://only-url-env.example.com/dav";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    assert.equal(cfg.remote.url, "https://only-url-env.example.com/dav");
    assert.equal(cfg.remote.username, "fileUser");
    assert.equal(cfg.remote.password, "filePass");
  });
});

// ── 1b. remoteBaseDir 도출 (USER 기반) ─────────────────────────
// WEBDAV_BASEDIR env 오버라이드는 제거됨. remoteBaseDir 는
//  (a) config 에 명시되면 override 로 사용, 아니면
//  (b) "/" + username 으로 도출. username 도 비면 명확한 에러로 halt.

describe("loadConfig — remoteBaseDir derived from username", () => {
  test("no remoteBaseDir + WEBDAV_USER env → derived = '/' + user", async () => {
    const cfgPath = writeConfigFile({
      remote: { url: "https://nas.example.com/dav" },
    });
    process.env["WEBDAV_USER"] = "wormhole_claude_code";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    assert.equal(cfg.remote.username, "wormhole_claude_code");
    // 정확히 선행 슬래시 1개, 후행 슬래시 없음.
    assert.equal(cfg.remote.remoteBaseDir, "/wormhole_claude_code");
  });

  test("explicit config remoteBaseDir wins over username derivation", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://nas.example.com/dav",
        username: "alice",
        remoteBaseDir: "/explicit-base",
      },
    });

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // override 가 도출("/alice")보다 우선.
    assert.equal(cfg.remote.username, "alice");
    assert.equal(cfg.remote.remoteBaseDir, "/explicit-base");
  });

  test("no remoteBaseDir + empty username → throws actionable error", async () => {
    const cfgPath = writeConfigFile({
      remote: { url: "https://nas.example.com/dav" },
    });
    // env 비어 있음(beforeEach) + config 에 username/remoteBaseDir 없음.

    await assert.rejects(
      () => loadConfig(cfgPath, isolatedEnv),
      (err: Error) => {
        assert.match(err.message, /WEBDAV_USER/);
        return true;
      },
    );
  });
});

describe("resolveConfig — env overrides injected raw for remote.*", () => {
  test("URL/USER/PASS env win over raw; USER overrides username", () => {
    process.env["WEBDAV_URL"] = "https://env-direct.example.com/dav";
    process.env["WEBDAV_USER"] = "directEnvUser";
    process.env["WEBDAV_PASS"] = "directEnvPass";

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
      remote: { url: "https://file.example.com/dav", username: "wormhole" },
      crypto: {
        passphraseFile: "/abs/file/passphrase",
        keychainService: "file-keychain-service",
      },
    });

    const envPassFile = path.join(tmpRoot, "env-passphrase");
    process.env["WORMHOLE_PASSPHRASE_FILE"] = envPassFile;
    process.env["WORMHOLE_KEYCHAIN_SERVICE"] = "env-keychain-service";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // passphraseFile: 절대경로면 그대로(확장만), env 값으로 대체.
    assert.equal(cfg.crypto.passphraseFile, envPassFile);
    assert.equal(cfg.crypto.keychainService, "env-keychain-service");
  });
});

// ── 2. absent env: file values untouched ──────────────────────

describe("loadConfig — absent env leaves file values untouched", () => {
  test("no WEBDAV_* env → file remote values preserved", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://untouched.example.com/dav",
        username: "fileOnlyUser",
        password: "fileOnlyPass",
        remoteBaseDir: "/base",
      },
    });

    // env 는 beforeEach 에서 이미 비워짐 — 명시적 재확인.
    assert.equal(process.env["WEBDAV_URL"], undefined);

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    assert.equal(cfg.remote.url, "https://untouched.example.com/dav");
    assert.equal(cfg.remote.username, "fileOnlyUser");
    assert.equal(cfg.remote.password, "fileOnlyPass");
    assert.equal(cfg.remote.remoteBaseDir, "/base");
  });

  test("no crypto env → file passphraseFile / keychainService preserved", async () => {
    // OS 절대경로를 사용해 isAbsolute 분기를 타게 함(확장만, stateDir resolve 안 함).
    const filePassphrase = path.join(tmpRoot, "file", "configured", "passphrase");
    const cfgPath = writeConfigFile({
      remote: { url: "https://x.example.com/dav", username: "wormhole" },
      crypto: {
        passphraseFile: filePassphrase,
        keychainService: "file-only-keychain",
      },
    });

    const cfg = await loadConfig(cfgPath, isolatedEnv);

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
    process.env["WORMHOLE_PASSPHRASE"] = SECRET;
    process.env["WORMHOLE_PASSPHRASE_FILE"] = "/some/passphrase/file";
    process.env["WORMHOLE_KEYCHAIN_SERVICE"] = "my-keychain";

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
    assert.equal(cfg.crypto.passphraseEnv, "WORMHOLE_PASSPHRASE");
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
    process.env["WORMHOLE_PASSPHRASE"] = SECRET;

    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      crypto: { passphraseEnv: "WORMHOLE_PASSPHRASE" },
    });

    assert.equal(cfg.crypto.passphraseEnv, "WORMHOLE_PASSPHRASE");
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

  // config.ts line 149/162: 비절대 derivedKeyPath → stateDir 기준 resolve.
  test("relative derivedKeyPath resolves against stateDir", () => {
    const stateDir = path.join(tmpRoot, "state-dkp-rel");
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav" },
      stateDir,
      crypto: { derivedKeyPath: "keys/age-key.txt" },
    });

    assert.equal(cfg.crypto.derivedKeyPath, path.resolve(cfg.stateDir, "keys", "age-key.txt"));
  });
});

// ── 5. Zod defaults applied when omitted ──────────────────────

describe("Zod schema defaults populate omitted fields", () => {
  test("minimal config gets DEFAULT_INCLUDE / DEFAULT_EXCLUDE", () => {
    const cfg = resolveConfig({ remote: { url: "https://x.example.com/dav" } });

    assert.deepEqual(cfg.targets.include, DEFAULT_INCLUDE);
    assert.deepEqual(cfg.targets.exclude, DEFAULT_EXCLUDE);
  });

  test("other schema defaults: remote subfields, crypto KDF, selfMcp, conflictPolicy, lock", () => {
    const cfg = resolveConfig({ remote: { url: "https://x.example.com/dav", username: "wormhole" } });

    // remote defaults
    assert.equal(cfg.remote.username, "wormhole");
    assert.equal(cfg.remote.password, "");
    // remoteBaseDir 는 기본값이 아니라 username 에서 도출된다("/" + username).
    assert.equal(cfg.remote.remoteBaseDir, "/wormhole");

    // crypto defaults
    assert.equal(cfg.crypto.passphraseEnv, "WORMHOLE_PASSPHRASE");
    assert.equal(cfg.crypto.kdfN, 1 << 16);
    assert.equal(cfg.crypto.kdfR, 8);
    assert.equal(cfg.crypto.kdfP, 1);
    // 미지정 keychainService 는 optional → undefined.
    assert.equal(cfg.crypto.keychainService, undefined);

    // top-level defaults
    assert.deepEqual(cfg.selfMcpServerNames, ["wormhole"]);
    assert.equal(cfg.conflictPolicy, "preserve-both");

    // lock defaults
    assert.equal(cfg.lock.ttlMs, 30_000);
    assert.equal(cfg.lock.acquireRetries, 3);
    assert.equal(cfg.lock.acquireRetryDelayMs, 1000);
  });

  test("loadConfig with missing config file throws actionable error (config.json required)", async () => {
    // 존재하지 않는 파일 → ENOENT → 기본값 폴백 금지, 명확한 에러로 halt.
    const missing = path.join(tmpRoot, "does-not-exist.json");
    await assert.rejects(
      () => loadConfig(missing, isolatedEnv),
      (err: Error) => {
        assert.match(err.message, /config\.json/);
        assert.match(err.message, /wormhole-setup/);
        return true;
      },
    );
  });

  test("WORMHOLE_CONFIG env points loadConfig at the tmp file", async () => {
    const cfgPath = writeConfigFile({ remote: { url: "https://via-env-config.example.com/dav", username: "wormhole" } });
    process.env["WORMHOLE_CONFIG"] = cfgPath;

    // WORMHOLE_CONFIG 경로 사용(configPath 생략) + 격리된 .env.
    const cfg = await loadConfig(undefined, isolatedEnv);

    assert.equal(cfg.remote.url, "https://via-env-config.example.com/dav");
    assert.deepEqual(cfg.targets.include, DEFAULT_INCLUDE);
  });
});

// ── 6. .env 최소 파서 (loadDotEnvIntoProcess) ─────────────────

function writeDotEnv(lines: string): string {
  const p = path.join(tmpRoot, ".env");
  fs.writeFileSync(p, lines, "utf-8");
  return p;
}

describe("loadDotEnvIntoProcess — minimal .env parser", () => {
  test("missing file is a silent no-op (ENOENT)", () => {
    const missing = path.join(tmpRoot, "no-such.env");
    // 던지지 않아야 함.
    assert.doesNotThrow(() => loadDotEnvIntoProcess(missing));
  });

  test("parses KEY=VALUE, skips blanks and # comments, strips surrounding quotes", () => {
    const envPath = writeDotEnv(
      [
        "# 주석 줄",
        "",
        "   ",
        "WEBDAV_USER=alice",
        '  WEBDAV_PASS = "secret with spaces"  ',
        "WEBDAV_URL='https://nas.example.com/dav'",
        "# 또 다른 주석",
        "WORMHOLE_PASSPHRASE=global-pass",
        "MALFORMED_NO_EQUALS",
      ].join("\n"),
    );

    loadDotEnvIntoProcess(envPath);

    assert.equal(process.env["WEBDAV_USER"], "alice");
    // 따옴표 안의 공백은 보존, 둘러싼 " 만 제거.
    assert.equal(process.env["WEBDAV_PASS"], "secret with spaces");
    assert.equal(process.env["WEBDAV_URL"], "https://nas.example.com/dav");
    assert.equal(process.env["WORMHOLE_PASSPHRASE"], "global-pass");
    // '=' 없는 줄은 무시.
    assert.equal(process.env["MALFORMED_NO_EQUALS"], undefined);
  });

  test("does NOT override an already-set process.env key", () => {
    // MCP 가 준 값이 있다고 가정.
    process.env["WEBDAV_USER"] = "preset-user";

    const envPath = writeDotEnv("WEBDAV_USER=from-dotenv\n");
    loadDotEnvIntoProcess(envPath);

    // 기존 값이 이긴다.
    assert.equal(process.env["WEBDAV_USER"], "preset-user");
  });
});

// ── 7. loadConfig integration with flat .env profile ─────────

describe("loadConfig — flat .env profile applied to remote", () => {
  test("URL-only .env: remote.url from env, username/password fall back to config.json", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://from-file.example.com/dav",
        username: "fileUser",
        password: "filePass",
      },
    });
    const envPath = writeDotEnv("WEBDAV_URL=https://from-env.example.com/dav\n");

    const cfg = await loadConfig(cfgPath, envPath);

    assert.equal(cfg.remote.url, "https://from-env.example.com/dav");
    assert.equal(cfg.remote.username, "fileUser");
    assert.equal(cfg.remote.password, "filePass");
  });

  test("three keys in .env (url/username/password); explicit config remoteBaseDir wins", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://from-file.example.com/dav",
        username: "fileUser",
        password: "filePass",
        remoteBaseDir: "/file-base",
      },
    });
    const envPath = writeDotEnv(
      [
        "WEBDAV_URL=https://nas.example.com/dav",
        "WEBDAV_USER=alice",
        "WEBDAV_PASS=secret1",
      ].join("\n"),
    );

    const cfg = await loadConfig(cfgPath, envPath);

    assert.equal(cfg.remote.url, "https://nas.example.com/dav");
    assert.equal(cfg.remote.username, "alice");
    assert.equal(cfg.remote.password, "secret1");
    // 명시적 config remoteBaseDir 는 override 로 유지(username 도출보다 우선).
    assert.equal(cfg.remote.remoteBaseDir, "/file-base");
  });

  test("no remoteBaseDir + WEBDAV_USER (.env) → remoteBaseDir derived = '/' + user", async () => {
    const cfgPath = writeConfigFile({
      remote: { url: "https://from-file.example.com/dav" },
    });
    const envPath = writeDotEnv("WEBDAV_USER=wormhole_claude_code\n");

    const cfg = await loadConfig(cfgPath, envPath);

    assert.equal(cfg.remote.username, "wormhole_claude_code");
    assert.equal(cfg.remote.remoteBaseDir, "/wormhole_claude_code");
  });

  test("no WEBDAV env → config.json remote values preserved", async () => {
    const cfgPath = writeConfigFile({
      remote: {
        url: "https://untouched.example.com/dav",
        username: "fileUser",
        password: "filePass",
        remoteBaseDir: "/base",
      },
    });
    const envPath = writeDotEnv("WORMHOLE_PASSPHRASE=global-passphrase-from-dotenv\n");

    const cfg = await loadConfig(cfgPath, envPath);

    assert.equal(cfg.remote.url, "https://untouched.example.com/dav");
    assert.equal(cfg.remote.username, "fileUser");
    assert.equal(cfg.remote.password, "filePass");
    assert.equal(cfg.remote.remoteBaseDir, "/base");
  });

  test("WORMHOLE_PASSPHRASE in .env is visible via process.env after load", async () => {
    const cfgPath = writeConfigFile({ remote: { url: "https://x.example.com/dav", username: "wormhole" } });
    const envPath = writeDotEnv("WORMHOLE_PASSPHRASE=global-passphrase-from-dotenv\n");

    const cfg = await loadConfig(cfgPath, envPath);

    // .env 가 주입한 전역 passphrase 가 env 경로로 보인다.
    assert.equal(process.env["WORMHOLE_PASSPHRASE"], "global-passphrase-from-dotenv");
    // 설정의 passphraseEnv 이름은 그 env 를 가리킨다.
    assert.equal(cfg.crypto.passphraseEnv, "WORMHOLE_PASSPHRASE");
  });
});


// ── S1.1: homeRootTargets ────────────────

describe("RawConfigSchema — homeRootTargets", () => {
  test("(c) homeRootTargets 포함 객체 parse 성공 후 값 보존", () => {
    const raw = {
      remote: { url: "https://x.example.com/dav", username: "wormhole" },
      homeRootTargets: {
        ".claude.json": { subkeys: ["mcpServers"], preserveMode: "denylist" },
      },
    };

    const cfg = resolveConfig(raw);

    assert.deepEqual(cfg.homeRootTargets, {
      ".claude.json": { subkeys: ["mcpServers"], preserveMode: "denylist" },
    });
  });

  test("(d) homeRootTargets 부재 parse 시 undefined 유지", () => {
    const cfg = resolveConfig({
      remote: { url: "https://x.example.com/dav", username: "wormhole" },
    });

    assert.equal(cfg.homeRootTargets, undefined);
  });
});

// ── 8. WORMHOLE_SYNC_INCLUDE/EXCLUDE — 가산 union 오버라이드 ───

describe("loadConfig — WORMHOLE_SYNC_INCLUDE/EXCLUDE additive union", () => {
  test("WORMHOLE_SYNC_INCLUDE adds new globs to targets.include (defaults still present)", async () => {
    const cfgPath = writeConfigFile(minimalRaw());
    process.env["WORMHOLE_SYNC_INCLUDE"] = ".claude/extra/**,docs/**";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // 기본 include 전부 유지(가산).
    for (const g of DEFAULT_INCLUDE) assert.ok(cfg.targets.include.includes(g), `missing default include: ${g}`);
    // env 가 추가한 글롭이 존재.
    assert.ok(cfg.targets.include.includes(".claude/extra/**"));
    assert.ok(cfg.targets.include.includes("docs/**"));
    // 기본값 + 추가값, 중복 없음.
    assert.deepEqual(cfg.targets.include, [...DEFAULT_INCLUDE, ".claude/extra/**", "docs/**"]);
  });

  test("WORMHOLE_SYNC_EXCLUDE adds new globs AND keeps every secure default exclude (never shrinks)", async () => {
    const cfgPath = writeConfigFile(minimalRaw());
    process.env["WORMHOLE_SYNC_EXCLUDE"] = "**/secrets/**,*.pem";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // 보안 회귀 가드: 핵심 보안 기본 제외 항목이 반드시 살아있어야 한다.
    for (const secure of ["**/*.key", "**/*.token", ".claude/.credentials.json", ".claude/settings.local.json"]) {
      assert.ok(cfg.targets.exclude.includes(secure), `보안 기본 제외 누락: ${secure}`);
    }
    // DEFAULT_EXCLUDE 전부 유지.
    for (const g of DEFAULT_EXCLUDE) assert.ok(cfg.targets.exclude.includes(g), `missing default exclude: ${g}`);
    // env 가 추가한 글롭이 존재.
    assert.ok(cfg.targets.exclude.includes("**/secrets/**"));
    assert.ok(cfg.targets.exclude.includes("*.pem"));
    // 가산 결과 = 기본값 + 추가값.
    assert.deepEqual(cfg.targets.exclude, [...DEFAULT_EXCLUDE, "**/secrets/**", "*.pem"]);
  });

  test("comma parsing trims spaces and drops empty segments ('a, ,b,' → ['a','b'])", async () => {
    const cfgPath = writeConfigFile(minimalRaw());
    process.env["WORMHOLE_SYNC_INCLUDE"] = "a, ,b,";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    assert.deepEqual(cfg.targets.include, [...DEFAULT_INCLUDE, "a", "b"]);
  });

  test("dedupe: an env include equal to an existing default does not duplicate", async () => {
    const dup = DEFAULT_INCLUDE[0];
    const cfgPath = writeConfigFile(minimalRaw());
    process.env["WORMHOLE_SYNC_INCLUDE"] = `${dup},brand-new/**`;

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // 중복 default 는 한 번만, 새 글롭만 끝에 추가.
    assert.deepEqual(cfg.targets.include, [...DEFAULT_INCLUDE, "brand-new/**"]);
    const occurrences = cfg.targets.include.filter((g) => g === dup).length;
    assert.equal(occurrences, 1);
  });

  test("absent env vars → targets equal config/defaults unchanged", async () => {
    const cfgPath = writeConfigFile(minimalRaw());
    // WORMHOLE_SYNC_* 미설정(beforeEach 가 clear).

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    assert.deepEqual(cfg.targets.include, DEFAULT_INCLUDE);
    assert.deepEqual(cfg.targets.exclude, DEFAULT_EXCLUDE);
  });

  test("union applies on top of config.json-provided custom targets (not just Zod defaults)", async () => {
    const cfgPath = writeConfigFile(
      minimalRaw({ targets: { include: ["custom/**"], exclude: ["custom-secret.key"] } }),
    );
    process.env["WORMHOLE_SYNC_INCLUDE"] = "added/**";
    process.env["WORMHOLE_SYNC_EXCLUDE"] = "added-secret/**";

    const cfg = await loadConfig(cfgPath, isolatedEnv);

    // config.json 의 명시 targets + env 가산.
    assert.deepEqual(cfg.targets.include, ["custom/**", "added/**"]);
    assert.deepEqual(cfg.targets.exclude, ["custom-secret.key", "added-secret/**"]);
  });

  test("via .env FILE: WORMHOLE_SYNC_INCLUDE in a tmp .env is unioned (loadDotEnvIntoProcess integration)", async () => {
    const cfgPath = writeConfigFile(minimalRaw());
    const envPath = writeDotEnv("WORMHOLE_SYNC_INCLUDE=from-dotenv/**,another/**\n");

    const cfg = await loadConfig(cfgPath, envPath);

    // .env 가 process.env 로 주입된 뒤 union 에 반영.
    assert.deepEqual(cfg.targets.include, [...DEFAULT_INCLUDE, "from-dotenv/**", "another/**"]);
    // 기본 exclude 는 그대로.
    assert.deepEqual(cfg.targets.exclude, DEFAULT_EXCLUDE);
  });
});
