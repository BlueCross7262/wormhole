import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools } from "./index.js";
import { registerStatusTool } from "./status.js";
import { registerResolveTool } from "./resolve.js";
import { registerSyncTool } from "./sync.js";
import type { SyncEngine } from "../sync/engine.js";
import type {
  PushResult,
  PullResult,
  ResolveResult,
  SyncStatus,
  ResolvePolicy,
  SyncRunOptions,
  ConflictItem,
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

function fixturePull(dryRun = false, conflicts: ConflictItem[] = []): PullResult {
  return {
    dryRun,
    applied: ["x.txt"] as PullResult["applied"],
    removed: ["y.txt"] as PullResult["removed"],
    conflicts,
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
  test("registers exactly the 3 wormhole tools with expected names", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerAllTools(server as unknown as McpServer, engine);

    const names = server.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "wormhole_resolve",
      "wormhole_status",
      "wormhole_sync",
    ]);
    assert.equal(server.tools.length, 3);
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

  test("write tools' descriptions state the confirm-gate safety rule", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerAllTools(server as unknown as McpServer, engine);
    for (const name of [
      "wormhole_resolve",
      "wormhole_sync",
    ]) {
      const desc = server.get(name).config.description ?? "";
      assert.match(desc, /confirm:true/);
      assert.match(desc, /미리보기/);
    }
  });
});

// ============================================================================
// wormhole_status (read-only)
// ============================================================================

describe("wormhole_status — input schema", () => {
  test("accepts empty object (no jobId param exists)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("wormhole_status", {}), {});
  });

  test("ignores unknown keys (no jobId in schema)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);
    // Empty inputSchema → zod strips unknowns to {}.
    assert.deepEqual(server.parse("wormhole_status", { jobId: "abc" }), {});
  });
});

describe("wormhole_status — handler", () => {
  test("invokes engine.status() and formats the SyncStatus result", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerStatusTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_status", {});
    assert.equal(calls.status, 1);
    assert.notEqual(res.isError, true);

    const out = parseStructured<SyncStatus>(res);
    assert.equal(out.machineId, "machine-A");
    assert.equal(out.manifestGeneration, 7);
    assert.deepEqual(out.items, []);
    assert.deepEqual(out.conflicts, []);
    assert.deepEqual(res.structuredContent, out as unknown as Record<string, unknown>);
  });

  test("engine.status() throwing surfaces as a tool error (isError) — no unhandled rejection", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      status: () => Promise.reject(new Error("status boom")),
    });
    registerStatusTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_status", {});
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "status boom");
  });
});



// ============================================================================
// wormhole_resolve (confirm-gated)
// ============================================================================

describe("wormhole_resolve — input schema", () => {
  test("empty object defaults confirm=false (policy/keys optional, absent)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("wormhole_resolve", {}), { confirm: false });
  });

  test("accepts a valid policy and keys array", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.deepEqual(
      server.parse("wormhole_resolve", {
        policy: "preserve-both",
        keys: ["k1", "k2"],
        confirm: true,
      }),
      { policy: "preserve-both", keys: ["k1", "k2"], confirm: true },
    );
  });

  test("rejects an invalid policy value (zod enum)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("wormhole_resolve", { policy: "whatever" }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });

  test("rejects keys that are not an array of strings", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("wormhole_resolve", { keys: [1, 2, 3] }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("wormhole_resolve — handler confirm-gate", () => {
  test("no confirm → preview: engine.resolve(..., {dryRun:true}) + note", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_resolve", {
      policy: "preserve-both",
      keys: ["k1", "k2"],
    });
    assert.equal(calls.resolve.length, 1);
    assert.deepEqual(calls.resolve[0], {
      policy: "preserve-both",
      keys: ["k1", "k2"],
      options: { dryRun: true },
    });
    const out = parseStructured<ResolveResult & { note?: string }>(res);
    assert.equal(out.policy, "preserve-both");
    assert.match(out.note ?? "", /미리보기/);
  });

  test("confirm:true → real execution: engine.resolve(..., {dryRun:false}) + no note", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_resolve", {
      policy: "latest-wins",
      confirm: true,
    });
    assert.equal(calls.resolve.length, 1);
    assert.deepEqual(calls.resolve[0], {
      policy: "latest-wins",
      keys: undefined,
      options: { dryRun: false },
    });
    const out = parseStructured<ResolveResult & { note?: string }>(res);
    assert.equal(out.policy, "latest-wins");
    assert.deepEqual(out.resolved, ["k1", "k2"]);
    assert.equal(out.note, undefined);
  });

  test("omitted policy/keys pass through as undefined (preview by default)", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerResolveTool(server as unknown as McpServer, engine);

    await server.call("wormhole_resolve", {});
    assert.equal(calls.resolve.length, 1);
    assert.equal(calls.resolve[0].policy, undefined);
    assert.equal(calls.resolve[0].keys, undefined);
    assert.deepEqual(calls.resolve[0].options, { dryRun: true });
  });

  test("engine.resolve throwing surfaces as a tool error", async () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine({
      resolve: () => Promise.reject(new Error("resolve failed")),
    });
    registerResolveTool(server as unknown as McpServer, engine);
    const res = await server.call("wormhole_resolve", {
      policy: "latest-wins",
      confirm: true,
    });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "resolve failed");
  });
});

