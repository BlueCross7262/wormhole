# wormhole-mcp

Claude Code 사용자 전역 설정을 머신 간 동기화하는 MCP 서버 (TypeScript, stdio transport).

- 전송/저장: **WebDAV** (Tailscale 망 내 NAS / 노드)
- 암호화: **age + passphrase 기반 zero-knowledge** — 업로드 전 클라이언트에서 암호화, 서버는 암호문만 보관
- 운용: **Windows 11 네이티브 + WSL2 (Ubuntu) 듀얼** — 논리키 기준 동기화, 적용 시 각 OS 경로로 매핑

핵심: passphrase 하나만 공유하면 모든 머신이 **동일한 age 키를 결정적으로 파생** 한다. 기기 간 키 파일 복사가 필요 없다.

---

## 1. 개요

- 동기화 대상은 `.claude/CLAUDE.md`, `settings.json`, `skills/**` 등 논리키로 표현된다. 각 머신은 적용 시점에 자기 OS 의 실제 경로로 매핑한다.
- 모든 원격 데이터 (매니페스트 + 파일 blob) 는 age 로 암호화된 상태로 WebDAV 에 올라간다. 서버 관리자도 평문에 접근할 수 없다.
- 암호화 키는 **passphrase 에서 결정적으로 파생** 한다. 동일 passphrase + 동일 salt → 모든 머신에서 동일 키. 따라서 비밀로 공유할 것은 passphrase 하나뿐이다.
- Claude Code 를 닫아 둔 동안에도 상시 백그라운드 동기화가 필요하면, 선택적 **상시 동기화 데몬** 을 별도 프로세스로 띄울 수 있다 (아래 **8.5 상시 동기화 데몬 (선택)** 참고).

---

## 2. 요구사항

- Node.js 20+
- WebDAV 서버 (Nextcloud, Caddy, nginx-dav 등). HTTPS 권장.
- 강한 passphrase (아래 4번 참고)

---

## 3. 설치 및 빌드

```bash
git clone https://github.com/your-org/wormhole-mcp
cd wormhole-mcp
npm install
npm run build
```

빌드 결과물은 `dist/index.js`.

개발 중 TypeScript 직접 실행:

```bash
npm run dev
```

테스트·타입 검사 실행법은 아래 **3.5 개발 / 테스트** 를 참고한다.

---

## 3.5 개발 / 테스트

테스트는 Node 내장 러너 (`node:test`) 와 `tsx` 로더로 실행한다. 별도 테스트 프레임워크 의존성은 없다 (`tsx` 는 이미 devDependency 에 포함).

```bash
npm test            # 전체 테스트 실행 (tsx --test "src/**/*.test.ts")
npm run test:types  # 테스트 코드 타입 검사 (tsconfig.test.json)
npm run typecheck   # 소스 전체 타입 검사 (tsc --noEmit)
```

- 테스트 파일은 대상 소스 옆에 co-located 된다 (`src/**/*.test.ts`). 현재 19개 파일, 519개 테스트.
- 빌드 산출물은 테스트를 제외한다 — `tsconfig.json` 이 `src/**/*.test.ts` 와 `src/test-helpers/**` 를 `exclude` 하므로 `dist/` 에는 런타임 코드만 들어간다.
- 테스트 코드의 타입 검사는 빌드와 분리된 `tsconfig.test.json` (`noEmit`) 으로 수행한다.

---

## 4. passphrase 설정

이 서버는 passphrase 를 scrypt KDF (Node 내장) 로 통과시켜 age identity (`AGE-SECRET-KEY-1...`) 를 **결정적으로 파생** 한다. 동일 passphrase + 동일 salt 면 어떤 머신에서도 같은 키가 나온다. salt 는 비밀이 아니며 원격 `keyparams.json` 에 평문으로 보관된다. 최초 기기가 salt 를 생성하고, 이후 기기는 이 salt 로 동일 키를 파생한다.

> passphrase 원문은 어디에도 저장되지 않는다. 파생된 키만 `~/.wormhole/age-key.txt` 에 0600 권한으로 캐시된다.

### 주입 우선순위

런타임에 다음 순서로 passphrase 를 찾는다. 먼저 발견된 것을 사용한다.

