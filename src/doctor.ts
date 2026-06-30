// wormhole-doctor — 읽기 전용 환경 진단. 부작용 없음(원격 쓰기/업로드 금지).
// buildEngine 과 동일한 의존 단계를 재사용하되, 각 단계를 try/catch 로 tolerant 하게
// 돌려 첫 실패에 throw 하지 않고 모든 체크 결과를 수집한다.
//
// 6 체크: (1)config (2)WebDAV 연결·인증 (3)passphrase 소스 (4)passphrase↔vault 정합
//         (5)vault 상태 (6)transport 보안.
//
// 읽기전용 불변식: keyparams 가 원격에 없을 때 ensureCryptoReady 를 호출하면 putAtomic 으로
// keyparams 가 업로드된다(부작용). 따라서 정합 검증은 keyparams 존재 시에만 sentinel
// 복호 로직을 직접 재현한다(deriveAgeIdentity → initWithIdentity → decryptToString).

import * as nodePath from "node:path";
import { loadConfig } from "./config.js";
import { RemoteStore, classifyEtag } from "./webdav/client.js";
import { AgeCrypto } from "./crypto/age.js";
import { resolvePassphrase } from "./crypto/passphrase.js";
import {
  KEYPARAMS_REMOTE,
  KeyParamsSchema,
  SENTINEL_PLAINTEXT,
} from "./crypto/keyparams.js";
import { deriveAgeIdentity } from "./crypto/kdf.js";
import { ManifestStore } from "./sync/manifest.js";
import { classifyLock } from "./sync/lock.js";
import { readMachineIdIfExists } from "./sync/machine.js";
import type { Config, MachineId, Logger } from "./types.js";
import { VERSION } from "./version.js";

export type DoctorStatus = "ok" | "fail" | "warn";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  version: string;
  checks: DoctorCheck[];
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

function isPlaintextHttp(url: string): boolean {
  return (
    /^http:\/\//i.test(url) &&
    !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)
  );
}

