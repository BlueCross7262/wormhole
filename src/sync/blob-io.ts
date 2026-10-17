import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { AgeCrypto } from "../crypto/age.js";

export const IO_CONCURRENCY = 8;

export const BLOB_MAGIC = Buffer.from("CSZ1", "ascii");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface BlobLimits {
  maxArmored: number;
  maxPlain: number;
}

export async function mapLimit<T>(
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
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
}

export async function sealBlob(crypto: AgeCrypto, plaintext: Buffer | string): Promise<string> {
  const raw = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;
  const compressed = await gzipAsync(raw);
  const tagged = Buffer.concat([BLOB_MAGIC, compressed]);
  return crypto.encrypt(new Uint8Array(tagged));
}

export async function openBlob(
  crypto: AgeCrypto,
  armored: string,
  limits?: BlobLimits,
): Promise<Buffer> {
  if (limits && armored.length > limits.maxArmored) {
    throw new RangeError("blob armored size limit exceeded");
  }
  const plain = Buffer.from(await crypto.decrypt(armored));
  if (
    plain.length >= BLOB_MAGIC.length &&
    plain.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)
  ) {
    const body = plain.subarray(BLOB_MAGIC.length);
    const out = limits
      ? await gunzipAsync(body, { maxOutputLength: limits.maxPlain })
      : await gunzipAsync(body);
    return Buffer.from(out);
  }
  if (limits && plain.length > limits.maxPlain) {
    throw new RangeError("blob plain size limit exceeded");
  }
  return plain;
}
