import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildPluginInstallGuidance, isMarketplaceRegistered } from "./plugin-install.js";
import { checkInstallPrereqs } from "./engine.js";

let root: string;
let counter = 0;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wh-plugin-install-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkPluginsDir(opts?: {
  known?: Record<string, { installLocation?: string }>;
  installed?: Record<string, unknown[]>;
}): string {
  const dir = path.join(root, `plugins-${counter++}`);
  mkdirSync(dir, { recursive: true });
  if (opts?.known) {
    writeFileSync(path.join(dir, "known_marketplaces.json"), JSON.stringify(opts.known), "utf-8");
  }
  if (opts?.installed) {
    writeFileSync(
      path.join(dir, "installed_plugins.json"),
      JSON.stringify({ plugins: opts.installed }),
      "utf-8",
    );
  }
  return dir;
}

function githubSettings(marketplace: string, repo: string): unknown {
  return { extraKnownMarketplaces: { [marketplace]: { source: { source: "github", repo } } } };
}

describe("buildPluginInstallGuidance", () => {
  test("미등록 github marketplace: add 명령이 install 명령 앞에 온다", () => {
    const dir = mkPluginsDir();
    const result = buildPluginInstallGuidance(["foo@bar"], githubSettings("bar", "o/r"), dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/r",
      "/plugin install foo@bar",
    ]);
    assert.deepEqual(result.unresolvedMarketplaces, []);
  });

  test("등록되고 installLocation 이 실존하면 add 없이 install 만 낸다", () => {
    const loc = path.join(root, "market-ok");
    mkdirSync(loc, { recursive: true });
    const dir = mkPluginsDir({ known: { bar: { installLocation: loc } } });
    const result = buildPluginInstallGuidance(["foo@bar"], githubSettings("bar", "o/r"), dir);
    assert.deepEqual(result.installCommands, ["/plugin install foo@bar"]);
  });

  test("등록됐지만 installLocation 이 없는 디렉터리면 add 를 다시 낸다", () => {
    const dir = mkPluginsDir({ known: { bar: { installLocation: path.join(root, "gone") } } });
    const result = buildPluginInstallGuidance(["foo@bar"], githubSettings("bar", "o/r"), dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/r",
      "/plugin install foo@bar",
    ]);
  });

  test("같은 marketplace 의 플러그인 여럿: add 는 한 번, add 들이 install 들보다 앞이다", () => {
    const dir = mkPluginsDir();
    const settings = {
      extraKnownMarketplaces: {
        m1: { source: { source: "github", repo: "o/one" } },
        m2: { source: { source: "github", repo: "o/two" } },
      },
    };
    const result = buildPluginInstallGuidance(["a@m1", "b@m2", "c@m1"], settings, dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/one",
      "/plugin marketplace add o/two",
      "/plugin install a@m1",
      "/plugin install b@m2",
      "/plugin install c@m1",
    ]);
  });

  test("git 소스는 URL 로 add 한다", () => {
    const dir = mkPluginsDir();
    const settings = {
      extraKnownMarketplaces: {
        bar: { source: { source: "git", url: "https://github.com/o/r.git" } },
      },
    };
    const result = buildPluginInstallGuidance(["foo@bar"], settings, dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add https://github.com/o/r.git",
      "/plugin install foo@bar",
    ]);
  });

  test("소스가 없으면 unresolved 로 표시하고 그 marketplace 의 install 은 내지 않는다", () => {
    const dir = mkPluginsDir();
    const result = buildPluginInstallGuidance(
      ["foo@bar", "baz@qux"],
      githubSettings("qux", "o/q"),
      dir,
    );
    assert.deepEqual(result.unresolvedMarketplaces, ["bar"]);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/q",
      "/plugin install baz@qux",
    ]);
  });

  test("settings 가 null 이거나 extraKnownMarketplaces 가 객체가 아니면 unresolved", () => {
    const dir = mkPluginsDir();
    assert.deepEqual(buildPluginInstallGuidance(["foo@bar"], null, dir), {
      installCommands: [],
      unresolvedMarketplaces: ["bar"],
    });
    assert.deepEqual(
      buildPluginInstallGuidance(["foo@bar"], { extraKnownMarketplaces: "x" }, dir).unresolvedMarketplaces,
      ["bar"],
    );
  });

  test("ref/path 같은 추가 필드가 있는 소스는 명령이 소스를 그대로 나타내지 못하므로 unresolved", () => {
    const dir = mkPluginsDir();
    const settings = {
      extraKnownMarketplaces: {
        bar: { source: { source: "github", repo: "o/r", ref: "dev" } },
      },
    };
    const result = buildPluginInstallGuidance(["foo@bar"], settings, dir);
    assert.deepEqual(result.unresolvedMarketplaces, ["bar"]);
    assert.deepEqual(result.installCommands, []);
  });

  test("github/git 외 소스 종류와 문자열이 아닌 필드는 unresolved", () => {
    const dir = mkPluginsDir();
    const settings = {
      extraKnownMarketplaces: {
        a: { source: { source: "directory", path: "/x/y" } },
        b: { source: { source: "github", repo: 42 } },
        c: { source: "github" },
      },
    };
    const result = buildPluginInstallGuidance(["p@a", "p@b", "p@c"], settings, dir);
    assert.deepEqual(result.unresolvedMarketplaces, ["a", "b", "c"]);
    assert.deepEqual(result.installCommands, []);
  });

  test("명령에 실을 수 없는 문자열(공백·옵션형·셸 메타문자·http)은 unresolved", () => {
    const dir = mkPluginsDir();
    const bad = ["o/r --scope project", "--scope", "o/r;x", "o/r/extra", "o r"];
    for (const repo of bad) {
      const result = buildPluginInstallGuidance(["foo@bar"], githubSettings("bar", repo), dir);
      assert.deepEqual(result.unresolvedMarketplaces, ["bar"], `repo=${repo}`);
      assert.deepEqual(result.installCommands, [], `repo=${repo}`);
    }
    const http = {
      extraKnownMarketplaces: { bar: { source: { source: "git", url: "http://h/r.git" } } },
    };
    assert.deepEqual(buildPluginInstallGuidance(["foo@bar"], http, dir).unresolvedMarketplaces, ["bar"]);
  });

  test("안전하지 않은 플러그인 키는 명령에서 빠진다", () => {
    const dir = mkPluginsDir();
    const result = buildPluginInstallGuidance(
      ["foo bar@bar", "noat", "ok@bar"],
      githubSettings("bar", "o/r"),
      dir,
    );
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/r",
      "/plugin install ok@bar",
    ]);
  });

  test("내장 claude-plugins-official 은 settings 에 소스가 없어도 add 를 낸다", () => {
    const dir = mkPluginsDir();
    const result = buildPluginInstallGuidance(["x@claude-plugins-official"], {}, dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add anthropics/claude-plugins-official",
      "/plugin install x@claude-plugins-official",
    ]);
  });

  test("marketplace 이름이 __proto__ 여도 프로토타입을 소스로 읽지 않는다", () => {
    const dir = mkPluginsDir();
    const result = buildPluginInstallGuidance(["x@__proto__"], {}, dir);
    assert.deepEqual(result.unresolvedMarketplaces, ["__proto__"]);
    assert.deepEqual(result.installCommands, []);
  });

  test("known_marketplaces.json 이 깨져 있으면 미등록으로 본다", () => {
    const dir = mkPluginsDir();
    writeFileSync(path.join(dir, "known_marketplaces.json"), "{not json", "utf-8");
    const result = buildPluginInstallGuidance(["foo@bar"], githubSettings("bar", "o/r"), dir);
    assert.deepEqual(result.installCommands, [
      "/plugin marketplace add o/r",
      "/plugin install foo@bar",
    ]);
  });

  test("안내를 따른 결과(레지스트리 파일 기록)를 checkInstallPrereqs 가 통과시킨다", () => {
    const dir = mkPluginsDir();
    const settings = {
      enabledPlugins: { "foo@bar": true },
      ...(githubSettings("bar", "o/r") as object),
    };
    const before = checkInstallPrereqs(settings, dir);
    assert.deepEqual(before.missing, ["foo@bar"]);

    const guidance = buildPluginInstallGuidance(before.missing, settings, dir);
    assert.deepEqual(guidance.installCommands, [
      "/plugin marketplace add o/r",
      "/plugin install foo@bar",
    ]);

    const loc = path.join(root, "market-after");
    mkdirSync(loc, { recursive: true });
    writeFileSync(
      path.join(dir, "known_marketplaces.json"),
      JSON.stringify({ bar: { installLocation: loc } }),
      "utf-8",
    );
    writeFileSync(
      path.join(dir, "installed_plugins.json"),
      JSON.stringify({ plugins: { "foo@bar": [{ version: "1" }] } }),
      "utf-8",
    );
    assert.equal(checkInstallPrereqs(settings, dir).ok, true);
  });
});

describe("isMarketplaceRegistered", () => {
  test("키 없음·installLocation 없음·경로 없음은 false, 실존 경로는 true", () => {
    const loc = path.join(root, "market-reg");
    mkdirSync(loc, { recursive: true });
    assert.equal(isMarketplaceRegistered("m", {}), false);
    assert.equal(isMarketplaceRegistered("m", { m: {} }), false);
    assert.equal(isMarketplaceRegistered("m", { m: { installLocation: path.join(root, "nope") } }), false);
    assert.equal(isMarketplaceRegistered("m", { m: { installLocation: loc } }), true);
    assert.equal(isMarketplaceRegistered("__proto__", {}), false);
  });
});
