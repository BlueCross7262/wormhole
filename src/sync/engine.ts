// SyncEngine — push/pull/resolve/status 오케스트레이션.
// 안전장치: 로컬 원자적 쓰기(tmp→rename), 원격 원자적 쓰기(RemoteStore.putAtomic),
// pull 적용 전 backups/<runTs> 스냅샷 + 예외 시 롤백, state.json/base 갱신, 멱등.
// 동시성: 인프로세스 AsyncMutex + 원격 lock.json(withLock).
// settings.json 은 3-way 머지로 라우팅. CAS(ManifestConflictError) 재시도 내장.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type {
  Config,
  MachineId,
  Logger,
  SyncStatus,
  PushResult,
  PullResult,
  ResolveResult,
  ResolvePolicy,
  SyncRunOptions,
  SyncState,
  SyncBaseline,
  LocalFileState,
  ScannedFile,
  Manifest,
  FileEntry,
  ConflictItem,
  ConflictCopy,
  LogicalKey,
  Sha256Hex,
} from "../types.js";
import type { AgeCrypto } from "../crypto/age.js";
import type { RemoteStore } from "../webdav/client.js";
import { ManifestStore, ManifestConflictError, MANIFEST_FILE } from "./manifest.js";
import { computeStatus } from "./diff.js";
import { scanLocal } from "./scanner.js";
import { hashFile, sha256, blobName } from "./hash.js";
import { toOS, isSettingsKey, isMcpJsonKey, isClaudeJsonKey, isValidLogicalKey, isWithinHome } from "./paths.js";
import { AsyncMutex, RemoteLock, withLock } from "./lock.js";
import {
  threeWayMerge,
  normalizeSettingsForSync,
  stripSelfMcpServers,
  mergeMcpJsonForPull,
  normalizeClaudeJsonForSync,
  mergeClaudeJsonForPull,
  tokenizeHome,
  detokenizeHome,
} from "./settings-merge.js";

/** 의존성 주입 묶음. */
export interface EngineDeps {
  config: Config;
  crypto: AgeCrypto;
  remote: RemoteStore;
  machineId: MachineId;
  logger?: Logger;
  /** 매니페스트 갱신 CAS 의 weak-ETag 재시도 백오프(ms). 생략 시 production 기본값. 테스트 주입용. */
  casRetryBackoffMs?: readonly number[];
}

/** CAS 재시도 상한. */
const MAX_CAS_RETRIES = 3;

// 원자적 쓰기용 임시파일 이름 충돌 회피 카운터(같은 프로세스 동시 호출 대비).
let atomicWriteSeq = 0;

// 비동기 지연 헬퍼(CAS 재시도 백오프 등).
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// push/pull blob I/O 동시성 한계(외부 의존성 없음). 네트워크 왕복을 겹쳐 처리량 향상.
const IO_CONCURRENCY = 8;

// blob 포맷 버전 매직 — gzip 압축 blob 을 명시 식별(매직바이트 휴리스틱의 우연 충돌 방지).
const BLOB_MAGIC = Buffer.from("CSZ1", "ascii");
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// 동시성 제한 병렬 실행. JS 단일 스레드라 동기 구간(매니페스트 갱신·배열 push)은 원자적이며,
// await 경계(업/다운로드)만 겹친다. 결과는 사용하지 않으므로 순서 무관.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  let aborted = false;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (true) {
          // 한 워커가 실패하면 신규 항목 수령은 멈추되, 이미 진행 중인 fn 은 끝까지 완료시킨다.
          if (aborted) break;
          const i = next++;
          if (i >= items.length) break;
          try {
            await fn(items[i], i);
          } catch (err) {
            aborted = true;
            throw err;
          }
        }
      })(),
    );
  }
  // 조기 reject(Promise.all) 대신 모든 워커가 settle 될 때까지 대기 후 첫 실패를 전파한다.
  // 이로써 호출부의 catch/rollback 진입 시점에 모든 워커의 디스크 부작용·backedUp 등록이 끝나 있어
  // 롤백이 전체 집합을 복원한다(pull all-or-nothing 보존). detached 워커의 unhandledRejection 도 방지.
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
}

// 원격 유래 값(machineId/generation 등)을 파일명 접미사로 쓸 때 경로 컴포넌트로 새지 않게 정제.
// 경로 구분자/점/특수문자를 제거해 traversal·ADS·예약명 주입을 차단한다.
function sanitizeToken(s: unknown): string {
  const t = String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return t === "" ? "unknown" : t;
}

export class SyncEngine {
  private readonly config: Config;
  private readonly crypto: AgeCrypto;
  private readonly remote: RemoteStore;
  private readonly machineId: MachineId;
  private readonly logger?: Logger;

  private readonly manifestStore: ManifestStore;
  private readonly lock: RemoteLock;
  private readonly mutex: AsyncMutex;

  /** state.json 절대경로. */
  private readonly statePath: string;
  /** base 스냅샷 디렉터리. */
  private readonly baseDir: string;
  /** backups 루트 디렉터리. */
  private readonly backupsDir: string;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.crypto = deps.crypto;
    this.remote = deps.remote;
    this.machineId = deps.machineId;
    this.logger = deps.logger;

    this.manifestStore = new ManifestStore(
      this.remote,
      this.crypto,
      this.config,
      deps.casRetryBackoffMs,
    );
    this.lock = new RemoteLock(this.remote, this.config, this.machineId, this.logger);
    this.mutex = new AsyncMutex();

