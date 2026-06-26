import * as path from "node:path";
import * as os from "node:os";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { open as fsOpen, rename as fsRename } from "node:fs/promises";
import type { Logger } from "./types.js";

export type MigrationResult =
  | { migrated: true; from: string; to: string }
  | { migrated: false; reason: string; detail?: string };

let tmpSeq = 0;

function isAbsoluteNonTilde(s: string): boolean {
  if (!s || s.startsWith("~/") || s === "~") return false;
  return path.isAbsolute(s);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const ba = b as unknown[];
    if (aa.length !== ba.length) return false;
    return aa.every((v, i) => deepEqual(v, ba[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length || ak.join("\0") !== bk.join("\0")) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

function normalizeForComparison(
  obj: Record<string, unknown>,
  selfEntry: string,
): Record<string, unknown> {
  const result = { ...obj };
  if (typeof result.targets === "object" && result.targets !== null) {
    const t = { ...(result.targets as Record<string, unknown>) };
    if (Array.isArray(t.include)) {
      const filtered = (t.include as string[]).filter((e) => e !== selfEntry);
      if (filtered.length > 0) {
        t.include = filtered;
      } else {
        delete t.include;
      }
    }
    if (Object.keys(t).length === 0) {
      delete result.targets;
    } else {
      result.targets = t;
    }
  }
  return result;
}

function checkPortability(
  raw: Record<string, unknown>,
): { ok: true } | { ok: false; detail: string } {
  const remote = raw.remote as Record<string, unknown> | undefined;
  if (typeof remote?.password === "string" && remote.password.length > 0) {
    return { ok: false, detail: "remote.password 인라인 값 존재" };
  }
  const crypto = raw.crypto as Record<string, unknown> | undefined;
  if (typeof crypto?.passphraseFile === "string" && crypto.passphraseFile.length > 0) {
    if (path.isAbsolute(crypto.passphraseFile)) {
      return { ok: false, detail: "crypto.passphraseFile 절대경로" };
    }
  }
  if (typeof crypto?.derivedKeyPath === "string" && crypto.derivedKeyPath.length > 0) {
    if (path.isAbsolute(crypto.derivedKeyPath)) {
      return { ok: false, detail: "crypto.derivedKeyPath 절대경로" };
    }
  }
  if (typeof raw.stateDir === "string" && isAbsoluteNonTilde(raw.stateDir)) {
    return { ok: false, detail: "stateDir 절대경로(비틸드)" };
  }
  if ("home" in raw) {
    return { ok: false, detail: "top-level home 키" };
  }
  return { ok: true };
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.wh-tmp.${process.pid}.${Date.now()}.${tmpSeq++}`);
  const fh = await fsOpen(tmp, "w", 0o600);
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsRename(tmp, filePath);
}

async function atomicWriteBuffer(filePath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.wh-tmp.${process.pid}.${Date.now()}.${tmpSeq++}`);
  const fh = await fsOpen(tmp, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsRename(tmp, filePath);
}

export async function upsertDotEnvKey(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  const dir = path.dirname(envPath);
  mkdirSync(dir, { recursive: true });

  if (!existsSync(envPath)) {
    await atomicWriteUtf8(envPath, `${key}=${value}\n`);
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // best-effort
    }
    return;
  }

  let raw = readFileSync(envPath, "utf-8");
  if (raw.startsWith("﻿")) raw = raw.slice(1);

  const lines = raw.split(/\r?\n/);

  function parseKeyLine(line: string): { isKey: boolean; parsedValue?: string } {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return { isKey: false };
    const eq = t.indexOf("=");
    if (eq === -1) return { isKey: false };
    const k = t.slice(0, eq).trim();
    if (k !== key) return { isKey: false };
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2) {
      const f = v[0];
      const l = v[v.length - 1];
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) v = v.slice(1, -1);
    }
    return { isKey: true, parsedValue: v };
  }

  let firstIdx = -1;
  let firstVal: string | undefined;
  let matchCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const { isKey, parsedValue } = parseKeyLine(lines[i]);
    if (isKey) {
      matchCount++;
      if (firstIdx === -1) {
        firstIdx = i;
        firstVal = parsedValue;
      }
    }
  }

  if (firstIdx === -1) {
    const needsNewline = raw.length > 0 && !raw.endsWith("\n");
    const newContent = (needsNewline ? raw + "\n" : raw) + `${key}=${value}\n`;
    await atomicWriteUtf8(envPath, newContent);
    try {
      chmodSync(envPath, 0o600);
    } catch {}
    return;
  }

  if (firstVal === value && matchCount <= 1) return;

  let first = true;
  const out: string[] = [];
  for (const line of lines) {
    const { isKey } = parseKeyLine(line);
    if (isKey) {
      if (first) {
        out.push(`${key}=${value}`);
        first = false;
      }
    } else {
      out.push(line);
    }
  }
  let newContent = out.join("\n");
  if (!newContent.endsWith("\n")) newContent += "\n";
  await atomicWriteUtf8(envPath, newContent);
  try {
    chmodSync(envPath, 0o600);
  } catch {}
}

