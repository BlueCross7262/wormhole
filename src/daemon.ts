// 헤드리스 데몬 진입점 — config 로드 → 자격/원격/엔진 조립 → 단일 인스턴스 락 +
// 연속 동기화(autoSync forceEnabled) 가동. MCP stdio 세션과 무관한 상시 프로세스.
// stdout 미사용 — 모든 로깅은 stderr(logger) 경유. supervisor 가 종료 시 재기동.

import path from "node:path";

import { logger } from "./logger.js";
import { buildEngine } from "./bootstrap.js";
import { SingleInstanceLock } from "./daemon/single-instance.js";
import { AutoSync } from "./watcher/auto-sync.js";
import { createDaemon } from "./daemon/runner.js";

async function main(): Promise<void> {
  // 1) 공유 부트스트랩으로 config·자격·원격·crypto·엔진 조립.
  //    passphrase/원격 오류 시 buildEngine 이 reject → 프로세스 비정상 종료(supervisor backoff).
  const { engine, config } = await buildEngine(logger);

  // 2) 단일 인스턴스 락 + 연속 동기화(forceEnabled: config.autoSync.enabled 무관 강제 가동).
  const lock = new SingleInstanceLock(path.join(config.stateDir, "daemon.lock"), { logger });
  const autoSync = new AutoSync(engine, config, logger, { forceEnabled: true });
  const daemon = createDaemon({ autoSync, lock, logger });

  // 3) 데몬 기동. 락 점유(다른 인스턴스 가동 중)면 throw → 비정상 종료로 supervisor 에 신호.
  try {
    await daemon.start();
  } catch (err) {
    logger.error(`데몬 시작 실패: ${String((err as Error).message)}`);
    process.exit(1);
  }
  logger.info("데몬 가동됨 — 연속 동기화 + 단일 인스턴스 락 보유");

  // 4) graceful shutdown — autoSync 정지 + 락 해제 후 종료.
  //    watcher 치명 오류는 AutoSync 가 로깅한다(watcher error 이벤트). v1 에서는
  //    프로세스가 죽으면 supervisor 가 재기동하는 단순 모델을 채택한다.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} 수신 — 종료 중`);
    try {
      await daemon.shutdown();
    } catch (err) {
      logger.error(`종료 정리 중 오류: ${String((err as Error).message)}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(`치명적 부트스트랩 오류: ${String((err as Error).stack ?? (err as Error).message)}`);
  process.exit(1);
});
