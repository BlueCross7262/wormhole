import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ManifestStore } from "./manifest.js";
import type { RemoteStore } from "../webdav/client.js";
import type { AgeCrypto } from "../crypto/age.js";
import type { Config, Manifest, ReasonsRef } from "../types.js";

const MACHINE_A = "machine-a";
const MACHINE_B = "machine-b";
const NOW = 1_700_000_000_000;

function makeHash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function makeRef(over: Partial<ReasonsRef> = {}): ReasonsRef {
  return { hash: makeHash(7), count: 2, lastGeneration: 1, ...over };
}

async function readAsRemote(manifest: unknown): Promise<Manifest | null> {
  const text = JSON.stringify(manifest);
  const remote = {
    async getTextWithETag(): Promise<{ text: string; etag: string | null }> {
      return { text, etag: '"e1"' };
    },
  } as unknown as RemoteStore;
  const crypto = {
    async decryptToString(armored: string): Promise<string> {
      return armored;
    },
  } as unknown as AgeCrypto;
  const config = {
    remote: { url: "", username: "", password: "", remoteBaseDir: "/wh" },
  } as unknown as Config;
  const store = new ManifestStore(remote, crypto, config, [0]);
  return store.read();
}

function manifestWith(entryExtra: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    manifestGeneration: 3,
    updatedBy: MACHINE_A,
    updatedAt: NOW,
    entries: {
      "a.md": {
        contentHash: makeHash(1),
        size: 10,
        mtimeMs: NOW,
        generation: 1,
        lastModifiedBy: MACHINE_A,
        deleted: false,
        deletedAt: null,
        ...entryExtra,
      },
    },
  };
}

describe("매니페스트 스키마 — reasonsRef", () => {
  test("정상 reasonsRef 를 읽는다", async () => {
    const m = await readAsRemote(manifestWith({ reasonsRef: makeRef() }));
    assert.deepEqual(m!.entries["a.md"]!.reasonsRef, makeRef());
  });

  test("hash 형식이 틀리면 reasonsRef 만 버리고 매니페스트는 통과한다", async () => {
    const m = await readAsRemote(manifestWith({ reasonsRef: makeRef({ hash: "zz" }) }));
    const entry = m!.entries["a.md"]!;
    assert.equal(entry.reasonsRef, undefined);
    assert.equal(entry.contentHash, makeHash(1));
    assert.equal(entry.generation, 1);
  });

  test("count 가 음수면 reasonsRef 만 버린다", async () => {
    const m = await readAsRemote(manifestWith({ reasonsRef: makeRef({ count: -1 }) }));
    assert.equal(m!.entries["a.md"]!.reasonsRef, undefined);
  });

  test("reasonsRef 가 객체가 아니어도 매니페스트는 통과한다", async () => {
    const m = await readAsRemote(manifestWith({ reasonsRef: "garbage" }));
    assert.equal(m!.entries["a.md"]!.reasonsRef, undefined);
  });

  test("reasonsRef 가 없는 매니페스트는 읽은 뒤 직렬화가 원문과 같다", async () => {
    const original = manifestWith({});
    const m = await readAsRemote(original);
    assert.equal(JSON.stringify(m), JSON.stringify(original));
    assert.equal("reasonsRef" in m!.entries["a.md"]!, false);
  });
});

describe("upsertEntry — reasonsRef 보존", () => {
  test("콘텐츠가 바뀌어도 기존 reasonsRef 를 옮긴다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    manifest.entries["a.md"] = { ...manifest.entries["a.md"]!, reasonsRef: makeRef() };

    const entry = ManifestStore.upsertEntry(manifest, "a.md", makeHash(2), 11, 101, MACHINE_B);

    assert.equal(entry.generation, 2);
    assert.deepEqual(entry.reasonsRef, makeRef());
  });

  test("콘텐츠 무변경 재push 에서도 보존한다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    manifest.entries["a.md"] = { ...manifest.entries["a.md"]!, reasonsRef: makeRef() };

    const entry = ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 999, MACHINE_A);

    assert.equal(entry.generation, 1);
    assert.deepEqual(entry.reasonsRef, makeRef());
  });

  test("tombstone 뒤 부활에서도 보존한다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    manifest.entries["a.md"] = { ...manifest.entries["a.md"]!, reasonsRef: makeRef() };
    ManifestStore.tombstoneEntry(manifest, "a.md", MACHINE_A);

    const entry = ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_B);

    assert.equal(entry.deleted, false);
    assert.deepEqual(entry.reasonsRef, makeRef());
  });

  test("reasonsRef 가 없던 엔트리에 키를 만들지 않는다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    const entry = ManifestStore.upsertEntry(manifest, "a.md", makeHash(2), 11, 101, MACHINE_A);
    assert.equal("reasonsRef" in entry, false);
  });

  test("tombstoneEntry 도 reasonsRef 를 유지한다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    manifest.entries["a.md"] = { ...manifest.entries["a.md"]!, reasonsRef: makeRef() };
    const entry = ManifestStore.tombstoneEntry(manifest, "a.md", MACHINE_B);
    assert.deepEqual(entry!.reasonsRef, makeRef());
  });
});
