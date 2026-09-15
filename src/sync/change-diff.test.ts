import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "diff";
import { computeChangeDiff, pruneChangeDiffs, renderDiffSection } from "./change-diff.js";
import type { ChangeDiff, Manifest, FileEntry, LogicalKey } from "../types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = 1_700_000_000_000;

function opts(over: Partial<Parameters<typeof computeChangeDiff>[2]> = {}) {
  return {
    maxBytes: 4096,
    baseHash: HASH_A,
    contentHash: HASH_B,
    now: NOW,
    ...over,
  };
}

describe("computeChangeDiff — 줄수 계산", () => {
  test("3줄 추가·1줄 삭제를 정확히 센다", () => {
    const base = "keep1\ndrop\nkeep2\n";
    const next = "keep1\nkeep2\nadd1\nadd2\nadd3\n";
    const d = computeChangeDiff(base, next, opts());
    assert.equal(d.format, "unified");
    assert.equal(d.added, 3);
    assert.equal(d.removed, 1);
    assert.equal(d.truncated, false);
    assert.equal(d.pruned, false);
    assert.equal(d.baseHash, HASH_A);
    assert.equal(d.contentHash, HASH_B);
    assert.equal(d.diffAt, NOW);
  });
});

describe("computeChangeDiff — applyPatch 왕복", () => {
  test("절단 안 된 unified 는 base 에 적용하면 next 가 된다", () => {
    const base = "l1\nl2\nl3\n";
    const next = "l1\nX\nl3\nl4\n";
    const d = computeChangeDiff(base, next, opts());
    assert.equal(d.truncated, false);
    assert.equal(applyPatch(base, d.text), next);
  });

  test("후행 개행 없는 텍스트도 왕복한다", () => {
    const base = '{"a":1,"b":2}';
    const next = '{"a":9,"b":2}';
    const d = computeChangeDiff(base, next, opts());
    assert.equal(d.truncated, false);
    assert.equal(applyPatch(base, d.text), next);
  });
});

