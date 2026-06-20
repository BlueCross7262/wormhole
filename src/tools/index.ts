import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncEngine } from "../sync/engine.js";
import { registerStatusTool } from "./status.js";
import { registerPushTool } from "./push.js";
import { registerPullTool } from "./pull.js";
import { registerResolveTool } from "./resolve.js";
import { registerDryRunTool } from "./dry-run.js";
import { registerSyncTool } from "./sync.js";

export function registerAllTools(server: McpServer, engine: SyncEngine): void {
  registerStatusTool(server, engine);
  registerPushTool(server, engine);
  registerPullTool(server, engine);
  registerResolveTool(server, engine);
  registerDryRunTool(server, engine);
  registerSyncTool(server, engine);
}
