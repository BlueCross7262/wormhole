# wormhole

Claude Code 사용자 전역 설정을 머신 간 동기화하는 CLI (TypeScript). Claude Code 슬래시 커맨드가 이 CLI 를 호출한다.

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

## 1.5 아키텍처

wormhole 은 **단발 CLI 진입점** (`src/cli.ts` → `dist/cli.mjs`) 이 **하나의 동기화 엔진 코어** 를 구동하는 구조다. Claude Code 슬래시 커맨드 (§7) 가 이 CLI 를 매 호출마다 새로 띄워 서브커맨드를 실행한다. 아래에서 큰 그림, 진입점, 공유 코어, 데이터 흐름, 원격 레이아웃, 동시성·안전, 암호화, 모듈 맵 순으로 설명한다.

### 큰 그림

```
   ┌──────────────────────────────┐
   │ Claude Code 슬래시 커맨드     │
   │ /wormhole_status /_sync 등    │
   │     │ shell out               │
   │     ▼                         │
   │ wormhole CLI (dist/cli.mjs)  │
   │ argv 디스패처 (단발 실행)     │
   ├──────────────────────────────┤
   │ status/resolve/sync           │
   │ JSON → stdout, 로그 → stderr │
   └───────────────┬──────────────┘
                   │  buildEngine(logger)
                   ▼
       ┌──────────────────────────┐
       │   SyncEngine 코어        │
       │  push / pull / resolve   │
       │  status                  │
       │  ─ ManifestStore (CAS)   │
       │  ─ RemoteLock (머신 간)  │
       │  ─ AsyncMutex (프로세스) │
       └────────────┬─────────────┘
                    ▼
       ┌──────────────────────────┐
       │  RemoteStore (WebDAV)    │
       │  keyparams.json          │
       │  manifest.json.age       │
       │  blobs/<sha256>.age      │
       └──────────────────────────┘
```

- CLI 는 매 서브커맨드 호출마다 `buildEngine(logger)` 로 엔진을 새로 조립하고 1회 작업 후 종료하는 **단발 실행** 모델이다 (상주 프로세스·세션 수명 없음). 각 호출은 자기 원격 락을 직접 획득·해제한다 (one-shot-safe).
- 진입점은 `src/cli.ts` 한 곳뿐이며, 슬래시 커맨드는 이 CLI 를 shell out 으로 호출한다. 엔진 코어 (`src/sync`, `src/crypto`, `src/webdav`) 는 진입 표면이 바뀌어도 **그대로** 다 — stdio MCP 서버에서 CLI 로 바뀐 것은 진입점 한 겹뿐이다.

### 진입점

#### CLI (`src/cli.ts`)

- argv 디스패처다. 첫 인자로 서브커맨드 (`status`/`resolve`/`sync`) 를 받아 `buildEngine(logger)` 로 엔진을 조립한 뒤 해당 엔진 메서드를 1회 호출하고 결과 JSON 을 **stdout** 으로 출력한다 (서브커맨드 상세는 **§7 슬래시 커맨드 / CLI** 참조).
- **stdout 은 결과 JSON 전용** 이며, 모든 로깅은 stderr 로거로만 나간다. 슬래시 커맨드는 stdout 의 JSON 을 파싱해 사용한다.
- 성공 시 exit code 0, 오류 시 stderr 에 메시지를 남기고 nonzero 로 종료한다. 기동 시 자동 pull 은 **없다** — 단발 CLI 라 각 서브커맨드가 명시한 작업만 수행한다 (동작 모델은 **§8 동작 모델** 참조).
- `--help` / `-h` / 서브커맨드 미지정 시에는 `buildEngine` 을 **호출하지 않고** 사용법만 출력한 뒤 exit 0 한다. 비밀값·원격 없이 오프라인 스모크 테스트가 가능하도록 한 설계다.

### 공유 코어 (`buildEngine` 조립 순서)

CLI 진입점은 매 서브커맨드 호출마다 `bootstrap.buildEngine(logger)` 로 엔진을 새로 조립한다. 고정된 순서는 다음과 같다.

1. `loadConfig()` (평문 HTTP 사용 시 경고)
2. `loadOrCreateMachineId(config.stateDir)`
3. `new RemoteStore(config.remote, logger)` → `ensureDir(remoteBaseDir)` + `ensureDir(remoteBaseDir/blobs)`
4. `resolvePassphrase` (env → 0600 파일 → keychain)
5. `new AgeCrypto(logger)` + `ensureCryptoReady` (KDF → 결정적 age 키 파생, 원격 keyparams sentinel 로 패스프레이즈 검증)
6. `new SyncEngine({config, crypto, remote, machineId, logger})`