| 순위 | 출처 | 지정 방법 | 근거 |
|---|---|---|---|
| 1 | 환경변수 | `WORMHOLE_PASSPHRASE` | MCP stdio 는 비대화형이므로 `.mcp.json` env 주입이 가장 단순하다 |
| 2 | 0600 파일 | 기본 `~/.wormhole/passphrase` (env `WORMHOLE_PASSPHRASE_FILE` 로 경로 지정) | 영속적이고 셸 히스토리에 노출되지 않는다 |
| 3 | keychain | env `WORMHOLE_KEYCHAIN_SERVICE` (Linux/WSL2 의 `secret-tool` 만 실구현) | 가장 안전하나 플랫폼 의존적이라 최후순위 |

0600 파일을 쓰려면:

```bash
mkdir -p ~/.wormhole
printf '%s' 'your-strong-passphrase' > ~/.wormhole/passphrase
chmod 600 ~/.wormhole/passphrase
```

keychain (Linux/WSL2) 을 쓰려면:

```bash
secret-tool store --label="wormhole" service wormhole account wormhole
# 입력 프롬프트에 passphrase 를 넣는다. 이후 config/env 에 keychainService="wormhole" 지정.
```

### 강한 passphrase 권장

- **8~10자 이상의 완전 랜덤 문자열**, 또는
- **공백으로 구분된 4~5개 랜덤 단어** (Diceware 스타일)

passphrase 가 약하면 zero-knowledge 보장이 무력해진다. 모든 머신이 같은 passphrase 를 써야 키가 일치한다.

---

## 5. WebDAV 연결 설정

WebDAV 접속 정보는 고정 위치 `~/.wormhole/.env` 에 **인덱스 기반 프로파일** 로 등록한다.
비밀값을 `config.json` 에 직접 쓰지 않는다.

### ~/.wormhole/.env 프로파일 스키마

```bash
# ~/.wormhole/.env  (fixed location; chmod 600)
WORMHOLE_WEBDAV_1_USER=alice
WORMHOLE_WEBDAV_1_PASS=secret1
WORMHOLE_WEBDAV_1_URL=https://nas-a.example.com/dav
WORMHOLE_WEBDAV_1_BASEDIR=/wormhole       # 선택 (생략 시 /wormhole 또는 config 기본값)

WORMHOLE_WEBDAV_2_USER=bob@corp.com
WORMHOLE_WEBDAV_2_PASS=secret2
WORMHOLE_WEBDAV_2_URL=https://nas-b.example.com/dav

# WORMHOLE_PASSPHRASE=...   (optional global; 0600 파일 / keychain 도 가능)
```

파일을 생성한 뒤 권한을 설정한다.

```bash
mkdir -p ~/.wormhole
cp .env.example ~/.wormhole/.env
chmod 600 ~/.wormhole/.env
# 실제 값으로 편집한다
```

### 프로파일 선택 규칙

- **프로파일 1개** — `WORMHOLE_WEBDAV_USER` 없이 자동 선택된다.
  - selector 가 있고 username 과 불일치하면 에러로 중단한다.
- **프로파일 2개 이상** — `WORMHOLE_WEBDAV_USER=<username>` 이 필수다.
  - 미지정 또는 불일치 시 사용 가능한 username 목록을 포함한 에러로 중단한다.

### config.json 설정

`config.example.json` 을 복사해 편집한다.
WebDAV 접속 정보는 `.env` 프로파일이 권위 소스이므로 `config.json` 의 `remote` 섹션은 불필요하다.

```bash
cp config.example.json ~/.wormhole/config.json
```

### 주요 필드

