import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveAgeIdentity, generateSaltB64, DEFAULT_KDF, type KdfParams } from "./kdf.js";

// 테스트 비용을 낮추기 위한 약한 KDF 파라미터.
// 결정성/민감도 검증은 파라미터 세기와 무관하므로 N 을 낮춰 빠르게 돌린다.
const FAST: KdfParams = { N: 1 << 8, r: 8, p: 1 };

// 16바이트 salt 의 정규 base64 표현(generateSaltB64 와 동일한 길이).
const SALT_A = Buffer.alloc(16, 0xaa).toString("base64");
const SALT_B = Buffer.alloc(16, 0xbb).toString("base64");

describe("deriveAgeIdentity — 결정성", () => {
  test("동일 passphrase + 동일 salt + 동일 params → 바이트 동일 identity", () => {
    const a = deriveAgeIdentity("correct horse battery staple", SALT_A, FAST);
    const b = deriveAgeIdentity("correct horse battery staple", SALT_A, FAST);
    assert.equal(a, b);
  });

  test("DEFAULT_KDF 로도 두 번 호출 시 동일(기본 파라미터 결정성)", () => {
    const a = deriveAgeIdentity("pw-default", SALT_A);
    const b = deriveAgeIdentity("pw-default", SALT_A, DEFAULT_KDF);
    assert.equal(a, b);
  });
});

describe("deriveAgeIdentity — 민감도", () => {
  test("같은 passphrase, 다른 salt → 다른 identity", () => {
    const a = deriveAgeIdentity("same-pass", SALT_A, FAST);
    const b = deriveAgeIdentity("same-pass", SALT_B, FAST);
    assert.notEqual(a, b);
  });

  test("다른 passphrase, 같은 salt → 다른 identity", () => {
    const a = deriveAgeIdentity("pass-one", SALT_A, FAST);
    const b = deriveAgeIdentity("pass-two", SALT_A, FAST);
    assert.notEqual(a, b);
  });

  test("N 변경 → 파생 키 변경", () => {
    const base = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 8, r: 8, p: 1 });
    const changedN = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 9, r: 8, p: 1 });
    assert.notEqual(base, changedN);
  });

  test("r 변경 → 파생 키 변경", () => {
    const base = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 8, r: 8, p: 1 });
    const changedR = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 8, r: 4, p: 1 });
    assert.notEqual(base, changedR);
  });

  test("p 변경 → 파생 키 변경", () => {
    const base = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 8, r: 8, p: 1 });
    const changedP = deriveAgeIdentity("param-pass", SALT_A, { N: 1 << 8, r: 8, p: 2 });
    assert.notEqual(base, changedP);
  });
});

describe("deriveAgeIdentity — 출력 형식", () => {
  test("well-formed age secret key: 'AGE-SECRET-KEY-1' 로 시작", () => {
    const id = deriveAgeIdentity("format-pass", SALT_A, FAST);
    assert.ok(
      id.startsWith("AGE-SECRET-KEY-1"),
      `identity 가 AGE-SECRET-KEY-1 로 시작하지 않음: ${id}`,
    );
  });

  test("출력은 대문자 + bech32 charset(소문자 없음)", () => {
    const id = deriveAgeIdentity("format-pass-2", SALT_A, FAST);
    assert.equal(id, id.toUpperCase());
    // bech32 본문은 [0-9 a-z] 인데 .toUpperCase() 후이므로 소문자가 남아선 안 된다.
    assert.match(id, /^AGE-SECRET-KEY-1[0-9A-Z]+$/);
  });
});

describe("deriveAgeIdentity — 에러 입력", () => {
  test("빈 passphrase → throw", () => {
    assert.throws(() => deriveAgeIdentity("", SALT_A, FAST), /passphrase/);
  });

  test("빈 salt(base64 빈 문자열) → throw", () => {
    assert.throws(() => deriveAgeIdentity("nonempty", "", FAST), /salt/);
  });
});

describe("generateSaltB64", () => {
  test("유효한 base64 이며 16바이트로 디코딩된다", () => {
    const saltB64 = generateSaltB64();
    // base64 charset 검증.
    assert.match(saltB64, /^[A-Za-z0-9+/]+={0,2}$/);
    const decoded = Buffer.from(saltB64, "base64");
    assert.equal(decoded.length, 16);
    // 16바이트 → base64 길이 24(패딩 '=' 2개 포함).
    assert.equal(saltB64.length, 24);
  });

  test("두 번 호출하면 서로 다른 값(랜덤성)", () => {
    const a = generateSaltB64();
    const b = generateSaltB64();
    assert.notEqual(a, b);
  });

  test("생성된 salt 는 deriveAgeIdentity 에서 그대로 사용 가능", () => {
    const salt = generateSaltB64();
    const id1 = deriveAgeIdentity("roundtrip", salt, FAST);
    const id2 = deriveAgeIdentity("roundtrip", salt, FAST);
    assert.equal(id1, id2);
    assert.ok(id1.startsWith("AGE-SECRET-KEY-1"));
  });
});

describe("DEFAULT_KDF 형태", () => {
  test("N=65536, r=8, p=1", () => {
    assert.deepEqual(DEFAULT_KDF, { N: 65536, r: 8, p: 1 });
    assert.equal(DEFAULT_KDF.N, 1 << 16);
  });
});
