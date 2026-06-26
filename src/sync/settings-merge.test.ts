import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeHome,
  detokenizeHome,
  extractSharedSubset,
  threeWayMerge,
  stripSelfMcpServers,
  normalizeSettingsForSync,
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

  test("detokenize: token + suffix reconstructed with forward slashes", () => {
    const out = detokenizeHome(`${HOME_TOKEN}/.claude/CLAUDE.md`, FAKE_HOME);
    assert.equal(out, `${FAKE_HOME}/.claude/CLAUDE.md`);
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

  test("compound command: home embedded mid-string is tokenized", () => {
    const home = "C:\\Users\\tou72";
    const input = `"C:/Program Files/nodejs/node.exe" "C:/Users/tou72/.claude/hooks/x.mjs"`;
    const result = tokenizeHome(input, home) as string;
    assert.equal(result, `"C:/Program Files/nodejs/node.exe" "${HOME_TOKEN}/.claude/hooks/x.mjs"`);
  });

  test("compound command: detokenize roundtrip identity (forward-slash)", () => {
    const home = "C:\\Users\\tou72";
    const input = `"C:/Program Files/nodejs/node.exe" "C:/Users/tou72/.claude/hooks/x.mjs"`;
    const tokenized = tokenizeHome(input, home) as string;
    const restored = detokenizeHome(tokenized, home) as string;
    assert.equal(restored, `"C:/Program Files/nodejs/node.exe" "C:/Users/tou72/.claude/hooks/x.mjs"`);
  });

  test("compound command backslash: tokenize produces forward-slash token", () => {
    const home = "C:\\Users\\tou72";
    const input = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tou72\\.claude\\hooks\\x.mjs"`;
    const result = tokenizeHome(input, home) as string;
    assert.equal(result, `"C:\\Program Files\\nodejs\\node.exe" "${HOME_TOKEN}/.claude/hooks/x.mjs"`);
  });

  test("compound backslash: fixpoint — tokenize twice is idempotent", () => {
    const home = "C:\\Users\\tou72";
    const input = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tou72\\.claude\\hooks\\x.mjs"`;
    const once = tokenizeHome(input, home) as string;
    const twice = tokenizeHome(once, home) as string;
    assert.equal(twice, once);
  });

  test("cross-OS detokenize: different home replaces token", () => {
    const tokenized = `"C:/Program Files/nodejs/node.exe" "${HOME_TOKEN}/.claude/hooks/x.mjs"`;
    const result = detokenizeHome(tokenized, "/home/bob") as string;
    assert.equal(result, `"C:/Program Files/nodejs/node.exe" "/home/bob/.claude/hooks/x.mjs"`);
  });

  test("tilde forward-slash is tokenized", () => {
    assert.equal(tokenizeHome("~/.claude/hooks/x", "/home/alice"), `${HOME_TOKEN}/.claude/hooks/x`);
  });

  test("tilde backslash is tokenized", () => {
    assert.equal(tokenizeHome("~\\.claude\\hooks\\x", "/home/alice"), `${HOME_TOKEN}/.claude/hooks/x`);
  });

  test("sibling dir is NOT tokenized", () => {
    const home = "C:\\Users\\tou72";
    assert.equal(tokenizeHome("C:/Users/tou72backup/x", home), "C:/Users/tou72backup/x");
  });

  test("node.exe arg is NOT tokenized (non-home path)", () => {
    const home = "C:\\Users\\tou72";
    const input = `"C:/Program Files/nodejs/node.exe" "${HOME_TOKEN}/.claude/hooks/x.mjs"`;
    const result = detokenizeHome(input, home) as string;
    assert.ok(result.includes("C:/Program Files/nodejs/node.exe"), "node.exe path unchanged");
  });

  test("idempotent: tokenize(tokenize(x)) === tokenize(x)", () => {
    const input = `${FAKE_HOME}/.claude/hooks/x`;
    const once = tokenizeHome(input, FAKE_HOME) as string;
    const twice = tokenizeHome(once, FAKE_HOME) as string;
    assert.equal(twice, once);
  });

  test("special-char home: dot in path does not overbroad-match", () => {
    const home = "/home/a.b";
    assert.equal(tokenizeHome("/home/axb/something", home), "/home/axb/something");
    assert.equal(tokenizeHome(`${home}/ok`, home), `${HOME_TOKEN}/ok`);
  });

  test("greedy ceiling: two ${HOME} tokens in one string — known behavior documented", () => {
    // [^"']* 가 공백을 삼켜 첫 match 가 "/a/b ${HOME}/c/d" 전부를 캡처한다.
    // 두 번째 ${HOME} 은 치환되지 않는 것이 알려진 ceiling — 따옴표 wrap 된 실 hook 커맨드는 안전.
    const value = `${HOME_TOKEN}/a/b ${HOME_TOKEN}/c/d`;
    const result = detokenizeHome(value, FAKE_HOME) as string;
    assert.equal(result, `${FAKE_HOME}/a/b ${HOME_TOKEN}/c/d`);
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

// -----------------------------------------------------------------------
// DEFAULT_SETTINGS_LOCAL_KEYS 신규 항목: "hooks" + "statusLine.command"
// settings.json 의 hooks.*.command / statusLine.command 에는 머신 절대
// 인터프리터 경로(예: C:\Program Files\nodejs\node.exe)가 박혀 있어
// ${HOME} 토큰화로 이식 불가 → 머신 로컬 처리. 단, 스크립트 파일 자체는
// .claude/hooks/**, .claude/statusline/** include 로 동기화된다.
// 매처(isLocalKey)는 prefix 기반: "hooks"(1세그먼트)는 hooks.* 전체 서브트리,
// "statusLine.command"는 그 leaf 만 보호한다.
// -----------------------------------------------------------------------

// settings.json 형태를 모사하는 헬퍼(머신별 node.exe 경로 포함).
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const LOCAL_KEYS = ["hooks", "statusLine.command"];

function settingsWithHooks(
  nodePath: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    theme: "dark",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", command: `${nodePath} hook.js` },
      ],
    },
    statusLine: { command: `${nodePath} statusline.js` },
    ...extra,
  };
}

describe("settingsLocalKeys hooks/statusLine.command — push extract drops machine-local", () => {
  test("extractSharedSubset DROPS hooks subtree and statusLine.command", () => {
    const obj = settingsWithHooks(WIN_NODE);
    const out = extractSharedSubset(obj, LOCAL_KEYS);
    // hooks 서브트리 전체 제거(prefix "hooks").
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, "hooks"),
      false,
      "hooks 서브트리는 공유 subset 에 새면 안 된다",
    );
    // statusLine.command leaf 제거되며, statusLine 은 다른 키가 없어 빈 껍데기로 생략.
    assert.equal(
      Object.prototype.hasOwnProperty.call(out, "statusLine"),
      false,
      "statusLine 은 command 뿐이라 prune 후 빈 객체로 생략된다",
    );
    // 공유 키는 유지.
    assert.deepEqual(out, { theme: "dark" });
  });

  test("normalizeSettingsForSync push subset omits the machine node.exe path entirely", () => {
    const raw = JSON.stringify(settingsWithHooks(WIN_NODE));
    const r = normalizeSettingsForSync(raw, LOCAL_KEYS);
    // 정규화된 push 텍스트 어디에도 머신 절대 인터프리터 경로가 없어야 한다.
    assert.equal(
      r.text.includes("node.exe"),
      false,
      "머신 node.exe 경로가 push subset 에 새면 안 된다",
    );
    assert.deepEqual(JSON.parse(r.text), { theme: "dark" });
  });

  test("statusLine sibling (.padding) is NOT protected — only .command is local", () => {
    // statusLine 에 command 외 다른 키가 있으면, command 만 제거되고 padding 은 유지된다.
    const obj = settingsWithHooks(WIN_NODE, {
      statusLine: { command: `${WIN_NODE} statusline.js`, padding: 4 },
    });
    const out = extractSharedSubset(obj, LOCAL_KEYS);
    // command leaf 제거.
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        out.statusLine as Record<string, unknown>,
        "command",
      ),
      false,
      "statusLine.command 는 머신 로컬 → 제거",
    );
    // padding 은 prefix 매칭 밖(statusLine.padding) → 보존되어 동기화.
    assert.deepEqual(out.statusLine, { padding: 4 });
  });
});

