// 부트스트랩 진입점 — config 로드 → 자격/원격/엔진 조립 → MCP 툴 등록 →
// StdioServerTransport connect. 기동 시 자율적 로컬 변경(pull) 없음.
// stdout 은 MCP 전송 전용 — 모든 로깅은 stderr(logger) 경유.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { logger } from "./logger.js";
import { registerAllTools } from "./tools/index.js";
import { buildEngine } from "./bootstrap.js";


async function main(): Promise<void> {
  // 1~6) 공유 부트스트랩으로 config·자격·원격·crypto·엔진을 조립.
  const { engine } = await buildEngine(logger);

  // 7) MCP 서버 + 툴 등록.
  const server = new McpServer({ name: "wormhole", version: "0.3.0" });
  registerAllTools(server, engine);

  // 8) graceful shutdown — 진행 작업 정리 후 종료.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} 수신 — 종료 중`);
    try {
      await server.close();
    } catch (err) {
      logger.error(`종료 정리 중 오류: ${String((err as Error).message)}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 9) stdio 전송 연결.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP 서버 연결됨 (stdio)");
}

main().catch((err) => {
  logger.error(`치명적 부트스트랩 오류: ${String((err as Error).stack ?? (err as Error).message)}`);
  process.exit(1);
});
