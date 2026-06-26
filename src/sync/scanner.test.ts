import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanLocal } from "./scanner.js";
import type { Config } from "../types.js";

function makeConfig(home: string, overrides?: Partial<Config["targets"]> & { stateDir?: string }): Config {
  return {
    home,
    stateDir: overrides?.stateDir ?? path.join(home, ".wormhole"),
    targets: {
      include: overrides?.include ?? [".claude/**"],
      exclude: overrides?.exclude ?? [],
    },
    remote: { url: "http://localhost", username: "u", password: "p", basePath: "/" },
    crypto: { type: "passphrase" },
    syncMcpServers: [],
    conflictPolicy: "newer",
    lock: { enabled: false, ttlMs: 0, pollMs: 0 },
  } as unknown as Config;
}

function writeFile(filePath: string, content = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("scanLocal", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-scanner-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("happy path — included files returned with correct shape", async () => {
    const home = path.join(tmpDir, "happy");
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "hello");
    writeFile(path.join(home, ".claude", "settings.json"), "{}");
    writeFile(path.join(home, ".claude", "skills", "x.md"), "skill");

    const cfg = makeConfig(home, { include: [".claude/**"] });
    const results = await scanLocal(cfg);

    const keys = results.map((r) => r.logicalKey);
    assert.ok(keys.includes(".claude/CLAUDE.md"), "CLAUDE.md missing");
    assert.ok(keys.includes(".claude/settings.json"), "settings.json missing");
    assert.ok(keys.includes(".claude/skills/x.md"), "skills/x.md missing");

    for (const r of results) {
      assert.ok(typeof r.absPath === "string" && path.isAbsolute(r.absPath), "absPath not absolute");
      assert.ok(typeof r.size === "number" && r.size >= 0, "size invalid");
      assert.ok(typeof r.mtimeMs === "number" && r.mtimeMs > 0, "mtimeMs invalid");
    }
  });

  test("excluded files are omitted", async () => {
    const home = path.join(tmpDir, "exclude");
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "keep");
    writeFile(path.join(home, ".claude", ".credentials.json"), "secret");
    writeFile(path.join(home, ".claude", "session.log"), "log");
    writeFile(path.join(home, ".claude", "private.key"), "key");

    const cfg = makeConfig(home, {
      include: [".claude/**"],
      exclude: [".claude/.credentials.json", "**/*.log", "**/*.key"],
    });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    assert.ok(keys.includes(".claude/CLAUDE.md"), "CLAUDE.md should be included");
    assert.ok(!keys.includes(".claude/.credentials.json"), ".credentials.json should be excluded");
    assert.ok(!keys.includes(".claude/session.log"), "*.log should be excluded");
    assert.ok(!keys.includes(".claude/private.key"), "*.key should be excluded");
  });

  test("exclude takes precedence over include (file matches both)", async () => {
    const home = path.join(tmpDir, "precedence");
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "both");
    writeFile(path.join(home, ".claude", "keep.md"), "keep");

    const cfg = makeConfig(home, {
      include: [".claude/**"],
      exclude: [".claude/CLAUDE.md"],
    });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    assert.ok(!keys.includes(".claude/CLAUDE.md"), "CLAUDE.md matched both include+exclude — must be excluded");
    assert.ok(keys.includes(".claude/keep.md"), "keep.md should remain");
  });

  test("empty directory returns empty array", async () => {
    const home = path.join(tmpDir, "empty");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    const cfg = makeConfig(home, { include: [".claude/**"] });
    const results = await scanLocal(cfg);

    assert.deepEqual(results, []);
  });

  test("nonexistent base directory returns empty array (no throw)", async () => {
    const home = path.join(tmpDir, "does-not-exist-at-all");

    const cfg = makeConfig(home, { include: [".claude/**"] });
    const results = await scanLocal(cfg);

    assert.deepEqual(results, []);
  });

  test("stateDir inside home is automatically excluded", async () => {
    const home = path.join(tmpDir, "statedir");
    const stateDir = path.join(home, ".wormhole");
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "keep");
    writeFile(path.join(stateDir, "base.snapshot"), "state");
    writeFile(path.join(stateDir, "age-key.txt"), "age1xxx");

    const cfg = makeConfig(home, {
      include: [".claude/**", ".wormhole/**"],
      stateDir,
    });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    assert.ok(keys.includes(".claude/CLAUDE.md"), "CLAUDE.md should be included");
    assert.ok(!keys.some((k) => k.startsWith(".wormhole/")), "stateDir contents must be excluded");
  });

  test("results are sorted by logicalKey ascending", async () => {
    const home = path.join(tmpDir, "sorted");
    writeFile(path.join(home, ".claude", "z.md"), "z");
    writeFile(path.join(home, ".claude", "a.md"), "a");
    writeFile(path.join(home, ".claude", "m.md"), "m");

    const cfg = makeConfig(home, { include: [".claude/**"] });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(keys, sorted, "results not sorted by logicalKey");
  });

  test("logicalKey uses posix slashes regardless of OS", async () => {
    const home = path.join(tmpDir, "posix");
    writeFile(path.join(home, ".claude", "deep", "nested", "file.md"), "n");

    const cfg = makeConfig(home, { include: [".claude/**"] });
    const results = await scanLocal(cfg);

    for (const r of results) {
      assert.ok(!r.logicalKey.includes("\\"), `logicalKey must use posix slashes: ${r.logicalKey}`);
    }
  });

  test("stateDir outside home is NOT auto-excluded", async () => {
    const home = path.join(tmpDir, "statedir-outside-home");
    const stateDir = path.join(tmpDir, "external-state");
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "keep");

    const cfg = makeConfig(home, {
      include: [".claude/**"],
      stateDir,
    });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    assert.ok(keys.includes(".claude/CLAUDE.md"), "CLAUDE.md should be included when stateDir is outside home");
  });

  // B1 [E3 Minor] homeRootTargets 미지정 시 home-root .claude.json 열거 안 됨 (opt-in 가드)
  test("homeRootTargets 미지정 시 home-root .claude.json 미열거 (opt-in 가드)", async () => {
    const home = path.join(tmpDir, "homeroot-optout");
    writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    writeFile(path.join(home, ".claude", "CLAUDE.md"), "keep");

    const cfg = makeConfig(home, {
      include: [".claude/**"],
    });
    const results = await scanLocal(cfg);
    const keys = results.map((r) => r.logicalKey);

    assert.equal(
      keys.includes(".claude.json"),
      false,
      "homeRootTargets 미지정 시 .claude.json 이 스캔 결과에 없어야 함",
    );
    assert.ok(keys.includes(".claude/CLAUDE.md"), ".claude/CLAUDE.md 는 포함됨");
  });
});
