import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SyncEngine } from "../sync/engine.js";
import type { ResolvePolicy } from "../types.js";

export function registerResolveTool(server: McpServer, engine: SyncEngine): void {
  server.registerTool(
    "wormhole_resolve",
    {
      title: "Wormhole Resolve",
      description:
        "충돌 항목을 지정한 정책으로 해소한다. keys 생략 시 전체 충돌 처리. 안전 기본값: confirm 없이 호출하면 실제 변경 없이 미리보기(dry-run)만 반환한다. 실제 적용은 confirm:true 가 필요하며, 이는 사용자의 명시적 확인이 있을 때만 전달한다 — 절대 자율적으로 confirm:true 를 넘기지 않는다.",
      inputSchema: {
        policy: z
          .enum(["preserve-both", "latest-wins", "ours", "manual"])
          .describe(
            "충돌 해소 정책. preserve-both(기본): 로컬 유지 + 원격본을 .conflict 사본으로 보존(무손실). latest-wins: 원격 최신본(매니페스트 generation = 마지막으로 push 된 쪽 기준, 파일 mtime/벽시계 시각 아님)으로 덮어쓰기 + 덮어쓰기 전 로컬 백업. ours: 로컬 콘텐츠를 채택하고 원격에 업로드(원격을 로컬로 덮어씀). 로컬 수정 보존이 목적. 수동 병합 후 ours 로 병합본 채택 가능. manual: 충돌 목록만 반환하고 자동 처리하지 않음. 생략 시 config 의 conflictPolicy 를 따른다.",
          )
          .optional(),
        keys: z.array(z.string()).optional(),
        confirm: z.boolean().optional().default(false),
      },
    },
    async (args, _extra) => {
      try {
        const dryRun = args.confirm !== true;
        const result = await engine.resolve(
          args.policy as ResolvePolicy | undefined,
          args.keys,
          { dryRun },
        );
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