| 필드 | 설명 | 기본값 |
|---|---|---|
| `stateDir` | 로컬 상태 디렉터리 | `~/.wormhole` |
| `crypto.passphraseEnv` | passphrase 를 읽을 환경변수 이름 | `WORMHOLE_PASSPHRASE` |
| `crypto.passphraseFile` | 0600 passphrase 파일 경로 (빈값이면 `<stateDir>/passphrase`) | `""` |
| `crypto.derivedKeyPath` | 파생 age 키 캐시 경로 (빈값이면 `<stateDir>/age-key.txt`) | `""` |
| `crypto.kdfN` | scrypt N (클수록 강함, 메모리 증가) | `65536` |
| `crypto.kdfR` | scrypt r | `8` |
| `crypto.kdfP` | scrypt p | `1` |
| `targets.include` | 동기화 포함 glob | 6번 참고 |
| `targets.exclude` | 동기화 제외 glob | 자격증명·캐시·로컬 오버라이드 |
| `settingsLocalKeys` | `settings.json` 에서 머신 고유로 제외할 키 | `mcpServers.*`, `permissions.*`, `hooks`, `statusLine.command` |
| `selfMcpServerNames` | `.mcp.json` 동기화 시 자기참조 제외 기준 | `["wormhole"]` |
| `conflictPolicy` | 충돌 기본 정책 | `preserve-both` |
| `autoSync.enabled` | 파일 변경 감지 자동 push | `false` |
| `autoSync.debounceMs` | 변경 후 push 까지 대기 (ms) | `2000` |
| `autoSync.pullIntervalMs` | 주기 pull 간격 (ms) | `300000` |

### .env 동기화 대상 추가 지정 (선택)

`~/.wormhole/.env` 에 아래 두 변수를 추가하면 `config.json` 기본값에 **ADDITIVE UNION** 으로 대상을 늘릴 수 있다.

| 변수 | 설명 |
|---|---|
| `WORMHOLE_SYNC_INCLUDE` | 추가로 포함할 glob (쉼표 구분) |
| `WORMHOLE_SYNC_EXCLUDE` | 추가로 제외할 glob (쉼표 구분) |

```bash
# ~/.wormhole/.env
WORMHOLE_SYNC_INCLUDE=.claude/plugins/known_marketplaces.json,.claude/extra/**
WORMHOLE_SYNC_EXCLUDE=.claude/secret-notes/**
```

- **보안 제외는 floor** — `*.key`, `*.token`, `.credentials.json`, `settings.local.json` 등 기본 제외 목록은 `.env` 로 제거할 수 없다. 제거하려면 `config.json` 의 `targets.exclude` 를 직접 편집한다.
- **쉼표가 구분자** — 중괄호 확장 `{a,b}` 미지원. 빈 변수 또는 미지정 시 아무 효과 없음.
- **`${HOME}` 토큰화 대상 아님** — 일반 glob 타겟은 raw 경로로 동기화된다. home 절대경로가 들어간 값은 타 머신에서 경로가 깨질 수 있으므로 주의한다.

#### 이미 동기화되는 것

전역 설정 `CLAUDE.md` 와 `settings.json` 은 기본 포함 대상이다.
`settings.json` 안에 hookify 훅 규칙과 `enabledPlugins` (어떤 플러그인을 켰는지) 가 들어있어 별도 추가 없이 동기화된다.

`.claude/hooks/**`, `.claude/statusline/**`, `.claude/hud/**` 디렉터리의 **스크립트 파일** 도 기본 포함 대상이다.
사용자가 직접 작성한 훅·스테이터스라인·HUD 스크립트를 머신 간 공유할 수 있다.

> **트레이드오프 — 스크립트 파일 vs. settings.json 와이어링**
>
> 훅·스테이터스라인 스크립트 파일은 동기화되지만, `settings.json` 의 훅 연결(`hooks.*`)과 `statusLine.command` 는 **머신 로컬** 로 유지된다 (`settingsLocalKeys` 기본값).
> 이유: `hooks.*.command` 와 `statusLine.command` 에는 Windows `C:\Program Files\nodejs\node.exe` 같은 OS·머신 고유 인터프리터 절대경로가 들어가며, wormhole 의 `${HOME}` 토큰화 범위 밖이라 그대로 동기화하면 타 머신에서 경로가 깨진다.
> 결과: 새 머신에 pull 하면 스크립트 파일은 도착하지만 와이어링은 각 머신이 직접 재설정해야 한다 (OMC 재실행 또는 수동 지정 1회).
> 스크립트 파일이 없는 상태에서 와이어링만 있는 기존 환경은 이전과 동일하게 동작한다.

#### 의도적으로 동기화하지 않는 것

