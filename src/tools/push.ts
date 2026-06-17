import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import { jobManager } from "../jobs/job-manager.js";

export function registerPushTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "sync_push",
    {
      title: "Sync Push",
      description:
        "로컬 변경사항을 원격으로 push 한다. dryRun=true 시 계획만 반환(변경 없음). async=true 시 백그라운드 실행 후 jobId 반환(sync_status 로 폴링).",
      inputSchema: {
        dryRun: z.boolean().optional().default(false),
        async: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        // async=true 이고 dryRun 이 아니면 백그라운드 job 으로 실행(stdio 비블로킹).
        if (args.async && !args.dryRun) {
          const job = jobManager.start("push", () => engine.push({ dryRun: false }));
          const out = { jobId: job.jobId, accepted: true, status: job.status };
          return {
            content: [{ type: "text", text: JSON.stringify(out) }],
            structuredContent: out as unknown as Record<string, unknown>,
          } as CallToolResult;
        }
        const result = await engine.push({ dryRun: args.dryRun });
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