// ============================================================================
// wormhole_sync (confirm-gated composite)
// ============================================================================

describe("wormhole_sync — input schema", () => {
  test("empty object defaults confirm=false (policy optional)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerSyncTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("wormhole_sync", {}), { confirm: false });
  });

  test("accepts policy preserve-both / latest-wins", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerSyncTool(server as unknown as McpServer, engine);
    assert.deepEqual(server.parse("wormhole_sync", { policy: "preserve-both" }), {
      policy: "preserve-both",
      confirm: false,
    });
    assert.deepEqual(server.parse("wormhole_sync", { policy: "latest-wins" }), {
      policy: "latest-wins",
      confirm: false,
    });
  });

  test("rejects policy 'manual' (not in enum)", () => {
    const server = new FakeServer();
    const { engine } = makeFakeEngine();
    registerSyncTool(server as unknown as McpServer, engine);
    assert.throws(
      () => server.parse("wormhole_sync", { policy: "manual" }),
      (e: unknown) => e instanceof z.ZodError,
    );
  });
});

describe("wormhole_sync — handler confirm-gate", () => {
  test("no confirm → preview: pull+push dry-runs, no resolve, note present", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerSyncTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_sync", {});
    assert.deepEqual(calls.pull, [{ dryRun: true }]);
    assert.deepEqual(calls.push, [{ dryRun: true }]);
    assert.equal(calls.resolve.length, 0);
    const out = parseStructured<{ pull: PullResult; push: PushResult; note: string }>(
      res,
    );
    assert.equal(out.pull.dryRun, true);
    assert.equal(out.push.dryRun, true);
    assert.match(out.note, /미리보기/);
  });

  test("confirm:true with no conflicts → pull then push (no resolve), real execution", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine();
    registerSyncTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_sync", { confirm: true });
    assert.deepEqual(calls.pull, [{}]);
    assert.deepEqual(calls.push, [{}]);
    assert.equal(calls.resolve.length, 0);
    const out = parseStructured<{
      pull: PullResult;
      push: PushResult;
      resolve?: ResolveResult;
    }>(res);
    assert.equal(out.pull.dryRun, false);
    assert.equal(out.push.dryRun, false);
    assert.equal(out.resolve, undefined);
  });

  test("confirm:true with conflicts → pull, resolve(policy), push; policy defaults to preserve-both", async () => {
    const server = new FakeServer();
    const conflict = { logicalKey: "c.txt" } as unknown as ConflictItem;
    const { engine, calls } = makeFakeEngine({
      pull: () => Promise.resolve(fixturePull(false, [conflict])),
    });
    registerSyncTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_sync", { confirm: true });
    assert.deepEqual(calls.pull, [{}]);
    assert.equal(calls.resolve.length, 1);
    assert.equal(calls.resolve[0].policy, "preserve-both");
    assert.deepEqual(calls.push, [{}]);
    const out = parseStructured<{
      pull: PullResult;
      resolve: ResolveResult;
      push: PushResult;
    }>(res);
    assert.ok(out.resolve);
    assert.equal(out.resolve.policy, "preserve-both");
  });

  test("confirm:true with conflicts and explicit policy=latest-wins", async () => {
    const server = new FakeServer();
    const conflict = { logicalKey: "c.txt" } as unknown as ConflictItem;
    const { engine, calls } = makeFakeEngine({
      pull: () => Promise.resolve(fixturePull(false, [conflict])),
    });
    registerSyncTool(server as unknown as McpServer, engine);

    await server.call("wormhole_sync", { confirm: true, policy: "latest-wins" });
    assert.equal(calls.resolve.length, 1);
    assert.equal(calls.resolve[0].policy, "latest-wins");
  });

  test("stop-on-error: pull failure aborts before push, surfaces tool error", async () => {
    const server = new FakeServer();
    const { engine, calls } = makeFakeEngine({
      pull: () => Promise.reject(new Error("sync pull failed")),
    });
    registerSyncTool(server as unknown as McpServer, engine);

    const res = await server.call("wormhole_sync", { confirm: true });
    assert.equal(res.isError, true);
    const block = res.content[0] as { type: string; text: string };
    assert.equal(block.text, "sync pull failed");
    // push never reached.
    assert.deepEqual(calls.push, []);
  });
});
