import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runDoctor } from "../doctor.js";
import { logger } from "../logger.js";

// wormhole_doctor — 읽기 전용 환경 진단(config/연결/passphrase/vault 정합·상태/transport).
// engine 불요: 자체적으로 loadConfig 등 부트스트랩 단계를 tolerant 하게 재실행한다.
export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    "wormhole_doctor",
    {
      title: "Wormhole Doctor",
      description:
        "환경 진단을 실행한다(읽기 전용, 변경 없음). config·WebDAV 연결/인증·passphrase 소스·passphrase↔vault 정합·vault 상태·transport 보안을 점검하고 각 체크의 ok/fail/warn 결과를 반환.",
      inputSchema: {},
    },
    async (_args, _extra) => {
      try {
        const result = await runDoctor(logger);
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
