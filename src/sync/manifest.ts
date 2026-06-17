// 매니페스트 읽기(복호)/쓰기(암호+CAS)/엔트리 갱신/tombstone.
// 원격 manifest.json.age 는 age 암호화 후 armored 로 저장. ManifestStore 는 매니페스트만 담당.
import type {
  Manifest,
  FileEntry,
  LogicalKey,
  MachineId,
  Config,
  Sha256Hex,
} from "../types.js";
import type { AgeCrypto } from "../crypto/age.js";
import type { RemoteStore } from "../webdav/client.js";
import { PreconditionFailedError } from "../webdav/client.js";
import { z } from "zod";

// 원격(타 머신/타 OS 작성) 매니페스트는 신뢰 불가 입력 — 복호 성공만으로 구조를 믿지 않고 zod 로 검증.
const FileEntrySchema = z.object({
  contentHash: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  generation: z.number().int().nonnegative(),
  lastModifiedBy: z.string().max(256),
  deleted: z.boolean(),
  deletedAt: z.number().nullable(),
});
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  manifestGeneration: z.number().int().nonnegative(),
  updatedBy: z.string().max(256),
  updatedAt: z.number(),
  entries: z.record(FileEntrySchema),
});

/** 원격 매니페스트 파일명. */
const MANIFEST_FILE = "manifest.json.age";

/** baseDir 와 파일명 결합 (posix). 중복 슬래시 제거. */
function joinRemote(baseDir: string, name: string): string {
  const trimmed = baseDir.replace(/\/+$/, "");
  return `${trimmed}/${name}`;
}

/** CAS 실패 전용 에러 — 엔진이 재시도/보고에 사용. */
export class ManifestConflictError extends Error {
  readonly expected: number | null;
  readonly actual: number | null;

  constructor(expected: number | null, actual: number | null) {
    super(
      `manifest CAS conflict: expected generation ${expected}, actual ${actual}`,
    );
    this.name = "ManifestConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ManifestStore {
  private readonly remote: RemoteStore;
  private readonly crypto: AgeCrypto;
  private readonly config: Config;
  /** 원격 manifest.json.age 절대 경로. */
  private readonly manifestPath: string;
  /** 마지막 read() 가 받은 매니페스트 ETag. write() 의 CAS(If-Match)에 사용. 없으면 null. */
  private lastEtag: string | null = null;

  constructor(remote: RemoteStore, crypto: AgeCrypto, config: Config) {
    this.remote = remote;
    this.crypto = crypto;
    this.config = config;
    this.manifestPath = joinRemote(config.remote.remoteBaseDir, MANIFEST_FILE);
  }

  /** 원격 manifest.json.age 읽어 복호+파싱. 없으면 null. */
  /** 원격 manifest.json.age 읽어 복호+파싱. 없으면 null. 마지막 read 의 ETag 를 내부 보관(CAS 용). */
  async read(): Promise<Manifest | null> {
    const result = await this.remote.getTextWithETag(this.manifestPath);
    if (result === null) {
      // 원격에 매니페스트 없음 — 다음 write 가 putIfNoneMatch(생성 전용)를 쓰도록 ETag 비움.
      this.lastEtag = null;
      return null;
    }
    this.lastEtag = result.etag;
    const plaintext = await this.crypto.decryptToString(result.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (err) {
      throw new Error(`원격 매니페스트 JSON 파싱 실패: ${String((err as Error).message)}`);
    }
    // 신뢰 불가 원격 입력 구조 검증(손상/비호환/악성 거부).
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`원격 매니페스트 구조 검증 실패(손상/비호환): ${validated.error.message}`);
    }
    return validated.data as Manifest;
  }