export async function runDoctor(logger: Logger): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 단계 간 산출물 보존(후속 체크 재사용). 선행 실패 시 null 로 남아 후속이 skip 한다.
  let config: Config | null = null;
  let remote: RemoteStore | null = null;
  let keyparamsRaw: string | null = null;
  let keyparamsEtag: string | null = null;
  let keyparamsFetched = false;
  let passphrase: string | null = null;
  let crypto: AgeCrypto | null = null;
  let selfId: MachineId | null = null;

  // ── Check 1: config 파일 ────────────────────────────────────────────
  try {
    config = await loadConfig();
    const pwWarn = config.remote.password === "";
    checks.push({
      name: "config 파일",
      status: pwWarn ? "warn" : "ok",
      detail: pwWarn
        ? `config.json/.env 로드 통과, 그러나 WEBDAV_PASS 가 비어 있음(익명 접근 또는 401 위험). remote.url=${config.remote.url}`
        : `config.json+.env 로드, 스키마 검증 통과. remote.url=${config.remote.url}`,
    });
  } catch (err) {
    checks.push({
      name: "config 파일",
      status: "fail",
      detail: (err as Error).message,
    });
  }

  // ── Check 11: include 글로브 절대경로 리터럴 ────────────────────────
  // home-prefix(C:/Users/x, /home/x, /Users/x) 및 비-home 절대경로(/usr, C:/Program Files)
  // 포함 시 타 머신 이주 불가 위험.
  if (config !== null) {
    const ABS_RE = /^([A-Za-z]:[/\\]|\/)/;
    const foundAbs = config.targets.include.filter((g) => ABS_RE.test(g));
    if (foundAbs.length > 0) {
      checks.push({
        name: "include 절대경로 리터럴",
        status: "warn",
        detail: `include 글로브에 절대경로 리터럴 발견 — 이주 불가/타 머신 호환 불가 위험: ${foundAbs.join(", ")}`,
      });
    } else {
      checks.push({
        name: "include 절대경로 리터럴",
        status: "ok",
        detail: "include 글로브에 절대경로 없음",
      });
    }
  }

  // ── Check 12: stateDir 동기화 범위 유출 ─────────────────────────────
  // stateDir 하위 파일(암호키·락·state.json 등)이 include 글로브에 매칭되면
  // 암호 자재가 원격으로 유출될 위험.
  if (config !== null) {
    const stateDirRel = nodePath.relative(config.home, config.stateDir).replace(/\\/g, "/");
    const stateDirLeaks = config.targets.include.filter((g) => {
      const gg = g.replace(/\\/g, "/");
      return gg.startsWith(stateDirRel + "/") || gg === stateDirRel || gg.startsWith(stateDirRel + "/**");
    });
    if (stateDirLeaks.length > 0) {
      checks.push({
        name: "stateDir 동기화 유출",
        status: "warn",
        detail: `stateDir(${stateDirRel}) 하위가 include 글로브에 포함 — 암호키·상태파일 유출 위험: ${stateDirLeaks.join(", ")}`,
      });
    } else {
      checks.push({
        name: "stateDir 동기화 유출",
        status: "ok",
        detail: `stateDir(${stateDirRel}) 이 include 범위 밖 — 암호 자재 유출 없음`,
      });
    }
  }

  // ── Check 13: include 시크릿 패턴(*_PAT/*_TOKEN/*_SECRET) ───────────
  // shared 동기화 대상에 토큰/시크릿 패턴 글로브가 포함되면 유출 위험.
  if (config !== null) {
    const SECRET_RE = /(_PAT|_TOKEN|_SECRET)(\b|$|\*)/i;
    const secretGlobs = config.targets.include.filter((g) => SECRET_RE.test(g));
    if (secretGlobs.length > 0) {
      checks.push({
        name: "include 시크릿 패턴",
        status: "warn",
        detail: `include 에 *_PAT/*_TOKEN/*_SECRET 패턴 발견 — 토큰·시크릿 파일 유출 위험: ${secretGlobs.join(", ")}`,
      });
    } else {
      checks.push({
        name: "include 시크릿 패턴",
        status: "ok",
        detail: "include 에 시크릿 패턴(*_PAT/*_TOKEN/*_SECRET) 없음",
      });
    }
  }

  // ── Check 2: WebDAV 연결·인증(PROPFIND, 401/200) ────────────────────
  if (config === null) {
    checks.push({
      name: "WebDAV 연결·인증",
      status: "fail",
      detail: "선행 체크(config) 실패로 스킵",
    });
  } else {
    try {
      remote = new RemoteStore(config.remote, logger);
      const kp = await remote.getTextWithETag(KEYPARAMS_REMOTE);
      keyparamsRaw = kp?.text ?? null;
      keyparamsEtag = kp?.etag ?? null;
      keyparamsFetched = true;
      selfId = await readMachineIdIfExists(config.stateDir);
      checks.push({
        name: "WebDAV 연결·인증",
        status: "ok",
        detail: "PROPFIND/GET 성공 — 연결·인증 정상",
      });
    } catch (err) {
      const code = statusOf(err);
      const detail =
        code === 401
          ? "인증 실패(401) — WEBDAV_USER/WEBDAV_PASS 를 확인하라"
          : `연결 실패: ${(err as Error).message}`;
      checks.push({ name: "WebDAV 연결·인증", status: "fail", detail });
    }
  }

  // ── Check 3: passphrase 소스(env → 파일 → keychain) ─────────────────
  if (config === null) {
    checks.push({
      name: "passphrase 소스",
      status: "fail",
      detail: "선행 체크(config) 실패로 스킵",
    });
  } else {
    try {
      const res = await resolvePassphrase(
        {
          env: config.crypto.passphraseEnv,
          file: config.crypto.passphraseFile,
          keychainService: config.crypto.keychainService,
        },
        logger,
      );
      passphrase = res.passphrase; // 원문은 detail 에 절대 노출하지 않는다.
      checks.push({
        name: "passphrase 소스",
        status: "ok",
        detail: `passphrase 소스: ${res.source}`,
      });
    } catch (err) {
      checks.push({
        name: "passphrase 소스",
        status: "fail",
        detail: (err as Error).message,
      });
    }
  }

  // ── Check 4: passphrase↔vault 정합(sentinel 복호) ───────────────────
  // 읽기전용: keyparams 존재 시에만 sentinel 검증을 직접 재현. 빈 vault 면 검증 대상 없음 → warn.
  if (config === null || !keyparamsFetched || passphrase === null) {
    checks.push({
      name: "passphrase↔vault 정합",
      status: "fail",
      detail: "선행 체크(config/연결/passphrase) 실패로 스킵",
    });
  } else if (keyparamsRaw === null) {
    checks.push({
      name: "passphrase↔vault 정합",
      status: "warn",
      detail:
        "원격 vault 미초기화(keyparams 없음) — 첫 push 시 이 passphrase 가 vault 표준이 됨",
    });
  } else {
    try {
      const parsed = KeyParamsSchema.parse(JSON.parse(keyparamsRaw));
      const identity = deriveAgeIdentity(passphrase, parsed.saltB64, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
      });
      const c = new AgeCrypto(logger);
      await c.initWithIdentity(identity, config.crypto.derivedKeyPath);
      const decoded = await c.decryptToString(parsed.sentinel);
      if (decoded !== SENTINEL_PLAINTEXT) {
        throw new Error("sentinel 평문 불일치");
      }
      crypto = c; // Check5 의 manifest 복호에 재사용.
      checks.push({
        name: "passphrase↔vault 정합",
        status: "ok",
        detail: "sentinel 복호 성공 — passphrase 가 vault 와 일치",
      });
    } catch (err) {
      checks.push({
        name: "passphrase↔vault 정합",
        status: "fail",
        detail: `passphrase 불일치 — 다른 기기와 동일 passphrase 인지 확인하라 (${(err as Error).message})`,
      });
    }
  }

  // ── Check 5: vault 상태(keyparams/manifest, manifestGeneration) ─────
  if (config === null || remote === null || !keyparamsFetched) {
    checks.push({
      name: "vault 상태",
      status: "fail",
      detail: "선행 체크(config/연결) 실패로 스킵",
    });
  } else if (keyparamsRaw === null) {
    checks.push({
      name: "vault 상태",
      status: "warn",
      detail: "vault 미초기화 — keyparams/manifest 없음(아직 push 안 됨)",
    });
  } else if (crypto === null) {
    // keyparams 는 있으나 passphrase 불일치 등으로 복호 키 미준비 → manifest 복호 불가.
    checks.push({
      name: "vault 상태",
      status: "warn",
      detail: "keyparams 존재하나 복호 키 미준비(passphrase 불일치) — manifestGeneration 미확인",
    });
  } else {
    try {
      const manifest = await new ManifestStore(remote, crypto, config).read();
      if (manifest === null) {
        checks.push({
          name: "vault 상태",
          status: "warn",
          detail: "keyparams 존재, manifest 없음(아직 push 안 됨)",
        });
      } else {
        checks.push({
          name: "vault 상태",
          status: "ok",
          detail: `manifestGeneration=${manifest.manifestGeneration}, entries=${Object.keys(manifest.entries).length}`,
        });
      }
    } catch (err) {
      checks.push({
        name: "vault 상태",
        status: "fail",
        detail: `manifest 읽기 실패: ${(err as Error).message}`,
      });
    }
  }

  // ── Check 6: transport 보안(평문 http) ──────────────────────────────
  if (config === null) {
    checks.push({
      name: "transport 보안",
      status: "fail",
      detail: "선행 체크(config) 실패로 스킵",
    });
  } else if (isPlaintextHttp(config.remote.url)) {
    checks.push({
      name: "transport 보안",
      status: "warn",
      detail:
        "평문 http — Tailscale 등 암호화 전송이 아니면 자격증명·메타데이터 노출 위험. https 권장",
    });
  } else {
    checks.push({
      name: "transport 보안",
      status: "ok",
      detail: "https 또는 localhost — 전송 보안 양호",
    });
  }

  // ── Check 7: CAS/ETag 능력 ──────────────────────────────────────────
  if (config === null || !keyparamsFetched) {
    checks.push({
      name: "CAS/ETag 능력",
      status: "warn",
      detail: "선행 체크 실패로 미검증",
    });
  } else if (keyparamsRaw === null) {
    checks.push({
      name: "CAS/ETag 능력",
      status: "warn",
      detail: "원격 vault 미초기화 — CAS 능력 미검증. 최초 push 후 재실행",
    });
  } else {
    const strength = classifyEtag(keyparamsEtag);
    if (strength === "strong") {
      checks.push({
        name: "CAS/ETag 능력",
        status: "ok",
        detail: "강한 ETag — 조건부 PUT(CAS) 신뢰 가능",
      });
    } else if (strength === "weak") {
      checks.push({
        name: "CAS/ETag 능력",
        status: "warn",
        detail: "약한 ETag(W/) — If-Match 강비교 실패 위험(가짜충돌·락소실). 서버 ETag 정책 확인",
      });
    } else {
      checks.push({
        name: "CAS/ETag 능력",
        status: "warn",
        detail: "GET 응답에 ETag 없음 — If-Match CAS 가능 여부 불확실. 서버 ETag 정책 확인",
      });
    }
  }

  // ── Check 8: 원격 락 상태 ───────────────────────────────────────────
  if (config === null || remote === null || !keyparamsFetched) {
    checks.push({
      name: "원격 락 상태",
      status: "warn",
      detail: "선행 체크 실패로 미검증",
    });
  } else {
    try {
      const lr = await remote.getTextWithETag("lock.json");
      const cls = classifyLock(lr?.text ?? null, Date.now(), selfId, config.lock.ttlMs);
      if (cls.state === "none") {
        checks.push({ name: "원격 락 상태", status: "ok", detail: "원격 락 없음" });
      } else if (cls.state === "self") {
        checks.push({ name: "원격 락 상태", status: "ok", detail: "자기 소유 락(정상)" });
      } else if (cls.state === "expired") {
        checks.push({
          name: "원격 락 상태",
          status: "ok",
          detail: "만료 락 — 다음 sync 가 탈취(정상)",
        });
      } else if (cls.state === "held") {
        checks.push({
          name: "원격 락 상태",
          status: "warn",
          detail: `타 머신 ${cls.holder?.slice(0, 8)} 락 보유, ${cls.ageMs}ms 경과 — 진행중이거나 stale`,
        });
      } else {
        checks.push({
          name: "원격 락 상태",
          status: "warn",
          detail: "lock.json 손상/미래시각 — 무시됨",
        });
      }
    } catch {
      checks.push({
        name: "원격 락 상태",
        status: "warn",
        detail: "lock.json 읽기 실패 — 무시됨",
      });
    }
  }

  // ── Check 9: machine-id ──────────────────────────────────────────────
  if (config === null) {
    checks.push({
      name: "machine-id",
      status: "warn",
      detail: "선행 체크 실패로 미검증",
    });
  } else if (selfId !== null) {
    checks.push({
      name: "machine-id",
      status: "ok",
      detail: `machine-id: ${selfId.slice(0, 8)}`,
    });
  } else {
    checks.push({
      name: "machine-id",
      status: "warn",
      detail: "machine-id 없음 — 아직 sync 전(첫 작업 시 생성)",
    });
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { ok, version: VERSION, checks };
}
