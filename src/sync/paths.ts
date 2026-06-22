// 논리키 ↔ OS 경로 매핑. logicalKey 는 home 기준 posix(슬래시) 상대경로.
// home=Config.home(os.homedir() 스냅샷). Win 드라이브/대소문자/sep 안전.
import path from "node:path";
import type { LogicalKey } from "../types.js";

// settings.json 의 논리키 (home 기준 posix).
const SETTINGS_LOGICAL_KEY: LogicalKey = ".claude/settings.json";

// .mcp.json 논리키. WebDAV 원격 동기화 시 자기참조(wormhole) mcpServers 엔트리를 제외하는 분기 기준.
export const MCP_JSON_LOGICAL_KEY: LogicalKey = ".claude/.mcp.json";

// ~/.claude.json 논리키. home-root(home 직하) 파일이므로 ".claude/" 하위가 아님.
export const CLAUDE_JSON_LOGICAL_KEY: LogicalKey = ".claude.json";

// absPath → logicalKey. path.relative(home, absPath) 후 sep → "/" 정규화.
export function toLogical(home: string, absPath: string): LogicalKey {
  const rel = path.relative(home, absPath);
  return rel.split(path.sep).join("/");
}

// logicalKey → OS 절대경로. home 과 슬래시 분해 세그먼트 결합.
export function toOS(home: string, logicalKey: LogicalKey): string {
  return path.join(home, ...logicalKey.split("/"));
}

// home 하위 정상 키 여부. 상위 탈출(".." / 절대경로 / 드라이브) 거부, posix 슬래시 강제.
export function isValidLogicalKey(logicalKey: string): boolean {
  if (typeof logicalKey !== "string" || logicalKey.length === 0) return false;
  // null byte 차단(경로 절단 공격).
  if (logicalKey.includes("\0")) return false;
  // 백슬래시(Win sep) 혼입 금지 — 항상 posix 슬래시여야 함.
  if (logicalKey.includes("\\")) return false;
  // 절대경로(posix "/" 시작) 또는 드라이브 프리픽스("c:") 거부.
  if (logicalKey.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(logicalKey)) return false;
  // Windows 예약 디바이스명(타 OS 작성 키를 Windows 가 pull 시 오작동 방지).
  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  // 세그먼트 단위 검사.
  for (const seg of logicalKey.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false; // 빈/현재/상위 세그먼트.
    if (seg.includes(":")) return false; // NTFS ADS 스트림 표기.
    if (/[ .]$/.test(seg)) return false; // 후행 점/공백(Windows 가 제거 → 다른 파일 지칭).
    if (WIN_RESERVED.test(seg)) return false;
  }
  return true;
}

// absPath 가 home 하위인지. home 자기 자신은 제외(엄격 하위만).
export function isWithinHome(home: string, absPath: string): boolean {
  const rel = path.relative(home, absPath);
  if (rel.length === 0) return false; // home 자체.
  if (rel.startsWith("..")) return false; // 상위 탈출.
  if (path.isAbsolute(rel)) return false; // 다른 드라이브(Win) → relative 가 절대 반환.
  return true;
}

// 해당 logicalKey 가 settings.json 인지. settings-merge 라우팅용.
export function isSettingsKey(logicalKey: LogicalKey): boolean {
  return logicalKey === SETTINGS_LOGICAL_KEY;
}


export function isMcpJsonKey(logicalKey: LogicalKey): boolean {
  return logicalKey === MCP_JSON_LOGICAL_KEY;
}

// 해당 logicalKey 가 ~/.claude.json(home-root) 인지. engine 라우팅용.
export function isClaudeJsonKey(logicalKey: LogicalKey): boolean {
  return logicalKey === CLAUDE_JSON_LOGICAL_KEY;
}