- **`installed_plugins.json` / `known_marketplaces.json`** — 머신별 절대경로 (`installPath` / `installLocation`) 를 품고 있어 그대로 동기화하면 타 머신 경로를 깨뜨린다. 일반 glob 타겟은 `${HOME}` 토큰화 대상이 아니라 raw 로 처리되므로 기본 제외다.
- **`~/.claude.json`** — 사용자 전역 MCP 설정이지만 `machineID` / OAuth 토큰 / 프로젝트 이력이 섞인 큰 파일이라 통째 동기화하지 않는다. 필요 시 subset 동기화는 향후 별도 설계 예정.

---

## 6. Claude Code `.mcp.json` 등록

`.mcp.json.example` 을 참고해 Claude Code 전역 MCP 설정에 등록한다.

```json
{
  "mcpServers": {
    "wormhole": {
      "command": "node",
      "args": ["/absolute/path/to/wormhole-mcp/dist/index.js"],
      "env": {
        "WORMHOLE_WEBDAV_USER": "alice",
        "WORMHOLE_LOG_LEVEL": "info"
      }
    }
  }
}
```

- `WORMHOLE_WEBDAV_USER` 는 `~/.wormhole/.env` 에 등록된 프로파일을 **username 으로 선택** 하는 셀렉터다.
  - 프로파일이 1개면 생략 가능 (자동 선택).
  - 2개 이상이면 필수이며, 불일치 시 에러로 중단한다.
- WebDAV 비밀값(PASS/URL 등)은 `~/.wormhole/.env` 에 두며 이 파일에 넣지 않는다.
- `WORMHOLE_PASSPHRASE` 를 여기 평문으로 넣는 대신 `~/.wormhole/.env` 또는 0600 파일 / keychain 사용을 권장한다 (4번 참고).
- `args` 의 경로는 절대경로로 지정한다. Windows 는 `C:/Users/user/...`, WSL2 는 `/home/user/...` 형식이다.

---

## 7. MCP 도구

서버가 등록되면 Claude Code 에서 다음 5종을 사용할 수 있다.

### `sync_status`

추가/수정/삭제/원격변경/충돌/수렴 요약을 반환한다. 변경 없음.

- 입력: `{ "jobId"?: string }`
- `jobId` 를 주면 해당 async job (아래 `async` 옵션) 의 상태/결과/오류를 반환한다.
- `jobId` 없으면: `summary` (added / modified / deleted / remoteAdded / remoteModified / remoteDeleted / conflicts / unchanged), `conflicts`, `machineId`, `manifestGeneration`

### `sync_push`

로컬 변경을 원격으로 업로드한다.

- 입력: `{ "dryRun"?: boolean, "async"?: boolean }` (둘 다 기본 `false`)
- `dryRun: true` 면 실제 업로드 없이 계획만 반환한다.
- `async: true` 면 백그라운드로 실행하고 `{ jobId, accepted }` 를 즉시 반환한다 (대용량 시 stdio 비블로킹). 진행은 `sync_status({ jobId })` 로 폴링.
- `settings.json` 은 머신 고유 키를 제외한 공유 subset 만 push 한다.
- `.mcp.json` 의 자기참조 항목 (`selfMcpServerNames`) 은 push 에서 제거된다.

### `sync_pull`

원격 변경을 로컬에 적용한다.

- 입력: `{ "dryRun"?: boolean, "async"?: boolean }` (둘 다 기본 `false`)
- `async: true` 동작은 `sync_push` 와 동일 (`jobId` 반환 → `sync_status` 폴링).
- 적용 전 영향 파일을 `<stateDir>/backups/<timestamp>/` 에 자동 백업한다.
- 충돌 발생 시 `conflictPolicy` 에 따라 처리한다 (기본 `preserve-both`).

### `sync_dry_run`

push/pull 을 실제 변경 없이 계획만 계산한다 (작업 전 미리보기 권장).

- 입력: `{ "direction": "push" | "pull" }`
- 반환: 해당 방향의 dry-run 계획 (업로드/다운로드/삭제/충돌 후보). 데이터 변경 없음.

### `sync_resolve`

충돌을 명시적으로 해소한다.

- 입력: `{ "policy"?: "preserve-both" | "latest-wins" | "manual", "keys"?: string[], "dryRun"?: boolean }`
- `policy` 생략 시 config 의 `conflictPolicy` 를 따른다.
- `keys` 생략 시 전체 충돌 대상.
- `latest-wins`: 원격 최신본 (매니페스트 generation 우선) 으로 덮어쓴다.
- `manual`: 충돌 목록만 반환하고 실제 처리는 사용자에게 위임한다.

