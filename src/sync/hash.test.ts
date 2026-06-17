import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { sha256, blobHash, blobName, hashFile } from "./hash.js";

describe("sha256", () => {
  test("empty string returns known hex vector", () => {
    assert.equal(
      sha256(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("'abc' returns known hex vector", () => {
    assert.equal(
      sha256("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("output is 64-char lowercase hex", () => {
    const result = sha256("hello world");
    assert.match(result, /^[0-9a-f]{64}$/);
  });

  test("Buffer input produces same result as string input", () => {
    const str = "test-buffer";
    const buf = Buffer.from(str, "utf8");
    assert.equal(sha256(buf), sha256(str));
  });

  test("Uint8Array input produces same result as string input", () => {
    const str = "uint8-input";
    const arr = new TextEncoder().encode(str);
    assert.equal(sha256(arr), sha256(str));
  });

  test("deterministic: same input gives same output", () => {
    assert.equal(sha256("determinism"), sha256("determinism"));
  });

  test("different inputs give different outputs", () => {
    assert.notEqual(sha256("foo"), sha256("bar"));
  });
});

describe("blobHash", () => {
  test("returns sha256 of the logical key", () => {
    assert.equal(blobHash("some/path/key"), sha256("some/path/key"));
  });

  test("deterministic for same key", () => {
    assert.equal(blobHash("key"), blobHash("key"));
  });

  test("different keys give different hashes", () => {
    assert.notEqual(blobHash("a/b"), blobHash("c/d"));
  });

  test("output is 64-char lowercase hex", () => {
    assert.match(blobHash("notes/todo.md"), /^[0-9a-f]{64}$/);
  });
});

describe("blobName", () => {
  test("format is '<sha256(key)>.age'", () => {
    const key = "docs/readme.md";
    const expected = `${sha256(key)}.age`;
    assert.equal(blobName(key), expected);
  });

  test("ends with .age extension", () => {
    assert.ok(blobName("any/path").endsWith(".age"));
  });

  test("deterministic for same key", () => {
    assert.equal(blobName("x"), blobName("x"));
  });

  test("different keys give different names", () => {
    assert.notEqual(blobName("alpha"), blobName("beta"));
  });

  test("stem portion is 64-char hex", () => {
    const name = blobName("stem-test");
    const stem = name.slice(0, -4);
    assert.match(stem, /^[0-9a-f]{64}$/);
  });
});

describe("hashFile", () => {
  test("returns sha256 of file contents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-hash-test-"));
    try {
      const filePath = path.join(dir, "sample.txt");
      const content = "hello file\n";
      await fs.writeFile(filePath, content, "utf8");
      const result = await hashFile(filePath);
      assert.equal(result, sha256(Buffer.from(content, "utf8")));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null for non-existent file", async () => {
    const result = await hashFile("/nonexistent/path/that/does/not/exist.txt");
    assert.equal(result, null);
  });

  test("deterministic: same file content gives same hash", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-hash-det-"));
    try {
      const filePath = path.join(dir, "det.txt");
      await fs.writeFile(filePath, "determinism content", "utf8");
      const h1 = await hashFile(filePath);
      const h2 = await hashFile(filePath);
      assert.equal(h1, h2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("empty file returns sha256 of empty bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-hash-empty-"));
    try {
      const filePath = path.join(dir, "empty.txt");
      await fs.writeFile(filePath, "");
      const result = await hashFile(filePath);
      assert.equal(
        result,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("different file contents give different hashes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-hash-diff-"));
    try {
      const fileA = path.join(dir, "a.txt");
      const fileB = path.join(dir, "b.txt");
      await fs.writeFile(fileA, "content-A", "utf8");
      await fs.writeFile(fileB, "content-B", "utf8");
      const hA = await hashFile(fileA);
      const hB = await hashFile(fileB);
      assert.notEqual(hA, hB);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("result matches sha256 of raw buffer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-hash-buf-"));
    try {
      const filePath = path.join(dir, "binary.bin");
      const bytes = Buffer.from([0x00, 0xff, 0x80, 0x42, 0x01]);
      await fs.writeFile(filePath, bytes);
      const result = await hashFile(filePath);
      assert.equal(result, sha256(bytes));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
