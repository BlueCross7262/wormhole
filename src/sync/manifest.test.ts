import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ManifestStore, ManifestConflictError, DEFAULT_CAS_RETRY_BACKOFF_MS } from "./manifest.js";
import { PreconditionFailedError } from "../webdav/client.js";
import type { RemoteStore } from "../webdav/client.js";
import type { AgeCrypto } from "../crypto/age.js";
import type { Manifest, FileEntry, Config } from "../types.js";

const MACHINE_A = "machine-a" as const;
const MACHINE_B = "machine-b" as const;

function makeHash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

describe("ManifestStore.empty", () => {
  test("schemaVersion is always 1", () => {
    const m = ManifestStore.empty(MACHINE_A);
    assert.equal(m.schemaVersion, 1);
  });

  test("manifestGeneration starts at 0", () => {
    const m = ManifestStore.empty(MACHINE_A);
    assert.equal(m.manifestGeneration, 0);
  });

  test("updatedBy reflects machineId", () => {
    const m = ManifestStore.empty(MACHINE_B);
    assert.equal(m.updatedBy, MACHINE_B);
  });

  test("entries is empty", () => {
    const m = ManifestStore.empty(MACHINE_A);
    assert.deepEqual(m.entries, {});
  });

  test("updatedAt is a recent timestamp", () => {
    const before = Date.now();
    const m = ManifestStore.empty(MACHINE_A);
    const after = Date.now();
    assert.ok(m.updatedAt >= before && m.updatedAt <= after);
  });
});

describe("ManifestStore.upsertEntry — new entry", () => {
  let manifest: Manifest;

  beforeEach(() => {
    manifest = ManifestStore.empty(MACHINE_A);
  });

  test("new entry gets generation 1", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "notes/foo.md", makeHash(1), 100, 1000, MACHINE_A,
    );
    assert.equal(entry.generation, 1);
  });

  test("new entry is not deleted", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "notes/foo.md", makeHash(1), 100, 1000, MACHINE_A,
    );
    assert.equal(entry.deleted, false);
    assert.equal(entry.deletedAt, null);
  });

  test("new entry fields match arguments", () => {
    const hash = makeHash(42);
    const entry = ManifestStore.upsertEntry(
      manifest, "doc.txt", hash, 512, 9999, MACHINE_B,
    );
    assert.equal(entry.contentHash, hash);
    assert.equal(entry.size, 512);
    assert.equal(entry.mtimeMs, 9999);
    assert.equal(entry.lastModifiedBy, MACHINE_B);
  });

  test("entry is stored in manifest.entries", () => {
    ManifestStore.upsertEntry(manifest, "a/b/c.md", makeHash(1), 1, 1, MACHINE_A);
    assert.ok("a/b/c.md" in manifest.entries);
  });

  test("multiple distinct keys coexist", () => {
    ManifestStore.upsertEntry(manifest, "x.md", makeHash(1), 1, 1, MACHINE_A);
    ManifestStore.upsertEntry(manifest, "y.md", makeHash(2), 2, 2, MACHINE_A);
    assert.equal(Object.keys(manifest.entries).length, 2);
  });
});

describe("ManifestStore.upsertEntry — content change increments generation", () => {
  let manifest: Manifest;

  beforeEach(() => {
    manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
  });

  test("different hash bumps generation to 2", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(2), 100, 2000, MACHINE_B,
    );
    assert.equal(entry.generation, 2);
  });

  test("different hash updates lastModifiedBy", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(2), 100, 2000, MACHINE_B,
    );
    assert.equal(entry.lastModifiedBy, MACHINE_B);
  });

  test("same hash does NOT increment generation", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(1), 100, 1500, MACHINE_B,
    );
    assert.equal(entry.generation, 1);
  });

  test("same hash preserves original lastModifiedBy", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(1), 100, 1500, MACHINE_B,
    );
    assert.equal(entry.lastModifiedBy, MACHINE_A);
  });

  test("generation increments monotonically across multiple changes", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(2), 1, 1, MACHINE_A);
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(3), 1, 1, MACHINE_A);
    const entry = ManifestStore.upsertEntry(manifest, "file.md", makeHash(4), 1, 1, MACHINE_A);
    assert.equal(entry.generation, 4);
  });
});