반환값은 `{engine, config, machineId, crypto, remote}` 다. 두 가지 순서 불변식이 있다.

- `ensureDir` (원격 레이아웃) 는 `ensureCryptoReady` (원격 keyparams 읽기) 보다 **먼저** 실행돼야 한다.
- `resolvePassphrase` 는 `ensureCryptoReady` 보다 **먼저** 실행돼야 한다.

패스프레이즈·원격 실패 시 `buildEngine` 이 reject 하며, CLI 가 stderr 에 오류를 남기고 nonzero 로 종료한다.

### 데이터 흐름

`SyncEngine` 은 push/pull/resolve/status 의 오케스트레이터로, 생성자에서 `ManifestStore` (매니페스트 읽기/쓰기/CAS), `RemoteLock` (머신 간 락), `AsyncMutex` (프로세스 내 직렬화) 세 협력자를 소유한다. 로컬 상태 경로도 소유한다: `state.json`, `base/`, `backups/` (모두 `stateDir` 하위).

- `status()` 는 부수효과 없음 — 원격 매니페스트 읽기 + 로컬 해시 스캔 + `state.json` 읽기 후 `computeStatus` 위임. mutex·락·쓰기 없음.
- 모든 `push`/`pull`/`resolve` 는 `mutex.runExclusive` 로 감싸고, non-dryRun 실제 작업은 추가로 `withLock(this.lock, ...)` (원격 락) 로 감싼다. dryRun 계획은 mutex 안에서만 돌고 원격 락은 잡지 않는다.

#### push

```
runPushWithRetry  ← ManifestConflictError 시 최대 MAX_CAS_RETRIES(3)회
  └ runPush
      1. 원격 매니페스트 읽기 → expectedGeneration (없으면 null = create 경로)
      2. 로컬 해시 스캔 + state.json → computeStatus 로 키 분류
      3. [pre-commit]  블롭 업로드(콘텐츠 주소·멱등, mapLimit IO_CONCURRENCY=8)
                       + 인메모리 매니페스트 upsert/tombstone
      4. [COMMIT]      manifestStore.write(manifest, expectedGeneration) ← 커밋 지점
      5. [post-commit] base 스냅샷 + state.json watermark (커밋 성공 후에만)
```

- 커밋 지점 전 실패는 원격·로컬 모두 무변경, 커밋 후 로컬 반영 실패는 다음 실행이 자가 치유한다.
- 빈 push 단락: pushed·deleted·converged 가 모두 0이면 매니페스트를 쓰지 않는다 (원격 무변경). CAS write 는 pushed>0 또는 deleted>0 일 때만 발생하며, converged-only push 는 원격 쓰기 없이 로컬 watermark 만 전진시킨다.
- 충돌 시 재시도 backoff 는 지수 + jitter (`min(2000, 100·2^attempt) + random(0..99)ms`). 이 엔진 레벨 재시도는 ManifestStore 내부 weak-ETag 재시도 **위에** 한 겹 더 얹힌 것이다.

#### pull

```
runPull
  1. 원격 매니페스트 읽기 (없으면 적용 대상 없음 → 빈 결과)
  2. 로컬 해시 스캔 + state.json → computeStatus
  3. toApply(remoteAdded/Modified) / toRemove(remoteDeleted) / converged 분류
  4. backupRoot = backups/<runTs> 생성
  5. mapLimit IO_CONCURRENCY=8 적용:
       경로 검증(safeAbsPath) → downloadBlob → backupFile → 키 타입별 라우팅 → watermark
  6. 실패 시 try/catch → rollback(backedUp) 후 rethrow
```

- pull 은 **충돌을 적용하지 않는다** — 비충돌 원격 변경만 fast-forward 하고 충돌은 결과에 보고만 한다. 충돌 해소 (preserve-both / latest-wins / manual) 는 `resolve()` 의 몫이다 (**§9 충돌 처리** 참조).
- 롤백은 all-or-nothing — `mapLimit` 이 `Promise.all` 이 아닌 `Promise.allSettled` 를 써서 모든 워커의 디스크 부수효과와 `backedUp` 등록이 끝난 뒤 rollback 이 돌도록 보장한다. 백업 복원 시 `backupPath===null` (적용이 새로 만든 파일) 항목은 삭제한다.

#### settings.json / .mcp.json 특수 라우팅

