import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncEngine } from "../sync/engine.js";
import { registerStatusTool } from "./status.js";
import { registerResolveTool } from "./resolve.js";
import { registerSyncTool } from "./sync.js";

export function registerAllTools(server: McpServer, engine: SyncEngine): void {
  registerStatusTool(server, engine);
  registerResolveTool(server, engine);
  registerSyncTool(server, engine);
}
