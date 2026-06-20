import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";

// 전용 dry-run 도구 — push/pull 을 실제 변경 없이 계획만 계산한다.
// (wormhole_push/wormhole_pull 의 confirm 미리보기와 기능 동일하나, "먼저 미리보기" UX 를 명시적으로 유도)
export function registerDryRunTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_dry_run",
    {
      title: "Wormhole Dry Run",
      description: "push 또는 pull 을 실제 변경 없이 계획만 계산해 반환한다(데이터 변경 없음).",
      inputSchema: {
        direction: z.enum(["push", "pull"]),
      },
    },
    async (args, _extra) => {
      try {
        const result =
          args.direction === "push"
            ? await engine.push({ dryRun: true })
            : await engine.pull({ dryRun: true });
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