---

## 8. 동작 모델

### 수동 동기화

`sync_push` / `sync_pull` / `sync_resolve` 를 직접 호출한다.

### 자동 동기화 (`autoSync.enabled: true`)

- chokidar watcher + debounce 로 **로컬 → 원격 push 만** 자동화한다.
- 다른 머신의 원격 변경은 watcher 로 감지할 수 없으므로, **기동 시 1회 pull + 주기 pull 폴링** (`pullIntervalMs`) 으로 반영한다.

### 하이브리드 구조 (MCP 서버 + 상시 데몬)

동기화는 두 경로로 동작하며, 둘은 동일한 엔진 + 원격을 공유한다.

- **MCP 서버 (세션 스코프)** — 온디맨드 도구 (`sync_*`) + 기동 시 1회 pull 을 제공한다. `autoSync.enabled: true` 면 세션이 살아 있는 동안 watcher 도 돈다. 단, MCP stdio 프로세스 (= Claude Code 세션) 에 종속되므로 세션이 종료되면 watcher 도 함께 멈춘다.
- **상시 데몬 (세션 무관)** — Claude Code 세션과 무관하게 watcher + 주기 pull 로 **연속 동기화** 를 수행하는 별도 프로세스다. 과거의 "watcher 수명 한계" 는 이 선택적 데몬으로 해소된다 — 세션이 꺼져 있어도 동기화가 지속된다. 구성·실행법은 아래 **8.5 상시 동기화 데몬 (선택)** 을 참고한다.

동시성은 두 경로가 함께 떠 있어도 안전하다 — 매니페스트 CAS 커밋 + 원격 락으로 직렬화되기 때문이다. 다만 watcher 가 둘 다 도는 이중 watch 는 불필요하므로 다음과 같이 조정된다.

- 데몬은 머신당 단일 인스턴스 락 (`<stateDir>/daemon.lock`) 을 점유한다.
- MCP 서버는 기동 시 이 락을 검사해 **라이브 데몬이 감지되면 자기 watcher 를 띄우지 않고 시작 pull 만 수행** 한다. 데몬이 없을 때만 (그리고 `autoSync.enabled: true` 일 때만) MCP 가 직접 watcher 를 가동한다.

---

## 8.5 상시 동기화 데몬 (선택)

상시 동기화 데몬은 Claude Code 가 닫혀 있어도 백그라운드에서 동기화를 지속하는 별도 프로세스다. MCP 서버의 watcher 는 세션이 종료되면 멈추지만, 이 데몬은 OS 가 살려 두는 한 watcher + 주기 pull 로 **연속 동기화** 를 수행한다.

### 빌드 및 실행

먼저 빌드한 뒤 실행한다.

```bash
npm run build
node dist/daemon.js
```

`wormhole-daemon` bin 으로도 실행할 수 있다 (전역 설치 시).

개발 중 TypeScript 직접 실행:

```bash
npm run daemon:dev
```

데몬은 MCP 서버와 **동일한 `config.json` 과 동일한 passphrase 주입 방식** (env / 0600 파일 / keychain, 4번 참고) 을 사용한다. `autoSync.enabled` 설정과 무관하게 연속 동기화를 강제 가동한다.

### 단일 인스턴스

- 머신당 데몬은 **하나만** 떠야 한다. 데몬은 기동 시 `<stateDir>/daemon.lock` 단일 인스턴스 락을 점유한다.
- 락을 이미 라이브 데몬이 쥐고 있으면 두 번째 인스턴스는 **0 이 아닌 코드로 종료** 한다. supervisor 가 이를 실패로 보고 재기동을 시도해도, 기존 데몬이 살아 있는 한 새 인스턴스는 계속 즉시 종료된다 (이중 가동 방지).

### supervisor 연동

데몬은 **스스로 데몬화하거나 로그를 회전하지 않는다.** 백그라운드 상주·재기동·로그 관리는 OS supervisor 에 위임하는 단순 모델이다. 모든 로그는 **stderr** 로만 출력하므로, supervisor 가 stderr 를 파일이나 journald 로 수집하도록 구성한다.

#### Linux / WSL2 — systemd user unit

