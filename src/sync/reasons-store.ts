import type { AgeCrypto } from "../crypto/age.js";
import type { RemoteStore } from "../webdav/client.js";
import type {
  FileEntry,
  Logger,
  LogicalKey,
  MachineId,
  Manifest,
  ReasonItem,
  ReasonRejectCode,
  ReasonsOutcome,
  ReasonsRef,
  ReasonView,
  SyncState,
} from "../types.js";
import { IO_CONCURRENCY, mapLimit, openBlob, sealBlob, type BlobLimits } from "./blob-io.js";
import { sha256 } from "./hash.js";
import {
  REASON_BLOB_MAX_ARMORED,
  REASON_LOG_MAX_BYTES,
  REASON_VIEW_TOTAL_BYTES,
  appendReasonItem,
  buildReasonView,
  decodeReasonLog,
  encodeReasonLog,
  reasonBlobPath,
  reasonViewBytes,
  type ReasonWanted,
} from "./reasons.js";

export type ReasonLogResult =
  | { kind: "ok"; items: ReasonItem[] }
  | { kind: "missing" }
  | { kind: "corrupt" };

export type ReasonEligibility = (
  key: LogicalKey,
  entry: FileEntry,
  wanted: ReasonWanted,
) => ReasonRejectCode | null;

export interface ReasonStoreDeps {
  remote: RemoteStore;
  crypto: AgeCrypto;
  machineId: MachineId;
  logger?: Logger;
}

const LOG_LIMITS: BlobLimits = {
  maxArmored: REASON_BLOB_MAX_ARMORED,
  maxPlain: REASON_LOG_MAX_BYTES,
};

function byKey<T extends { logicalKey: string }>(a: T, b: T): number {
  return a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0;
}

export class ReasonStore {
  private readonly remote: RemoteStore;
  private readonly crypto: AgeCrypto;
  private readonly machineId: MachineId;
  private readonly logger?: Logger;

  constructor(deps: ReasonStoreDeps) {
    this.remote = deps.remote;
    this.crypto = deps.crypto;
    this.machineId = deps.machineId;
    this.logger = deps.logger;
  }

  async loadLog(key: LogicalKey, ref: ReasonsRef): Promise<ReasonLogResult> {
    const armored = await this.remote.getTextIfExists(reasonBlobPath(key, ref.hash));
    if (armored === null) return { kind: "missing" };
    try {
      const plain = await openBlob(this.crypto, armored, LOG_LIMITS);
      if (sha256(plain) !== ref.hash) return { kind: "corrupt" };
      const items = decodeReasonLog(plain);
      return items === null ? { kind: "corrupt" } : { kind: "ok", items };
    } catch {
      return { kind: "corrupt" };
    }
  }

  async apply(
    manifest: Manifest,
    wanted: Map<LogicalKey, ReasonWanted>,
    eligible: ReasonEligibility,
    commit: boolean,
    now: number,
  ): Promise<{ outcome: ReasonsOutcome; replaced: string[] }> {
    const recorded: LogicalKey[] = [];
    const unchanged: LogicalKey[] = [];
    const rejected: Array<{ logicalKey: LogicalKey; code: ReasonRejectCode }> = [];
    const replaced: string[] = [];

    await mapLimit([...wanted], IO_CONCURRENCY, async ([key, w]) => {
      const entry = manifest.entries[key];
      if (!entry) {
        rejected.push({ logicalKey: key, code: "no-entry" });
        return;
      }
      const code = eligible(key, entry, w);
      if (code) {
        rejected.push({ logicalKey: key, code });
        return;
      }

      let log: ReasonItem[] = [];
      if (entry.reasonsRef) {
        const loaded = await this.loadLog(key, entry.reasonsRef);
        if (loaded.kind === "ok") {
          log = loaded.items;
        } else {
          this.logger?.warn(`[reasons] 기존 이력을 쓸 수 없어 빈 이력에서 시작 ${key} (${loaded.kind})`);
        }
      }

      const item: ReasonItem = {
        generation: entry.generation,
        machineId: this.machineId,
        at: now,
        contentHash: entry.contentHash,
        reason: w.reason,
      };
      const appended = appendReasonItem(log, item);
      if (!appended.changed) {
        unchanged.push(key);
        return;
      }

      const { plain, hash } = encodeReasonLog(appended.items);
      if (plain.length > REASON_LOG_MAX_BYTES) {
        rejected.push({ logicalKey: key, code: "log-full" });
        return;
      }

      if (commit) {
        await this.putLog(reasonBlobPath(key, hash), plain);
        const old = entry.reasonsRef;
        manifest.entries[key] = {
          ...entry,
          reasonsRef: { hash, count: appended.items.length, lastGeneration: entry.generation },
        };
        if (old && old.hash !== hash) replaced.push(reasonBlobPath(key, old.hash));
      }
      recorded.push(key);
    });

    recorded.sort();
    unchanged.sort();
    rejected.sort(byKey);
    replaced.sort();
    return { outcome: { recorded, unchanged, rejected }, replaced };
  }