- push 시 `preparePushSettings` 가 스캔과 **동일한 파이프라인** 으로 정규화한다 — `settings.json` 은 머신 로컬 키 제거 + `${HOME}` 토큰화 + 안정 직렬화, `.mcp.json` 은 self/wormhole mcpServers 제거 + 토큰화. 정규화 텍스트가 블롭 콘텐츠가 되어 `contentHash` 가 스캔과 일치한다 (영구 modified 루프 방지).
- pull 시 `applyPullSettings` 는 키 단위 3-way 병합 (원격 공유 vs 로컬 토큰화 vs base 스냅샷) 으로 머신 로컬 키는 항상 로컬 값을 보존하고 공유 부분집합만 병합한 뒤 실제 홈 경로로 detokenize 한다. `.mcp.json` 은 `mergeMcpJsonForPull` 로 비-self 서버는 remote-wins, self/wormhole 항목은 항상 로컬 보존.

### 원격 레이아웃

`remoteBaseDir` (예: `/wormhole`) 아래 세 종류 아티팩트만 존재한다.

| 경로 | 내용 |
|---|---|
| `keyparams.json` | 평문 KDF 파라미터 (salt, N/r/p) + sentinel |
| `manifest.json.age` | age 암호화 + armored 매니페스트 |
| `blobs/<sha256(logicalKey)>.age` | 콘텐츠 주소 암호화 파일 블롭 |

- 블롭 파일명은 **논리 키 (경로) 의 sha256** 이지 콘텐츠 해시가 아니다 — 그래서 서버에 논리 경로가 노출되지 않는다 (zero-knowledge 명명).
- `RemoteStore.resolvePath` 가 상대 경로에 baseDir 을 접두하고 중복 슬래시를 접는다.

### 동시성·안전

2계층 동시성으로 무결성을 지킨다.

- **프로세스 내** — `AsyncMutex.runExclusive` 가 `tail` 프로미스에 fn 을 체이닝하고 `tail = run.catch(()=>undefined)` 로 갱신해 실패 작업이 큐를 깨지 않게 하는 순수 FIFO 직렬화.
- **머신 간** — 원격 `lock.json` 으로 직렬화. `RemoteLock.acquire()` 는 서버측 조건부 PUT (없으면 `putIfNoneMatch`, 만료·손상·자기 락 갱신은 `putIfMatch`) 으로 진짜 상호배제를 구현한다. TTL 은 `config.lock.ttlMs` (약 30초), 만료 판정은 `acquiredAt+ttl<=now` 또는 `CLOCK_SKEW_TOLERANCE_MS`(5분) 초과 미래값(=손상). `release()` 는 자기 락만 best-effort 삭제, `withLock` 은 획득 실패 시 throw 하고 finally 에서 release.

매니페스트 CAS 는 **두 독립 가드** 를 쓴다 (안전장치 전반은 **§10 안전장치** 참조).

- **1차 — ETag 조건부 PUT** — 원격이 있으면 `putIfMatch(If-Match:lastEtag)`, 생성 시 `putIfNoneMatch(If-None-Match:*)`. `ManifestStore.read()` 가 캡처한 ETag 를 다음 write 의 If-Match 로 쓴다.
- **2차/폴백 — 세대 카운터** — write 직전 원격을 재독해 실제 `manifestGeneration` 을 `expectedGeneration` 과 비교, 다르면 `ManifestConflictError`. ETag 미지원 서버에서도 충돌을 잡는다. write 시 generation +1, `updatedBy`/`updatedAt` 갱신.
- **weak-ETag 관용 재시도** — Apache mod_dav 등은 갓 수정한 파일에 약 1초간 weak ETag (`W/"..."`) 를 내보내, strong If-Match 비교가 실제 충돌 없이 가짜 412 를 낸다. 412 발생 시 write 가 원격을 재독해 — generation 이 전진했으면 **진짜 충돌** (throw), 그대로면 **가짜 weak-412** 로 보고 backoff (`DEFAULT_CAS_RETRY_BACKOFF_MS = [300,500,700,900,1100]ms`) 후 ETag 가 strong 으로 늙을 때까지 재시도한다. push 전체가 원격 락 (단일 writer) 아래 돌기 때문에 weak 윈도우 동안 외부 머신이 generation 을 전진시킬 수 없어 안전하다. 예산 소진 시 `ManifestConflictError` 로 변환되어 상위 push 재시도 루프로 올라간다. (생성 경로는 존재 기반 `If-None-Match` 라 weak-ETag 와 무관 — 단발 시도.)

엔진 레벨 push 재시도 (`MAX_CAS_RETRIES = 3`) 는 이 manifest-store 내부 재시도 **위에** 한 겹 더 있는 별개 천장이다.

추가 안전장치:

