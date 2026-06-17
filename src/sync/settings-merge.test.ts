import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  tokenizeHome,
  detokenizeHome,
  extractSharedSubset,
  threeWayMerge,
  stripSelfMcpServers,
  normalizeSettingsForSync,
  mergeMcpJsonForPull,
} from "./settings-merge.js";
import { sha256 } from "./hash.js";

const HOME_TOKEN = "${HOME}";

// posix-joined home for portability of expected token values
const FAKE_HOME = "/home/alice";

describe("tokenizeHome / detokenizeHome", () => {
  test("empty home leaves string untouched", () => {
    assert.equal(tokenizeHome("/home/alice/x", ""), "/home/alice/x");
  });

  test("exact home string => HOME_TOKEN", () => {
    assert.equal(tokenizeHome(FAKE_HOME, FAKE_HOME), HOME_TOKEN);
  });

  test("home-prefixed path => token + posix-normalized suffix", () => {
    assert.equal(
      tokenizeHome(`${FAKE_HOME}/.claude/CLAUDE.md`, FAKE_HOME),
      `${HOME_TOKEN}/.claude/CLAUDE.md`,
    );
  });

  test("backslash-separated suffix is normalized to forward slashes on the wire", () => {
    // Windows-style home prefix with backslash separators
    const winHome = "C:\\Users\\alice";
    const input = `${winHome}\\.claude\\config.json`;
    assert.equal(
      tokenizeHome(input, winHome),
      `${HOME_TOKEN}/.claude/config.json`,
    );
  });

  test("non-home path is left unchanged", () => {
    assert.equal(
      tokenizeHome("/usr/local/bin/node", FAKE_HOME),
      "/usr/local/bin/node",
    );
  });

  test("a path that merely contains home as a non-boundary prefix is NOT tokenized", () => {
    // "/home/alice2" starts with "/home/alice" but the next char is not a separator
    assert.equal(
      tokenizeHome("/home/alice2/x", FAKE_HOME),
      "/home/alice2/x",
    );
  });

  test("recurses into arrays and plain objects", () => {
    const input = {
      command: `${FAKE_HOME}/bin/tool`,
      args: [`${FAKE_HOME}/data`, "--flag", "literal"],
      nested: { p: `${FAKE_HOME}/n` },
    };
    assert.deepEqual(tokenizeHome(input, FAKE_HOME), {
      command: `${HOME_TOKEN}/bin/tool`,
      args: [`${HOME_TOKEN}/data`, "--flag", "literal"],
      nested: { p: `${HOME_TOKEN}/n` },
    });
  });

  test("non-string leaves (number, bool, null) pass through", () => {
    assert.equal(tokenizeHome(42, FAKE_HOME), 42);
    assert.equal(tokenizeHome(true, FAKE_HOME), true);
    assert.equal(tokenizeHome(null, FAKE_HOME), null);
  });

  test("forbidden keys are dropped while tokenizing objects", () => {
    const input = JSON.parse(
      `{"safe": "${FAKE_HOME}/ok", "__proto__": {"polluted": true}}`,
    );
    const out = tokenizeHome(input, FAKE_HOME) as Record<string, unknown>;
    assert.equal(out.safe, `${HOME_TOKEN}/ok`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, "__proto__"),
      false,
    );
  });

  test("detokenize: exact HOME_TOKEN => home", () => {
    assert.equal(detokenizeHome(HOME_TOKEN, FAKE_HOME), FAKE_HOME);
  });

  test("detokenize: token + suffix reconstructed with local path.sep", () => {
    const out = detokenizeHome(`${HOME_TOKEN}/.claude/CLAUDE.md`, FAKE_HOME);
    // the suffix segments are re-joined with the local OS separator
    assert.equal(out, FAKE_HOME + ["", ".claude", "CLAUDE.md"].join(path.sep));
  });

  test("detokenize: string without token is unchanged", () => {
    assert.equal(detokenizeHome("/etc/hosts", FAKE_HOME), "/etc/hosts");
  });

  test("roundtrip: posix value survives tokenize -> detokenize on same OS", () => {
    const original = `${FAKE_HOME}/.claude/CLAUDE.md`;
    const tokenized = tokenizeHome(original, FAKE_HOME);
    assert.equal(tokenized, `${HOME_TOKEN}/.claude/CLAUDE.md`);
    const back = detokenizeHome(tokenized, FAKE_HOME);
    // On posix path.sep === "/" so back === original; on win32 separators differ
    // but the suffix structure is preserved. Compare via normalized separators.
    const normalize = (s: string) => s.split(/[\\/]/).join("/");
    assert.equal(normalize(back as string), normalize(original));
  });

  test("roundtrip preserves nested object structure", () => {
    const original = {
      mcpServers: {
        other: {
          command: `${FAKE_HOME}/bin/other`,
          args: [`${FAKE_HOME}/cfg`, "--x"],
        },
      },
    };
    const wire = tokenizeHome(original, FAKE_HOME);
    const back = detokenizeHome(wire, FAKE_HOME) as typeof original;
    const normalize = (s: string) => s.split(/[\\/]/).join("/");
    assert.equal(
      normalize(back.mcpServers.other.command),
      normalize(original.mcpServers.other.command),
    );
    assert.equal(
      normalize(back.mcpServers.other.args[0] as string),
      normalize(original.mcpServers.other.args[0] as string),
    );
    assert.equal(back.mcpServers.other.args[1], "--x");
  });
});