  // 매니페스트 암호화(armored) 후 원격 원자적 쓰기.
  // expectedGeneration CAS: 쓰기 직전 원격 재로드해 manifestGeneration 비교, 다르면 throw.
  // 쓰기 전 manifestGeneration +1, updatedBy/updatedAt 갱신. 반환: 기록된 매니페스트.
  // 매니페스트 암호화(armored) 후 원격에 ETag 기반 CAS 로 쓰기.
  // 1차 방어: 마지막 read 의 ETag 로 조건부 PUT(서버측 원자 비교-후-쓰기).
  //   - 원격에 이미 존재(lastEtag != null) → putIfMatch(If-Match): read 이후 누가 덮어썼으면 412.
  //   - 원격에 없음(lastEtag == null) → putIfNoneMatch(If-None-Match:*): 동시 생성은 한쪽만 성공.
  // PreconditionFailedError 는 ManifestConflictError 로 변환해 throw(engine 재시도 루프가 잡음).
  // 보조 방어: expectedGeneration 비교(ETag 미지원 서버에서도 generation 으로 1차 충돌 검출).
  // 쓰기 전 manifestGeneration +1, updatedBy/updatedAt 갱신. 반환: 기록된 매니페스트.
  async write(
    manifest: Manifest,
    expectedGeneration: number | null,
    machineId: MachineId,
  ): Promise<Manifest> {
    // 보조 CAS: 저장 직전 현재 원격 세대 확인(ETag 미지원 폴백 시에도 충돌 검출). read() 가 lastEtag 도 갱신.
    const current = await this.read();
    const actual = current === null ? null : current.manifestGeneration;
    if (actual !== expectedGeneration) {
      throw new ManifestConflictError(expectedGeneration, actual);
    }

    const written: Manifest = {
      ...manifest,
      manifestGeneration: manifest.manifestGeneration + 1,
      updatedBy: machineId,
      updatedAt: Date.now(),
    };

    const armored = await this.crypto.encrypt(JSON.stringify(written));

    try {
      if (current === null) {
        // 원격에 없음 → 생성 전용 조건부 PUT(동시 생성 경쟁에서 한쪽만 성공).
        await this.remote.putIfNoneMatch(this.manifestPath, armored, machineId);
      } else {
        // 원격에 있음 → ETag 일치 시에만 덮어쓰기(read→write 사이 변경 검출).
        await this.remote.putIfMatch(this.manifestPath, armored, this.lastEtag, machineId);
      }
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        // 서버측 CAS 패배 → 다른 머신이 먼저 썼음. generation 단위 충돌로 변환.
        throw new ManifestConflictError(expectedGeneration, actual);
      }
      throw err;
    }

    return written;
  }

  /** 빈 매니페스트 생성 (schemaVersion:1, manifestGeneration:0, entries:{}). */
  static empty(machineId: MachineId): Manifest {
    return {
      schemaVersion: 1,
      manifestGeneration: 0,
      updatedBy: machineId,
      updatedAt: Date.now(),
      entries: {},
    };
  }

  // 엔트리 upsert: 콘텐츠 해시 변경 시 generation+1, deleted=false. 새 엔트리는 generation=1.
  // entries 객체를 변형(엔진 소유)하고 갱신된 FileEntry 반환.
  static upsertEntry(
    manifest: Manifest,
    logicalKey: LogicalKey,
    contentHash: Sha256Hex,
    size: number,
    mtimeMs: number,
    machineId: MachineId,
  ): FileEntry {
    const existing = manifest.entries[logicalKey];

    if (!existing) {
      const entry: FileEntry = {
        contentHash,
        size,
        mtimeMs,
        generation: 1,
        lastModifiedBy: machineId,
        deleted: false,
        deletedAt: null,
      };
      manifest.entries[logicalKey] = entry;
      return entry;
    }

    // 콘텐츠 변경(또는 tombstone 부활) 시 generation +1.
    const changed = existing.contentHash !== contentHash || existing.deleted;
    const entry: FileEntry = {
      contentHash,
      size,
      mtimeMs,
      generation: changed ? existing.generation + 1 : existing.generation,
      lastModifiedBy: changed ? machineId : existing.lastModifiedBy,
      deleted: false,
      deletedAt: null,
    };
    manifest.entries[logicalKey] = entry;
    return entry;
  }

  // tombstone 처리: deleted=true, deletedAt=now, generation+1. 엔트리 없으면 null.
  // 이미 tombstone 이면 no-op 으로 기존 엔트리 반환.
  static tombstoneEntry(
    manifest: Manifest,
    logicalKey: LogicalKey,
    machineId: MachineId,
  ): FileEntry | null {
    const existing = manifest.entries[logicalKey];
    if (!existing) return null;
    if (existing.deleted) return existing;

    const entry: FileEntry = {
      ...existing,
      generation: existing.generation + 1,
      lastModifiedBy: machineId,
      deleted: true,
      deletedAt: Date.now(),
    };
    manifest.entries[logicalKey] = entry;
    return entry;
  }
}
