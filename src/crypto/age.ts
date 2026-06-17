import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as age from "age-encryption";
import type { Logger } from "../types.js";

// AgeCrypto — age X25519 identity 로드/생성, armored 암호/복호.
// identity(비밀)/recipient(공개)는 load/generate 후 내부 보관. 키 노출 최소화.
export class AgeCrypto {
  #identity: string | null = null;
  #recipient: string | null = null;
  readonly #logger?: Logger;

  constructor(logger?: Logger) {
    this.#logger = logger;
  }

  // passphrase 로부터 결정적으로 파생된 age identity 로 초기화한다(kdf.deriveAgeIdentity 결과).
  // identity 에서 recipient(공개키)를 산출하고, derivedKeyPath 가 주어지면 0600 으로 캐시한다.
  // passphrase 원문은 절대 저장하지 않는다 — 캐시되는 것은 파생된 키(identity)뿐이다(locked decision #1).
  async initWithIdentity(identity: string, derivedKeyPath?: string): Promise<void> {
    const trimmed = identity.trim();
    if (!trimmed.startsWith("AGE-SECRET-KEY-1")) {
      throw new Error("유효하지 않은 age identity — 'AGE-SECRET-KEY-1' 로 시작해야 함");
    }
    // identity 검증 겸 recipient 산출(잘못된 키면 여기서 throw).
    const recipient = await age.identityToRecipient(trimmed);
    this.#identity = trimmed;
    this.#recipient = recipient;

    if (derivedKeyPath) {
      await AgeCrypto.#cacheIdentity(derivedKeyPath, trimmed, this.#logger);
    }
    this.#logger?.debug("age identity 초기화 완료(passphrase 파생)");
  }

  // initWithIdentity 선행 여부.
  get isReady(): boolean {
    return this.#identity !== null && this.#recipient !== null;
  }

  // 현재 recipient(공개키). 미초기화면 throw.
  get recipient(): string {
    if (this.#recipient === null) {
      throw new Error("AgeCrypto 미초기화 — initWithIdentity 선행 필요");
    }
    return this.#recipient;
  }

  // 평문 → armored 암호문("-----BEGIN AGE...").
  async encrypt(plaintext: string | Uint8Array): Promise<string> {
    const recipient = this.recipient;
    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    const ciphertext = await encrypter.encrypt(plaintext);
    return age.armor.encode(ciphertext);
  }

  // armored 암호문 → 평문 Uint8Array.
  async decrypt(armoredCiphertext: string): Promise<Uint8Array> {
    const identity = this.#requireIdentity();
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    const ciphertext = age.armor.decode(armoredCiphertext);
    return decrypter.decrypt(ciphertext);
  }

  // armored 암호문 → 평문 string(utf-8).
  async decryptToString(armoredCiphertext: string): Promise<string> {
    const identity = this.#requireIdentity();
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    const ciphertext = age.armor.decode(armoredCiphertext);
    return decrypter.decrypt(ciphertext, "text");
  }

  #requireIdentity(): string {
    if (this.#identity === null) {
      throw new Error("AgeCrypto 미초기화 — initWithIdentity 선행 필요");
    }
    return this.#identity;
  }

  // 파생된 identity 를 0600 으로 캐시. 부모 디렉터리 mkdir -p.
  static async #cacheIdentity(cachePath: string, identity: string, logger?: Logger): Promise<void> {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const body = `# wormhole 파생 age 키 — passphrase 로부터 자동 생성됨. 수동 편집 금지.\n${identity}\n`;
    await fs.writeFile(cachePath, body, { encoding: "utf-8", mode: 0o600 });
    try {
      await fs.chmod(cachePath, 0o600);
    } catch {
      // Windows 는 chmod 무의미 — 사용자 프로파일 ACL 의존(best-effort).
    }
    logger?.debug(`파생 키 캐시 완료: ${cachePath}`);
  }
}