describe("stableStringify (via normalizeSettingsForSync)", () => {
  // stableStringify is not exported; normalizeSettingsForSync routes raw JSON
  // through extractSharedSubset (no local keys) + stableStringify, so two
  // differently-ordered equal inputs must yield identical normalized text.
  test("key ordering does not affect output", () => {
    const a = JSON.stringify({ b: 1, a: 2, c: { z: 9, y: 8 } });
    const b = JSON.stringify({ c: { y: 8, z: 9 }, a: 2, b: 1 });
    const ra = normalizeSettingsForSync(a, []);
    const rb = normalizeSettingsForSync(b, []);
    assert.equal(ra.text, rb.text);
    assert.equal(ra.hash, rb.hash);
  });

  test("output is sorted, 2-space indented, trailing newline", () => {
    const r = normalizeSettingsForSync(JSON.stringify({ b: 1, a: 2 }), []);
    assert.equal(r.text, '{\n  "a": 2,\n  "b": 1\n}\n');
  });

  test("arrays preserve order; only object keys are sorted", () => {
    const r = normalizeSettingsForSync(
      JSON.stringify({ list: [3, 1, 2], k: { b: 1, a: 0 } }),
      [],
    );
    assert.equal(
      r.text,
      '{\n  "k": {\n    "a": 0,\n    "b": 1\n  },\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n',
    );
  });

  test("hash matches sha256 of normalized text bytes", () => {
    const r = normalizeSettingsForSync(JSON.stringify({ x: 1 }), []);
    assert.equal(r.hash, sha256(Buffer.from(r.text, "utf-8")));
    assert.equal(r.size, Buffer.from(r.text, "utf-8").byteLength);
  });
});

describe("normalizeSettingsForSync", () => {
  test("local keys are excluded from the normalized shared subset", () => {
    const raw = JSON.stringify({
      theme: "dark",
      mcpServers: { foo: { command: "x" } },
    });
    const r = normalizeSettingsForSync(raw, ["mcpServers.*"]);
    const parsed = JSON.parse(r.text);
    assert.deepEqual(parsed, { theme: "dark" });
  });

  test("home tokenization applied when home provided", () => {
    const raw = JSON.stringify({ extPath: `${FAKE_HOME}/x` });
    const r = normalizeSettingsForSync(raw, [], FAKE_HOME);
    assert.deepEqual(JSON.parse(r.text), { extPath: `${HOME_TOKEN}/x` });
  });

  test("invalid JSON falls back to raw bytes (no throw)", () => {
    const raw = "{not valid json";
    const r = normalizeSettingsForSync(raw, ["mcpServers.*"]);
    assert.equal(r.text, raw);
    assert.equal(r.hash, sha256(Buffer.from(raw, "utf-8")));
    assert.equal(r.size, Buffer.from(raw, "utf-8").byteLength);
  });

  test("non-object top-level JSON normalizes to empty object", () => {
    const r = normalizeSettingsForSync("[1,2,3]", []);
    assert.equal(r.text, "{}\n");
  });

  test("idempotent: scan vs push hash consistent for same input + home", () => {
    const raw = JSON.stringify({
      a: `${FAKE_HOME}/p`,
      mcpServers: { self: { command: "y" } },
    });
    const first = normalizeSettingsForSync(raw, ["mcpServers.*"], FAKE_HOME);
    const second = normalizeSettingsForSync(raw, ["mcpServers.*"], FAKE_HOME);
    assert.equal(first.hash, second.hash);
  });
});

