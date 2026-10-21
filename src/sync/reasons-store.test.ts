import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as age from "age-encryption";

import { AgeCrypto } from "../crypto/age.js";
import { MockWebdavRemote } from "../test-helpers/mock-webdav.js";
import { ReasonStore } from "./reasons-store.js";
import { sealBlob } from "./blob-io.js";
import {
  REASON_LOG_MAX_BYTES,
  REASON_MAX_CHARS,
  REASON_VIEW_PER_KEY,
  REASON_VIEW_TOTAL_BYTES,
  encodeReasonLog,
  reasonBlobPath,
} from "./reasons.js";
import { sha256 } from "./hash.js";
import type { FileEntry, LogicalKey, Manifest, ReasonItem, SyncState } from "../types.js";

let crypto: AgeCrypto;

before(async () => {
  crypto = new AgeCrypto();
  await crypto.initWithIdentity(await age.generateIdentity());
});

function makeEntry(generation: number, over: Partial<FileEntry> = {}): FileEntry {
  return {
    contentHash: sha256(`content-${generation}`),
    size: 1,
    mtimeMs: 1,
    generation,
    lastModifiedBy: "machine-a",
    deleted: false,
    deletedAt: null,
    ...over,
  };
}

function makeManifest(entries: Record<string, FileEntry>): Manifest {
  return { schemaVersion: 1, manifestGeneration: 1, updatedBy: "machine-a", updatedAt: 1, entries };
}

function makeStore(remote: MockWebdavRemote, machineId = "machine-a"): ReasonStore {
  return new ReasonStore({ remote: remote.asRemoteStore(), crypto, machineId });
}

const KEY = ".claude/a.md" as LogicalKey;
const NOW = 1_700_000_000_000;
const always = () => null;

async function seed(store: ReasonStore, manifest: Manifest, key: LogicalKey, generation: number, reason: string) {
  manifest.entries[key] = { ...manifest.entries[key]!, generation };
  return store.apply(manifest, new Map([[key, { reason }]]), always, true, NOW + generation);
}