export async function maybeMigrateLegacyConfig(
  opts?: { home?: string; logger?: Logger },
): Promise<MigrationResult> {
  const home = opts?.home ?? os.homedir();
  const log = opts?.logger;

  const LEGACY = path.join(home, ".wormhole", "config.json");
  const NEW = path.join(home, ".claude", "wormhole-config.json");
  const ENVPATH = path.join(home, ".wormhole", ".env");
  const SELF_ENTRY = ".claude/wormhole-config.json";

  if (!existsSync(LEGACY)) return { migrated: false, reason: "no-legacy" };

  let legacyObj: Record<string, unknown>;
  try {
    legacyObj = JSON.parse(readFileSync(LEGACY, "utf-8")) as Record<string, unknown>;
  } catch {
    log?.warn("[wormhole] 레거시 config.json 파싱 실패 — 마이그레이션 건너뜀");
    return { migrated: false, reason: "legacy-parse-failed" };
  }

  const portCheck = checkPortability(legacyObj);
  if (!portCheck.ok) {
    log?.warn(`[wormhole] 이식성 거부 (${portCheck.detail})`);
    return { migrated: false, reason: "portability-reject", detail: portCheck.detail };
  }

  let needsCopy = true;
  if (existsSync(NEW)) {
    let newObj: Record<string, unknown>;
    try {
      newObj = JSON.parse(readFileSync(NEW, "utf-8")) as Record<string, unknown>;
    } catch {
      log?.warn("[wormhole] ~/.claude/wormhole-config.json 파싱 실패 — 수동 조정 필요");
      return { migrated: false, reason: "target-exists-divergent" };
    }
    const legNorm = normalizeForComparison(legacyObj, SELF_ENTRY);
    const newNorm = normalizeForComparison(newObj, SELF_ENTRY);
    if (deepEqual(legNorm, newNorm)) {
      needsCopy = false;
    } else {
      log?.warn("[wormhole] ~/.claude/wormhole-config.json 이 레거시와 다름 — 수동 조정 필요");
      return { migrated: false, reason: "target-exists-divergent" };
    }
  }

  try {
    mkdirSync(path.join(home, ".claude"), { recursive: true });

    if (needsCopy) {
      await atomicWriteBuffer(NEW, readFileSync(LEGACY));
    }

    let newObj = JSON.parse(readFileSync(NEW, "utf-8")) as Record<string, unknown>;
    const targets = (
      typeof newObj.targets === "object" && newObj.targets !== null ? newObj.targets : {}
    ) as Record<string, unknown>;
    const include = Array.isArray(targets.include) ? (targets.include as string[]) : [];
    if (!include.includes(SELF_ENTRY)) {
      targets.include = [...include, SELF_ENTRY];
      newObj = { ...newObj, targets };
      await atomicWriteUtf8(NEW, JSON.stringify(newObj, null, 2) + "\n");
    }

    const newFwd = NEW.replace(/\\/g, "/");
    await upsertDotEnvKey(ENVPATH, "WORMHOLE_CONFIG", newFwd);

    const verifyObj = JSON.parse(readFileSync(NEW, "utf-8")) as Record<string, unknown>;
    const vt = (
      typeof verifyObj.targets === "object" && verifyObj.targets !== null
        ? verifyObj.targets
        : {}
    ) as Record<string, unknown>;
    const vInc = Array.isArray(vt.include) ? (vt.include as string[]) : [];
    const envContent = readFileSync(ENVPATH, "utf-8");
    const envOk = envContent
      .split(/\r?\n/)
      .some((l) => l.trim() === `WORMHOLE_CONFIG=${newFwd}`);

    if (!vInc.includes(SELF_ENTRY) || !envOk) {
      log?.warn("[wormhole] 마이그레이션 검증 실패 — 레거시 보존");
      return { migrated: false, reason: "verify-failed" };
    }

    unlinkSync(LEGACY);
    process.env["WORMHOLE_CONFIG"] = newFwd;
    log?.info(`[wormhole] 레거시 config 마이그레이션 완료: ${LEGACY} → ${NEW}`);
    return { migrated: true, from: LEGACY, to: NEW };
  } catch (err) {
    log?.warn(`[wormhole] 마이그레이션 오류: ${String(err)}`);
    return { migrated: false, reason: "migration-error" };
  }
}
