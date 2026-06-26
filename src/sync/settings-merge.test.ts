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
  // through extractSharedSubset + stableStringify, so two
  // differently-ordered equal inputs must yield identical normalized text.
  test("key ordering does not affect output", () => {
    const a = JSON.stringify({ b: 1, a: 2, c: { z: 9, y: 8 } });
    const b = JSON.stringify({ c: { y: 8, z: 9 }, a: 2, b: 1 });
    const ra = normalizeSettingsForSync(a);
    const rb = normalizeSettingsForSync(b);
    assert.equal(ra.text, rb.text);
    assert.equal(ra.hash, rb.hash);
  });

  test("output is sorted, 2-space indented, trailing newline", () => {
    const r = normalizeSettingsForSync(JSON.stringify({ b: 1, a: 2 }));
    assert.equal(r.text, '{\n  "a": 2,\n  "b": 1\n}\n');
  });

  test("arrays preserve order; only object keys are sorted", () => {
    const r = normalizeSettingsForSync(
      JSON.stringify({ list: [3, 1, 2], k: { b: 1, a: 0 } }),
    );
    assert.equal(
      r.text,
      '{\n  "k": {\n    "a": 0,\n    "b": 1\n  },\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n',
    );
  });

  test("hash matches sha256 of normalized text bytes", () => {
    const r = normalizeSettingsForSync(JSON.stringify({ x: 1 }));
    assert.equal(r.hash, sha256(Buffer.from(r.text, "utf-8")));
    assert.equal(r.size, Buffer.from(r.text, "utf-8").byteLength);
  });
});

describe("normalizeSettingsForSync", () => {
  test("home tokenization applied when home provided", () => {
    const raw = JSON.stringify({ extPath: `${FAKE_HOME}/x` });
    const r = normalizeSettingsForSync(raw, FAKE_HOME);
    assert.deepEqual(JSON.parse(r.text), { extPath: `${HOME_TOKEN}/x` });
  });

  test("invalid JSON falls back to raw bytes (no throw)", () => {
    const raw = "{not valid json";
    const r = normalizeSettingsForSync(raw);
    assert.equal(r.text, raw);
    assert.equal(r.hash, sha256(Buffer.from(raw, "utf-8")));
    assert.equal(r.size, Buffer.from(raw, "utf-8").byteLength);
  });

  test("non-object top-level JSON normalizes to empty object", () => {
    const r = normalizeSettingsForSync("[1,2,3]");
    assert.equal(r.text, "{}\n");
  });

  test("idempotent: scan vs push hash consistent for same input + home", () => {
    const raw = JSON.stringify({
      a: `${FAKE_HOME}/p`,
      mcpServers: { self: { command: "y" } },
    });
    const first = normalizeSettingsForSync(raw, FAKE_HOME);
    const second = normalizeSettingsForSync(raw, FAKE_HOME);
    assert.equal(first.hash, second.hash);
  });
});


describe("threeWayMerge", () => {
  test("remote change to a shared key is applied when local unchanged", () => {
    const local = { fontSize: 12 };
    const res = threeWayMerge(local, { fontSize: 16 }, { fontSize: 12 });
    assert.equal(res.merged.fontSize, 16);
    assert.equal(res.sharedSubset.fontSize, 16);
    assert.equal(res.hasConflict, false);
  });

  test("local-only change is kept when remote unchanged", () => {
    const local = { fontSize: 20 };
    const res = threeWayMerge(local, { fontSize: 12 }, { fontSize: 12 });
    assert.equal(res.merged.fontSize, 20);
    assert.equal(res.sharedSubset.fontSize, 20);
    assert.equal(res.hasConflict, false);
  });

  test("remote deletion of a shared key is applied", () => {
    const local = { a: 1, b: 2 };
    const res = threeWayMerge(local, { a: 1 }, { a: 1, b: 2 });
    // b deleted remotely, local unchanged => deletion applied
    assert.equal(Object.prototype.hasOwnProperty.call(res.merged, "b"), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.sharedSubset, "b"),
      false,
    );
  });

  test("remote addition of a new shared key is applied", () => {
    const local = { a: 1 };
    const res = threeWayMerge(local, { a: 1, c: 3 }, { a: 1 });
    assert.equal(res.merged.c, 3);
    assert.equal(res.sharedSubset.c, 3);
  });

  test("both sides change same leaf differently => conflict, local retained", () => {
    const local = { x: "L" };
    const res = threeWayMerge(local, { x: "R" }, { x: "B" });
    assert.equal(res.hasConflict, true);
    assert.deepEqual(res.conflictKeys, ["x"]);
    // leaf conflict keeps local value
    assert.equal(res.merged.x, "L");
    assert.equal(res.sharedSubset.x, "L");
  });

  test("both sides make identical change => no conflict", () => {
    const local = { x: "same" };
    const res = threeWayMerge(local, { x: "same" }, { x: "old" });
    assert.equal(res.hasConflict, false);
    assert.equal(res.merged.x, "same");
  });

  test("divergent nested objects recurse; non-conflicting children merge", () => {
    const local = { obj: { a: "L", shared: "base" } };
    const remoteShared = { obj: { b: "R", shared: "base" } };
    const baseShared = { obj: { shared: "base" } };
    const res = threeWayMerge(local, remoteShared, baseShared);
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
    );
    assert.deepEqual(res.conflictKeys, ["obj.k"]);
    assert.equal((res.merged.obj as Record<string, unknown>).k, "L");
  });

  test("unchanged on both sides preserves base value", () => {
    const local = { a: 1 };
    const res = threeWayMerge(local, { a: 1 }, { a: 1 });
    assert.equal(res.merged.a, 1);
    assert.equal(res.hasConflict, false);
  });

  test("merged is independent clone of local (no shared mutation)", () => {
    const local = { mcpServers: { foo: { command: "c" } }, t: 1 };
    const res = threeWayMerge(local, { t: 2 }, { t: 1 });
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


describe("threeWayMerge — 양측이 동일하게 삭제한 키 (lines 92-93 both-deleted branch)", () => {
  // 두 sides 가 base 에 있던 키를 동일하게 삭제: localChanged=true, remoteChanged=true,
  // deepEqual(undefined, undefined)=true, hasLocal=false → out 에 포함되지 않는다.
  test("양측이 같은 키를 base 에서 삭제하면 결과에 포함되지 않는다", () => {
    // base 에 "gone" 키, local 과 remote 양쪽에서 삭제됨.
    const local = { kept: 1 };
    const remoteShared = { kept: 1 };
    const baseShared = { kept: 1, gone: "was-here" };
    const res = threeWayMerge(local, remoteShared, baseShared);
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
    const res = threeWayMerge(local, remoteShared, baseShared);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.merged, "maybeGone"),
      false,
    );
    assert.equal(res.hasConflict, false);
  });
});

