import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  REASON_MAX_CHARS,
  REASON_VIEW_PER_KEY,
  appendReasonItem,
  buildReasonView,
  decodeReasonLog,
  encodeReasonLog,
  parseReasonInputs,
  prepareReasonInputs,
  reasonBlobPath,
  reasonViewBytes,
  validateReasonText,
} from "./reasons.js";
import { blobHash, sha256 } from "./hash.js";
import type { ReasonItem } from "../types.js";

function item(generation: number, reason: string, machineId = "m1"): ReasonItem {
  return { generation, machineId, at: 1000 + generation, contentHash: sha256(`c${generation}`), reason };
}

describe("reasonBlobPath", () => {
  test("blobs/r-<sha256(key)>-<hash>.age 형식이다", () => {
    const hash = sha256("log");
    assert.equal(reasonBlobPath(".claude/a.md", hash), `blobs/r-${blobHash(".claude/a.md")}-${hash}.age`);
  });
});

describe("encodeReasonLog / decodeReasonLog", () => {
  test("왕복하고 hash 는 평문의 sha256 이다", () => {
    const items = [item(1, "first"), item(2, "second")];
    const { plain, hash } = encodeReasonLog(items);
    assert.equal(hash, sha256(plain));
    assert.deepEqual(decodeReasonLog(plain), items);
  });

  test("JSON 이 아니면 null", () => {
    assert.equal(decodeReasonLog(Buffer.from("not json")), null);
  });

  test("버전이 다르면 null", () => {
    assert.equal(decodeReasonLog(Buffer.from(JSON.stringify({ v: 2, items: [] }))), null);
  });

  test("reason 이 상한을 넘으면 null", () => {
    const bad = { v: 1, items: [{ ...item(1, "x".repeat(REASON_MAX_CHARS + 1)) }] };
    assert.equal(decodeReasonLog(Buffer.from(JSON.stringify(bad))), null);
  });

  test("필드 타입이 틀리면 null", () => {
    const bad = { v: 1, items: [{ generation: "1", machineId: "m", at: 1, contentHash: "h", reason: "r" }] };
    assert.equal(decodeReasonLog(Buffer.from(JSON.stringify(bad))), null);
  });
});

describe("appendReasonItem", () => {
  test("새 항목을 뒤에 덧붙인다", () => {
    const base = [item(1, "a")];
    const out = appendReasonItem(base, item(2, "b"));
    assert.equal(out.changed, true);
    assert.equal(out.items.length, 2);
    assert.equal(base.length, 1);
  });

  test("generation·machineId·reason 이 같으면 변경 없음", () => {
    const base = [item(1, "a")];
    const out = appendReasonItem(base, { ...item(1, "a"), at: 99999 });
    assert.equal(out.changed, false);
    assert.equal(out.items.length, 1);
  });

  test("같은 generation 이라도 reason 이 다르면 덧붙인다", () => {
    const out = appendReasonItem([item(1, "a")], item(1, "b"));
    assert.equal(out.changed, true);
    assert.equal(out.items.length, 2);
  });

  test("같은 reason 이라도 machineId 가 다르면 덧붙인다", () => {
    const out = appendReasonItem([item(1, "a", "m1")], item(1, "a", "m2"));
    assert.equal(out.changed, true);
  });
});

describe("validateReasonText", () => {
  test("공백만이면 empty", () => {
    assert.equal(validateReasonText("   \n"), "empty");
  });
  test("상한 초과면 too-long", () => {
    assert.equal(validateReasonText("x".repeat(REASON_MAX_CHARS + 1)), "too-long");
  });
  test("상한 이하면 null", () => {
    assert.equal(validateReasonText("x".repeat(REASON_MAX_CHARS)), null);
  });
});

describe("parseReasonInputs", () => {
  test("배열을 읽는다", () => {
    const out = parseReasonInputs(JSON.stringify([{ logicalKey: ".claude/a.md", reason: "why" }]));
    assert.deepEqual(out, [{ logicalKey: ".claude/a.md", reason: "why" }]);
  });

  test("선두 BOM 을 제거한다", () => {
    const out = parseReasonInputs("﻿" + JSON.stringify([{ logicalKey: "k", reason: "r" }]));
    assert.equal(out.length, 1);
  });

  test("contentHash 가 있으면 64자리 hex 여야 한다", () => {
    assert.throws(() => parseReasonInputs(JSON.stringify([{ logicalKey: "k", reason: "r", contentHash: "zz" }])));
    const ok = parseReasonInputs(JSON.stringify([{ logicalKey: "k", reason: "r", contentHash: sha256("x") }]));
    assert.equal(ok[0]!.contentHash, sha256("x"));
  });

  test("배열이 아니면 오류", () => {
    assert.throws(() => parseReasonInputs(JSON.stringify({ logicalKey: "k", reason: "r" })));
  });

  test("reason 이 문자열이 아니면 오류", () => {
    assert.throws(() => parseReasonInputs(JSON.stringify([{ logicalKey: "k", reason: 3 }])));
  });

  test("JSON 이 아니면 오류", () => {
    assert.throws(() => parseReasonInputs("not json"));
  });
});

