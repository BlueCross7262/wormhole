import * as crypto from "crypto";
import * as fs from "fs/promises";
import type { Sha256Hex } from "../types.js";

// 콘텐츠 → sha256 hex 소문자
export function sha256(data: string | Buffer | Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// 파일 해시. 없으면 null.
export async function hashFile(absPath: string): Promise<Sha256Hex | null> {
  try {
    const buf = await fs.readFile(absPath);
    return sha256(buf);
  } catch {
    return null;
  }
}

// blob 파일명 산출용: sha256(logicalKey) — 논리경로 비노출(zero-knowledge).
export function blobHash(logicalKey: string): Sha256Hex {
  return sha256(logicalKey);
}

// 완성 blob 파일명: "<sha256(logicalKey)>.age"
export function blobName(logicalKey: string): string {
  return `${blobHash(logicalKey)}.age`;
}
