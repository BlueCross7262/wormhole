import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { maybeMigrateLegacyConfig, upsertDotEnvKey } from "./migrate-config.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wh-migrate-"));
  fs.mkdirSync(path.join(tmpHome, ".wormhole"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const legacyPath = () => path.join(tmpHome, ".wormhole", "config.json");
const newPath = () => path.join(tmpHome, ".claude", "wormhole-config.json");
const envPath = () => path.join(tmpHome, ".wormhole", ".env");

function writeLegacy(obj: unknown): void {
  fs.writeFileSync(legacyPath(), JSON.stringify(obj, null, 2));
}

describe("maybeMigrateLegacyConfig — no legacy", () => {
  test("레거시 없음 → no-op, migrated:false reason:no-legacy", async () => {
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "no-legacy");
    assert.equal(fs.existsSync(newPath()), false);
  });
});

describe("maybeMigrateLegacyConfig — happy path", () => {
  test("레거시 존재 → migrated:true, NEW 생성, 레거시 삭제", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(legacyPath()), false);
    assert.equal(fs.existsSync(newPath()), true);
  });

  test("NEW 에 self-entry 포함됨", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    await maybeMigrateLegacyConfig({ home: tmpHome });
    const newContent = JSON.parse(fs.readFileSync(newPath(), "utf-8")) as Record<string, unknown>;
    const targets = newContent.targets as Record<string, unknown> | undefined;
    const include = targets?.include ?? [];
    assert.ok(
      Array.isArray(include) && (include as string[]).includes(".claude/wormhole-config.json"),
      "self-entry 누락",
    );
  });

  test(".env 에 WORMHOLE_CONFIG 추가, 기존 비밀라인 정확 보존", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    fs.writeFileSync(envPath(), "WEBDAV_URL=https://dav.example.com\nWEBDAV_PASS=mysecret\n");
    await maybeMigrateLegacyConfig({ home: tmpHome });
    const envContent = fs.readFileSync(envPath(), "utf-8");
    const lines = envContent.split("\n").filter((l) => l.length > 0);
    const secretLines = ["WEBDAV_URL=https://dav.example.com", "WEBDAV_PASS=mysecret"];
    for (const secretLine of secretLines) {
      const found = lines.find((l) => l === secretLine);
      assert.equal(found, secretLine, `비밀라인 "${secretLine}" byte 정확 보존`);
    }
    assert.ok(lines.some((l) => l.startsWith("WORMHOLE_CONFIG=")), "WORMHOLE_CONFIG 추가됨");
  });

  test("멱등: 2회 실행 → 2번째 no-op, NEW 내용 불변", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    await maybeMigrateLegacyConfig({ home: tmpHome });
    const firstContent = fs.readFileSync(newPath(), "utf-8");
    const result2 = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result2.migrated, false);
    assert.equal((result2 as { reason: string }).reason, "no-legacy");
    assert.equal(fs.readFileSync(newPath(), "utf-8"), firstContent);
  });

  test("crash-resume: NEW=마이그레이션형(self-entry 있음) LEGACY=원본 → migrated:true 완료", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    fs.mkdirSync(path.dirname(newPath()), { recursive: true });
    fs.writeFileSync(
      newPath(),
      JSON.stringify(
        {
          remote: { url: "https://dav.example.com" },
          targets: { include: [".claude/wormhole-config.json"] },
        },
        null,
        2,
      ) + "\n",
    );
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(legacyPath()), false, "레거시 삭제됨");
    assert.equal(fs.existsSync(newPath()), true, "NEW 보존");
  });
});

describe("maybeMigrateLegacyConfig — portability reject", () => {
  test("remote.password 인라인 → migrated:false, 레거시 보존, NEW 미생성", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com", password: "s3cret" } });
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "portability-reject");
    assert.equal(fs.existsSync(legacyPath()), true);
    assert.equal(fs.existsSync(newPath()), false);
  });

  test("crypto.passphraseFile 절대경로 → migrated:false, 레거시 보존", async () => {
    const absPath =
      process.platform === "win32" ? "C:\\Users\\user\\.secret" : "/home/user/.secret";
    writeLegacy({
      remote: { url: "https://dav.example.com" },
      crypto: { passphraseFile: absPath },
    });
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "portability-reject");
    assert.equal(fs.existsSync(legacyPath()), true);
  });

  test("stateDir 절대경로(비틸드) → migrated:false, 레거시 보존", async () => {
    const absDir =
      process.platform === "win32" ? "C:\\Users\\user\\.wormhole" : "/home/user/.wormhole";
    writeLegacy({ remote: { url: "https://dav.example.com" }, stateDir: absDir });
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "portability-reject");
    assert.equal(fs.existsSync(legacyPath()), true);
  });

  test("top-level home 키 존재 → migrated:false, 레거시 보존", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" }, home: "/home/user" });
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "portability-reject");
    assert.equal(fs.existsSync(legacyPath()), true);
  });
});

