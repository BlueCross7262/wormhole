import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Config } from "./types.js";

// ── 기본값 ────────────────────────────────────────────────────

export const DEFAULT_INCLUDE: string[] = [
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  ".claude/skills/**",
  ".claude/agents/**",
  ".claude/commands/**",
  ".claude/hooks/**",
  ".claude/statusline/**",
  ".claude/hud/**",
];

export const DEFAULT_EXCLUDE: string[] = [
  ".claude/.credentials.json",
  ".claude/settings.local.json",
  "**/*.token",
  "**/*.key",
  ".claude/projects/**",
  ".claude/todos/**",
  ".claude/statsig/**",
  ".claude/history/**",
  "**/*.log",
  "**/cache/**",
];

export const DEFAULT_SETTINGS_LOCAL_KEYS: string[] = [
  "mcpServers.*.command",
  "mcpServers.*.args",
  "mcpServers.*.cwd",
  "mcpServers.*.env",
  "permissions.*",
  "hooks",
  "statusLine.command",
];

// ── zod 스키마 ────────────────────────────────────────────────

const RemoteConfigSchema = z.object({
  url: z.string().min(1),
  username: z.string().default(""),
  password: z.string().default(""),
  // remoteBaseDir 는 더 이상 기본값을 갖지 않는다. 미지정 시 username 에서 도출된다("/" + username).
  remoteBaseDir: z.string().optional(),
});

const CryptoConfigSchema = z.object({
  // passphrase 를 읽을 환경변수 이름.
  passphraseEnv: z.string().default("WORMHOLE_PASSPHRASE"),
  // 0600 passphrase 파일 경로(빈 문자열이면 stateDir/passphrase 기본값).
  passphraseFile: z.string().default(""),
  // (선택) keychain service 이름(secret-tool, Linux/WSL2).
  keychainService: z.string().optional(),
  // 파생 age 키 캐시 경로(빈 문자열이면 stateDir/age-key.txt 기본값).
  derivedKeyPath: z.string().default(""),
  // scrypt KDF 파라미터(N 은 2의 거듭제곱). 기본 N=2^16.
  kdfN: z.number().int().positive().default(1 << 16),
  kdfR: z.number().int().positive().default(8),
  kdfP: z.number().int().positive().default(1),
});

const SyncTargetsSchema = z.object({
  include: z.array(z.string()).default(DEFAULT_INCLUDE),
  exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
});

const LockConfigSchema = z.object({
  ttlMs: z.number().int().positive().default(30_000),
  acquireRetries: z.number().int().nonnegative().default(3),
  acquireRetryDelayMs: z.number().int().nonnegative().default(1000),
});

const HomeRootTargetSchema = z.object({
  subkeys: z.array(z.string()),
  preserveMode: z.literal("denylist"),
});

const SettingsJsonSchema = z.object({
  localOnlyKeys: z.array(z.string()).default(DEFAULT_SETTINGS_LOCAL_KEYS),
  forceSyncKeys: z.array(z.string()).optional(),
}).default({});

const RawConfigSchema = z.object({
  stateDir: z.string().optional(),
  home: z.string().optional(),
  remote: RemoteConfigSchema.partial().default({}),
  crypto: CryptoConfigSchema.partial().default({}),
  targets: SyncTargetsSchema.partial().default({}),
  settingsJson: SettingsJsonSchema,
  // 자기 자신(wormhole) mcp 서버 이름 목록. .mcp.json 동기화 시 자기참조 제외 기준.
  selfMcpServerNames: z.array(z.string()).default(["wormhole"]),
  conflictPolicy: z.enum(["preserve-both", "latest-wins", "manual"]).default("preserve-both"),
  lock: LockConfigSchema.partial().default({}),
  // home-root 파일(예: .claude.json)의 머지 서브키와 보존모드 맵.
  homeRootTargets: z.record(HomeRootTargetSchema).optional(),
});

