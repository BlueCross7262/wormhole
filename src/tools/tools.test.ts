import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools } from "./index.js";
import { registerStatusTool } from "./status.js";
import { registerPushTool } from "./push.js";
import { registerPullTool } from "./pull.js";
import { registerDryRunTool } from "./dry-run.js";
import { registerResolveTool } from "./resolve.js";
import { jobManager } from "../jobs/job-manager.js";
import type { SyncEngine } from "../sync/engine.js";
import type {
  PushResult,
  PullResult,
  ResolveResult,
  SyncStatus,
  ResolvePolicy,
  SyncRunOptions,
} from "../types.js";

// ----------------------------------------------------------------------------
// Test infrastructure: a fake McpServer capturing registerTool(name, config, cb)
// and a fake SyncEngine whose methods are stubbed per test.
// ----------------------------------------------------------------------------

type ZodRawShape = Record<string, z.ZodTypeAny>;

interface CapturedTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShape;
  };
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
}

class FakeServer {
  readonly tools: CapturedTool[] = [];
  registerTool(
    name: string,
    config: CapturedTool["config"],
    handler: CapturedTool["handler"],
  ): unknown {
    this.tools.push({ name, config, handler });
    return {};
  }
  get(name: string): CapturedTool {
    const t = this.tools.find((x) => x.name === name);
    assert.ok(t, `tool not registered: ${name}`);
    return t;
  }
  // Validate `args` against the registered inputSchema (mirrors the SDK's
  // pre-handler validation) and run the handler with the parsed result.
  async call(name: string, rawArgs: unknown): Promise<CallToolResult> {
    const t = this.get(name);
    const parsed = z.object(t.config.inputSchema ?? {}).parse(rawArgs ?? {});
    return t.handler(parsed, {});
  }
  // Parse-only: surface zod validation behavior without invoking the handler.
  parse(name: string, rawArgs: unknown): unknown {
    const t = this.get(name);
    return z.object(t.config.inputSchema ?? {}).parse(rawArgs ?? {});
  }
}

interface EngineCalls {
  status: number;
  push: SyncRunOptions[];
  pull: SyncRunOptions[];
  resolve: Array<{ policy?: ResolvePolicy; keys?: string[]; options?: SyncRunOptions }>;
}

interface FakeEngineOpts {
  status?: () => Promise<SyncStatus>;
  push?: (o?: SyncRunOptions) => Promise<PushResult>;
  pull?: (o?: SyncRunOptions) => Promise<PullResult>;
  resolve?: (
    p?: ResolvePolicy,
    k?: string[],
    o?: SyncRunOptions,
  ) => Promise<ResolveResult>;
}

function fixtureStatus(): SyncStatus {
  return {
    generatedAt: 1700000000000 as SyncStatus["generatedAt"],
    machineId: "machine-A" as SyncStatus["machineId"],
    manifestGeneration: 7,
    items: [],
    conflicts: [],
    summary: {
      localOnly: [],
      remoteOnly: [],
      modifiedLocal: [],
      modifiedRemote: [],
      conflict: [],
      inSync: [],
    } as unknown as SyncStatus["summary"],
  };
}

function fixturePush(dryRun = false): PushResult {
  return {
    dryRun,
    pushed: ["a.txt", "b.txt"] as PushResult["pushed"],
    deleted: ["gone.txt"] as PushResult["deleted"],
    skipped: 2,
    manifestGeneration: 8,
    conflicts: [],
  };
}

function fixturePull(dryRun = false): PullResult {
  return {
    dryRun,
    applied: ["x.txt"] as PullResult["applied"],
    removed: ["y.txt"] as PullResult["removed"],
    conflicts: [],
    backupDir: "/tmp/backup-1",
  };
}

function fixtureResolve(policy: ResolvePolicy = "latest-wins"): ResolveResult {
  return {
    policy,
    resolved: ["k1", "k2"] as ResolveResult["resolved"],
    conflictCopies: [],
    backupDir: null,
  };
}

function makeFakeEngine(opts: FakeEngineOpts = {}): {
  engine: SyncEngine;
  calls: EngineCalls;
} {
  const calls: EngineCalls = { status: 0, push: [], pull: [], resolve: [] };
  const engine = {
    async status(): Promise<SyncStatus> {
      calls.status++;
      return opts.status ? opts.status() : fixtureStatus();
    },
    async push(o?: SyncRunOptions): Promise<PushResult> {
      calls.push.push(o ?? {});
      return opts.push ? opts.push(o) : fixturePush(o?.dryRun ?? false);
    },
    async pull(o?: SyncRunOptions): Promise<PullResult> {
      calls.pull.push(o ?? {});
      return opts.pull ? opts.pull(o) : fixturePull(o?.dryRun ?? false);
    },
    async resolve(
      p?: ResolvePolicy,
      k?: string[],
      o?: SyncRunOptions,
    ): Promise<ResolveResult> {
      calls.resolve.push({ policy: p, keys: k, options: o });
      return opts.resolve ? opts.resolve(p, k, o) : fixtureResolve(p ?? "latest-wins");
    },
  } as unknown as SyncEngine;
  return { engine, calls };
}