describe("settingsLocalKeys hooks/statusLine.command — pull merge preserves local", () => {
  test("remote change to hooks/statusLine.command does NOT overwrite local machine values", () => {
    // 로컬: 이 머신의 node.exe 배선.
    const local = settingsWithHooks(WIN_NODE);
    // 원격 공유 subset: 로컬키가 이미 추출 단계에서 빠지므로 hooks/statusLine 을 담지 않는다.
    // 원격이 공유 키(theme)만 바꾼 상황을 모사.
    const remoteShared = { theme: "light" };
    const baseShared = { theme: "dark" };

    const res = threeWayMerge(local, remoteShared, baseShared, LOCAL_KEYS);

    // 공유 키(theme)는 원격 변경 채택.
    assert.equal((res.merged as Record<string, unknown>).theme, "light");
    // 머신 로컬 hooks 는 그대로 보존(원격이 건드릴 수 없음).
    assert.deepEqual(res.merged.hooks, local.hooks);
    // statusLine.command 도 로컬 머신 값 그대로.
    assert.deepEqual(res.merged.statusLine, local.statusLine);
    // 머신 node.exe 경로가 보존됨을 직접 확인.
    assert.equal(
      ((res.merged.statusLine as Record<string, unknown>).command as string).includes(
        "node.exe",
      ),
      true,
    );
    // 공유 subset 에는 로컬키가 새지 않는다.
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.sharedSubset, "hooks"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.sharedSubset, "statusLine"),
      false,
    );
    assert.equal(res.hasConflict, false);
  });

  test("normalized remoteShared (post-extract) never carries hooks/statusLine.command, so local survives a full pull cycle", () => {
    // 실제 계약: 원격 공유 subset 은 항상 push 단계에서 extractSharedSubset 으로
    // 로컬키가 제거된 형태다. 원격 머신의 raw settings 를 동일 localKeys 로 정규화하면
    // hooks/statusLine.command 가 빠지고, 그 정규화 결과를 remoteShared 로 머지해도
    // 로컬 머신 배선은 보존된다.
    const local = settingsWithHooks(WIN_NODE);
    // 원격 머신의 raw settings(자기 머신의 /usr/bin/node 배선 포함).
    const remoteRaw = {
      theme: "light",
      hooks: { PreToolUse: [{ matcher: "Bash", command: "/usr/bin/node hook.js" }] },
      statusLine: { command: "/usr/bin/node statusline.js" },
    };
    // push 단계 정규화: 로컬키 제거 → remoteShared 에 hooks/statusLine 이 들어가지 않는다.
    const remoteShared = extractSharedSubset(remoteRaw, LOCAL_KEYS);
    assert.equal(
      Object.prototype.hasOwnProperty.call(remoteShared, "hooks"),
      false,
      "정규화된 remoteShared 는 hooks 를 담지 않는다",
    );
    const baseShared = extractSharedSubset(settingsWithHooks(WIN_NODE), LOCAL_KEYS);

    const res = threeWayMerge(local, remoteShared, baseShared, LOCAL_KEYS);

    // 공유 키(theme)는 원격 변경 채택.
    assert.equal((res.merged as Record<string, unknown>).theme, "light");
    // 로컬 머신 배선이 보존됨(원격의 /usr/bin/node 가 새지 않음).
    assert.deepEqual(res.merged.hooks, local.hooks);
    assert.deepEqual(res.merged.statusLine, local.statusLine);
    assert.equal(
      ((res.merged.statusLine as Record<string, unknown>).command as string).includes(
        "node.exe",
      ),
      true,
    );
  });

  test("statusLine.padding (non-command sibling) is shared — remote change to it IS applied", () => {
    // padding 은 로컬키가 아니므로 공유 영역 → 원격 변경이 반영된다.
    // command 는 로컬 머신 값 보존, padding 만 원격 채택을 동시에 검증.
    const local = {
      theme: "dark",
      statusLine: { command: `${WIN_NODE} statusline.js`, padding: 2 },
    };
    const remoteShared = { theme: "dark", statusLine: { padding: 8 } };
    const baseShared = { theme: "dark", statusLine: { padding: 2 } };

    const res = threeWayMerge(local, remoteShared, baseShared, LOCAL_KEYS);

    const mergedStatus = res.merged.statusLine as Record<string, unknown>;
    // command(로컬키) 는 머신 값 보존.
    assert.equal(mergedStatus.command, `${WIN_NODE} statusline.js`);
    // padding(공유키) 는 원격 변경 채택.
    assert.equal(mergedStatus.padding, 8);
    // 공유 subset 에 statusLine.padding 만 실리고 command 는 없어야 한다.
    const sharedStatus = res.sharedSubset.statusLine as Record<string, unknown>;
    assert.equal(sharedStatus.padding, 8);
    assert.equal(
      Object.prototype.hasOwnProperty.call(sharedStatus, "command"),
      false,
    );
    assert.equal(res.hasConflict, false);
  });
});