describe("extractSharedSubset (isLocalKey wildcard behavior)", () => {
  test("removes wildcard-matched local keys, keeps shared", () => {
    const obj = {
      theme: "dark",
      mcpServers: { foo: { command: "a" }, bar: { command: "b" } },
      permissions: { allow: ["x"] },
    };
    const out = extractSharedSubset(obj, ["mcpServers.*", "permissions.*"]);
    assert.deepEqual(out, { theme: "dark" });
  });

  test("exact dot-path key removed; sibling preserved", () => {
    const obj = { a: { keepMe: 1, dropMe: 2 } };
    const out = extractSharedSubset(obj, ["a.dropMe"]);
    assert.deepEqual(out, { a: { keepMe: 1 } });
  });

  test("container emptied solely by local-key pruning is dropped", () => {
    const obj = { mcpServers: { only: { command: "x" } }, theme: "t" };
    const out = extractSharedSubset(obj, ["mcpServers.*"]);
    // mcpServers had content but all of it was local => container omitted
    assert.deepEqual(out, { theme: "t" });
    assert.equal(Object.prototype.hasOwnProperty.call(out, "mcpServers"), false);
  });

  test("originally-empty object is preserved (not confused with pruned-empty)", () => {
    const obj = { emptyObj: {}, x: 1 };
    const out = extractSharedSubset(obj, ["mcpServers.*"]);
    assert.deepEqual(out, { emptyObj: {}, x: 1 });
  });

  test("prefix wildcard matches deep descendants", () => {
    const obj = { mcpServers: { foo: { command: "a", args: ["1"] } }, k: 2 };
    const out = extractSharedSubset(obj, ["mcpServers.*"]);
    assert.deepEqual(out, { k: 2 });
  });

  test("forbidden keys never appear in shared subset", () => {
    const obj = JSON.parse('{"safe": 1, "__proto__": {"x": 1}}');
    const out = extractSharedSubset(obj, []);
    assert.deepEqual(out, { safe: 1 });
  });

  test("returns a deep clone (no mutation of input)", () => {
    const obj = { nested: { a: 1 } };
    const out = extractSharedSubset(obj, []);
    (out.nested as Record<string, unknown>).a = 99;
    assert.equal(obj.nested.a, 1);
  });
});