// Drive the event loop until a predicate holds, without real sleeps. The
// jobManager worker settles on microtasks; a few yields are sufficient.
async function flushUntil(pred: () => boolean, max = 50): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) {
    await Promise.resolve();
  }
}

function parseStructured<T>(res: CallToolResult): T {
  // The handlers always emit a single text block with JSON.stringify(result).
  const block = res.content?.[0] as { type: string; text: string } | undefined;
  assert.ok(block && block.type === "text", "expected a text content block");
  return JSON.parse(block.text) as T;
}

// ============================================================================
// registerAllTools
// ============================================================================

describe("registerAllTools", () => {
  test("registers exactly the 5 sync tools with expected names", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerAllTools(server as unknown as McpServer, engine);

    const names = server.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "sync_dry_run",
      "sync_pull",
      "sync_push",
      "sync_resolve",
      "sync_status",
    ]);
    assert.equal(server.tools.length, 5);
  });

  test("each registered tool has a title and description", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerAllTools(server as unknown as McpServer, engine);
    for (const t of server.tools) {
      assert.ok(typeof t.config.title === "string" && t.config.title.length > 0);
      assert.ok(
        typeof t.config.description === "string" && t.config.description.length > 0,
      );
    }
  });
});

// ============================================================================
// sync_status
// ============================================================================

describe("sync_status — input schema", () => {
  test("accepts empty object (no jobId)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_status", {}), {});
  });

  test("accepts a string jobId", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_status", { jobId: "abc" }), { jobId: "abc" });
  });

  test("rejects a non-string jobId (zod error)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_status", { jobId: 123 }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("sync_status — handler without jobId", () => {
  test("invokes engine.status() and formats the SyncStatus result", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_status", {});
    assert.equal(calls.status, 1);
    assert.notEqual(res.isError, true);

    const out = parseStructured<SyncStatus>(res);
    assert.equal(out.machineId, "machine-A");
    assert.equal(out.manifestGeneration, 7);
    assert.deepEqual(out.items, []);
    assert.deepEqual(out.conflicts, []);
    // structuredContent mirrors the parsed JSON.
    assert.deepEqual(res.structuredContent, out as unknown as Record<string, unknown>);
  });

  test("engine.status() throwing surfaces as a tool error (isError) — no unhandled rejection", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      status: () => Promise.reject(new Error("status boom")),
    });
    registerStatusTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_status", {});
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "status boom");
  });
});

describe("sync_status — handler with jobId (job lookup)", () => {
  test("returns the JobRecord when jobId exists", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);

    // Seed a completed job in the real jobManager.
    const worker = Promise.resolve({ ok: true });
    const rec = jobManager.start("push", () => worker);
    await worker;
    await flushUntil(() => rec.status === "completed");

    const res = await server.call("sync_status", { jobId: rec.jobId });
    // jobId path must NOT call engine.status().
    assert.equal(calls.status, 0);
    assert.notEqual(res.isError, true);
    const out = parseStructured<typeof rec>(res);
    assert.equal(out.jobId, rec.jobId);
    assert.equal(out.status, "completed");
    assert.deepEqual(out.result, { ok: true });
  });

  test("unknown jobId returns isError with a 'job 없음' message", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_status", {
      jobId: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.match(block.text, /job 없음/);
  });
});

// ============================================================================
// sync_push
// ============================================================================

describe("sync_push — input schema", () => {
  test("empty object defaults dryRun=false, async=false", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerPushTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_push", {}), { dryRun: false, async: false });
  });

  test("accepts explicit booleans", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerPushTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_push", { dryRun: true, async: true }), {
      dryRun: true,
      async: true,
    });
  });

  test("rejects a non-boolean dryRun (zod error)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerPushTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_push", { dryRun: "yes" }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("sync_push — handler sync path", () => {
  test("dryRun=false calls engine.push({dryRun:false}) and formats PushResult", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerPushTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_push", { dryRun: false, async: false });
    assert.deepEqual(calls.push, [{ dryRun: false }]);
    const out = parseStructured<PushResult>(res);
    assert.deepEqual(out.pushed, ["a.txt", "b.txt"]);
    assert.deepEqual(out.deleted, ["gone.txt"]);
    assert.equal(out.skipped, 2);
    assert.equal(out.manifestGeneration, 8);
    assert.deepEqual(out.conflicts, []);
    assert.equal(out.dryRun, false);
  });

  test("dryRun=true maps to engine.push({dryRun:true}) even if async=true (no job)", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerPushTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_push", { dryRun: true, async: true });
    // async is ignored when dryRun is set → synchronous engine.push call.
    assert.deepEqual(calls.push, [{ dryRun: true }]);
    const out = parseStructured<PushResult>(res);
    assert.equal(out.dryRun, true);
    // Not a job acceptance envelope.
    assert.equal(
      (out as unknown as { jobId?: string }).jobId,
      undefined,
    );
  });

  test("engine.push throwing surfaces as a tool error", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      push: () => Promise.reject(new Error("push failed")),
    });
    registerPushTool(server as unknown as McpServer, engine);
    const res = await server.call("sync_push", { dryRun: false, async: false });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "push failed");
  });
});

