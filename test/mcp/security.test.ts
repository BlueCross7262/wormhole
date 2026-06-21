// Batch 4 — 보안: F-ENGINE-24 경로탈출 거부 (MCP 경계).
// 신뢰불가 원격 manifest 에 악성 logicalKey(상위탈출/절대/백슬래시)를 직접 주입(테스트가
// passphrase 보유 → 원격 키 파생해 manifest 복호·재암호화)하고, 머신B wormhole_sync(pull 단계)가
// safeAbsPath→isValidLogicalKey/isWithinHome 가드로 거부해 home 밖에 쓰지 않음을 검증.
// push/pull 노출 제거: 상태 조성·pull 검증은 sync(pull→push)로 이전.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { gzipSync } from "node:zlib";

import { deriveAgeIdentity } from "../../src/crypto/kdf.js";
import { AgeCrypto } from "../../src/crypto/age.js";
import { sha256, blobName } from "../../src/sync/hash.js";
import {
  startWebdav, makeHome, childEnv, McpClient, rmrf, parseToolResult, DEFAULT_PASSPHRASE,
} from "./harness.mjs";

const KEYPARAMS = "/wormhole/keyparams.json";
const MANIFEST = "/wormhole/manifest.json.age";

// 원격 store 에서 vault 키를 재파생해 manifest 를 복호한다.
async function openManifest(store: Map<string, any>): Promise<{ crypto: AgeCrypto; manifest: any }> {
  const kp = JSON.parse(store.get(KEYPARAMS).body.toString("utf8"));
  const identity = deriveAgeIdentity(DEFAULT_PASSPHRASE, kp.saltB64, { N: kp.N, r: kp.r, p: kp.p });
  const crypto = new AgeCrypto();
  await crypto.initWithIdentity(identity);
  const armored = store.get(MANIFEST).body.toString("utf8");
  const manifest = JSON.parse(await crypto.decryptToString(armored));
  return { crypto, manifest };
}

async function writeManifest(store: Map<string, any>, crypto: AgeCrypto, manifest: any): Promise<void> {
  const armored = await crypto.encrypt(JSON.stringify(manifest));
  store.set(MANIFEST, { body: Buffer.from(armored, "utf8"), etag: '"evil-manifest"', type: "file", mtime: Date.now() });
}

test("F-ENGINE-24: 악성 원격 manifest 키 → pull 경로탈출 거부", async (t) => {
  const dav = await startWebdav();
  const homeA = makeHome({ label: "secA", remoteUrl: dav.url, files: { ".claude/CLAUDE.md": "legit\n" } });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  await a.callTool("wormhole_sync", { confirm: true }); // vault + manifest + blob 부트스트랩
  await a.close();

  // 악성 키 주입: 상위탈출 / 절대 / 백슬래시. 유효 엔트리를 클론해 구조 유효성 유지.
  const { crypto, manifest } = await openManifest(dav.store);
  const template = manifest.entries[".claude/CLAUDE.md"];
  assert.ok(template, "유효 엔트리 존재(클론 템플릿)");
  const EVIL = {
    rel: "../WH_EVIL_REL.txt",
    abs: "/tmp/WH_EVIL_ABS.txt",
    bs: "..\\WH_EVIL_BS.txt",
    deep: "../../../../../../../../tmp/WH_EVIL_DEEP.txt",
  };
  for (const k of Object.values(EVIL)) manifest.entries[k] = { ...template };
  manifest.manifestGeneration += 1;
  await writeManifest(dav.store, crypto, manifest);

  // 머신 B(신규): 악성 manifest 를 pull.
  const homeB = makeHome({ label: "secB", remoteUrl: dav.url });
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url)).spawn();
  t.after(async () => { await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });
  await b.initialize();

  const pull = parseToolResult(await b.callTool("wormhole_sync", { confirm: true }));

  // 유효 키는 적용, 악성 키는 전부 미적용.
  assert.equal(pull.isError, false, "sync 자체는 graceful(크래시 아님)");
  assert.ok(pull.structured.pull.applied.includes(".claude/CLAUDE.md"), "유효 키 적용");
  for (const k of Object.values(EVIL)) {
    assert.ok(!pull.structured.pull.applied.includes(k), `악성 키 미적용: ${k}`);
  }

  // home 밖 마커 파일이 생성되지 않았음(경로탈출 방어 실효).
  const parent = path.dirname(homeB.homeDir);
  assert.equal(fs.existsSync(path.join(parent, "WH_EVIL_REL.txt")), false, "상위탈출 파일 미생성");
  assert.equal(fs.existsSync(path.join(parent, "WH_EVIL_BS.txt")), false, "백슬래시 파일 미생성");
  assert.equal(fs.existsSync("/tmp/WH_EVIL_ABS.txt"), false, "절대경로 파일 미생성");
  // deep 탈출이 어디 떨어지든 마커명으로 광역 부재 확인(tmp 루트).
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "WH_EVIL_DEEP.txt")), false, "deep 탈출 파일 미생성");

  // 프로세스 생존.
  assert.equal(parseToolResult(await b.callTool("wormhole_status")).isError, false, "B 생존");
});

