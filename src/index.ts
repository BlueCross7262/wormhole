// 부트스트랩 진입점 — config 로드 → 자격/원격/엔진 조립 → MCP 툴 등록 →
// 시작 시 pull(best-effort) → autoSync(설정 시) → StdioServerTransport connect.
// stdout 은 MCP 전송 전용 — 모든 로깅은 stderr(logger) 경유.

import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { logger } from "./logger.js";
import { registerAllTools } from "./tools/index.js";
import { AutoSync } from "./watcher/auto-sync.js";
import { buildEngine } from "./bootstrap.js";
import { SingleInstanceLock } from "./daemon/single-instance.js";


async function main(): Promise<void> {
  // 1~6) 공유 부트스트랩으로 config·자격·원격·crypto·엔진을 조립.
  const { engine, config } = await buildEngine(logger);

  // 7) MCP 서버 + 툴 등록.
  const server = new McpServer({ name: "wormhole", version: "0.1.0" });
  registerAllTools(server, engine);

  // 8) autoSync 설정.
  //    주의(watcher 수명 한계): 이 watcher 는 MCP stdio 프로세스(=Claude Code 세션)에 종속된다.
  //    세션 종료 시 watcher 도 죽으므로 상시 데몬이 아니다. 오프라인 변경은 다음 기동의 startup pull
  //    또는 수동 sync_push 로 보정한다(README 참고).
  let autoSync: AutoSync | null = null;
  if (config.autoSync.enabled) {
    // 상시 데몬이 연속 동기화를 소유 중이면 MCP watcher 를 띄우지 않는다(이중 watch 방지).
    const daemonLock = new SingleInstanceLock(path.join(config.stateDir, "daemon.lock"));
    if (await daemonLock.isHeld()) {
      logger.warn("데몬이 연속 동기화를 소유 중 — MCP watcher 생략, 시작 pull 만 수행");
      try {
        const result = await engine.pull();
        logger.info(
          `시작 pull 완료: applied=${result.applied.length} removed=${result.removed.length} conflicts=${result.conflicts.length}`,
        );
      } catch (err) {
        logger.warn(`시작 pull 실패(무시하고 계속): ${String((err as Error).message)}`);
      }
    } else {
      autoSync = new AutoSync(engine, config, logger);
      await autoSync.start(); // start() 내부에서 startup pull 1회 수행.
      logger.info("autoSync 시작됨(기동 pull 포함)");
    }
  } else {
    // autoSync 비활성 시에는 여기서 기동 pull 을 1회 수행한다(중복 pull 방지).
    try {
      const result = await engine.pull();
      logger.info(
        `시작 pull 완료: applied=${result.applied.length} removed=${result.removed.length} conflicts=${result.conflicts.length}`,
      );
    } catch (err) {
      logger.warn(`시작 pull 실패(무시하고 계속): ${String((err as Error).message)}`);
    }
  }

  // 9) graceful shutdown — autoSync.stop + 진행 작업 정리 후 종료.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} 수신 — 종료 중`);
    try {
      if (autoSync) await autoSync.stop();
      await server.close();
    } catch (err) {
      logger.error(`종료 정리 중 오류: ${String((err as Error).message)}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 10) stdio 전송 연결.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP 서버 연결됨 (stdio)");
}

main().catch((err) => {
  logger.error(`치명적 부트스트랩 오류: ${String((err as Error).stack ?? (err as Error).message)}`);
  process.exit(1);
});
