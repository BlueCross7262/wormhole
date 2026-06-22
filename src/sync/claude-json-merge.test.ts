import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeJsonForSync, mergeClaudeJsonForPull } from "./settings-merge.js";
import { sha256 } from "./hash.js";

const HOME = "/home/alice";

// 실제 ~/.claude.json 구조를 모사한 픽스처.
// mcpServers(env 포함) + oauthAccount + userID + projects(2단 중첩) + numStartups + machineID + 임의키 2개.
const FIXTURE_RAW = {
  mcpServers: {
    ky_jira: {
      command: "npx",
      args: ["-y", "@ky/mcp-jira"],
      env: {
        JIRA_PAT: "secret-token-abc123",
        JIRA_URL: "https://example.atlassian.net",
      },
    },
    context7: {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
  },
  oauthAccount: { email: "user@example.com", id: "oauth-id-123" },
  userID: "user-id-xyz",
  projects: {
    "/home/alice/project-a": {
      allowedTools: ["bash", "read"],
      nested: { deepKey: "deepValue" },
    },
    "/home/alice/project-b": {
      allowedTools: ["write"],
    },
  },
  numStartups: 42,
  machineID: "machine-abc-123",
  arbitraryKey1: "some-value",
  arbitraryKey2: { foo: "bar" },
};

// ── normalizeClaudeJsonForSync ─────────────────────────────────

describe("normalizeClaudeJsonForSync", () => {
  test("mcpServers만 추출하고 home 토큰화하여 안정 직렬화 반환", () => {
    const raw = JSON.stringify(FIXTURE_RAW);
    const result = normalizeClaudeJsonForSync(raw, HOME);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "mcpServers"), "mcpServers 키 존재");
    assert.equal(Object.keys(parsed).length, 1, "mcpServers 외 키는 포함되지 않음");

    const servers = parsed.mcpServers as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(servers, "ky_jira"), "ky_jira 서버 존재");
    assert.ok(Object.prototype.hasOwnProperty.call(servers, "context7"), "context7 서버 존재");
  });

  test("hash와 size가 text 기준으로 일치", () => {
    const raw = JSON.stringify(FIXTURE_RAW);
    const result = normalizeClaudeJsonForSync(raw, HOME);
    const buf = Buffer.from(result.text, "utf-8");
    assert.equal(result.hash, sha256(buf));
    assert.equal(result.size, buf.byteLength);
  });

  test("동일 입력 두 번 호출 시 동일 hash — 멱등성", () => {
    const raw = JSON.stringify(FIXTURE_RAW);
    const r1 = normalizeClaudeJsonForSync(raw, HOME);
    const r2 = normalizeClaudeJsonForSync(raw, HOME);
    assert.equal(r1.hash, r2.hash);
    assert.equal(r1.text, r2.text);
  });

  test("mcpServers 부재 시 빈 객체 정규화", () => {
    const raw = JSON.stringify({ oauthAccount: "x", userID: "y" });
    const result = normalizeClaudeJsonForSync(raw, HOME);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    assert.deepEqual(parsed, {});
  });

  test("빈 mcpServers 객체 정규화", () => {
    const raw = JSON.stringify({ mcpServers: {} });
    const result = normalizeClaudeJsonForSync(raw, HOME);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    assert.deepEqual(parsed, { mcpServers: {} });
  });

  test("JSON 파싱 실패 시 원본 반환(throw 금지)", () => {
    const bad = "not-valid-json{{{";
    const result = normalizeClaudeJsonForSync(bad, HOME);
    assert.equal(result.text, bad);
    const buf = Buffer.from(bad, "utf-8");
    assert.equal(result.hash, sha256(buf));
  });

  test("home 경로를 HOME 토큰으로 치환", () => {
    const raw = JSON.stringify({
      mcpServers: {
        local_tool: {
          command: `${HOME}/bin/tool`,
          args: [`${HOME}/data`],
        },
      },
    });
    const result = normalizeClaudeJsonForSync(raw, HOME);
    assert.ok(result.text.includes("${HOME}"), "HOME 토큰 존재");
    assert.ok(!result.text.includes(HOME), "절대 home 경로 미포함");
  });
});

// ── mergeClaudeJsonForPull ─────────────────────────────────────

