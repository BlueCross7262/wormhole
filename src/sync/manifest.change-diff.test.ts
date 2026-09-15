import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ManifestStore } from "./manifest.js";
import { HARD_MAX_DIFF_BYTES } from "./change-diff.js";
import type { RemoteStore } from "../webdav/client.js";
import type { AgeCrypto } from "../crypto/age.js";
import type { ChangeDiff, Config, Manifest } from "../types.js";

const MACHINE_A = "machine-a";
const MACHINE_B = "machine-b";
const NOW = 1_700_000_000_000;
const REMOTE_BASE = "/wh";

function makeHash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function makeDiff(over: Partial<ChangeDiff> = {}): ChangeDiff {
  return {
    format: "unified",
    baseHash: null,
    contentHash: makeHash(2),
    added: 4,
    removed: 1,
    truncated: false,
    pruned: false,
    diffAt: NOW,
    text: "@@ -1 +1 @@\n-a\n+b\n",
    ...over,
  };
}

/** read() 실제 경로로 스키마를 검증한다. 원격 텍스트를 그대로 복호본으로 돌려주는 통과 crypto 사용. */
async function parseAsRemote(manifest: unknown): Promise<{ ok: boolean; error?: string }> {
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
    remote: { url: "", username: "", password: "", remoteBaseDir: REMOTE_BASE },
  } as unknown as Config;

  const store = new ManifestStore(remote, crypto, config, [0]);
  try {
    await store.read();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
}

describe("upsertEntry — changeDiff 후행 인자", () => {
  test("기존 6인자 호출은 동작이 바뀌지 않는다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    const entry = ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    assert.equal(entry.generation, 1);
    assert.equal(entry.changeDiff, undefined);
  });

  test("신규 엔트리의 baseHash 는 null 로 강제된다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    const entry = ManifestStore.upsertEntry(
      manifest,
      "a.md",
      makeHash(1),
      10,
      100,
      MACHINE_A,
      makeDiff({ baseHash: makeHash(9) }),
    );
    assert.equal(entry.changeDiff?.baseHash, null);
  });

  test("baseHash 는 직전 원격 엔트리의 contentHash 로 확정된다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    const prev = manifest.entries["a.md"]!;

    const entry = ManifestStore.upsertEntry(
      manifest,
      "a.md",
      makeHash(2),
      11,
      101,
      MACHINE_B,
      makeDiff({ baseHash: makeHash(77) }),
    );

    assert.equal(entry.generation, 2);
    assert.equal(entry.changeDiff?.baseHash, prev.contentHash);
    assert.equal(entry.changeDiff?.baseHash, makeHash(1));
  });

  test("콘텐츠 무변경 재push 는 기존 changeDiff 를 보존한다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    ManifestStore.upsertEntry(
      manifest,
      "a.md",
      makeHash(2),
      11,
      101,
      MACHINE_A,
      makeDiff({ text: "original\n" }),
    );
    const before = manifest.entries["a.md"]!.changeDiff;

    const entry = ManifestStore.upsertEntry(
      manifest,
      "a.md",
      makeHash(2),
      11,
      999,
      MACHINE_A,
      makeDiff({ text: "SHOULD-NOT-APPLY\n" }),
    );

    assert.equal(entry.generation, 2, "무변경이면 generation 그대로");
    assert.deepEqual(entry.changeDiff, before, "기존 diff 보존");
  });

  test("tombstone 부활은 changeDiff 를 새로 반영한다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    ManifestStore.tombstoneEntry(manifest, "a.md", MACHINE_A);

    const entry = ManifestStore.upsertEntry(
      manifest,
      "a.md",
      makeHash(1),
      10,
      100,
      MACHINE_B,
      makeDiff({ text: "revived\n" }),
    );

    assert.equal(entry.deleted, false);
    assert.equal(entry.changeDiff?.text, "revived\n");
  });
});

describe("tombstoneEntry — changeDiff", () => {
  test("baseHash 와 contentHash 가 모두 직전 해시다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(5), 10, 100, MACHINE_A);
    const prev = manifest.entries["a.md"]!.contentHash;

    const entry = ManifestStore.tombstoneEntry(
      manifest,
      "a.md",
      MACHINE_B,
      makeDiff({ format: "deleted", text: "", added: 0, removed: 3, baseHash: null }),
    );

    assert.ok(entry);
    assert.equal(entry!.deleted, true);
    assert.equal(entry!.changeDiff?.format, "deleted");
    assert.equal(entry!.changeDiff?.baseHash, prev);
    assert.equal(entry!.changeDiff?.contentHash, prev);
    assert.equal(entry!.changeDiff?.removed, 3);
  });

  test("엔트리가 없으면 null 이고 diff 도 만들지 않는다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    const entry = ManifestStore.tombstoneEntry(manifest, "ghost.md", MACHINE_A, makeDiff());
    assert.equal(entry, null);
    assert.equal(manifest.entries["ghost.md"], undefined);
  });

  test("이미 tombstone 이면 기존 엔트리를 그대로 돌려준다", () => {
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "a.md", makeHash(1), 10, 100, MACHINE_A);
    const first = ManifestStore.tombstoneEntry(manifest, "a.md", MACHINE_A, makeDiff());
    const second = ManifestStore.tombstoneEntry(manifest, "a.md", MACHINE_B, makeDiff());
    assert.equal(second, first);
  });
});

describe("매니페스트 스키마 — changeDiff 수용·거부", () => {
  function baseManifest(changeDiff?: unknown): Manifest {
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
          ...(changeDiff === undefined ? {} : { changeDiff }),
        },
      },
    } as unknown as Manifest;
  }

  test("changeDiff 없는 매니페스트를 그대로 받아들인다(하위호환)", async () => {
    const r = await parseAsRemote(baseManifest());
    assert.equal(r.ok, true, r.error);
  });

  test("정상 changeDiff 를 받아들인다", async () => {
    const r = await parseAsRemote(baseManifest(makeDiff()));
    assert.equal(r.ok, true, r.error);
  });

  test("text 가 하드 상한을 넘으면 거부한다", async () => {
    const r = await parseAsRemote(
      baseManifest(makeDiff({ text: "x".repeat(HARD_MAX_DIFF_BYTES + 1) })),
    );
    assert.equal(r.ok, false, "하드 상한 초과 매니페스트는 거부돼야 한다");
  });

  test("text 가 하드 상한과 같으면 받아들인다(경계)", async () => {
    const r = await parseAsRemote(baseManifest(makeDiff({ text: "x".repeat(HARD_MAX_DIFF_BYTES) })));
    assert.equal(r.ok, true, r.error);
  });

  test("format 이 enum 밖이면 거부한다", async () => {
    const r = await parseAsRemote(
      baseManifest(makeDiff({ format: "weird" as ChangeDiff["format"] })),
    );
    assert.equal(r.ok, false, "미지정 format 은 거부돼야 한다");
  });

  test("added 가 음수면 거부한다", async () => {
    const r = await parseAsRemote(baseManifest(makeDiff({ added: -1 })));
    assert.equal(r.ok, false, "음수 카운트는 거부돼야 한다");
  });

  test("pruned 필드가 없으면 거부한다(필수 필드)", async () => {
    const { pruned: _omit, ...withoutPruned } = makeDiff();
    const r = await parseAsRemote(baseManifest(withoutPruned));
    assert.equal(r.ok, false, "필수 필드 누락은 거부돼야 한다");
  });
});