describe("ManifestStore.upsertEntry — tombstone resurrection", () => {
  let manifest: Manifest;

  beforeEach(() => {
    manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_A);
  });

  test("resurrect after tombstone increments generation", () => {
    const beforeGen = manifest.entries["file.md"].generation;
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(1), 100, 2000, MACHINE_B,
    );
    assert.equal(entry.generation, beforeGen + 1);
  });

  test("resurrected entry has deleted=false", () => {
    const entry = ManifestStore.upsertEntry(
      manifest, "file.md", makeHash(1), 100, 2000, MACHINE_B,
    );
    assert.equal(entry.deleted, false);
    assert.equal(entry.deletedAt, null);
  });
});

describe("ManifestStore.tombstoneEntry", () => {
  let manifest: Manifest;

  beforeEach(() => {
    manifest = ManifestStore.empty(MACHINE_A);
  });

  test("returns null for nonexistent key", () => {
    const result = ManifestStore.tombstoneEntry(manifest, "ghost.md", MACHINE_A);
    assert.equal(result, null);
  });

  test("tombstone increments generation by 1", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    const prev = manifest.entries["file.md"].generation;
    const entry = ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_B)!;
    assert.equal(entry.generation, prev + 1);
  });

  test("tombstone sets deleted=true", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    const entry = ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_A)!;
    assert.equal(entry.deleted, true);
  });

  test("tombstone sets deletedAt to a recent timestamp", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    const before = Date.now();
    const entry = ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_A)!;
    const after = Date.now();
    assert.ok(entry.deletedAt !== null);
    assert.ok(entry.deletedAt >= before && entry.deletedAt <= after);
  });

  test("tombstone updates lastModifiedBy", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    const entry = ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_B)!;
    assert.equal(entry.lastModifiedBy, MACHINE_B);
  });

  test("double tombstone returns existing entry unchanged (idempotent)", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_A);
    const gen1 = manifest.entries["file.md"].generation;
    const entry = ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_B)!;
    assert.equal(entry.generation, gen1);
    assert.equal(entry.deleted, true);
  });

  test("tombstoned key remains in entries map", () => {
    ManifestStore.upsertEntry(manifest, "file.md", makeHash(1), 100, 1000, MACHINE_A);
    ManifestStore.tombstoneEntry(manifest, "file.md", MACHINE_A);
    assert.ok("file.md" in manifest.entries);
  });
});

describe("Manifest JSON serialize/parse roundtrip (pure data model)", () => {
  function buildManifest(): Manifest {
    const m = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(m, "alpha.md", makeHash(1), 128, 5000, MACHINE_A);
    ManifestStore.upsertEntry(m, "beta.md", makeHash(2), 256, 6000, MACHINE_B);
    ManifestStore.tombstoneEntry(m, "beta.md", MACHINE_A);
    return m;
  }

  test("JSON.stringify then JSON.parse yields deepEqual object", () => {
    const original = buildManifest();
    const roundtripped = JSON.parse(JSON.stringify(original)) as Manifest;
    assert.deepEqual(roundtripped, original);
  });

  test("empty manifest roundtrips cleanly", () => {
    const original = ManifestStore.empty(MACHINE_A);
    const roundtripped = JSON.parse(JSON.stringify(original)) as Manifest;
    assert.deepEqual(roundtripped, original);
  });

  test("schemaVersion is preserved as 1 after roundtrip", () => {
    const m = buildManifest();
    const rt = JSON.parse(JSON.stringify(m)) as Manifest;
    assert.equal(rt.schemaVersion, 1);
  });

  test("manifestGeneration is preserved after roundtrip", () => {
    const m = buildManifest();
    m.manifestGeneration = 7;
    const rt = JSON.parse(JSON.stringify(m)) as Manifest;
    assert.equal(rt.manifestGeneration, 7);
  });

  test("all entry fields survive roundtrip", () => {
    const m = ManifestStore.empty(MACHINE_A);
    const hash = makeHash(99);
    ManifestStore.upsertEntry(m, "file.md", hash, 512, 8888, MACHINE_B);
    const rt = JSON.parse(JSON.stringify(m)) as Manifest;
    const e = rt.entries["file.md"];
    assert.equal(e.contentHash, hash);
    assert.equal(e.size, 512);
    assert.equal(e.mtimeMs, 8888);
    assert.equal(e.generation, 1);
    assert.equal(e.lastModifiedBy, MACHINE_B);
    assert.equal(e.deleted, false);
    assert.equal(e.deletedAt, null);
  });
});