describe("mergeClaudeJsonForPull", () => {
  test("원격 mcpServers를 로컬에 머지하고 나머지 키는 byte-identical 보존", () => {
    const localRaw = JSON.stringify(FIXTURE_RAW);

    // 원격: mcpServers만 포함(normalizeClaudeJsonForSync 산출물 모사), home 토큰화됨.
    const remoteMcpServers = {
      ky_jira: {
        command: "npx",
        args: ["-y", "@ky/mcp-jira"],
        env: {
          JIRA_URL: "https://example.atlassian.net",
          // JIRA_PAT 은 원격에서 이미 strip 된 상태
        },
      },
      new_server: {
        command: "npx",
        args: ["-y", "some-new-mcp"],
      },
    };
    const remoteContent = JSON.stringify({ mcpServers: remoteMcpServers });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;

    // mcpServers 는 원격 기준으로 머지됨
    const servers = result.mcpServers as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(servers, "ky_jira"), "ky_jira 존재");
    assert.ok(Object.prototype.hasOwnProperty.call(servers, "new_server"), "new_server 존재");

    // mcpServers 외 나머지 키는 로컬 그대로 보존
    assert.deepEqual(
      (result as Record<string, unknown>).oauthAccount,
      FIXTURE_RAW.oauthAccount,
      "oauthAccount 보존",
    );
    assert.equal((result as Record<string, unknown>).userID, FIXTURE_RAW.userID, "userID 보존");
    assert.equal(
      (result as Record<string, unknown>).numStartups,
      FIXTURE_RAW.numStartups,
      "numStartups 보존",
    );
    assert.equal(
      (result as Record<string, unknown>).machineID,
      FIXTURE_RAW.machineID,
      "machineID 보존",
    );
    assert.equal(
      (result as Record<string, unknown>).arbitraryKey1,
      FIXTURE_RAW.arbitraryKey1,
      "arbitraryKey1 보존",
    );
    assert.deepEqual(
      (result as Record<string, unknown>).arbitraryKey2,
      FIXTURE_RAW.arbitraryKey2,
      "arbitraryKey2 보존",
    );
  });

  test("projects 2단 중첩은 deep merge로 손실 없이 보존", () => {
    const localRaw = JSON.stringify(FIXTURE_RAW);
    const remoteContent = JSON.stringify({ mcpServers: { server_a: { command: "cmd" } } });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;

    const projects = result.projects as Record<string, unknown>;
    assert.ok(
      Object.prototype.hasOwnProperty.call(projects, "/home/alice/project-a"),
      "project-a 키 보존",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(projects, "/home/alice/project-b"),
      "project-b 키 보존",
    );
    const projA = projects["/home/alice/project-a"] as Record<string, unknown>;
    assert.deepEqual(
      (projA.nested as Record<string, unknown>).deepKey,
      "deepValue",
      "중첩 deepKey 보존",
    );

    // byte-identity: projects 전체 서브트리가 FIXTURE_RAW.projects 와 동일
    assert.deepEqual(result.projects, FIXTURE_RAW.projects, "projects 전체 byte-identity 보존");
    // project-b.allowedTools 명시적 검증 (key 존재만으론 내부 변조 탐지 불가)
    const projB = projects["/home/alice/project-b"] as Record<string, unknown>;
    assert.deepEqual(projB.allowedTools, FIXTURE_RAW.projects["/home/alice/project-b"].allowedTools, "project-b.allowedTools 보존");
  });

  test("원격 mcpServers env의 시크릿(*_PAT/*_TOKEN/*_SECRET) strip", () => {
    const localRaw = JSON.stringify({ mcpServers: {}, userID: "u" });
    const remoteContent = JSON.stringify({
      mcpServers: {
        tool_with_secrets: {
          command: "cmd",
          env: {
            TOOL_PAT: "should-be-stripped",
            TOOL_TOKEN: "also-stripped",
            TOOL_SECRET: "also-stripped",
            TOOL_URL: "keep-this",
          },
        },
      },
    });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;
    const env = (
      (result.mcpServers as Record<string, unknown>).tool_with_secrets as Record<string, unknown>
    ).env as Record<string, unknown>;

    assert.equal(env.TOOL_PAT, undefined, "TOOL_PAT strip 됨");
    assert.equal(env.TOOL_TOKEN, undefined, "TOOL_TOKEN strip 됨");
    assert.equal(env.TOOL_SECRET, undefined, "TOOL_SECRET strip 됨");
    assert.equal(env.TOOL_URL, "keep-this", "TOOL_URL 보존됨");
  });

  test("JIRA_PAT 은 원격에서 undefined (strip 확인)", () => {
    const localRaw = JSON.stringify(FIXTURE_RAW);
    // 원격 push 정규화 후 JIRA_PAT이 유지된 상태로 왔다고 가정(방어 strip 검증)
    const remoteContent = JSON.stringify({
      mcpServers: {
        ky_jira: {
          command: "npx",
          args: ["-y", "@ky/mcp-jira"],
          env: {
            JIRA_PAT: "leaked-secret",
            JIRA_URL: "https://example.atlassian.net",
          },
        },
      },
    });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;
    const jiraEnv = (
      (result.mcpServers as Record<string, unknown>).ky_jira as Record<string, unknown>
    ).env as Record<string, unknown>;

    assert.equal(jiraEnv.JIRA_PAT, undefined, "JIRA_PAT은 pull 결과에서 undefined");
  });

  test("로컬 부재(null) 시 원격 mcpServers 기반으로 반환", () => {
    const remoteContent = JSON.stringify({
      mcpServers: { tool_a: { command: "cmd" } },
    });

    const merged = mergeClaudeJsonForPull(null, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;
    const servers = result.mcpServers as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(servers, "tool_a"), "tool_a 존재");
  });

  test("빈 mcpServers인 원격 — 로컬 보존키 유지", () => {
    const localRaw = JSON.stringify(FIXTURE_RAW);
    const remoteContent = JSON.stringify({ mcpServers: {} });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;

    assert.deepEqual(result.mcpServers, {}, "원격 빈 mcpServers 적용");
    assert.equal(result.userID, FIXTURE_RAW.userID, "userID 보존");
  });

  test("원격 home 토큰은 로컬 home 경로로 detokenize", () => {
    const localRaw = JSON.stringify({ mcpServers: {}, userID: "u" });
    const remoteContent = JSON.stringify({
      mcpServers: {
        local_tool: {
          command: "${HOME}/bin/tool",
        },
      },
    });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;
    const tool = (result.mcpServers as Record<string, unknown>).local_tool as Record<
      string,
      unknown
    >;
    assert.ok(
      (tool.command as string).startsWith(HOME),
      `${HOME}로 detokenize 됨: ${tool.command}`,
    );
  });

  // A1 [E0 Critical] new-machine first-pull 시크릿 strip: localRaw=null 경로
  test("localRaw=null(신규 머신 첫 pull) 시 remote env 시크릿 strip 후 반환", () => {
    const remoteContent = JSON.stringify({
      mcpServers: {
        srv: {
          command: "npx",
          env: {
            ACME_PAT: "leak",
            X_TOKEN: "leak2",
            Y_SECRET: "leak3",
            SAFE_URL: "https://ok",
          },
        },
      },
    });

    const merged = mergeClaudeJsonForPull(null, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;
    const env = (
      (result.mcpServers as Record<string, { env: Record<string, unknown> }>).srv
    ).env;

    assert.equal(env.ACME_PAT, undefined, "ACME_PAT strip 됨");
    assert.equal(env.X_TOKEN, undefined, "X_TOKEN strip 됨");
    assert.equal(env.Y_SECRET, undefined, "Y_SECRET strip 됨");
    assert.equal(env.SAFE_URL, "https://ok", "SAFE_URL 보존됨");
  });

  // A2 [E2 Minor] remote 에 mcpServers 키 부재 시 merged 에서도 delete, 로컬 sibling 보존
  test("remote mcpServers 키 부재 시 merged 에서 delete, 로컬 sibling(userID/projects) 보존", () => {
    const localRaw = JSON.stringify({
      mcpServers: { old: {} },
      userID: "u",
      projects: { p: { x: 1 } },
    });
    const remoteContent = JSON.stringify({ userID: "remoteIgnored" });

    const merged = mergeClaudeJsonForPull(localRaw, remoteContent, HOME);
    const result = JSON.parse(merged) as Record<string, unknown>;

    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "mcpServers"),
      false,
      "remote 에 mcpServers 키 없으면 merged 에서 delete",
    );
    assert.equal(result.userID, "u", "로컬 userID 보존");
    assert.deepEqual(result.projects, { p: { x: 1 } }, "로컬 projects 보존");
  });

  // A3 [E5 보강] normalizeClaudeJsonForSync: env 시크릿 strip + mcpServers-only 정규화
  test("normalizeClaudeJsonForSync — env 시크릿 strip + mcpServers-only 정규화", () => {
    const raw = JSON.stringify({
      mcpServers: {
        srv: {
          command: "npx",
          env: {
            Z_SECRET: "s",
            OK: "v",
          },
        },
      },
      numStartups: 9,
      userID: "u",
    });

    const result = normalizeClaudeJsonForSync(raw, HOME);
    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    assert.equal(Object.keys(parsed).length, 1, "mcpServers 외 키 제외");
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "mcpServers"), true, "mcpServers 존재");

    const srvEnv = (
      (parsed.mcpServers as Record<string, { env: Record<string, unknown> }>).srv
    ).env;
    assert.equal(srvEnv.Z_SECRET, undefined, "Z_SECRET strip 됨");
    assert.equal(srvEnv.OK, "v", "OK 보존됨");
  });
});
