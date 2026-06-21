// 동시성 락 — 인프로세스 AsyncMutex + 원격 lock.json(best-effort CAS).
// 인프로세스 뮤텍스로 push/pull/resolve 직렬화, 원격 락으로 머신간 직렬화.

import type { Config, LockInfo, MachineId } from "../types.js";
import type { RemoteStore } from "../webdav/client.js";
import { PreconditionFailedError } from "../webdav/client.js";
import type { Logger } from "../types.js";

// acquiredAt 이 현재 시각보다 이만큼(ms) 이상 미래면 손상 락으로 간주해 탈취 허용.
// clock skew 정상 범위를 넘는 미래값은 잘못 기록된 락이다.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** 짧은 비동기 지연. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 인프로세스 비동기 뮤텍스. runExclusive 호출을 큐로 직렬화한다.
 * 한 프로세스 내 push/pull/resolve 가 겹치지 않게 보장.
 */
export class AsyncMutex {
  // 직전 작업의 완료 Promise. 새 작업은 이 꼬리에 붙어 순차 실행.
  private tail: Promise<unknown> = Promise.resolve();

  /** fn 을 배타 실행. 반환은 fn 의 반환. fn 예외는 호출자에게 전파하되 큐는 유지. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // 이전 작업 성공/실패와 무관하게 다음 작업이 이어지도록 catch 로 흡수한 꼬리에 체이닝.
    const run = this.tail.then(() => fn());
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * 원격 lock.json 기반 머신간 락. best-effort CAS.
 * acquire: lock.json 읽어 미만료·타머신이면 재시도 후 false 종료, 비었거나 만료·자기소유면 기록 후 재확인.
 * release: 자기 소유 락만 삭제.
 */
export class RemoteLock {
  private readonly ttlMs: number;
  private readonly acquireRetries: number;
  private readonly acquireRetryDelayMs: number;
  /** 마지막 read() 가 받은 lock.json 의 ETag. 만료 락 탈취 시 putIfMatch CAS 에 사용. */
  private lastLockEtag: string | null = null;

  constructor(
    private readonly remote: RemoteStore,
    private readonly config: Config,
    private readonly machineId: MachineId,
    private readonly logger?: Logger,
  ) {
    this.ttlMs = config.lock.ttlMs;
    this.acquireRetries = config.lock.acquireRetries;
    this.acquireRetryDelayMs = config.lock.acquireRetryDelayMs;
  }

  /** lock.json 경로(<remoteBaseDir>/lock.json). */
  get lockPath(): string {
    return "lock.json";
  }

  /** 현재 원격 락 상태 읽기. 없거나 파싱 실패 시 null. */
  /** 현재 원격 락 상태 읽기. 없거나 파싱 실패 시 null. 마지막 read 의 ETag 도 내부 보관(탈취 CAS 용). */
  async read(): Promise<LockInfo | null> {
    const result = await this.remote.getTextWithETag(this.lockPath);
    if (result === null) {
      this.lastLockEtag = null;
      return null;
    }
    this.lastLockEtag = result.etag;
    try {
      const info = JSON.parse(result.text) as LockInfo;
      if (typeof info.machineId !== "string" || typeof info.acquiredAt !== "number") {
        return null;
      }
      return info;
    } catch {
      // 손상된 락은 없는 것으로 간주 (만료/탈취 처리에 맡김).
      return null;
    }
  }

  /** 락이 만료됐는지 (acquiredAt + ttlMs < now). */
  /**
   * 락이 탈취 가능한 상태인지 (만료 또는 손상).
   * - 정상 만료: acquiredAt + ttlMs <= now.
   * - 손상: acquiredAt 이 now 보다 CLOCK_SKEW_TOLERANCE_MS 이상 미래 → 잘못 기록된 락으로 간주.
   */
  private isExpired(info: LockInfo, now: number): boolean {
    return isLockExpired(info, now, this.ttlMs);
  }