- **원자적 로컬 쓰기** — `atomicWriteFile` 은 부모 mkdir → 동일 디렉터리 temp (machineId/pid/seq 명) → `fsync` → close → rename → 부모 dir fsync (best-effort). `state.json`, base 스냅샷, pull 파일, 충돌 사본에 적용해 크래시·정전 시 0바이트/부분 파일을 막는다.
- **경로 탈출 방어** — 원격 유래 논리 키는 `safeAbsPath` (`isValidLogicalKey` + toOS + `isWithinHome`) 검증 후에만 쓰기/삭제, 무효·홈 밖 키는 warn 후 스킵. 파일명 접미사로 쓰이는 원격 유래 machineId/generation 은 `sanitizeToken` (`[A-Za-z0-9_-]`, 최대 64자) 으로 정제해 traversal/ADS/예약어 주입을 차단한다.
- **converged watermark 전진** — 양측이 동일 콘텐츠에 도달했거나 양측 삭제한 항목은 데이터 전송 없이 base/state watermark 만 전진시켜 다음 실행의 stale-base 가짜 충돌을 막는다 (`advanceConverged`, runPush·runPull 양쪽 호출).
### 암호화 (zero-knowledge)

- 서버에는 **암호문만** 저장된다. 매니페스트와 모든 블롭은 age 암호화 후 armored 로 업로드되고, 패스프레이즈 평문은 절대 저장되지 않으며 파생된 age 신원만 로컬 캐시된다.
- **패스프레이즈 → 결정적 age 신원** — `deriveAgeIdentity` 가 `scryptSync(passphrase, salt, 32, {N,r,p,maxmem})` 로 32바이트 스칼라를 만들고 `bech32.encodeFromBytes("AGE-SECRET-KEY-", scalar).toUpperCase()` 로 인코딩한다. 같은 패스프레이즈 + 같은 salt + 같은 파라미터면 **모든 머신에서 동일 신원** 이 나와 기기 간 키 파일 복사가 불필요하다. 패스프레이즈·salt 가 비면 throw. `maxmem` 은 scrypt 메모리(약 `128·N·r`)가 Node 기본 32MB 를 넘으므로 `128·N·r·2 + (1<<24)` 로 설정.
- **KDF 파라미터** — `DEFAULT_KDF = {N: 1<<16 (=65536), r: 8, p: 1}` (약 64MB, 파생 1회 <1초), `config.crypto.kdfN/kdfR/kdfP` 로 튜닝. salt 는 16바이트 랜덤 base64 로 비밀이 아니며 원격에 평문 저장.
- **AgeCrypto** — private `#identity`/public `#recipient` 를 들고 `age-encryption(typage)` 로 동작한다. `initWithIdentity` 는 신원이 `AGE-SECRET-KEY-1` 로 시작하는지 검증하고 `age.identityToRecipient` 로 recipient 를 산출한다. encrypt 는 `age.Encrypter`+`addRecipient` 후 `age.armor.encode` (armored), decrypt 는 `age.Decrypter`+`addIdentity` 후 `age.armor.decode`. 파생 키는 `derivedKeyPath` 에 **mode 0600** 으로 캐시 (Windows 에선 chmod no-op, 프로필 ACL 의존). 캐시되는 것은 파생 키뿐, 패스프레이즈가 아니다.
- **keyparams.json + sentinel** — `{version, kdf:'scrypt', saltB64, N, r, p, sentinel}` 를 원격에 평문 저장 (`KeyParamsSchema` zod 검증). sentinel 은 고정 평문 `'wormhole passphrase verification v1'` 의 armored age 암호문이다.
- **ensureCryptoReady 분기** — keyparams 부재(첫 머신)면 salt 생성 → 신원 파생 → sentinel 암호화 → keyparams 업로드 후 `{created:true}`. 존재(새 머신)면 **원격 salt/N/r/p** 로 신원 파생 (원격이 진실의 원천 → 모든 머신이 동일 키), sentinel 복호 후 평문 일치 단언 — 불일치 시 `'passphrase 검증 실패'` throw (틀린 패스프레이즈로는 원격 데이터 복호 불가).
- **블롭 페이로드** — 평문 → gzip → `BLOB_MAGIC('CSZ1')` 접두 → age 암호화 → 업로드. 다운로드는 복호 후 앞 4바이트가 `CSZ1` 이면 magic 제거 + gunzip, 아니면 그대로 (레거시 무압축 하위호환). `contentHash` 는 **평문** 기준이라 압축·암호화가 해시에 영향을 주지 않는다.

### 모듈 맵

