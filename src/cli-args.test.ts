import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parsePolicy, resolveReasonsArgs, resolveSyncReasonsFile, USAGE } from "./cli-args.js";

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

describe("이유 인자 해석", () => {
  test("USAGE 에 pending·reasons·--reasons-file 이 노출된다", () => {
    assert.match(USAGE, /wormhole pending/);
    assert.match(USAGE, /wormhole reasons/);
    assert.match(USAGE, /--reasons-file/);
  });

  test("resolveSyncReasonsFile: 없으면 undefined, 문자열이면 그대로", () => {
    assert.equal(resolveSyncReasonsFile({}), undefined);
    assert.equal(resolveSyncReasonsFile({ "reasons-file": "r.json" }), "r.json");
  });

  test("resolveSyncReasonsFile: 값 없는 플래그는 오류", () => {
    assert.throws(() => resolveSyncReasonsFile({ "reasons-file": true }), /reasons-file/);
  });

  test("resolveReasonsArgs: --file 과 dry-run 없음", () => {
    assert.deepEqual(resolveReasonsArgs({ file: "a.json" }, ["reasons"]), { file: "a.json", dryRun: false });
  });

  test("resolveReasonsArgs: --dry-run 이 있으면 dry-run", () => {
    assert.deepEqual(resolveReasonsArgs({ file: "a.json", "dry-run": true }, ["reasons"]), {
      file: "a.json",
      dryRun: true,
    });
  });

  test("resolveReasonsArgs: --dry-run 이 뒤따르는 경로를 삼켜도 dry-run 이고 그 경로를 파일로 쓴다", () => {
    assert.deepEqual(resolveReasonsArgs({ "dry-run": "a.json" }, ["reasons"]), {
      file: "a.json",
      dryRun: true,
    });
  });

  test("resolveReasonsArgs: 위치 인자도 파일로 받는다", () => {
    assert.deepEqual(resolveReasonsArgs({ "dry-run": true }, ["reasons", "a.json"]), {
      file: "a.json",
      dryRun: true,
    });
  });

  test("resolveReasonsArgs: 파일이 없거나 --file 에 값이 없으면 오류", () => {
    assert.throws(() => resolveReasonsArgs({}, ["reasons"]), /file/);
    assert.throws(() => resolveReasonsArgs({ file: true }, ["reasons"]), /file/);
  });
});
