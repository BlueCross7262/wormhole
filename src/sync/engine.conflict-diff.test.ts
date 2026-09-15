import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as age from "age-encryption";
import { applyPatch } from "diff";

import { SyncEngine } from "./engine.js";
import type { EngineDeps } from "./engine.js";
import { AgeCrypto } from "../crypto/age.js";
import type { Config, MachineId, ConflictDetail } from "../types.js";
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
  machineId: MachineId;
}

function mkTmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wh-cdf-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function makeReplica(remote: MockWebdavRemote, label: string, machineId: MachineId): Replica {
  const home = mkTmp(`${label}-home`);
  const config = {
    stateDir: path.join(home, ".claude-sync"),
    home,
    remote: { url: "http://mock.invalid", username: "", password: "", remoteBaseDir: "/claude-sync" },
    targets: { include: [".claude/**"], exclude: [] },
    syncMcpServers: [],
    conflictPolicy: "preserve-both",
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  } as unknown as Config;
  const deps: EngineDeps = {
    config,
    crypto: sharedCrypto,
    remote: remote.asRemoteStore(),
    machineId,
  };
  return { engine: new SyncEngine(deps), home, machineId };
}

async function writeHomeFile(r: Replica, key: string, content: string): Promise<void> {
  const abs = path.join(r.home, ...key.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function abs(r: Replica, key: string): string {
  return path.join(r.home, ...key.split("/"));
}

type Blocked = { aborted: true; reason: "conflicts"; conflicts: ConflictDetail[] };

const KEY = ".claude/doc.md";

describe("충돌 노출 — 양쪽 diff", () => {
  test("원격 diff 는 A 가 저장한 값, 로컬 diff 는 B 의 base→로컬 변경", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "a", "machine-a");
    const b = makeReplica(remote, "b", "machine-b");

    const shared = "l1\nl2\nl3\n";
    await writeHomeFile(a, KEY, shared);
    await a.engine.push();

    // B 가 공통 base 를 받아둔다.
    await b.engine.pull();

    // 양쪽이 같은 base 에서 서로 다르게 바꾼다.
    const aNext = "l1\nA-CHANGED\nl3\n";
    await writeHomeFile(a, KEY, aNext);
    await a.engine.push();

    const bNext = "l1\nl2\nl3\nB-ADDED\n";
    await writeHomeFile(b, KEY, bNext);

    const result = (await b.engine.syncAtomic({
      pluginsDir: b.home,
      policy: "preserve-both",
    })) as Blocked;

    assert.equal(result.aborted, true);
    assert.equal(result.reason, "conflicts");
    const c = result.conflicts.find((x) => x.logicalKey === KEY);
    assert.ok(c, "해당 키 충돌이 있어야 한다");

    const rd = c!.remoteChangeDiff;
    assert.ok(rd, "원격 diff 가 실려야 한다");
    assert.equal(rd!.format, "unified");
    assert.equal(applyPatch(shared, rd!.text), aNext, "원격 diff 는 A 의 변경을 담는다");

    const ld = c!.localChangeDiff;
    assert.ok(ld, "로컬 diff 가 실려야 한다");
    assert.equal(applyPatch(shared, ld!.text), bNext, "로컬 diff 는 B 의 변경을 담는다");
    assert.equal(ld!.added, 1);
    assert.equal(ld!.removed, 0);
  });

  test("settings.json 로컬 diff 는 키 순서·들여쓰기 잡음 없이 실제 변경만 담는다", async () => {
    const SETTINGS = ".claude/settings.json";
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "norm-a", "machine-a");
    const b = makeReplica(remote, "norm-b", "machine-b");

    const baseObj = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };
    await writeHomeFile(a, SETTINGS, JSON.stringify(baseObj, null, 2));
    await a.engine.push();
    await b.engine.pull();

    // A 는 gamma 를 바꾼다 → 원격 변경.
    await writeHomeFile(a, SETTINGS, JSON.stringify({ ...baseObj, gamma: 777 }, null, 2));
    await a.engine.push();

    // B 는 beta 만 바꾸되, 키 순서를 뒤집고 들여쓰기도 다르게 쓴다.
    // 정규화가 제대로 걸리면 diff 에는 beta 한 줄 변화만 남아야 한다.
    await writeHomeFile(
      b,
      SETTINGS,
      JSON.stringify({ epsilon: 5, delta: 4, gamma: 3, beta: 42, alpha: 1 }, null, 4),
    );

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    assert.equal(result.aborted, true, "settings.json 충돌로 차단돼야 한다");
    assert.equal((result as Blocked).reason, "conflicts");

    const c = (result as Blocked).conflicts.find((x) => x.logicalKey === SETTINGS);
    assert.ok(c, "settings.json 충돌이 보고돼야 한다");

    const ld = c!.localChangeDiff;
    assert.ok(ld, "로컬 diff 가 실려야 한다");
    assert.equal(ld!.added, 1, `beta 한 줄만 추가여야 한다 — 실제 diff:\n${ld!.text}`);
    assert.equal(ld!.removed, 1, `beta 한 줄만 삭제여야 한다 — 실제 diff:\n${ld!.text}`);
    assert.match(ld!.text, /\+\s*"beta": 42/);
    assert.doesNotMatch(ld!.text, /[-+]\s*"epsilon"/, "순서 차이가 diff 로 새면 안 된다");
  });

  test(".diff 사이드카가 생기고 기존 사이드카는 바이트 불변", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "sc-a", "machine-a");
    const b = makeReplica(remote, "sc-b", "machine-b");

    const JSON_KEY = ".claude/data.json";
    await writeHomeFile(a, JSON_KEY, '{"v":1}\n');
    await a.engine.push();
    await b.engine.pull();

    const aRemote = '{"v":2}\n';
    await writeHomeFile(a, JSON_KEY, aRemote);
    await a.engine.push();
    await writeHomeFile(b, JSON_KEY, '{"v":3}\n');

    const result = (await b.engine.syncAtomic({
      pluginsDir: b.home,
      policy: "preserve-both",
    })) as Blocked;

    const c = result.conflicts.find((x) => x.logicalKey === JSON_KEY);
    assert.ok(c);
    assert.ok(c!.diffPath, ".diff 경로가 실려야 한다");
    assert.ok(existsSync(c!.diffPath!), ".diff 파일이 있어야 한다");

    const diffBody = await fs.readFile(c!.diffPath!, "utf-8");
    assert.match(diffBody, /원격 변경/);
    assert.match(diffBody, /로컬 변경/);

    assert.ok(c!.copyPath, "기존 사이드카 경로도 있어야 한다");
    const sidecar = await fs.readFile(c!.copyPath!, "utf-8");
    assert.equal(sidecar, aRemote, "기존 사이드카는 원격 blob 평문 그대로여야 한다");
    JSON.parse(sidecar);
  });

  test(".diff 사이드카는 다음 push 대상에 잡히지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "scope-a", "machine-a");
    const b = makeReplica(remote, "scope-b", "machine-b");

    await writeHomeFile(a, KEY, "base\n");
    await a.engine.push();
    await b.engine.pull();
    await writeHomeFile(a, KEY, "remote\n");
    await a.engine.push();
    await writeHomeFile(b, KEY, "local\n");

    const blocked = (await b.engine.syncAtomic({
      pluginsDir: b.home,
      policy: "preserve-both",
    })) as Blocked;
    assert.ok(blocked.conflicts[0]?.diffPath);

    const status = await b.engine.status();
    const diffKeys = status.items
      .map((i) => i.logicalKey)
      .filter((k) => k.includes(".conflict-"));
    assert.deepEqual(diffKeys, [], "사이드카·diff 는 동기화 범위 밖이어야 한다");
  });

  test("원격 엔트리에 changeDiff 가 없어도(구버전 작성분) 예외 없이 null 로 실린다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "legacy-a", "machine-a");
    const b = makeReplica(remote, "legacy-b", "machine-b");

    await writeHomeFile(a, KEY, "base\n");
    await a.engine.push();
    await b.engine.pull();
    await writeHomeFile(a, KEY, "remote\n");
    await a.engine.push();

    // 구버전 머신이 쓴 것처럼 원격 매니페스트에서 changeDiff 를 제거한다.
    const store = remote.asRemoteStore();
    const got = await store.getTextWithETag("/claude-sync/manifest.json.age");
    const plain = JSON.parse(await sharedCrypto.decryptToString(got!.text));
    for (const entry of Object.values(plain.entries as Record<string, { changeDiff?: unknown }>)) {
      delete entry.changeDiff;
    }
    await store.putAtomic(
      "/claude-sync/manifest.json.age",
      await sharedCrypto.encrypt(JSON.stringify(plain)),
      "machine-a",
    );

    await writeHomeFile(b, KEY, "local\n");
    const result = (await b.engine.syncAtomic({
      pluginsDir: b.home,
      policy: "preserve-both",
    })) as Blocked;

    const c = result.conflicts.find((x) => x.logicalKey === KEY);
    assert.ok(c);
    assert.equal(c!.remoteChangeDiff, null, "구버전 작성분은 null");
    assert.ok(c!.localChangeDiff, "로컬 diff 는 그대로 계산된다");
  });

  test("로컬 파일이 사라진 삭제 충돌도 보고가 죽지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const a = makeReplica(remote, "missing-a", "machine-a");
    const b = makeReplica(remote, "missing-b", "machine-b");

    await writeHomeFile(a, KEY, "base\n");
    await a.engine.push();
    await b.engine.pull();
    await writeHomeFile(a, KEY, "remote-changed\n");
    await a.engine.push();

    await fs.rm(abs(b, KEY), { force: true });

    const result = await b.engine.syncAtomic({ pluginsDir: b.home, policy: "preserve-both" });
    assert.equal(result.aborted, true);
    const c = (result as Blocked).conflicts.find((x) => x.logicalKey === KEY);
    assert.ok(c, "삭제 충돌이 보고돼야 한다");
    assert.equal(c!.localChangeDiff?.format, "deleted");
  });
});
