// Batch 2 — TWO_MACHINE MCP 도구 경계 시나리오.
// 머신 A/B 가 별도 HOME·stateDir, 동일 원격 webdav-harness + 동일 passphrase.
// happy 왕복(MCP 경계), CFL-01/02 충돌, SMR-02/06 라우팅, TMB-02 tombstone.
// push/pull 노출 제거: 상태 조성·왕복은 sync(pull→push)로 이전.
// sync 페이로드 형태: { pull: PullResult, [resolve], push: PushResult }.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult,
} from "./harness.mjs";

// A 부팅·keyparams 부트스트랩 완료 후 B 부팅(생성 경쟁 회피).
async function twoMachines(t, { aFiles = {}, bFiles = {} } = {}) {
  const dav = await startWebdav();
  const homeA = makeHome({ label: "A", remoteUrl: dav.url, files: aFiles });
  const homeB = makeHome({ label: "B", remoteUrl: dav.url, files: bFiles });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url)).spawn();
  await b.initialize();
  t.after(async () => {
    await a.close(); await b.close(); await dav.close();
    rmrf(homeA.homeDir); rmrf(homeB.homeDir);
  });
  return { dav, homeA, homeB, a, b };
}

const readFile = (home, rel) => fs.readFileSync(path.join(home.homeDir, rel), "utf8");
const writeFile = (home, rel, c) => {
  const abs = path.join(home.homeDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c);
};
const exists = (home, rel) => fs.existsSync(path.join(home.homeDir, rel));

// ── 기반: A sync → B sync 왕복(MCP 경계, 바이트 충실) ──
test("RT: A sync → B sync 왕복 바이트 충실(MCP 경계)", async (t) => {
  const content = "# CLAUDE.md\n한글 ✓ — éè\n";
  const { homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": content } });

  const aSync = parseToolResult(await a.callTool("wormhole_sync", { confirm: true }));
  assert.ok(aSync.structured.push.pushed.includes(".claude/CLAUDE.md"), "A push 포함");

  assert.equal(exists(homeB, ".claude/CLAUDE.md"), false, "B sync 전 없음");
  const bSync = parseToolResult(await b.callTool("wormhole_sync", { confirm: true }));
  assert.ok(bSync.structured.pull.applied.includes(".claude/CLAUDE.md"), "B pull applied");
  assert.equal(readFile(homeB, ".claude/CLAUDE.md"), content, "바이트 충실");
});

// ── CFL-01: 양측 발산 → B status 가 conflict + conflicts[] 노출 ──
test("CFL-01: 양측 발산 → status conflict 구조", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await a.callTool("wormhole_sync", { confirm: true });          // gen1: v1
  await b.callTool("wormhole_sync", { confirm: true });           // B baseline=v1
  writeFile(homeA, ".claude/CLAUDE.md", "v2-from-A\n");
  await a.callTool("wormhole_sync", { confirm: true });           // gen2: v2 (remote)
  writeFile(homeB, ".claude/CLAUDE.md", "v3-from-B\n");           // B local divergent

  const st = parseToolResult(await b.callTool("wormhole_status")).structured;
  const item = st.items.find((x) => x.logicalKey === ".claude/CLAUDE.md");
  assert.ok(item, "키 존재");
  assert.equal(item.kind, "conflict", `kind=conflict (실제 ${item?.kind})`);
  const c = st.conflicts.find((x) => x.logicalKey === ".claude/CLAUDE.md");
  assert.ok(c, "conflicts[] 에 키");
  assert.ok("localHash" in c && "remoteHash" in c && "isDeletionConflict" in c, "ConflictItem 필드");
});

// ── CFL-02: resolve preserve-both → conflictCopies 기록 ──
test("CFL-02: resolve preserve-both conflictCopies", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "v1\n" } });
  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });
  writeFile(homeA, ".claude/CLAUDE.md", "v2-from-A\n");
  await a.callTool("wormhole_sync", { confirm: true });
  writeFile(homeB, ".claude/CLAUDE.md", "v3-from-B\n");

  const res = parseToolResult(await b.callTool("wormhole_resolve", { policy: "preserve-both", confirm: true }));
  assert.equal(res.isError, false, "resolve 정상");
  assert.equal(res.structured.policy, "preserve-both", "policy 반영");
  assert.ok(Array.isArray(res.structured.conflictCopies) && res.structured.conflictCopies.length > 0,
    "conflictCopies 기록됨");
  assert.ok(res.structured.resolved.includes(".claude/CLAUDE.md"), "resolved 에 키");
});

// ── SMR-02: ${HOME} 토큰화 왕복 — A 홈경로 → B 홈경로 detokenize ──
test("SMR-02: settings.json ${HOME} 토큰화 왕복", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t);
  const aPath = path.join(homeA.homeDir, "sub", "x");
  writeFile(homeA, ".claude/settings.json", JSON.stringify({ theme: "dark", p: aPath }, null, 2));

  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });

  const bSettings = JSON.parse(readFile(homeB, ".claude/settings.json"));
  const bExpected = path.join(homeB.homeDir, "sub", "x");
  assert.equal(bSettings.p, bExpected, `B detokenize 홈경로 (${bSettings.p})`);
  assert.notEqual(bSettings.p, aPath, "A 홈경로가 그대로 새지 않음");
  assert.equal(bSettings.theme, "dark", "공유 키 보존");
});

// ── SMR-06: 비밀 파일 push 제외 ──────────────────────────────
test("SMR-06: 비밀 파일 동기화 제외", async (t) => {
  const { a } = await twoMachines(t, {
    aFiles: {
      ".claude/CLAUDE.md": "ok\n",
      ".claude/.credentials.json": "SECRET-CRED\n",
      ".claude/settings.local.json": "{\"local\":true}\n",
      ".claude/foo.key": "PRIVATE-KEY\n",
    },
  });
  const push = parseToolResult(await a.callTool("wormhole_sync", { confirm: true }));
  const pushed = push.structured.push.pushed;
  assert.ok(pushed.includes(".claude/CLAUDE.md"), "정상 파일 push");
  for (const secret of [".claude/.credentials.json", ".claude/settings.local.json", ".claude/foo.key"]) {
    assert.ok(!pushed.includes(secret), `비밀 제외: ${secret}`);
  }
});

// ── TMB-02: A tombstone push → B pull 로 로컬 삭제 ──
test("TMB-02: tombstone 전파 — A 삭제 push → B pull removed", async (t) => {
  const { homeA, homeB, a, b } = await twoMachines(t, { aFiles: { ".claude/CLAUDE.md": "x\n" } });
  await a.callTool("wormhole_sync", { confirm: true });
  await b.callTool("wormhole_sync", { confirm: true });
  assert.equal(exists(homeB, ".claude/CLAUDE.md"), true, "B 가 먼저 받음");

  fs.rmSync(path.join(homeA.homeDir, ".claude/CLAUDE.md"));
  const push = parseToolResult(await a.callTool("wormhole_sync", { confirm: true }));
  assert.ok(push.structured.push.deleted.includes(".claude/CLAUDE.md"), "A push deleted tombstone");

  const pull = parseToolResult(await b.callTool("wormhole_sync", { confirm: true }));
  assert.ok(pull.structured.pull.removed.includes(".claude/CLAUDE.md"), "B pull removed");
  assert.equal(exists(homeB, ".claude/CLAUDE.md"), false, "B 로컬 삭제됨");
});
