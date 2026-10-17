import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SyncEngine } from "./sync/engine.js";
import { parseReasonInputs } from "./sync/reasons.js";
import type { ReasonInput, ResolvePolicy } from "./types.js";

export interface RunSyncCommandOpts {
  policy: ResolvePolicy;
  reasons?: ReasonInput[];
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
  const result = await engine.syncAtomic({
    pluginsDir,
    policy: opts.policy,
    ...(opts.reasons ? { reasons: opts.reasons } : {}),
  });
  const payload = result as unknown as Record<string, unknown>;
  const exitCode = result.aborted ? 1 : 0;
  return { payload, exitCode };
}

export async function runReasonsCommand(
  engine: SyncEngine,
  opts: { inputs: ReasonInput[]; dryRun: boolean },
): Promise<RunSyncCommandResult> {
  const result = await engine.pushReasons(opts.inputs, { dryRun: opts.dryRun });
  const nothingDone =
    result.recorded.length === 0 && result.unchanged.length === 0 && result.rejected.length > 0;
  return { payload: result as unknown as Record<string, unknown>, exitCode: nothingDone ? 1 : 0 };
}

export async function loadReasonInputs(file: string): Promise<ReasonInput[]> {
  return parseReasonInputs(await fs.readFile(file, "utf-8"));
}
