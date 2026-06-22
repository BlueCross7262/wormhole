// Batch 6 — TWO_MACHINE 추가 시나리오.
// CGW-07(sync 충돌 자동해소), CGW-08(sync 무충돌 실적용),
// CFL-03/04/06(resolve 정책 변형), SMR-01/03/05(라우팅), TMB-03(converged), ELC-04(락 경합).
// push/pull 노출 제거: 상태 조성은 sync(pull→push)로 이전, pull 게이트 동작 검증(CGW-02)은 삭제.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult,
} from "./harness.mjs";

async function twoMachines(t, { aFiles = {}, bFiles = {} } = {}) {
  const dav = await startWebdav();
  const homeA = makeHome({ label: "A2", remoteUrl: dav.url, files: aFiles });
  const homeB = makeHome({ label: "B2", remoteUrl: dav.url, files: bFiles });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url)).spawn();
  await b.initialize();
  t.after(async () => { await a.close(); await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });
  return { dav, homeA, homeB, a, b };
}
const readF = (h, r) => fs.readFileSync(path.join(h.homeDir, r), "utf8");
const writeF = (h, r, c) => { const ab = path.join(h.homeDir, r); fs.mkdirSync(path.dirname(ab), { recursive: true }); fs.writeFileSync(ab, c); };
const exists = (h, r) => fs.existsSync(path.join(h.homeDir, r));
const sc = (res) => parseToolResult(res).structured;

// 충돌 상태 만들기: A v1 sync → B sync(baseline) → A v2 sync → B 로컬 v3.
async function makeConflict(a, b, homeA, homeB) {
  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });
  writeF(homeA, ".claude/CLAUDE.md", "v2-A\n");
  await a.callTool("wormhole_sync", { confirm: true });
  writeF(homeB, ".claude/CLAUDE.md", "v3-B\n");
}

// ── CGW-02: sync pull-단계 confirm 게이트(미리보기 → 로컬 미변경) ──
// (pull 도구 제거: confirm 게이트의 "미리보기 시 로컬 미변경" 의미를 sync 로 이전.)
test("CGW-02: sync confirm 게이트 — 미리보기 후 로컬 미변경", async (t) => {
  const { homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "x\n" } });
  await a.callTool("wormhole_sync", { confirm: true });

  const prev = sc(await b.callTool("wormhole_sync")); // confirm 생략 = 미리보기
  assert.equal(prev.pull.dryRun, true, "pull.dryRun:true");
  assert.ok(typeof prev.note === "string", "note 존재");
  assert.equal(exists(homeB, ".claude/CLAUDE.md"), false, "미리보기 후 로컬 미생성");

  const applied = sc(await b.callTool("wormhole_sync", { confirm: true }));
  assert.equal(applied.pull.dryRun, false, "confirm:true → 적용");
  assert.equal(exists(homeB, ".claude/CLAUDE.md"), true, "실제 다운로드");
});

// ── CGW-07: sync confirm:true 충돌 시 resolve 자동 개입 ──
test("CGW-07: sync 충돌 자동해소 경로", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await makeConflict(a, b, homeA, homeB);
  const r = sc(await b.callTool("wormhole_sync", { confirm: true })); // 기본 preserve-both
  assert.ok(r.pull, "pull 단계");
  assert.ok(r.resolve, "충돌이므로 resolve 단계 개입");
  assert.ok(r.push, "push 단계");
});

// ── CGW-08: sync confirm:true 무충돌 실적용(resolve 스킵) ──
test("CGW-08: sync 무충돌 → resolve 부재", async (t) => {
  const { a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "only-A\n" } });
  await a.callTool("wormhole_sync", { confirm: true }); // 원격만 변경, B 충돌 없음
  const r = sc(await b.callTool("wormhole_sync", { confirm: true }));
  assert.ok(r.pull, "pull 존재");
  assert.ok(r.push, "push 존재");
  assert.equal(r.resolve, undefined, "무충돌 → resolve 키 부재");
  assert.ok(r.pull.applied.includes(".claude/CLAUDE.md"), "pull 로 A 변경 반영");
});

// ── CFL-03: resolve latest-wins ──
test("CFL-03: resolve latest-wins 계약", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await makeConflict(a, b, homeA, homeB);
  const r = sc(await b.callTool("wormhole_resolve", { policy: "latest-wins", confirm: true }));
  assert.equal(r.policy, "latest-wins", "policy 반영");
  assert.ok(r.resolved.includes(".claude/CLAUDE.md"), "resolved 에 키");
  assert.equal(r.conflictCopies.length, 0, "latest-wins 는 사본 미생성");
});

// ── CFL-04: resolve manual → 미해소 잔존 ──
test("CFL-04: resolve manual 미해소", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await makeConflict(a, b, homeA, homeB);
  const r = sc(await b.callTool("wormhole_resolve", { policy: "manual", confirm: true }));
  assert.equal(r.policy, "manual", "policy=manual");
  assert.equal(r.resolved.length, 0, "manual 은 해소 안 함");
  assert.equal(r.conflictCopies.length, 0, "사본 없음");
  // 충돌 잔존 확인.
  const st = sc(await b.callTool("wormhole_status"));
  assert.ok(st.conflicts.some((c) => c.logicalKey === ".claude/CLAUDE.md"), "충돌 잔존");
});

