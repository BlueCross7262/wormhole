// Batch 1 — 단일 머신 MCP 도구 경계 계약 시나리오.
// TRX-01(tools/list 스키마), CGW-01/03/06(confirm 게이트 실와이어),
// SCH-01/02/04(zod 입력검증), ELC-02/03/10(부팅 실패 경로).
// 모드 B: 실패 시 테스트결함이면 본 파일 수정, 코드버그면 src 수정 + 발견 리포트.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult, DEFAULT_PASSPHRASE,
} from "./harness.mjs";

const CLAUDE_MD = "# CLAUDE.md fixture\n\n한글 ✓ 내용.\n";

async function bootClient(t, { files, configOverrides, env } = {}) {
  const dav = await startWebdav();
  const home = makeHome({ label: "c", remoteUrl: dav.url, files, configOverrides });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url, env)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });
  return { dav, home, client };
}

function statusGen(res) {
  const { structured } = parseToolResult(res);
  return structured?.manifestGeneration ?? null;
}
function rejected(res) {
  return res.error !== undefined || parseToolResult(res).isError === true;
}

// ── TRX-01: tools/list 입력스키마 계약 ───────────────────────
test("TRX-01: tools/list 6개 도구 inputSchema 계약", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  const tools = (await client.listTools()).result.tools;
  const by = Object.fromEntries(tools.map((x) => [x.name, x]));

  assert.equal(tools.length, 6, "정확히 6개");

  // status: 파라미터 없음
  const statusProps = by.wormhole_status.inputSchema?.properties ?? {};
  assert.equal(Object.keys(statusProps).length, 0, "status 파라미터 없음");

  // dry_run: direction enum required
  const dr = by.wormhole_dry_run.inputSchema;
  assert.deepEqual(dr.properties.direction.enum, ["push", "pull"], "dry_run.direction enum");
  assert.ok((dr.required ?? []).includes("direction"), "dry_run.direction required");

  // push/pull: confirm boolean optional
  for (const n of ["wormhole_push", "wormhole_pull"]) {
    assert.equal(by[n].inputSchema.properties.confirm.type, "boolean", `${n}.confirm boolean`);
    assert.ok(!(by[n].inputSchema.required ?? []).includes("confirm"), `${n}.confirm optional`);
  }

  // resolve: policy 3-enum, keys array, confirm
  const rp = by.wormhole_resolve.inputSchema.properties;
  assert.deepEqual(rp.policy.enum, ["preserve-both", "latest-wins", "manual"], "resolve.policy 3종");
  assert.equal(rp.keys.type, "array", "resolve.keys array");

  // sync: policy 2-enum (manual 제외)
  const sp = by.wormhole_sync.inputSchema.properties;
  assert.deepEqual(sp.policy.enum, ["preserve-both", "latest-wins"], "sync.policy 2종(manual 없음)");
});

// ── CGW-01: push confirm 생략 → 미리보기, 와이어 불변; confirm:true → 적용 ──
test("CGW-01: push confirm 게이트 실와이어 무변경 증명", async (t) => {
  const { client } = await bootClient(t, { files: { ".claude/CLAUDE.md": CLAUDE_MD } });
  await client.initialize();

  const gen0 = statusGen(await client.callTool("wormhole_status"));

  const preview = parseToolResult(await client.callTool("wormhole_push")); // confirm 생략
  assert.equal(preview.structured.dryRun, true, "confirm 생략 → dryRun:true");
  assert.ok(typeof preview.structured.note === "string" && preview.structured.note.length > 0, "note 존재");
  assert.equal(statusGen(await client.callTool("wormhole_status")), gen0, "미리보기 후 generation 불변");

  const previewFalse = parseToolResult(await client.callTool("wormhole_push", { confirm: false }));
  assert.equal(previewFalse.structured.dryRun, true, "confirm:false → dryRun:true");
  assert.equal(statusGen(await client.callTool("wormhole_status")), gen0, "confirm:false 후 generation 불변");

  const applied = parseToolResult(await client.callTool("wormhole_push", { confirm: true }));
  assert.equal(applied.structured.dryRun, false, "confirm:true → dryRun:false");
  assert.equal(applied.structured.note, undefined, "실적용엔 note 없음");
  assert.ok(applied.structured.pushed.includes(".claude/CLAUDE.md"), "CLAUDE.md push 됨");
  const gen1 = statusGen(await client.callTool("wormhole_status"));
  assert.ok(gen1 !== null && gen1 !== gen0, `generation 전진 (${gen0} -> ${gen1})`);
});

// ── CGW-03: sync 미리보기 → {pull,push} 합본, resolve 키 부재 ──
test("CGW-03: sync 미리보기 구조 + 와이어 불변", async (t) => {
  const { client } = await bootClient(t, { files: { ".claude/CLAUDE.md": CLAUDE_MD } });
  await client.initialize();
  const gen0 = statusGen(await client.callTool("wormhole_status"));

  const prev = parseToolResult(await client.callTool("wormhole_sync"));
  assert.ok(prev.structured.pull, "pull 키 존재");
  assert.ok(prev.structured.push, "push 키 존재");
  assert.equal(prev.structured.pull.dryRun, true, "pull dryRun:true");
  assert.equal(prev.structured.push.dryRun, true, "push dryRun:true");
  assert.equal(prev.structured.resolve, undefined, "미리보기엔 resolve 키 없음");
  assert.equal(statusGen(await client.callTool("wormhole_status")), gen0, "sync 미리보기 후 불변");
});

