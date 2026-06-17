import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import * as age from "age-encryption";
import { AgeCrypto } from "./age.js";
import { deriveAgeIdentity, generateSaltB64 } from "./kdf.js";

// Cheap KDF params so deriving a test identity stays fast/deterministic.
// (scrypt N=2^14 keeps the suite well under a second while still exercising the real path.)
const FAST_KDF = { N: 1 << 14, r: 8, p: 1 };

// Deterministic identity #1 (the "owner" of every roundtrip in this suite).
const SALT_A = Buffer.from("0123456789abcdef", "utf-8").toString("base64");
const IDENTITY_A = deriveAgeIdentity("correct horse battery staple", SALT_A, FAST_KDF);

// Distinct identity #2 used for the wrong-key rejection test.
const SALT_B = Buffer.from("fedcba9876543210", "utf-8").toString("base64");
const IDENTITY_B = deriveAgeIdentity("a totally different passphrase", SALT_B, FAST_KDF);

// Helper: a ready-to-use AgeCrypto bound to a given identity (no key file cached).
async function makeCrypto(identity: string): Promise<AgeCrypto> {
  const c = new AgeCrypto();
  await c.initWithIdentity(identity);
  return c;
}

describe("AgeCrypto", () => {
  let crypto: AgeCrypto;

  before(async () => {
    crypto = await makeCrypto(IDENTITY_A);
  });

  describe("initWithIdentity / readiness", () => {
    test("fresh instance is not ready and recipient getter throws", () => {
      const fresh = new AgeCrypto();
      assert.equal(fresh.isReady, false);
      assert.throws(() => fresh.recipient, /미초기화/);
    });

    test("becomes ready and exposes a valid age recipient after init", async () => {
      const c = await makeCrypto(IDENTITY_A);
      assert.equal(c.isReady, true);
      assert.match(c.recipient, /^age1[0-9a-z]+$/);
      // recipient must match what age derives from the same identity (no surprises).
      assert.equal(c.recipient, await age.identityToRecipient(IDENTITY_A));
    });

    test("identity is trimmed before use (surrounding whitespace tolerated)", async () => {
      const c = new AgeCrypto();
      await c.initWithIdentity(`  \n${IDENTITY_A}\t `);
      assert.equal(c.isReady, true);
      assert.equal(c.recipient, await age.identityToRecipient(IDENTITY_A));
    });

    test("rejects an identity without the AGE-SECRET-KEY-1 prefix", async () => {
      const c = new AgeCrypto();
      await assert.rejects(
        () => c.initWithIdentity("not-a-valid-age-key"),
        /유효하지 않은 age identity/,
      );
      assert.equal(c.isReady, false);
    });

    test("rejects an empty identity", async () => {
      const c = new AgeCrypto();
      await assert.rejects(() => c.initWithIdentity("   "), /유효하지 않은 age identity/);
    });
  });

  describe("encrypt output shape", () => {
    test("produces ASCII-armored ciphertext", async () => {
      const armored = await crypto.encrypt("hello");
      assert.match(armored, /-----BEGIN AGE ENCRYPTED FILE-----/);
      assert.match(armored, /-----END AGE ENCRYPTED FILE-----/);
    });

    test("encrypting the same plaintext twice yields different ciphertext (nonce/ephemeral key)", async () => {
      const a = await crypto.encrypt("repeatable plaintext");
      const b = await crypto.encrypt("repeatable plaintext");
      assert.notEqual(a, b);
      // ...but both still decrypt back to the same plaintext.
      assert.equal(await crypto.decryptToString(a), "repeatable plaintext");
      assert.equal(await crypto.decryptToString(b), "repeatable plaintext");
    });
  });

  describe("roundtrip", () => {
    test("string plaintext roundtrips via decryptToString", async () => {
      const msg = "the quick brown fox 🦊 — 다국어 텍스트";
      const armored = await crypto.encrypt(msg);
      assert.equal(await crypto.decryptToString(armored), msg);
    });

    test("Uint8Array payload (incl. all byte values) roundtrips exactly via decrypt", async () => {
      // Every byte 0..255 — catches any latin1/utf-8 corruption.
      const payload = new Uint8Array(256);
      for (let i = 0; i < 256; i++) payload[i] = i;
      const armored = await crypto.encrypt(payload);
      const out = await crypto.decrypt(armored);
      assert.deepEqual(out, payload);
    });

    test("Buffer payload with NULs and high bytes roundtrips exactly", async () => {
      const payload = Buffer.from([0x00, 0xff, 0x1f, 0x8b, 0x00, 0x42, 0x00]);
      const armored = await crypto.encrypt(payload);
      const out = await crypto.decrypt(armored);
      assert.deepEqual(Buffer.from(out), payload);
    });

    test("empty payload roundtrips to a zero-length array", async () => {
      const armored = await crypto.encrypt(new Uint8Array(0));
      const out = await crypto.decrypt(armored);
      assert.equal(out.length, 0);
    });

    test("empty string roundtrips", async () => {
      const armored = await crypto.encrypt("");
      assert.equal(await crypto.decryptToString(armored), "");
    });

    test("large (1 MiB) payload roundtrips exactly", async () => {
      const big = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
      const armored = await crypto.encrypt(big);
      const out = Buffer.from(await crypto.decrypt(armored));
      assert.equal(out.length, big.length);
      assert.ok(out.equals(big));
    });

    test("decrypt and decryptToString agree on the same ciphertext", async () => {
      const msg = "consistency check";
      const armored = await crypto.encrypt(msg);
      const bytes = await crypto.decrypt(armored);
      const str = await crypto.decryptToString(armored);
      assert.equal(Buffer.from(bytes).toString("utf-8"), str);
    });
  });

  describe("cross-instance interop (determinism of derived identity)", () => {
    test("a second instance built from the SAME derived identity decrypts the first's ciphertext", async () => {
      // Re-derive the identity from scratch (same passphrase+salt+params) → must be byte-identical.
      const rederived = deriveAgeIdentity("correct horse battery staple", SALT_A, FAST_KDF);
      assert.equal(rederived, IDENTITY_A);

      const other = await makeCrypto(rederived);
      const armored = await crypto.encrypt("shared-key payload");
      assert.equal(await other.decryptToString(armored), "shared-key payload");
    });
  });

  describe("wrong key", () => {
    test("decrypting with a different identity rejects", async () => {
      const armored = await crypto.encrypt("secret");
      const stranger = await makeCrypto(IDENTITY_B);
      await assert.rejects(() => stranger.decrypt(armored));
    });

    test("decryptToString with a different identity rejects", async () => {
      const armored = await crypto.encrypt("secret");
      const stranger = await makeCrypto(IDENTITY_B);
      await assert.rejects(() => stranger.decryptToString(armored));
    });
  });

  describe("uninitialized usage", () => {
    test("encrypt before init throws (recipient unavailable)", async () => {
      const fresh = new AgeCrypto();
      await assert.rejects(() => fresh.encrypt("x"), /미초기화/);
    });

    test("decrypt before init throws (identity unavailable)", async () => {
      const fresh = new AgeCrypto();
      await assert.rejects(() => fresh.decrypt("garbage"), /미초기화/);
    });

    test("decryptToString before init throws (identity unavailable)", async () => {
      const fresh = new AgeCrypto();
      await assert.rejects(() => fresh.decryptToString("garbage"), /미초기화/);
    });
  });

  describe("malformed input", () => {
    test("decrypting non-armored garbage rejects", async () => {
      await assert.rejects(() => crypto.decrypt("this is not armored age data"));
    });
  });
});