describe("ReasonStore.apply", () => {
  test("commit 이면 이력 blob 을 올리고 reasonsRef 를 매니페스트에 건다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(3) });

    const { outcome } = await store.apply(manifest, new Map([[KEY, { reason: "why" }]]), always, true, NOW);

    assert.deepEqual(outcome.recorded, [KEY]);
    const ref = manifest.entries[KEY]!.reasonsRef!;
    assert.equal(ref.count, 1);
    assert.equal(ref.lastGeneration, 3);
    assert.ok(remote.has(reasonBlobPath(KEY, ref.hash)));
    const loaded = await store.loadLog(KEY, ref);
    assert.equal(loaded.kind, "ok");
    if (loaded.kind === "ok") {
      assert.equal(loaded.items[0]!.reason, "why");
      assert.equal(loaded.items[0]!.generation, 3);
      assert.equal(loaded.items[0]!.machineId, "machine-a");
      assert.equal(loaded.items[0]!.contentHash, manifest.entries[KEY]!.contentHash);
    }
  });

  test("commit=false 는 아무것도 쓰지 않고 판정만 낸다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });

    const { outcome, replaced } = await store.apply(manifest, new Map([[KEY, { reason: "why" }]]), always, false, NOW);

    assert.deepEqual(outcome.recorded, [KEY]);
    assert.equal(manifest.entries[KEY]!.reasonsRef, undefined);
    assert.equal(remote.calls.putAtomic, 0);
    assert.deepEqual(replaced, []);
  });

  test("같은 이유를 다시 주면 unchanged 이고 쓰지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seed(store, manifest, KEY, 1, "why");
    const puts = remote.calls.putAtomic;

    const { outcome } = await store.apply(manifest, new Map([[KEY, { reason: "why" }]]), always, true, NOW + 50);

    assert.deepEqual(outcome.unchanged, [KEY]);
    assert.deepEqual(outcome.recorded, []);
    assert.equal(remote.calls.putAtomic, puts);
  });

  test("이유가 다르면 덧붙이고 옛 blob 경로를 replaced 로 돌려준다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seed(store, manifest, KEY, 1, "first");
    const oldRef = manifest.entries[KEY]!.reasonsRef!;

    const { outcome, replaced } = await seed(store, manifest, KEY, 2, "second");

    assert.deepEqual(outcome.recorded, [KEY]);
    const newRef = manifest.entries[KEY]!.reasonsRef!;
    assert.equal(newRef.count, 2);
    assert.equal(newRef.lastGeneration, 2);
    assert.deepEqual(replaced, [reasonBlobPath(KEY, oldRef.hash)]);
    assert.ok(remote.has(reasonBlobPath(KEY, oldRef.hash)), "삭제는 호출부가 커밋 뒤에 한다");
    assert.ok(remote.has(reasonBlobPath(KEY, newRef.hash)));
  });

  test("엔트리가 없으면 no-entry", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({});

    const { outcome } = await store.apply(manifest, new Map([[KEY, { reason: "why" }]]), always, true, NOW);

    assert.deepEqual(outcome.rejected, [{ logicalKey: KEY, code: "no-entry" }]);
  });

  test("eligible 이 코드를 주면 그 코드로 거부하고 쓰지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });

    const { outcome } = await store.apply(
      manifest,
      new Map([[KEY, { reason: "why" }]]),
      () => "stale-hash",
      true,
      NOW,
    );

    assert.deepEqual(outcome.rejected, [{ logicalKey: KEY, code: "stale-hash" }]);
    assert.equal(remote.calls.putAtomic, 0);
    assert.equal(manifest.entries[KEY]!.reasonsRef, undefined);
  });

  test("기존 이력 blob 읽기가 I/O 오류면 throw 하고 포인터와 원격을 바꾸지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seed(store, manifest, KEY, 1, "first");
    const ref = manifest.entries[KEY]!.reasonsRef!;
    const puts = remote.calls.putAtomic;

    const failing = remote.asRemoteStore();
    const wrapped = Object.create(failing) as typeof failing;
    wrapped.getTextIfExists = async () => {
      throw Object.assign(new Error("connection reset"), { status: 503 });
    };
    const flaky = new ReasonStore({ remote: wrapped, crypto, machineId: "machine-a" });
    manifest.entries[KEY] = { ...manifest.entries[KEY]!, generation: 2 };

    await assert.rejects(() => flaky.apply(manifest, new Map([[KEY, { reason: "second" }]]), always, true, NOW));

    assert.deepEqual(manifest.entries[KEY]!.reasonsRef, ref);
    assert.equal(remote.calls.putAtomic, puts);
  });

  test("기존 이력 blob 이 없으면 빈 이력에서 시작한다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({
      [KEY]: makeEntry(2, { reasonsRef: { hash: sha256("gone"), count: 3, lastGeneration: 1 } }),
    });

    const { outcome } = await store.apply(manifest, new Map([[KEY, { reason: "fresh" }]]), always, true, NOW);

    assert.deepEqual(outcome.recorded, [KEY]);
    assert.equal(manifest.entries[KEY]!.reasonsRef!.count, 1);
  });

  test("기존 이력 blob 이 손상됐으면 빈 이력에서 시작한다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const hash = sha256("whatever");
    await remote.putAtomic(reasonBlobPath(KEY, hash), "not an age armor", "m");
    const manifest = makeManifest({
      [KEY]: makeEntry(2, { reasonsRef: { hash, count: 3, lastGeneration: 1 } }),
    });

    const { outcome } = await store.apply(manifest, new Map([[KEY, { reason: "fresh" }]]), always, true, NOW);

    assert.deepEqual(outcome.recorded, [KEY]);
    assert.equal(manifest.entries[KEY]!.reasonsRef!.count, 1);
  });

  test("이력 평문이 상한을 넘게 되면 log-full", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const proto: ReasonItem = {
      generation: 1,
      machineId: "machine-a",
      at: NOW,
      contentHash: sha256("c"),
      reason: "x".repeat(REASON_MAX_CHARS),
    };
    const per = encodeReasonLog([proto]).plain.length;
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...proto, generation: i + 1 }));
    let n = Math.floor(REASON_LOG_MAX_BYTES / per);
    n += Math.floor((REASON_LOG_MAX_BYTES - encodeReasonLog(build(n)).plain.length) / (per + 3));
    const items = build(n);
    const { plain, hash } = encodeReasonLog(items);
    assert.ok(plain.length <= REASON_LOG_MAX_BYTES);
    assert.ok(plain.length + per + 3 > REASON_LOG_MAX_BYTES);
    await remote.putAtomic(reasonBlobPath(KEY, hash), await sealBlob(crypto, plain), "m");
    const manifest = makeManifest({
      [KEY]: makeEntry(n + 1, { reasonsRef: { hash, count: n, lastGeneration: n } }),
    });

    const { outcome } = await store.apply(
      manifest,
      new Map([[KEY, { reason: "y".repeat(REASON_MAX_CHARS) }]]),
      always,
      true,
      NOW,
    );

    assert.deepEqual(outcome.rejected, [{ logicalKey: KEY, code: "log-full" }]);
    assert.equal(manifest.entries[KEY]!.reasonsRef!.hash, hash);
  });
});

