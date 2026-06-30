// 공유 타입/인터페이스 — 모든 모듈의 캐노니컬 계약.
// zero-knowledge: 매니페스트/blob 은 age 암호화 후 armored 저장. blob 명 = sha256(logicalKey).
// 경로: logicalKey 는 os.homedir() 기준 posix(슬래시) 상대경로. OS 실제경로는 path API 로 변환.

// ── 기본 별칭 ──────────────────────────────────────────────

/** os.homedir() 기준 posix(슬래시) 상대경로. 예: ".claude/CLAUDE.md". 양 OS 공통 식별자. */
export type LogicalKey = string;

/** 머신 식별자 (crypto.randomUUID()). state dir 의 machine-id 파일에 영속. */
export type MachineId = string;

/** sha256 hex 소문자 (64 chars). 콘텐츠 해시 및 blob 파일명 산출에 사용. */
export type Sha256Hex = string;

/** epoch milliseconds (Date.now()). */
export type EpochMs = number;

// ── 설정 (config.ts) ──────────────────────────────────────

/** 충돌 해소 정책. 기본 preserve-both. */
export type ResolvePolicy = "preserve-both" | "latest-wins" | "ours" | "manual";

/** 동기화 대상 include/exclude 글로브 (home 기준 posix). */
export interface SyncTargets {
  /** 포함 글로브 (posix). */
  include: string[];
  /** 제외 글로브 (posix). exclude 가 include 보다 우선. */
  exclude: string[];
}

/** WebDAV 원격 접속 설정. 비밀값은 config/env 주입 — 하드코딩 금지. */
export interface RemoteConfig {
  /** WebDAV 베이스 URL. */
  url: string;
  /** WebDAV 사용자명. */
  username: string;
  /** WebDAV 비밀번호. */
  password: string;
  /**
   * 원격 레이아웃 루트. 예: "/wormhole_claude_code".
   * 설정 파일에서 명시하지 않으면 username 에서 도출된다("/" + username).
   * loadConfig 이후의 해석된 Config 에서는 항상 채워진 문자열이다.
   */
  remoteBaseDir: string;
}

/** age 자격 설정. identityKeyPath 파일 또는 env 원문(WORMHOLE_IDENTITY_KEY) 사용. */
export interface CryptoConfig {
  /** passphrase 를 읽을 환경변수 이름. */
  passphraseEnv: string;
  /** 0600 passphrase 파일 경로(stateDir 기준 확장 후 절대경로). */
  passphraseFile: string;
  /** (선택) keychain service 이름(secret-tool, Linux/WSL2). */
  keychainService?: string;
  /** 파생된 age 키 캐시 경로(절대경로, 0600). passphrase 원문이 아니라 파생 키만 저장. */
  derivedKeyPath: string;
  /** scrypt KDF 작업계수 N(2의 거듭제곱). */
  kdfN: number;
  /** scrypt KDF r. */
  kdfR: number;
  /** scrypt KDF p. */
  kdfP: number;
}

/** 원격 lock.json 관련 설정. */
export interface LockConfig {
  /** 락 TTL(ms). 만료된 락은 탈취 가능. */
  ttlMs: number;
  /** 락 획득 재시도 횟수. */
  acquireRetries: number;
  /** 재시도 간 대기(ms). */
  acquireRetryDelayMs: number;
}

/** homeRootTargets 단일 항목. home-root 파일의 머지 서브키와 보존모드. */
export interface HomeRootTarget {
  /** 머지할 top-level 서브키 목록. */
  subkeys: string[];
  /** 보존 모드. denylist = subkeys 외 나머지는 머신고유로 보존. */
  preserveMode: "denylist";
}

/** 최상위 설정. config 파일 + env 병합 후 검증된 형태. */
export interface Config {
  /** 로컬 상태 디렉터리(절대경로). 기본 ~/.wormhole. */
  stateDir: string;
  /** os.homedir() 스냅샷(절대경로). 논리키↔OS 경로 매핑 기준. */
  home: string;
  /** WebDAV 원격 설정. */
  remote: RemoteConfig;
  /** age 자격 설정. */
  crypto: CryptoConfig;
  /** 동기화 대상 글로브. */
  targets: SyncTargets;
  skills_keyword?: string;
  /** 동기화할 mcpServer 이름 allowlist. 등록된 서버만 .claude.json mcpServers 에서 동기화. */
  syncMcpServers: string[];
  /** 충돌 기본 정책. */
  conflictPolicy: ResolvePolicy;
  /** 원격 락 설정. */
  lock: LockConfig;
  /** home-root 파일(예: .claude.json)의 머지 서브키와 보존모드 맵. 미지정 시 undefined. */
  homeRootTargets?: Record<string, HomeRootTarget>;
}

// ── 매니페스트 (manifest.ts) ──────────────────────────────