// -----------------------------------------------------------------------
// S1.2: templateSettingsKeys — push-side 토큰화 포함 + pull-side 복원
// templateKeys 로 지정된 키는 drop 대신 tokenizeHome 후 shared 에 포함한다.
// pull 시 detokenizeHome 으로 복원 → 로컬 머신 경로로 재구성된다.
// -----------------------------------------------------------------------

describe("extractSharedSubset — templateKeys 지정 키는 tokenizeHome 후 shared 포함", () => {
  const TEMPLATE_HOME = "/home/alice";
  const TEMPLATE_TOKEN = "${HOME}";

  test("templateKey 의 home 경로가 ${HOME} 로 토큰화되어 shared 에 포함된다", () => {
    const obj = {
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", command: `${TEMPLATE_HOME}/.claude/hooks/pre.js` }],
      },
      statusLine: { type: "custom", command: `${TEMPLATE_HOME}/.claude/statusline.js` },
    };
    const out = extractSharedSubset(obj, [], ["hooks", "statusLine"], TEMPLATE_HOME);

    assert.ok(
      Object.prototype.hasOwnProperty.call(out, "hooks"),
      "hooks 는 templateKey → shared 에 포함",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(out, "statusLine"),
      "statusLine 은 templateKey → shared 에 포함",
    );
    const hookCmd = (out.hooks as { PreToolUse: { command: string }[] }).PreToolUse[0].command;
    assert.ok(hookCmd.startsWith(TEMPLATE_TOKEN), `hooks command 가 \${HOME} 로 시작해야 함: ${hookCmd}`);
    const statusCmd = (out.statusLine as { command: string }).command;
    assert.ok(statusCmd.startsWith(TEMPLATE_TOKEN), `statusLine.command 가 \${HOME} 로 시작해야 함: ${statusCmd}`);
  });

  test("templateKey + localKey 혼합: localKey 는 drop, templateKey 는 tokenize+포함", () => {
    const obj = {
      theme: "dark",
      hooks: { PreToolUse: [{ matcher: "Bash", command: `${TEMPLATE_HOME}/hook.js` }] },
      permissions: { allow: ["Bash"] },
    };
    const out = extractSharedSubset(obj, ["permissions"], ["hooks"], TEMPLATE_HOME);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, "permissions"), "permissions 는 localKey → drop");
    assert.ok(Object.prototype.hasOwnProperty.call(out, "hooks"), "hooks 는 templateKey → 포함");
    assert.equal(out.theme, "dark");
  });

  test("normalizeSettingsForSync — templateKeys 의 home 경로가 토큰화되어 shared 에 포함", () => {
    const raw = JSON.stringify({
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", command: `${TEMPLATE_HOME}/.claude/hooks/pre.js` }],
      },
      statusLine: { type: "custom", command: `${TEMPLATE_HOME}/.claude/statusline.js` },
      permissions: { allow: ["Bash"] },
    });
    const out = normalizeSettingsForSync(raw, ["permissions"], TEMPLATE_HOME, ["hooks", "statusLine"]);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;

    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "hooks"), "hooks 포함");
    const hookCmd = (parsed.hooks as { PreToolUse: { command: string }[] }).PreToolUse[0].command;
    assert.ok(hookCmd.startsWith(TEMPLATE_TOKEN), `hooks command 토큰화: ${hookCmd}`);

    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "statusLine"), "statusLine 포함");
    const statusCmd = (parsed.statusLine as { command: string }).command;
    assert.ok(statusCmd.startsWith(TEMPLATE_TOKEN), `statusLine.command 토큰화: ${statusCmd}`);

    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, "permissions"), "permissions drop");
  });

  test("pull-side: detokenizeHome 후 복원 — deepEqual 원본과 일치", () => {
    // detokenizeHome 은 forward-slash 정준으로 복원한다.
    const hookPath = `${TEMPLATE_HOME}/.claude/hooks/pre.js`;
    const statusPath = `${TEMPLATE_HOME}/.claude/statusline.js`;
    const original = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", command: hookPath }],
      },
      statusLine: { type: "custom", command: statusPath },
    };
    const tokenized = tokenizeHome(original, TEMPLATE_HOME);
    const restored = detokenizeHome(tokenized, TEMPLATE_HOME);
    assert.deepEqual(restored, original, "detokenize 후 원본과 deepEqual");
  });

  test("statusLine command 복원 — type-only 잔존 회귀 방지", () => {
    const original = {
      statusLine: { type: "custom", command: `${TEMPLATE_HOME}/.claude/statusline.js` },
    };
    const raw = JSON.stringify(original);
    const norm = normalizeSettingsForSync(raw, [], TEMPLATE_HOME, ["statusLine"]);
    const parsed = JSON.parse(norm.text) as Record<string, unknown>;
    const sl = parsed.statusLine as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(sl, "type"), "statusLine.type 포함");
    assert.ok(Object.prototype.hasOwnProperty.call(sl, "command"), "statusLine.command 포함 (type-only 회귀 금지)");
    assert.ok((sl.command as string).startsWith(TEMPLATE_TOKEN), "command 는 \${HOME} 토큰화됨");
  });
});

