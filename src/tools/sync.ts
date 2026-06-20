import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import type { ResolvePolicy } from "../types.js";

// wormhole_sync — pull → (충돌 시) resolve → push 복합 동기화.
// confirm 없이 호출하면 pull/push 계획만 미리보기로 계산한다(변경 없음).
// confirm:true 일 때만 실제 복합 실행하며, stop-on-error 로 단계별 중단한다.
export function registerSyncTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_sync",
    {
      title: "Wormhole Sync",
      description:
        "pull → (충돌 시) resolve → push 를 한 번에 수행하는 복합 동기화. 안전 기본값: confirm 없이 호출하면 실제 변경 없이 pull/push 미리보기(dry-run)만 반환한다. 실제 적용은 confirm:true 가 필요하며, 이는 사용자의 명시적 확인이 있을 때만 전달한다 — 절대 자율적으로 confirm:true 를 넘기지 않는다.",
      inputSchema: {
        policy: z.enum(["preserve-both", "latest-wins"]).optional(),
        confirm: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        if (args.confirm !== true) {
          // 미리보기: pull/push 계획만 계산(변경 없음).
          const pull = await engine.pull({ dryRun: true });
          const push = await engine.push({ dryRun: true });
          const payload: Record<string, unknown> = {
            pull,
            push,
            note: "미리보기 — 실제 적용하려면 confirm:true (사용자 확인 후)",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          } as CallToolResult;
        }

        // 복합 실행: pull → (충돌 있으면) resolve(policy) → push. stop-on-error.
        const policy: ResolvePolicy = args.policy ?? "preserve-both";
        const pull = await engine.pull();
        const payload: Record<string, unknown> = { pull };
        if (pull.conflicts.length > 0) {
          payload.resolve = await engine.resolve(policy);
        }
        payload.push = await engine.push();
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
