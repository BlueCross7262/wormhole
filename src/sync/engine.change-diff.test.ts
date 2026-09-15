import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";
import { applyPatch } from "diff";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import { sha256 } from "./hash.js";
import { MAX_TOTAL_DIFF_BYTES } from "./change-diff.js";
import type { Config, MachineId, Manifest } from "../types.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";

let sharedIdentity: string;
let sharedCrypto: AgeCrypto;
const tmpDirs: string[] = [];

before(async () => {
  sharedIdentity = await age.generateIdentity();
  sharedCrypto = new AgeCrypto();
  await sharedCrypto.initWithIdentity(sharedIdentity);
});

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

interface Replica {
  engine: SyncEngine;
  home: string;
  stateDir: string;
  machineId: MachineId;
}

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-cd-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function buildConfig(home: string, stateDir: string): Config {
  return {
    stateDir,
    home,
    remote: { url: "http://mock.invalid", username: "", password: "", remoteBaseDir: "/claude-sync" },
    targets: { include: [".claude/**"], exclude: [] },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  } as unknown as Config;
}

function makeReplica(remote: MockWebdavRemote, label: string, machineId: MachineId): Replica {
  const home = mkTmp(`${label}-home`);
  const stateDir = path.join(home, ".claude-sync");
  const deps: EngineDeps = {
    config: buildConfig(home, stateDir),
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
  };
  return { engine: new SyncEngine(deps), home, stateDir, machineId };
}

async function writeHomeFile(r: Replica, key: string, content: string): Promise<void> {
  const abs = path.join(r.home, ...key.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function removeHomeFile(r: Replica, key: string): Promise<void> {
  await fs.rm(path.join(r.home, ...key.split("/")), { force: true });
}

/** 원격 매니페스트를 그 엔진의 crypto 로 직접 복호해 읽는다(엔진 내부 상태를 우회한 독립 확인). */
async function readRemoteManifest(remote: MockWebdavRemote): Promise<Manifest> {
  const store = remote.asRemoteStore();
  const got = await store.getTextWithETag("/claude-sync/manifest.json.age");
  assert.ok(got, "원격 매니페스트가 있어야 한다");
  const plain = await sharedCrypto.decryptToString(got!.text);
  return JSON.parse(plain) as Manifest;
}

const KEY = ".claude/note.md";

describe("push — changeDiff 기록", () => {
  test("첫 push 는 format=added, baseHash=null", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "add", "machine-a");

    await writeHomeFile(a, KEY, "l1\nl2\n");
    await a.engine.push();

    const m = await readRemoteManifest(remote);
    const d = m.entries[KEY]!.changeDiff;
    assert.ok(d, "changeDiff 가 있어야 한다");
    assert.equal(d!.format, "added");
    assert.equal(d!.baseHash, null);
    assert.equal(d!.added, 2);
    assert.equal(d!.removed, 0);
  });

  test("두번째 push 의 diff 는 base 에 적용하면 push 한 콘텐츠가 된다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "round", "machine-a");

    const first = "l1\nl2\nl3\n";
    await writeHomeFile(a, KEY, first);
    await a.engine.push();
    const gen1 = await readRemoteManifest(remote);

    const second = "l1\nCHANGED\nl3\nl4\n";
    await writeHomeFile(a, KEY, second);
    await a.engine.push();
    const gen2 = await readRemoteManifest(remote);

    const d = gen2.entries[KEY]!.changeDiff!;
    assert.equal(d.format, "unified");
    assert.equal(d.truncated, false);
    assert.equal(d.baseHash, gen1.entries[KEY]!.contentHash, "baseHash 는 직전 원격 해시");
    assert.equal(d.contentHash, sha256(Buffer.from(second, "utf-8")));
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.equal(applyPatch(first, d.text), second, "diff 본문이 실제 변화를 담아야 한다");
  });

  test("삭제 push 는 format=deleted 이고 baseHash=contentHash", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "del", "machine-a");

    await writeHomeFile(a, KEY, "gone1\ngone2\ngone3\n");
    await a.engine.push();
    const before = await readRemoteManifest(remote);
    const prevHash = before.entries[KEY]!.contentHash;

    await removeHomeFile(a, KEY);
    await a.engine.push();

    const after = await readRemoteManifest(remote);
    const entry = after.entries[KEY]!;
    assert.equal(entry.deleted, true);
    const d = entry.changeDiff!;
    assert.equal(d.format, "deleted");
    assert.equal(d.text, "");
    assert.equal(d.baseHash, prevHash);
    assert.equal(d.contentHash, prevHash);
    assert.equal(d.removed, 3);
  });

  test("변경 없는 재push 는 기존 changeDiff 를 유지한다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "noop", "machine-a");

    await writeHomeFile(a, KEY, "a\n");
    await a.engine.push();
    await writeHomeFile(a, KEY, "a\nb\n");
    await a.engine.push();
    const before = (await readRemoteManifest(remote)).entries[KEY]!.changeDiff;

    await a.engine.push();
    const after = (await readRemoteManifest(remote)).entries[KEY]!.changeDiff;
    assert.deepEqual(after, before);
  });

  test("매니페스트 총 diff 본문이 예산 안에 든다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "budget", "machine-a");

    // 키당 상한(4096B) x 다수 → 총량 예산을 넘기도록 충분히 만든다.
    const body = Array.from({ length: 300 }, (_, i) => `line-${i}-${"y".repeat(60)}`).join("\n");
    for (let i = 0; i < 80; i++) {
      await writeHomeFile(a, `.claude/bulk-${i}.md`, `${body}\n`);
    }
    await a.engine.push();

    const m = await readRemoteManifest(remote);
    let total = 0;
    let prunedCount = 0;
    for (const entry of Object.values(m.entries)) {
      const d = entry.changeDiff;
      if (!d) continue;
      total += Buffer.byteLength(d.text, "utf-8");
      if (d.pruned) {
        prunedCount++;
        assert.equal(d.text, "", "pruned 엔트리는 본문이 비어야 한다");
        assert.ok(d.added > 0, "pruned 여도 통계는 남아야 한다");
      }
    }
    assert.ok(total <= MAX_TOTAL_DIFF_BYTES, `총 diff 본문 ${total} <= ${MAX_TOTAL_DIFF_BYTES}`);
    assert.ok(prunedCount > 0, "예산을 넘겼으므로 prune 된 엔트리가 있어야 한다");
  });
});
