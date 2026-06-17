// 데몬 팩토리 — import 시 부수효과 없음(process.exit/시그널 핸들러 없음).
// 테스트 가능한 순수 로직만 보유한다. 진입점(daemon.ts)이 시그널·exit 를 담당.

import type { Logger } from "../types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface DaemonDeps {
  autoSync: { start(): Promise<void>; stop(): Promise<void> };
  lock: {
    acquire(): Promise<boolean>;
    heartbeat(): Promise<void>;
    release(): Promise<void>;
  };
  logger?: Logger;
  heartbeatIntervalMs?: number;
}

export interface Daemon {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createDaemon(deps: DaemonDeps): Daemon {
  const { autoSync, lock, logger } = deps;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function start(): Promise<void> {
    // 1) 단일 인스턴스 락 획득. 실패 시 throw(진입점이 exit 처리).
    const acquired = await lock.acquire();
    if (!acquired) {
      throw new Error("another daemon instance is already running");
    }

    // 2) heartbeat 스케줄 시작. 락 TTL 갱신으로 stale 판정 방지.
    heartbeatTimer = setInterval(() => {
      void lock.heartbeat().catch((err) => {
        logger?.error(`[daemon] heartbeat 실패: ${String((err as Error).message)}`);
      });
    }, heartbeatIntervalMs);

    // 3) 연속 동기화 시작(watcher + 주기 pull).
    await autoSync.start();
    logger?.info("[daemon] started — 락 보유, 연속 동기화 가동");
  }

  async function shutdown(): Promise<void> {
    // 멱등성: 두 번째 호출 이후는 안전한 no-op.
    if (stopped) return;
    stopped = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    // 순서: autoSync 정지 → 락 해제.
    await autoSync.stop();
    await lock.release();
    logger?.info("[daemon] stopped — 동기화 정지, 락 해제");
  }

  return { start, shutdown };
}