describe("ManifestConflictError", () => {
  test("stores expected and actual", () => {
    const err = new ManifestConflictError(3, 5);
    assert.equal(err.expected, 3);
    assert.equal(err.actual, 5);
  });

  test("is instanceof Error", () => {
    const err = new ManifestConflictError(0, 1);
    assert.ok(err instanceof Error);
  });

  test("name is ManifestConflictError", () => {
    const err = new ManifestConflictError(null, null);
    assert.equal(err.name, "ManifestConflictError");
  });

  test("message mentions generation numbers", () => {
    const err = new ManifestConflictError(2, 7);
    assert.ok(err.message.includes("2"));
    assert.ok(err.message.includes("7"));
  });

  test("null expected and actual are preserved", () => {
    const err = new ManifestConflictError(null, null);
    assert.equal(err.expected, null);
    assert.equal(err.actual, null);
  });
});

describe("entry key set tracking", () => {
  test("upsert adds key, tombstone keeps key in entries", () => {
    const m = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(m, "k1", makeHash(1), 1, 1, MACHINE_A);
    ManifestStore.upsertEntry(m, "k2", makeHash(2), 1, 1, MACHINE_A);
    assert.equal(Object.keys(m.entries).length, 2);
    ManifestStore.tombstoneEntry(m, "k1", MACHINE_A);
    assert.equal(Object.keys(m.entries).length, 2);
    assert.equal(m.entries["k1"].deleted, true);
    assert.equal(m.entries["k2"].deleted, false);
  });

  test("live keys are those where deleted=false", () => {
    const m = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(m, "alive.md", makeHash(1), 1, 1, MACHINE_A);
    ManifestStore.upsertEntry(m, "dead.md", makeHash(2), 1, 1, MACHINE_A);
    ManifestStore.tombstoneEntry(m, "dead.md", MACHINE_A);
    const live = Object.entries(m.entries)
      .filter(([, e]) => !e.deleted)
      .map(([k]) => k);
    assert.deepEqual(live, ["alive.md"]);
  });
});

// ---------------------------------------------------------------------------
// ManifestStore.write — CAS commit point (create vs update, 412 -> conflict)
// ---------------------------------------------------------------------------
//
// write() drives two CAS layers (see manifest.ts):
//   1. generation pre-check: re-read remote, compare manifestGeneration to
//      expectedGeneration; mismatch -> ManifestConflictError (before any PUT).
//   2. ETag conditional PUT:
//        - remote absent (read() == null) -> putIfNoneMatch (create-only)
//        - remote present                 -> putIfMatch(lastEtag) (update)
//      a server-side precondition failure surfaces as PreconditionFailedError,
//      which write() converts into ManifestConflictError.
//
// These tests inject a tiny purpose-built in-memory fake remote (Map + etag
// counter) so create/update/412 are fully deterministic with no FS/network.
// mock-webdav.ts is deliberately NOT used here.

const REMOTE_BASE = "/wormhole";
const MANIFEST_PATH = `${REMOTE_BASE}/manifest.json.age`;

// Records each PUT the store performs, so tests can assert which CAS verb
// (create vs update) was chosen and with what arguments.
type PutCall =
  | { kind: "putIfNoneMatch"; path: string; data: string; machineId: string }
  | { kind: "putIfMatch"; path: string; data: string; etag: string | null; machineId: string };

