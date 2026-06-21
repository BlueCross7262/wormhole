// Batch 1 — 단일 머신 MCP 도구 경계 계약 시나리오.
// TRX-01(tools/list 스키마), CGW-03(sync confirm 게이트 실와이어),
// SCH-02(zod 입력검증), ELC-02/03/10(부팅 실패 경로).
// push/pull/dry_run 노출 제거: 해당 도구 동작 검증 케이스(CGW-01/06, SCH-01/04)는 삭제,
// 안전 기본값(confirm 없는 미리보기)은 sync(CGW-03)로 이전됨.
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
test("TRX-01: tools/list 3개 도구 inputSchema 계약", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  const tools = (await client.listTools()).result.tools;
  const by = Object.fromEntries(tools.map((x) => [x.name, x]));

  assert.equal(tools.length, 3, "정확히 3개");

  // 음성 단언: push/pull/dry_run 은 더 이상 노출되지 않음.
  for (const removed of ["wormhole_push", "wormhole_pull", "wormhole_dry_run"]) {
    assert.equal(by[removed], undefined, `${removed} 미노출`);
  }

  // status: 파라미터 없음
  const statusProps = by.wormhole_status.inputSchema?.properties ?? {};
  assert.equal(Object.keys(statusProps).length, 0, "status 파라미터 없음");

  // resolve: policy 3-enum, keys array, confirm
  const rp = by.wormhole_resolve.inputSchema.properties;
  assert.deepEqual(rp.policy.enum, ["preserve-both", "latest-wins", "manual"], "resolve.policy 3종");
  assert.equal(rp.keys.type, "array", "resolve.keys array");

  // sync: policy 2-enum (manual 제외), confirm boolean optional
  const sp = by.wormhole_sync.inputSchema.properties;
  assert.deepEqual(sp.policy.enum, ["preserve-both", "latest-wins"], "sync.policy 2종(manual 없음)");
  assert.equal(sp.confirm.type, "boolean", "sync.confirm boolean");
  assert.ok(!(by.wormhole_sync.inputSchema.required ?? []).includes("confirm"), "sync.confirm optional");
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

// ── CGW-06: 반복 sync 미리보기 후 단일 적용 전진 ──
// (push 제거: 안전 기본값 반복 미리보기 불변 + 단일 confirm 적용 전진을 sync 로 이전.)
test("CGW-06: 반복 sync 미리보기 후 단일 적용 전진", async (t) => {
  const { client } = await bootClient(t, { files: { ".claude/CLAUDE.md": CLAUDE_MD } });
  await client.initialize();
  const gen0 = statusGen(await client.callTool("wormhole_status"));
  for (let i = 0; i < 3; i++) {
    const p = parseToolResult(await client.callTool("wormhole_sync"));
    assert.equal(p.structured.push.dryRun, true, `dry ${i} push.dryRun:true`);
  }
  assert.equal(statusGen(await client.callTool("wormhole_status")), gen0, "3회 미리보기 후 불변");
  await client.callTool("wormhole_sync", { confirm: true });
  const gen1 = statusGen(await client.callTool("wormhole_status"));
  assert.ok(gen1 !== gen0, "1회 적용 후 전진");
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

// ── SCH-04: confirm 비불리언 거부 (sync) ────────────────────
test("SCH-04: sync confirm 비불리언 거부", async (t) => {
  const { client } = await bootClient(t);
  await client.initialize();
  assert.ok(rejected(await client.callTool("wormhole_sync", { confirm: "true" })), "confirm 문자열 거부");
  assert.ok(rejected(await client.callTool("wormhole_sync", { confirm: 1 })), "confirm 숫자 거부");
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
  await a.callTool("wormhole_sync", { confirm: true }); // 원격 keyparams 부트스트랩
  await a.close();

  // 머신 B: 신규 home, 같은 원격, 다른 passphrase → sentinel 복호 실패.
  const homeB = makeHome({ label: "vaultB", remoteUrl: dav.url });
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url, { WORMHOLE_PASSPHRASE: "totally-wrong-passphrase" })).spawn();
  t.after(async () => { await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });

  await assert.rejects(() => b.initialize({ timeoutMs: 15000 }), "잘못된 passphrase 부팅 실패");
  // 에러 메시지는 sentinel/passphrase 정합성 관련이어야(정확 문구는 실행으로 확인).
  t.diagnostic(`ELC-02 stderr tail: ${b.stderr.split("\n").slice(-6).join(" | ")}`);
});
