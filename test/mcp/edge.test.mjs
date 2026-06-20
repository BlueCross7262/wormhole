// Batch 3 — 엣지·동시성·CAS·강건성 MCP 경계 시나리오.
// TRX-12(description 와이어계약), TRX-14(normalizeBaseDir), ELC-09(AsyncMutex 동시성),
// TMB-08(손상 blob pull graceful + 로컬 무손상).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult,
} from "./harness.mjs";

const readF = (home, rel) => fs.readFileSync(path.join(home.homeDir, rel), "utf8");
const writeF = (home, rel, c) => {
  const abs = path.join(home.homeDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c);
};

// ── TRX-12: tools/list description 안전문구 계약 ──
test("TRX-12: 쓰기4종 confirm 안전문구, 읽기2종 부재", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({ label: "desc", remoteUrl: dav.url });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });
  await client.initialize();
  const by = Object.fromEntries((await client.listTools()).result.tools.map((x) => [x.name, x]));

  const SAFE = "절대 자율적으로 confirm:true 를 넘기지 않는다";
  for (const n of ["wormhole_push", "wormhole_pull", "wormhole_resolve", "wormhole_sync"]) {
    assert.ok(by[n].description.includes(SAFE), `${n} 안전문구 포함`);
  }
  for (const n of ["wormhole_status", "wormhole_dry_run"]) {
    assert.ok(!by[n].description.includes("confirm"), `${n} confirm 문구 부재`);
  }
});

// ── TRX-14: normalizeBaseDir 정규화 → 부팅 MKCOL 위치 ──
test("TRX-14: remoteBaseDir 정규화 후 MKCOL 위치", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({
    label: "norm", remoteUrl: dav.url,
    configOverrides: { remote: { url: dav.url, username: "", password: "", remoteBaseDir: "//foo/bar//" } },
  });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });
  await client.initialize(); // 부팅 = ensureDir(MKCOL)

  const keys = [...dav.store.keys()];
  assert.ok(dav.store.has("/foo/bar"), `정규화된 base '/foo/bar' 생성 (keys: ${keys.join(",")})`);
  assert.ok(dav.store.has("/foo/bar/blobs"), "blobs 하위 생성");
  assert.ok(!keys.some((k) => k.includes("//")), "이중 슬래시 잔재 없음");
});

// ── ELC-09: AsyncMutex — 동시 push/pull 직렬화, 교차손상 없음 ──
test("ELC-09: 동시 push/pull tools/call 직렬화", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({ label: "mutex", remoteUrl: dav.url, files: { ".claude/CLAUDE.md": "concurrent\n" } });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });
  await client.initialize();

  // 응답 대기 없이 동시 발사.
  const [push, pull] = await Promise.all([
    client.callTool("wormhole_push", { confirm: true }),
    client.callTool("wormhole_pull", { confirm: true }),
  ]);
  assert.equal(parseToolResult(push).isError, false, "push 정상");
  assert.equal(parseToolResult(pull).isError, false, "pull 정상");

  // 프로세스 생존 + 와이어 일관(후속 status 정상).
  const st = parseToolResult(await client.callTool("wormhole_status"));
  assert.equal(st.isError, false, "후속 status 정상(프로세스 생존)");
});

// ── TMB-08: 손상 원격 blob → B pull graceful 실패 + 로컬 무손상 ──
test("TMB-08: 손상 blob pull → isError + 로컬 이전상태 보존", async (t) => {
  const dav = await startWebdav();
  const homeA = makeHome({ label: "rbA", remoteUrl: dav.url, files: { ".claude/CLAUDE.md": "v1\n" } });
  const homeB = makeHome({ label: "rbB", remoteUrl: dav.url });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url)).spawn();
  await b.initialize();
  t.after(async () => { await a.close(); await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });

  await a.callTool("wormhole_push", { confirm: true });   // v1
  await b.callTool("wormhole_pull", { confirm: true });    // B = v1
  assert.equal(readF(homeB, ".claude/CLAUDE.md"), "v1\n", "B 초기 v1");

  writeF(homeA, ".claude/CLAUDE.md", "v2\n");
  await a.callTool("wormhole_push", { confirm: true });    // v2 새 blob

  // 원격 blob 전부 손상(age 복호 불가 바이트로).
  let corrupted = 0;
  for (const [k, v] of dav.store) {
    if (k.includes("/blobs/") && v.type === "file") { v.body = Buffer.from("CORRUPT-not-age\n"); corrupted++; }
  }
  assert.ok(corrupted > 0, "blob 손상 주입됨");

  const pull = parseToolResult(await b.callTool("wormhole_pull", { confirm: true }));
  assert.equal(pull.isError, true, "손상 blob pull → isError(graceful, no crash)");
  assert.equal(readF(homeB, ".claude/CLAUDE.md"), "v1\n", "B 로컬 v1 보존(부분 손상/덮어쓰기 없음)");

  // 프로세스 생존.
  assert.equal(parseToolResult(await b.callTool("wormhole_status")).isError, false, "B 생존");
});