// ── CGW-06: 3× dry → gen 불변; confirm:true 1회 → 정확히 1회 전진 ──
test("CGW-06: 반복 미리보기 후 단일 적용 전진", async (t) => {
  const { client } = await bootClient(t, { files: { ".claude/CLAUDE.md": CLAUDE_MD } });
  await client.initialize();
  const gen0 = statusGen(await client.callTool("wormhole_status"));
  for (let i = 0; i < 3; i++) {
    const p = parseToolResult(await client.callTool("wormhole_push"));
    assert.equal(p.structured.dryRun, true, `dry ${i} dryRun:true`);
  }
  assert.equal(statusGen(await client.callTool("wormhole_status")), gen0, "3회 dry 후 불변");
  await client.callTool("wormhole_push", { confirm: true });
  const gen1 = statusGen(await client.callTool("wormhole_status"));
  assert.ok(gen1 !== gen0, "1회 적용 후 전진");
});

// ── SCH-01: dry_run direction 검증 ───────────────────────────
test("SCH-01: dry_run direction 필수+enum", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  assert.ok(rejected(await client.callTool("wormhole_dry_run", {})), "direction 누락 거부");
  assert.ok(rejected(await client.callTool("wormhole_dry_run", { direction: "sideways" })), "오enum 거부");
  const ok = parseToolResult(await client.callTool("wormhole_dry_run", { direction: "push" }));
  assert.equal(ok.isError, false, "direction:push 수용");
  assert.equal(ok.structured.dryRun, true, "dryRun:true 반환");
});

// ── SCH-02: sync policy 'manual' 거부 (resolve 와 발산) ──
test("SCH-02: sync 는 manual 거부, resolve 는 수용", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  assert.ok(rejected(await client.callTool("wormhole_sync", { policy: "manual" })), "sync manual 거부");
  // resolve manual 은 스키마상 수용(충돌 없으면 no-op). 스키마 거부가 아님을 확인.
  const r = await client.callTool("wormhole_resolve", { policy: "manual" });
  assert.ok(!rejected(r) || parseToolResult(r).structured?.policy === "manual", "resolve manual 스키마 수용");
});

// ── SCH-04: confirm 비불리언 거부 ────────────────────────────
test("SCH-04: confirm 비불리언 거부", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  assert.ok(rejected(await client.callTool("wormhole_push", { confirm: "true" })), "confirm 문자열 거부");
  assert.ok(rejected(await client.callTool("wormhole_push", { confirm: 1 })), "confirm 숫자 거부");
});

// ── ELC-03: config.json 부재 → 부팅 실패 ─────────────────────
test("ELC-03: config.json 부재 부팅 실패", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({ label: "noconf", remoteUrl: dav.url });
  // config 를 지워 부재 상태로.
  fs.rmSync(home.configPath);
  const env = childEnv(home.homeDir, home.configPath, dav.url);
  const client = new McpClient(env).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });

  await assert.rejects(() => client.initialize({ timeoutMs: 15000 }), "부팅 실패로 initialize reject");
  assert.match(client.stderr, /config\.json 없음/, "stderr 에 'config.json 없음'");
});

// ── ELC-10: 깨진 config.json → 부팅 실패(ENOENT 와 구별) ──
test("ELC-10: 깨진 config.json 부팅 실패", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({ label: "badconf", remoteUrl: dav.url });
  fs.writeFileSync(home.configPath, "{broken json");
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });

  await assert.rejects(() => client.initialize({ timeoutMs: 15000 }), "부팅 실패");
  assert.match(client.stderr, /config 파일 읽기 실패/, "stderr 에 'config 파일 읽기 실패'");
});

// ── ELC-02: 신규 머신 잘못된 passphrase → sentinel 검증 실패 부팅 실패 ──
test("ELC-02: 잘못된 passphrase 부팅 실패(기존 vault)", async (t) => {
  const dav = await startWebdav();
  // 머신 A: 올바른 passphrase 로 push → 원격 keyparams 부트스트랩.
  const homeA = makeHome({ label: "vaultA", remoteUrl: dav.url, files: { ".claude/CLAUDE.md": CLAUDE_MD } });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  await a.callTool("wormhole_push", { confirm: true });
  await a.close();

  // 머신 B: 신규 home, 같은 원격, 다른 passphrase → sentinel 복호 실패.
  const homeB = makeHome({ label: "vaultB", remoteUrl: dav.url });
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url, { WORMHOLE_PASSPHRASE: "totally-wrong-passphrase" })).spawn();
  t.after(async () => { await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });

  await assert.rejects(() => b.initialize({ timeoutMs: 15000 }), "잘못된 passphrase 부팅 실패");
  // 에러 메시지는 sentinel/passphrase 정합성 관련이어야(정확 문구는 실행으로 확인).
  t.diagnostic(`ELC-02 stderr tail: ${b.stderr.split("\n").slice(-6).join(" | ")}`);
});