// Minimal in-memory stand-in for the slice of RemoteStore that
// ManifestStore.read()/write() actually touch: getTextWithETag,
// putIfNoneMatch, putIfMatch. Backed by a Map keyed by path, with a
// monotonic etag counter so every successful write yields a fresh etag.
class FakeRemote {
  private readonly store = new Map<string, { data: string; etag: string }>();
  private etagCounter = 0;
  readonly puts: PutCall[] = [];
  // When set, the *next* putIfMatch rejects with a precondition failure,
  // simulating a stale-etag (HTTP 412) loss of the server-side CAS race.
  failNextPutIfMatch = false;
  // Same simulated-loss hook for the create path.
  failNextPutIfNoneMatch = false;
  // path -> remaining reads that still return a WEAK etag. Apache mod_dav emits
  // W/"..." for files modified within ~1s, then ages to a strong etag. While
  // weak, putIfMatch 412s under strong comparison regardless of the etag sent.
  private readonly weakReads = new Map<string, number>();

  // Seed a value as if it already exists remotely. Returns the assigned etag.
  seed(path: string, data: string): string {
    const etag = `etag-${this.etagCounter++}`;
    this.store.set(path, { data, etag });
    return etag;
  }

  // Out-of-band overwrite (another machine wrote between our read and put):
  // changes the stored etag so a later putIfMatch with the old etag is stale.
  rotateEtag(path: string): string {
    const cur = this.store.get(path);
    if (!cur) throw new Error(`rotateEtag: no value at ${path}`);
    const etag = `etag-${this.etagCounter++}`;
    this.store.set(path, { data: cur.data, etag });
    return etag;
  }

  // Simulate Apache mod_dav's weak-ETag window: the path returns a WEAK etag
  // for the next `reads` getTextWithETag calls, during which putIfMatch 412s;
  // afterwards it ages to a strong etag and CAS succeeds again.
  markWeak(path: string, reads: number): void {
    this.weakReads.set(path, reads);
  }

  // Out-of-band overwrite that advances the stored value AND its etag (models a
  // competing machine landing a new manifest generation between our read & put).
  overwrite(path: string, data: string): string {
    const etag = `etag-${this.etagCounter++}`;
    this.store.set(path, { data, etag });
    return etag;
  }

  currentEtag(path: string): string | null {
    return this.store.get(path)?.etag ?? null;
  }

  async getTextWithETag(
    path: string,
  ): Promise<{ text: string; etag: string | null } | null> {
    const cur = this.store.get(path);
    if (cur === undefined) return null;
    // Weak-ETag window: while weak, reads return a W/ etag and the value ages
    // one step per read until it becomes strong.
    const weakLeft = this.weakReads.get(path) ?? 0;
    if (weakLeft > 0) {
      this.weakReads.set(path, weakLeft - 1);
      return { text: cur.data, etag: `W/${cur.etag}` };
    }
    return { text: cur.data, etag: cur.etag };
  }

  async putIfNoneMatch(path: string, data: string, machineId: string): Promise<void> {
    this.puts.push({ kind: "putIfNoneMatch", path, data, machineId });
    if (this.failNextPutIfNoneMatch) {
      this.failNextPutIfNoneMatch = false;
      throw new PreconditionFailedError(
        `If-None-Match conflict (already exists): ${path}`,
        412,
      );
    }
    if (this.store.has(path)) {
      // Real create-only semantics: refuse to overwrite an existing resource.
      throw new PreconditionFailedError(`If-None-Match conflict: ${path}`, 412);
    }
    const etag = `etag-${this.etagCounter++}`;
    this.store.set(path, { data, etag });
  }

  async putIfMatch(
    path: string,
    data: string,
    etag: string | null,
    machineId: string,
  ): Promise<void> {
    this.puts.push({ kind: "putIfMatch", path, data, etag, machineId });
    if (this.failNextPutIfMatch) {
      this.failNextPutIfMatch = false;
      throw new PreconditionFailedError(
        `If-Match conflict (stale etag): ${path} expected=${etag}`,
        412,
      );
    }
    // Real servers use strong comparison: a WEAK current etag never matches, so
    // a freshly-written (weak) resource 412s regardless of the supplied etag.
    if ((this.weakReads.get(path) ?? 0) > 0) {
      throw new PreconditionFailedError(
        `If-Match conflict (weak etag): ${path}`,
        412,
      );
    }
    const cur = this.store.get(path);
    if (cur === undefined || cur.etag !== etag) {
      // Stale etag -> server-side CAS loss.
      throw new PreconditionFailedError(
        `If-Match conflict (stale etag): ${path} expected=${etag}`,
        412,
      );
    }
    const next = `etag-${this.etagCounter++}`;
    this.store.set(path, { data, etag: next });
  }
}