// 완전한 Config zod 타입 (런타임 검증용)
const FullConfigSchema = z.object({
  stateDir: z.string(),
  home: z.string(),
  remote: RemoteConfigSchema,
  crypto: CryptoConfigSchema,
  targets: SyncTargetsSchema,
  settingsJson: z.object({ localOnlyKeys: z.array(z.string()), forceSyncKeys: z.array(z.string()).optional() }),
  conflictPolicy: z.enum(["preserve-both", "latest-wins", "manual"]),
  lock: LockConfigSchema,
});

export const ConfigSchema: z.ZodType<Config> = FullConfigSchema as unknown as z.ZodType<Config>;

// ── ~ 확장 유틸 ───────────────────────────────────────────────

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

// ── .env 로더 (zero-dep 최소 파서) ────────────────────────────
// 고정 위치 ~/.wormhole/.env 를 읽어 process.env 로 주입한다.
// 규칙: 빈 줄·'#' 주석 무시, 첫 '=' 기준 분리, key trim,
//       value trim 후 둘러싼 한 쌍의 ' 또는 " 제거.
//       이미 존재하는 키는 덮어쓰지 않는다(기존 process.env 우선).
export function loadDotEnvIntoProcess(envPath?: string): void {
  const target = envPath ?? path.join(os.homedir(), ".wormhole", ".env");

  let content: string;
  try {
    content = fs.readFileSync(target, "utf-8");
  } catch (err: unknown) {
    // 파일 없으면 조용히 skip. 그 외 오류만 전파.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === "") continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    // 이미 설정된 키는 덮어쓰지 않음(MCP 가 준 값 우선).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ── env 오버라이드 적용 ───────────────────────────────────────

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw } as Record<string, unknown>;

  const remote = { ...(result["remote"] as Record<string, unknown> ?? {}) };

  if (process.env["WEBDAV_URL"]) remote["url"] = process.env["WEBDAV_URL"];
  if (process.env["WEBDAV_USER"]) remote["username"] = process.env["WEBDAV_USER"];
  if (process.env["WEBDAV_PASS"]) remote["password"] = process.env["WEBDAV_PASS"];
  result["remote"] = remote;

  // crypto: passphrase 원문은 config 에 저장하지 않는다(런타임에 env/0600파일/keychain 에서 직접 읽음).
  // 여기서는 passphrase "소스 메타"(파일 경로 / keychain service)만 오버라이드한다.
  const crypto = { ...(result["crypto"] as Record<string, unknown> ?? {}) };
  if (process.env["WORMHOLE_PASSPHRASE_FILE"]) crypto["passphraseFile"] = process.env["WORMHOLE_PASSPHRASE_FILE"];
  if (process.env["WORMHOLE_KEYCHAIN_SERVICE"]) crypto["keychainService"] = process.env["WORMHOLE_KEYCHAIN_SERVICE"];
  result["crypto"] = crypto;

  return result;
}

function migrateLegacySettingsKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const hasLegacy = "settingsLocalKeys" in raw || "templateSettingsKeys" in raw;
  if (!hasLegacy) return raw;
  const out = { ...raw };
  if (out.settingsJson == null) {
    const grp: Record<string, unknown> = {};
    if (Array.isArray(out.settingsLocalKeys)) grp.localOnlyKeys = out.settingsLocalKeys;
    if (Array.isArray(out.templateSettingsKeys)) grp.forceSyncKeys = out.templateSettingsKeys;
    out.settingsJson = grp;
    console.warn("[wormhole] config 의 settingsLocalKeys/templateSettingsKeys 는 deprecated — settingsJson.{localOnlyKeys,forceSyncKeys} 로 이전하라. 이번 실행은 자동 변환됨.");
  }
  delete out.settingsLocalKeys;
  delete out.templateSettingsKeys;
  return out;
}


