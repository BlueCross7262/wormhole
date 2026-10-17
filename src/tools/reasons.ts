import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";

export function registerReasonsTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_reasons",
    {
      title: "Wormhole Reasons",
      description:
        "이미 원격에 올라간 버전에 수정 이유만 따로 덧붙인다(로컬 파일 변경·pull 없음). 안전 기본값: confirm 없이 호출하면 실제 기록 없이 미리보기(dry-run)만 반환한다. 실제 기록은 confirm:true 가 필요하며, 이는 사용자의 명시적 확인이 있을 때만 전달한다 — 절대 자율적으로 confirm:true 를 넘기지 않는다. 각 항목의 contentHash 는 wormhole_status 가 준 remoteHash 이며 원격 엔트리와 다르면 stale-hash 로 거부된다.",
      inputSchema: {
        reasons: z
          .array(
            z.object({
              logicalKey: z.string().min(1),
              reason: z.string(),
              contentHash: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .optional(),
            }),
          )
          .min(1)
          .describe("파일(logicalKey)별 수정 이유. 같은 logicalKey 는 한 번만 쓴다."),
        confirm: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        const dryRun = args.confirm !== true;
        const result = await engine.pushReasons(args.reasons, { dryRun });
        const payload: Record<string, unknown> = { ...result };
        if (dryRun) {
          payload.note = "미리보기 — 실제 기록하려면 confirm:true (사용자 확인 후)";
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