| 모듈 | 책임 |
|---|---|
| `src/cli.ts` | CLI argv 디스패처 진입점 (status/resolve/sync), JSON→stdout |
| `src/bootstrap.ts` | `buildEngine` — 엔진 조립 (config→machineId→remote→passphrase→crypto→engine) |
| `src/sync/engine.ts` | `SyncEngine` — push/pull/resolve/status, 블롭 업/다운로드, 원자적 쓰기, 롤백 |
| `src/sync/manifest.ts` | `ManifestStore` — 매니페스트 read/write, 2차 CAS, weak-ETag 재시도 |
| `src/sync/diff.ts` | `computeStatus` — 3-way 콘텐츠 해시 diff, 충돌 항목 enrich |
| `src/sync/scanner.ts` | `scanLocal` — fast-glob 로컬 열거 (stateDir 강제 제외) |
| `src/sync/lock.ts` | `RemoteLock` (머신 간) + `AsyncMutex` (프로세스 내) |
| `src/sync/hash.ts` | `sha256`/`hashFile`/`blobName`/`blobHash` — 콘텐츠 주소 명명 |
| `src/sync/settings-merge.ts` | settings.json/.mcp.json 정규화 + 3-way 병합 |
| `src/crypto/kdf.ts` | `deriveAgeIdentity` (scrypt) + KDF 파라미터/salt |
| `src/crypto/age.ts` | `AgeCrypto` — age encrypt/decrypt + 0600 키 캐시 |
| `src/crypto/keyparams.ts` | `ensureCryptoReady` — 첫 머신 부트스트랩 vs 새 머신 검증 |
| `src/crypto/passphrase.ts` | `resolvePassphrase` — env → 파일 → keychain |
| `src/webdav/client.ts` | `RemoteStore` — putAtomic/putIfMatch/putIfNoneMatch/getTextWithETag 등 WebDAV 원시 연산 |

---

## 2. 요구사항

- Node.js 20+
- WebDAV 서버 (Nextcloud, Caddy, nginx-dav 등). HTTPS 권장.
- 강한 passphrase (아래 4번 참고)

---

## 2.5 플러그인으로 설치 (권장 경로)

Claude Code 플러그인 마켓플레이스를 통해 빌드 없이 설치한다.

### 단계

**1. 마켓플레이스 등록**

```
/plugin marketplace add BlueCross7262/wormhole
```

**2. 플러그인 설치**

```
/plugin install wormhole@wormhole-marketplace
```

**3. 초기 설정 스캐폴드**

```
/wormhole-setup
```

`~/.wormhole/.env` 와 `~/.wormhole/config.json` 두 파일을 자동 생성하고 필요한 값을 채워넣을 수 있도록 안내한다.
두 파일 모두 이미 존재하면 덮어쓰지 않는다 (멱등).

**4. `.env` 편집**

```bash
# ~/.wormhole/.env  (chmod 600 적용됨)
# URL 에 WebDAV 공유 경로까지 포함한다 (예: /claude_code_sync)
WEBDAV_URL=https://nas.example.com/claude_code_sync
WEBDAV_USER=alice
WEBDAV_PASS=secret
WORMHOLE_PASSPHRASE=your-strong-passphrase
# 원격 기본 디렉터리는 자동 파생됨 → /alice (WEBDAV_BASEDIR 불필요)
```

**5. 슬래시 커맨드로 사용**

값 입력 후 Claude Code 세션에서 슬래시 커맨드를 호출하면 된다. 별도 재시작·서버 기동이 필요 없다 (각 커맨드가 CLI 를 단발 실행한다).

| 커맨드 | 동작 |
|---|---|
| `/wormhole_status` | 추가/수정/삭제/원격변경/충돌/수렴 요약 (변경 없음) |
| `/wormhole_resolve` | 충돌을 명시적으로 해소 |
| `/wormhole_sync` | **원샷** — pull → 충돌 시 자동 해소(`preserve-both`) → push |

일상적으로는 `/wormhole_sync` 하나면 충분하다. pull 후 충돌이 있으면 기본 정책 (`preserve-both`) 으로 해소한 뒤 push 까지 한 번에 처리한다 (커맨드 상세는 **§7 슬래시 커맨드** 참조).

> 플러그인 설치는 **두 표면** 을 동시에 등록한다 — MCP 서버(`plugin/dist/server.mjs`, Claude Code 재시작 후 활성화)와 슬래시 커맨드. MCP 도구 상세는 **§2.6 MCP 도구** 를 참조한다. 아래 **§6 (CLI 직접 실행)** 은 터미널에서 직접 돌릴 때만 참고한다.

---

## 2.6 MCP 도구 (자율 호출 표면)

플러그인은 슬래시 커맨드 외에 **MCP stdio 서버** (`plugin/dist/server.mjs`) 를 함께 제공한다.
Claude Code 가 직접 호출하는 도구로, 슬래시 커맨드 없이 AI 흐름 안에서 상태 조회·동기화를 수행할 수 있다.
플러그인 설치 후 Claude Code 를 **재시작** 하면 MCP 서버가 활성화된다.

