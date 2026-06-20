import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";

export function registerPullTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_pull",
    {
      title: "Wormhole Pull",
      description:
        "원격 WebDAV 변경사항을 로컬로 다운로드한다. 안전 기본값: confirm 없이 호출하면 실제 변경 없이 미리보기(dry-run)만 반환한다. 실제 적용은 confirm:true 가 필요하며, 이는 사용자의 명시적 확인이 있을 때만 전달한다 — 절대 자율적으로 confirm:true 를 넘기지 않는다.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        const dryRun = args.confirm !== true;
        const result = await engine.pull({ dryRun });
        const payload: Record<string, unknown> = {
          ...(result as unknown as Record<string, unknown>),
        };
        if (dryRun) {
          payload.note = "미리보기 — 실제 적용하려면 confirm:true (사용자 확인 후)";
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
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
