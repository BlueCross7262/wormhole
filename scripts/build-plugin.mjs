// 플러그인 번들 빌드/릴리스 스크립트 (component 4).
// 단계: typecheck → esbuild 듀얼 번들(cli + server) → (claude CLI 존재 시) plugin validate →
//        번들 무결성 스모크 테스트(cli --help + server integrity) → 산출물 크기 출력.
// 각 단계는 실패 시 nonzero process.exit 로 게이팅한다. 멱등·재실행 가능.
//
// 핵심 사실:
//   cli.mjs  — `--help` 는 buildEngine() 를 호출하지 않으므로 비밀 없이 exit 0.
//   server.mjs — stdio MCP 서버라 --help 없음. 설정 없는 환경에서 기동하면 buildEngine →
//               loadConfig 가 "config.json 없음" 오류로 빠르게 실패한다. 따라서 서버
//               스모크 테스트는 stderr 에 모듈 해석 계열 오류가 없는지만 확인하고 kill 한다.

import esbuild from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")).version;

const CLI_OUTFILE = path.join(repoRoot, "plugin", "dist", "cli.mjs");
const SERVER_OUTFILE = path.join(repoRoot, "plugin", "dist", "server.mjs");
const CONFIG_EXAMPLE_SRC = path.join(repoRoot, "config.example.json");
const CONFIG_EXAMPLE_MIRROR = path.join(repoRoot, "plugin", "scripts", "config.example.json");
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
log("[1/6] typecheck (tsc --noEmit)...");
{
  const { code, error } = runInherit(NPM_CMD, ["run", "typecheck"]);
  if (error) fail("typecheck", `npm 실행 불가: ${String(error.message)}`);
  if (code !== 0) fail("typecheck", `tsc 가 오류와 함께 종료 (exit ${code}).`);
  log("[1/6] typecheck OK");
}

// ── config.example.json 미러 동기화 (setup.mjs SSOT) ──────────
// setup.mjs 는 plugin/scripts/ 안의 config.example.json 만 런타임에 읽는다
// (배포 단위 = plugin/, root 의 config.example.json 은 패키지에 없음).
// root SSOT 를 사본으로 동기화해 drift 를 막는다.
{
  fs.copyFileSync(CONFIG_EXAMPLE_SRC, CONFIG_EXAMPLE_MIRROR);
  log(`[*] config.example.json 미러 동기화 OK → ${CONFIG_EXAMPLE_MIRROR}`);
}

// 공통 esbuild 옵션 (두 번들 공유).
const ESBUILD_COMMON = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // 일부 transitive 의존성이 내부적으로 CJS require 를 쓰므로 banner 로 require 를 주입한다.
  // createRequire 를 alias 로 import 한다: esbuild 0.28+ 가 ESM 출력에 자체
  // `import { createRequire } from "node:module"` 를 top-level 로 emit 하므로,
  // banner 가 같은 식별자를 쓰면 "Identifier 'createRequire' has already been declared" 충돌이 난다.
  banner: {
    js: "import { createRequire as __wormholeCreateRequire } from 'node:module'; const require = __wormholeCreateRequire(import.meta.url);",
  },
  logLevel: "info",
  define: { __WORMHOLE_VERSION__: JSON.stringify(PKG_VERSION) },
};

// ── 2) Bundle CLI: src/cli.ts → plugin/dist/cli.mjs ─────────
log("[2/6] esbuild 번들 → plugin/dist/cli.mjs ...");
try {
  fs.mkdirSync(path.dirname(CLI_OUTFILE), { recursive: true });
  await esbuild.build({
    ...ESBUILD_COMMON,
    entryPoints: [path.join(repoRoot, "src", "cli.ts")],
    outfile: CLI_OUTFILE,
  });
  log("[2/6] cli bundle OK");
} catch (err) {
  fail("bundle(cli)", String(err?.stack ?? err?.message ?? err));
}

// ── 3) Bundle Server: src/index.ts → plugin/dist/server.mjs ─
log("[3/6] esbuild 번들 → plugin/dist/server.mjs ...");
try {
  fs.mkdirSync(path.dirname(SERVER_OUTFILE), { recursive: true });
  await esbuild.build({
    ...ESBUILD_COMMON,
    entryPoints: [path.join(repoRoot, "src", "index.ts")],
    outfile: SERVER_OUTFILE,
  });
  log("[3/6] server bundle OK");
} catch (err) {
  fail("bundle(server)", String(err?.stack ?? err?.message ?? err));
}

// ── 4) Validate (claude CLI 있을 때만) ───────────────────────
log("[4/6] claude plugin validate ...");
if (!resolveClaudeCli()) {
  log("[4/6] skip: no claude CLI");
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
  log("[4/6] validate OK");
}

