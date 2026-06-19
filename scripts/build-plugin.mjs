// 플러그인 번들 빌드/릴리스 스크립트 (component 4).
// 단계: typecheck → esbuild 단일 파일 번들 → (claude CLI 존재 시) plugin validate →
//        번들 무결성 스모크 테스트 → 산출물 크기 출력.
// 각 단계는 실패 시 nonzero process.exit 로 게이팅한다. 멱등·재실행 가능.
//
// 핵심 사실: src/index.ts 의 buildEngine() 는 기동 시 resolvePassphrase + WebDAV
// remote.ensureDir 를 수행하므로, 비밀이 없으면 "MCP 서버 연결됨 (stdio)" 로그(index.ts:49)
// 전에 부트스트랩에서 크래시한다. 따라서 스모크 테스트는 서버 헬스가 아니라
// 번들 무결성(번들이 모든 의존성을 적재하고 wormhole 코드를 실행했는가)을 검증한다.

import esbuild from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const OUTFILE = path.join(repoRoot, "plugin", "dist", "index.mjs");
const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(step, detail) {
  process.stdout.write(`\n[FAIL] ${step}\n`);
  if (detail) process.stdout.write(`${detail}\n`);
  process.exit(1);
}

// Node 20+ on Windows refuses to spawn .cmd/.bat shims with shell:false
// (EINVAL — CVE-2024-27980 hardening). npm/claude are .cmd shims on Windows,
// so we must run through a shell there. args here are simple literals (no
// user input, no special chars) so shell:true is safe.
const SPAWN_SHELL = process.platform === "win32";

// stdio 를 상속해 자식 출력을 그대로 흘리는 동기 spawn. 종료코드 반환.
function runInherit(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: SPAWN_SHELL,
  });
  if (res.error) return { code: 1, error: res.error };
  return { code: res.status ?? 1 };
}

// claude CLI 가 PATH 에서 해석되는지 확인.
function resolveClaudeCli() {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, ["claude"], { cwd: repoRoot, shell: SPAWN_SHELL });
  return res.status === 0;
}

// ── 1) Typecheck ─────────────────────────────────────────────
log("[1/5] typecheck (tsc --noEmit)...");
{
  const { code, error } = runInherit(NPM_CMD, ["run", "typecheck"]);
  if (error) fail("typecheck", `npm 실행 불가: ${String(error.message)}`);
  if (code !== 0) fail("typecheck", `tsc 가 오류와 함께 종료 (exit ${code}).`);
  log("[1/5] typecheck OK");
}

// ── 2) Bundle (esbuild JS API) ───────────────────────────────
log("[2/5] esbuild 번들 → plugin/dist/index.mjs ...");
try {
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: OUTFILE,
    // 일부 transitive 의존성이 내부적으로 CJS require 를 쓰므로 banner 로 require 를 주입한다.
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    logLevel: "info",
  });
  log("[2/5] bundle OK");
} catch (err) {
  fail("bundle", String(err?.stack ?? err?.message ?? err));
}

// ── 3) Validate (claude CLI 있을 때만) ───────────────────────
log("[3/5] claude plugin validate ...");
if (!resolveClaudeCli()) {
  log("[3/5] skip: no claude CLI");
} else {
  const targets = [
    ["plugin", ["plugin", "validate", "./plugin"]],
    ["repo root", ["plugin", "validate", "."]],
  ];
  for (const [label, args] of targets) {
    log(`  validate (${label}): claude ${args.join(" ")}`);
    const { code, error } = runInherit("claude", args);
    if (error) fail("validate", `claude 실행 불가 (${label}): ${String(error.message)}`);
    if (code !== 0) fail("validate", `claude plugin validate 실패 (${label}, exit ${code}).`);
  }
  log("[3/5] validate OK");
}

// ── 4) Smoke-test: 번들 무결성 ───────────────────────────────
// node 로 번들을 직접 실행한다. 비밀이 없으므로 부트스트랩에서 크래시하지만,
// 그 크래시가 wormhole 코드(config/WebDAV/passphrase)에서 났다면 = 번들이 모든
// 의존성을 정상 적재·실행했다는 뜻 → PASS. 모듈 해석 계열 오류가 있으면 = FAIL.
log("[4/5] smoke-test (bundle integrity) ...");
{
  const MODULE_ERROR_SIGNATURES = [
    "MODULE_NOT_FOUND",
    "ERR_MODULE_NOT_FOUND",
    "Cannot find module",
    "Cannot find package",
    "ERR_REQUIRE_ESM",
    "require is not defined",
    "SyntaxError",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
  ];

  // 일회용 환경: 비밀 일체 없음. 로그 레벨만 error 로 낮춘다.
  const throwawayEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    WORMHOLE_LOG_LEVEL: "error",
  };

  const stderr = await new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(process.execPath, [OUTFILE], {
      cwd: repoRoot,
      env: throwawayEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out + "\n" + err);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 4000);
    child.on("error", (e) => {
      err += `\nspawn error: ${String(e?.message ?? e)}`;
      finish();
    });
    child.on("close", () => finish());
  });

  const hit = MODULE_ERROR_SIGNATURES.find((sig) => stderr.includes(sig));
  const excerpt = stderr.trim().split("\n").slice(0, 20).join("\n");

  if (hit) {
    fail(
      "smoke-test",
      `번들 무결성 위반 — stderr 에 "${hit}" 발견.\n--- captured stderr/stdout (head) ---\n${excerpt}`,
    );
  }
  log("[4/5] smoke-test PASS (번들이 모든 의존성을 적재·실행함; 부트스트랩 에러는 정상)");
  if (excerpt) {
    log(`--- captured output (head, expected wormhole bootstrap error) ---\n${excerpt}`);
  }
}

// ── 5) 산출물 크기 ───────────────────────────────────────────
{
  const stat = fs.statSync(OUTFILE);
  const kib = (stat.size / 1024).toFixed(1);
  log(`\n[5/5] ALL PASS`);
  log(`artifact: ${OUTFILE}`);
  log(`size: ${stat.size} bytes (${kib} KiB)`);
}

process.exit(0);