// Passthrough crypto: encrypt/decrypt are identity over the JSON string, so
// the manifest survives the write->read roundtrip with no age dependency.
// Only encrypt()/decryptToString() are exercised by write()/read().
class FakeCrypto {
  async encrypt(plaintext: string): Promise<string> {
    return plaintext;
  }
  async decryptToString(armored: string): Promise<string> {
    return armored;
  }
}

function makeConfig(): Config {
  return {
    remote: { url: "", username: "", password: "", remoteBaseDir: REMOTE_BASE },
  } as unknown as Config;
}

function makeStore(
  remote: FakeRemote,
  casBackoffMs: readonly number[] = [0, 0, 0, 0, 0],
): {
  store: ManifestStore;
  remote: FakeRemote;
} {
  const store = new ManifestStore(
    remote as unknown as RemoteStore,
    new FakeCrypto() as unknown as AgeCrypto,
    makeConfig(),
    casBackoffMs,
  );
  return { store, remote };
}

// Decodes whatever the fake stored (passthrough crypto) back into a Manifest.
function decodeStored(remote: FakeRemote): Manifest {
  const got = remote.currentEtag(MANIFEST_PATH);
  assert.ok(got !== null, "expected a manifest to be stored");
  // getTextWithETag is async; resolve synchronously via the store map by
  // round-tripping through the public reader instead.
  return JSON.parse(remote["store"].get(MANIFEST_PATH)!.data) as Manifest;
}

describe("ManifestStore.write — create path (putIfNoneMatch)", () => {
  test("writing when remote is empty uses putIfNoneMatch (create semantics)", async () => {
    const { store, remote } = makeStore(new FakeRemote());
    const manifest = ManifestStore.empty(MACHINE_A);

    // remote empty -> read() returns null -> expectedGeneration must be null.
    await store.write(manifest, null, MACHINE_A);

    assert.equal(remote.puts.length, 1);
    assert.equal(remote.puts[0].kind, "putIfNoneMatch");
    assert.equal(remote.puts[0].path, MANIFEST_PATH);
  });

  test("create bumps manifestGeneration 0 -> 1 and persists it", async () => {
    const { store, remote } = makeStore(new FakeRemote());
    const manifest = ManifestStore.empty(MACHINE_A); // generation 0

    const written = await store.write(manifest, null, MACHINE_A);

    assert.equal(written.manifestGeneration, 1);
    const persisted = decodeStored(remote);
    assert.equal(persisted.manifestGeneration, 1);
  });

  test("create stamps updatedBy = writer machineId", async () => {
    const { store, remote } = makeStore(new FakeRemote());
    const manifest = ManifestStore.empty(MACHINE_A);

    const written = await store.write(manifest, null, MACHINE_B);

    assert.equal(written.updatedBy, MACHINE_B);
    assert.equal(decodeStored(remote).updatedBy, MACHINE_B);
  });

  test("create does not mutate the caller's input manifest", async () => {
    const { store } = makeStore(new FakeRemote());
    const manifest = ManifestStore.empty(MACHINE_A);

    await store.write(manifest, null, MACHINE_A);

    // write() builds a fresh object via spread; caller's copy stays at gen 0.
    assert.equal(manifest.manifestGeneration, 0);
  });

  test("create persists entries payload intact", async () => {
    const { store, remote } = makeStore(new FakeRemote());
    const manifest = ManifestStore.empty(MACHINE_A);
    ManifestStore.upsertEntry(manifest, "notes/foo.md", makeHash(7), 100, 1000, MACHINE_A);

    await store.write(manifest, null, MACHINE_A);

    const persisted = decodeStored(remote);
    assert.equal(persisted.entries["notes/foo.md"].contentHash, makeHash(7));
    assert.equal(persisted.entries["notes/foo.md"].generation, 1);
  });
});