/** 매니페스트 단일 엔트리 (logicalKey 별 메타). 삭제는 tombstone 으로 표현. */
export interface FileEntry {
  /** 평문 콘텐츠 sha256 hex. deleted 면 마지막 알려진 값(또는 빈 문자열). */
  contentHash: Sha256Hex;
  /** 평문 바이트 크기. */
  size: number;
  /** 원본 파일 mtime(ms). */
  mtimeMs: EpochMs;
  /** 엔트리 세대. 콘텐츠 변경 시마다 +1. 원격변경 판별용. */
  generation: number;
  /** 마지막 수정 머신. */
  lastModifiedBy: MachineId;
  /** tombstone 여부. true 면 원격 삭제 표식. */
  deleted: boolean;
  /** 삭제 시각(ms). deleted=false 면 null. */
  deletedAt: EpochMs | null;
  /** de-scope 마킹. true 면 이 머신의 동기화 범위에서 제외된 키 — pull/force-download 적용 건너뜀. */
  scopeExcluded?: boolean;
}

/** 매니페스트 전체. 암호화 후 armored 로 <base>/manifest.json.age 에 저장. */
export interface Manifest {
  /** 스키마 버전. 현재 1. */
  schemaVersion: 1;
  /** 매니페스트 세대. 쓸 때마다 +1 (CAS 비교용). */
  manifestGeneration: number;
  /** 마지막 갱신 머신. */
  updatedBy: MachineId;
  /** 마지막 갱신 시각(ms). */
  updatedAt: EpochMs;
  /** logicalKey → 엔트리 맵. */
  entries: Record<LogicalKey, FileEntry>;
}

// ── 원격 락 (lock.ts) ─────────────────────────────────────

/** 원격 lock.json 평문 구조. */
export interface LockInfo {
  /** 락 소유 머신. */
  machineId: MachineId;
  /** 획득 시각(ms). */
  acquiredAt: EpochMs;
  /** TTL(ms). acquiredAt + ttlMs 경과 시 만료. */
  ttlMs: number;
}

// ── 로컬 상태 (state.json) ────────────────────────────────

/** logicalKey 별 마지막 동기화 기준선(base). 자기변경 vs 원격변경 판별용. */
export interface SyncBaseline {
  /** 마지막 동기화된 평문 콘텐츠 해시. */
  syncedHash: Sha256Hex;
  /** 마지막 동기화 시점의 매니페스트 엔트리 generation. */
  syncedGeneration: number;
}

/** state.json 전체: logicalKey → baseline. */
export type SyncState = Record<LogicalKey, SyncBaseline>;

// ── 스캐너 (scanner.ts) ───────────────────────────────────

/** 로컬 스캔 결과 단일 항목. */
export interface ScannedFile {
  /** 논리키 (posix). */
  logicalKey: LogicalKey;
  /** OS 절대경로. */
  absPath: string;
  /** 평문 바이트 크기. */
  size: number;
  /** 파일 mtime(ms). */
  mtimeMs: EpochMs;
}

// ── 상태/diff (diff.ts) ───────────────────────────────────

/** 단일 logicalKey 에 대한 동기화 판정 분류. */
export type ChangeKind =
  /** 변경 없음(로컬=base=원격). */
  | "unchanged"
  /** 로컬에 새로 생김(원격/ base 부재). push 후보. */
  | "added"
  /** 로컬 콘텐츠 변경(원격 미변경). push 후보. */
  | "modified"
  /** 로컬 삭제(원격 존재). push 가 tombstone 처리. */
  | "deleted"
  /** 원격만 변경 → pull 로 fast-forward 적용 대상. */
  | "remoteAdded"
  | "remoteModified"
  | "remoteDeleted"
  /** 원격·로컬 동시 변경 발산 → 정책 적용. */
  | "conflict"
  /** 원격·로컬이 동일 콘텐츠로 수렴 → 전송 없이 base/state watermark 만 전진. */
  | "converged";

/** logicalKey 단위 diff 항목. */
export interface DiffItem {
  /** 논리키. */
  logicalKey: LogicalKey;
  /** 판정 분류. */
  kind: ChangeKind;
  /** 현재 로컬 콘텐츠 해시. 부재 시 null. */
  localHash: Sha256Hex | null;
  /** state 기준선 해시. 부재 시 null. */
  baseHash: Sha256Hex | null;
  /** 원격 매니페스트 엔트리 콘텐츠 해시. 부재 시 null. */
  remoteHash: Sha256Hex | null;
  /** 원격 엔트리 generation. 부재 시 null. */
  remoteGeneration: number | null;
}

/** 충돌 상세 (발산 발생 logicalKey). */
export interface ConflictItem {
  /** 논리키. */
  logicalKey: LogicalKey;
  /** 로컬 콘텐츠 해시(또는 ABSENT 의미로 null). */
  localHash: Sha256Hex | null;
  /** 원격 콘텐츠 해시(또는 null). */
  remoteHash: Sha256Hex | null;
  /** 원격본을 만든 머신. */
  remoteMachineId: MachineId;
  /** 원격 엔트리 generation. */
  remoteGeneration: number;
  /** 한쪽이 tombstone(삭제)인 충돌이면 true. */
  isDeletionConflict: boolean;
}