const BLOB_MAGIC = Buffer.from("CSZ1", "ascii");

test("SMR-09: 악성 원격 settings blob(__proto__) → pull Object.prototype 무오염", async (t) => {
  const dav = await startWebdav();
  const homeA = makeHome({
    label: "smr9A", remoteUrl: dav.url,
    files: { ".claude/CLAUDE.md": "x\n", ".claude/settings.json": JSON.stringify({ theme: "dark" }) },
  });
  const a = new McpClient(childEnv(homeA.homeDir, homeA.configPath, dav.url)).spawn();
  await a.initialize();
  await a.callTool("wormhole_sync", { confirm: true });
  await a.close();

  // 악성 settings 평문(신뢰불가 원격) — __proto__/constructor 오염 페이로드.
  const evilText = JSON.stringify({
    theme: "evil",
    __proto__: { polluted: "SMR09_PWNED" },
    constructor: { prototype: { polluted2: "Y" } },
  });
  const evilBuf = Buffer.from(evilText, "utf-8");
  const settingsKey = ".claude/settings.json";

  // blob 교체: encrypt(CSZ1 + gzip(평문)).
  const { crypto, manifest } = await openManifest(dav.store);
  const tagged = Buffer.concat([BLOB_MAGIC, gzipSync(evilBuf)]);
  const armoredBlob = await crypto.encrypt(new Uint8Array(tagged));
  dav.store.set(`/wormhole/blobs/${blobName(settingsKey)}`, {
    body: Buffer.from(armoredBlob, "utf8"), etag: '"evil-blob"', type: "file", mtime: Date.now(),
  });
  // manifest contentHash 를 악성 평문 해시로 맞춰 무결성 검사 통과시킴 + generation 전진.
  manifest.entries[settingsKey].contentHash = sha256(evilBuf);
  manifest.entries[settingsKey].generation = (manifest.entries[settingsKey].generation ?? 0) + 1;
  manifest.manifestGeneration += 1;
  await writeManifest(dav.store, crypto, manifest);

  // 머신 B(신규) pull.
  const homeB = makeHome({ label: "smr9B", remoteUrl: dav.url });
  const b = new McpClient(childEnv(homeB.homeDir, homeB.configPath, dav.url)).spawn();
  t.after(async () => { await b.close(); await dav.close(); rmrf(homeA.homeDir); rmrf(homeB.homeDir); });
  await b.initialize();

  const pull = parseToolResult(await b.callTool("wormhole_sync", { confirm: true }));
  assert.equal(pull.isError, false, "sync graceful");

  // ★Object.prototype 무오염 (이 테스트 런타임에서 직접 프로브).
  assert.equal(({} as any).polluted, undefined, "({}).polluted undefined");
  assert.equal(({} as any).polluted2, undefined, "({}).polluted2 undefined");
  assert.ok(!Object.getOwnPropertyNames(Object.prototype).includes("polluted"), "Object.prototype 무오염");

  // B 로컬 settings.json 에 __proto__ 자기프로퍼티 없음(무해 키는 머지될 수 있음).
  if (fs.existsSync(path.join(homeB.homeDir, ".claude/settings.json"))) {
    const raw = fs.readFileSync(path.join(homeB.homeDir, ".claude/settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, "__proto__"), "settings 자기 __proto__ 부재");
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, "constructor"), "settings 자기 constructor 부재");
  }
  assert.equal(parseToolResult(await b.callTool("wormhole_status")).isError, false, "B 생존");
});