  /**
   * 원격 락 획득 시도. best-effort CAS.
   * - 락 없음/만료/자기소유 → 자기 락 기록 후 짧은 지연 뒤 재확인(다른 머신 동시 기록 검출).
   * - 재확인 결과 자기 소유면 true.
   * - 타머신이 유효 락 보유 → acquireRetryDelayMs 대기 후 재시도, acquireRetries 소진 시 false.
   */
  /**
   * 원격 락 획득 시도. 서버측 조건부 PUT 으로 진짜 상호배제(원자적 CAS).
   * - 락 없음 → putIfNoneMatch(If-None-Match:*): 동시 생성 경쟁에서 한쪽만 성공.
   * - 만료/손상 락 → putIfMatch(If-Match:<etag>): read 시점 ETag 일치할 때만 탈취(다른 머신이 먼저 갱신했으면 실패).
   * - 자기 소유 락 → putIfMatch 로 갱신(재진입/TTL 연장).
   * - 타머신 유효 락 → acquireRetryDelayMs 대기 후 재시도, acquireRetries 소진 시 false.
   * - CAS 패배(PreconditionFailedError) → 다음 시도로 재경쟁.
   * delay 후 사후 read 휴리스틱은 서버측 원자 연산으로 대체되어 불필요해졌다.
   */
  async acquire(): Promise<boolean> {
    const totalAttempts = this.acquireRetries + 1;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const now = Date.now();
      const current = await this.read();

      const isNone = current === null;
      const isOwn = current !== null && current.machineId === this.machineId;
      const isStale = current !== null && this.isExpired(current, now);
      const takeable = isNone || isOwn || isStale;

      if (!takeable) {
        // 타머신이 유효 락 보유 → 대기 후 재시도.
        if (attempt < totalAttempts - 1) {
          this.logger?.debug(
            `remote lock held by ${current.machineId}, retry ${attempt + 1}/${this.acquireRetries}`,
          );
          await delay(this.acquireRetryDelayMs);
          continue;
        }
        this.logger?.warn(
          `remote lock acquire failed: held by ${current.machineId} (not expired)`,
        );
        return false;
      }

      const lock: LockInfo = {
        machineId: this.machineId,
        acquiredAt: now,
        ttlMs: this.ttlMs,
      };
      const payload = JSON.stringify(lock);

      try {
        if (isNone) {
          // 생성 전용 — 동시 생성 경쟁에서 한쪽만 성공.
          await this.remote.putIfNoneMatch(this.lockPath, payload, this.machineId);
        } else {
          // 만료/손상/자기소유 락 탈취·갱신 — read 시 ETag 일치할 때만 성공.
          await this.remote.putIfMatch(this.lockPath, payload, this.lastLockEtag, this.machineId);
        }
        this.logger?.debug("remote lock acquired");
        return true;
      } catch (err) {
        if (err instanceof PreconditionFailedError) {
          // 경쟁 패배(다른 머신이 먼저 생성/갱신) → 다음 시도로 재경쟁.
          if (attempt < totalAttempts - 1) {
            this.logger?.debug(
              `remote lock race lost (CAS), retry ${attempt + 1}/${this.acquireRetries}`,
            );
            await delay(this.acquireRetryDelayMs);
            continue;
          }
          this.logger?.warn("remote lock acquire failed: lost CAS race");
          return false;
        }
        throw err;
      }
    }
    return false;
  }

  /** 자기 소유 락만 해제(deleteFile). 타 소유면 no-op. best-effort. */
  async release(): Promise<void> {
    try {
      const current = await this.read();
      if (current === null) return;
      if (current.machineId !== this.machineId) {
        // 타머신 락 — 건드리지 않음.
        this.logger?.debug(`remote lock release skipped: owned by ${current.machineId}`);
        return;
      }
      await this.remote.deleteFile(this.lockPath);
      this.logger?.debug("remote lock released");
    } catch (err) {
      // best-effort — 해제 실패는 ttl 만료에 맡김.
      this.logger?.warn(`remote lock release failed: ${String((err as Error).message)}`);
    }
  }
}

/**
 * 원격 락 획득→fn 실행→해제를 보장하는 헬퍼.
 * 획득 실패 시 throw, fn 예외 발생해도 finally 에서 release.
 */
export async function withLock<T>(lock: RemoteLock, fn: () => Promise<T>): Promise<T> {
  const acquired = await lock.acquire();
  if (!acquired) {
    throw new Error("failed to acquire remote lock");
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function isLockExpired(info: LockInfo, now: number, defaultTtlMs: number): boolean {
  if (info.acquiredAt > now + CLOCK_SKEW_TOLERANCE_MS) return true;
  const ttl = typeof info.ttlMs === "number" ? info.ttlMs : defaultTtlMs;
  return info.acquiredAt + ttl <= now;
}

export type LockState = "none" | "self" | "expired" | "held" | "corrupt";

export interface LockClassification {
  state: LockState;
  holder?: string;
  ageMs?: number;
}

export function classifyLock(
  raw: string | null,
  now: number,
  selfId: string | null,
  defaultTtlMs: number,
): LockClassification {
  if (raw === null) return { state: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "corrupt" };
  }
  const o = parsed as { machineId?: unknown; acquiredAt?: unknown };
  if (typeof o.machineId !== "string" || typeof o.acquiredAt !== "number") {
    return { state: "corrupt" };
  }
  const info = parsed as LockInfo;
  const ageMs = now - info.acquiredAt;
  if (info.acquiredAt > now + CLOCK_SKEW_TOLERANCE_MS) {
    return { state: "corrupt", holder: info.machineId, ageMs };
  }
  if (isLockExpired(info, now, defaultTtlMs)) {
    return { state: "expired", holder: info.machineId, ageMs };
  }
  if (selfId !== null && info.machineId === selfId) {
    return { state: "self", holder: info.machineId, ageMs };
  }
  return { state: "held", holder: info.machineId, ageMs };
}