describe("ReasonStore.loadLog", () => {
  test("해시가 다르면 corrupt", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const real = encodeReasonLog([]);
    const claimed = sha256("claimed");
    await remote.putAtomic(reasonBlobPath(KEY, claimed), await sealBlob(crypto, real.plain), "m");

    const r = await store.loadLog(KEY, { hash: claimed, count: 0, lastGeneration: 0 });

    assert.equal(r.kind, "corrupt");
  });

  test("해제 크기가 상한을 넘으면 corrupt", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const huge = Buffer.alloc(REASON_LOG_MAX_BYTES + 1024, 0x61);
    const hash = sha256(huge);
    await remote.putAtomic(reasonBlobPath(KEY, hash), await sealBlob(crypto, huge), "m");

    const r = await store.loadLog(KEY, { hash, count: 1, lastGeneration: 1 });

    assert.equal(r.kind, "corrupt");
  });

  test("blob 이 없으면 missing", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const r = await store.loadLog(KEY, { hash: sha256("nope"), count: 1, lastGeneration: 1 });
    assert.equal(r.kind, "missing");
  });
});

describe("ReasonStore.collect", () => {
  async function seedKeys(store: ReasonStore, manifest: Manifest, keys: LogicalKey[], perKey: number, textLen: number) {
    for (const key of keys) {
      for (let g = 1; g <= perKey; g++) {
        await seed(store, manifest, key, g, `${key}-${g}-`.padEnd(textLen, "z"));
      }
    }
  }

  test("baseline 보다 큰 generation 항목만 돌려준다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seedKeys(store, manifest, [KEY], 3, 10);
    const state: SyncState = { [KEY]: { syncedHash: "h", syncedGeneration: 1 } };

    const out = await store.collect(manifest, [KEY], state);

    assert.deepEqual(out[KEY]!.items.map((i) => i.generation), [2, 3]);
    assert.equal(out[KEY]!.omitted, 0);
  });

  test("state 가 없으면 기준 0 이라 전부 보인다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seedKeys(store, manifest, [KEY], 2, 10);

    const out = await store.collect(manifest, [KEY], {});

    assert.equal(out[KEY]!.items.length, 2);
  });

  test("키당 최신 건수만 남기고 나머지는 omitted", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seedKeys(store, manifest, [KEY], REASON_VIEW_PER_KEY + 2, 10);

    const out = await store.collect(manifest, [KEY], {});

    assert.equal(out[KEY]!.items.length, REASON_VIEW_PER_KEY);
    assert.equal(out[KEY]!.omitted, 2);
    assert.equal(out[KEY]!.items.at(-1)!.generation, REASON_VIEW_PER_KEY + 2);
  });

  test("baseline 이 lastGeneration 이상이면 내려받지 않는다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const manifest = makeManifest({ [KEY]: makeEntry(1) });
    await seedKeys(store, manifest, [KEY], 2, 10);
    const before = remote.calls.getTextIfExists;

    const out = await store.collect(manifest, [KEY], { [KEY]: { syncedHash: "h", syncedGeneration: 2 } });

    assert.deepEqual(out, {});
    assert.equal(remote.calls.getTextIfExists, before);
  });

  test("총량 예산을 넘으면 그 키부터 items 를 비우고 omitted 만 남긴다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const keys = Array.from({ length: 8 }, (_, i) => `.claude/k${i}.md` as LogicalKey);
    const manifest = makeManifest(Object.fromEntries(keys.map((k) => [k, makeEntry(1)])));
    await seedKeys(store, manifest, keys, REASON_VIEW_PER_KEY, 2000);

    const out = await store.collect(manifest, keys, {});

    let used = 0;
    for (const k of keys) {
      const v = out[k]!;
      used += v.items.reduce((s, i) => s + Buffer.byteLength(i.reason), 0);
    }
    assert.ok(used <= REASON_VIEW_TOTAL_BYTES, `used=${used}`);
    const emptied = keys.filter((k) => out[k]!.items.length === 0);
    assert.ok(emptied.length >= 1, "예산 초과 키가 있어야 한다");
    for (const k of emptied) assert.ok(out[k]!.omitted > 0);
    const firstEmptied = keys.indexOf(emptied[0]!);
    for (const k of keys.slice(firstEmptied)) assert.equal(out[k]!.items.length, 0);
    for (const k of keys.slice(0, firstEmptied)) assert.equal(out[k]!.items.length, REASON_VIEW_PER_KEY);
  });

  test("한 키의 읽기가 I/O 오류면 그 키는 건수만 남기고 나머지 키는 돌려준다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const k1 = ".claude/a.md" as LogicalKey;
    const k2 = ".claude/b.md" as LogicalKey;
    const manifest = makeManifest({ [k1]: makeEntry(1), [k2]: makeEntry(1) });
    await seedKeys(store, manifest, [k1, k2], 1, 10);

    const base = remote.asRemoteStore();
    const wrapped = Object.create(base) as typeof base;
    wrapped.getTextIfExists = async (p: string) => {
      if (p.includes(`r-${sha256(k1)}`)) throw new Error("boom");
      return base.getTextIfExists(p);
    };
    const flaky = new ReasonStore({ remote: wrapped, crypto, machineId: "machine-a" });

    const out = await flaky.collect(manifest, [k1, k2], {});

    assert.deepEqual(out[k1], { items: [], omitted: 1 });
    assert.equal(out[k2]!.items.length, 1);
  });

  test("손상된 이력은 그 키의 items 를 비우고 건수만 남긴다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    const hash = sha256("bad");
    await remote.putAtomic(reasonBlobPath(KEY, hash), "garbage", "m");
    const manifest = makeManifest({
      [KEY]: makeEntry(1, { reasonsRef: { hash, count: 1, lastGeneration: 1 } }),
    });

    const out = await store.collect(manifest, [KEY], {});

    assert.deepEqual(out, { [KEY]: { items: [], omitted: 1 } });
  });
});

describe("ReasonStore.deleteReplaced", () => {
  test("경로를 지우고 실패는 삼킨다", async () => {
    const remote = new MockWebdavRemote();
    const store = makeStore(remote);
    await remote.putAtomic("blobs/r-x-y.age", "data", "m");

    await store.deleteReplaced(["blobs/r-x-y.age", "blobs/r-never.age"]);

    assert.equal(remote.has("blobs/r-x-y.age"), false);
  });
});
