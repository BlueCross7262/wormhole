// Batch 5 — 단일 머신 추가 계약/부팅 시나리오.
// SCH-03(keys 검증), SCH-08(dry_run pull 형태), TRX-04(initialize capabilities),
// TRX-13(passphrase 소스 env 관측), CGW-09(sync 미리보기 stop-on-error).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult,
} from "./harness.mjs";

async function boot(t, opts = {}) {
  const dav = await startWebdav();
  const home = makeHome({ label: "b5", remoteUrl: dav.url, ...opts });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url, opts.env)).spawn();
  t.after(async () => { await client.close(); await dav.close(); rmrf(home.homeDir); });
  return { dav, home, client };
}
const rejected = (res) => res.error !== undefined || parseToolResult(res).isError === true;

// ── SCH-03: resolve.keys 비배열/비문자열 거부 ──
test("SCH-03: resolve keys 타입 검증", async (t) => {
  const { client } = await boot(t);
  await client.initialize();
  assert.ok(rejected(await client.callTool("wormhole_resolve", { keys: "notarray" })), "keys 비배열 거부");
  assert.ok(rejected(await client.callTool("wormhole_resolve", { keys: [123] })), "keys 비문자열 원소 거부");
  // keys 빈 배열은 수용(전체 충돌 처리 의미).
  assert.ok(!rejected(await client.callTool("wormhole_resolve", { keys: [] })), "keys 빈배열 수용");
});

// ── SCH-08: dry_run direction:pull → PullResult 형태 ──
test("SCH-08: dry_run pull 은 PullResult(dryRun:true)", async (t) => {
  const { client } = await boot(t);
  await client.initialize();
  const r = parseToolResult(await client.callTool("wormhole_dry_run", { direction: "pull" }));
  assert.equal(r.isError, false, "pull dry_run 정상");
  assert.equal(r.structured.dryRun, true, "dryRun:true");
  for (const f of ["applied", "removed", "conflicts"]) assert.ok(f in r.structured, `PullResult.${f} 존재`);
  assert.ok("backupDir" in r.structured, "PullResult.backupDir 존재");
  assert.equal(r.structured.pushed, undefined, "PushResult 키(pushed) 부재 → pull 분기 확인");
});

// ── TRX-04: initialize capabilities 계약 ──
test("TRX-04: initialize serverInfo + capabilities", async (t) => {
  const { client } = await boot(t);
  const init = await client.initialize();
  const r = init.result;
  assert.equal(r.serverInfo.name, "wormhole", "serverInfo.name");
  assert.ok(typeof r.protocolVersion === "string" && r.protocolVersion.length > 0, "protocolVersion 문자열");
  assert.ok(r.capabilities && typeof r.capabilities.tools === "object", "capabilities.tools 객체");
});

// ── TRX-13: passphrase 소스 env 관측(stderr) ──
test("TRX-13: passphrase 소스 env 로그", async (t) => {
  const { client } = await boot(t);
  await client.initialize();
  assert.match(client.stderr, /passphrase 소스: env/, "stderr 에 'passphrase 소스: env'");
});

// ── CGW-09: sync 미리보기 분기 stop-on-error(pull dryRun throw → isError) ──
test("CGW-09: sync 미리보기 pull 실패 → isError, push 미산출", async (t) => {
  const { dav, client } = await boot(t, { files: { ".claude/CLAUDE.md": "x\n" } });
  await client.initialize();
  await client.callTool("wormhole_push", { confirm: true }); // manifest 생성

  // 원격 manifest 손상 → pull(dryRun) 의 manifestStore.read 복호/파싱 실패.
  const mkey = "/wormhole/manifest.json.age";
  assert.ok(dav.store.has(mkey), "manifest 존재");
  dav.store.set(mkey, { body: Buffer.from("not-age-garbage"), etag: '"bad"', type: "file", mtime: Date.now() });

  const res = await client.callTool("wormhole_sync"); // confirm 생략 = 미리보기
  const r = parseToolResult(res);
  assert.equal(r.isError, true, "pull dryRun 실패 → sync 미리보기 isError");
  // 미리보기 분기는 pull 후 push 순차 — pull throw 시 push 합본 산출 안 됨.
  assert.ok(!(r.structured && r.structured.push), "push 미리보기 미산출");
  // 프로세스 생존.
  assert.equal(parseToolResult(await client.callTool("wormhole_status")).isError, true, "status 도 동일 손상으로 isError(생존 확인)");
});
