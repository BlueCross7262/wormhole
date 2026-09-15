// push 가 만든 콘텐츠 변화를 기계 diff 로 산출하고, 매니페스트 총량 예산에 맞춰 정리한다.
// advisory 데이터 — 동기화 정확성 판정에 쓰지 않는다. 구버전이 strip 해도 무해해야 한다.
import { createTwoFilesPatch, structuredPatch } from "diff";
import type { ChangeDiff, Manifest, Sha256Hex, EpochMs } from "../types.js";

/** 키당 diff 본문 상한(바이트). 초과분은 잘리고 truncated=true. */
export const MAX_DIFF_BYTES_PER_KEY = 4096;

/** 매니페스트 전체 diff 본문 예산(바이트). 초과분은 오래된 것부터 본문이 비워진다. */
export const MAX_TOTAL_DIFF_BYTES = 262_144;

/** 원격 매니페스트 수용 시 zod 가 강제하는 하드 상한. 피어가 매니페스트를 부풀리는 것을 막는다. */
export const HARD_MAX_DIFF_BYTES = 65_536;

/** diff 를 만드는 두 텍스트에 붙이는 이름. unified 헤더에만 쓰인다. */
const BASE_LABEL = "base";
const NEXT_LABEL = "local";

export interface ComputeChangeDiffOptions {
  /** 본문 상한(바이트). 초과 시 앞부분만 남긴다. */
  maxBytes: number;
  /** 출발점 콘텐츠 해시. 신규면 null. */
  baseHash: Sha256Hex | null;
  /** 도착점 콘텐츠 해시. */
  contentHash: Sha256Hex;
  /** 산출 시각(ms). */
  now: EpochMs;
}

function hasNullByte(text: string): boolean {
  return text.includes("\0");
}

function countLines(baseText: string, nextText: string): { added: number; removed: number } {
  const patch = structuredPatch(BASE_LABEL, NEXT_LABEL, baseText, nextText, "", "", { context: 0 });
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/** 바이트 상한에 맞춰 자른다. UTF-8 멀티바이트 문자를 쪼개지 않는다. */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  if (maxBytes <= 0) return { text: "", truncated: true };
  // 경계에서 잘린 불완전 시퀀스는 U+FFFD 로 디코딩된다 — 그 꼬리만 제거한다.
  const sliced = buf.subarray(0, maxBytes).toString("utf-8").replace(/�+$/u, "");
  return { text: sliced, truncated: true };
}

/**
 * base→next 변화의 기계 diff 를 만든다.
 * added/removed 는 항상 절단 전 전체 diff 기준이다 — 절단 대상은 text 뿐이다.
 */
export function computeChangeDiff(
  baseText: string | null,
  nextText: string | null,
  opts: ComputeChangeDiffOptions,
): ChangeDiff {
  const common = {
    baseHash: opts.baseHash,
    contentHash: opts.contentHash,
    pruned: false,
    diffAt: opts.now,
  };

  if (nextText === null) {
    const removed = baseText === null ? 0 : countLines(baseText, "").removed;
    return { ...common, format: "deleted", added: 0, removed, truncated: false, text: "" };
  }

  if (hasNullByte(nextText) || (baseText !== null && hasNullByte(baseText))) {
    return { ...common, format: "binary", added: 0, removed: 0, truncated: false, text: "" };
  }

  const base = baseText ?? "";
  const { added, removed } = countLines(base, nextText);
  const full = createTwoFilesPatch(BASE_LABEL, NEXT_LABEL, base, nextText, "", "", { context: 3 });
  const { text, truncated } = truncateToBytes(full, opts.maxBytes);

  return {
    ...common,
    format: baseText === null ? "added" : "unified",
    added,
    removed,
    truncated,
    text,
  };
}

/** 사이드카·보고용 사람 읽는 표현. 본문이 없는 사유를 사유대로 구분해 적는다. */
export function renderDiffSection(diff: ChangeDiff | null | undefined): string {
  if (!diff) return "(정보 없음 — 이 쪽 변경 diff 를 구할 수 없음)";
  const stat = `+${diff.added} -${diff.removed} (format=${diff.format})`;
  if (diff.format === "binary") return `${stat}\n(바이너리 — 본문 없음)`;
  if (diff.format === "deleted") return `${stat}\n(삭제됨 — 본문 없음)`;
  if (diff.pruned) return `${stat}\n(원격 매니페스트 예산 초과로 본문이 정리됨)`;
  if (diff.text.length === 0) return `${stat}\n(본문 없음)`;
  return diff.truncated ? `${stat}\n${diff.text}\n(... 상한 초과로 절단됨)` : `${stat}\n${diff.text}`;
}

/**
 * 매니페스트 전체 diff 본문이 예산 안에 들도록 정리한다.
 * 최신 diffAt 부터 본문을 유지하고, 예산을 넘긴 것은 text 만 비우고 pruned=true 로 표시한다.
 * truncated·added·removed·해시는 손대지 않는다 — 두 신호가 섞이면 소비자가 오독한다.
 * 멱등이다. CAS 재시도로 fresh 매니페스트에 다시 돌아도 결과가 같다.
 */
export function pruneChangeDiffs(manifest: Manifest, maxTotalBytes: number): void {
  const withDiff: Array<{ diff: ChangeDiff; key: string }> = [];
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (entry.changeDiff) withDiff.push({ diff: entry.changeDiff, key });
  }
  if (withDiff.length === 0) return;

  // diffAt 내림차순. 동률은 키 사전순으로 고정해 머신 간 결과가 갈리지 않게 한다.
  withDiff.sort((a, b) => b.diff.diffAt - a.diff.diffAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let used = 0;
  for (const { diff } of withDiff) {
    const bytes = Buffer.byteLength(diff.text, "utf-8");
    if (bytes === 0) {
      // 이미 비어 있음 — 절단으로 비었든 이전 prune 이었든 예산을 더 쓰지 않는다.
      continue;
    }
    if (used + bytes <= maxTotalBytes) {
      used += bytes;
      continue;
    }
    diff.text = "";
    diff.pruned = true;
  }
}
