import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import type { ResolvePolicy } from "../types.js";

export function registerResolveTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "sync_resolve",
    {
      title: "Sync Resolve",
      description: "충돌을 지정된 정책으로 해소한다. keys 생략 시 전체 충돌 처리. dryRun=true 시 계획만 반환.",
      inputSchema: {
        policy: z.enum(["preserve-both", "latest-wins", "manual"]).optional(),
        keys: z.array(z.string()).optional(),
        dryRun: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        const result = await engine.resolve(
          args.policy as ResolvePolicy | undefined,
          args.keys,
          { dryRun: args.dryRun },
        );
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