describe("threeWayMerge — templateKeys pull 동작", () => {
  test("(a) templateKeys 지정 키는 pull 시 원격 값으로 채택된다", () => {
    const local = { permissions: { defaultMode: "bypassPermissions" } };
    const remoteShared = { permissions: { defaultMode: "default" } };
    const baseShared = { permissions: { defaultMode: "bypassPermissions" } };
    const res = threeWayMerge(
      local,
      remoteShared,
      baseShared,
      ["permissions.*"],
      ["permissions.defaultMode"],
    );
    assert.strictEqual(
      (res.merged.permissions as Record<string, unknown>).defaultMode,
      "default",
      "merged 에 원격 값 채택",
    );
    assert.strictEqual(
      ((res.sharedSubset as Record<string, unknown>).permissions as Record<string, unknown>).defaultMode,
      "default",
      "sharedSubset 에도 원격 값 포함",
    );
  });

  test("(b) templateKeys 없으면 localKeys denylist 로 drop — 로컬 값 보존", () => {
    const local = { permissions: { defaultMode: "bypassPermissions" } };
    const remoteShared = { permissions: { defaultMode: "default" } };
    const baseShared = { permissions: { defaultMode: "bypassPermissions" } };
    const res = threeWayMerge(
      local,
      remoteShared,
      baseShared,
      ["permissions.*"],
      [],
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(res.sharedSubset, "permissions"),
      "sharedSubset 에 permissions 키 없음",
    );
    assert.strictEqual(
      (res.merged.permissions as Record<string, unknown>).defaultMode,
      "bypassPermissions",
      "merged 에 로컬 값 보존",
    );
  });
});

