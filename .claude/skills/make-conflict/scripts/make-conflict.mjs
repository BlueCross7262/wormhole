#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = fwd(path.join(REPO, "plugin", "dist", "cli.mjs"));
const TEMP = fwd(path.join(os.tmpdir(), "wormhole-make-conflict"));
const REAL_HOME = fwd(os.homedir());
const REAL_ENV = `${REAL_HOME}/.wormhole/.env`;
const REAL_PLUGINS = `${REAL_HOME}/.claude/plugins`;
const REAL_SETTINGS = `${REAL_HOME}/.claude/settings.json`;
const SETTINGS_KEY = ".claude/settings.json";
const FAKE_MACHINE_ID = "00000000-f1c7-4000-8000-000000000001";
const ENV_DROP = /^(WORMHOLE_CONFIG|WORMHOLE_SYNC_INCLUDE|WORMHOLE_SYNC_EXCLUDE)=/;
const ENV_UNSUPPORTED = /^(WORMHOLE_PASSPHRASE_FILE|WORMHOLE_KEYCHAIN_SERVICE)=/;
const BACKUP = `${TEMP}-settings-backup.json`;

function fwd(p) {
  return p.split("\\").join("/");
}

function fail(msg) {
  console.error(`[make-conflict] 중단: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { mode: "create", keyA: "WORMHOLE_FIXTURE_A", keyB: "WORMHOLE_FIXTURE_B" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cleanup") out.mode = "cleanup";
    else if (a === "--revert-remote") out.mode = "revert-remote";
    else if (a === "--key-a") out.keyA = argv[++i];
    else if (a === "--key-b") out.keyB = argv[++i];
    else fail(`알 수 없는 인자 ${a}`);
  }
  for (const k of [out.keyA, out.keyB]) {
    if (!k || !/^[A-Z][A-Z0-9_]*$/.test(k)) fail(`fixture 키 이름이 대문자 식별자가 아니다: ${k}`);
    if (/_(PAT|TOKEN|SECRET)$/.test(k)) fail(`fixture 키 이름에 비밀값 접미를 쓰지 않는다: ${k}`);
  }
  if (out.keyA === out.keyB) fail("key-a 와 key-b 가 같다");
  return out;
}

function realEnv() {
  const e = { ...process.env };
  delete e.WORMHOLE_CONFIG;
  return e;
}

function fakeEnv() {
  const e = { ...process.env };
  for (const k of [
    "WEBDAV_URL",
    "WEBDAV_USER",
    "WEBDAV_PASS",
    "WORMHOLE_PASSPHRASE",
    "WORMHOLE_SYNC_INCLUDE",
    "WORMHOLE_SYNC_EXCLUDE",
  ]) {
    delete e[k];
  }
  e.USERPROFILE = TEMP;
  e.HOME = TEMP;
  e.WORMHOLE_CONFIG = `${TEMP}/.wormhole/config.json`;
  return e;
}

function runCli(env, args) {
  let out;
  try {
    out = execFileSync("node", [CLI, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    out = err.stdout ?? "";
    if (!out.includes("{")) fail(`cli ${args.join(" ")} 실행 실패: ${err.message}`);
  }
  const i = out.indexOf("{");
  if (i === -1) fail(`cli ${args.join(" ")} 가 JSON 을 내지 않았다`);
  return JSON.parse(out.slice(i));
}

function assertQuiet(status, label) {
  const s = status.summary;
  const dirty = ["added", "modified", "deleted"].filter((k) => s[k].length > 0);
  if (dirty.length > 0 || status.conflicts.length > 0) {
    fail(
      `${label}: 수렴 상태가 아니다 — ${dirty.map((k) => `${k}=${s[k].length}`).join(" ")} conflicts=${status.conflicts.length}`,
    );
  }
}

function spliceEnvKeys(absPath, pairs) {
  const raw = fs.readFileSync(absPath, "utf-8");
  const anchor = /"env"\s*:\s*\{/g;
  const hits = raw.match(anchor);
  if (!hits) fail(`${absPath}: "env" 블록이 없다`);
  if (hits.length !== 1) fail(`${absPath}: "env" 앵커가 ${hits.length} 회 매치됐다`);
  const at = raw.search(anchor);
  const insertAt = raw.indexOf("{", at) + 1;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const nextLine = raw.slice(insertAt).split(eol)[1] ?? "";
  const indent = (nextLine.match(/^\s*/) ?? ["    "])[0] || "    ";
  const lines = pairs.map(([k, v]) => `${eol}${indent}${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("");
  const next = raw.slice(0, insertAt) + lines + raw.slice(insertAt);
  JSON.parse(next);
  fs.writeFileSync(absPath, next);
}

function removeEnvKeys(absPath, keys) {
  const raw = fs.readFileSync(absPath, "utf-8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const kept = raw
    .split(eol)
    .filter((line) => !keys.some((k) => line.trim().startsWith(`${JSON.stringify(k)}:`)));
  const next = kept.join(eol);
  JSON.parse(next);
  fs.writeFileSync(absPath, next);
}

function buildRig() {
  if (fs.existsSync(TEMP)) {
    fail(`temp 리그가 이미 있다 (${TEMP}). 직전 실행이 정리되지 않았다 — --cleanup 먼저 실행하라`);
  }
  const envSrc = fs.readFileSync(REAL_ENV, "utf-8");
  if (envSrc.split(/\r?\n/).some((l) => ENV_UNSUPPORTED.test(l))) {
    fail("passphrase 가 파일·keychain 방식이다 — temp HOME 으로는 해석되지 않는다");
  }
  fs.mkdirSync(`${TEMP}/.wormhole`, { recursive: true });
  fs.mkdirSync(`${TEMP}/.claude/plugins`, { recursive: true });
  fs.writeFileSync(
    `${TEMP}/.wormhole/.env`,
    envSrc
      .split(/\r?\n/)
      .filter((l) => !ENV_DROP.test(l))
      .join("\n"),
  );
  fs.writeFileSync(`${TEMP}/.wormhole/machine-id`, FAKE_MACHINE_ID);

  const real = JSON.parse(fs.readFileSync(`${REAL_HOME}/.claude/wormhole-config.json`, "utf-8"));
  const cfg = { ...real };
  delete cfg.skills_keyword;
  cfg.home = TEMP;
  cfg.stateDir = `${TEMP}/.wormhole`;
  cfg.targets = { include: [SETTINGS_KEY], exclude: real.targets?.exclude ?? [] };
  cfg.homeRootTargets = {};
  fs.writeFileSync(`${TEMP}/.wormhole/config.json`, JSON.stringify(cfg, null, 2));

  for (const f of ["installed_plugins.json", "known_marketplaces.json"]) {
    fs.copyFileSync(`${REAL_PLUGINS}/${f}`, `${TEMP}/.claude/plugins/${f}`);
  }
}

function pullFakeBaseline() {
  const env = fakeEnv();
  assertQuiet(runCli(env, ["status"]), "게이트 A(가짜 초기)");

  const sync = runCli(env, ["sync"]);
  if (sync.aborted) fail(`가짜 baseline sync 중단: ${sync.reason} ${JSON.stringify(sync.missing ?? sync.conflicts)}`);
  if (JSON.stringify(sync.pull.applied) !== JSON.stringify([SETTINGS_KEY])) {
    fail(`가짜 pull 범위가 1건이 아니다: ${JSON.stringify(sync.pull.applied)}`);
  }
  if (sync.push.pushed.length > 0 || sync.push.deleted.length > 0) {
    fail(`가짜 baseline sync 가 원격을 바꿨다: pushed=${JSON.stringify(sync.push.pushed)} deleted=${JSON.stringify(sync.push.deleted)}`);
  }
  const after = runCli(env, ["status"]);
  assertQuiet(after, "게이트 A2(가짜 pull 이후)");
  return after.manifestGeneration;
}

function pushFake(expectGeneration, label) {
  const env = fakeEnv();
  const gate = runCli(env, ["status"]);
  const s = gate.summary;
  if (
    JSON.stringify(s.modified) !== JSON.stringify([SETTINGS_KEY]) ||
    s.added.length > 0 ||
    s.deleted.length > 0 ||
    gate.conflicts.length > 0
  ) {
    fail(
      `게이트 B(${label}): modified=${JSON.stringify(s.modified)} added=${s.added.length} deleted=${s.deleted.length} conflicts=${gate.conflicts.length}`,
    );
  }

  let sync = runCli(env, ["sync"]);
  if (sync.aborted || sync.push.pushed.length === 0) {
    sync = runCli(env, ["sync"]);
  }
  if (sync.aborted) fail(`가짜 push 중단: ${sync.reason}`);
  if (JSON.stringify(sync.push.pushed) !== JSON.stringify([SETTINGS_KEY]) || sync.push.deleted.length > 0) {
    fail(`가짜 push 범위 이상: pushed=${JSON.stringify(sync.push.pushed)} deleted=${JSON.stringify(sync.push.deleted)}`);
  }
  if (sync.push.manifestGeneration !== expectGeneration + 1) {
    console.error(
      `[make-conflict] 경고: generation 이 ${expectGeneration}+1 이 아니라 ${sync.push.manifestGeneration} 이다`,
    );
  }
  return sync.push.manifestGeneration;
}

function create(args) {
  const realStatus = runCli(realEnv(), ["status"]);
  assertQuiet(realStatus, "Step 0(실 머신)");

  buildRig();
  const gen = pullFakeBaseline();

  fs.copyFileSync(REAL_SETTINGS, BACKUP);
  let pushedGeneration = null;
  try {
    spliceEnvKeys(REAL_SETTINGS, [[args.keyA, "local"]]);
    spliceEnvKeys(`${TEMP}/${SETTINGS_KEY}`, [
      [args.keyA, "remote"],
      [args.keyB, "remote-only"],
    ]);
    pushedGeneration = pushFake(gen, "fixture push");
  } catch (err) {
    if (pushedGeneration === null) {
      fs.copyFileSync(BACKUP, REAL_SETTINGS);
      console.error(`[make-conflict] 실 settings.json 을 백업에서 복원했다 (${BACKUP})`);
    }
    throw err;
  }

  const after = runCli(realEnv(), ["status"]);
  const ok =
    after.conflicts.length === 1 &&
    after.conflicts[0].logicalKey === SETTINGS_KEY &&
    after.summary.remoteDeleted.length === 0;

  console.log(
    JSON.stringify(
      {
        mode: "create",
        tempRoot: TEMP,
        backup: BACKUP,
        fakeMachineId: FAKE_MACHINE_ID,
        keys: { leafConflict: args.keyA, remoteOnly: args.keyB },
        remoteGeneration: pushedGeneration,
        postCheck: {
          ok,
          conflicts: after.conflicts.map((c) => c.logicalKey),
          remoteDeleted: after.summary.remoteDeleted,
        },
        next: "/wormhole-sync",
      },
      null,
      2,
    ),
  );
  if (!ok) {
    console.error("[make-conflict] 사후 확인 실패 — 원격은 이미 fixture 를 담고 있다. 복원하지 않았다.");
    process.exit(1);
  }
}

function revertRemote(args) {
  if (!fs.existsSync(`${TEMP}/${SETTINGS_KEY}`)) fail(`temp 리그가 없다 (${TEMP}) — create 를 먼저 실행했어야 한다`);
  const env = fakeEnv();
  const before = runCli(env, ["status"]).manifestGeneration;
  runCli(env, ["sync"]);
  removeEnvKeys(`${TEMP}/${SETTINGS_KEY}`, [args.keyA, args.keyB]);
  const gen = pushFake(runCli(env, ["status"]).manifestGeneration, "revert-remote");
  console.log(
    JSON.stringify({ mode: "revert-remote", beforeGeneration: before, remoteGeneration: gen }, null, 2),
  );
}

function cleanup() {
  const sidecars = fs
    .readdirSync(`${REAL_HOME}/.claude`)
    .filter((f) => f.startsWith("settings.json.conflict-"))
    .map((f) => `${REAL_HOME}/.claude/${f}`);
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      { mode: "cleanup", removedTempRoot: TEMP, backupKept: fs.existsSync(BACKUP) ? BACKUP : null, sidecars },
      null,
      2,
    ),
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === "create") create(args);
else if (args.mode === "revert-remote") revertRemote(args);
else cleanup();
