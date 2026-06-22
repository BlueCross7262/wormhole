import * as path from "node:path";
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
        policy: z
          .enum(["preserve-both", "latest-wins"])
          .describe(
            "충돌 해소 정책. preserve-both(기본): 양쪽 보존(무손실). latest-wins: 원격 최신본(매니페스트 generation = 마지막으로 push 된 쪽 기준, 파일 mtime/벽시계 시각 아님)으로 덮어쓰기. 생략 시 preserve-both.",
          )
          .optional(),
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

        // 복합 실행: 단일 락 파이프라인 (fetch → install-check → pull → resolve → push).
        const policy: ResolvePolicy = args.policy ?? "preserve-both";
        const engineCfg = (engine as unknown as { config: { home: string } }).config;
        const pluginsDir = path.join(engineCfg.home, ".claude", "plugins");
        const result = await engine.syncAtomic({ pluginsDir, policy });
        if (result.aborted) {
          const payload: Record<string, unknown> = {
            aborted: true,
            missing: result.missing,
            note: "미설치 플러그인이 있어 동기화 중단됨. 플러그인 설치 후 재시도하세요.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          } as CallToolResult;
        }
        const payload: Record<string, unknown> = { pull: result.pull, push: result.push };
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
