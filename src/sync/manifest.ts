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
// Apache mod_dav (및 유사 서버)는 수정 직후(~1s) 파일에 weak ETag(W/"...")를 주고, 이후
// strong ETag 로 늙는다. RFC 7232 If-Match 는 strong 비교라 weak 현재 ETag 는 실 충돌 없이도
// 412 가 된다. write() 의 갱신 CAS 는 이 윈도를 넘길 때까지 재시도한다. 누적 백오프는 관측된
// ~1s 윈도를 충분히 초과하고, push 전체가 원격 락(TTL 30s) 안에서 도므로 락 TTL 보다는 훨씬 작다.
export const DEFAULT_CAS_RETRY_BACKOFF_MS: readonly number[] = [300, 500, 700, 900, 1100];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /** 갱신 CAS 의 weak-ETag 재시도 백오프(ms). 시도 사이 대기. 테스트는 0 배열 주입. */
  private readonly casRetryBackoffMs: readonly number[];

  constructor(
    remote: RemoteStore,
    crypto: AgeCrypto,
    config: Config,
    casRetryBackoffMs: readonly number[] = DEFAULT_CAS_RETRY_BACKOFF_MS,
  ) {
    this.remote = remote;
    this.crypto = crypto;
    this.config = config;
    this.manifestPath = joinRemote(config.remote.remoteBaseDir, MANIFEST_FILE);
    this.casRetryBackoffMs = casRetryBackoffMs;
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

    // 생성 경로(원격 부재)는 존재 기반 If-None-Match 라 weak-ETag 문제와 무관 — 단발 시도.
    if (current === null) {
      try {
        await this.remote.putIfNoneMatch(this.manifestPath, armored, machineId);
      } catch (err) {
        if (err instanceof PreconditionFailedError) {
          // 동시 생성 경쟁 패배 → 충돌.
          throw new ManifestConflictError(expectedGeneration, actual);
        }
        throw err;
      }
      return written;
    }

    // 갱신 경로(If-Match). Apache mod_dav 등은 수정 직후(~1s) 파일에 weak ETag 를 주어 strong
    // 비교인 If-Match 가 실 충돌 없이도 412 를 낸다. 412 면 세대를 재확인해 진짜 경쟁 쓰기(세대 전진)와
    // 가짜 weak-412(세대 동일)를 구분한다. 진짜면 즉시 충돌, 가짜면 ETag 가 strong 으로 늙을 때까지
    // 백오프 재시도한다(루프 전체가 원격 락 안에서 도므로 락 외부 머신은 weak 윈도 내 끼어들 수 없다).
    const maxAttempts = this.casRetryBackoffMs.length + 1;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.remote.putIfMatch(this.manifestPath, armored, this.lastEtag, machineId);
        return written;
      } catch (err) {
        if (err instanceof PreconditionFailedError && err.status === 412) {
          // 재확인: read() 가 lastEtag 를 갱신(늙으면 weak→strong)하고 현재 세대를 준다.
          const recheck = await this.read();
          const recheckGen = recheck === null ? null : recheck.manifestGeneration;
          if (recheckGen !== expectedGeneration) {
            // 다른 머신이 매니페스트를 전진(또는 삭제)시킴 → 진짜 충돌.
            throw new ManifestConflictError(expectedGeneration, recheckGen);
          }
          if (attempt < maxAttempts - 1) {
            // 세대 동일 + 412 → weak-ETag 가짜 충돌. push 전체가 원격 락(단일 writer) 안에서
            // 도므로 weak 윈도 내 세대를 바꿀 외부 writer 는 없다. 즉 세대 동일 412 는 서버의
            // weak→strong 숙성 대기일 뿐 — 윈도가 지나도록 대기 후 재시도.
            await delay(this.casRetryBackoffMs[attempt]);
            continue;
          }
          // 예산 소진(weak 윈도가 비정상적으로 김) → 충돌로 변환. 상위 push 재시도가 처리.
          throw new ManifestConflictError(expectedGeneration, recheckGen);
        }
        if (err instanceof PreconditionFailedError) {
          // 412 외 precondition(405/409 등) → 즉시 충돌(기존 동작 유지).
          throw new ManifestConflictError(expectedGeneration, actual);
        }
        throw err;
      }
    }
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