// remoteBaseDir 정규화: 정확히 1개의 선행 슬래시, 후행 슬래시 제거.
// 예: "wormhole_claude_code" -> "/wormhole_claude_code", "/foo/" -> "/foo".
function normalizeBaseDir(raw: string): string {
  return "/" + raw.replace(/^\/+/, "").replace(/\/+$/, "");
}

// 해석된 remote.remoteBaseDir 도출:
// - 명시적으로 설정된 경우(공백 아님) 그 값을 정규화해 사용(override).
// - 미지정/공백이면 username 에서 "/" + username 으로 도출.
// username 도 비어 있을 때의 throw 가드는 호출자(loadConfig)에서 처리한다.
function deriveRemoteBaseDir(remoteBaseDir: string | undefined, username: string): string {
  const explicit = (remoteBaseDir ?? "").trim();
  if (explicit) return normalizeBaseDir(explicit);
  return normalizeBaseDir(username);
}
// ── 경로 확장 (~ + stateDir 기준 상대경로) ───────────────────

function resolvePaths(parsed: z.infer<typeof RawConfigSchema>, home: string, stateDir: string): Config {
  const remoteRaw = RemoteConfigSchema.parse(parsed.remote);
  const remote = {
    url: remoteRaw.url,
    username: remoteRaw.username,
    password: remoteRaw.password,
    remoteBaseDir: deriveRemoteBaseDir(remoteRaw.remoteBaseDir, remoteRaw.username),
  };
  const cryptoRaw = CryptoConfigSchema.parse(parsed.crypto);

  // passphraseFile: 빈 문자열이면 stateDir/passphrase 기본값.
  let passphraseFile = cryptoRaw.passphraseFile;
  if (!passphraseFile) {
    passphraseFile = path.join(stateDir, "passphrase");
  } else {
    passphraseFile = expandTilde(passphraseFile, home);
    if (!path.isAbsolute(passphraseFile)) {
      passphraseFile = path.resolve(stateDir, passphraseFile);
    }
  }

  // derivedKeyPath: 빈 문자열이면 stateDir/age-key.txt 기본값(locked decision #1).
  let derivedKeyPath = cryptoRaw.derivedKeyPath;
  if (!derivedKeyPath) {
    derivedKeyPath = path.join(stateDir, "age-key.txt");
  } else {
    derivedKeyPath = expandTilde(derivedKeyPath, home);
    if (!path.isAbsolute(derivedKeyPath)) {
      derivedKeyPath = path.resolve(stateDir, derivedKeyPath);
    }
  }

  return {
    stateDir,
    home,
    remote,
    crypto: {
      passphraseEnv: cryptoRaw.passphraseEnv,
      passphraseFile,
      keychainService: cryptoRaw.keychainService,
      derivedKeyPath,
      kdfN: cryptoRaw.kdfN,
      kdfR: cryptoRaw.kdfR,
      kdfP: cryptoRaw.kdfP,
    },
    targets: SyncTargetsSchema.parse(parsed.targets),
    settingsJson: parsed.settingsJson,
    selfMcpServerNames: parsed.selfMcpServerNames,
    conflictPolicy: parsed.conflictPolicy,
    lock: LockConfigSchema.parse(parsed.lock),
    homeRootTargets: parsed.homeRootTargets,
  };
}

// ── resolveConfig (테스트/직접 주입) ─────────────────────────

export function resolveConfig(raw: unknown): Config {
  const home = os.homedir();
  const withEnv = applyEnvOverrides(raw as Record<string, unknown>);
  const migrated = migrateLegacySettingsKeys(withEnv);
  const parsed = RawConfigSchema.parse(migrated);

  const stateDir = parsed.stateDir
    ? path.resolve(expandTilde(parsed.stateDir, home))
    : path.join(home, ".wormhole");

  const resolvedHome = parsed.home
    ? path.resolve(expandTilde(parsed.home, home))
    : home;

  return resolvePaths(parsed, resolvedHome, stateDir);
}