describe("buildReasonView", () => {
  test("기준 generation 이하만 있으면 null", () => {
    assert.equal(buildReasonView([item(1, "a"), item(2, "b")], 2), null);
  });

  test("기준보다 큰 항목만 남긴다", () => {
    const view = buildReasonView([item(1, "a"), item(2, "b"), item(3, "c")], 1);
    assert.deepEqual(view!.items.map((i) => i.generation), [2, 3]);
    assert.equal(view!.omitted, 0);
  });

  test("키당 최신 건수만 남기고 나머지는 omitted 로 센다", () => {
    const items = Array.from({ length: REASON_VIEW_PER_KEY + 3 }, (_, i) => item(i + 1, `r${i + 1}`));
    const view = buildReasonView(items, 0);
    assert.equal(view!.items.length, REASON_VIEW_PER_KEY);
    assert.equal(view!.omitted, 3);
    assert.equal(view!.items[view!.items.length - 1]!.generation, REASON_VIEW_PER_KEY + 3);
  });
});

describe("prepareReasonInputs", () => {
  const H = sha256("x");

  test("유효 입력은 wanted 에 들어간다", () => {
    const { wanted, rejected } = prepareReasonInputs([{ logicalKey: ".claude/a.md", reason: "why" }], false);
    assert.equal(rejected.length, 0);
    assert.deepEqual(wanted.get(".claude/a.md"), { reason: "why" });
  });

  test("잘못된 논리키는 invalid-key", () => {
    const { wanted, rejected } = prepareReasonInputs([{ logicalKey: "../x", reason: "why" }], false);
    assert.equal(wanted.size, 0);
    assert.deepEqual(rejected, [{ logicalKey: "../x", code: "invalid-key" }]);
  });

  test("공백 이유는 empty, 긴 이유는 too-long", () => {
    const { rejected } = prepareReasonInputs(
      [
        { logicalKey: "a.md", reason: "  " },
        { logicalKey: "b.md", reason: "x".repeat(REASON_MAX_CHARS + 1) },
      ],
      false,
    );
    assert.deepEqual(rejected, [
      { logicalKey: "a.md", code: "empty" },
      { logicalKey: "b.md", code: "too-long" },
    ]);
  });

  test("같은 키가 둘 이상이면 키당 한 번만 duplicate-key 로 거부하고 둘 다 버린다", () => {
    const { wanted, rejected } = prepareReasonInputs(
      [
        { logicalKey: "a.md", reason: "one" },
        { logicalKey: "a.md", reason: "two" },
        { logicalKey: "a.md", reason: "three" },
      ],
      false,
    );
    assert.equal(wanted.size, 0);
    assert.deepEqual(rejected, [{ logicalKey: "a.md", code: "duplicate-key" }]);
  });

  test("requireHash 면 contentHash 없는 항목은 hash-required", () => {
    const { wanted, rejected } = prepareReasonInputs([{ logicalKey: "a.md", reason: "why" }], true);
    assert.equal(wanted.size, 0);
    assert.deepEqual(rejected, [{ logicalKey: "a.md", code: "hash-required" }]);
  });

  test("requireHash 면 contentHash 를 유지한다", () => {
    const { wanted } = prepareReasonInputs([{ logicalKey: "a.md", reason: "why", contentHash: H }], true);
    assert.deepEqual(wanted.get("a.md"), { reason: "why", contentHash: H });
  });

  test("requireHash 가 아니면 contentHash 를 버린다", () => {
    const { wanted } = prepareReasonInputs([{ logicalKey: "a.md", reason: "why", contentHash: H }], false);
    assert.deepEqual(wanted.get("a.md"), { reason: "why" });
  });
});

describe("reasonViewBytes", () => {
  test("reason 텍스트의 UTF-8 바이트 합이다", () => {
    const view = { items: [item(1, "가나"), item(2, "ab")], omitted: 0 };
    assert.equal(reasonViewBytes(view), Buffer.byteLength("가나") + 2);
  });
});