// 모듈 해석 계열 오류 시그니처 (두 스모크 테스트 공유).
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

// 일회용 환경: 비밀값 일체 없음 (WebDAV/passphrase 미설정).
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

// 자식 프로세스를 spawn 해 stdout+stderr 를 캡처한다.
// timeoutMs 경과 시 SIGKILL 후 exitCode=null 반환 (PASS 판정 허용).
function spawnCapture(args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: throwawayEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, output: out + "\n" + err });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.on("error", (e) => {
      err += `\nspawn error: ${String(e?.message ?? e)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// ── 번들 격리 복사 (설치 환경 재현) ──────────────────────────
// smoke 를 repoRoot 에서 실행하면 createRequire 가 repoRoot/node_modules 로
// 외부 의존성을 해석해 "번들에서 누락된 의존성" 버그를 가린다 (0.5.4 micromatch 사고).
// 자체 완결 번들은 node_modules 조상이 없는 디렉터리에서도 동작해야 하므로,
// 임시 격리 디렉터리에 복사해 그곳에서 smoke 를 돌린다.
const ISO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-smoke-"));
const CLI_ISO = path.join(ISO_DIR, "cli.mjs");
const SERVER_ISO = path.join(ISO_DIR, "server.mjs");
fs.copyFileSync(CLI_OUTFILE, CLI_ISO);
fs.copyFileSync(SERVER_OUTFILE, SERVER_ISO);
log(`[smoke] 격리 디렉터리: ${ISO_DIR}`);

// ── 5) Smoke-test A: cli.mjs --help ──────────────────────────
// --help 는 buildEngine() 를 호출하지 않으므로 비밀 없이 exit 0 이어야 한다.
// exit 0 + 모듈 오류 시그니처 부재 = PASS.
log("[5/6] smoke-test A (cli.mjs --help) ...");
{
  const { exitCode, output } = await spawnCapture([CLI_ISO, "--help"], 4000);
  const hit = MODULE_ERROR_SIGNATURES.find((sig) => output.includes(sig));
  const excerpt = output.trim().split("\n").slice(0, 20).join("\n");

  if (hit) {
    fail(
      "smoke-test-cli",
      `번들 무결성 위반 — 출력에 "${hit}" 발견.\n--- captured stdout/stderr (head) ---\n${excerpt}`,
    );
  }
  if (exitCode !== 0) {
    fail(
      "smoke-test-cli",
      `cli.mjs --help 가 exit ${String(exitCode)} 으로 종료 (0 기대).\n--- captured stdout/stderr (head) ---\n${excerpt}`,
    );
  }
  log("[5/6] smoke-test A PASS (cli.mjs --help exit 0, 모듈 오류 없음)");
  if (excerpt) log(`--- captured output (head) ---\n${excerpt}`);
}

// ── 6) Smoke-test B: server.mjs 번들 무결성 ──────────────────
// stdio MCP 서버는 --help 가 없다. 설정 없는 환경에서 기동하면 buildEngine → loadConfig 가
// "config.json 없음" 오류로 빠르게 실패한다 (정상). 검사 목적은 모듈 해석 계열 오류가
// stderr 에 없는지만 확인하는 것이다 — 번들이 모든 의존성을 정상 적재했음을 증명한다.
// 프로세스가 블로킹되면 타임아웃 후 kill (exitCode=null) 하며, 모듈 오류 없으면 PASS.
log("[6/6] smoke-test B (server.mjs bundle integrity) ...");
{
  const { output } = await spawnCapture([SERVER_ISO], 3000);
  const hit = MODULE_ERROR_SIGNATURES.find((sig) => output.includes(sig));
  const excerpt = output.trim().split("\n").slice(0, 20).join("\n");

  if (hit) {
    fail(
      "smoke-test-server",
      `서버 번들 무결성 위반 — 출력에 "${hit}" 발견.\n--- captured stdout/stderr (head) ---\n${excerpt}`,
    );
  }
  log("[6/6] smoke-test B PASS (server.mjs 모듈 오류 없음)");
  if (excerpt) log(`--- captured output (head) ---\n${excerpt}`);
}

// 격리 디렉터리 정리.
fs.rmSync(ISO_DIR, { recursive: true, force: true });

// ── 산출물 크기 ──────────────────────────────────────────────
{
  const fmtSize = (f) => {
    const s = fs.statSync(f);
    return `${s.size} bytes (${(s.size / 1024).toFixed(1)} KiB)`;
  };
  log(`\nALL PASS`);
  log(`artifact(cli):    ${CLI_OUTFILE}  — ${fmtSize(CLI_OUTFILE)}`);
  log(`artifact(server): ${SERVER_OUTFILE}  — ${fmtSize(SERVER_OUTFILE)}`);
}

process.exit(0);
