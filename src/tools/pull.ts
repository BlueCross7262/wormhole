import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import { jobManager } from "../jobs/job-manager.js";

export function registerPullTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "sync_pull",
    {
      title: "Sync Pull",
      description:
        "원격 변경사항을 로컬로 pull 한다. dryRun=true 시 계획만 반환(변경 없음). async=true 시 백그라운드 실행 후 jobId 반환(sync_status 로 폴링).",
      inputSchema: {
        dryRun: z.boolean().optional().default(false),
        async: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        if (args.async && !args.dryRun) {
          const job = jobManager.start("pull", () => engine.pull({ dryRun: false }));
          const out = { jobId: job.jobId, accepted: true, status: job.status };
          return {
            content: [{ type: "text", text: JSON.stringify(out) }],
            structuredContent: out as unknown as Record<string, unknown>,
          } as CallToolResult;
        }
        const result = await engine.pull({ dryRun: args.dryRun });
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