describe("threeWayMerge", () => {
  test("local-protected keys are retained and never overwritten by remote", () => {
    const local = {
      theme: "dark",
      mcpServers: { foo: { command: "local-cmd" } },
    };
    const remoteShared = { theme: "light" };
    const baseShared = { theme: "dark" };
    const res = threeWayMerge(local, remoteShared, baseShared, ["mcpServers.*"]);
    // remote changed theme; local did not => remote wins on shared key
    assert.equal((res.merged as Record<string, unknown>).theme, "light");
    // local-protected mcpServers untouched
    assert.deepEqual(res.merged.mcpServers, { foo: { command: "local-cmd" } });
    // sharedSubset must not carry local keys
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.sharedSubset, "mcpServers"),
      false,
    );
    assert.equal(res.hasConflict, false);
  });

  test("remote change to a shared key is applied when local unchanged", () => {
    const local = { fontSize: 12 };
    const res = threeWayMerge(local, { fontSize: 16 }, { fontSize: 12 }, []);
    assert.equal(res.merged.fontSize, 16);
    assert.equal(res.sharedSubset.fontSize, 16);
    assert.equal(res.hasConflict, false);
  });

  test("local-only change is kept when remote unchanged", () => {
    const local = { fontSize: 20 };
    const res = threeWayMerge(local, { fontSize: 12 }, { fontSize: 12 }, []);
    assert.equal(res.merged.fontSize, 20);
    assert.equal(res.sharedSubset.fontSize, 20);
    assert.equal(res.hasConflict, false);
  });

  test("remote deletion of a shared key is applied", () => {
    const local = { a: 1, b: 2 };
    const res = threeWayMerge(local, { a: 1 }, { a: 1, b: 2 }, []);
    // b deleted remotely, local unchanged => deletion applied
    assert.equal(Object.prototype.hasOwnProperty.call(res.merged, "b"), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.sharedSubset, "b"),
      false,
    );
  });

  test("remote addition of a new shared key is applied", () => {
    const local = { a: 1 };
    const res = threeWayMerge(local, { a: 1, c: 3 }, { a: 1 }, []);
    assert.equal(res.merged.c, 3);
    assert.equal(res.sharedSubset.c, 3);
  });

  test("both sides change same leaf differently => conflict, local retained", () => {
    const local = { x: "L" };
    const res = threeWayMerge(local, { x: "R" }, { x: "B" }, []);
    assert.equal(res.hasConflict, true);
    assert.deepEqual(res.conflictKeys, ["x"]);
    // leaf conflict keeps local value
    assert.equal(res.merged.x, "L");
    assert.equal(res.sharedSubset.x, "L");
  });

  test("both sides make identical change => no conflict", () => {
    const local = { x: "same" };
    const res = threeWayMerge(local, { x: "same" }, { x: "old" }, []);
    assert.equal(res.hasConflict, false);
    assert.equal(res.merged.x, "same");
  });

  test("divergent nested objects recurse; non-conflicting children merge", () => {
    const local = { obj: { a: "L", shared: "base" } };
    const remoteShared = { obj: { b: "R", shared: "base" } };
    const baseShared = { obj: { shared: "base" } };
    const res = threeWayMerge(local, remoteShared, baseShared, []);
    // a added locally, b added remotely => both present, no conflict
    assert.deepEqual(res.merged.obj, { shared: "base", a: "L", b: "R" });
    assert.equal(res.hasConflict, false);
  });

  test("nested leaf conflict reports full dot-path", () => {
    const local = { obj: { k: "L" } };
    const res = threeWayMerge(
      local,
      { obj: { k: "R" } },
      { obj: { k: "B" } },
      [],
    );
    assert.deepEqual(res.conflictKeys, ["obj.k"]);
    assert.equal((res.merged.obj as Record<string, unknown>).k, "L");
  });

  test("unchanged on both sides preserves base value", () => {
    const local = { a: 1 };
    const res = threeWayMerge(local, { a: 1 }, { a: 1 }, []);
    assert.equal(res.merged.a, 1);
    assert.equal(res.hasConflict, false);
  });

  test("merged is independent clone of local (no shared mutation)", () => {
    const local = { mcpServers: { foo: { command: "c" } }, t: 1 };
    const res = threeWayMerge(local, { t: 2 }, { t: 1 }, ["mcpServers.*"]);
    (res.merged.mcpServers as Record<string, Record<string, unknown>>).foo.command =
      "mutated";
    assert.equal(local.mcpServers.foo.command, "c");
  });
});

