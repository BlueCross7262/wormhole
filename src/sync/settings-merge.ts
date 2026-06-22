import * as path from "node:path";
import type { SettingsMergeResult } from "../types.js";
import { sha256 } from "./hash.js";

// settings.json 키단위 deep 3-way 머지.
// dot-path + 와일드카드(mcpServers.*.command) 로 로컬고유키를 식별·제외한다.
// shared subset 만 동기화하고 로컬고유키는 항상 로컬값을 보존한다.

// plain 객체(배열/null 아님)인지 판별 — deep 머지 재귀 진입 조건.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 프로토타입 오염 방어: 원격 JSON 에서 온 위험 키를 객체 빌드 시 차단한다.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isForbiddenKey(k: string): boolean {
  return FORBIDDEN_KEYS.has(k);
}

// 경로 이식성: home 절대경로를 "${HOME}" 토큰으로 치환(tokenize)/복원(detokenize).
// 동기화되는 값(.mcp.json 의 타 서버 command/args 등)이 머신별 절대경로로 깨지는 것을 막는다.
const HOME_TOKEN = "${HOME}";

export function tokenizeHome(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    if (home === "") return value;
    if (value === home) return HOME_TOKEN;
    if (value.startsWith(home + "/") || value.startsWith(home + "\\")) {
      // 접미사를 canonical posix("/")로 정규화해 저장 → 어느 OS 가 pull 해도 자기 path.sep 로 재구성 가능
      // (Win 의 `\` 가 그대로 새어 POSIX 머신에서 깨지는 것을 방지).
      const suffix = value.slice(home.length).split(/[\\/]/).join("/");
      return HOME_TOKEN + suffix;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => tokenizeHome(v, home));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue;
      out[k] = tokenizeHome(v, home);
    }
    return out;
  }
  return value;
}

export function detokenizeHome(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    if (value === HOME_TOKEN) return home;
    if (value.startsWith(HOME_TOKEN + "/") || value.startsWith(HOME_TOKEN + "\\")) {
      // 토큰 접미사(canonical posix)를 로컬 OS 구분자(path.sep)로 재구성.
      const suffix = value.slice(HOME_TOKEN.length).split(/[\\/]/).join(path.sep);
      return home + suffix;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => detokenizeHome(v, home));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue;
      out[k] = detokenizeHome(v, home);
    }
    return out;
  }
  return value;
}

// dot-path 한 세그먼트가 패턴 세그먼트와 매칭되는지("*" 는 임의 키 1개).
function segMatches(pattern: string, seg: string): boolean {
  return pattern === "*" || pattern === seg;
}