### 제공 도구

| 도구 이름 | 읽기/쓰기 | 기본 동작 | 설명 |
|---|---|---|---|
| `wormhole_status` | 읽기 전용 | 자율 호출 가능 | 추가/수정/삭제/충돌/수렴 요약 반환 (변경 없음) |
| `wormhole_resolve` | 쓰기 | 기본값 = 미리보기 | 충돌을 명시적으로 해소 |
| `wormhole_sync` | 쓰기 | 기본값 = 미리보기 | pull → resolve → push 원샷 동기화 |

### confirm-gate 안전 모델

**읽기 전용 도구** (`wormhole_status`) 는 로컬·원격을 변경하지 않으므로 Claude 가 자율적으로 호출할 수 있다.

**쓰기 도구** (`wormhole_resolve`, `wormhole_sync`) 는 `confirm` 파라미터(기본값 `false`)로 작동을 제어한다.

- `confirm: false` (기본) — 실제 변경 없이 **미리보기** 결과만 반환한다. 어떤 파일이 영향을 받는지 확인할 수 있다.
- `confirm: true` — 실제로 적용한다.

> **중요:** Claude 는 `confirm: true` 를 **자율적으로 전달하지 않는다.** 사용자가 명시적으로 실행을 확인한 경우에만 `confirm: true` 로 재호출한다. 이 설계는 원격·로컬 데이터의 의도치 않은 변경을 방지한다.

일반 흐름:

1. Claude 가 `wormhole_sync` (confirm 생략 = 미리보기) 호출 → 계획 반환
2. 사용자가 내용 확인 후 "적용해" 라고 지시
3. Claude 가 `wormhole_sync` (`confirm: true`) 재호출 → 실제 동기화

---

## 3. 설치 및 빌드 (수동 / 레거시 경로)

> 플러그인을 쓰지 않거나 소스에서 직접 빌드해야 할 때만 이 절차를 따른다. 일반 사용자는 **§2.5 플러그인으로 설치** 를 권장한다.

```bash
git clone https://github.com/BlueCross7262/wormhole
cd wormhole
npm install
npm run build
```

빌드 결과물은 `dist/cli.mjs` (CLI 진입점). 터미널에서 직접 실행하는 방법은 **§6 (CLI 직접 실행)** 참조.

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

## 3.7 플러그인 빌드 (개발자)

플러그인 배포 아티팩트 (`plugin/dist/cli.mjs`) 를 빌드하고 검증한다.

```bash
npm run build:plugin
```

이 명령은 세 단계를 순서대로 실행하며, **어느 단계든 실패하면 전체가 중단된다.**

| 단계 | 내용 |
|---|---|
| esbuild 번들링 | `src/cli.ts` → `plugin/dist/cli.mjs` (단일 파일, ESM, Node 20+, 외부 의존성 인라인) |
| `claude plugin validate` | Claude Code 플러그인 유효성 검사 (`plugin/plugin.json` + 슬래시 커맨드 정의 포함) |
| 번들 무결성 스모크 테스트 | `node cli.mjs --help` 로 번들을 실행해 사용법 출력·기동 오류 여부 확인 (오프라인·비밀값 없이 동작) |

빌드 성공 후 `plugin/dist/cli.mjs` 를 커밋에 포함한다.

```bash
git add plugin/dist/cli.mjs
git commit -m "chore(plugin): update bundled cli"
```

> `plugin/dist/cli.mjs` 는 플러그인 설치 시 별도 빌드 없이 슬래시 커맨드가 바로 실행하는 아티팩트다 (hookify-global 방식과 동일). 커밋에 포함하지 않으면 설치 후 커맨드를 실행할 수 없다.

---

## 4. passphrase 설정

wormhole 은 passphrase 를 scrypt KDF (Node 내장) 로 통과시켜 age identity (`AGE-SECRET-KEY-1...`) 를 **결정적으로 파생** 한다. 동일 passphrase + 동일 salt 면 어떤 머신에서도 같은 키가 나온다. salt 는 비밀이 아니며 원격 `keyparams.json` 에 평문으로 보관된다. 최초 기기가 salt 를 생성하고, 이후 기기는 이 salt 로 동일 키를 파생한다.

> passphrase 원문은 어디에도 저장되지 않는다. 파생된 키만 `~/.wormhole/age-key.txt` 에 0600 권한으로 캐시된다.

### 주입 우선순위

런타임에 다음 순서로 passphrase 를 찾는다. 먼저 발견된 것을 사용한다.

