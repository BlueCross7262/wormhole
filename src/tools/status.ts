import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import { jobManager } from "../jobs/job-manager.js";

export function registerStatusTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "sync_status",
    {
      title: "Sync Status",
      description:
        "현재 동기화 상태를 조회한다. jobId 를 주면 해당 async job 의 상태를, 없으면 로컬/원격 diff·충돌·집계를 반환.",
      inputSchema: {
        jobId: z.string().optional(),
      },
    },
    async (args, _extra) => {
      try {
        if (args.jobId) {
          const job = jobManager.get(args.jobId);
          if (job === null) {
            return {
              content: [{ type: "text", text: `job 없음: ${args.jobId}` }],
              isError: true,
            } as CallToolResult;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(job) }],
            structuredContent: job as unknown as Record<string, unknown>,
          } as CallToolResult;
        }
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