describe("ManifestStore.write — update path (putIfMatch)", () => {
  // Seeds an existing remote manifest at the given generation, then forces the
  // store to learn its etag via read() (which write() also does internally).
  async function seedExisting(remote: FakeRemote, generation: number): Promise<string> {
    const existing: Manifest = {
      ...ManifestStore.empty(MACHINE_A),
      manifestGeneration: generation,
    };
    return remote.seed(MANIFEST_PATH, JSON.stringify(existing));
  }

  test("writing over existing manifest uses putIfMatch with the prior etag", async () => {
    const remote = new FakeRemote();
    const priorEtag = await seedExisting(remote, 3);
    const { store } = makeStore(remote);

    // expectedGeneration must equal the remote's current generation (3).
    await store.write({ ...ManifestStore.empty(MACHINE_A), manifestGeneration: 3 }, 3, MACHINE_A);

    assert.equal(remote.puts.length, 1);
    const put = remote.puts[0];
    assert.equal(put.kind, "putIfMatch");
    assert.equal(put.kind === "putIfMatch" ? put.etag : null, priorEtag);
  });

  test("update bumps manifestGeneration by exactly 1", async () => {
    const remote = new FakeRemote();
    await seedExisting(remote, 5);
    const { store } = makeStore(remote);

    const written = await store.write(
      { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 5 },
      5,
      MACHINE_A,
    );

    assert.equal(written.manifestGeneration, 6);
    assert.equal(decodeStored(remote).manifestGeneration, 6);
  });

  test("update uses putIfMatch, never putIfNoneMatch", async () => {
    const remote = new FakeRemote();
    await seedExisting(remote, 2);
    const { store } = makeStore(remote);

    await store.write({ ...ManifestStore.empty(MACHINE_A), manifestGeneration: 2 }, 2, MACHINE_A);

    assert.ok(remote.puts.every((p) => p.kind === "putIfMatch"));
  });

  test("generation pre-check rejects a stale expectedGeneration before any PUT", async () => {
    const remote = new FakeRemote();
    await seedExisting(remote, 9); // remote is at gen 9
    const { store } = makeStore(remote);

    // Caller thinks remote is at gen 4 -> mismatch -> ManifestConflictError.
    await assert.rejects(
      () => store.write({ ...ManifestStore.empty(MACHINE_A), manifestGeneration: 4 }, 4, MACHINE_A),
      (err: unknown) => {
        assert.ok(err instanceof ManifestConflictError);
        assert.equal(err.expected, 4);
        assert.equal(err.actual, 9);
        return true;
      },
    );
    // Pre-check fails before the PUT layer: no put was attempted.
    assert.equal(remote.puts.length, 0);
  });
});