// ── CFL-06: resolve policy 생략 → config 기본(preserve-both) ──
test("CFL-06: resolve policy 생략 → config 기본 preserve-both", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await makeConflict(a, b, homeA, homeB);
  const r = sc(await b.callTool("wormhole_resolve", { confirm: true })); // policy 생략
  assert.equal(r.policy, "preserve-both", "config 기본 적용");
  assert.ok(r.conflictCopies.length > 0, "preserve-both → 사본 생성");
});

// ── SMR-01: settings 3-way 로컬키 격리(base 경유 공유키 전파) ──
// base(이전 동기화 시점)가 있을 때 공유키 변경은 전파되고 로컬키는 보존된다.
// (base 없이 양측 발산하면 conflict — SMR-08 참조.)
test("SMR-01: settings 3-way 로컬키 격리", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/settings.json": JSON.stringify({ theme: "dark" }) } });
  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });               // B base = {theme:dark}
  writeF(homeB, ".claude/settings.json", JSON.stringify({ theme: "dark", permissions: { allow: ["B"] } })); // B 로컬키 추가
  writeF(homeA, ".claude/settings.json", JSON.stringify({ theme: "blue" }));                                 // A 공유키 변경
  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });
  const bs = JSON.parse(readF(homeB, ".claude/settings.json"));
  assert.equal(bs.theme, "blue", "공유키 변경(base 경유) 전파");
  assert.deepEqual(bs.permissions, { allow: ["B"] }, "로컬키(permissions) B 보존");
});

// ── SMR-03: contentHash 안정성(영구 modified 루프 부재) ──
test("SMR-03: push 후 settings 재-modified 없음", async (t) => {
  const { a } = await twoMachines(t, { aFiles: { ".claude/settings.json": JSON.stringify({ theme: "dark", x: 1 }) } });
  await a.callTool("wormhole_sync", { confirm: true });
  const st = sc(await a.callTool("wormhole_status"));
  assert.ok(!st.summary.modified.includes(".claude/settings.json"), "settings 재-modified 아님");
  assert.ok(!st.summary.added.includes(".claude/settings.json"), "settings 재-added 아님");
});

// ── SMR-08: 발산 settings(no-base) → conflict 분류·local 보존·미적용 ──
// (Phase 1.2: .mcp.json de-scope. settings.json 충돌 게이팅만 검증.)
test("SMR-08: 발산(no-base) → conflict, 로컬 보존, 미적용", async (t) => {
  const { homeB, a, b } = await twoMachines(t, {
    aFiles: {
      ".claude/settings.json": JSON.stringify({ theme: "dark" }),
    },
    bFiles: {
      ".claude/settings.json": JSON.stringify({ theme: "light" }),
    },
  });
  await a.callTool("wormhole_sync", { confirm: true });
  const pull = sc(await b.callTool("wormhole_sync", { confirm: true })).pull;
  const ck = pull.conflicts.map((c) => c.logicalKey);
  assert.ok(ck.includes(".claude/settings.json"), "settings 충돌 분류");
  assert.ok(!pull.applied.includes(".claude/settings.json"), "충돌 settings 미적용");
  assert.equal(JSON.parse(readF(homeB, ".claude/settings.json")).theme, "light", "B settings 로컬 보존");
});

// ── TMB-03: 양측 동일콘텐츠 도달 → converged ──
test("TMB-03: 독립 동일콘텐츠 → converged 분류", async (t) => {
  const same = "identical\n";
  const { b, a } = await twoMachines(t, {
    aFiles: { ".claude/CLAUDE.md": same },
    bFiles: { ".claude/CLAUDE.md": same },
  });
  await a.callTool("wormhole_sync", { confirm: true }); // 원격 = same
  const st = sc(await b.callTool("wormhole_status")); // B 로컬도 same
  const item = st.items.find((x) => x.logicalKey === ".claude/CLAUDE.md");
  assert.ok(item, "키 존재");
  assert.equal(item.kind, "converged", `kind=converged (실제 ${item?.kind})`);
  assert.ok(st.summary.converged.includes(".claude/CLAUDE.md"), "summary.converged 포함");
});

// ── ELC-04: 동시 push 경합 — 무손상 + 수렴 ──
test("ELC-04: 두 머신 동시 push 무손상", async (t) => {
  const { a, b, homeA, homeB } = await twoMachines(t, {
    aFiles: { ".claude/CLAUDE.md": "from-A\n" },
    bFiles: { ".claude/agents/x.md": "from-B\n" },
  });
  // 서로 다른 키를 동시 sync(같은 원격 lock/manifest CAS 경합).
  const [pa, pb] = await Promise.all([
    a.callTool("wormhole_sync", { confirm: true }),
    b.callTool("wormhole_sync", { confirm: true }),
  ]);
  // CAS/락 재시도로 둘 다 성공해야(혹은 최소 무크래시 + 후속 성공).
  assert.equal(parseToolResult(pa).isError, false, "A sync 무에러");
  assert.equal(parseToolResult(pb).isError, false, "B sync 무에러");
  // 후속 status 정상(원격 manifest 무손상).
  assert.equal(parseToolResult(await a.callTool("wormhole_status")).isError, false, "A status 정상");
  assert.equal(parseToolResult(await b.callTool("wormhole_status")).isError, false, "B status 정상");
});