describe("maybeMigrateLegacyConfig — error cases", () => {
  test("손편집 깨진 JSON → migrated:false, 레거시 보존", async () => {
    fs.writeFileSync(legacyPath(), "not valid json {{{");
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "legacy-parse-failed");
    assert.equal(fs.existsSync(legacyPath()), true);
  });

  test("NEW 존재+상이 → migrated:false reason:target-exists-divergent, 레거시 보존", async () => {
    writeLegacy({ remote: { url: "https://dav.example.com" } });
    fs.mkdirSync(path.dirname(newPath()), { recursive: true });
    fs.writeFileSync(newPath(), JSON.stringify({ different: "content" }));
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, false);
    assert.equal((result as { reason: string }).reason, "target-exists-divergent");
    assert.equal(fs.existsSync(legacyPath()), true);
  });

  test("NEW 존재+동일 → migrated:true, 레거시 삭제", async () => {
    const content = JSON.stringify({ remote: { url: "https://dav.example.com" } }, null, 2);
    fs.writeFileSync(legacyPath(), content);
    fs.mkdirSync(path.dirname(newPath()), { recursive: true });
    fs.writeFileSync(newPath(), content);
    const result = await maybeMigrateLegacyConfig({ home: tmpHome });
    assert.equal(result.migrated, true);
    assert.equal(fs.existsSync(legacyPath()), false);
    assert.equal(fs.existsSync(newPath()), true);
  });
});

describe("upsertDotEnvKey", () => {
  test("(a) 동일값 → no-op (파일 내용 불변)", async () => {
    const envFile = path.join(tmpHome, "test.env");
    const content = "WORMHOLE_CONFIG=/some/path\nOTHER=val\n";
    fs.writeFileSync(envFile, content);
    await upsertDotEnvKey(envFile, "WORMHOLE_CONFIG", "/some/path");
    assert.equal(fs.readFileSync(envFile, "utf-8"), content);
  });

  test("(b) 다른값 → 첫 라인 교체, 중복 제거", async () => {
    const envFile = path.join(tmpHome, "test.env");
    fs.writeFileSync(envFile, "WORMHOLE_CONFIG=old\nOTHER=val\nWORMHOLE_CONFIG=dup\n");
    await upsertDotEnvKey(envFile, "WORMHOLE_CONFIG", "new");
    const lines = fs
      .readFileSync(envFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    const wormholeLines = lines.filter((l) => l.startsWith("WORMHOLE_CONFIG="));
    assert.equal(wormholeLines.length, 1, "WORMHOLE_CONFIG 라인 1개");
    assert.equal(wormholeLines[0], "WORMHOLE_CONFIG=new");
    assert.ok(lines.includes("OTHER=val"), "OTHER 보존");
  });

  test("(c) 키 부재 → append", async () => {
    const envFile = path.join(tmpHome, "test.env");
    fs.writeFileSync(envFile, "OTHER=val\n");
    await upsertDotEnvKey(envFile, "WORMHOLE_CONFIG", "/new/path");
    const lines = fs
      .readFileSync(envFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.ok(lines.includes("OTHER=val"), "OTHER 보존");
    assert.ok(lines.includes("WORMHOLE_CONFIG=/new/path"), "WORMHOLE_CONFIG 추가");
  });

  test("(d) 끝 개행 없는 .env → append 시 라인 분리", async () => {
    const envFile = path.join(tmpHome, "test.env");
    fs.writeFileSync(envFile, "OTHER=val");
    await upsertDotEnvKey(envFile, "WORMHOLE_CONFIG", "/new/path");
    const lines = fs
      .readFileSync(envFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.ok(lines.includes("OTHER=val"), "OTHER 별도 라인");
    assert.ok(lines.includes("WORMHOLE_CONFIG=/new/path"), "WORMHOLE_CONFIG 별도 라인");
  });

  test("(e) ENV 부재 → 생성, 0o600 모드(비Windows)", async () => {
    const envFile = path.join(tmpHome, "new.env");
    await upsertDotEnvKey(envFile, "WORMHOLE_CONFIG", "/some/path");
    assert.equal(fs.existsSync(envFile), true);
    const lines = fs
      .readFileSync(envFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.ok(lines.includes("WORMHOLE_CONFIG=/some/path"), "키 생성됨");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    }
  });
});