describe("ManifestStore.write — CAS conflict (412 -> ManifestConflictError)", () => {
  test("a competing writer that advances generation becomes ManifestConflictError", async () => {
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 3 };
    // Another machine lands generation 4 between our read and our PUT, so the
    // conditional PUT 412s and the in-write re-read observes the advance.
    class RacingRemote extends FakeRemote {
      private raced = false;
      override async putIfMatch(
        path: string,
        data: string,
        etag: string | null,
        machineId: string,
      ): Promise<void> {
        if (!this.raced) {
          this.raced = true;
          this.overwrite(
            path,
            JSON.stringify({ ...ManifestStore.empty(MACHINE_B), manifestGeneration: 4 }),
          );
        }
        return super.putIfMatch(path, data, etag, machineId);
      }
    }
    const remote = new RacingRemote();
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write({ ...existing }, 3, MACHINE_A),
      (err: unknown) => {
        assert.ok(
          err instanceof ManifestConflictError,
          "expected ManifestConflictError, got " + (err as Error)?.name,
        );
        // expected mirrors the caller's expectedGeneration; actual mirrors the
        // advanced generation observed during the in-write re-read.
        assert.equal(err.expected, 3);
        assert.equal(err.actual, 4);
        return true;
      },
    );
  });

  test("a real CAS conflict surfaces as ManifestConflictError, not raw PreconditionFailedError", async () => {
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 1 };
    class RacingRemote extends FakeRemote {
      private raced = false;
      override async putIfMatch(
        path: string,
        data: string,
        etag: string | null,
        machineId: string,
      ): Promise<void> {
        if (!this.raced) {
          this.raced = true;
          this.overwrite(
            path,
            JSON.stringify({ ...ManifestStore.empty(MACHINE_B), manifestGeneration: 2 }),
          );
        }
        return super.putIfMatch(path, data, etag, machineId);
      }
    }
    const remote = new RacingRemote();
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write({ ...existing }, 1, MACHINE_A),
      (err: unknown) => {
        assert.ok(!(err instanceof PreconditionFailedError));
        assert.ok(err instanceof ManifestConflictError);
        return true;
      },
    );
  });

  test("an out-of-band write advancing generation between read and put yields ManifestConflictError", async () => {
    // Faithful concurrent-writer simulation: between our read() and our PUT,
    // another machine lands a NEW generation (new data + new etag). Our PUT
    // 412s and the re-read observes the advanced generation -> real conflict.
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 2 };

    class RacingRemote extends FakeRemote {
      private raced = false;
      override async putIfMatch(
        path: string,
        data: string,
        etag: string | null,
        machineId: string,
      ): Promise<void> {
        if (!this.raced) {
          this.raced = true;
          this.overwrite(
            path,
            JSON.stringify({ ...ManifestStore.empty(MACHINE_B), manifestGeneration: 3 }),
          );
        }
        return super.putIfMatch(path, data, etag, machineId);
      }
    }
    const racing = new RacingRemote();
    racing.seed(MANIFEST_PATH, JSON.stringify(existing));
    const { store } = makeStore(racing);

    await assert.rejects(
      () => store.write({ ...existing }, 2, MACHINE_A),
      (err: unknown) => {
        assert.ok(err instanceof ManifestConflictError);
        assert.equal(err.actual, 3);
        return true;
      },
    );
  });

  test("putIfNoneMatch precondition failure (concurrent create) becomes ManifestConflictError", async () => {
    const remote = new FakeRemote();
    // Remote is empty at read time -> create path -> putIfNoneMatch, which we
    // force to 412 as if another machine created it first.
    remote.failNextPutIfNoneMatch = true;
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write(ManifestStore.empty(MACHINE_A), null, MACHINE_A),
      (err: unknown) => {
        assert.ok(err instanceof ManifestConflictError);
        assert.equal(err.expected, null);
        assert.equal(err.actual, null);
        return true;
      },
    );
  });

  test("non-precondition errors from the remote propagate unchanged", async () => {
    const remote = new FakeRemote();
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 1 };
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    const boom = new Error("network down");
    // Override putIfMatch to throw a generic (non-412) error.
    const original = remote.putIfMatch.bind(remote);
    remote.putIfMatch = async () => {
      void original;
      throw boom;
    };
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write({ ...existing }, 1, MACHINE_A),
      (err: unknown) => {
        // Only PreconditionFailedError is translated; everything else escapes.
        assert.ok(!(err instanceof ManifestConflictError));
        assert.equal(err, boom);
        return true;
      },
    );
  });
});