/** 전체 동기화 상태/계획. status 및 diff 의 산출. */
export interface SyncStatus {
  /** 산출 시각(ms). */
  generatedAt: EpochMs;
  /** 이 머신 id. */
  machineId: MachineId;
  /** 알고 있는 원격 매니페스트 세대. null 이면 원격 매니페스트 부재. */
  manifestGeneration: number | null;
  /** logicalKey 별 diff 항목 전체. */
  items: DiffItem[];
  /** 충돌 항목(items 중 kind==="conflict" 의 상세). */
  conflicts: ConflictItem[];
  /** 분류별 logicalKey 집계. */
  summary: SyncSummary;
}

/** SyncStatus 의 분류별 집계. */
export interface SyncSummary {
  added: LogicalKey[];
  modified: LogicalKey[];
  deleted: LogicalKey[];
  remoteAdded: LogicalKey[];
  remoteModified: LogicalKey[];
  remoteDeleted: LogicalKey[];
  conflicts: LogicalKey[];
  unchanged: LogicalKey[];
  /** 양측이 동일 콘텐츠로 수렴 → IO 없이 watermark 전진 대상. */
  converged: LogicalKey[];
}

/** diff 계산 입력 묶음. */
export interface DiffInput {
  /** 로컬 스캔 결과(콘텐츠 해시 포함). */
  local: LocalFileState[];
  /** 원격 매니페스트(없으면 null). */
  manifest: Manifest | null;
  /** 로컬 baseline 상태. */
  state: SyncState;
  /** 이 머신 id. */
  machineId: MachineId;
}

/** diff 입력용 로컬 파일 상태(해시 포함). scanner 결과 + 해시. */
export interface LocalFileState {
  logicalKey: LogicalKey;
  absPath: string;
  contentHash: Sha256Hex;
  size: number;
  mtimeMs: EpochMs;
}

// ── settings 머지 (settings-merge.ts) ─────────────────────

/** settings.json 3-way 머지 결과. */
export interface SettingsMergeResult {
  /** 머지된 객체(로컬에 기록할 최종 settings). */
  merged: Record<string, unknown>;
  /** 동기화 대상 shared subset(로컬고유키 제거). 매니페스트/원격 반영용. */
  sharedSubset: Record<string, unknown>;
  /** 양측 동시 변경된 충돌 키(JSON dot-path). */
  conflictKeys: string[];
  /** 충돌 발생 여부. conflictKeys.length>0 와 동치. */
  hasConflict: boolean;
}

// ── 엔진 결과 (engine.ts) ─────────────────────────────────

/** push/pull/resolve 공통 옵션. */
export interface SyncRunOptions {
  /** 실제 변경 없이 계획만 산출. */
  dryRun?: boolean;
}

/** push 결과. */
export interface PushResult {
  dryRun: boolean;
  /** 업로드/갱신된 logicalKey. */
  pushed: LogicalKey[];
  /** tombstone 처리된 logicalKey. */
  deleted: LogicalKey[];
  /** 변경 없어 건너뛴 수. */
  skipped: number;
  /** 갱신 후 매니페스트 세대. dryRun 이면 예상치. null=원격 부재. */
  manifestGeneration: number | null;
  /** push 중 감지된 충돌(정책상 push 보류). */
  conflicts: ConflictItem[];
}

/** pull 결과. */
export interface PullResult {
  dryRun: boolean;
  /** 원격→로컬 적용된 logicalKey (생성/수정). */
  applied: LogicalKey[];
  /** 로컬 삭제된 logicalKey (원격 tombstone 반영). */
  removed: LogicalKey[];
  /** 정책 적용된 충돌. */
  conflicts: ConflictItem[];
  /** 백업 디렉터리 경로(있을 때). */
  backupDir: string | null;
}

/** resolve 결과. */
export interface ResolveResult {
  /** 적용된 정책. */
  policy: ResolvePolicy;
  /** 해소 처리된 logicalKey. */
  resolved: LogicalKey[];
  /** preserve-both 로 기록된 conflict 사본 경로. */
  conflictCopies: ConflictCopy[];
  /** 백업 디렉터리 경로(있을 때). */
  backupDir: string | null;
}

/** preserve-both 시 기록된 원격 사본 정보. */
export interface ConflictCopy {
  /** 원본 논리키. */
  logicalKey: LogicalKey;
  /** 기록된 사본 OS 절대경로. "<path>.conflict-<remoteMachine>-<gen>". */
  copyPath: string;
}

export interface ConflictDetail {
  logicalKey: LogicalKey;
  localHash: Sha256Hex | null;
  remoteHash: Sha256Hex | null;
  remoteMachineId: MachineId;
  remoteGeneration: number;
  copyPath: string | null;
}

// ── 로깅 (logger.ts) ──────────────────────────────────────

/** stderr 전용 로거. stdout 은 MCP 전송 전용이라 사용 금지. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** 로그 레벨. */
export type LogLevel = "debug" | "info" | "warn" | "error";

// ── 원격 디렉터리 항목 (webdav/client.ts) ─────────────────

/** RemoteStore.list 가 반환하는 항목 (webdav 항목의 부분 투영). */
export interface RemoteEntry {
  /** 파일/디렉터리명. */
  basename: string;
  /** 전체 원격 경로. */
  filename: string;
  /** 종류. */
  type: "file" | "directory";
}
