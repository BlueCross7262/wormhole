import { z } from "zod";
import { blobHash, sha256 } from "./hash.js";
import { isValidLogicalKey } from "./paths.js";
import type {
  LogicalKey,
  ReasonInput,
  ReasonItem,
  ReasonRejectCode,
  ReasonView,
  Sha256Hex,
} from "../types.js";

export const REASON_MAX_CHARS = 2000;
export const REASON_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const REASON_BLOB_MAX_ARMORED = 8 * 1024 * 1024;
export const REASON_VIEW_PER_KEY = 5;
export const REASON_VIEW_TOTAL_BYTES = 65_536;
export const PENDING_DIFF_PER_KEY = 1024;
export const PENDING_DIFF_TOTAL = 32_768;

const HEX64 = /^[0-9a-f]{64}$/;

export const ReasonsRefSchema = z.object({
  hash: z.string().regex(HEX64),
  count: z.number().int().nonnegative(),
  lastGeneration: z.number().int().nonnegative(),
});

const ReasonItemSchema = z.object({
  generation: z.number().int().nonnegative(),
  machineId: z.string().max(256),
  at: z.number(),
  contentHash: z.string().max(128),
  reason: z.string().max(REASON_MAX_CHARS),
});

const ReasonLogSchema = z.object({
  v: z.literal(1),
  items: z.array(ReasonItemSchema),
});

const ReasonInputFileSchema = z.array(
  z.object({
    logicalKey: z.string(),
    reason: z.string(),
    contentHash: z.string().regex(HEX64).optional(),
  }),
);

export function reasonBlobPath(logicalKey: string, hash: Sha256Hex): string {
  return `blobs/r-${blobHash(logicalKey)}-${hash}.age`;
}

export function encodeReasonLog(items: ReasonItem[]): { plain: Buffer; hash: Sha256Hex } {
  const plain = Buffer.from(JSON.stringify({ v: 1, items }), "utf-8");
  return { plain, hash: sha256(plain) };
}

export function decodeReasonLog(plain: Buffer): ReasonItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString("utf-8"));
  } catch {
    return null;
  }
  const result = ReasonLogSchema.safeParse(parsed);
  return result.success ? (result.data.items as ReasonItem[]) : null;
}

export function appendReasonItem(
  items: ReasonItem[],
  item: ReasonItem,
): { items: ReasonItem[]; changed: boolean } {
  const duplicate = items.some(
    (i) => i.generation === item.generation && i.machineId === item.machineId && i.reason === item.reason,
  );
  if (duplicate) return { items, changed: false };
  return { items: [...items, item], changed: true };
}

export function validateReasonText(reason: string): "empty" | "too-long" | null {
  if (reason.trim().length === 0) return "empty";
  if (reason.length > REASON_MAX_CHARS) return "too-long";
  return null;
}

export function parseReasonInputs(text: string): ReasonInput[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`이유 파일이 JSON 이 아님: ${(err as Error).message}`);
  }
  const result = ReasonInputFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`이유 파일 형식 오류: ${result.error.message}`);
  }
  return result.data as ReasonInput[];
}

export function buildReasonView(items: ReasonItem[], baseGeneration: number): ReasonView | null {
  const fresh = items.filter((i) => i.generation > baseGeneration);
  if (fresh.length === 0) return null;
  const kept = fresh.slice(-REASON_VIEW_PER_KEY);
  return { items: kept, omitted: fresh.length - kept.length };
}

export function reasonViewBytes(view: ReasonView): number {
  let total = 0;
  for (const i of view.items) total += Buffer.byteLength(i.reason, "utf-8");
  return total;
}

export interface ReasonWanted {
  reason: string;
  contentHash?: Sha256Hex;
}

export function prepareReasonInputs(
  inputs: ReasonInput[],
  requireHash: boolean,
): {
  wanted: Map<LogicalKey, ReasonWanted>;
  rejected: Array<{ logicalKey: LogicalKey; code: ReasonRejectCode }>;
} {
  const wanted = new Map<LogicalKey, ReasonWanted>();
  const rejected: Array<{ logicalKey: LogicalKey; code: ReasonRejectCode }> = [];
  const counts = new Map<LogicalKey, number>();
  for (const input of inputs) counts.set(input.logicalKey, (counts.get(input.logicalKey) ?? 0) + 1);

  const seenDuplicate = new Set<LogicalKey>();
  for (const input of inputs) {
    const key = input.logicalKey;
    if ((counts.get(key) ?? 0) > 1) {
      if (!seenDuplicate.has(key)) {
        seenDuplicate.add(key);
        rejected.push({ logicalKey: key, code: "duplicate-key" });
      }
      continue;
    }
    if (!isValidLogicalKey(key)) {
      rejected.push({ logicalKey: key, code: "invalid-key" });
      continue;
    }
    const textCode = validateReasonText(input.reason);
    if (textCode) {
      rejected.push({ logicalKey: key, code: textCode });
      continue;
    }
    if (requireHash && input.contentHash === undefined) {
      rejected.push({ logicalKey: key, code: "hash-required" });
      continue;
    }
    wanted.set(key, {
      reason: input.reason,
      ...(requireHash && input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
    });
  }
  return { wanted, rejected };
}