describe("enabledPlugins — forceSyncKeys 미포함 시 localOnlyKeys 로 플러그인 단위 제외", () => {
  test("push 추출: 제외 플러그인만 shared 에서 빠지고 나머지는 유지", () => {
    const local = { enabledPlugins: { "a@m": true, "b@m": true, "x@m": true } };
    const out = extractSharedSubset(local, ["enabledPlugins.x@m"], []);
    const shared = out.enabledPlugins as Record<string, unknown>;
    assert.ok(!("x@m" in shared), "x@m 은 localOnlyKeys 로 제외 → shared 에서 빠짐");
    assert.equal(shared["a@m"], true, "a@m 유지");
    assert.equal(shared["b@m"], true, "b@m 유지");
  });

  test("pull merge: 제외 플러그인은 로컬 보존 + sharedSubset 미포함, 원격 신규는 수신", () => {
    const local = { enabledPlugins: { "a@m": true, "x@m": true } };
    const remoteShared = { enabledPlugins: { "a@m": true, "b@m": true } };
    const baseShared = { enabledPlugins: { "a@m": true } };
    const res = threeWayMerge(local, remoteShared, baseShared, ["enabledPlugins.x@m"], []);
    const merged = res.merged.enabledPlugins as Record<string, unknown>;
    assert.equal(merged["x@m"], true, "x@m 로컬 보존(push 안 했어도 로컬엔 남음)");
    assert.equal(merged["b@m"], true, "원격 신규 b@m 수신");
    assert.equal(merged["a@m"], true, "a@m 유지");
    const sub = res.sharedSubset.enabledPlugins as Record<string, unknown>;
    assert.ok(!("x@m" in sub), "x@m 은 push 대상(sharedSubset)에서 빠짐");
  });

  test("대조: forceSyncKeys 에 enabledPlugins(부모) 포함 시 자식 localOnlyKeys 무시되고 x@m 이 샌다", () => {
    const local = { enabledPlugins: { "a@m": true, "x@m": true } };
    const out = extractSharedSubset(local, ["enabledPlugins.x@m"], ["enabledPlugins"], "");
    const shared = out.enabledPlugins as Record<string, unknown>;
    assert.equal(shared["x@m"], true, "부모 강제 → 자식 예외 불가(x@m 누출) — 제거가 정당한 이유");
  });
});