`~/.config/systemd/user/wormhole.service`:

```ini
[Unit]
Description=wormhole continuous sync daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/node /home/user/wormhole-mcp/dist/daemon.js
Restart=on-failure
RestartSec=5
Environment=WORMHOLE_WEBDAV_USER=alice
Environment=WORMHOLE_PASSPHRASE_FILE=/home/user/.wormhole/passphrase

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now wormhole.service
journalctl --user -u wormhole -f   # stderr 로그 확인
```

- `ExecStart` 의 node 경로와 `dist/daemon.js` 경로는 절대경로로 지정한다.
- stderr 는 journald 가 자동 수집한다 (별도 리다이렉트 불필요).

#### macOS — launchd LaunchAgent

`~/Library/LaunchAgents/com.user.wormhole.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.wormhole</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/user/wormhole-mcp/dist/daemon.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WORMHOLE_WEBDAV_USER</key>
    <string>alice</string>
    <key>WORMHOLE_PASSPHRASE_FILE</key>
    <string>/Users/user/.wormhole/passphrase</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/Users/user/.wormhole/daemon.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.user.wormhole.plist
```

- `KeepAlive=true` 로 종료 시 재기동을 보장한다.
- stderr 는 `StandardErrorPath` 가 가리키는 파일로 수집된다.

#### Windows — Task Scheduler

작업 스케줄러에서 **"로그온 시 시작 (At log on)"** 트리거로 다음을 실행한다.

```
node "C:\Users\user\wormhole-mcp\dist\daemon.js"
```

