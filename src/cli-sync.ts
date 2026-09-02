import * as path from "node:path";
import type { SyncEngine } from "./sync/engine.js";
import type { ResolvePolicy } from "./types.js";

export interface RunSyncCommandOpts {
  policy: ResolvePolicy;
}

export interface RunSyncCommandResult {
  payload: Record<string, unknown>;
  exitCode: number;
}

export async function runSyncCommand(
  engine: SyncEngine,
  opts: RunSyncCommandOpts,
): Promise<RunSyncCommandResult> {
  const engineCfg = (engine as unknown as { config: { home: string } }).config;
  const pluginsDir = path.join(engineCfg.home, ".claude", "plugins");
  const result = await engine.syncAtomic({ pluginsDir, policy: opts.policy });
  const payload = result as unknown as Record<string, unknown>;
  const exitCode = result.aborted ? 1 : 0;
  return { payload, exitCode };
}