| 순위 | 출처 | 지정 방법 | 근거 |
|---|---|---|---|
| 1 | 환경변수 | `WORMHOLE_PASSPHRASE` | CLI 는 비대화형이므로 `~/.wormhole/.env` env 주입이 가장 단순하다 |
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

WebDAV 접속 정보는 고정 위치 `~/.wormhole/.env` 에 **플랫 단일 변수** 로 등록한다.
비밀값을 `config.json` 에 직접 쓰지 않는다.

### ~/.wormhole/.env 스키마

```bash
# ~/.wormhole/.env  (fixed location; chmod 600)
# WEBDAV_URL 에는 WebDAV 공유 경로까지 포함한다
# (예: https://nas.example.com/claude_code_sync)
# Synology 등 NAS 는 루트가 읽기 전용이므로 쓰기 가능한 공유 경로를 URL 에 지정한다.
WEBDAV_URL=https://nas.example.com/claude_code_sync
WEBDAV_USER=alice
WEBDAV_PASS=secret
# 원격 기본 디렉터리는 WEBDAV_USER 에서 자동 파생된다 → /alice
# (WEBDAV_BASEDIR 는 제거됨; 명시 override 가 필요하면 config.json 의 remote.remoteBaseDir 사용)

# WORMHOLE_PASSPHRASE=...   (optional global; 0600 파일 / keychain 도 가능)
```

파일을 생성한 뒤 권한을 설정한다.

```bash
mkdir -p ~/.wormhole
cp .env.example ~/.wormhole/.env
chmod 600 ~/.wormhole/.env
# 실제 값으로 편집한다
```

### config.json 설정

`~/.wormhole/config.json` 은 **필수** 파일이다.
존재하지 않으면 어떤 wormhole 커맨드든 오류와 함께 중단되며, `/wormhole-setup` 실행을 안내하는 메시지가 출력된다.

`/wormhole-setup` (또는 `setup.mjs`) 을 실행하면 코드 기본값 그대로 채워진 `config.json` 이 생성된다 (이미 있으면 건드리지 않음).
직접 만들려면:

```bash
cp config.example.json ~/.wormhole/config.json
```

`config.json` 에는 **`remote` 섹션을 두지 않는다** — WebDAV 접속 정보(WEBDAV_URL/USER/PASS)는 `.env` 에만 기술한다. 원격 기본 디렉터리는 WEBDAV_USER 에서 자동 파생되며, 명시 override 가 필요한 경우에만 `remote.remoteBaseDir` 필드를 추가한다.

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

- **보안 제외는 floor** — `*.key`, `*.token`, `.credentials.json`, `settings.local.json` 등 기본 제외 목록은 `.env` 로 제거할 수 없다. 제거하려면 `~/.wormhole/config.json` 의 `targets.exclude` 를 직접 편집한다. 이 목록은 이제 `config.json` 에 명시적으로 기술되어 있으므로 바로 확인·수정할 수 있다.
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

## 6. CLI 직접 실행 (터미널)

> 일반 사용자는 §2.5 플러그인 + 슬래시 커맨드를 쓰면 된다. 이 절은 터미널에서 직접 돌리거나 스크립트로 자동화할 때만 참고한다. 등록할 MCP 서버는 없다.

빌드 후 `dist/cli.mjs` 를 node 로 직접 실행한다.

```bash
node dist/cli.mjs status
node dist/cli.mjs resolve --policy preserve-both
node dist/cli.mjs sync   --policy preserve-both
node dist/cli.mjs --help        # 사용법 (오프라인, 비밀값 불필요)
```

`npm link` (또는 전역 설치) 후에는 `wormhole` bin 으로 바로 호출할 수 있다.

```bash
npm link
wormhole status
wormhole resolve
wormhole sync
```

- WebDAV / passphrase 비밀값은 `~/.wormhole/.env` (또는 0600 파일 / keychain) 에서 읽는다 — CLI 인자로 넘기지 않는다 (§4, §5 참고).
- 결과는 stdout 에 JSON 으로, 로그는 stderr 로 나간다. 성공 시 exit 0, 오류 시 nonzero.

---

## 7. 슬래시 커맨드

플러그인 설치 후 Claude Code 에서 다음 슬래시 커맨드를 쓸 수 있다.

### `/wormhole_status` (`status`)

추가/수정/삭제/원격변경/충돌/수렴 요약을 반환한다. 변경 없음.

- `summary` (added / modified / deleted / remoteAdded / remoteModified / remoteDeleted / conflicts / unchanged), `conflicts`, `machineId`, `manifestGeneration` 을 JSON 으로 출력.

### `/wormhole_resolve` (`resolve [--policy P] [--keys k1,k2] [--dry-run]`)