describe("sync_push — async job path", () => {
  test("async=true returns {jobId, accepted:true, status:running} and the job completes", async () => {
    const server = new FakeServer();
    let resolveWork!: (r: PushResult) => void;
    const work = new Promise<PushResult>((r) => {
      resolveWork = r;
    });
    const { engine, calls } = makeFakeEngine({ push: () => work });
    registerPushTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_push", { dryRun: false, async: true });
    const env = parseStructured<{ jobId: string; accepted: boolean; status: string }>(res);
    assert.equal(env.accepted, true);
    assert.equal(env.status, "running");
    assert.ok(typeof env.jobId === "string" && env.jobId.length > 0);
    // engine.push invoked exactly once with dryRun:false (from the job closure).
    assert.deepEqual(calls.push, [{ dryRun: false }]);

    // Job is registered and running.
    const running = jobManager.get(env.jobId);
    assert.ok(running);
    assert.equal(running.status, "running");

    // Drive to completion.
    resolveWork(fixturePush(false));
    await work;
    await flushUntil(() => jobManager.get(env.jobId)?.status === "completed");

    // sync_status with the jobId reflects the completed result.
    const statusServer = new FakeServer();
    const { engine: e2 } = makeFakeEngine();
    registerStatusTool(statusServer as unknown as McpServer, e2);
    const statusRes = await statusServer.call("sync_status", { jobId: env.jobId });
    assert.notEqual(statusRes.isError, true);
    const job = parseStructured<{ status: string; result: PushResult }>(statusRes);
    assert.equal(job.status, "completed");
    assert.deepEqual(job.result.pushed, ["a.txt", "b.txt"]);
  });

  test("async job failing is captured as a failed JobRecord (not unhandled)", async () => {
    const server = new FakeServer();
    let rejectWork!: (e: Error) => void;
    const work = new Promise<PushResult>((_res, rej) => {
      rejectWork = rej;
    });
    const { engine } = makeFakeEngine({ push: () => work });
    registerPushTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_push", { dryRun: false, async: true });
    const env = parseStructured<{ jobId: string }>(res);

    rejectWork(new Error("async push exploded"));
    try {
      await work;
    } catch {
      /* expected */
    }
    await flushUntil(() => jobManager.get(env.jobId)?.status === "failed");

    const job = jobManager.get(env.jobId);
    assert.ok(job);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "async push exploded");
    assert.equal(job.result, null);
  });
});

// ============================================================================
// sync_pull
// ============================================================================

describe("sync_pull — input schema", () => {
  test("empty object defaults dryRun=false, async=false", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerPullTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_pull", {}), { dryRun: false, async: false });
  });

  test("rejects a non-boolean async (zod error)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerPullTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_pull", { async: 1 }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("sync_pull — handler sync path", () => {
  test("dryRun=false calls engine.pull({dryRun:false}) and formats PullResult", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerPullTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_pull", { dryRun: false, async: false });
    assert.deepEqual(calls.pull, [{ dryRun: false }]);
    const out = parseStructured<PullResult>(res);
    assert.deepEqual(out.applied, ["x.txt"]);
    assert.deepEqual(out.removed, ["y.txt"]);
    assert.deepEqual(out.conflicts, []);
    assert.equal(out.backupDir, "/tmp/backup-1");
    assert.equal(out.dryRun, false);
  });

  test("engine.pull throwing surfaces as a tool error", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      pull: () => Promise.reject(new Error("pull failed")),
    });
    registerPullTool(server as unknown as McpServer, engine);
    const res = await server.call("sync_pull", { dryRun: false, async: false });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "pull failed");
  });
});

