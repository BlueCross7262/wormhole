#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const WORMHOLE_DIR = path.join(os.homedir(), ".wormhole");
const ENV_PATH = path.join(WORMHOLE_DIR, ".env");
const CONFIG_PATH = path.join(WORMHOLE_DIR, "config.json");

const ENV_TEMPLATE = `# wormhole MCP 서버 설정
# 이 파일을 편집하여 실제 값을 입력하고 Claude Code 를 재시작하세요.

# ── WebDAV 연결 ───────────────────────────────────────────────
# WebDAV 서버 URL — WebDAV 공유 경로까지 포함해야 합니다
# (예: https://nas.example.com/claude_code_sync)
# Synology 등 NAS 는 루트가 읽기 전용이며 쓰기는 공유 디렉터리 안에서만 가능합니다.
WEBDAV_URL=https://your-webdav-server/your-share

# WebDAV 계정 이름
# 원격 기본 디렉터리는 이 값에서 자동으로 파생됩니다 (/<WEBDAV_USER>).
# 별도 WEBDAV_BASEDIR 설정은 필요 없습니다.
WEBDAV_USER=your-username

# WebDAV 계정 비밀번호 (앱 비밀번호 권장)
WEBDAV_PASS=your-password

# ── 암호화 패스프레이즈 ──────────────────────────────────────
# 방법 A: 환경변수 직접 지정 (가장 단순)
# WORMHOLE_PASSPHRASE=your-secret-passphrase

# 방법 B: 0600 권한 파일 경로로 지정 (기본값: ~/.wormhole/passphrase)
# WORMHOLE_PASSPHRASE_FILE=~/.wormhole/passphrase

# 방법 C: Linux/WSL2 keychain service 이름 (secret-tool)
# WORMHOLE_KEYCHAIN_SERVICE=wormhole

# ── 선택적 설정 ──────────────────────────────────────────────
# 로그 레벨 (debug | info | warn | error, 기본값: info)
# WORMHOLE_LOG_LEVEL=info
`;

const CONFIG_TEMPLATE = {
  stateDir: "~/.wormhole",
  crypto: {
    passphraseEnv: "WORMHOLE_PASSPHRASE",
    passphraseFile: "",
    derivedKeyPath: "",
    kdfN: 65536,
    kdfR: 8,
    kdfP: 1
  },
  targets: {
    include: [
      ".claude/CLAUDE.md",
      ".claude/settings.json",
      ".claude/skills/**",
      ".claude/agents/**",
      ".claude/commands/**",
      ".claude/.mcp.json",
      ".claude/hooks/**",
      ".claude/statusline/**",
      ".claude/hud/**"
    ],
    exclude: [
      ".claude/.credentials.json",
      ".claude/settings.local.json",
      "**/*.token",
      "**/*.key",
      ".claude/projects/**",
      ".claude/todos/**",
      ".claude/statsig/**",
      ".claude/history/**",
      "**/*.log",
      "**/cache/**"
    ]
  },
  settingsLocalKeys: [
    "mcpServers.*.command",
    "mcpServers.*.args",
    "mcpServers.*.cwd",
    "mcpServers.*.env",
    "permissions.*",
    "hooks",
    "statusLine.command"
  ],
  selfMcpServerNames: ["wormhole"],
  conflictPolicy: "preserve-both",
  lock: {
    ttlMs: 30000,
    acquireRetries: 3,
    acquireRetryDelayMs: 1000
  }
};

fs.mkdirSync(WORMHOLE_DIR, { recursive: true });

if (fs.existsSync(ENV_PATH)) {
  console.log(`already exists — not overwriting (idempotent): ${ENV_PATH}`);
} else {
  fs.writeFileSync(ENV_PATH, ENV_TEMPLATE, { encoding: "utf-8" });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    console.warn(
      "chmod 600 적용 실패 (Windows 에서는 ACL 로 파일 권한을 관리하므로 정상입니다)."
    );
  }
  console.log(`작성 완료: ${ENV_PATH}`);
}

if (fs.existsSync(CONFIG_PATH)) {
  console.log(`already exists — not overwriting (idempotent): ${CONFIG_PATH}`);
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", { encoding: "utf-8" });
  console.log(`작성 완료: ${CONFIG_PATH}`);
}

console.log("");
console.log("다음 단계:");
console.log("  1. ~/.wormhole/.env 를 열어 WebDAV 정보와 패스프레이즈를 입력한다.");
console.log("  2. ~/.wormhole/config.json 을 열어 동기화 범위(targets)를 필요에 맞게 수정한다 (선택).");
console.log("  3. Claude Code 를 재시작하면 /wormhole_sync, /wormhole_push, /wormhole_pull 을 바로 사용할 수 있다.");
