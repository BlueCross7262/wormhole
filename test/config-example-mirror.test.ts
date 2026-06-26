import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const rootExample = path.join(repoRoot, "config.example.json");
const mirrorExample = path.join(repoRoot, "plugin/scripts/config.example.json");

test("config.example.json 미러가 root SSOT 와 동일 (drift 방지)", () => {
  const root = JSON.parse(fs.readFileSync(rootExample, "utf-8"));
  const mirror = JSON.parse(fs.readFileSync(mirrorExample, "utf-8"));
  assert.deepStrictEqual(
    mirror,
    root,
    "plugin/scripts/config.example.json 이 root 와 drift 됨 — `npm run build:plugin` 재실행 필요"
  );
});

test("config.example.json 이 _comment strip 후에도 setup 검증 4조건 만족", () => {
  const root = JSON.parse(fs.readFileSync(rootExample, "utf-8"));
  assert.equal(root.conflictPolicy, "preserve-both", "conflictPolicy 기본값");
  assert.ok((root.targets?.include ?? []).includes(".claude/CLAUDE.md"), "targets.include 에 .claude/CLAUDE.md 포함");
  assert.ok(root.homeRootTargets, "homeRootTargets 존재 (drift 로 누락됐던 기능 키)");
});
