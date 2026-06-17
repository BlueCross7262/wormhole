# claude-sync-mcp

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

---

## 2. 요구사항

- Node.js 20+
- WebDAV 서버 (Nextcloud, Caddy, nginx-dav 등). HTTPS 권장.
- 강한 passphrase (아래 4번 참고)

---

## 3. 설치 및 빌드

```bash
git clone https://github.com/your-org/claude-sync-mcp
cd claude-sync-mcp
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

- 테스트 파일은 대상 소스 옆에 co-located 된다 (`src/**/*.test.ts`). 현재 13개 파일, 353개 테스트.
- 빌드 산출물은 테스트를 제외한다 — `tsconfig.json` 이 `src/**/*.test.ts` 와 `src/test-helpers/**` 를 `exclude` 하므로 `dist/` 에는 런타임 코드만 들어간다.
- 테스트 코드의 타입 검사는 빌드와 분리된 `tsconfig.test.json` (`noEmit`) 으로 수행한다.

---

## 4. passphrase 설정

이 서버는 passphrase 를 scrypt KDF (Node 내장) 로 통과시켜 age identity (`AGE-SECRET-KEY-1...`) 를 **결정적으로 파생** 한다. 동일 passphrase + 동일 salt 면 어떤 머신에서도 같은 키가 나온다. salt 는 비밀이 아니며 원격 `keyparams.json` 에 평문으로 보관된다. 최초 기기가 salt 를 생성하고, 이후 기기는 이 salt 로 동일 키를 파생한다.

> passphrase 원문은 어디에도 저장되지 않는다. 파생된 키만 `~/.claude-sync/age-key.txt` 에 0600 권한으로 캐시된다.

### 주입 우선순위

런타임에 다음 순서로 passphrase 를 찾는다. 먼저 발견된 것을 사용한다.

| 순위 | 출처 | 지정 방법 | 근거 |
|---|---|---|---|
| 1 | 환경변수 | `CLAUDE_SYNC_PASSPHRASE` | MCP stdio 는 비대화형이므로 `.mcp.json` env 주입이 가장 단순하다 |
| 2 | 0600 파일 | 기본 `~/.claude-sync/passphrase` (env `CLAUDE_SYNC_PASSPHRASE_FILE` 로 경로 지정) | 영속적이고 셸 히스토리에 노출되지 않는다 |
| 3 | keychain | env `CLAUDE_SYNC_KEYCHAIN_SERVICE` (Linux/WSL2 의 `secret-tool` 만 실구현) | 가장 안전하나 플랫폼 의존적이라 최후순위 |

0600 파일을 쓰려면:

```bash
mkdir -p ~/.claude-sync
printf '%s' 'your-strong-passphrase' > ~/.claude-sync/passphrase
chmod 600 ~/.claude-sync/passphrase
```

keychain (Linux/WSL2) 을 쓰려면:

```bash
secret-tool store --label="claude-sync" service claude-sync account claude-sync
# 입력 프롬프트에 passphrase 를 넣는다. 이후 config/env 에 keychainService="claude-sync" 지정.
```

### 강한 passphrase 권장

- **8~10자 이상의 완전 랜덤 문자열**, 또는
- **공백으로 구분된 4~5개 랜덤 단어** (Diceware 스타일)

passphrase 가 약하면 zero-knowledge 보장이 무력해진다. 모든 머신이 같은 passphrase 를 써야 키가 일치한다.

---

## 5. WebDAV 연결 설정

`config.example.json` 을 복사해 편집한다.

```bash
cp config.example.json ~/.claude-sync/config.json
```

### 주요 필드

| 필드 | 설명 | 기본값 |
|---|---|---|
| `stateDir` | 로컬 상태 디렉터리 | `~/.claude-sync` |
| `remote.url` | WebDAV 베이스 URL | — |
| `remote.username` | WebDAV 사용자명 | `""` |
| `remote.password` | WebDAV 비밀번호 (환경변수 권장) | `""` |
| `remote.remoteBaseDir` | 원격 루트 경로 | `/claude-sync` |
| `crypto.passphraseEnv` | passphrase 를 읽을 환경변수 이름 | `CLAUDE_SYNC_PASSPHRASE` |
| `crypto.passphraseFile` | 0600 passphrase 파일 경로 (빈값이면 `<stateDir>/passphrase`) | `""` |
| `crypto.derivedKeyPath` | 파생 age 키 캐시 경로 (빈값이면 `<stateDir>/age-key.txt`) | `""` |
| `crypto.kdfN` | scrypt N (클수록 강함, 메모리 증가) | `65536` |
| `crypto.kdfR` | scrypt r | `8` |
| `crypto.kdfP` | scrypt p | `1` |
| `targets.include` | 동기화 포함 glob | 6번 참고 |
| `targets.exclude` | 동기화 제외 glob | 자격증명·캐시·로컬 오버라이드 |
| `settingsLocalKeys` | `settings.json` 에서 머신 고유로 제외할 키 | `mcpServers.*`, `permissions.*` |
| `selfMcpServerNames` | `.mcp.json` 동기화 시 자기참조 제외 기준 | `["claude-sync"]` |
| `conflictPolicy` | 충돌 기본 정책 | `preserve-both` |
| `autoSync.enabled` | 파일 변경 감지 자동 push | `false` |
| `autoSync.debounceMs` | 변경 후 push 까지 대기 (ms) | `2000` |
| `autoSync.pullIntervalMs` | 주기 pull 간격 (ms) | `300000` |

### 비밀값 환경변수 주입

비밀값은 설정 파일에 직접 입력하지 않는다.

```bash
export CLAUDE_SYNC_WEBDAV_URL="https://your-webdav-server.example.com"
export CLAUDE_SYNC_WEBDAV_USER="your-webdav-username"
export CLAUDE_SYNC_WEBDAV_PASS="your-webdav-password"
export CLAUDE_SYNC_PASSPHRASE="your-strong-passphrase"
export CLAUDE_SYNC_LOG_LEVEL="info"   # debug | info | warn | error
```

env 가 있으면 config 파일 값을 오버라이드한다.

---

## 6. Claude Code `.mcp.json` 등록

`.mcp.json.example` 을 참고해 Claude Code 전역 MCP 설정에 등록한다.

```json
{
  "mcpServers": {
    "claude-sync": {
      "command": "node",
      "args": ["/absolute/path/to/claude-sync-mcp/dist/index.js"],
      "env": {
        "CLAUDE_SYNC_CONFIG": "/absolute/path/to/config.json",
        "CLAUDE_SYNC_WEBDAV_PASS": "your-webdav-password",
        "CLAUDE_SYNC_PASSPHRASE": "",
        "CLAUDE_SYNC_LOG_LEVEL": "info"
      }
    }
  }
}
```

> `args` 와 `CLAUDE_SYNC_CONFIG` 는 반드시 절대경로로 지정한다. Windows 는 `C:/Users/user/...`, WSL2 는 `/home/user/...` 형식이다.
> `CLAUDE_SYNC_PASSPHRASE` 를 평문으로 넣는 대신 0600 파일이나 keychain 사용을 권장한다 (4번 참고).

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

> **watcher 수명 한계 (중요)**: watcher 는 MCP stdio 프로세스 (= Claude Code 세션) 가 살아 있는 동안에만 동작한다. 세션이 종료되면 자동 push 도 멈춘다 (상시 데몬이 아니다). 세션이 꺼진 동안 발생한 오프라인 변경은 다음 기동 시 startup pull + 수동 `sync_push` 로 보정한다.

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

- `CLAUDE_SYNC_LOG_LEVEL=debug` 로 설정 후 재시작해 stderr 로그를 확인한다.
- `dist/index.js` 경로와 `CLAUDE_SYNC_CONFIG` 가 절대경로인지 확인한다.
- `npm run build` 로 빌드가 완료됐는지 확인한다.

### WebDAV 연결 오류

- WebDAV URL 과 `remoteBaseDir` 경로를 확인한다.
- username / password 가 환경변수로 올바르게 주입됐는지 확인한다.

### "passphrase 검증 실패" 로 기동이 중단된다

- 신규 기기는 원격 `keyparams.json` 의 sentinel (고정 평문 암호문) 을 파생 키로 복호해 passphrase 정합성을 검증한다. 실패하면 기동을 멈춘다.
- 다른 기기와 **완전히 동일한 passphrase** 를 쓰고 있는지 확인한다. 한 글자라도 다르면 다른 키가 파생된다.

### passphrase 분실

- passphrase 를 잃으면 **원격 데이터를 복호화할 수 없다.** passphrase 원문은 어디에도 저장되지 않기 때문이다.
- 파생 키 캐시 (`~/.claude-sync/age-key.txt`) 가 남아 있는 기기가 있다면 그 기기에서는 계속 복호 가능하지만, 새 기기를 붙일 수는 없다.
- 복구가 불가능하면 원격 blob 과 `keyparams.json` 을 모두 삭제하고 새 passphrase 로 초기 push 를 재실행한다.

### 매니페스트 CAS 충돌

- 두 머신이 동시에 push 하면 발생할 수 있다. 재시도는 엔진 내부에서 자동 처리된다.
- 반복 발생 시 `lock.acquireRetries` / `lock.acquireRetryDelayMs` 값을 늘린다.

---

## 13. 보안 주의

- WebDAV 서버는 HTTPS 로 구성한다 (평문 전송 금지).
- 비밀값 (WebDAV 비밀번호, passphrase) 을 config 파일이나 코드에 하드코딩하지 않는다. env / 0600 파일 / keychain 으로 주입한다.
- `~/.claude-sync/age-key.txt` (파생 키) 와 passphrase 파일은 0600 권한으로 보관한다 (Windows 는 사용자 프로파일 ACL 의존).
- 파생 키 캐시와 passphrase 파일은 동기화 대상에서 제외된다 (`**/*.key`, `exclude` 기본값).
- 서버 측 데이터는 모두 age 암호화 상태다. 서버 관리자도 평문에 접근할 수 없다.
