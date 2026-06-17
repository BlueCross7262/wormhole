import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyKey, computeStatus } from "./diff.js";
import type {
  FileEntry,
  LocalFileState,
  Manifest,
  SyncState,
  DiffInput,
} from "../types.js";

// ── fixtures ──────────────────────────────────────────────

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    contentHash: "h-remote",
    size: 10,
    mtimeMs: 1000,
    generation: 1,
    lastModifiedBy: "machine-remote",
    deleted: false,
    deletedAt: null,
    ...overrides,
  };
}

function local(
  logicalKey: string,
  contentHash: string,
  overrides: Partial<LocalFileState> = {},
): LocalFileState {
  return {
    logicalKey,
    absPath: `/home/user/${logicalKey}`,
    contentHash,
    size: 10,
    mtimeMs: 1000,
    ...overrides,
  };
}

function manifestOf(entries: Record<string, FileEntry>): Manifest {
  return {
    schemaVersion: 1,
    manifestGeneration: 5,
    updatedBy: "machine-remote",
    updatedAt: 2000,
    entries,
  };
}

// classifyKey 시그니처:
//   (logicalKey, localHash, baseHash, remoteEntry, syncedGeneration)
// remoteEntry 의 deleted 가 true 면 콘텐츠 부재(remoteHash=null)로 취급.

describe("classifyKey — single-key 3-way 판정", () => {
  test("unchanged: local==base==remote", () => {
    const item = classifyKey("k", "h", "h", entry({ contentHash: "h" }), 1);
    assert.equal(item.kind, "unchanged");
    assert.equal(item.localHash, "h");
    assert.equal(item.baseHash, "h");
    assert.equal(item.remoteHash, "h");
    assert.equal(item.logicalKey, "k");
  });

  test("added: local present, base+remote absent", () => {
    // base 없음(null), remote 엔트리 없음(undefined) → 로컬만 새로 생김.
    const item = classifyKey("k", "hLocal", null, undefined, undefined);
    assert.equal(item.kind, "added");
    assert.equal(item.localHash, "hLocal");
    assert.equal(item.baseHash, null);
    assert.equal(item.remoteHash, null);
    assert.equal(item.remoteGeneration, null);
  });

  test("modified: local!=base, remote==base, base+remote present", () => {
    const item = classifyKey(
      "k",
      "hNew",
      "hOld",
      entry({ contentHash: "hOld" }),
      1,
    );
    assert.equal(item.kind, "modified");
    assert.equal(item.remoteHash, "hOld");
  });

  test("deleted: local absent (null), base present, remote==base", () => {
    // localChanged (null !== base) 이고 remoteChanged false, local 부재 → deleted.
    const item = classifyKey("k", null, "hOld", entry({ contentHash: "hOld" }), 1);
    assert.equal(item.kind, "deleted");
    assert.equal(item.localHash, null);
  });

  test("remoteAdded: remote present, base absent, local==base(absent)", () => {
    // local null, base null → localChanged false; remote 존재 → remoteChanged → remoteAdded.
    const item = classifyKey("k", null, null, entry({ contentHash: "hR" }), undefined);
    assert.equal(item.kind, "remoteAdded");
    assert.equal(item.remoteHash, "hR");
    assert.equal(item.remoteGeneration, 1);
  });

  test("remoteModified: remote!=base, local==base, base present", () => {
    const item = classifyKey(
      "k",
      "hOld",
      "hOld",
      entry({ contentHash: "hRemoteNew", generation: 2 }),
      1,
    );
    assert.equal(item.kind, "remoteModified");
    assert.equal(item.remoteHash, "hRemoteNew");
    assert.equal(item.remoteGeneration, 2);
  });

  test("remoteDeleted: remote tombstone, local still present == base", () => {
    // remote deleted=true → remoteHash null → remoteChanged(null!==base). local==base 그대로 존재.
    const item = classifyKey(
      "k",
      "hOld",
      "hOld",
      entry({ deleted: true, deletedAt: 3000 }),
      1,
    );
    assert.equal(item.kind, "remoteDeleted");
    assert.equal(item.remoteHash, null);
  });

  test("remote tombstone but local already absent → unchanged (no-op)", () => {
    // local null, base null → localChanged false. remote deleted → remoteHash null == base null → remoteChanged false.
    const item = classifyKey("k", null, null, entry({ deleted: true }), undefined);
    assert.equal(item.kind, "unchanged");
  });

  test("conflict: local!=base AND remote!=base AND local!=remote", () => {
    const item = classifyKey(
      "k",
      "hLocal",
      "hBase",
      entry({ contentHash: "hRemote" }),
      1,
    );
    assert.equal(item.kind, "conflict");
    assert.equal(item.localHash, "hLocal");
    assert.equal(item.remoteHash, "hRemote");
  });

  test("CRITICAL convergence: both changed from base but local==remote → converged, NOT conflict", () => {
    const item = classifyKey(
      "k",
      "hSame",
      "hBase",
      entry({ contentHash: "hSame" }),
      1,
    );
    assert.equal(item.kind, "converged");
    assert.notEqual(item.kind, "conflict");
  });

  test("convergence via simultaneous deletion: local absent + remote tombstone, base present → converged", () => {
    // localChanged (null!==base) AND remoteChanged (null!==base) AND localHash===remoteHash(both null) → converged.
    const item = classifyKey(
      "k",
      null,
      "hBase",
      entry({ deleted: true, deletedAt: 4000 }),
      1,
    );
    assert.equal(item.kind, "converged");
    assert.notEqual(item.kind, "conflict");
    assert.equal(item.localHash, null);
    assert.equal(item.remoteHash, null);
  });

  test("conflict where remote is a tombstone (deletion conflict): local modified, remote deleted", () => {
    // local!=base (modified), remote tombstone → remoteHash null != base → remoteChanged. local(hNew) != remote(null) → conflict.
    const item = classifyKey(
      "k",
      "hNew",
      "hBase",
      entry({ deleted: true }),
      1,
    );
    assert.equal(item.kind, "conflict");
    assert.equal(item.localHash, "hNew");
    assert.equal(item.remoteHash, null);
  });

  test("remoteGeneration reflects entry.generation even when remoteHash null (tombstone)", () => {
    const item = classifyKey(
      "k",
      "hOld",
      "hOld",
      entry({ deleted: true, generation: 7 }),
      1,
    );
    assert.equal(item.remoteGeneration, 7);
    assert.equal(item.remoteHash, null);
  });
});

