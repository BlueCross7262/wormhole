// 하네스 스모크: server.mjs 부팅 + initialize + tools/list = 4 도구.
// 블랙박스 채널(stdio JSON-RPC ↔ webdav-harness)이 실제로 도는지 1차 검증.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebdav, makeHome, childEnv, McpClient, rmrf } from "./harness.mjs";

const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
).version;

const EXPECTED_TOOLS = [
  "wormhole_status", "wormhole_resolve", "wormhole_sync", "wormhole_doctor",
];

// push/pull/dry_run 은 노출 표면에서 제거됨(sync 내부 프리미티브로만 잔존).
const REMOVED_TOOLS = ["wormhole_push", "wormhole_pull", "wormhole_dry_run"];

test("smoke: 부팅 + initialize + tools/list = 4 도구", async (t) => {
  const dav = await startWebdav();
  const home = makeHome({ label: "smoke", remoteUrl: dav.url });
  const client = new McpClient(childEnv(home.homeDir, home.configPath, dav.url)).spawn();

  t.after(async () => {
    await client.close();
    await dav.close();
    rmrf(home.homeDir);
  });

  const init = await client.initialize();
  assert.equal(init.result?.serverInfo?.name, "wormhole", "serverInfo.name");
  assert.ok(init.result?.capabilities?.tools, "capabilities.tools 존재");

  const list = await client.listTools();
  const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), "정확히 4개 도구");

  // 음성 단언: push/pull/dry_run 은 더 이상 노출되지 않음.
  for (const removed of REMOVED_TOOLS) {
    assert.ok(!names.includes(removed), `${removed} 미노출`);
  }

  // stdout 순수성: 부팅 로그가 stdout 으로 새지 않았는지(파싱 실패 라인 없이 JSON-RPC 만)
  assert.equal(client.stdoutBuf.trim(), "", "stdout 잔여 버퍼 없음(프레임 정합)");

  // 서버 버전 회귀 가드: serverInfo.version 이 package.json 과 일치(발견 1 수정 검증)
  assert.equal(init.result?.serverInfo?.version, PKG_VERSION, `serverInfo.version === package.json(${PKG_VERSION})`);
});
