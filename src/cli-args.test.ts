import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parsePolicy, USAGE } from "./cli-args.js";

describe("M8/M20a: cli-args parsePolicy/USAGE — merge 정책 추가", () => {
  test("M8: parsePolicy('merge') 는 'merge' 를 반환한다", () => {
    assert.equal(parsePolicy("merge"), "merge");
  });

  test("M8: parsePolicy('bogus') 는 throw 하고 메시지에 merge 를 포함한다", () => {
    assert.throws(
      () => parsePolicy("bogus"),
      (err: unknown) => err instanceof Error && /merge/.test(err.message),
    );
  });

  test("M20a: parsePolicy 는 기존 4개 정책도 그대로 수용한다", () => {
    assert.equal(parsePolicy("preserve-both"), "preserve-both");
    assert.equal(parsePolicy("latest-wins"), "latest-wins");
    assert.equal(parsePolicy("ours"), "ours");
    assert.equal(parsePolicy("manual"), "manual");
  });

  test("M20a: parsePolicy(undefined) / parsePolicy(true) 는 undefined 를 반환한다 (플래그 값 없음)", () => {
    assert.equal(parsePolicy(undefined), undefined);
    assert.equal(parsePolicy(true), undefined);
  });

  test("M20a: USAGE 문자열에 merge 정책이 노출된다 (resolve, sync 각각)", () => {
    assert.match(USAGE, /preserve-both\|latest-wins\|ours\|manual\|merge/);
    assert.match(USAGE, /preserve-both\|latest-wins\|merge/);
  });
});
