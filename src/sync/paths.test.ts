import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  toLogical,
  toOS,
  isValidLogicalKey,
  isWithinHome,
  isSettingsKey,
} from "./paths.js";

const FAKE_HOME_POSIX = "/fake/home";
const FAKE_HOME_WIN = "C:\\Users\\test";

describe("toOS + toLogical roundtrip", () => {
  const keys = [
    ".claude/settings.json",
    ".claude/.mcp.json",
    ".claude/CLAUDE.md",
    "some/deep/nested/file.txt",
    "file-at-root.txt",
  ];

  for (const key of keys) {
    test(`roundtrip: "${key}"`, () => {
      const absPath = toOS(FAKE_HOME_POSIX, key);
      const result = toLogical(FAKE_HOME_POSIX, absPath);
      assert.equal(result, key);
    });
  }
});

describe("toOS", () => {
  test("joins home with logical key segments", () => {
    const result = toOS(FAKE_HOME_POSIX, ".claude/settings.json");
    assert.equal(result, path.join(FAKE_HOME_POSIX, ".claude", "settings.json"));
  });

  test("single-segment key", () => {
    const result = toOS(FAKE_HOME_POSIX, "file.txt");
    assert.equal(result, path.join(FAKE_HOME_POSIX, "file.txt"));
  });

  test("deep nesting", () => {
    const result = toOS(FAKE_HOME_POSIX, "a/b/c/d.txt");
    assert.equal(result, path.join(FAKE_HOME_POSIX, "a", "b", "c", "d.txt"));
  });
});

describe("toLogical — posix normalization", () => {
  test("normalizes OS path separators to posix '/'", () => {
    const winStyleAbs = FAKE_HOME_WIN + "\\subfolder\\file.txt";
    const result = toLogical(FAKE_HOME_WIN, winStyleAbs);
    assert.ok(!result.includes("\\"), `Expected no backslashes, got: ${result}`);
    assert.equal(result, "subfolder/file.txt");
  });

  test("returns posix-only string for nested abs path", () => {
    const absPath = path.join(FAKE_HOME_POSIX, "a", "b", "c.md");
    const result = toLogical(FAKE_HOME_POSIX, absPath);
    assert.equal(result, "a/b/c.md");
  });
});

describe("isValidLogicalKey — valid keys", () => {
  const valid = [
    ".claude/settings.json",
    ".claude/.mcp.json",
    ".claude/CLAUDE.md",
    "file.txt",
    "a/b/c.txt",
    ".hidden",
    "dir/.hidden-file",
    "normal-file",
    "with_underscore/file.ts",
  ];

  for (const key of valid) {
    test(`accepts: "${key}"`, () => {
      assert.equal(isValidLogicalKey(key), true);
    });
  }
});

describe("isValidLogicalKey — rejected traversal / malformed", () => {
  const invalid: Array<[string, string]> = [
    ["", "empty string"],
    ["/absolute/path", "posix absolute"],
    ["/", "posix root"],
    ["../escape", "parent traversal at start"],
    ["a/../b", "parent traversal mid-path"],
    ["..", "bare double-dot"],
    ["C:/Windows", "Windows drive absolute (forward slash)"],
    ["c:\\file", "Windows drive with backslash"],
    ["a\\b", "backslash separator"],
    ["a//b", "empty segment (double slash)"],
    ["./relative", "current-dir dot segment"],
    ["file\0name", "null byte"],
    ["file:stream", "NTFS ADS colon"],
    ["con", "Windows reserved name (case-insensitive)"],
    ["CON", "Windows reserved name upper"],
    ["nul.txt", "Windows reserved name with extension"],
    ["com1", "Windows reserved COM port"],
    ["lpt9", "Windows reserved LPT port"],
    ["trailing.", "trailing dot"],
    ["trailing ", "trailing space"],
  ];

  for (const [key, label] of invalid) {
    test(`rejects (${label}): "${key}"`, () => {
      assert.equal(isValidLogicalKey(key), false);
    });
  }
});

describe("isWithinHome", () => {
  test("true for file directly under home", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, FAKE_HOME_POSIX + "/file.txt"), true);
  });

  test("true for deeply nested path", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, FAKE_HOME_POSIX + "/a/b/c.txt"), true);
  });

  test("false for home itself", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, FAKE_HOME_POSIX), false);
  });

  test("false for sibling directory (parent escape)", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, "/fake/other"), false);
  });

  test("false for parent directory", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, "/fake"), false);
  });

  test("false for completely unrelated path", () => {
    assert.equal(isWithinHome(FAKE_HOME_POSIX, "/tmp/something"), false);
  });
});

describe("isSettingsKey", () => {
  test("true for literal '.claude/settings.json'", () => {
    assert.equal(isSettingsKey(".claude/settings.json"), true);
  });


  test("false for arbitrary key", () => {
    assert.equal(isSettingsKey(".claude/CLAUDE.md"), false);
  });

  test("false for partial match", () => {
    assert.equal(isSettingsKey(".claude/settings.json.bak"), false);
  });
});