describe("stripSelfMcpServers", () => {
  test("removes named self server, keeps others", () => {
    const json = JSON.stringify({
      mcpServers: {
        "wormhole": { command: "self" },
        other: { command: "keep" },
      },
    });
    const r = stripSelfMcpServers(json, ["wormhole"]);
    const parsed = JSON.parse(r.text);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed.mcpServers, "wormhole"),
      false,
    );
    assert.deepEqual(parsed.mcpServers.other, { command: "keep" });
  });

  test("removes multiple self servers", () => {
    const json = JSON.stringify({
      mcpServers: { a: {}, b: {}, c: {} },
    });
    const r = stripSelfMcpServers(json, ["a", "c"]);
    const parsed = JSON.parse(r.text);
    assert.deepEqual(Object.keys(parsed.mcpServers), ["b"]);
  });

  test("output is stable-stringified and hash/size match the text", () => {
    const json = JSON.stringify({ mcpServers: { b: {}, a: {} }, z: 1 });
    const r = stripSelfMcpServers(json, []);
    // keys sorted by stableStringify
    assert.match(r.text, /^\{\n {2}"mcpServers"/);
    assert.equal(r.hash, sha256(Buffer.from(r.text, "utf-8")));
    assert.equal(r.size, Buffer.from(r.text, "utf-8").byteLength);
  });

  test("invalid JSON returns original text with original-byte hash (no throw)", () => {
    const raw = "{ broken";
    const r = stripSelfMcpServers(raw, ["x"]);
    assert.equal(r.text, raw);
    assert.equal(r.hash, sha256(Buffer.from(raw, "utf-8")));
    assert.equal(r.size, Buffer.from(raw, "utf-8").byteLength);
  });

  test("home tokenization applied to non-self server paths when home given", () => {
    const json = JSON.stringify({
      mcpServers: {
        "wormhole": { command: `${FAKE_HOME}/self` },
        other: { command: `${FAKE_HOME}/bin/other` },
      },
    });
    const r = stripSelfMcpServers(json, ["wormhole"], FAKE_HOME);
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.mcpServers.other.command, `${HOME_TOKEN}/bin/other`);
  });

  test("non-object top-level JSON yields empty stable object", () => {
    const r = stripSelfMcpServers("[1,2]", ["x"]);
    assert.equal(r.text, "{}\n");
  });
});

// -----------------------------------------------------------------------
// settings-merge.ts 추가 브랜치 커버리지
// -----------------------------------------------------------------------

describe("isLocalKey — pat.length > segs.length branch (lines 78-80)", () => {
  // 패턴이 경로보다 더 긴 경우 → continue(skip) → 최종 false.
  // extractSharedSubset 을 통해 간접 호출한다.
  test("패턴이 경로보다 길면 매칭되지 않아 키가 유지된다", () => {
    // localKey "a.b.c" (3세그먼트)로 "a.b" (2세그먼트) 경로를 필터링하려 하면 안 된다.
    const obj = { a: { b: 42 } };
    const out = extractSharedSubset(obj, ["a.b.c"]);
    // 패턴(3) > 경로 세그먼트(2) → continue → 매칭 없음 → 키 보존.
    assert.deepEqual(out, { a: { b: 42 } });
  });

  test("패턴이 경로보다 짧거나 같으면 정상 매칭된다(대조)", () => {
    // localKey "a.b" (2세그먼트)로 "a.b" 경로 필터링 → 제거.
    const obj = { a: { b: 1, c: 2 } };
    const out = extractSharedSubset(obj, ["a.b"]);
    assert.deepEqual(out, { a: { c: 2 } });
  });
});

describe("threeWayMerge — 양측이 동일하게 삭제한 키 (lines 92-93 both-deleted branch)", () => {
  // 두 sides 가 base 에 있던 키를 동일하게 삭제: localChanged=true, remoteChanged=true,
  // deepEqual(undefined, undefined)=true, hasLocal=false → out 에 포함되지 않는다.
  test("양측이 같은 키를 base 에서 삭제하면 결과에 포함되지 않는다", () => {
    // base 에 "gone" 키, local 과 remote 양쪽에서 삭제됨.
    const local = { kept: 1 };
    const remoteShared = { kept: 1 };
    const baseShared = { kept: 1, gone: "was-here" };
    const res = threeWayMerge(local, remoteShared, baseShared, []);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.merged, "gone"),
      false,
      "양측 동일 삭제 키는 결과에 없어야 한다",
    );
    assert.equal(res.hasConflict, false);
    assert.equal(res.merged.kept, 1);
  });

  test("한쪽만 삭제하고 다른 쪽은 유지하면 삭제가 적용된다(단측 변경 경로)", () => {
    // remote 가 삭제, local 은 base 그대로 → remote 변경 채택 → 삭제.
    const local = { kept: 1, maybeGone: "still-here" };
    const remoteShared = { kept: 1 };
    const baseShared = { kept: 1, maybeGone: "still-here" };
    const res = threeWayMerge(local, remoteShared, baseShared, []);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.merged, "maybeGone"),
      false,
    );
    assert.equal(res.hasConflict, false);
  });
});