// 주어진 dot-path 가 localKeys 중 하나와 매칭되는지(와일드카드 지원).
// 패턴이 path 의 prefix 면 매칭 — "mcpServers.*" 는 "mcpServers.foo.command" 도 포함.
function isLocalKey(path: string, localKeys: string[]): boolean {
  const segs = path.split(".");
  for (const key of localKeys) {
    const pat = key.split(".");
    if (pat.length > segs.length) continue;
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (!segMatches(pat[i], segs[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// 객체를 깊이 순회하며 localKeys 에 매칭되지 않는 키만 복제한다.
// templateKeys 에 매칭되는 키는 drop 대신 tokenizeHome 후 포함한다.
function pruneLocal(
  obj: Record<string, unknown>,
  localKeys: string[],
  prefix: string,
  templateKeys: string[],
  home: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isForbiddenKey(k)) continue;
    const dotPath = prefix ? `${prefix}.${k}` : k;
    if (isLocalKey(dotPath, templateKeys)) {
      // templateKey: drop 대신 tokenizeHome 후 shared 에 포함한다.
      out[k] = home ? tokenizeHome(v, home) : v;
      continue;
    }
    if (isLocalKey(dotPath, localKeys)) continue;
    if (isPlainObject(v)) {
      const pruned = pruneLocal(v, localKeys, dotPath, templateKeys, home);
      // 자식이 "로컬키 제거로 인해" 비었으면(원래는 내용이 있었음) 부모도 생략한다.
      // 머신 고유 중첩키(예: mcpServers.x.command)만 있던 컨테이너가 빈 껍데기로 원격에 새는 것을 막는다.
      // 원래부터 빈 객체({})는 보존한다.
      if (Object.keys(pruned).length === 0 && Object.keys(v).length > 0) continue;
      out[k] = pruned;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 로컬고유키(localKeys)를 제거한 shared subset 을 반환한다(깊은 복제).
// templateKeys 에 매칭되는 키는 drop 대신 tokenizeHome 후 shared 에 포함한다.
export function extractSharedSubset(
  obj: Record<string, unknown>,
  localKeys: string[],
  templateKeys: string[] = [],
  home = "",
): Record<string, unknown> {
  return pruneLocal(obj, localKeys, "", templateKeys, home);
}

// 동등성 비교(구조적). 동시 변경 충돌 판정용.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}

// 키단위 3-way 머지 재귀. 각 키별로 local/remote/base 를 비교한다.
// - 양측 미변경 → base(=동일) 유지.
// - 한쪽만 변경 → 변경된 쪽 채택.
// - 양측 상이 변경 → 객체면 하위로 재귀, leaf 면 conflict 수집 후 local 유지.
function mergeRecursive(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  base: Record<string, unknown>,
  prefix: string,
  conflicts: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set<string>([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  for (const k of keys) {
    if (isForbiddenKey(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const hasLocal = Object.prototype.hasOwnProperty.call(local, k);
    const hasRemote = Object.prototype.hasOwnProperty.call(remote, k);
    const hasBase = Object.prototype.hasOwnProperty.call(base, k);
    const lv = local[k];
    const rv = remote[k];
    const bv = base[k];

    const localChanged = hasLocal !== hasBase || (hasLocal && !deepEqual(lv, bv));
    const remoteChanged = hasRemote !== hasBase || (hasRemote && !deepEqual(rv, bv));

    if (!localChanged && !remoteChanged) {
      if (hasBase) out[k] = bv;
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (hasLocal) out[k] = lv;
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (hasRemote) out[k] = rv;
      continue;
    }

    // 양측 변경.
    if (deepEqual(lv, rv)) {
      if (hasLocal) out[k] = lv;
      continue;
    }
    if (isPlainObject(lv) && isPlainObject(rv)) {
      out[k] = mergeRecursive(
        lv,
        rv,
        isPlainObject(bv) ? bv : {},
        path,
        conflicts,
      );
      continue;
    }
    // leaf 충돌 — local 유지, conflict 기록.
    conflicts.push(path);
    if (hasLocal) out[k] = lv;
  }
  return out;
}

// 3-way deep merge.
// local(현재 로컬 전체), remoteShared(원격 shared subset), baseShared(마지막 동기화 shared subset).
// 로컬고유키는 머지에서 제외하고 로컬값 그대로 보존, shared 영역만 3-way 머지한다.
// 반환 merged 는 로컬에 기록할 최종(로컬고유키 + 머지된 shared),
// sharedSubset 은 원격 반영분(로컬고유키 제거).
export function threeWayMerge(
  local: Record<string, unknown>,
  remoteShared: Record<string, unknown>,
  baseShared: Record<string, unknown>,
  localKeys: string[],
): SettingsMergeResult {
  const localShared = extractSharedSubset(local, localKeys);
  const conflictKeys: string[] = [];

  const mergedShared = mergeRecursive(
    localShared,
    remoteShared,
    baseShared,
    "",
    conflictKeys,
  );

  // 로컬고유키 보존: 로컬 전체에서 shared 영역(머지본)으로 덮어쓴다.
  const merged: Record<string, unknown> = structuredCloneSafe(local);
  applyShared(merged, mergedShared, localShared);

  return {
    merged,
    sharedSubset: mergedShared,
    conflictKeys,
    hasConflict: conflictKeys.length > 0,
  };
}

// 구조적 복제(순환 없는 JSON 류 settings 가정). structuredClone 미지원 환경 대비 폴백.
function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}


// 안정적(키 정렬) JSON 직렬화. 동일 내용이면 항상 동일 바이트열을 내도록 객체 키를 재귀 정렬한다.
// 배열은 의미상 순서가 중요하므로 순서를 보존하고 원소만 재귀 정규화한다.
function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value), null, 2) + "\n";
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (isForbiddenKey(k)) continue;
      out[k] = stableNormalize(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * .mcp.json 텍스트에서 자기참조(wormhole 등) mcpServers 엔트리를 제거한다.
 * - JSON 파싱 실패 시 원본 텍스트를 그대로 반환(throw 금지)하되 hash/size 는 원본 기준으로 계산한다.
 * - 성공 시 mcpServers 객체에서 selfNames 키를 삭제하고 안정 직렬화한다.
 */
export function stripSelfMcpServers(
  jsonText: string,
  selfNames: string[],
  home = "",
): { text: string; hash: string; size: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const buf = Buffer.from(jsonText, "utf-8");
    return { text: jsonText, hash: sha256(buf), size: buf.byteLength };
  }

  const root = isPlainObject(parsed) ? structuredCloneSafe(parsed) : {};
  const servers = root.mcpServers;
  if (isPlainObject(servers)) {
    for (const name of selfNames) {
      delete servers[name];
    }
  }

  // home 절대경로를 ${HOME} 토큰으로 치환(타 머신 이식성).
  const tokenized = home ? tokenizeHome(root, home) : root;
  const text = stableStringify(tokenized);
  const buf = Buffer.from(text, "utf-8");
  return { text, hash: sha256(buf), size: buf.byteLength };
}

// settings.json 동기화용 정규화: 머신 고유키를 제거한 shared subset 을 결정적(stableStringify)으로
// 직렬화하고 해시한다. scan 의 localHash 와 push 의 contentHash 가 동일 파이프라인을 통과해야
// "변경 없음" 이 unchanged 로 판정된다(멱등성). 파싱 실패 시 원본 바이트 기준으로 폴백.
export function normalizeSettingsForSync(
  rawText: string,
  localKeys: string[],
  home = "",
  templateKeys: string[] = [],
): { text: string; hash: string; size: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const buf = Buffer.from(rawText, "utf-8");
    return { text: rawText, hash: sha256(buf), size: buf.byteLength };
  }
  const obj = isPlainObject(parsed) ? parsed : {};
  // templateKeys 키는 extractSharedSubset 내부에서 tokenizeHome 후 포함된다.
  // 나머지 shared 키는 이후 tokenizeHome 으로 다시 처리 — templateKeys 는 이미 토큰화됐으므로 이중 토큰화되지 않는다.
  // (tokenizeHome 은 이미 토큰화된 문자열을 건드리지 않음: "${HOME}/..." 는 home prefix 아님)
  const shared = extractSharedSubset(obj, localKeys, templateKeys, home);
  // templateKeys 외 shared 키의 home 절대경로를 ${HOME} 토큰으로 치환(이식성).
  const tokenized = home ? tokenizeHome(shared, home) : shared;
  const text = stableStringify(tokenized);
  const buf = Buffer.from(text, "utf-8");
  return { text, hash: sha256(buf), size: buf.byteLength };
}

/**
 * pull 시 원격 shared(.mcp.json, 이미 self 제거됨)를 로컬에 머지한다.
 * - 로컬의 self mcpServers 엔트리는 항상 보존한다(기기 로컬 wormhole 등록 유지).
 * - 원격의 비-self 서버 엔트리는 원격 우선으로 적용한다.
 * - 로컬 파싱 실패/부재면 원격을 기반으로 self 만 비우고 반환한다.
 * - 안정 직렬화된 텍스트를 반환한다.
 */

// *_PAT / *_TOKEN / *_SECRET 형태 env 키 패턴 — pull 시 시크릿 strip 기준.
const SECRET_ENV_PATTERN = /_(PAT|TOKEN|SECRET)$/;

/**
 * push/scan 공용 정규화: 로컬 .claude.json raw → mcpServers 서브트리만 추출 + home 토큰화.
 * stripSelfMcpServers 시그니처를 미러링한다.
 * JSON 파싱 실패 시 원본 텍스트/해시 반환(throw 금지).
 */
export function normalizeClaudeJsonForSync(
  jsonText: string,
  selfNames: string[],
  home = "",
): { text: string; hash: string; size: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const buf = Buffer.from(jsonText, "utf-8");
    return { text: jsonText, hash: sha256(buf), size: buf.byteLength };
  }

  const root = isPlainObject(parsed) ? (parsed as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(root, "mcpServers")) {
    const servers = root.mcpServers;
    if (isPlainObject(servers)) {
      const strippedServers: Record<string, unknown> = {};
      for (const [name, serverVal] of Object.entries(servers)) {
        if (selfNames.includes(name)) continue;
        if (!isPlainObject(serverVal)) {
          strippedServers[name] = serverVal;
          continue;
        }
        const srv = structuredCloneSafe(serverVal) as Record<string, unknown>;
        const env = srv.env;
        if (isPlainObject(env)) {
          for (const envKey of Object.keys(env)) {
            if (SECRET_ENV_PATTERN.test(envKey)) {
              delete (env as Record<string, unknown>)[envKey];
            }
          }
        }
        strippedServers[name] = srv;
      }
      out.mcpServers = strippedServers;
    } else {
      out.mcpServers = servers;
    }
  }

  const tokenized = home ? tokenizeHome(out, home) : out;
  const text = stableStringify(tokenized);
  const buf = Buffer.from(text, "utf-8");
  return { text, hash: sha256(buf), size: buf.byteLength };
}

/**
 * pull 시 원격 mcpServers 를 로컬 .claude.json 에 머지한다.
 * - mcpServers 만 원격 기준으로 교체(원격 우선). env 의 시크릿(*_PAT/*_TOKEN/*_SECRET) strip.
 * - mcpServers 외 나머지 키(oauthAccount/userID/projects/numStartups/machineID/임의키)는
 *   byte-identical 보존(deep merge 로 중첩 projects 손실 금지).
 * - 로컬 파싱 실패/부재(null) 시 원격 mcpServers 기반으로 반환.
 * - 원격 content 는 ${HOME} 토큰 공간 → home 인자로 detokenize.
 */
export function mergeClaudeJsonForPull(
  localRaw: string | null,
  remoteContent: string,
  selfNames: string[],
  home = "",
): string {
  let remote: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(remoteContent);
    if (isPlainObject(parsed)) remote = structuredCloneSafe(parsed);
  } catch {
    remote = {};
  }

  // 원격은 ${HOME} 토큰 공간 → 이 머신 home 절대경로로 복원.
  if (home) remote = detokenizeHome(remote, home) as Record<string, unknown>;

  // 원격 mcpServers 에서 self 엔트리 방어적 strip(원격 오염 차단).
  if (isPlainObject(remote.mcpServers)) {
    for (const name of selfNames) {
      delete (remote.mcpServers as Record<string, unknown>)[name];
    }
  }

  // 원격 mcpServers env 의 시크릿 strip.
  const remoteServers = remote.mcpServers;
  if (isPlainObject(remoteServers)) {
    for (const [, serverVal] of Object.entries(remoteServers)) {
      if (!isPlainObject(serverVal)) continue;
      const env = serverVal.env;
      if (!isPlainObject(env)) continue;
      for (const envKey of Object.keys(env)) {
        if (SECRET_ENV_PATTERN.test(envKey)) {
          delete (env as Record<string, unknown>)[envKey];
        }
      }
    }
  }

  let local: Record<string, unknown> | null = null;
  if (localRaw !== null) {
    try {
      const parsed = JSON.parse(localRaw);
      if (isPlainObject(parsed)) local = structuredCloneSafe(parsed);
    } catch {
      local = null;
    }
  }

  // 로컬 파싱 실패/부재: 원격 mcpServers 기반으로 반환.
  if (local === null) {
    const out: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(remote, "mcpServers")) {
      out.mcpServers = remote.mcpServers;
    }
    return stableStringify(out);
  }

  // 로컬의 mcpServers 만 원격 기준으로 교체, 나머지는 로컬 그대로.
  const merged: Record<string, unknown> = structuredCloneSafe(local);
  if (Object.prototype.hasOwnProperty.call(remote, "mcpServers")) {
    merged.mcpServers = remote.mcpServers;
  } else {
    delete merged.mcpServers;
  }

  // 로컬 self 엔트리 보존(로컬 실제 경로·설정 그대로).
  // selfNames 중 실제 로컬에 존재하는 항목만 보존 — 빈 mcpServers 객체 생성 금지.
  if (selfNames.length > 0) {
    const localServers = local.mcpServers;
    if (isPlainObject(localServers)) {
      const selfEntries = selfNames.filter(name =>
        Object.prototype.hasOwnProperty.call(localServers, name),
      );
      if (selfEntries.length > 0) {
        const mergedServers = isPlainObject(merged.mcpServers)
          ? (merged.mcpServers as Record<string, unknown>)
          : ((merged.mcpServers = {}), merged.mcpServers as Record<string, unknown>);
        for (const name of selfEntries) {
          mergedServers[name] = (localServers as Record<string, unknown>)[name];
        }
      }
    }
  }

  return stableStringify(merged);
}

// merged 객체에서 shared 영역을 머지 결과로 치환한다.
// 기존 shared 키는 제거 후 mergedShared 를 덮어 — shared 에서 삭제된 키 반영.
function applyShared(
  target: Record<string, unknown>,
  mergedShared: Record<string, unknown>,
  localShared: Record<string, unknown>,
): void {
  removeShared(target, localShared);
  deepAssign(target, mergedShared);
}

// localShared 에 존재했던 shared 키들을 target 에서 제거(로컬고유키는 건드리지 않음).
function removeShared(
  target: Record<string, unknown>,
  localShared: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(localShared)) {
    if (!Object.prototype.hasOwnProperty.call(target, k)) continue;
    if (isPlainObject(v) && isPlainObject(target[k])) {
      removeShared(target[k] as Record<string, unknown>, v);
      if (Object.keys(target[k] as Record<string, unknown>).length === 0) {
        delete target[k];
      }
    } else {
      delete target[k];
    }
  }
}

// src 의 키를 target 에 깊게 병합(중첩 객체는 재귀, leaf 는 치환).
function deepAssign(
  target: Record<string, unknown>,
  src: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(src)) {
    if (isForbiddenKey(k)) continue;
    if (isPlainObject(v)) {
      if (!isPlainObject(target[k])) target[k] = {};
      deepAssign(target[k] as Record<string, unknown>, v);
    } else {
      target[k] = v;
    }
  }
}
