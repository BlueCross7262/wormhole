import type { RemoteStore } from "../webdav/client.js";
import type { AgeCrypto } from "./age.js";
import type { Logger } from "../types.js";
import { deriveAgeIdentity, generateSaltB64, type KdfParams } from "./kdf.js";
import { z } from "zod";

// 원격에 평문으로 보관하는 키 파라미터. salt 는 비밀이 아니다.
// sentinel 은 파생키로 암호화한 고정 평문 — 새 기기에서 passphrase 정합성 검증에 사용.
export interface KeyParamsFile {
  version: number;
  kdf: "scrypt";
  saltB64: string;
  N: number;
  r: number;
  p: number;
  sentinel: string; // armored age 암호문
}

const KEYPARAMS_REMOTE = "keyparams.json";
const SENTINEL_PLAINTEXT = "claude-sync passphrase verification v1";

// 원격 keyparams.json 은 신뢰 불가 입력 — 구조를 zod 로 검증한다.
const KeyParamsSchema = z.object({
  version: z.number().int(),
  kdf: z.literal("scrypt"),
  saltB64: z.string().min(1),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  sentinel: z.string().min(1),
});

export interface EnsureCryptoArgs {
  remote: RemoteStore;
  crypto: AgeCrypto;
  passphrase: string;
  params: KdfParams;
  derivedKeyPath: string;
  machineId: string;
  logger?: Logger;
}

export interface EnsureCryptoResult {
  // 원격 keyparams 를 이번에 새로 만들었는지(=이 기기가 최초 기기).
  created: boolean;
  recipient: string;
}

// 원격 keyparams.json 을 기준으로 AgeCrypto 를 준비한다(locked decision #1).
//
// - 원격에 keyparams 가 없으면(최초 기기): salt 생성 → 키 파생 → sentinel 암호화 → keyparams 업로드.
// - 원격에 있으면(신규 기기): 원격 salt/params 로 키를 파생한 뒤 sentinel 을 복호 시도해
//   passphrase 가 원격을 복호화할 수 있는지 검증한다. 실패하면 잘못된 passphrase 로 간주하고 throw.
//
// 어느 경우든 파생된 identity 는 derivedKeyPath(age-key.txt)에 0600 으로 캐시된다.
export async function ensureCryptoReady(args: EnsureCryptoArgs): Promise<EnsureCryptoResult> {
  const { remote, crypto, passphrase, params, derivedKeyPath, machineId, logger } = args;

  const existingRaw = await remote.getTextIfExists(KEYPARAMS_REMOTE);

  if (existingRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch (err) {
      throw new Error(`원격 keyparams.json 파싱 실패: ${String((err as Error).message)}`);
    }
    const validated = KeyParamsSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`원격 keyparams.json 구조 검증 실패(손상/비호환): ${validated.error.message}`);
    }
    const kp: KeyParamsFile = validated.data;
    // 원격이 진실의 원천 — 모든 기기가 동일 salt/params 로 파생해야 키가 일치한다.
    const remoteParams: KdfParams = { N: kp.N, r: kp.r, p: kp.p };
    const identity = deriveAgeIdentity(passphrase, kp.saltB64, remoteParams);
    await crypto.initWithIdentity(identity, derivedKeyPath);

    // 신규 기기 검증: sentinel 복호. 잘못된 passphrase 면 여기서 실패한다.
    try {
      const decoded = await crypto.decryptToString(kp.sentinel);
      if (decoded !== SENTINEL_PLAINTEXT) {
        throw new Error("sentinel 평문 불일치");
      }
    } catch (err) {
      throw new Error(
        `passphrase 검증 실패 — 이 passphrase 로 원격 데이터를 복호화할 수 없음. ` +
          `다른 기기와 동일한 passphrase 인지 확인하라. (${String((err as Error).message)})`,
      );
    }
    logger?.info("passphrase 검증 성공 — 원격 keyparams 사용");
    return { created: false, recipient: crypto.recipient };
  }

  // 최초 기기: salt 생성 → 파생 → sentinel 암호화 → 업로드.
  const saltB64 = generateSaltB64();
  const identity = deriveAgeIdentity(passphrase, saltB64, params);
  await crypto.initWithIdentity(identity, derivedKeyPath);

  const sentinel = await crypto.encrypt(SENTINEL_PLAINTEXT);
  const kp: KeyParamsFile = {
    version: 1,
    kdf: "scrypt",
    saltB64,
    N: params.N,
    r: params.r,
    p: params.p,
    sentinel,
  };
  // 부트스트랩 1회성 쓰기. 최초 init 시에는 아직 blob 이 없어 경쟁이 사실상 무해하다.
  await remote.putAtomic(KEYPARAMS_REMOTE, JSON.stringify(kp, null, 2), machineId);
  logger?.warn(
    "원격 keyparams 신규 생성 — 이 passphrase 가 vault 표준이 됨. 다른 기기는 동일 passphrase 를 사용하라.",
  );
  return { created: true, recipient: crypto.recipient };
}