// ── computeStatus: collectKeys + toLocalMap + summarize 를 간접 검증 ──

describe("computeStatus — full diff over manifests", () => {
  test("empty inputs → all-empty summary, no items", () => {
    const input: DiffInput = {
      local: [],
      manifest: null,
      state: {},
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.equal(status.items.length, 0);
    assert.equal(status.conflicts.length, 0);
    assert.equal(status.machineId, "me");
    assert.equal(status.manifestGeneration, null);
    assert.deepEqual(status.summary, {
      added: [],
      modified: [],
      deleted: [],
      remoteAdded: [],
      remoteModified: [],
      remoteDeleted: [],
      conflicts: [],
      unchanged: [],
      converged: [],
    });
  });

  test("collectKeys: union of local + manifest + state keys, sorted, deduped", () => {
    const input: DiffInput = {
      local: [local("b", "h"), local("a", "h")],
      manifest: manifestOf({ c: entry({ contentHash: "h" }), a: entry({ contentHash: "h" }) }),
      state: { d: { syncedHash: "h", syncedGeneration: 1 }, a: { syncedHash: "h", syncedGeneration: 1 } },
      machineId: "me",
    };
    const status = computeStatus(input);
    const keys = status.items.map((i) => i.logicalKey);
    assert.deepEqual(keys, ["a", "b", "c", "d"]);
  });

  test("manifestGeneration propagated from manifest", () => {
    const input: DiffInput = {
      local: [],
      manifest: manifestOf({}),
      state: {},
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.equal(status.manifestGeneration, 5);
  });

  test("mixed scenario: summarize buckets each category exactly", () => {
    // 키별 시나리오 구성:
    //  k_unchanged: local=base=remote = "h0"
    //  k_added:     local only
    //  k_modified:  local!=base, remote==base
    //  k_deleted:   local absent, base present, remote==base
    //  k_remoteAdded: remote only, no base/local
    //  k_remoteModified: remote!=base, local==base
    //  k_remoteDeleted:  remote tombstone, local==base present
    //  k_conflict:  local!=base, remote!=base, local!=remote
    //  k_converged: local!=base, remote!=base, local==remote
    const state: SyncState = {
      k_unchanged: { syncedHash: "h0", syncedGeneration: 1 },
      k_modified: { syncedHash: "hBase", syncedGeneration: 1 },
      k_deleted: { syncedHash: "hBase", syncedGeneration: 1 },
      k_remoteModified: { syncedHash: "hBase", syncedGeneration: 1 },
      k_remoteDeleted: { syncedHash: "hBase", syncedGeneration: 1 },
      k_conflict: { syncedHash: "hBase", syncedGeneration: 1 },
      k_converged: { syncedHash: "hBase", syncedGeneration: 1 },
    };
    const input: DiffInput = {
      local: [
        local("k_unchanged", "h0"),
        local("k_added", "hAdd"),
        local("k_modified", "hLocalNew"),
        // k_deleted: absent locally
        local("k_remoteModified", "hBase"),
        local("k_remoteDeleted", "hBase"),
        local("k_conflict", "hLocalX"),
        local("k_converged", "hSame"),
      ],
      manifest: manifestOf({
        k_unchanged: entry({ contentHash: "h0" }),
        k_modified: entry({ contentHash: "hBase" }),
        k_deleted: entry({ contentHash: "hBase" }),
        k_remoteAdded: entry({ contentHash: "hRA" }),
        k_remoteModified: entry({ contentHash: "hRemoteNew", generation: 2 }),
        k_remoteDeleted: entry({ deleted: true, deletedAt: 9000 }),
        k_conflict: entry({ contentHash: "hRemoteY" }),
        k_converged: entry({ contentHash: "hSame" }),
      }),
      state,
      machineId: "me",
    };
    const { summary } = computeStatus(input);
    assert.deepEqual(summary.unchanged, ["k_unchanged"]);
    assert.deepEqual(summary.added, ["k_added"]);
    assert.deepEqual(summary.modified, ["k_modified"]);
    assert.deepEqual(summary.deleted, ["k_deleted"]);
    assert.deepEqual(summary.remoteAdded, ["k_remoteAdded"]);
    assert.deepEqual(summary.remoteModified, ["k_remoteModified"]);
    assert.deepEqual(summary.remoteDeleted, ["k_remoteDeleted"]);
    assert.deepEqual(summary.conflicts, ["k_conflict"]);
    assert.deepEqual(summary.converged, ["k_converged"]);

    // 각 항목이 정확히 한 버킷에만 들어가는지 (총합 == 키 수)
    const total =
      summary.unchanged.length +
      summary.added.length +
      summary.modified.length +
      summary.deleted.length +
      summary.remoteAdded.length +
      summary.remoteModified.length +
      summary.remoteDeleted.length +
      summary.conflicts.length +
      summary.converged.length;
    assert.equal(total, 9);
  });

  test("conflict produces a ConflictItem with remote metadata", () => {
    const input: DiffInput = {
      local: [local("k", "hLocal")],
      manifest: manifestOf({
        k: entry({ contentHash: "hRemote", lastModifiedBy: "machine-x", generation: 3 }),
      }),
      state: { k: { syncedHash: "hBase", syncedGeneration: 1 } },
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.equal(status.conflicts.length, 1);
    const c = status.conflicts[0];
    assert.equal(c.logicalKey, "k");
    assert.equal(c.localHash, "hLocal");
    assert.equal(c.remoteHash, "hRemote");
    assert.equal(c.remoteMachineId, "machine-x");
    assert.equal(c.remoteGeneration, 3);
    assert.equal(c.isDeletionConflict, false);
  });

  test("deletion conflict: local modified, remote tombstone → isDeletionConflict true", () => {
    const input: DiffInput = {
      local: [local("k", "hLocalNew")],
      manifest: manifestOf({
        k: entry({ deleted: true, deletedAt: 1234, lastModifiedBy: "machine-x", generation: 4 }),
      }),
      state: { k: { syncedHash: "hBase", syncedGeneration: 1 } },
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.equal(status.conflicts.length, 1);
    const c = status.conflicts[0];
    assert.equal(c.isDeletionConflict, true);
    assert.equal(c.remoteHash, null);
    assert.equal(c.localHash, "hLocalNew");
  });

  test("converged at computeStatus level: NOT counted as conflict, no ConflictItem", () => {
    const input: DiffInput = {
      local: [local("k", "hSame")],
      manifest: manifestOf({ k: entry({ contentHash: "hSame" }) }),
      state: { k: { syncedHash: "hBase", syncedGeneration: 1 } },
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.deepEqual(status.summary.converged, ["k"]);
    assert.deepEqual(status.summary.conflicts, []);
    assert.equal(status.conflicts.length, 0);
  });

  test("local added + remote added (different keys) bucketed separately", () => {
    const input: DiffInput = {
      local: [local("onlyLocal", "hL")],
      manifest: manifestOf({ onlyRemote: entry({ contentHash: "hR" }) }),
      state: {},
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.deepEqual(status.summary.added, ["onlyLocal"]);
    assert.deepEqual(status.summary.remoteAdded, ["onlyRemote"]);
  });

  test("deleted both sides where base present but neither holds content → converged (simultaneous delete)", () => {
    // local absent, remote tombstone, base present.
    const input: DiffInput = {
      local: [],
      manifest: manifestOf({ k: entry({ deleted: true, deletedAt: 5000 }) }),
      state: { k: { syncedHash: "hBase", syncedGeneration: 1 } },
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.deepEqual(status.summary.converged, ["k"]);
    assert.deepEqual(status.summary.deleted, []);
    assert.deepEqual(status.summary.remoteDeleted, []);
  });

  test("determinism: same input twice yields identical items/summary", () => {
    const build = (): DiffInput => ({
      local: [local("b", "h"), local("a", "hX")],
      manifest: manifestOf({ a: entry({ contentHash: "hBase" }), b: entry({ contentHash: "h" }) }),
      state: { a: { syncedHash: "hBase", syncedGeneration: 1 }, b: { syncedHash: "h", syncedGeneration: 1 } },
      machineId: "me",
    });
    const s1 = computeStatus(build());
    const s2 = computeStatus(build());
    assert.deepEqual(s1.items, s2.items);
    assert.deepEqual(s1.summary, s2.summary);
  });

  test("toLocalMap last-wins on duplicate logicalKey in local array", () => {
    // local 배열에 동일 키 2개 → Map 이 마지막 값으로 덮어씀.
    const input: DiffInput = {
      local: [local("k", "hFirst"), local("k", "hSecond")],
      manifest: null,
      state: {},
      machineId: "me",
    };
    const status = computeStatus(input);
    assert.equal(status.items.length, 1);
    assert.equal(status.items[0].localHash, "hSecond");
  });
});