describe("ManifestStore.write — weak-ETag tolerance (Apache mod_dav)", () => {
  test("a weak-ETag 412 with unchanged generation is retried until the etag ages, then succeeds", async () => {
    const remote = new FakeRemote();
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 5 };
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    // The manifest reads back WEAK for the next 2 reads (freshly written),
    // forcing putIfMatch to 412 even though no other machine wrote.
    remote.markWeak(MANIFEST_PATH, 2);
    const { store } = makeStore(remote); // zero backoff -> instant retries

    const written = await store.write({ ...existing }, 5, MACHINE_A);

    assert.equal(written.manifestGeneration, 6);
    assert.equal(decodeStored(remote).manifestGeneration, 6);
    // The first attempt(s) 412'd on the weak etag; success required retrying.
    assert.ok(remote.puts.length >= 2, `expected retries, got ${remote.puts.length} put(s)`);
  });

  test("a weak-ETag that never ages exhausts retries and surfaces ManifestConflictError(expected,expected)", async () => {
    const remote = new FakeRemote();
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 5 };
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    // Weak for far more reads than the retry budget -> never ages in time.
    remote.markWeak(MANIFEST_PATH, 999);
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write({ ...existing }, 5, MACHINE_A),
      (err: unknown) => {
        // Surfaced as a conflict (not a raw precondition error); the tell-tale
        // of a false weak-412 is expected === actual.
        assert.ok(!(err instanceof PreconditionFailedError));
        assert.ok(err instanceof ManifestConflictError);
        assert.equal(err.expected, 5);
        assert.equal(err.actual, 5);
        return true;
      },
    );
    // The manifest was never overwritten (generation stays at 5).
    assert.equal(decodeStored(remote).manifestGeneration, 5);
  });

  test("a real conflict during the weak-retry loop fast-fails with the advanced generation", async () => {
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 5 };
    // Weak window active AND a competing machine lands generation 6 on the
    // second PUT attempt — the re-read must catch the advance and fast-fail.
    class WeakThenRacing extends FakeRemote {
      private putCalls = 0;
      override async putIfMatch(
        path: string,
        data: string,
        etag: string | null,
        machineId: string,
      ): Promise<void> {
        this.putCalls += 1;
        if (this.putCalls === 2) {
          this.overwrite(
            path,
            JSON.stringify({ ...ManifestStore.empty(MACHINE_B), manifestGeneration: 6 }),
          );
        }
        return super.putIfMatch(path, data, etag, machineId);
      }
    }
    const remote = new WeakThenRacing();
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    remote.markWeak(MANIFEST_PATH, 10);
    const { store } = makeStore(remote);

    await assert.rejects(
      () => store.write({ ...existing }, 5, MACHINE_A),
      (err: unknown) => {
        assert.ok(err instanceof ManifestConflictError);
        assert.equal(err.expected, 5);
        assert.equal(err.actual, 6);
        return true;
      },
    );
  });

  test("a transient strong-etag mismatch with unchanged generation is absorbed (retried, then succeeds)", async () => {
    // No weak window; instead the etag rotates once between read and PUT while
    // the generation stays the same. Under the new contract this is treated as
    // a benign transient and the retry (with the refreshed etag) succeeds.
    const existing: Manifest = { ...ManifestStore.empty(MACHINE_A), manifestGeneration: 7 };
    class RotateOnceRemote extends FakeRemote {
      private rotated = false;
      override async putIfMatch(
        path: string,
        data: string,
        etag: string | null,
        machineId: string,
      ): Promise<void> {
        if (!this.rotated) {
          this.rotated = true;
          this.rotateEtag(path); // etag changes but data/generation do not
        }
        return super.putIfMatch(path, data, etag, machineId);
      }
    }
    const remote = new RotateOnceRemote();
    remote.seed(MANIFEST_PATH, JSON.stringify(existing));
    const { store } = makeStore(remote);

    const written = await store.write({ ...existing }, 7, MACHINE_A);

    assert.equal(written.manifestGeneration, 8);
    assert.equal(decodeStored(remote).manifestGeneration, 8);
  });
});

describe("DEFAULT_CAS_RETRY_BACKOFF_MS budget", () => {
  test("weak-ETag CAS backoff outlasts the ~1s weak window yet stays well under the lock TTL", () => {
    const innerSum = DEFAULT_CAS_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    // Must comfortably outlast Apache mod_dav's observed ~1s weak-ETag window so
    // a freshly-written manifest ages to a strong etag before the budget runs out.
    assert.ok(innerSum >= 1500, `CAS backoff budget ${innerSum}ms too small for weak window`);
    // The whole push (incl. up to MAX_CAS_RETRIES outer re-runs in the engine)
    // runs inside the remote lock; keep the total far below the 30s lock TTL so no
    // other machine can steal the lock and advance the manifest mid-retry.
    const MAX_CAS_RETRIES = 3; // mirror of engine.ts const
    assert.ok(
      innerSum * MAX_CAS_RETRIES < 15_000,
      `CAS backoff budget ${innerSum}ms x${MAX_CAS_RETRIES} too close to lock TTL`,
    );
  });
});
