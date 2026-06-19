#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const WORMHOLE_DIR = path.join(os.homedir(), ".wormhole");
const ENV_PATH = path.join(WORMHOLE_DIR, ".env");

const TEMPLATE = `# wormhole MCP 서버 설정
# 이 파일을 편집하여 실제 값을 입력하고 Claude Code 를 재시작하세요.

# ── WebDAV 연결 ───────────────────────────────────────────────
# WebDAV 서버 URL (예: https://nextcloud.example.com/remote.php/dav/files/user/)
WEBDAV_URL=https://your-webdav-server/path/

# WebDAV 계정 이름
WEBDAV_USER=your-username

# WebDAV 계정 비밀번호 (앱 비밀번호 권장)
WEBDAV_PASS=your-password

# WebDAV 서버에서 wormhole 파일을 저장할 기본 경로 (기본값: /wormhole)
WEBDAV_BASEDIR=/wormhole

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

fs.mkdirSync(WORMHOLE_DIR, { recursive: true });

if (fs.existsSync(ENV_PATH)) {
  console.log(`already exists — not overwriting (idempotent): ${ENV_PATH}`);
  process.exit(0);
}

fs.writeFileSync(ENV_PATH, TEMPLATE, { encoding: "utf-8" });

try {
  fs.chmodSync(ENV_PATH, 0o600);
} catch {
  console.warn(
    "chmod 600 적용 실패 (Windows 에서는 ACL 로 파일 권한을 관리하므로 정상입니다)."
  );
}

console.log(`작성 완료: ${ENV_PATH}`);
console.log("다음 단계: 위 파일을 열어 WebDAV 정보와 패스프레이즈를 입력한 뒤 Claude Code 를 재시작하세요.");