충돌을 명시적으로 해소한다.

- `--policy` 는 `preserve-both` | `latest-wins` | `manual`. 생략 시 config 의 `conflictPolicy` 를 따른다.
- `--keys` 생략 시 전체 충돌 대상.
- `latest-wins`: 원격 최신본 (매니페스트 generation 우선) 으로 덮어쓴다. 여기서 "최신" 은 **마지막으로 push 된** 쪽(generation 이 높은 쪽)을 뜻하며, 파일 mtime/벽시계 시각이 아니다. 덮어쓰기 전 로컬본은 백업 디렉터리에 보존된다.
- `manual`: 충돌 목록만 반환하고 실제 처리는 사용자에게 위임한다.

### `/wormhole_sync` (`sync [--policy preserve-both|latest-wins]`)

**원샷 동기화** — pull → (충돌 시) resolve → push 를 한 번에 수행한다.

- pull 결과에 충돌이 있으면 `--policy` (기본 `preserve-both`) 로 해소한 뒤 push 한다.
- **stop-on-error** — pull / resolve 가 실패하면 push 전에 중단한다.
- `--policy manual` 은 **금지** 다 (sync 안에서는 자동 해소가 전제이므로 에러 — 수동 해소가 필요하면 `/wormhole_resolve` 를 따로 쓴다).
- 일상 동기화는 이 커맨드 하나면 충분하다.

---

## 8. 동작 모델

wormhole 은 **명시적 단발 동기화** 모델이다. 상주 서버·자동 백그라운드 동기화·기동 시 자동 pull 이 없다 — 사용자가 슬래시 커맨드 (또는 CLI) 를 호출한 시점에만, 호출한 작업만 수행한다.

### 일상 흐름

대개 `/wormhole_sync` 하나면 된다. pull → 충돌 시 자동 해소(`preserve-both`) → push 를 한 번에 처리한다. 세밀한 제어가 필요하면 `/wormhole_status` 로 상태를 확인한 뒤 `/wormhole_resolve` 로 충돌을 해소하고 다시 `/wormhole_sync` 를 호출한다 (커맨드 상세는 **§7 슬래시 커맨드** 참조).

### 동시 실행 안전성

여러 머신·여러 호출이 동시에 떠도 안전하다 — 각 호출은 자기 원격 락을 직접 획득·해제하며 (one-shot-safe), 매니페스트 CAS 커밋 + 원격 락 (`RemoteLock`) + 프로세스 내 `AsyncMutex` 로 직렬화되기 때문이다.

---

## 9. 충돌 처리

3-way (LOCAL / BASE / REMOTE) 콘텐츠 해시 비교로 충돌을 감지한다. 양측이 동일 콘텐츠로 수렴하면 전송 없이 watermark 만 전진한다.

| 정책 | 동작 |
|---|---|
| `preserve-both` (기본) | 로컬을 유지하고 원격본을 `<path>.conflict-<머신>-<세대>` 로 보존 (삭제 충돌은 `.conflict-deleted-*` 마커) |
| `latest-wins` | 원격 최신본 (매니페스트 generation = **마지막 push** 기준, 파일 mtime 아님) 으로 자동 덮어쓰기 |
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

### "config.json 을 찾을 수 없습니다" 오류

`~/.wormhole/config.json` 이 없으면 wormhole 커맨드가 즉시 오류와 함께 종료된다.
`/wormhole-setup` 을 실행하면 기본값이 채워진 `config.json` 이 자동 생성된다.
이미 `.env` 만 있는 기존 환경은 `/wormhole-setup` 을 한 번 더 실행하면 `config.json` 만 추가 생성된다 (`.env` 는 건드리지 않음).

### 슬래시 커맨드 / CLI 가 동작하지 않는다

- `WORMHOLE_LOG_LEVEL=debug` 환경변수로 stderr 로그를 자세히 본다.
- `node dist/cli.mjs --help` 가 사용법을 출력하는지 확인한다 (오프라인에서도 동작해야 정상).
- `npm run build` (직접 실행) 또는 `npm run build:plugin` (플러그인) 으로 빌드가 완료됐는지 확인한다.

### WebDAV 연결 오류

- WebDAV URL 과 `remoteBaseDir` 경로를 확인한다.
- username / password 가 환경변수로 올바르게 주입됐는지 확인한다.

### "passphrase 검증 실패" 로 커맨드가 중단된다

- 신규 기기는 원격 `keyparams.json` 의 sentinel (고정 평문 암호문) 을 파생 키로 복호해 passphrase 정합성을 검증한다. 실패하면 커맨드가 nonzero 로 종료한다.
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