describe("mergeMcpJsonForPull", () => {
  test("preserves local self server, applies remote non-self servers", () => {
    const remote = JSON.stringify({ mcpServers: { other: { command: "R" } } });
    const local = JSON.stringify({
      mcpServers: {
        "wormhole": { command: "local-self" },
        other: { command: "stale-local" },
      },
    });
    const out = mergeMcpJsonForPull(remote, local, ["wormhole"]);
    const parsed = JSON.parse(out);
    // remote wins for non-self
    assert.deepEqual(parsed.mcpServers.other, { command: "R" });
    // local self preserved
    assert.deepEqual(parsed.mcpServers["wormhole"], {
      command: "local-self",
    });
  });

  test("remote self entries are defensively stripped", () => {
    const remote = JSON.stringify({
      mcpServers: {
        "wormhole": { command: "remote-self-leaked" },
        other: { command: "R" },
      },
    });
    const local = JSON.stringify({
      mcpServers: { "wormhole": { command: "local-self" } },
    });
    const out = mergeMcpJsonForPull(remote, local, ["wormhole"]);
    const parsed = JSON.parse(out);
    // local self wins over any leaked remote self
    assert.deepEqual(parsed.mcpServers["wormhole"], {
      command: "local-self",
    });
  });

  test("detokenizes remote ${HOME} back to local home for non-self paths", () => {
    const remote = JSON.stringify({
      mcpServers: { other: { command: `${HOME_TOKEN}/bin/other` } },
    });
    const out = mergeMcpJsonForPull(remote, null, ["wormhole"], FAKE_HOME);
    const parsed = JSON.parse(out);
    const normalize = (s: string) => s.split(/[\\/]/).join("/");
    assert.equal(
      normalize(parsed.mcpServers.other.command),
      `${FAKE_HOME}/bin/other`,
    );
  });

  test("null local => remote-based output with self emptied", () => {
    const remote = JSON.stringify({
      mcpServers: {
        "wormhole": { command: "leaked" },
        other: { command: "R" },
      },
    });
    const out = mergeMcpJsonForPull(remote, null, ["wormhole"]);
    const parsed = JSON.parse(out);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed.mcpServers, "wormhole"),
      false,
    );
    assert.deepEqual(parsed.mcpServers.other, { command: "R" });
  });

  test("invalid local JSON treated as absent (remote-based result)", () => {
    const remote = JSON.stringify({ mcpServers: { other: { command: "R" } } });
    const out = mergeMcpJsonForPull(remote, "{broken", ["wormhole"]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.mcpServers.other, { command: "R" });
  });

  test("invalid remote JSON treated as empty remote", () => {
    const local = JSON.stringify({
      mcpServers: { "wormhole": { command: "local-self" } },
    });
    const out = mergeMcpJsonForPull("{broken", local, ["wormhole"]);
    const parsed = JSON.parse(out);
    // self preserved, no other servers
    assert.deepEqual(parsed.mcpServers["wormhole"], {
      command: "local-self",
    });
  });

  test("creates mcpServers container when remote lacks it but local self exists", () => {
    const remote = JSON.stringify({ someTopKey: 1 });
    const local = JSON.stringify({
      mcpServers: { "wormhole": { command: "local-self" } },
    });
    const out = mergeMcpJsonForPull(remote, local, ["wormhole"]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.mcpServers["wormhole"], {
      command: "local-self",
    });
    // remote top-level key preserved (remote-first base)
    assert.equal(parsed.someTopKey, 1);
  });

  test("output is stable-stringified (deterministic key order)", () => {
    const remoteA = JSON.stringify({ mcpServers: { b: {}, a: {} }, z: 1 });
    const remoteB = JSON.stringify({ z: 1, mcpServers: { a: {}, b: {} } });
    const outA = mergeMcpJsonForPull(remoteA, null, []);
    const outB = mergeMcpJsonForPull(remoteB, null, []);
    assert.equal(outA, outB);
  });

  test("local non-self servers do NOT leak into merged output", () => {
    const remote = JSON.stringify({ mcpServers: { other: { command: "R" } } });
    const local = JSON.stringify({
      mcpServers: {
        "wormhole": { command: "self" },
        localOnly: { command: "should-not-appear" },
      },
    });
    const out = mergeMcpJsonForPull(remote, local, ["wormhole"]);
    const parsed = JSON.parse(out);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed.mcpServers, "localOnly"),
      false,
    );
  });
});