// ── loadConfig (파일 + env 병합) ─────────────────────────────

// 콤마 구분 env 값을 트림·빈문자 제거 후 배열로 파싱한다.
// 빈/부재 값은 빈 배열 → union 에 아무것도 기여하지 않는다.
function parseCommaList(v: string | undefined): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// 최초 등장 순서를 보존하는 안정 dedupe.
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export async function loadConfig(configPath?: string, dotEnvPath?: string): Promise<Config> {
  const home = os.homedir();

  // 진입부에서 ~/.wormhole/.env(또는 테스트용 override 경로)를 process.env 로 주입.
  // 기존 process.env 키는 보존(MCP 가 준 값 우선).
  loadDotEnvIntoProcess(dotEnvPath);

  // 설정 파일 경로 결정
  const cfgPath = configPath
    ?? process.env["WORMHOLE_CONFIG"]
    ?? path.join(home, ".wormhole", "config.json");

  let fileRaw: Record<string, unknown> = {};
  try {
    const content = await fs.promises.readFile(cfgPath, "utf-8");
    fileRaw = JSON.parse(content) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `config.json 없음 (${cfgPath}). /wormhole-setup 를 실행하면 config.json 과 .env 템플릿을 자동 생성한다(기존 파일은 보존). 생성 뒤 ~/.wormhole/.env 에 WEBDAV_URL/USER/PASS 와 패스프레이즈를 채워라.`,
      );
    }
    throw new Error(`config 파일 읽기 실패 (${cfgPath}): ${(err as Error).message}`);
  }

  const withEnv = applyEnvOverrides(fileRaw);
  const migrated = migrateLegacySettingsKeys(withEnv);
  const parsed = RawConfigSchema.parse(migrated);

  // remoteBaseDir 가드: 명시적 remoteBaseDir 가 없고 username 도 비어 있으면 도출 불가 → 명확히 halt.
  // (remoteBaseDir 는 username 에서 "/" + username 으로 도출되므로 username 이 필수다.)
  const remoteUsername = (parsed.remote?.username ?? "").trim();
  const remoteBaseDir = (parsed.remote?.remoteBaseDir ?? "").trim();
  if (!remoteBaseDir && !remoteUsername) {
    throw new Error(
      "WEBDAV_USER 가 필요함 (remote base 경로를 USER 에서 도출). ~/.wormhole/.env 에 WEBDAV_USER 를 설정하라.",
    );
  }

  // .env(또는 process.env)의 WORMHOLE_SYNC_INCLUDE/EXCLUDE 는 동기화 대상에 대해
  // "가산 union" 으로만 작동한다(절대 replace 아님). config.json 의 보안 기본 제외
  // (*.key, *.token, .credentials.json, settings.local.json 등)는 항상 유지되며,
  // env 로는 기본값을 줄일 수 없다 — 줄이려면 config.json 을 직접 수정해야 한다.
  // SyncTargetsSchema.parse 로 Zod 기본값(DEFAULT_INCLUDE/EXCLUDE)을 먼저 실체화한 뒤 union.
  const baseTargets = SyncTargetsSchema.parse(parsed.targets);
  parsed.targets = {
    include: dedupe([
      ...baseTargets.include,
      ...parseCommaList(process.env["WORMHOLE_SYNC_INCLUDE"]),
    ]),
    exclude: dedupe([
      ...baseTargets.exclude,
      ...parseCommaList(process.env["WORMHOLE_SYNC_EXCLUDE"]),
    ]),
  };

  const stateDir = parsed.stateDir
    ? path.resolve(expandTilde(parsed.stateDir, home))
    : path.join(home, ".wormhole");

  const resolvedHome = parsed.home
    ? path.resolve(expandTilde(parsed.home, home))
    : home;

  return resolvePaths(parsed, resolvedHome, stateDir);
}
