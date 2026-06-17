// status/diff 계산 + 충돌 감지. 순수함수(부수효과 없음).
// 알고리즘(BRIEF): 3-way 콘텐츠 해시 비교. localChanged = localHash!==baseHash;
// remoteChanged = remoteHash!==baseHash. 양측 변경+동일 해시 → converged, 다르면 conflict.

import type {
  DiffInput,
  SyncStatus,
  SyncSummary,
  DiffItem,
  ConflictItem,
  ChangeKind,
  FileEntry,
  LocalFileState,
  Manifest,
  SyncState,
  LogicalKey,
} from "../types.js";

// 단일 키 판정. remoteEntry/syncedGeneration 부재(undefined)는 ABSENT 의미.
export function classifyKey(
  logicalKey: string,
  localHash: string | null,
  baseHash: string | null,
  remoteEntry: FileEntry | undefined,
  syncedGeneration: number | undefined,
): DiffItem {
  // 원격은 tombstone(deleted)이면 콘텐츠 부재로 취급.
  const remoteExists = remoteEntry !== undefined && !remoteEntry.deleted;
  const remoteHash: string | null = remoteExists ? remoteEntry!.contentHash : null;
  const remoteGeneration: number | null =
    remoteEntry !== undefined ? remoteEntry.generation : null;
  // syncedGeneration 은 현재 판정에 사용하지 않으나(콘텐츠 3-way 로 전환), 시그니처는 호환 유지.
  void syncedGeneration;

  const localExists = localHash !== null;
  const baseExists = baseHash !== null;

  // baptiste식 3-way: 로컬/원격 변경 여부를 모두 콘텐츠 해시로 BASE 와 대조한다.
  // (이전 구현은 원격 변경을 generation 비교로만 판단해 콘텐츠가 base 와 같아도 충돌로 오판했음)
  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;

  let kind: ChangeKind;

  if (!localChanged && !remoteChanged) {
    kind = "unchanged";
  } else if (localChanged && remoteChanged) {
    // 양측 변경 → 결과 동일하면 수렴, 다르면 발산(conflict).
    if (localHash === remoteHash) {
      // 동일 콘텐츠(또는 양측 동시 삭제)로 수렴: 충돌 아님. watermark 만 전진.
      kind = "converged";
    } else {
      kind = "conflict";
    }
  } else if (localChanged && !remoteChanged) {
    // 로컬만 변경 → push 후보.
    if (!localExists) {
      kind = "deleted";
    } else if (!baseExists && !remoteExists) {
      kind = "added";
    } else {
      kind = "modified";
    }
  } else {
    // 원격만 변경 → pull 로 fast-forward.
    const remoteDeleted = remoteEntry !== undefined && remoteEntry.deleted;
    if (remoteDeleted) {
      kind = localExists ? "remoteDeleted" : "unchanged";
    } else if (!baseExists) {
      kind = "remoteAdded";
    } else {
      kind = "remoteModified";
    }
  }

  return {
    logicalKey,
    kind,
    localHash,
    baseHash,
    remoteHash,
    remoteGeneration,
  };
}

// 전체 상태 계산. 로컬 + 원격 매니페스트 + baseline 합집합 키를 순회.
export function computeStatus(input: DiffInput): SyncStatus {
  const { local, manifest, state, machineId } = input;

  const localMap = toLocalMap(local);
  const entries = manifest?.entries ?? {};

  // 로컬 + 원격 + base 의 키 합집합.
  const keys = collectKeys(localMap, entries, state);

  const items: DiffItem[] = [];
  const conflicts: ConflictItem[] = [];

  for (const logicalKey of keys) {
    const localHash = localMap.get(logicalKey)?.contentHash ?? null;
    const baseline = state[logicalKey];
    const baseHash = baseline?.syncedHash ?? null;
    const syncedGeneration = baseline?.syncedGeneration;
    const remoteEntry = entries[logicalKey];

    const item = classifyKey(
      logicalKey,
      localHash,
      baseHash,
      remoteEntry,
      syncedGeneration,
    );
    items.push(item);

    if (item.kind === "conflict") {
      // 대부분 remoteEntry 가 존재하나, 원격이 base 에 있던 키를 tombstone 없이 드롭한 경우
      // undefined 일 수 있다 — 이때는 원격 삭제 충돌로 안전 처리한다.
      const re = remoteEntry;
      const remoteIsGone = re === undefined || re.deleted === true;
      const isDeletionConflict = remoteIsGone || localHash === null;
      conflicts.push({
        logicalKey,
        localHash,
        remoteHash: remoteIsGone ? null : re!.contentHash,
        remoteMachineId: re?.lastModifiedBy ?? "unknown",
        remoteGeneration: re?.generation ?? 0,
        isDeletionConflict,
      });
    }
  }

  const summary = summarize(items);

  return {
    generatedAt: Date.now(),
    machineId,
    manifestGeneration: manifest?.manifestGeneration ?? null,
    items,
    conflicts,
    summary,
  };
}

// LocalFileState[] → logicalKey 맵.
function toLocalMap(local: LocalFileState[]): Map<LogicalKey, LocalFileState> {
  const m = new Map<LogicalKey, LocalFileState>();
  for (const f of local) m.set(f.logicalKey, f);
  return m;
}

// 세 출처의 키 합집합 (정렬된 배열).
function collectKeys(
  localMap: Map<LogicalKey, LocalFileState>,
  entries: Record<LogicalKey, FileEntry>,
  state: SyncState,
): LogicalKey[] {
  const set = new Set<LogicalKey>();
  for (const k of localMap.keys()) set.add(k);
  for (const k of Object.keys(entries)) set.add(k);
  for (const k of Object.keys(state)) set.add(k);
  return Array.from(set).sort();
}

// 분류별 logicalKey 집계.
function summarize(items: DiffItem[]): SyncSummary {
  const summary: SyncSummary = {
    added: [],
    modified: [],
    deleted: [],
    remoteAdded: [],
    remoteModified: [],
    remoteDeleted: [],
    conflicts: [],
    unchanged: [],
    converged: [],
  };
  for (const item of items) {
    switch (item.kind) {
      case "added":
        summary.added.push(item.logicalKey);
        break;
      case "modified":
        summary.modified.push(item.logicalKey);
        break;
      case "deleted":
        summary.deleted.push(item.logicalKey);
        break;
      case "remoteAdded":
        summary.remoteAdded.push(item.logicalKey);
        break;
      case "remoteModified":
        summary.remoteModified.push(item.logicalKey);
        break;
      case "remoteDeleted":
        summary.remoteDeleted.push(item.logicalKey);
        break;
      case "conflict":
        summary.conflicts.push(item.logicalKey);
        break;
      case "converged":
        summary.converged.push(item.logicalKey);
        break;
      case "unchanged":
        summary.unchanged.push(item.logicalKey);
        break;
    }
  }
  return summary;
}