- stderr 를 파일로 모으려면 래퍼로 리다이렉트한다 — 예: `cmd /c node "...\dist\daemon.js" 2>> "C:\Users\user\.wormhole\daemon.log"`.
- 환경변수 (`WORMHOLE_WEBDAV_USER`, `WORMHOLE_PASSPHRASE_FILE` 등) 는 작업의 환경 또는 사용자 환경변수로 주입한다. WebDAV 비밀값은 `~/.wormhole/.env` 에서 읽힌다.
- 서비스형 상주·자동 재기동이 필요하면 [nssm](https://nssm.cc/) 으로 `node dist\daemon.js` 를 Windows 서비스로 등록하는 방법도 있다.

### 주의

config.json 을 수정한 뒤에는 **데몬을 재시작** 해야 한다. v1 은 핫 리로드를 지원하지 않으므로, 변경된 설정은 다음 기동 시에만 반영된다.

---

## 9. 충돌 처리

3-way (LOCAL / BASE / REMOTE) 콘텐츠 해시 비교로 충돌을 감지한다. 양측이 동일 콘텐츠로 수렴하면 전송 없이 watermark 만 전진한다.

| 정책 | 동작 |
|---|---|
| `preserve-both` (기본) | 로컬을 유지하고 원격본을 `<path>.conflict-<머신>-<세대>` 로 보존 (삭제 충돌은 `.conflict-deleted-*` 마커) |
| `latest-wins` | 원격 최신본 (매니페스트 generation 우선) 으로 자동 덮어쓰기 |
| `manual` | 충돌 목록만 반환, 사용자가 직접 처리 |

기본값이 `preserve-both` 인 이유: 설정 파일은 손실 위험을 0 으로 두는 게 안전하므로 양쪽을 보존하는 것이 적절한 기본값이다.

---

## 10. 안전장치

- 모든 로컬 쓰기는 원자적이다 (temp + fsync + rename).
- pull 적용 전 로컬 스냅샷을 백업한다.
- 모든 연산은 멱등이며, 부분 실패 시 롤백/재시도한다 (push 는 매니페스트 CAS 커밋을 원자 지점으로 삼아 자가복구).
- 동시쓰기 방어: 원격 매니페스트 ETag 기반 낙관적 잠금 + 락 파일, 충돌 시 지수 백오프 재시도.
- `settings.json` 은 키 단위로 머지하며 머신 고유키 (`settingsLocalKeys`) 를 보호한다. `settings.local.json` 은 동기화에서 제외된다 (기기 로컬 오버라이드).

---

## 10.5 저장·전송 최적화 / 경로 이식성

- **gzip 압축** — 업로드 전 `gzip → age 암호화` 순으로 처리해 전송/저장 용량을 줄인다. 다운로드 시 gzip magic (`0x1f 0x8b`) 을 감지해 자동 해제하며, 압축 이전 형식의 blob 도 그대로 읽는다 (하위 호환). 콘텐츠 해시는 평문 기준이라 압축이 변경 감지에 영향을 주지 않는다.
- **`${HOME}` 경로 토큰화** — `settings.json` · `.mcp.json` 의 동기화 대상 값에 포함된 home 절대경로를 `${HOME}` 토큰으로 치환해 업로드하고, pull 시 각 머신의 home 으로 복원한다. 이로써 `.mcp.json` 의 타 서버 `command`/`args` 같은 머신별 절대경로가 크로스머신에서 깨지지 않는다. 토큰 뒤 경로는 와이어에서 항상 posix(`/`) 형태로 정규화되고 pull 시 각 OS 의 구분자로 재구성되므로 Windows ↔ WSL2 간에도 안전하다.
- **push/pull 동시성** — blob 업/다운로드를 동시성 8 로 병렬 처리해 파일 수가 많을 때 처리량을 높인다. 매니페스트 CAS 커밋 순서와 멱등성은 그대로 보존된다.

---

## 11. 동기화 대상 기본값

### 포함 (`targets.include`)

```
.claude/CLAUDE.md
.claude/settings.json
.claude/skills/**
.claude/agents/**
.claude/commands/**
.claude/.mcp.json
.claude/hooks/**
.claude/statusline/**
.claude/hud/**
```

### 제외 (`targets.exclude`)

```
.claude/.credentials.json
.claude/settings.local.json
**/*.token
**/*.key
.claude/projects/**
.claude/todos/**
.claude/statsig/**
.claude/history/**
**/*.log
**/cache/**
```

---

## 12. 트러블슈팅

### MCP 서버가 응답하지 않는다

- `WORMHOLE_LOG_LEVEL=debug` 로 설정 후 재시작해 stderr 로그를 확인한다.
- `dist/index.js` 경로가 절대경로인지 확인한다.
- `npm run build` 로 빌드가 완료됐는지 확인한다.

### WebDAV 연결 오류

- WebDAV URL 과 `remoteBaseDir` 경로를 확인한다.
- username / password 가 환경변수로 올바르게 주입됐는지 확인한다.

### "passphrase 검증 실패" 로 기동이 중단된다

- 신규 기기는 원격 `keyparams.json` 의 sentinel (고정 평문 암호문) 을 파생 키로 복호해 passphrase 정합성을 검증한다. 실패하면 기동을 멈춘다.
- 다른 기기와 **완전히 동일한 passphrase** 를 쓰고 있는지 확인한다. 한 글자라도 다르면 다른 키가 파생된다.

### passphrase 분실

- passphrase 를 잃으면 **원격 데이터를 복호화할 수 없다.** passphrase 원문은 어디에도 저장되지 않기 때문이다.
- 파생 키 캐시 (`~/.wormhole/age-key.txt`) 가 남아 있는 기기가 있다면 그 기기에서는 계속 복호 가능하지만, 새 기기를 붙일 수는 없다.
- 복구가 불가능하면 원격 blob 과 `keyparams.json` 을 모두 삭제하고 새 passphrase 로 초기 push 를 재실행한다.

### 매니페스트 CAS 충돌

- 두 머신이 동시에 push 하면 발생할 수 있다. 재시도는 엔진 내부에서 자동 처리된다.
- 반복 발생 시 `lock.acquireRetries` / `lock.acquireRetryDelayMs` 값을 늘린다.

---

## 13. 보안 주의

- WebDAV 서버는 HTTPS 로 구성한다 (평문 전송 금지).
- 비밀값 (WebDAV 비밀번호, passphrase) 을 config 파일이나 코드에 하드코딩하지 않는다. env / 0600 파일 / keychain 으로 주입한다.
- `~/.wormhole/age-key.txt` (파생 키) 와 passphrase 파일은 0600 권한으로 보관한다 (Windows 는 사용자 프로파일 ACL 의존).
- 파생 키 캐시와 passphrase 파일은 동기화 대상에서 제외된다 (`**/*.key`, `exclude` 기본값).
- 서버 측 데이터는 모두 age 암호화 상태다. 서버 관리자도 평문에 접근할 수 없다.
