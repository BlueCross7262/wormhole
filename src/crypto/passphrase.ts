import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../types.js";

const execFileAsync = promisify(execFile);

export interface PassphraseSourceConfig {
  // 환경변수 이름(예: "WORMHOLE_PASSPHRASE").
  env: string;
  // 0600 권한의 passphrase 파일 경로(절대경로, 이미 tilde 확장됨).
  file: string;
  // (선택) keychain service 이름. 설정 시 secret-tool 로 조회(Linux/WSL2).
  keychainService?: string;
}

export interface PassphraseResult {
  passphrase: string;
  source: "env" | "file" | "keychain";
}

// passphrase 해석 우선순위: env > file > keychain.
//
// 근거:
// - MCP 서버는 stdio 비대화형 프로세스라 인터랙티브 입력이 불가능하다. .mcp.json 의 env 로
//   주입하는 방식이 가장 단순·명시적이라 env 를 1순위로 둔다.
// - env 미주입 환경(셸 직접 실행 등)을 위해 0600 파일을 2순위로 둔다. 파일은 영속적이고
//   프로세스 환경에 노출되지 않는다.
// - keychain 은 가장 안전하나 플랫폼 의존적이고(Windows 자격증명관리자 vs Linux secret-tool)
//   가용성이 낮아 최후순위로 둔다. 여기서는 WSL2/Linux 의 secret-tool 만 실구현한다.
export async function resolvePassphrase(
  cfg: PassphraseSourceConfig,
  logger?: Logger,
): Promise<PassphraseResult> {
  const fromEnv = process.env[cfg.env];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    logger?.debug(`passphrase: env(${cfg.env}) 사용`);
    return { passphrase: fromEnv.trim(), source: "env" };
  }

  const fromFile = await readPassphraseFile(cfg.file, logger);
  if (fromFile !== null) {
    logger?.debug(`passphrase: 파일(${cfg.file}) 사용`);
    return { passphrase: fromFile, source: "file" };
  }

  if (cfg.keychainService) {
    const fromKc = await readKeychain(cfg.keychainService, logger);
    if (fromKc !== null) {
      logger?.debug(`passphrase: keychain(${cfg.keychainService}) 사용`);
      return { passphrase: fromKc, source: "keychain" };
    }
  }

  throw new Error(
    `passphrase 를 찾을 수 없음. 다음 중 하나를 설정하라: ` +
      `환경변수 ${cfg.env}, 0600 파일 ${cfg.file}` +
      (cfg.keychainService ? `, keychain service ${cfg.keychainService}` : ""),
  );
}

// passphrase 파일 읽기. 첫 비주석·비공백 라인을 passphrase 로 사용한다.
// POSIX 에서 0600 보다 느슨한 권한이면 경고(차단은 아님).
async function readPassphraseFile(filePath: string, logger?: Logger): Promise<string | null> {
  let raw: string;
  let mode: number;
  try {
    const st = await fs.stat(filePath);
    mode = st.mode;
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  // POSIX 권한 점검(group/other 비트가 켜져 있으면 경고). Windows 는 mode 무의미.
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    logger?.warn(
      `passphrase 파일 권한이 느슨함(${(mode & 0o777).toString(8)}). 'chmod 600 ${filePath}' 권장.`,
    );
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

// secret-tool(libsecret) 로 keychain 조회. 미설치/미존재 시 null.
// 조회 키: `secret-tool lookup service <service> account wormhole`.
async function readKeychain(service: string, logger?: Logger): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      "wormhole",
    ]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch (err) {
    logger?.debug(`keychain 조회 실패(무시): ${String((err as Error).message)}`);
    return null;
  }
}