describe("settings.json 통째 동기화 — 필터 제거 후 동작", () => {
  test("과거 localOnlyKeys 였던 키(hooks, permissions)가 shared subset 에 포함됨", () => {
    const raw = JSON.stringify({
      theme: "dark",
      hooks: { PreToolUse: [{ matcher: "Bash", command: "/usr/bin/node hook.js" }] },
      permissions: { allow: ["Bash"] },
    });
    const r = normalizeSettingsForSync(raw);
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "hooks"), "hooks 포함");
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "permissions"), "permissions 포함");
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "theme"), "theme 포함");
    assert.deepEqual(parsed.permissions, { allow: ["Bash"] }, "permissions 값 무손실");
  });
});

describe("home 경로 라운드트립 (normalizeSettingsForSync)", () => {
  test("push: home 절대경로 → ${HOME} 토큰, 비-home 값 불변 / pull: 다른 home 으로 복원", () => {
    const home1 = "/home/alice";
    const home2 = "/home/bob";
    const raw = JSON.stringify({ cmd: `${home1}/.claude/hook.js`, theme: "dark" });
    const pushed = normalizeSettingsForSync(raw, home1);
    const pushParsed = JSON.parse(pushed.text) as Record<string, unknown>;
    assert.equal(pushParsed.cmd, "${HOME}/.claude/hook.js");
    assert.equal(pushParsed.theme, "dark");
    const pulledBack = detokenizeHome(pushParsed, home2) as Record<string, unknown>;
    assert.equal(pulledBack.cmd, `${home2}/.claude/hook.js`);
    assert.equal(pulledBack.theme, "dark");
  });
});

describe("forbidden-key 가드 존속 (normalizeSettingsForSync)", () => {
  test("__proto__ 키는 normalize 결과에서 제외됨", () => {
    const raw = '{"safe": 1, "__proto__": {"x": 1}}';
    const r = normalizeSettingsForSync(raw);
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    assert.deepEqual(parsed, { safe: 1 });
  });
});

describe("삭제 전파 회귀 가드 (threeWayMerge)", () => {
  test("local 에 없고 base+remote 에 있던 키가 부활하지 않음", () => {
    const local = { kept: 1 };
    const base = { kept: 1, ghost: "was-here" };
    const remote = { kept: 1, ghost: "was-here" };
    const res = threeWayMerge(local, remote, base);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.merged, "ghost"),
      false,
      "local 에서 삭제된 키가 remote=base 이어도 부활하지 않아야 한다",
    );
    assert.equal(res.hasConflict, false);
  });

  // base 보유가 삭제전파의 필요조건임을 못박는 음성대조
  test("base 에 없던 키를 remote 가 새로 추가하면 merged 에 포함됨 (삭제전파 아님)", () => {
    const local = { kept: 1 };
    const base = { kept: 1 };
    const remote = { kept: 1, ghost: "resurrect" };
    const res = threeWayMerge(local, remote, base);
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.merged, "ghost"),
      true,
      "base 에 없던 키는 remote 신규 추가 → merged 에 포함(부활)",
    );
    assert.equal(res.merged.ghost, "resurrect");
    assert.equal(res.hasConflict, false);
  });
});

