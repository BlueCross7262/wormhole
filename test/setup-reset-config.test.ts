import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const setupScript = path.join(repoRoot, "plugin/scripts/setup.mjs");

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(repoRoot, "test", ".tmp-home-"));
}

function runSetup(homeDir: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [setupScript, ...args],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      encoding: "utf-8",
    }
  );
}

test("(a) --reset-config: sentinel config 덮어씀 + 기본값 마커 존재", () => {
  const homeDir = makeTmpHome();
  try {
    const wormholeDir = path.join(homeDir, ".wormhole");
    fs.mkdirSync(wormholeDir, { recursive: true });
    const configPath = path.join(wormholeDir, "config.json");

    fs.writeFileSync(configPath, JSON.stringify({ __sentinel__: true }), "utf-8");

    const result = runSetup(homeDir, ["--reset-config"]);
    assert.equal(result.status, 0, `setup 실패: ${result.stderr}`);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.__sentinel__, undefined, "sentinel 이 남아있으면 안 됨");
    assert.ok(Array.isArray(config.settingsJson?.localOnlyKeys), "settingsJson.localOnlyKeys 배열 존재");
    assert.equal(config.conflictPolicy, "preserve-both", "conflictPolicy 기본값");
    assert.ok(
      (config.targets?.include ?? []).includes(".claude/CLAUDE.md"),
      "targets.include 에 .claude/CLAUDE.md 포함"
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("(b) --reset-config: .env sentinel 내용 byte-identical 유지 (보안 핵심)", () => {
  const homeDir = makeTmpHome();
  try {
    const wormholeDir = path.join(homeDir, ".wormhole");
    fs.mkdirSync(wormholeDir, { recursive: true });
    const envPath = path.join(wormholeDir, ".env");
    const sentinel = "SENTINEL=keep\n";

    fs.writeFileSync(envPath, sentinel, "utf-8");

    const result = runSetup(homeDir, ["--reset-config"]);
    assert.equal(result.status, 0, `setup 실패: ${result.stderr}`);

    const envContent = fs.readFileSync(envPath, "utf-8");
    assert.equal(envContent, sentinel, ".env 내용이 변경됨 — 비밀값 보호 실패");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("(c) 플래그 없음: sentinel config 덮어쓰지 않음", () => {
  const homeDir = makeTmpHome();
  try {
    const wormholeDir = path.join(homeDir, ".wormhole");
    fs.mkdirSync(wormholeDir, { recursive: true });
    const configPath = path.join(wormholeDir, "config.json");

    fs.writeFileSync(configPath, JSON.stringify({ __sentinel__: true }), "utf-8");

    const result = runSetup(homeDir, []);
    assert.equal(result.status, 0, `setup 실패: ${result.stderr}`);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.__sentinel__, true, "플래그 없으면 sentinel 이 유지되어야 함");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