describe("sync_pull — async job path", () => {
  test("async=true returns acceptance envelope and a 'pull' kind job that completes", async () => {
    const server = new FakeServer();
    let resolveWork!: (r: PullResult) => void;
    const work = new Promise<PullResult>((r) => {
      resolveWork = r;
    });
    const { engine, calls } = makeFakeEngine({ pull: () => work });
    registerPullTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_pull", { dryRun: false, async: true });
    const env = parseStructured<{ jobId: string; accepted: boolean; status: string }>(res);
    assert.equal(env.accepted, true);
    assert.equal(env.status, "running");
    assert.deepEqual(calls.pull, [{ dryRun: false }]);

    const running = jobManager.get(env.jobId);
    assert.ok(running);
    assert.equal(running.kind, "pull");

    resolveWork(fixturePull(false));
    await work;
    await flushUntil(() => jobManager.get(env.jobId)?.status === "completed");

    const job = jobManager.get(env.jobId);
    assert.ok(job);
    assert.equal(job.status, "completed");
    assert.deepEqual((job.result as PullResult).applied, ["x.txt"]);
  });
});

// ============================================================================
// sync_dry_run
// ============================================================================

describe("sync_dry_run — input schema", () => {
  test("accepts direction='push' and direction='pull'", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerDryRunTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_dry_run", { direction: "push" }), {
      direction: "push",
    });
    assert.deepEqual(server.parse("sync_dry_run", { direction: "pull" }), {
      direction: "pull",
    });
  });

  test("rejects a missing direction (required enum)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerDryRunTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_dry_run", {}),
      (e: unknown) => e instanceof z.ZodError,
    );
  });

  test("rejects an invalid direction value", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerDryRunTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_dry_run", { direction: "sideways" }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("sync_dry_run — handler", () => {
  test("direction='push' calls engine.push({dryRun:true}) and returns the plan", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerDryRunTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_dry_run", { direction: "push" });
    assert.deepEqual(calls.push, [{ dryRun: true }]);
    assert.deepEqual(calls.pull, []);
    const out = parseStructured<PushResult>(res);
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.pushed, ["a.txt", "b.txt"]);
  });

  test("direction='pull' calls engine.pull({dryRun:true}) and returns the plan", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerDryRunTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_dry_run", { direction: "pull" });
    assert.deepEqual(calls.pull, [{ dryRun: true }]);
    assert.deepEqual(calls.push, []);
    const out = parseStructured<PullResult>(res);
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.applied, ["x.txt"]);
  });

  test("engine error during dry-run surfaces as a tool error", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      push: () => Promise.reject(new Error("plan failed")),
    });
    registerDryRunTool(server as unknown as McpServer, engine);
    const res = await server.call("sync_dry_run", { direction: "push" });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "plan failed");
  });
});

// ============================================================================
// sync_resolve
// ============================================================================

describe("sync_resolve — input schema", () => {
  test("empty object defaults dryRun=false (policy/keys optional, absent)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("sync_resolve", {}), { dryRun: false });
  });

  test("accepts a valid policy and keys array", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.deepEqual(
      server.parse("sync_resolve", {
        policy: "preserve-both",
        keys: ["k1", "k2"],
        dryRun: true,
      }),
      { policy: "preserve-both", keys: ["k1", "k2"], dryRun: true },
    );
  });

  test("rejects an invalid policy value (zod enum)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_resolve", { policy: "whatever" }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });

  test("rejects keys that are not an array of strings", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("sync_resolve", { keys: [1, 2, 3] }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("sync_resolve — handler", () => {
  test("maps policy, keys, and dryRun to engine.resolve and formats ResolveResult", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);

    const res = await server.call("sync_resolve", {
      policy: "preserve-both",
      keys: ["k1", "k2"],
      dryRun: true,
    });
    assert.equal(calls.resolve.length, 1);
    assert.deepEqual(calls.resolve[0], {
      policy: "preserve-both",
      keys: ["k1", "k2"],
      options: { dryRun: true },
    });
    const out = parseStructured<ResolveResult>(res);
    assert.equal(out.policy, "preserve-both");
    assert.deepEqual(out.resolved, ["k1", "k2"]);
    assert.deepEqual(out.conflictCopies, []);
    assert.equal(out.backupDir, null);
  });

  test("omitted policy/keys pass through as undefined with dryRun default false", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);

    await server.call("sync_resolve", {});
    assert.equal(calls.resolve.length, 1);
    assert.equal(calls.resolve[0].policy, undefined);
    assert.equal(calls.resolve[0].keys, undefined);
    assert.deepEqual(calls.resolve[0].options, { dryRun: false });
  });

  test("engine.resolve throwing surfaces as a tool error", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      resolve: () => Promise.reject(new Error("resolve failed")),
    });
    registerResolveTool(server as unknown as McpServer, engine);
    const res = await server.call("sync_resolve", { policy: "latest-wins" });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "resolve failed");
  });
});