  async deleteReplaced(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        await this.remote.deleteFile(p);
      } catch (err) {
        this.logger?.warn(`[reasons] 옛 이력 blob 삭제 실패 ${p}: ${String((err as Error).message)}`);
      }
    }
  }

  async collect(
    manifest: Manifest,
    keys: LogicalKey[],
    state: SyncState,
  ): Promise<Record<LogicalKey, ReasonView>> {
    const sorted = [...new Set(keys)].sort();
    const out: Record<LogicalKey, ReasonView> = {};
    let used = 0;
    let exhausted = false;

    for (let i = 0; i < sorted.length; i += IO_CONCURRENCY) {
      const chunk = sorted.slice(i, i + IO_CONCURRENCY);
      if (exhausted) {
        for (const key of chunk) {
          const omitted = this.pendingCount(manifest, key, state);
          if (omitted > 0) out[key] = { items: [], omitted };
        }
        continue;
      }
      const views = await Promise.all(chunk.map((key) => this.viewFor(manifest, key, state)));
      chunk.forEach((key, j) => {
        const view = views[j];
        if (!view) return;
        const total = view.items.length + view.omitted;
        if (exhausted) {
          out[key] = { items: [], omitted: total };
          return;
        }
        const bytes = reasonViewBytes(view);
        if (used + bytes > REASON_VIEW_TOTAL_BYTES) {
          exhausted = true;
          out[key] = { items: [], omitted: total };
          return;
        }
        used += bytes;
        out[key] = view;
      });
    }
    return out;
  }

  private async putLog(relPath: string, plain: Buffer): Promise<void> {
    const armored = await sealBlob(this.crypto, plain);
    await this.remote.putAtomic(relPath, armored, this.machineId);
  }

  private pendingCount(manifest: Manifest, key: LogicalKey, state: SyncState): number {
    const ref = manifest.entries[key]?.reasonsRef;
    if (!ref) return 0;
    const base = state[key]?.syncedGeneration ?? 0;
    return ref.lastGeneration > base ? ref.count : 0;
  }

  private async viewFor(
    manifest: Manifest,
    key: LogicalKey,
    state: SyncState,
  ): Promise<ReasonView | null> {
    const ref = manifest.entries[key]?.reasonsRef;
    if (!ref) return null;
    const base = state[key]?.syncedGeneration ?? 0;
    if (ref.lastGeneration <= base) return null;
    try {
      const loaded = await this.loadLog(key, ref);
      if (loaded.kind !== "ok") {
        this.logger?.warn(`[reasons] 이력을 읽지 못해 건수만 남김 ${key} (${loaded.kind})`);
        return { items: [], omitted: this.pendingCount(manifest, key, state) };
      }
      return buildReasonView(loaded.items, base);
    } catch (err) {
      this.logger?.warn(`[reasons] 이력 조회 실패로 건수만 남김 ${key}: ${String((err as Error).message)}`);
      return { items: [], omitted: this.pendingCount(manifest, key, state) };
    }
  }
}
