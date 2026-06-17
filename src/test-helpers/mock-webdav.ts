// In-memory WebDAV mock — replaces RemoteStore for integration tests.
// Backed by a single Map so multiple SyncEngine instances (replicas) can share one
// "remote" without any real network. Implements the exact subset of RemoteStore that
// SyncEngine / ManifestStore / RemoteLock call, plus the rest of the public surface so
// it can be cast to RemoteStore. ETags are tracked so conditional PUT (If-Match /
// If-None-Match) behaves like a real CAS-capable WebDAV server.

import { PreconditionFailedError } from "../webdav/client.js";
import type { RemoteStore } from "../webdav/client.js";
import type { RemoteEntry } from "../types.js";

interface StoredObject {
  data: Buffer;
  etag: string;
}

export interface MockCallCounts {
  putAtomic: number;
  put: number;
  putIfMatch: number;
  putIfNoneMatch: number;
  getTextWithETag: number;
  getTextIfExists: number;
  deleteFile: number;
  list: number;
}

function toBuffer(data: string | Buffer): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
}

/**
 * In-memory remote store backing a Map<path, {data, etag}>.
 * Construct fresh per "remote"; share one instance across replicas to simulate convergence.
 */
export class MockWebdavRemote {
  private readonly store = new Map<string, StoredObject>();
  private etagSeq = 0;

  /** Per-method call counters — assert idempotency / no-op behavior in tests. */
  readonly calls: MockCallCounts = {
    putAtomic: 0,
    put: 0,
    putIfMatch: 0,
    putIfNoneMatch: 0,
    getTextWithETag: 0,
    getTextIfExists: 0,
    deleteFile: 0,
    list: 0,
  };

  private nextEtag(): string {
    this.etagSeq += 1;
    return `"etag-${this.etagSeq}"`;
  }

  /** Test-only: snapshot of all stored paths (sorted). */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  /** Test-only: does a path currently exist in the remote. */
  has(path: string): boolean {
    return this.store.has(path);
  }

  /** Test-only: raw bytes at a path, or null. */
  rawGet(path: string): Buffer | null {
    const obj = this.store.get(path);
    return obj ? Buffer.from(obj.data) : null;
  }

  // ── RemoteStore surface ────────────────────────────────────────

  async ensureDir(_path: string): Promise<void> {
    // No directory concept in the flat map — no-op.
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  async putAtomic(path: string, data: string | Buffer, _machineId: string): Promise<void> {
    this.calls.putAtomic += 1;
    this.store.set(path, { data: toBuffer(data), etag: this.nextEtag() });
  }

  async put(path: string, data: string | Buffer): Promise<void> {
    this.calls.put += 1;
    this.store.set(path, { data: toBuffer(data), etag: this.nextEtag() });
  }

  async getText(path: string): Promise<string> {
    const obj = this.store.get(path);
    if (!obj) throw Object.assign(new Error(`404: ${path}`), { status: 404 });
    return obj.data.toString("utf-8");
  }

  async getTextWithETag(path: string): Promise<{ text: string; etag: string | null } | null> {
    this.calls.getTextWithETag += 1;
    const obj = this.store.get(path);
    if (!obj) return null;
    return { text: obj.data.toString("utf-8"), etag: obj.etag };
  }

  async getTextIfExists(path: string): Promise<string | null> {
    this.calls.getTextIfExists += 1;
    const obj = this.store.get(path);
    return obj ? obj.data.toString("utf-8") : null;
  }

  async getBinary(path: string): Promise<Buffer> {
    const obj = this.store.get(path);
    if (!obj) throw Object.assign(new Error(`404: ${path}`), { status: 404 });
    return Buffer.from(obj.data);
  }

  async putIfMatch(
    path: string,
    data: string | Buffer,
    etag: string | null,
    _machineId: string,
  ): Promise<void> {
    this.calls.putIfMatch += 1;
    const obj = this.store.get(path);
    if (etag === null) {
      // Server-without-ETag fallback path: best-effort unconditional PUT.
      this.store.set(path, { data: toBuffer(data), etag: this.nextEtag() });
      return;
    }
    if (!obj || obj.etag !== etag) {
      throw new PreconditionFailedError(`If-Match failed: ${path}`, 412);
    }
    this.store.set(path, { data: toBuffer(data), etag: this.nextEtag() });
  }

  async putIfNoneMatch(path: string, data: string | Buffer, _machineId: string): Promise<void> {
    this.calls.putIfNoneMatch += 1;
    if (this.store.has(path)) {
      throw new PreconditionFailedError(`If-None-Match failed (exists): ${path}`, 412);
    }
    this.store.set(path, { data: toBuffer(data), etag: this.nextEtag() });
  }

  async deleteFile(path: string): Promise<void> {
    this.calls.deleteFile += 1;
    this.store.delete(path);
  }

  async list(path: string): Promise<RemoteEntry[]> {
    this.calls.list += 1;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const out: RemoteEntry[] = [];
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ basename: rest, filename: key, type: "file" });
    }
    return out;
  }

  async moveFile(from: string, to: string): Promise<void> {
    const obj = this.store.get(from);
    if (!obj) throw Object.assign(new Error(`404: ${from}`), { status: 404 });
    this.store.delete(from);
    this.store.set(to, { data: obj.data, etag: this.nextEtag() });
  }

  /** Cast to the concrete RemoteStore type expected by EngineDeps. */
  asRemoteStore(): RemoteStore {
    return this as unknown as RemoteStore;
  }
}