    this.statePath = path.join(this.config.stateDir, "state.json");
    this.baseDir = path.join(this.config.stateDir, "base");
    this.backupsDir = path.join(this.config.stateDir, "backups");
  }

  // ── 공개 API ────────────────────────────────────────────────

  /** 현재 동기화 상태 계산. 부수효과 없음. */
  async status(): Promise<SyncStatus> {
    const manifest = await this.manifestStore.read();
    const local = await this.scanWithHashes();
    const state = await this.readState();
    return computeStatus({ local, manifest, state, machineId: this.machineId });
  }

  /** 로컬→원격 push. mutex+원격락 경유, CAS 재시도 내장. dryRun 시 계획만. */
  async push(options?: SyncRunOptions): Promise<PushResult> {
    const dryRun = options?.dryRun ?? false;
    return this.mutex.runExclusive(async () => {
      if (dryRun) {
        return this.planPush();
      }
      return withLock(this.lock, () => this.runPushWithRetry());
    });
  }

  /** 원격→로컬 pull. fast-forward + tombstone + 충돌 정책. 백업/롤백. dryRun 시 계획만. */
  async pull(options?: SyncRunOptions): Promise<PullResult> {
    const dryRun = options?.dryRun ?? false;
    return this.mutex.runExclusive(async () => {
      if (dryRun) {
        return this.planPull();
      }
      return withLock(this.lock, () => this.runPull());
    });
  }

  async forceUpload(options?: SyncRunOptions): Promise<PushResult> {
    const dryRun = options?.dryRun ?? false;
    return this.mutex.runExclusive(async () => {
      if (dryRun) return this.planPush();
      return withLock(this.lock, async () => {
        await this.wipeRemoteData();
        await this.resetLocalState();
        return this.runPush();
      });
    });
  }

  async forceDownload(options?: SyncRunOptions): Promise<PullResult> {
    const dryRun = options?.dryRun ?? false;
    return this.mutex.runExclusive(async () => {
      if (dryRun) return this.planPull();
      return withLock(this.lock, () => this.runForceDownload());
    });
  }

  /** 충돌 해소. policy 생략 시 config.conflictPolicy. keys 생략 시 전체 충돌. */
  async resolve(
    policy?: ResolvePolicy,
    keys?: string[],
    options?: SyncRunOptions,
  ): Promise<ResolveResult> {
    const dryRun = options?.dryRun ?? false;
    const effective = policy ?? this.config.conflictPolicy;
    return this.mutex.runExclusive(async () => {
      if (dryRun) {
        return this.planResolve(effective, keys);
      }
      return withLock(this.lock, () => this.runResolve(effective, keys));
    });
  }

  // ── 로컬 상태/해시 ──────────────────────────────────────────

  /** scanLocal 결과에 콘텐츠 해시를 채워 LocalFileState[] 로 변환. */
  private async scanWithHashes(): Promise<LocalFileState[]> {
    const scanned = await scanLocal(this.config);
    const out: LocalFileState[] = [];
    for (const f of scanned) {
      let contentHash: string | null;
      let size = f.size;
      if (isSettingsKey(f.logicalKey) || isMcpJsonKey(f.logicalKey) || isClaudeJsonKey(f.logicalKey)) {
        // settings/.mcp.json/.claude.json 은 동기화 대상이 "정규화된 shared 부분" 이다.
        // 전체 파일 raw 해시가 아니라 push 가 저장하는 것과 동일한 정규화 콘텐츠 해시로 비교해야
        // 사용자 변경이 없을 때 unchanged 로 판정된다(영구 modified 루프 방지).
        let raw: string;
        try {
          raw = await fs.readFile(f.absPath, "utf-8");
        } catch {
          continue; // 스캔 후 삭제됨.
        }
        const norm = isSettingsKey(f.logicalKey)
          ? normalizeSettingsForSync(raw, this.config.settingsLocalKeys, this.config.home, this.config.templateSettingsKeys ?? [])
          : isClaudeJsonKey(f.logicalKey)
            ? normalizeClaudeJsonForSync(raw, this.config.home)
            : stripSelfMcpServers(raw, this.config.selfMcpServerNames, this.config.home);
        contentHash = norm.hash;
        size = norm.size;
      } else {
        contentHash = await hashFile(f.absPath);
      }
      if (contentHash === null) continue; // 스캔 후 삭제됨.
      out.push({
        logicalKey: f.logicalKey,
        absPath: f.absPath,
        contentHash,
        size,
        mtimeMs: f.mtimeMs,
      });
    }
    // 대소문자만 다른 키 충돌 감지(Win case-insensitive ↔ WSL case-sensitive 혼선 경고).
    // 자동 case-folding 은 Linux 에서 별개 파일을 잘못 병합하므로 하지 않고 경고만 남긴다.
    const seenLower = new Map<string, string>();
    for (const f of out) {
      const lc = f.logicalKey.toLowerCase();
      const prev = seenLower.get(lc);
      if (prev !== undefined && prev !== f.logicalKey) {
        this.logger?.warn(
          `[engine] 대소문자만 다른 키 충돌: '${prev}' vs '${f.logicalKey}' — 크로스OS 동기화 시 혼선 가능`,
        );
      } else {
        seenLower.set(lc, f.logicalKey);
      }
    }
    return out;
  }

  /** state.json 읽기. 없으면 빈 객체. */
  private async readState(): Promise<SyncState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      return JSON.parse(raw) as SyncState;
    } catch {
      return {};
    }
  }

  /** state.json 원자적 쓰기. */
  private async writeState(state: SyncState): Promise<void> {
    await this.atomicWriteFile(this.statePath, JSON.stringify(state, null, 2));
  }

  // ── push ────────────────────────────────────────────────────

  /** dryRun push 계획 — 실제 변경 없이 상태만 분류. */
  private async planPush(): Promise<PushResult> {
    const status = await this.status();
    const pushed: LogicalKey[] = [
      ...status.summary.added,
      ...status.summary.modified,
    ];
    const deleted = [...status.summary.deleted];
    return {
      dryRun: true,
      pushed,
      deleted,
      skipped: status.summary.unchanged.length,
      manifestGeneration: status.manifestGeneration,
      conflicts: status.conflicts,
    };
  }

  /** CAS 충돌 시 재시도하며 push 수행. */
  private async runPushWithRetry(): Promise<PushResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      try {
        return await this.runPush();
      } catch (err) {
        if (err instanceof ManifestConflictError) {
          lastErr = err;
          // 지수 백오프 + 지터 — 동시 경합 시 thundering-herd/livelock 방지.
          const backoff = Math.min(2000, 100 * 2 ** attempt) + Math.floor(Math.random() * 100);
          this.logger?.warn(
            `[engine] push CAS 충돌 — ${backoff}ms 후 재시도 ${attempt + 1}/${MAX_CAS_RETRIES}`,
          );
          await delay(backoff);
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("push CAS 재시도 소진");
  }

  /** push 1회 시도. CAS 실패 시 ManifestConflictError throw → 재시도 루프가 처리. */
  private async runPush(): Promise<PushResult> {
    const remoteManifest = await this.manifestStore.read();
    const manifest: Manifest =
      remoteManifest ?? ManifestStore.empty(this.machineId);
    const expectedGeneration = remoteManifest
      ? remoteManifest.manifestGeneration
      : null;

    const local = await this.scanWithHashes();
    const state = await this.readState();

    const status = computeStatus({
      local,
      manifest: remoteManifest,
      state,
      machineId: this.machineId,
    });

    const pushed: LogicalKey[] = [];
    const deleted: LogicalKey[] = [];
    let skipped = 0;

    const localMap = new Map<LogicalKey, LocalFileState>();
    for (const f of local) localMap.set(f.logicalKey, f);

    // settings.json / .mcp.json 라우팅 결과(정규화 콘텐츠/해시)를 미리 계산.
    const settingsOverride = await this.preparePushSettings(
      localMap,
      remoteManifest,
      state,
    );

    // 원자성 전략: blob 업로드(content-addressed, 멱등)와 매니페스트 in-memory 갱신을 먼저 하고,
    // 매니페스트 CAS 쓰기를 "커밋 지점" 으로 삼는다. 로컬 base 스냅샷/state 반영은 커밋 성공 후에만
    // 수행한다. 커밋 전 실패 → 원격/로컬 모두 무변경. 커밋 후 로컬 반영 실패 → 다음 실행이 자가복구.
    const postCommit: Array<() => Promise<void>> = [];
    const stateUpdates: Array<{ key: LogicalKey; remove: boolean; syncedHash: string; syncedGeneration: number }> = [];

    const uploadItems = status.items.filter(
      (i) => i.kind === "added" || i.kind === "modified",
    );
    const deleteItems = status.items.filter((i) => i.kind === "deleted");
    const convergedItems = status.items.filter((i) => i.kind === "converged");
    skipped = status.items.filter((i) => i.kind === "unchanged").length;

    // 업로드(네트워크 바운드)는 동시성 제한 병렬. upsertEntry/배열 push 는 동기 구간이라 안전.
    await mapLimit(uploadItems, IO_CONCURRENCY, async (item) => {
      const key = item.logicalKey;
      let content: Buffer | string;
      let contentHash: Sha256Hex;
      let size: number;
      let mtimeMs: number;
      if (isSettingsKey(key) || isMcpJsonKey(key) || isClaudeJsonKey(key)) {
        const ov = settingsOverride.get(key);
        if (!ov) {
          skipped++;
          return;
        }
        content = ov.content;
        contentHash = ov.contentHash;
        size = ov.size;
        mtimeMs = Date.now();
      } else {
        const f = localMap.get(key);
        if (!f) {
          skipped++;
          return;
        }
        content = await fs.readFile(f.absPath);
        contentHash = f.contentHash;
        size = f.size;
        mtimeMs = f.mtimeMs;
      }
      await this.uploadBlob(key, content);
      const entry = ManifestStore.upsertEntry(
        manifest,
        key,
        contentHash,
        size,
        mtimeMs,
        this.machineId,
      );
      const gen = entry.generation;
      const blobContent = content;
      postCommit.push(async () => {
        await this.writeBaseSnapshot(key, blobContent);
      });
      stateUpdates.push({ key, remove: false, syncedHash: contentHash, syncedGeneration: gen });
      pushed.push(key);
    });

    // 삭제(tombstone)는 네트워크 없는 동기 작업 — 순차 처리.
    for (const item of deleteItems) {
      const key = item.logicalKey;
      const entry = ManifestStore.tombstoneEntry(manifest, key, this.machineId);
      postCommit.push(async () => {
        await this.removeBaseSnapshot(key);
      });
      if (entry) {
        stateUpdates.push({ key, remove: false, syncedHash: "", syncedGeneration: entry.generation });
      } else {
        stateUpdates.push({ key, remove: true, syncedHash: "", syncedGeneration: 0 });
      }
      deleted.push(key);
    }

    // 변경/삭제/수렴 모두 없으면 매니페스트 쓰기 생략(멱등).
    if (pushed.length === 0 && deleted.length === 0 && convergedItems.length === 0) {
      return {
        dryRun: false,
        pushed,
        deleted,
        skipped,
        manifestGeneration: manifest.manifestGeneration,
        conflicts: status.conflicts,
      };
    }

    // 커밋 지점: 매니페스트 CAS 쓰기. push/delete 가 있을 때만 원격 반영.
    let writtenGeneration = manifest.manifestGeneration;
    if (pushed.length > 0 || deleted.length > 0) {
      const written = await this.manifestStore.write(
        manifest,
        expectedGeneration,
        this.machineId,
      );
      writtenGeneration = written.manifestGeneration;
    }

    // 커밋 이후 로컬 watermark 반영.
    const nextState: SyncState = { ...state };
    for (const thunk of postCommit) await thunk();
    for (const su of stateUpdates) {
      if (su.remove) {
        delete nextState[su.key];
      } else {
        nextState[su.key] = { syncedHash: su.syncedHash, syncedGeneration: su.syncedGeneration };
      }
    }
    // 수렴 항목 watermark 전진(전송 없음).
    await this.advanceConverged(convergedItems, nextState);
    await this.writeState(nextState);

    return {
      dryRun: false,
      pushed,
      deleted,
      skipped,
      manifestGeneration: writtenGeneration,
      conflicts: status.conflicts,
    };
  }

  /** settings.json push 시 원격 반영분(shared subset)을 산출. 충돌은 호출부에서 보고. */
  private async preparePushSettings(
    localMap: Map<LogicalKey, LocalFileState>,
    _remoteManifest: Manifest | null,
    _state: SyncState,
  ): Promise<Map<LogicalKey, { content: Buffer; contentHash: Sha256Hex; size: number }>> {
    const out = new Map<
      LogicalKey,
      { content: Buffer; contentHash: Sha256Hex; size: number }
    >();
    for (const [key, f] of localMap) {
      if (!isSettingsKey(key) && !isMcpJsonKey(key) && !isClaudeJsonKey(key)) continue;
      // scan 과 동일한 정규화 파이프라인을 사용해 contentHash 가 일치하도록 한다.
      //  - settings.json: 머신 고유키 제거 후 stableStringify (normalizeSettingsForSync)
      //  - .mcp.json: 자기 등록 항목 제거 후 stableStringify (stripSelfMcpServers)
      //  - .claude.json: mcpServers 서브트리만 추출 후 stableStringify (normalizeClaudeJsonForSync)
      let rawText: string;
      try {
        rawText = await fs.readFile(f.absPath, "utf-8");
      } catch {
        continue;
      }
      const norm = isSettingsKey(key)
        ? normalizeSettingsForSync(rawText, this.config.settingsLocalKeys, this.config.home, this.config.templateSettingsKeys ?? [])
        : isClaudeJsonKey(key)
          ? normalizeClaudeJsonForSync(rawText, this.config.home)
          : stripSelfMcpServers(rawText, this.config.selfMcpServerNames, this.config.home);
      const content = Buffer.from(norm.text, "utf-8");
      out.set(key, { content, contentHash: norm.hash, size: norm.size });
    }
    return out;
  }

  /** blob 업로드: <base>/blobs/<sha256(logicalKey)>.age (armored 암호문). */
  private async uploadBlob(key: LogicalKey, plaintext: Buffer | string): Promise<void> {
    const raw = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;
    // gzip 압축(비동기, 이벤트루프 양보) 후 버전 매직 prepend → age 암호화. contentHash 는 평문 기준이라 영향 없음.
    const compressed = await gzipAsync(raw);
    const tagged = Buffer.concat([BLOB_MAGIC, compressed]);
    const armored = await this.crypto.encrypt(new Uint8Array(tagged));
    await this.remote.putAtomic(`blobs/${blobName(key)}`, armored, this.machineId);
  }

  /** blob 다운로드+복호 → 평문 Buffer. 없으면 null. */
  private async downloadBlob(key: LogicalKey): Promise<Buffer | null> {
    const armored = await this.remote.getTextIfExists(`blobs/${blobName(key)}`);
    if (armored === null) return null;
    const plain = Buffer.from(await this.crypto.decrypt(armored));
    // CSZ1 매직이면 gzip 압축 blob → 매직 제거 후 해제. 아니면 레거시 비압축 blob 으로 그대로 반환(하위호환).
    if (
      plain.length >= BLOB_MAGIC.length &&
      plain.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)
    ) {
      return Buffer.from(await gunzipAsync(plain.subarray(BLOB_MAGIC.length)));
    }
    return plain;
  }

  // ── pull ────────────────────────────────────────────────────

  /** dryRun pull 계획. */
  private async planPull(): Promise<PullResult> {
    const status = await this.status();
    const applied: LogicalKey[] = [
      ...status.summary.remoteAdded,
      ...status.summary.remoteModified,
    ];
    const removed = [...status.summary.remoteDeleted];
    return {
      dryRun: true,
      applied,
      removed,
      conflicts: status.conflicts,
      backupDir: null,
    };
  }

  /** pull 1회 — fast-forward 적용 + tombstone 삭제 + 충돌 정책. 백업/롤백. */
  private async runPull(): Promise<PullResult> {
    const remoteManifest = await this.manifestStore.read();
    if (remoteManifest === null) {
      // 원격 매니페스트 부재 → 적용할 것 없음.
      return { dryRun: false, applied: [], removed: [], conflicts: [], backupDir: null };
    }

    const local = await this.scanWithHashes();
    const state = await this.readState();
    const status = computeStatus({
      local,
      manifest: remoteManifest,
      state,
      machineId: this.machineId,
    });

    const toApply = status.items.filter(
      (i) => i.kind === "remoteAdded" || i.kind === "remoteModified",
    );
    const toRemove = status.items.filter((i) => i.kind === "remoteDeleted");
    const convergedItems = status.items.filter((i) => i.kind === "converged");

    if (toApply.length === 0 && toRemove.length === 0 && convergedItems.length === 0) {
      // 충돌만 있을 수 있음 — 정책 적용은 resolve 가 담당, pull 은 보고만.
      return {
        dryRun: false,
        applied: [],
        removed: [],
        conflicts: status.conflicts,
        backupDir: null,
      };
    }

    const runTs = this.makeRunTs();
    const backupRoot = path.join(this.backupsDir, runTs);
    const applied: LogicalKey[] = [];
    const removed: LogicalKey[] = [];
    const nextState: SyncState = { ...state };
    // 롤백용 백업 매핑.
    const backedUp: Array<{ key: LogicalKey; absPath: string; backupPath: string | null }> = [];

    try {
      // 다운로드+적용(네트워크/IO 바운드)을 동시성 제한 병렬. 키별 nextState/배열 push 는 동기 구간이라 안전.
      await mapLimit(toApply, IO_CONCURRENCY, async (item) => {
        const key = item.logicalKey;
        const entry = remoteManifest.entries[key];
        if (!entry || entry.deleted) return;

        // 원격 키 경로 검증(탈출 방어). 유효하지 않으면 건너뜀.
        const absPath = this.safeAbsPath(key);
        if (absPath === null) return;

        const plain = await this.downloadBlob(key);
        if (plain === null) {
          this.logger?.warn(`[engine] pull: blob 부재로 건너뜀 ${key}`);
          return;
        }

        const backupPath = await this.backupFile(absPath, key, backupRoot);
        backedUp.push({ key, absPath, backupPath });

        if (isSettingsKey(key)) {
          await this.applyPullSettings(key, absPath, plain, entry, nextState);
        } else if (isMcpJsonKey(key)) {
          await this.applyPullMcpJson(key, absPath, plain, entry, nextState);
        } else if (isClaudeJsonKey(key)) {
          await this.applyPullClaudeJson(key, absPath, plain, entry, nextState);
        } else {
          await this.atomicWriteFile(absPath, plain);
          await this.writeBaseSnapshot(key, plain);
          nextState[key] = {
            syncedHash: entry.contentHash,
            syncedGeneration: entry.generation,
          };
        }
        applied.push(key);
      });

      await mapLimit(toRemove, IO_CONCURRENCY, async (item) => {
        const key = item.logicalKey;
        const entry = remoteManifest.entries[key];
        if (!entry) return;
        const absPath = this.safeAbsPath(key);
        if (absPath === null) return;
        const backupPath = await this.backupFile(absPath, key, backupRoot);
        backedUp.push({ key, absPath, backupPath });

        await this.deleteLocalFile(absPath);
        await this.removeBaseSnapshot(key);
        nextState[key] = {
          syncedHash: "",
          syncedGeneration: entry.generation,
        };
        removed.push(key);
      });

      // 수렴(converged) 항목은 전송 없이 base/state watermark 만 전진(거짓 충돌 방지).
      await this.advanceConverged(convergedItems, nextState);

      await this.writeState(nextState);
    } catch (err) {
      // 롤백: 백업본 복원.
      this.logger?.error(`[engine] pull 적용 중 오류 — 롤백 시도: ${String((err as Error).message)}`);
      await this.rollback(backedUp);
      throw err;
    }

    const hadBackup = backedUp.some((b) => b.backupPath !== null);
    return {
      dryRun: false,
      applied,
      removed,
      conflicts: status.conflicts,
      backupDir: hadBackup ? backupRoot : null,
    };
  }

  private async wipeRemoteData(): Promise<void> {
    const manifestFullPath = `${this.config.remote.remoteBaseDir.replace(/\/+$/, "")}/${MANIFEST_FILE}`;
    await this.remote.deleteFile(manifestFullPath);
    const blobs = await this.remote.list("blobs");
    await mapLimit(
      blobs.filter((e) => e.type === "file"),
      IO_CONCURRENCY,
      (e) => this.remote.deleteFile(`blobs/${e.basename}`),
    );
    // keyparams.json 은 의도적으로 보존 — 삭제 시 vault 복호 불능.
  }

  private async resetLocalState(): Promise<void> {
    await this.writeState({});
    await fs.rm(this.baseDir, { recursive: true, force: true });
  }

  private async runForceDownload(): Promise<PullResult> {
    const remoteManifest = await this.manifestStore.read();
    const local = await this.scanWithHashes();
    const runTs = this.makeRunTs();
    const backupRoot = path.join(this.backupsDir, runTs);
    const applied: LogicalKey[] = [];
    const removed: LogicalKey[] = [];
    const nextState: SyncState = {};
    const backedUp: Array<{ key: LogicalKey; absPath: string; backupPath: string | null }> = [];
    const remoteKeys = new Set<LogicalKey>();

    try {
      if (remoteManifest) {
        const entries = Object.entries(remoteManifest.entries).filter(([, e]) => !e.deleted);
        await mapLimit(entries, IO_CONCURRENCY, async ([key, entry]) => {
          remoteKeys.add(key as LogicalKey);
          const absPath = this.safeAbsPath(key as LogicalKey);
          if (absPath === null) return;
          const plain = await this.downloadBlob(key as LogicalKey);
          if (plain === null) {
            this.logger?.warn(`[engine] force-down: blob 부재 ${key}`);
            return;
          }
          const backupPath = await this.backupFile(absPath, key as LogicalKey, backupRoot);
          backedUp.push({ key: key as LogicalKey, absPath, backupPath });
          // 서버 무조건 적용: settings/.mcp.json 도 머지 없이 원격 raw 로 덮어쓴다.
          await this.atomicWriteFile(absPath, plain);
          await this.writeBaseSnapshot(key as LogicalKey, plain);
          nextState[key as LogicalKey] = {
            syncedHash: entry.contentHash,
            syncedGeneration: entry.generation,
          };
          applied.push(key as LogicalKey);
        });
      }

      // 미러 삭제: 원격에 없는 로컬 관리 파일 제거.
      const toDelete = local.filter((f) => !remoteKeys.has(f.logicalKey));
      await mapLimit(toDelete, IO_CONCURRENCY, async (f) => {
        const absPath = this.safeAbsPath(f.logicalKey);
        if (absPath === null) return;
        const backupPath = await this.backupFile(absPath, f.logicalKey, backupRoot);
        backedUp.push({ key: f.logicalKey, absPath, backupPath });
        await this.deleteLocalFile(absPath);
        await this.removeBaseSnapshot(f.logicalKey);
        removed.push(f.logicalKey);
      });

      await this.writeState(nextState);
    } catch (err) {
      this.logger?.error(
        `[engine] force-down 중 오류 — 롤백: ${String((err as Error).message)}`,
      );
      await this.rollback(backedUp);
      throw err;
    }

    const hadBackup = backedUp.some((b) => b.backupPath !== null);
    return {
      dryRun: false,
      applied,
      removed,
      conflicts: [],
      backupDir: hadBackup ? backupRoot : null,
    };
  }

  /** settings.json pull: 원격 shared subset 을 로컬에 3-way 머지(로컬고유키 보존). */
  private async applyPullSettings(
    key: LogicalKey,
    absPath: string,
    remotePlain: Buffer,
    entry: FileEntry,
    nextState: SyncState,
  ): Promise<void> {
    const home = this.config.home;
    // 원격 shared 는 ${HOME} 토큰 공간. 3-way 비교가 동일 공간에서 이뤄지도록 로컬도 토큰화한다.
    const remoteShared = this.parseJson(remotePlain.toString("utf-8")) ?? {};
    const localReal = (await this.readJsonFile(absPath)) ?? {};
    const localObj = home
      ? (tokenizeHome(localReal, home) as Record<string, unknown>)
      : localReal;
    // base 스냅샷은 토큰 공간으로 저장되어 있음.
    const baseShared = (await this.readBaseSnapshotJson(key)) ?? {};

    const result = threeWayMerge(
      localObj,
      remoteShared,
      baseShared,
      this.config.settingsLocalKeys,
    );

    // 사용자 파일은 실제 home 경로로 복원해서 쓴다.
    const mergedReal = home ? detokenizeHome(result.merged, home) : result.merged;
    const mergedText = JSON.stringify(mergedReal, null, 2);
    await this.atomicWriteFile(absPath, mergedText);

    // base 스냅샷은 토큰 공간(shared subset)을 보관해 다음 3-way 의 base 로 사용.
    const sharedText = JSON.stringify(result.sharedSubset, null, 2);
    await this.writeBaseSnapshot(key, sharedText);

    nextState[key] = {
      syncedHash: entry.contentHash,
      syncedGeneration: entry.generation,
    };
  }

  // .mcp.json pull 적용: 원격(self 제거된 shared)을 로컬에 머지하되 로컬의 자기(wormhole) 항목은 보존.
  private async applyPullMcpJson(
    key: LogicalKey,
    absPath: string,
    remotePlain: Buffer,
    entry: FileEntry,
    nextState: SyncState,
  ): Promise<void> {
    const remoteSharedText = remotePlain.toString("utf-8");
    let localText: string | null;
    try {
      localText = await fs.readFile(absPath, "utf-8");
    } catch {
      localText = null;
    }
    const mergedText = mergeMcpJsonForPull(
      remoteSharedText,
      localText,
      this.config.selfMcpServerNames,
      this.config.home,
    );
    await this.atomicWriteFile(absPath, mergedText);
    // base 스냅샷은 원격 반영분(self 제거 shared)을 보관해 다음 3-way 의 base 로 사용.
    await this.writeBaseSnapshot(key, remoteSharedText);
    nextState[key] = {
      syncedHash: entry.contentHash,
      syncedGeneration: entry.generation,
    };
  }

  // .claude.json pull 적용: 원격 mcpServers 만 로컬에 머지하되 mcpServers 외 나머지 키는 로컬 보존.
  private async applyPullClaudeJson(
    key: LogicalKey,
    absPath: string,
    remotePlain: Buffer,
    entry: FileEntry,
    nextState: SyncState,
  ): Promise<void> {
    const remoteContent = remotePlain.toString("utf-8");
    let localRaw: string | null;
    try {
      localRaw = await fs.readFile(absPath, "utf-8");
    } catch {
      localRaw = null;
    }
    const mergedText = mergeClaudeJsonForPull(localRaw, remoteContent, this.config.home);
    await this.atomicWriteFile(absPath, mergedText);
    // base 스냅샷은 원격 반영분(mcpServers-only 정규화)을 보관해 다음 scan 의 base 로 사용.
    await this.writeBaseSnapshot(key, remoteContent);
    nextState[key] = {
      syncedHash: entry.contentHash,
      syncedGeneration: entry.generation,
    };
  }

  // ── resolve ─────────────────────────────────────────────────

  /** dryRun resolve 계획. */
  private async planResolve(
    policy: ResolvePolicy,
    keys?: string[],
  ): Promise<ResolveResult> {
    const status = await this.status();
    const targets = this.selectConflicts(status.conflicts, keys);
    return {
      policy,
      resolved: targets.map((c) => c.logicalKey),
      conflictCopies: [],
      backupDir: null,
    };
  }

  /** resolve 1회. preserve-both/latest-wins/manual 정책 적용. */
  private async runResolve(policy: ResolvePolicy, keys?: string[]): Promise<ResolveResult> {
    const remoteManifest = await this.manifestStore.read();
    if (remoteManifest === null) {
      return { policy, resolved: [], conflictCopies: [], backupDir: null };
    }

    const local = await this.scanWithHashes();
    const state = await this.readState();
    const status = computeStatus({
      local,
      manifest: remoteManifest,
      state,
      machineId: this.machineId,
    });

    const targets = this.selectConflicts(status.conflicts, keys);
    if (targets.length === 0) {
      return { policy, resolved: [], conflictCopies: [], backupDir: null };
    }

    if (policy === "manual") {
      // manual 은 자동 처리 금지 — 충돌 목록만 반환(해소하지 않음).
      return { policy, resolved: [], conflictCopies: [], backupDir: null };
    }

    const runTs = this.makeRunTs();
    const backupRoot = path.join(this.backupsDir, runTs);
    const resolved: LogicalKey[] = [];
    const conflictCopies: ConflictCopy[] = [];
    const nextState: SyncState = { ...state };
    let hadBackup = false;

    for (const conflict of targets) {
      const key = conflict.logicalKey;
      const entry = remoteManifest.entries[key];
      if (!entry) continue;

      // 원격 키 경로 검증(탈출 방어).
      const absPath = this.safeAbsPath(key);
      if (absPath === null) continue;

      if (policy === "preserve-both") {
        // 양쪽 보존: 로컬 유지 + 원격 의도를 사본/마커로 기록(멱등 — 동일 사본 있으면 재기록 생략).
        // 원격 유래 machineId/generation 은 파일명 접미사로 쓰기 전 반드시 정제(경로 탈출 방어).
        const mid = sanitizeToken(conflict.remoteMachineId);
        const gen = sanitizeToken(conflict.remoteGeneration);
        if (entry.deleted) {
          // 삭제 충돌(원격 삭제 vs 로컬 변경): 로컬 유지 + 원격 삭제 의도를 마커로 보존.
          const markerPath = `${absPath}.conflict-deleted-${mid}-${gen}`;
          if (!isWithinHome(this.config.home, markerPath)) {
            this.logger?.warn(`[engine] conflict 마커 경로가 home 밖 — 건너뜀: ${key}`);
          } else {
            if (!(await fs.access(markerPath).then(() => true).catch(() => false))) {
              await this.atomicWriteFile(
                markerPath,
                `원격(${conflict.remoteMachineId}, gen ${conflict.remoteGeneration})이 이 파일을 삭제했습니다.\n` +
                  `로컬본은 유지되었습니다. 검토 후 로컬을 삭제하거나 sync_push 로 원격에 복원하세요.\n`,
              );
            }
            conflictCopies.push({ logicalKey: key, copyPath: markerPath });
          }
        } else {
          const remotePlain = await this.downloadBlob(key);
          if (remotePlain !== null) {
            const copyPath = `${absPath}.conflict-${mid}-${gen}`;
            if (!isWithinHome(this.config.home, copyPath)) {
              this.logger?.warn(`[engine] conflict 사본 경로가 home 밖 — 건너뜀: ${key}`);
            } else {
              if (!(await fs.access(copyPath).then(() => true).catch(() => false))) {
                await this.atomicWriteFile(copyPath, remotePlain);
              }
              conflictCopies.push({ logicalKey: key, copyPath });
            }
          }
        }
        // base/state 갱신은 보류 — 사용자가 수동 정리 후 push 하도록.
        resolved.push(key);
        continue;
      }

      // latest-wins: 원격 generation 이 더 높으므로 원격을 채택(원격이 최신).
      const backupPath = await this.backupFile(absPath, key, backupRoot);
      if (backupPath !== null) hadBackup = true;

      if (entry.deleted) {
        await this.deleteLocalFile(absPath);
        await this.removeBaseSnapshot(key);
        nextState[key] = { syncedHash: "", syncedGeneration: entry.generation };
      } else {
        const remotePlain = await this.downloadBlob(key);
        if (remotePlain === null) {
          this.logger?.warn(`[engine] resolve(latest-wins): blob 부재 ${key}`);
          continue;
        }
        await this.atomicWriteFile(absPath, remotePlain);
        await this.writeBaseSnapshot(key, remotePlain);
        nextState[key] = {
          syncedHash: entry.contentHash,
          syncedGeneration: entry.generation,
        };
      }
      resolved.push(key);
    }

    if (policy === "latest-wins") {
      await this.writeState(nextState);
    }

    return {
      policy,
      resolved,
      conflictCopies,
      backupDir: hadBackup ? backupRoot : null,
    };
  }

  /** 충돌 목록에서 keys 로 필터(생략 시 전체). */
  private selectConflicts(conflicts: ConflictItem[], keys?: string[]): ConflictItem[] {
    if (keys === undefined || keys.length === 0) return conflicts;
    const set = new Set(keys);
    return conflicts.filter((c) => set.has(c.logicalKey));
  }

  // ── 파일 입출력 유틸 ────────────────────────────────────────

  /** 로컬 원자적 쓰기: 같은 디렉터리에 tmp 작성 → rename. 부모 mkdir -p. */
  private async atomicWriteFile(absPath: string, data: Buffer | string): Promise<void> {
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.${path.basename(absPath)}.tmp.${this.machineId}.${process.pid}.${atomicWriteSeq++}`,
    );
    // 임시파일에 쓰고 fsync 후 rename → 전원손실/크래시 시 0바이트/부분파일 방지.
    const fh = await fs.open(tmpPath, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, absPath);
    // 부모 디렉터리 fsync 로 rename 영속화. 일부 FS/Windows 는 미지원 → best-effort.
    try {
      const dh = await fs.open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // 디렉터리 fsync 미지원 — 무시.
    }
  }

  /** 로컬 파일 삭제. 없으면 무시(멱등). */
  private async deleteLocalFile(absPath: string): Promise<void> {
    try {
      await fs.unlink(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // 원격 매니페스트에서 온 논리키를 검증하고 OS 절대경로로 변환한다(경로 탈출 방어).
  // 유효하지 않거나 home 밖이면 null 을 반환하여 호출부가 건너뛰게 한다.
  private safeAbsPath(key: LogicalKey): string | null {
    if (!isValidLogicalKey(key)) {
      this.logger?.warn(`[engine] 유효하지 않은 원격 논리키 무시: ${JSON.stringify(key)}`);
      return null;
    }
    const absPath = toOS(this.config.home, key);
    if (!isWithinHome(this.config.home, absPath)) {
      this.logger?.warn(`[engine] home 밖 경로 무시(탈출 방어): ${key}`);
      return null;
    }
    return absPath;
  }

  // converged(양측 동일 콘텐츠 수렴) 항목의 watermark 를 전송 없이 전진시킨다.
  // 이렇게 해야 다음 실행에서 stale base 로 인한 거짓 충돌이 생기지 않는다.
  private async advanceConverged(
    items: import("../types.js").DiffItem[],
    nextState: SyncState,
  ): Promise<LogicalKey[]> {
    const advanced: LogicalKey[] = [];
    for (const item of items) {
      if (item.kind !== "converged") continue;
      const key = item.logicalKey;
      if (item.localHash === null) {
        // 양측 동시 삭제로 수렴 → 추적 해제.
        await this.removeBaseSnapshot(key);
        delete nextState[key];
      } else {
        // 양측 동일 콘텐츠 → base/state 를 현재 콘텐츠로 전진(로컬 파일에서 스냅샷 갱신).
        const absPath = this.safeAbsPath(key);
        if (absPath !== null) {
          try {
            const content = await fs.readFile(absPath);
            await this.writeBaseSnapshot(key, content);
          } catch {
            // 로컬 파일을 읽지 못해도 state watermark 는 전진시킨다(다음 스캔에서 재평가).
          }
        }
        nextState[key] = {
          syncedHash: item.localHash,
          syncedGeneration: item.remoteGeneration ?? 0,
        };
      }
      advanced.push(key);
    }
    return advanced;
  }

  /** JSON 파일 읽어 객체로. 없거나 파싱 실패 시 null. */
  private async readJsonFile(absPath: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fs.readFile(absPath, "utf-8");
      return this.parseJson(raw);
    } catch {
      return null;
    }
  }

  /** 문자열 JSON 파싱. plain 객체 아니면 null. */
  private parseJson(raw: string): Record<string, unknown> | null {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── base 스냅샷 ─────────────────────────────────────────────

  /** base 스냅샷 경로: <stateDir>/base/<sha256(logicalKey)>. */
  private baseSnapshotPath(key: LogicalKey): string {
    return path.join(this.baseDir, sha256(key));
  }

  /** base 스냅샷 기록(마지막 동기화 평문 보관). */
  private async writeBaseSnapshot(key: LogicalKey, data: Buffer | string): Promise<void> {
    await this.atomicWriteFile(this.baseSnapshotPath(key), data);
  }

  /** base 스냅샷 삭제. */
  private async removeBaseSnapshot(key: LogicalKey): Promise<void> {
    await this.deleteLocalFile(this.baseSnapshotPath(key));
  }

  /** base 스냅샷을 JSON 으로 읽기(settings 3-way base). 없으면 null. */
  private async readBaseSnapshotJson(key: LogicalKey): Promise<Record<string, unknown> | null> {
    return this.readJsonFile(this.baseSnapshotPath(key));
  }

  // ── 백업/롤백 ───────────────────────────────────────────────

  /** runTs 디렉터리명(파일시스템 안전). */
  private makeRunTs(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  /**
   * 대상 파일을 backups/<runTs>/<logicalKey> 로 백업.
   * 파일이 없으면(생성 케이스) null 반환(복원 시 삭제로 롤백).
   */
  private async backupFile(
    absPath: string,
    key: LogicalKey,
    backupRoot: string,
  ): Promise<string | null> {
    try {
      const data = await fs.readFile(absPath);
      const backupPath = path.join(backupRoot, ...key.split("/"));
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, data);
      return backupPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** 롤백: 백업본을 원위치로 복원. 백업 없던(=새로 생성된) 파일은 삭제. */
  private async rollback(
    backedUp: Array<{ key: LogicalKey; absPath: string; backupPath: string | null }>,
  ): Promise<void> {
    for (const b of backedUp) {
      try {
        if (b.backupPath === null) {
          // 적용 전 부재 → 적용으로 생긴 파일 제거.
          await this.deleteLocalFile(b.absPath);
        } else {
          const data = await fs.readFile(b.backupPath);
          await this.atomicWriteFile(b.absPath, data);
        }
      } catch (err) {
        this.logger?.error(`[engine] 롤백 실패 ${b.key}: ${String((err as Error).message)}`);
      }
    }
  }
}
