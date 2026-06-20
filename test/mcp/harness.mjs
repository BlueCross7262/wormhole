// MCP 도구 경계 블랙박스 하네스.
// plugin/dist/server.mjs 를 child_process 로 띄우고 stdio 위에서 newline-delimited
// JSON-RPC(MCP stdio 전송 규약)로 구동한다. webdav-harness.mjs(인메모리 쓰기 WebDAV)를
// 원격으로 붙여 실제 부팅(MKCOL)·도구 호출·와이어 효과를 관측한다.
//
// MCP stdio 전송은 Content-Length 프레이밍이 아니라 줄바꿈 구분 JSON 메시지다
// (SDK ReadBuffer 가 \n 으로 분리). 클라이언트도 동일하게 한 줄당 한 메시지.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { start as startWebdav } from "../webdav-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const SERVER_PATH = path.join(REPO, "plugin", "dist", "server.mjs");

export const DEFAULT_PASSPHRASE = "mcp-e2e-passphrase-do-not-use-irl";
export const DEFAULT_WEBDAV_PASS = "webdav-pass-distinct"; // passphrase 와 반드시 다름(zero-knowledge)

export { startWebdav };

// 임시 HOME + stateDir + config.json 스캐폴딩. roundtrip 의 makeHome 형태를 미러링.
// opts: { label, remoteUrl, files?:{rel:content}, remoteBaseDir?, kdfN?, configOverrides? }
export function makeHome(opts) {
  const { label, remoteUrl, files = {}, remoteBaseDir = "/wormhole", kdfN = 1024, configOverrides = {} } = opts;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `wh-mcp-${label}-`));
  const stateDir = path.join(homeDir, ".wormhole");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(homeDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const config = {
    home: homeDir,
    stateDir,
    remote: { url: remoteUrl, username: "", password: "", remoteBaseDir },
    crypto: { passphraseEnv: "WORMHOLE_PASSPHRASE", kdfN, kdfR: 8, kdfP: 1 },
    lock: { ttlMs: 30000, acquireRetries: 3, acquireRetryDelayMs: 50 },
    ...configOverrides,
  };
  const configPath = path.join(stateDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { homeDir, stateDir, configPath };
}

// child 프로세스용 격리 env. 실제 ~/.wormhole/.env 오염 차단(USERPROFILE/HOME 을 temp 로).
// 간섭 가능한 ambient 변수 제거 후 명시 변수만 주입.
export function childEnv(homeDir, configPath, remoteUrl, overrides = {}) {
  const e = { ...process.env };
  for (const k of [
    "WEBDAV_BASEDIR", "WORMHOLE_PASSPHRASE_FILE", "WORMHOLE_KEYCHAIN_SERVICE",
    "WORMHOLE_SYNC_INCLUDE", "WORMHOLE_SYNC_EXCLUDE", "WORMHOLE_LOG_LEVEL",
  ]) delete e[k];
  return {
    ...e,
    USERPROFILE: homeDir,
    HOME: homeDir,
    WORMHOLE_CONFIG: configPath,
    WEBDAV_URL: remoteUrl,
    WEBDAV_USER: "testuser",
    WEBDAV_PASS: DEFAULT_WEBDAV_PASS,
    WORMHOLE_PASSPHRASE: DEFAULT_PASSPHRASE,
    ...overrides,
  };
}

// server.mjs 를 stdio JSON-RPC 로 구동하는 클라이언트.
export class McpClient {
  constructor(env, { serverPath = SERVER_PATH } = {}) {
    this.env = env;
    this.serverPath = serverPath;
    this.child = null;
    this.stderr = "";
    this.stdoutBuf = "";
    this.pending = new Map(); // id -> {resolve, reject}
    this.notifications = [];
    this.nextId = 1;
    this.exited = null; // {code, signal} 설정되면 종료됨
  }

  spawn() {
    this.child = spawn(process.execPath, [this.serverPath], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      // 미해결 요청은 부팅/런타임 실패로 간주, stderr 와 함께 reject.
      const err = new Error(`server exited (code=${code}, signal=${signal})\nstderr:\n${this.stderr}`);
      err.exit = { code, signal };
      err.stderr = this.stderr;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    return this;
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 비-JSON stdout 라인은 무시(오염 감지는 별도)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    }
  }

  _send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, { timeoutMs = 20000 } = {}) {
    if (this.exited) {
      return Promise.reject(new Error(`server already exited\nstderr:\n${this.stderr}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' timed out after ${timeoutMs}ms\nstderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-boundary-harness", version: "0.0.1" },
    });
    this.notify("notifications/initialized", {});
    return res;
  }

  listTools() { return this.request("tools/list", {}); }
  callTool(name, args = {}) { return this.request("tools/call", { name, arguments: args }); }

  // 부팅 실패를 기대하는 케이스: initialize 가 reject(프로세스 종료)될 때까지 대기.
  async waitForExit(timeoutMs = 20000) {
    if (this.exited) return this.exited;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
      this.child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
  }

  async close() {
    if (this.child && this.exited === null) {
      this.child.kill();
      try { await this.waitForExit(5000); } catch { /* best effort */ }
    }
  }
}

export function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

// 도구 호출 결과 파싱 헬퍼. structuredContent 우선, 없으면 content[0].text JSON.
export function parseToolResult(res) {
  const r = res.result ?? {};
  const sc = r.structuredContent;
  let text = null;
  if (Array.isArray(r.content) && r.content[0]?.type === "text") {
    try { text = JSON.parse(r.content[0].text); } catch { text = r.content[0].text; }
  }
  return { isError: r.isError === true, structured: sc ?? text, text, raw: r };
}
