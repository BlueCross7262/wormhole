import { scryptSync, randomBytes } from "node:crypto";
import { bech32 } from "@scure/base";

// scrypt KDF 파라미터.
// N 은 작업계수(메모리/CPU 비용, 2의 거듭제곱), r 블록크기, p 병렬도.
export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

// 기본값: N=2^16(=65536) → 메모리 약 64MB, 1회 파생 1초 미만.
// 더 강하게: N=2^17(약 128MB) 또는 2^18(약 256MB). config.crypto.kdfN 으로 조정.
export const DEFAULT_KDF: KdfParams = { N: 1 << 16, r: 8, p: 1 };

// 16바이트 랜덤 salt 를 base64 로 반환. salt 는 비밀이 아니며 원격에 평문 보관한다.
export function generateSaltB64(): string {
  return randomBytes(16).toString("base64");
}

// passphrase + salt → 결정적 age identity 문자열("AGE-SECRET-KEY-1...").
//
// age-encryption(typage) 의 generateIdentity 와 동일한 인코딩을 사용한다:
//   bech32.encodeFromBytes("AGE-SECRET-KEY-", <32바이트 scalar>).toUpperCase()
// 차이는 scalar 가 랜덤이 아니라 scrypt(passphrase, salt) 로 파생된다는 점뿐이다.
// 따라서 동일 passphrase + 동일 salt + 동일 params → 모든 머신에서 동일 identity 가 나오며,
// 기기 간 키 파일 복사 없이 같은 키를 재현할 수 있다(locked decision #1).
export function deriveAgeIdentity(
  passphrase: string,
  saltB64: string,
  params: KdfParams = DEFAULT_KDF,
): string {
  if (passphrase === "") {
    throw new Error("passphrase 가 비어 있음 — 키 파생 불가");
  }
  const salt = Buffer.from(saltB64, "base64");
  if (salt.length === 0) {
    throw new Error("salt 가 비어 있음 — 키 파생 불가");
  }
  // scrypt 메모리 요구량 ≈ 128 * N * r 바이트. Node 기본 maxmem(32MB)을 초과하므로 명시한다.
  const maxmem = 128 * params.N * params.r * 2 + (1 << 24);
  const scalar = scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
  return bech32.encodeFromBytes("AGE-SECRET-KEY-", new Uint8Array(scalar)).toUpperCase();
}