describe("computeChangeDiff — 절단", () => {
  test("상한 초과 시 text 만 자르고 카운트는 전체값을 유지한다", () => {
    const base = "";
    const next = Array.from({ length: 400 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    const small = computeChangeDiff(base, next, opts({ maxBytes: 256 }));
    const full = computeChangeDiff(base, next, opts({ maxBytes: 1_000_000 }));

    assert.equal(small.truncated, true);
    assert.equal(small.pruned, false);
    assert.ok(Buffer.byteLength(small.text, "utf-8") <= 256);
    assert.equal(small.added, full.added);
    assert.equal(small.removed, full.removed);
    assert.ok(full.added >= 400);
  });
});

describe("computeChangeDiff — format 분기", () => {
  test("널바이트 포함이면 binary 이고 본문이 없다", () => {
    const base = "plain\n";
    const next = "bin\0ary\n";
    const d = computeChangeDiff(base, next, opts());
    assert.equal(d.format, "binary");
    assert.equal(d.text, "");
    assert.equal(d.truncated, false);
  });

  test("base 가 null 이면 added 이고 baseHash 도 null 이다", () => {
    const d = computeChangeDiff(null, "new1\nnew2\n", opts({ baseHash: null }));
    assert.equal(d.format, "added");
    assert.equal(d.baseHash, null);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 0);
    assert.ok(d.text.length > 0);
  });

  test("next 가 null 이면 deleted 이고 본문이 없다", () => {
    const d = computeChangeDiff("gone1\ngone2\n", null, opts({ contentHash: HASH_A }));
    assert.equal(d.format, "deleted");
    assert.equal(d.text, "");
    assert.equal(d.removed, 2);
    assert.equal(d.added, 0);
    assert.equal(d.baseHash, HASH_A);
    assert.equal(d.contentHash, HASH_A);
  });

  test("base·next 가 모두 null 이면 deleted 이고 카운트가 0 이다", () => {
    const d = computeChangeDiff(null, null, opts({ baseHash: null, contentHash: HASH_A }));
    assert.equal(d.format, "deleted");
    assert.equal(d.text, "");
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });
});

function makeDiff(over: Partial<ChangeDiff> = {}): ChangeDiff {
  return {
    format: "unified",
    baseHash: HASH_A,
    contentHash: HASH_B,
    added: 5,
    removed: 2,
    truncated: false,
    pruned: false,
    diffAt: NOW,
    text: "x".repeat(100),
    ...over,
  };
}

function makeEntry(changeDiff: ChangeDiff | undefined): FileEntry {
  return {
    contentHash: HASH_B,
    size: 1,
    mtimeMs: NOW,
    generation: 1,
    lastModifiedBy: "m",
    deleted: false,
    deletedAt: null,
    ...(changeDiff ? { changeDiff } : {}),
  };
}

function makeManifest(entries: Record<LogicalKey, FileEntry>): Manifest {
  return {
    schemaVersion: 1,
    manifestGeneration: 1,
    updatedBy: "m",
    updatedAt: NOW,
    entries,
  };
}

describe("renderDiffSection — 본문 부재 사유를 구분한다", () => {
  test("null 은 정보 없음이지 변경 없음이 아니다", () => {
    const out = renderDiffSection(null);
    assert.match(out, /정보 없음/);
    assert.doesNotMatch(out, /\+\d+ -\d+/, "통계가 없으므로 줄수를 적지 않는다");
  });

  test("binary 는 바이너리 사유를 적고 통계를 함께 낸다", () => {
    const out = renderDiffSection(makeDiff({ format: "binary", text: "", added: 0, removed: 0 }));
    assert.match(out, /바이너리/);
    assert.match(out, /\+0 -0/);
  });

  test("deleted 는 삭제 사유를 적는다", () => {
    const out = renderDiffSection(makeDiff({ format: "deleted", text: "", added: 0, removed: 7 }));
    assert.match(out, /삭제됨/);
    assert.match(out, /\+0 -7/);
  });

  test("pruned 는 예산 초과 사유를 적는다", () => {
    const out = renderDiffSection(makeDiff({ text: "", pruned: true }));
    assert.match(out, /예산 초과/);
    assert.match(out, /\+5 -2/, "본문이 없어도 통계는 남는다");
    assert.doesNotMatch(out, /바이너리|삭제됨/);
  });

  test("truncated 는 본문과 절단 표시를 함께 낸다", () => {
    const out = renderDiffSection(makeDiff({ text: "@@ body @@", truncated: true }));
    assert.match(out, /@@ body @@/);
    assert.match(out, /절단됨/);
  });

  test("정상 diff 는 통계와 본문만 낸다", () => {
    const out = renderDiffSection(makeDiff({ text: "@@ body @@" }));
    assert.match(out, /\+5 -2/);
    assert.match(out, /@@ body @@/);
    assert.doesNotMatch(out, /절단됨|예산 초과|바이너리|삭제됨|정보 없음/);
  });
});

describe("pruneChangeDiffs", () => {
  test("예산 초과분은 오래된 diffAt 부터 본문만 비우고 통계는 보존한다", () => {
    const manifest = makeManifest({
      newest: makeEntry(makeDiff({ diffAt: NOW + 3000, text: "n".repeat(100) })),
      middle: makeEntry(makeDiff({ diffAt: NOW + 2000, text: "m".repeat(100) })),
      oldest: makeEntry(makeDiff({ diffAt: NOW + 1000, text: "o".repeat(100), truncated: true })),
    });

    pruneChangeDiffs(manifest, 250);

    const newest = manifest.entries["newest"]!.changeDiff!;
    const middle = manifest.entries["middle"]!.changeDiff!;
    const oldest = manifest.entries["oldest"]!.changeDiff!;

    assert.equal(newest.text.length, 100, "최신은 유지");
    assert.equal(newest.pruned, false);
    assert.equal(middle.text.length, 100, "예산 안이므로 유지");
    assert.equal(middle.pruned, false);

    assert.equal(oldest.text, "", "예산 초과분은 본문 제거");
    assert.equal(oldest.pruned, true);
    assert.equal(oldest.truncated, true, "prune 은 truncated 를 바꾸지 않는다");
    assert.equal(oldest.added, 5, "통계 보존");
    assert.equal(oldest.removed, 2, "통계 보존");
    assert.equal(oldest.baseHash, HASH_A, "해시 보존");
  });

  test("멱등 — 2회 연속 실행 결과가 같다", () => {
    const build = () =>
      makeManifest({
        a: makeEntry(makeDiff({ diffAt: NOW + 3000, text: "a".repeat(100) })),
        b: makeEntry(makeDiff({ diffAt: NOW + 2000, text: "b".repeat(100) })),
        c: makeEntry(makeDiff({ diffAt: NOW + 1000, text: "c".repeat(100) })),
      });

    const once = build();
    pruneChangeDiffs(once, 250);

    const twice = build();
    pruneChangeDiffs(twice, 250);
    pruneChangeDiffs(twice, 250);

    assert.deepEqual(twice.entries, once.entries);
  });

  test("changeDiff 없는 엔트리를 건드리지 않는다", () => {
    const manifest = makeManifest({ plain: makeEntry(undefined) });
    pruneChangeDiffs(manifest, 0);
    assert.equal(manifest.entries["plain"]!.changeDiff, undefined);
  });

  test("예산이 0 이면 전부 본문을 비운다", () => {
    const manifest = makeManifest({
      a: makeEntry(makeDiff({ diffAt: NOW + 2000 })),
      b: makeEntry(makeDiff({ diffAt: NOW + 1000 })),
    });
    pruneChangeDiffs(manifest, 0);
    assert.equal(manifest.entries["a"]!.changeDiff!.text, "");
    assert.equal(manifest.entries["a"]!.changeDiff!.pruned, true);
    assert.equal(manifest.entries["b"]!.changeDiff!.text, "");
    assert.equal(manifest.entries["b"]!.changeDiff!.pruned, true);
  });
});
