import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";

export function registerStatusTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_status",
    {
      title: "Wormhole Status",
      description:
        "현재 동기화 상태를 조회한다(읽기 전용, 변경 없음). 로컬/원격 diff·충돌·집계를 반환.",
      inputSchema: {},
    },
    async (_args, _extra) => {
      try {
        const result = await engine.status();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        } as CallToolResult;
      } catch (err) {
        return {
          content: [{ type: "text", text: String((err as Error).message) }],
          isError: true,
        } as CallToolResult;
      }
    },
  );
}
