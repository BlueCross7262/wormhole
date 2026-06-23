# wormhole MCP 도구 경계 검증 계획서 (MCP Tool-Boundary Verification Plan)

- **작성일**: 2026-06-20
- **검증 계층**: MCP 도구 경계 블랙박스 (stdio JSON-RPC / MCP Inspector)
- **환경 정책**: 환경 무관 + 시나리오별 전제조건
- **대상 빌드물**: `plugin/dist/server.mjs` (`src/index.ts`)

---

## 1. 목적과 범위

- **목적**: wormhole MCP stdio 서버가 노출하는 4개 도구(`wormhole_status`, `wormhole_resolve`, `wormhole_sync`, `wormhole_doctor`)를 실제 MCP 프로토콜 경계에서 블랙박스로 검증한다.
- **증명 기준**: 본 계획서가 말하는 'proven'(proven=true)은 **무사각 기준** = "모든 mcp-boundary 기능에 그 동작을 행사하는 시나리오가 ≥1개 존재(none=0)" 를 뜻한다. 상세 결과는 §7.8 참조.
- **범위 IN**:
  - `tools/list` · `tools/call` 직렬화
  - zod 입력검증
  - confirm 게이트의 실제 와이어 무변경 증명
  - 충돌 3정책 (preserve-both / latest-wins / manual)
  - `settings.json` / `.mcp.json` 특수 라우팅
  - tombstone / converged
  - 에러 · 락 · CAS 강건성
  - 전송 · 등록 · 수명주기
- **범위 OUT**: 아래 2절의 기존 검증 완료 항목.

---

## 2. 제외 범위 — 기존 검증 완료 (재사용 금지 근거)

| 구분 | 항목 | 커버 내용 | 한계 |
|---|---|---|---|
| (a) | 툴 레이어 mock 단위테스트 (`src/tools/tools.test.ts`) | 어댑터 계약 (registerTool 호출, 분기 매핑) | 실 와이어 미검증, MockEngine 기반 |
| (b) | e2e 왕복 해피패스 (`test/roundtrip.test.ts` + `test/webdav-harness.mjs`) | 엔진 직접호출 push/pull 왕복 | 단일 happy 경로, MCP 프로토콜 경계 미검증 |
| (c) | 실서버 caveat | Apache `mod_dav` write-block 현상 문서화 | PUT 405 현상 기술에 국한, 발산·실패 경로 미검증 |

본 계획은 위 (a)(b)(c) 가 다루지 않은 **MCP 경계 · 발산 · 실패경로** 를 노린다. 모든 시나리오는 mock 엔진/buildEngine 직접호출을 금지하고 `server.mjs` 를 실제 stdio 프로세스로 띄워 검증한다.

---

## 3. 검증 대상 표면

### 3.1 4개 도구

| 도구명 | 종류 | inputSchema 요약 | 반환타입 | confirm 동작 |
|---|---|---|---|---|
| `wormhole_status` | 읽기전용 | 파라미터 없음 (빈 object) | `SyncStatus` | 해당 없음 (자율호출) |
| `wormhole_resolve` | 쓰기 | `policy: enum 3종 optional`, `keys: array<string> optional`, `confirm: boolean optional` | `ResolveResult` | false=미리보기 / true=실행 |
| `wormhole_sync` | 쓰기 | `policy: enum 2종("preserve-both","latest-wins") optional`, `confirm: boolean optional` | pull+push (+resolve) 합본 | false=미리보기 / true=실행 |
| `wormhole_doctor` | 읽기전용 | 파라미터 없음 (빈 object) | `{ ok: boolean, checks: Array<{name, status, detail}> }` | 해당 없음 (자율호출) |

### 3.2 confirm 게이트 안전 모델

- **읽기전용 (`wormhole_status`, `wormhole_doctor`)**: confirm 불필요, Claude 자율호출 허용.
- **쓰기 2종 (`resolve` / `sync`)**: confirm 기본값 `false` = 미리보기(dryRun), `true` = 실행.
- **Claude 자율 `confirm:true` 금지**: 쓰기 도구의 실제 실행은 사용자 확인을 거친다.

### 3.3 주의 사항

- `wormhole_sync.policy` enum 은 **`"manual"` 을 제외** 한다 (`wormhole_resolve` 와 의도적으로 발산). sync 는 자동 해소 파이프라인이므로 수동 보류 정책을 허용하지 않는다.
- server version 문자열이 코드 하드코딩 `"0.1.1"` 이며 `package.json` 의 `0.1.3` 과 **불일치** 한다 (부수 발견, 9절 기록). 본 계획의 모든 serverInfo 단언은 `"0.1.1"` 기준으로 pass/fail 을 건다.

---

## 4. 테스트 환경 라벨과 하네스

### 4.1 환경 라벨 정의

| 라벨 | 의미 | 구성법 |
|---|---|---|
| `WRITABLE_WEBDAV` | 쓰기 가능 + 강한 ETag 반환 WebDAV | dufs(`--allow-all`) / Caddy file_server+webdav / Nginx dav module / rclone serve webdav |
| `READONLY_WEBDAV` | PROPFIND 허용, MKCOL/PUT 모두 405 반환 | nginx `dav_methods` 를 GET HEAD OPTIONS PROPFIND LOCK UNLOCK 만 허용 |
| `TWO_MACHINE` | 머신 A/B 분리 (동일 원격 공유) | HOME 환경변수 + stateDir 만 분리 (별도 임시 디렉터리 2개), 동일 `WEBDAV_URL` + `WEBDAV_USER` + passphrase |
| `CORRUPT_REMOTE` | 손상된 원격 매니페스트 | `manifest.json.age` 에 평문/비-age-armored 바이트를 WebDAV PUT 으로 주입 |
| `NO_ETAG_WEBDAV` | ETag 헤더 미반환 서버 | nginx/Caddy 리버스 프록시에서 ETag 헤더 strip (커스텀 프록시) |

### 4.2 하네스 구성 (crossCuttingNotes 반영)

- **1순위 하네스**: 블랙박스 stdio JSON-RPC 클라이언트. `server.mjs`(`plugin/dist/server.mjs`)를 `child_process.spawn` 으로 띄우고 stdin 에 `initialize → initialized notification → tools/list → tools/call` 순서로 전송한다. MCP stdio 전송 규약인 줄바꿈 구분(newline-delimited) JSON 메시지를 사용한다 — LSP-style Content-Length 프레이밍이 아니다(실행 검증으로 확정).
- **2순위 하네스**: `@modelcontextprotocol/inspector --cli` 는 빠른 스모크에 편하나, generation/PROPFIND 와이어 관측·exit code·stdout 무오염 단언에는 직접 RPC 클라이언트가 정밀하다.
- **stdout/stderr 엄격 분리 캡처**: stdout 은 MCP JSON-RPC 프레임 전용, 모든 로깅·에러는 stderr 로 라우팅. `spawn` 시 `stdio:['pipe','pipe','pipe']` 로 fd1/fd2 를 독립 수집한다. TRX-08(부팅 halt), ELC-01/05(warn/debug 로그) 판정이 이 분리에 의존한다.
- **`WRITABLE_WEBDAV` 후보**: dufs / Caddy / Nginx / rclone serve webdav. ETag 강도가 중요한 ELC-08(manifest CAS 소진) · ELC-05(락 CAS)는 강한 ETag 가 필요하다. Apache `mod_dav` 의 weak-ETag 윈도는 `putIfMatch` CAS 를 깨므로 CAS 의존 시나리오에 부적합하다.
- **`TWO_MACHINE` 구성**: 머신 A/B 를 `HOME` 환경변수와 stateDir 만 분리(별도 임시 디렉터리 2개)하고, 동일 `WEBDAV_URL` + `WEBDAV_USER` + passphrase 로 동일 원격을 공유한다. `settings.json` 특수 라우팅(SMR-08)은 `${HOME}` 토큰화 공간에서 3-way 가 일어나므로 두 HOME 이 실제로 달라야 토큰화/디토큰화 경로가 실측된다.
- **`NO_ETAG_WEBDAV` 모사**: ELC-06(best-effort PUT 폴백 + warn) 별도 검증용으로 ETag 미반환 서버를 모사한다.
- **독립 PROPFIND 와이어 관측**: 도구와 별개의 PROPFIND/GET 클라이언트(`webdav` npm 또는 `curl`)를 띄워 `manifest.json` generation, `lock.json` machineId, `blobs/*` 존재를 호출 전후로 비교한다. confirm 게이트 무변경 증명(CGW 차원)과 sync 미리보기 읽기전용(CGW-01)은 이 외부 관측으로 "mock 분기" 가 아닌 "실제 와이어 불변" 을 단언한다.
- **실행 순서 · 판정 자동화 팁**: 8절 참조.

---

## 5. 시나리오 요약 매트릭스

| 차원 | ID | 우선순위 | 제목 |
|---|---|---|---|
| **Transport & Registration** | TRX-01 | P0 | tools/list — 정확히 4개 도구 이름·inputSchema 계약 검증 |
| | TRX-02 | P0 | stdout 순수성 — 로그가 stderr 로만 나오고 MCP 프레임 외 stdout 오염 없음 |
| | TRX-03 | P1 | 부팅 시 MKCOL 부수효과 — 도구 호출 전 원격 디렉터리 생성 PROPFIND 관측 |
| | TRX-04 | P1 | initialize capabilities — 서버 반환 capabilities 구조 계약 검증 |
| | TRX-05 | P1 | SIGINT graceful shutdown — SIGINT 수신 시 process.exit(0) 확인 |
| | TRX-06 | P1 | 부팅 실패 경로 — config.json 없음 시 stderr 에러 후 exit(1), stdout 무오염 |
| | TRX-07 | P2 | 잘못된 inputSchema 인자 — zod 거부 시 isError 응답이 MCP 프레임 내 반환 |
| | TRX-08 | P0 | WEBDAV_USER 부재 + remoteBaseDir 미설정 시 부팅 halt (stdout 무오염) |
| | TRX-09 | P2 | .env 로더 host-우선 override — 호스트 주입 env 가 ~/.wormhole/.env 보다 우선 |
| | TRX-10 | P2 | .env 파서 견고성 — 따옴표 strip·인라인 # 보존·전체줄 주석 무시·ENOENT silent skip |
| | TRX-11 | P1 | 평문 http 경고 — non-localhost http URL 부팅 시 stderr 경고 1회, localhost 무경고 |
| | TRX-12 | P1 | tools/list description 와이어 계약 정밀화 — 쓰기2종 confirm 안전문구 1개 부분문자열만, 읽기전용 1종 confirm 부재 |
| | TRX-13 | P2 | passphrase 소스 메타 override — WORMHOLE_PASSPHRASE_FILE 지정 시 'passphrase 소스: file', env 시 'env' |
| | TRX-14 | P2 | normalizeBaseDir 정규화 — 지저분한 remoteBaseDir('//foo/bar//') 부팅 MKCOL 이 '/foo/bar' 컬렉션 생성 |
| | TRX-15 | P2 | passphraseFile 기본경로 해석 — crypto.passphraseFile='' 이면 <stateDir>/passphrase 로 해석돼 부팅 'file' 소스 |
| **confirm-gate-realwire** | CGW-01 | P0 | wormhole_sync 미리보기 → pull+push 합본 구조 검증 및 와이어 불변 |
| | CGW-02 | P1 | wormhole_resolve confirm:false → 충돌 목록 반환만, 파일 불변 증명 |
| | CGW-03 | P1 | 읽기전용 도구에 confirm 전달 → 와이어 무변경 각도 (범위 축소) |
| | CGW-04 | P1 | confirm:false 연속 후 confirm:true → generation 정확히 +1만 전진 |
| | CGW-05 | P1 | wormhole_sync confirm:true + pull 충돌 시 resolve 자동 개입 검증 |
| | CGW-06 | P1 | wormhole_sync confirm:true 비충돌 발산 실적용 — pull·push 실행, resolve 키 부재 |
| | CGW-07 | P1 | wormhole_sync 미리보기 CORRUPT_REMOTE stop-on-error — pull throw 로 push 미산출, isError |
| **input-schema-zod** | SCH-01 | P0 | wormhole_sync — policy:'manual' 전달 시 zod 거부 (resolve 와 발산) |
| | SCH-02 | P1 | wormhole_resolve — keys 비배열/비문자열 원소 zod 거부 |
| | SCH-03 | P0 | confirm 비불리언 전달 시 모든 confirm 수용 도구에서 zod 거부 |
| | SCH-04 | P2 | wormhole_status 에 추가 프로퍼티 전달 시 통과/무시 여부 확인 |
| | SCH-05 | P1 | wormhole_resolve keys 빈 배열 + confirm:false — dryRun note 확인 |
| | SCH-06 | P1 | tools/list inputSchema JSON Schema 자체 유효성 + drift 감지 (범위 축소) |
| **conflict-policies** | CFL-01 | P0 | 양측 발산 후 wormhole_status 가 conflicts[] 를 완전 구조로 노출 |
| | CFL-02 | P0 | resolve preserve-both confirm:true — conflictCopies 기록, 원본 무변경 |
| | CFL-03 | P0 | resolve latest-wins confirm:true — 원격 우선 채택, backupDir 생성 |
| | CFL-04 | P1 | resolve manual policy — resolved=[], conflictCopies=[], 충돌 잔존 |
| | CFL-05 | P1 | resolve keys 부분집합 — 지정 키만 해소, 나머지 충돌 잔존 |
| | CFL-06 | P1 | resolve policy 생략 시 config.conflictPolicy 기본값 폴백 적용 |
| | CFL-07 | P1 | 삭제 충돌(isDeletionConflict=true) — preserve-both 마커 생성 |
| | CFL-08 | P1 | preserve-both resolve 멱등성 — 2회 실행 시 사본 중복 미생성 |
| **settings-mcp-routing** | SMR-01 | P0 | settings.json 로컬키 push 격리 — 원격 blob 로컬키 누락 확인 |
| | SMR-02 | P0 | ${HOME} 토큰화 왕복 — A 홈경로 토큰 저장, B pull 시 B 홈경로 복원 |
| | SMR-03 | P0 | contentHash 안정성 — push 직후 modified 재분류 부재 (영구 루프 부재) |
| | SMR-04 | P1 | settings.json 3-way 머지 — A 공유키 변경이 B 로컬키 미덮어씀 |
| | SMR-05 | P1 | .mcp.json self 엔트리 머신 간 격리 — B wormhole 엔트리 유지 |
| | SMR-06 | P0 | 비밀 파일 스캔 제외 — credentials/local/token/key 가 push 대상 미포함 |
| | SMR-07 | P2 | 로컬키 전용 컨테이너 빈 껍데기 누출 방지 — mcpServers:{} 미포함 |
| | SMR-08 | P1 | settings.json 공유키 양측 발산 — pull 3-way 가 silent local-wins |
| | SMR-09 | P0 | 악성 원격 blob __proto__/constructor/prototype 페이로드가 pull 경로(detokenize/mergeRecursive/deepAssign) 가드 차단 → Object.prototype 무오염 |
| | SMR-10 | P2 | 로컬 settings.json 파싱실패 push 복원 — JSON.parse 실패 시 원본 바이트로 hash/size |
| | SMR-11 | P2 | pull 로컬 .mcp.json 부재/손상 복구 — localText null 시 원격기반 stableStringify 복구 |
| **tombstone-convergence** | TMB-01 | P0 | 로컬 삭제 → push → PushResult.deleted 기록, generation 전진 |
| | TMB-02 | P0 | A tombstone push 후 B pull → removed, 로컬 삭제, backupDir 생성 |
| | TMB-03 | P1 | 양측 독립 동일콘텐츠 도달 → converged 분류, 전송 없이 watermark 전진 |
| | TMB-04 | P1 | tombstone 후 동일 키 재생성(revive) → push 로 되살리기, generation 전진 |
| | TMB-05 | P1 | tombstone pull 후 재pull 멱등 — removed/applied 빈 배열, backupDir null |
| | TMB-06 | P1 | pull 시 기존 파일 덮어쓰기 — backupDir 내 원본 보존 검증 |
| | TMB-07 | P2 | 양측 동시 삭제 수렴 → status converged, pull/push 모두 전송 없음 |
| | TMB-08 | P1 | pull 다중키 적용 중 한 blob 손상 → all-or-nothing 롤백 (부분 적용 잔존 없이 원복 + isError) |
| **error-lock-cas** | ELC-01 | P0 | READONLY_WEBDAV — ensureDir MKCOL 405 시 부팅 성공·도구 노출 확인 |
| | ELC-02 | P0 | 잘못된 PASSPHRASE — sentinel 복호 실패 → process.exit(1) |
| | ELC-03 | P0 | config.json 부재 — 부팅 크래시 및 에러 메시지 검증 |
| | ELC-04 | P0 | 락 경합 소진 — 동시 push 시 한쪽 acquireRetries=3 소진 후 isError |
| | ELC-05 | P1 | 만료 lock.json 탈취 — TTL 경과 후 CAS putIfMatch 로 락 탈취 성공 |
| | ELC-06 | P1 | NO_ETAG_WEBDAV — best-effort PUT 폴백·CAS 상실 경고 확인 |
| | ELC-07 | P1 | sync stop-on-error — pull 단계 실패 시 push 미실행 및 isError 전파 |
| | ELC-08 | P0 | push manifest CAS 재시도 소진 → ManifestConflictError isError:true 표면화 |
| | ELC-09 | P1 | AsyncMutex 인프로세스 직렬화 — push·pull 무대기 연속 발사 시 순차화·교차손상 없음 |
| | ELC-10 | P0 | config.json 비-ENOENT(깨진 JSON) 래핑 — 'config 파일 읽기 실패' throw·exit≠0·stdout 무오염 |
| | ELC-11 | P1 | 빈 원격 동시 2서버 generation 생성경쟁 — putIfNoneMatch 패자 수렴; NO_ETAG putIfMatch 폴백 warn |
| | ELC-12 | P1 | 부팅 시 파생 age identity 가 derivedKeyPath 에 0600 + 헤더주석으로 캐시되고 AGE-SECRET-KEY-1 본문 포함 |

### 차원별 소계 및 우선순위 집계

| 차원 | 시나리오 수 | P0 | P1 | P2 |
|---|---|---|---|---|
| Transport & Registration | 15 | 3 | 6 | 6 |
| confirm-gate-realwire | 7 | 1 | 6 | 0 |
| input-schema-zod | 6 | 2 | 3 | 1 |
| conflict-policies | 8 | 3 | 5 | 0 |
| settings-mcp-routing | 11 | 5 | 3 | 3 |
| tombstone-convergence | 8 | 2 | 5 | 1 |
| error-lock-cas | 12 | 6 | 6 | 0 |
| **합계** | **67** | **22** | **34** | **11** |

---

## 6. 시나리오 상세

### 6.1 Transport & Registration

> **차원 개요**: MCP stdio 전송 경계에서 서버를 블랙박스로 관측한다. `tools/list` 응답의 도구 수·name·inputSchema JSON Schema 정합성, server name/version 문자열, stdout 의 MCP 프레이밍 순수성, SIGINT/SIGTERM graceful shutdown, `buildEngine` 이 도구 호출 전 원격 MKCOL 부수효과를 완료함을 PROPFIND 로 블랙박스 관측한다.

#### TRX-01 · tools/list — 정확히 3개 도구 이름·inputSchema 계약 검증  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 WebDAV 서버(dufs/Caddy) 기동, 쓰기 가능
  - `~/.wormhole/config.json` 유효, `WEBDAV_URL`/`USER`/`PASS`/`WORMHOLE_PASSPHRASE` 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료
- **대상 도구**: (MCP 프로토콜 자체) initialize + tools/list
- **절차**:
  1. `STDIO_RPC_CLIENT` 로 `server.mjs` 를 node 로 기동 (`node plugin/dist/server.mjs`)
  2. JSON-RPC 요청 전송: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}`
  3. JSON-RPC 요청 전송: `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
  4. 응답 `tools` 배열을 파싱해 name 목록 추출
  5. 각 도구의 `inputSchema` 를 JSON Schema 로 파싱하고 필수/선택 파라미터 타입 확인
  6. server 메타(initialize 응답의 `serverInfo`)에서 name/version 필드 추출
- **기대 결과**:
  - `tools` 배열 길이 == 3
  - name 집합 == `{"wormhole_status","wormhole_resolve","wormhole_sync"}`
  - `wormhole_status.inputSchema`: properties 없음 또는 빈 object (파라미터 없음)
  - `wormhole_resolve.inputSchema`: `{policy: enum 3종 optional, keys: array optional, confirm: boolean optional}`
  - `wormhole_sync.inputSchema`: `{policy: enum 2종("preserve-both","latest-wins") optional, confirm: boolean optional}` — `"manual"` 없음
  - `serverInfo.name == "wormhole"`, `serverInfo.version == "0.1.1"` (package.json 불일치 관측)
- **합격 기준**:
  - `tools` 배열 길이 정확히 3
  - 3개 도구명 집합 일치 (누락·추가 없음)
  - `wormhole_sync.inputSchema` 에 `"manual"` 이 없음 (wormhole_resolve 와 발산하는 의도적 제한)
  - `serverInfo.version` 이 `"0.1.1"` 임 (코드 불일치 탐지)
  - `wormhole_status` inputSchema 가 파라미터 없음 계약 유지
- **신선도**: (a) mock 단위테스트는 registerTool 호출을 직접 검증하지만 실제 MCP 프로토콜 직렬화·tools/list 응답 포맷은 검증하지 않았고, (b)(c) 는 tools/list 를 전혀 호출하지 않았다.
- **자동화 힌트**: `npx @modelcontextprotocol/inspector --cli node plugin/dist/server.mjs --method tools/list` 의 JSON 출력을 jq 로 파싱하거나, 자체 stdio JSON-RPC 하네스로 응답을 assert 한다.

#### TRX-02 · stdout 순수성 — 로그가 stderr 로만 나오고 MCP 프레임 외 stdout 오염 없음  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 WebDAV 서버 기동
  - `~/.wormhole/config.json` 유효, 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료, `WORMHOLE_LOG_LEVEL=debug` 설정
- **대상 도구**: (MCP 전송 계층) StdioServerTransport
- **절차**:
  1. `node plugin/dist/server.mjs` 기동 시 stdout 과 stderr 를 분리 캡처 (stdout → stdout.log, stderr → stderr.log)
  2. initialize 핸드셰이크 + tools/list 전송
  3. `wormhole_status` 도구 호출: `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wormhole_status","arguments":{}}}`
  4. 서버 응답 수신 후 프로세스 종료
  5. stdout.log 에서 줄바꿈 구분 JSON 메시지 파싱 외 나머지 바이트 검사
  6. stderr.log 에서 `[INFO]`/`[DEBUG]`/`[WARN]`/`[ERROR]` 패턴 검사
- **기대 결과**:
  - stdout.log 는 줄바꿈 구분 JSON-RPC 메시지(한 줄당 한 메시지)만 포함
  - stdout.log 에 `[INFO]`, `[DEBUG]`, `[WARN]`, `[ERROR]` 패턴 없음
  - stderr.log 에 `"machine id:"`, `"age 키 준비 완료"`, `"MCP 서버 연결됨"` 등 부트스트랩 로그 존재
  - stdout 의 모든 청크가 유효한 JSON-RPC 2.0 메시지로 파싱됨
- **합격 기준**:
  - stdout 각 줄을 JSON-RPC 메시지로 파싱 시 에러 없음
  - stdout 에서 console.error 이외 경로로 나온 텍스트(로그 문자열) 0건
  - stderr 에 부트스트랩 로그 1건 이상 존재 (logger 가 stderr 로 라우팅됨 확인)
- **신선도**: (a)(b)(c) 어느 것도 stdout/stderr 분리를 실제 프로세스 레벨에서 캡처해 검증하지 않았다.
- **자동화 힌트**: `node plugin/dist/server.mjs 1>stdout.log 2>stderr.log` 로 기동 후 stdout.log 각 줄을 JSON.parse 로 처리, `grep -P '[^\x00-\x7F]|\[INFO\]|\[DEBUG\]' stdout.log` 로 오염 검사.

#### TRX-03 · 부팅 시 MKCOL 부수효과 — 도구 호출 전에 원격 디렉터리가 생성됨을 PROPFIND 로 관측  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 초기 상태가 완전히 빈 원격 저장소 (remoteBaseDir 와 blobs 디렉터리 미존재)
  - `~/.wormhole/config.json` 유효, `WEBDAV_URL`/`USER`/`PASS`/`WORMHOLE_PASSPHRASE` 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료
- **대상 도구**: (buildEngine 부트스트랩) remote.ensureDir — 도구 호출 전 부수효과
- **절차**:
  1. 서버 기동 전 PROPFIND `{remoteBaseDir}` 로 디렉터리 미존재 확인 (404 응답 기대)
  2. `node plugin/dist/server.mjs` 기동
  3. initialize 핸드셰이크만 수행 (tools/call 없음)
  4. 서버가 initialize 응답을 반환하는 즉시 (tools/list 호출 전) PROPFIND `{remoteBaseDir}` 전송
  5. PROPFIND `{remoteBaseDir}/blobs` 전송
  6. 서버 프로세스 종료
- **기대 결과**:
  - 3단계(initialize 직후): PROPFIND `{remoteBaseDir}` → 207 Multi-Status (컬렉션 존재)
  - PROPFIND `{remoteBaseDir}/blobs` → 207 Multi-Status
  - 어떤 tools/call 도 없었음에도 MKCOL 이 buildEngine 내 ensureDir 에서 완료됨
- **합격 기준**:
  - initialize 응답 수신 시점에 이미 remoteBaseDir 가 PROPFIND 로 확인됨 (207)
  - remoteBaseDir/blobs 도 동일하게 존재 확인
  - 이 시점까지 tools/call 이 단 한 건도 없었음 (부팅 부수효과가 도구 경계 이전에 발생함을 블랙박스 증명)
- **신선도**: (b) e2e 는 buildEngine 을 직접 호출하므로 MCP initialize 핸드셰이크와의 타이밍 관계를 관측하지 않았고, (a)(c) 는 이 부수효과를 전혀 다루지 않았다.
- **자동화 힌트**: `curl -X PROPFIND` 로 204/207 여부를 확인. 서버 기동과 PROPFIND 사이에 짧은 폴링(200ms 간격, 최대 5초)으로 initialize 응답 후 즉시 검사.

#### TRX-04 · initialize capabilities — 서버가 반환하는 capabilities 구조 계약 검증  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 WebDAV 서버 기동
  - `~/.wormhole/config.json` 유효, 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료
- **대상 도구**: (MCP 프로토콜) initialize 핸드셰이크
- **절차**:
  1. `STDIO_RPC_CLIENT` 로 `server.mjs` 기동
  2. JSON-RPC 전송: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-harness","version":"0.0.1"}}}`
  3. 응답의 result 필드 파싱
  4. `result.serverInfo`, `result.capabilities`, `result.protocolVersion` 필드 검사
  5. initialized notification 전송: `{"jsonrpc":"2.0","method":"notifications/initialized"}`
  6. tools/list 로 정상 동작 확인
- **기대 결과**:
  - `result.serverInfo.name == "wormhole"`
  - `result.serverInfo.version == "0.1.1"`
  - `result.protocolVersion == "2024-11-05"` (또는 SDK 가 협상한 버전)
  - `result.capabilities.tools` 객체 존재 (tools 기능 광고)
  - `result.capabilities.resources` 또는 `result.capabilities.prompts` 는 없거나 빈 객체 (wormhole 은 tools 만 등록)
  - initialized 후 tools/list 정상 응답
- **합격 기준**:
  - `serverInfo.name`/`version` 계약값 일치 — `name === "wormhole"`, `version === "0.1.1"` (package.json 0.1.3 과 의도적 불일치 기록), `capabilities.tools` 존재 (critic 교정 반영)
  - `protocolVersion` 이 유효한 MCP 버전 문자열
  - **(완화)** initialize 이전 tools/list 의 `-32002 ServerNotInitialized` 단언은 MCP SDK(Server/StdioServerTransport) 구현 의존이라 wormhole `index.ts` 가 직접 보장하지 않으므로 pass/fail 에서 제거하고, "핸드셰이크 순서 강제 여부를 관측·기록(문서화 목적)" 으로 강등한다 (critic 교정 반영)
- **신선도**: (a)(b)(c) 모두 MCP initialize 핸드셰이크를 실제 프로토콜 레벨에서 검증하지 않았다.
- **자동화 힌트**: MCP Inspector CLI (`--method initialize`) 또는 자체 stdio 하네스로 응답 JSON 을 assert.

#### TRX-05 · SIGINT graceful shutdown — 진행 중 tools/call 없이 SIGINT 수신 시 process.exit(0) 확인  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 WebDAV 서버 기동
  - `~/.wormhole/config.json` 유효, 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료
- **대상 도구**: (index.ts) SIGINT 핸들러 → server.close() → process.exit(0)
- **절차**:
  1. `node plugin/dist/server.mjs` 기동, PID 캡처
  2. initialize 핸드셰이크 완료
  3. tools/list 호출로 정상 상태 확인
  4. `kill -SIGINT {PID}` 전송
  5. 프로세스 종료 코드 캡처
  6. stderr 로그에서 종료 메시지 확인
- **기대 결과**:
  - 프로세스 종료 코드 == 0
  - stderr 에 `"SIGINT 수신"` 또는 `"종료 중"` 포함
  - stdout 에 추가 JSON-RPC 메시지 없음 (깨진 프레임 없음)
  - server.close() 이후 추가 도구 호출 불가 (연결 종료)
- **합격 기준**:
  - exit code 0 (비정상 종료 아님)
  - SIGTERM 동일 검사: `kill -SIGTERM` 시에도 exit 0
  - 이중 SIGINT (shuttingDown 가드): 두 번째 SIGINT 가 중복 close() 없이 처리됨
  - stderr 종료 로그 1건 이상
- **신선도**: (a)(b)(c) 어느 것도 SIGINT/SIGTERM 핸들러를 실제 프로세스 시그널로 검증하지 않았다.
- **자동화 힌트**: Node `child_process.spawn` 으로 기동 후 `process.kill(pid, 'SIGINT')`, `child.exitCode` 를 assert. Windows 에서는 SIGINT 대신 `taskkill /PID` 또는 `process.kill` 사용.

#### TRX-06 · 부팅 실패 경로 — config.json 없음 시 stderr 에러 로그 후 exit(1), stdout 오염 없음  `P1`

- **전제조건**:
  - `~/.wormhole/config.json` 이 존재하지 않는 격리 환경 (`WORMHOLE_CONFIG` 로 존재하지 않는 경로 지정)
  - `plugin/dist/server.mjs` 빌드 완료
  - WebDAV 접근 불필요 (부트스트랩 전 단계에서 실패)
- **대상 도구**: (main → buildEngine → loadConfig) 부팅 실패 경로
- **절차**:
  1. `WORMHOLE_CONFIG=/nonexistent/config.json node plugin/dist/server.mjs` 기동, stdout·stderr 분리 캡처
  2. 프로세스 종료 대기 (타임아웃 5초)
  3. 종료 코드 확인
  4. stderr 내용 확인
  5. stdout 내용 확인
- **기대 결과**:
  - 프로세스 종료 코드 == 1
  - stderr 에 `"치명적 부트스트랩 오류"` 포함, config.json 없음 메시지 포함
  - stdout 가 완전히 비어 있음 (MCP 프레이밍 없음, 로그 없음)
  - 어떤 JSON-RPC 응답도 stdout 에 없음
- **합격 기준**:
  - exit code 1
  - stdout 바이트 수 == 0 (오염 없음)
  - stderr 에 스택 트레이스 또는 오류 메시지 1건 이상
  - MCP 클라이언트가 연결을 시도했다면 EOF 를 받음 (stdout 빈 채로 닫힘)
- **신선도**: (a) mock 은 engine 이 이미 조립된 상태에서 도구 레이어를 검증하므로 부트스트랩 실패 경로를 전혀 다루지 않았고, (b)(c) 도 동일하다.
- **자동화 힌트**: `WORMHOLE_CONFIG` 환경변수로 없는 경로를 지정해 기동, `child.exitCode` 와 stdout 버퍼 길이를 assert.

#### TRX-07 · 잘못된 inputSchema 인자 — zod 거부 시 isError 응답이 MCP 프레임 내에서 반환됨  `P2`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 WebDAV 서버 기동
  - `~/.wormhole/config.json` 유효, 환경변수 설정
  - `plugin/dist/server.mjs` 빌드 완료, initialize 완료
- **대상 도구**: `wormhole_sync` (confirm 필수), `wormhole_resolve` (policy enum 제한)
- **절차**:
  1. initialize + tools/list 완료
  2. tools/call 전송: `{"name":"wormhole_sync","arguments":{}}` — confirm 누락
  3. 응답 파싱, isError 확인
  4. tools/call 전송: `{"name":"wormhole_sync","arguments":{"confirm":"yes"}}` — boolean 외 값
  5. 응답 파싱
  6. tools/call 전송: `{"name":"wormhole_resolve","arguments":{"policy":"manual","confirm":true}}` — policy=manual 은 resolve 에서 허용됨 확인 (wormhole_sync 에는 없는 값)
  7. 응답이 줄바꿈 구분 JSON 메시지로 정상 파싱되는지 확인 (stdout 프레임 유지)
- **기대 결과**:
  - confirm 누락: `isError:true`, content[0].text 에 zod 검증 오류 메시지 또는 MCP 프로토콜 수준 InvalidParams 에러
  - confirm="yes"(string): 동일하게 에러 응답
  - `wormhole_resolve` policy=manual: isError 없이 정상 응답 (resolve 는 manual 허용)
  - 모든 에러 응답이 유효한 JSON-RPC 2.0 응답 프레임 내에 있음 (stdout 프레임 깨지지 않음)
- **합격 기준**:
  - 에러 응답이 `{"jsonrpc":"2.0","id":N,"result":{"isError":true,...}}` 또는 `{"error":{"code":-32602,...}}` 형식
  - stdout 줄 단위 JSON 파서가 에러 응답 후에도 계속 파싱 가능 (연결 유지)
  - `wormhole_resolve` 의 manual 정책이 정상 처리됨 (wormhole_sync 와 enum 발산이 의도적임 확인)
  - 에러 후에도 다음 tools/call 이 정상 동작 (스테이트리스 핸들러 확인)
- **신선도**: (a) mock 단위테스트는 zod 거부를 직접 호출로 검증하지만 실제 MCP 프로토콜 프레임 내 전달 및 연결 유지 여부는 검증하지 않았다.
- **자동화 힌트**: stdio JSON-RPC 하네스로 순차 요청 전송, 각 응답을 줄 단위 JSON 으로 파싱해 프레임 무결성 assert.

#### TRX-08 · WEBDAV_USER 부재 + remote.remoteBaseDir 미설정 시 부팅 halt (stdout 무오염)  `P0`

> gaps 패치 신규 시나리오 — transport-registration 차원 보강.

- **전제조건**:
  - `~/.wormhole/config.json` 존재(필수 충족)하되 `remote.remoteBaseDir` 미설정
  - `~/.wormhole/.env` 또는 `process.env` 에 `WEBDAV_USER` 미설정(빈 문자열)
  - `WEBDAV_URL`/`WEBDAV_PASS`/`WORMHOLE_PASSPHRASE` 는 정상 설정(USER 가드만 단독 트리거)
  - `STDIO_RPC_CLIENT` 로 `server.mjs` 기동, stdout/stderr 분리 캡처
- **대상 도구**: (main → buildEngine → loadConfig) 부팅 실패 경로
- **절차**:
  1. `server.mjs` 를 stdio 로 spawn
  2. `loadConfig`(config.ts)가 `remoteUsername=(username??'').trim()===''`(line 317) 및 remoteBaseDir 미설정 감지
  3. `config.ts:320-321` `throw new Error('WEBDAV_USER 가 필요함 ...')` 발생
  4. buildEngine 부팅 실패 → 프로세스 비정상 종료(exit 비0), MCP 핸드셰이크 미도달
  5. stdout 캡처 검사(MCP JSON-RPC 프레임 외 어떤 바이트도 없어야 함)
- **기대 결과**:
  - 프로세스가 initialize 응답 전에 종료(exit code !== 0)
  - stderr 에 `'WEBDAV_USER 가 필요함 (remote base 경로를 USER 에서 도출)'` 메시지 출력
  - stdout 은 완전히 비어 있음(에러/로그 누출 0) — stdout MCP 전송 전용 규약 유지
  - tools/list 호출 자체가 불가(transport 미수립)
- **합격 기준**:
  - exit code 비0(부팅 halt)
  - stderr 에 정확한 가드 메시지 문자열 존재
  - stdout 바이트 길이 0(또는 JSON-RPC 외 비-프레임 0) — stdout 오염 부재 단언
  - `remoteBaseDir = WEBDAV_URL + '/' + USER` 자동파생의 USER 필수 전제가 도구경계서 실증됨
- **신선도**: ELC-02(passphrase)/ELC-03(config 부재)와 다른 부팅 실패 경로. deriveRemoteBaseDir 설계의 USER 필수 가드(config.ts 317-321) 미답 칸. stdout 무오염은 (b) 와이어 누출검사와 다른 transport 규약 각도.

#### TRX-09 · .env 로더 host-우선 override — MCP 호스트 주입 env 가 ~/.wormhole/.env 보다 우선  `P2`

- **갭 클로저**: F-CONFIG-04 — loadDotEnvIntoProcess 가 이미 존재하는 process.env 키를 덮지 않음(host env 우선)을 부팅 산출물로 관측
- **전제조건**:
  - WRITABLE_WEBDAV: 쓰기 가능한 WebDAV 엔드포인트(MKCOL/PROPFIND 허용)
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR: server.mjs 를 stdio JSON-RPC 로 스폰
  - ~/.wormhole/config.json 존재(remote.url 만 채워지고 remote.username 은 비움/생략 → username 은 WEBDAV_USER env 로 주입)
  - ~/.wormhole/.env 에 WEBDAV_USER=fileval 한 줄 작성
  - config.json 에 remoteBaseDir 미지정(공백/없음) — baseDir 가 username 에서 도출되도록
- **대상 도구**: `wormhole_status`
- **절차**:
  1. ~/.wormhole/.env 에 'WEBDAV_USER=fileval' 작성. config.json 의 remote.username 은 비우고 remote.remoteBaseDir 미지정.
  2. server.mjs 를 spawn 하되 프로세스 env 에 WEBDAV_USER=hostval, WEBDAV_URL=<엔드포인트>, WEBDAV_PASS=<pw>, WORMHOLE_PASSPHRASE=<pp> 주입(STDIO_RPC_CLIENT).
  3. 부팅 완료(initialize handshake 성공)까지 대기. buildEngine 단계 2-3 에서 remote.ensureDir(config.remote.remoteBaseDir) 가 MKCOL 호출함.
  4. 동일 자격으로 별도 WebDAV 클라이언트(curl PROPFIND Depth:1)로 원격 루트를 조회해 MKCOL 로 생성된 컬렉션 경로를 관측.
  5. 대조: PROPFIND 로 '/hostval' 컬렉션이 생성됐고 '/fileval' 은 없음을 확인.
  6. tools/call wormhole_status {} 호출(부팅이 hostval baseDir 로 정상 동작했는지 추가 확인).
- **기대 결과**:
  - loadDotEnvIntoProcess line 152: process.env['WEBDAV_USER'] 가 이미 'hostval' 로 정의돼 있어 'fileval' 로 덮어쓰지 않음
  - applyEnvOverrides line 164: remote.username = process.env['WEBDAV_USER'] = 'hostval'
  - deriveRemoteBaseDir('', 'hostval') → normalizeBaseDir('hostval') → '/hostval'
  - PROPFIND 결과: 부팅 MKCOL 이 '/hostval' 및 '/hostval/blobs' 컬렉션 생성(bootstrap.ts line 42-43)
  - wormhole_status 는 isError 없이 structuredContent 반환(hostval baseDir 로 부팅 성공)
- **합격 기준**:
  - PROPFIND 응답에 '/hostval' 컬렉션 존재 AND '/fileval' 컬렉션 부재
  - wormhole_status 응답이 isError:true 가 아님
  - stdout 에는 JSON-RPC 프레임만 존재(로그 오염 없음)
- **신선도**: 기존 54 는 정상 단일 env 소스만 다뤘고 (a)(b)(c) 는 host-vs-file 충돌 우선순위를 검증하지 않음 — 본 시나리오는 host env 와 .env 파일이 동일 키를 동시에 정의했을 때의 override 방향을 부팅 MKCOL 위치로 관측한다.
- **자동화 힌트**: spawn 시 env 두 소스 셋업 후 PROPFIND diff. 도구 호출 1회로 충분.

#### TRX-10 · .env 파서 견고성 — 따옴표 strip·인라인 # 보존·전체줄 주석 무시·ENOENT silent skip  `P2`

- **갭 클로저**: F-CONFIG-02/03/05 — loadDotEnvIntoProcess 파싱 규칙(따옴표 1쌍 1회 제거, 트레일링 # 값 보존, 전체줄 주석 skip, 파일 부재 silent) 을 도출 config 로 관측
- **전제조건**:
  - WRITABLE_WEBDAV: 쓰기 가능 엔드포인트
  - STDIO_RPC_CLIENT: server.mjs stdio 스폰
  - 프로세스 env 에 WEBDAV_URL/USER/PASS 미주입(파일값이 적용되도록) — 단 WORMHOLE_PASSPHRASE 만 부팅용으로 주입
  - config.json 은 remote 비움(전부 .env 로 채움)
- **대상 도구**: `wormhole_status`
- **절차**:
  1. ~/.wormhole/.env 작성: 'WEBDAV_URL="<엔드포인트>"' (양끝 큰따옴표), 'WEBDAV_USER=user#tag' (인라인 트레일링 #), '# 전체줄 주석' 라인, 빈 줄, 'WEBDAV_PASS=pw'.
  2. host env 에는 WEBDAV_URL/USER/PASS 를 넣지 않고 WORMHOLE_PASSPHRASE 만 주입한 채 server.mjs spawn.
  3. 부팅 → applyEnvOverrides 가 .env 주입값으로 remote 채움 → MKCOL 위치는 '/user#tag' (트레일링 # 보존).
  4. PROPFIND Depth:1 로 생성 컬렉션 경로 관측(URL 의 따옴표가 strip 됐는지=요청이 정상 URL 로 나갔는지, username 의 # 보존됐는지).
  5. wormhole_status {} 호출해 isError 없이 응답하는지 확인(URL 따옴표가 strip 안 됐으면 잘못된 URL 로 부팅 실패했을 것).
  6. 2차: ~/.wormhole/.env 를 삭제 후 동일 env(WEBDAV_* 전부 host 주입)로 재스폰 → ENOENT silent skip 으로 정상 부팅 확인.
- **기대 결과**:
  - line 143-149: WEBDAV_URL 값 양끝 동일 큰따옴표 1쌍 제거 → 순수 URL(따옴표 없음)로 remote.url 설정
  - line 134: '# 전체줄 주석' 라인은 startsWith('#') 으로 skip, 빈 줄도 skip
  - 인라인 #: 'user#tag' 는 '#' 가 line 시작이 아니므로 값에 보존(인라인 주석 제거 로직 없음) → username='user#tag'
  - MKCOL/PROPFIND: 컬렉션 '/user#tag' 생성(deriveRemoteBaseDir → normalizeBaseDir('user#tag'))
  - 2차: .env 부재 시 line 128 ENOENT return 으로 throw 없이 부팅 성공
  - wormhole_status: isError 없이 structuredContent 반환
- **합격 기준**:
  - PROPFIND 응답에 '/user#tag' 컬렉션 존재(따옴표 strip 된 URL 로 요청 성공 + # 보존 동시 입증)
  - wormhole_status 응답 isError:true 아님
  - 2차(.env 삭제) 스폰도 부팅 성공 — initialize handshake 정상, status 호출 가능
  - stdout JSON-RPC 프레임만(파서 경고/오류가 stdout 오염 없음)
- **신선도**: 기존 54 및 (a)(b)(c) 는 잘 형성된 .env 만 가정했고 따옴표/인라인#/주석/파일부재 같은 파서 엣지를 다루지 않음 — 본 시나리오는 4가지 파싱 규칙을 한 .env 에 모아 도출 config(원격 URL/USER) 의 실제 파싱 결과로 회귀 감지한다.
- **자동화 힌트**: 동일 .env 에 4 케이스 동봉 후 PROPFIND 1회 + status 1회. 2차는 .env 삭제 재스폰. username 의 '#' 는 원격 컬렉션 경로에서 URL-encode(%23)될 수 있음 — PROPFIND 매칭 시 인코딩/디코딩 양형 허용. (critic 교정 반영)

#### TRX-11 · 평문 http 경고 — non-localhost http URL 부팅 시 stderr 경고 1회, localhost 는 무경고  `P1`

- **갭 클로저**: F-CONFIG-17 — buildEngine 의 평문 http 감지 분기(/^http:\/\//i AND NOT localhost/127./[::1])가 logger.warn 을 stderr 로 1회 방출하고 stdout 미오염임을 관측
- **전제조건**:
  - WRITABLE_WEBDAV: http(평문) non-localhost 엔드포인트(예: http://nas.example/)에서 MKCOL/PROPFIND 가능 — 또는 부팅 단계 4 이전(MKCOL 단계)까지만 도달해도 경고는 단계 1 이후 즉시 방출됨
  - STDIO_RPC_CLIENT: server.mjs spawn 시 stdout 과 stderr 를 분리 캡처
  - WEBDAV_URL 을 평문 http non-localhost 로 주입, WEBDAV_USER/PASS/WORMHOLE_PASSPHRASE 주입
- **대상 도구**: `wormhole_status`
- **절차**:
  1. server.mjs 를 spawn(env: WEBDAV_URL=http://nas.example/ , WEBDAV_USER=u, WEBDAV_PASS=p, WORMHOLE_PASSPHRASE=pp). stdout/stderr 별도 파이프.
  2. 부팅 진행 중 buildEngine line 27-34 의 평문 http 분기가 logger.warn 호출(machineId 로드 전, config 로드 직후).
  3. stderr 캡처에서 '평문 http' 경고 문자열 출현 횟수 카운트.
  4. stdout 캡처에 경고 문자열이 섞이지 않았는지 확인(MCP 전용).
  5. 대조: WEBDAV_URL=http://localhost:8080/ 로 동일 spawn → stderr 에 평문 http 경고 부재 확인.
  6. (가능 시) initialize 후 wormhole_status {} 호출로 부팅 자체는 정상 진행됐는지 확인.
- **기대 결과**:
  - stderr 에 'WebDAV URL 이 평문 http 임 — Tailscale 등 암호화 전송이 아니면 자격증명 노출 위험. https 권장.' 정확히 1회
  - 정규식: /^http:\/\//i.test(url)=true AND /^http:\/\/(localhost|127\.|\[::1\])/i.test(url)=false 일 때만 warn(bootstrap.ts line 28-29)
  - localhost 대조: http://localhost 는 두번째 정규식 매치 → warn 미호출(경고 0회)
  - stdout 에는 JSON-RPC 프레임만 — '평문 http' 문자열 0회
  - logger.warn 은 stderr 채널로 출력(index.ts 주석: stdout=MCP 전용)
- **합격 기준**:
  - non-localhost http: stderr 경고 정확히 1회(2회 이상이면 fail)
  - stdout 에 '평문 http' 문자열 0회
  - localhost http 대조: stderr 경고 0회
  - 경고 문자열이 코드의 정확한 문구와 일치(문구 drift 시 fail)
- **신선도**: 기존 54 및 (a)(b)(c) 는 https 정상 부팅만 다뤘고 평문 http 보안 경고 채널(stderr)과 localhost 예외 분기를 검증하지 않음 — 본 시나리오는 경고 1회·정확 문구·stdout 무오염·localhost 무경고를 동시에 단언한다.
- **자동화 힌트**: stdout/stderr 분리 캡처가 핵심. non-localhost vs localhost 2회 spawn 비교.

#### TRX-12 · tools/list description 와이어 계약 정밀화 — 쓰기 2종 confirm 안전문구 1개 부분문자열만, 읽기전용 1종 confirm 부재  `P1`

- **갭 클로저**: universeGap(description) — F-WIRE description drift 회귀. tools/list 와이어로 노출되는 3개 도구 description 의 confirm 안전 가이드 문구 존재/부재를 코드 대조 정확값으로만 단언해 거짓양성(과도 부분문자열) 제거
- **전제조건**:
  - WRITABLE_WEBDAV 또는 READONLY_WEBDAV: 부팅 성공만 필요(tools/list 는 엔진 동작 무관, 도구 등록만 요구)
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR(--cli): tools/list 호출 가능
  - 정상 config + passphrase 로 buildEngine 성공 → registerAllTools 가 3개 도구 등록 완료
- **대상 도구**: `wormhole_status`, `wormhole_resolve`, `wormhole_sync`
- **절차**:
  1. server.mjs(plugin/dist/server.mjs) 를 child_process.spawn 으로 기동.
  2. stdin: initialize → initialized notification 전송.
  3. tools/list 요청 전송: {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}} (또는 mcp-inspector --cli tools/list).
  4. 응답 result.tools[] 에서 3개 도구의 name/description 추출(title 은 부정밀 신호이므로 단언 대상에서 제외 — name+description 만).
  5. tools[] 길이가 정확히 3 이고 name 집합이 {wormhole_status, wormhole_resolve, wormhole_sync} 임을 단언.
  6. 쓰기 2종(resolve/sync) 각 description 이 부분문자열 '절대 자율적으로 confirm:true 를 넘기지 않는다.' 를 포함함을 단언(이 1개 부분문자열만 — 2차 부분문자열 '안전 기본값: ...' 단언은 제거).
  7. wormhole_resolve description 만 추가로 부분문자열 'keys 생략 시 전체 충돌 처리.' 포함을 단언.
  8. 읽기전용 1종(status) description 이 부분문자열 'confirm' 을 포함하지 않음을 단언(대소문자 그대로의 'confirm').
- **기대 결과**:
  - result.tools[] 길이 = 3, name 집합 = {wormhole_status, wormhole_resolve, wormhole_sync}
  - wormhole_resolve.description = '충돌 항목을 지정한 정책으로 해소한다. keys 생략 시 전체 충돌 처리. 안전 기본값: ... — 절대 자율적으로 confirm:true 를 넘기지 않는다.' (src/tools/resolve.ts:12-13) → '절대 자율적으로 confirm:true 를 넘기지 않는다.' 및 'keys 생략 시 전체 충돌 처리.' 둘 다 포함
  - wormhole_sync.description (src/tools/sync.ts:15-16) → '절대 자율적으로 confirm:true 를 넘기지 않는다.' 포함
  - wormhole_status.description = '현재 동기화 상태를 조회한다(읽기 전용, 변경 없음). 로컬/원격 diff·충돌·집계를 반환.' (src/tools/status.ts:11-12) → 'confirm' 문자열 부재
- **합격 기준**:
  - 쓰기 2종 description 2/2 가 '절대 자율적으로 confirm:true 를 넘기지 않는다.' 포함
  - wormhole_resolve description 이 추가로 'keys 생략 시 전체 충돌 처리.' 포함(sync 는 이 문구 비포함)
  - 읽기전용 1종 description 이 부분문자열 'confirm' 미포함
  - tools 개수 정확히 3(추가/누락 시 fail), name 집합 정확 일치
  - 제거 확인: 과도한 2차 부분문자열 단언과 title 정확값 단언은 본 정밀화에서 단언 대상이 아님(거짓양성 회피)
- **신선도**: 기존 TRX-12 본문은 쓰기 4종에 confirm 안전문구 2개(주 문구 + 2차 부분문자열)를 모두 단언하고 6개 title 정확값까지 단언했다. 도구 표면이 3종으로 축소됐으므로 코드 대조(resolve.ts:13 / sync.ts:16 / status.ts:12) 로 핵심 계약 부분문자열만 정밀 단언: 쓰기 2종 공통 1개('절대 자율적으로 confirm:true 를 넘기지 않는다.'), resolve 전용 1개('keys 생략 시 전체 충돌 처리.'), 읽기전용 1종 'confirm' 부재.
- **자동화 힌트**: tools/list 1회 호출로 3개 description 추출 후 핵심 부분문자열 단언만. 엔진 실행 불필요. title 비교·2차 부분문자열 비교 코드는 삭제.

---

#### TRX-13 · passphrase 소스 메타 override — WORMHOLE_PASSPHRASE_FILE 지정 시 부팅 stderr 'passphrase 소스: file', env 설정 시 'passphrase 소스: env'  `P2`

- **갭 클로저**: F-CONFIG-10 passphrase 소스메타 override (passphraseFile + keychainService 양 env override). applyEnvOverrides(config.ts:171) 가 WORMHOLE_PASSPHRASE_FILE→crypto.passphraseFile, (config.ts:172) 가 WORMHOLE_KEYCHAIN_SERVICE→crypto.keychainService 를 오버라이드하고, resolvePassphrase 우선순위(env>file>keychain)가 source 를 결정·최종 throw 메시지에 keychainService 를 노출함을 bootstrap.ts:54 / 부팅 throw stderr 로 블랙박스 증명
- **전제조건**:
  - WRITABLE_WEBDAV 또는 READONLY_WEBDAV: buildEngine 성공 필요(resolvePassphrase 는 bootstrap 5단계, ensureCryptoReady 전)
  - STDIO_RPC_CLIENT: server.mjs spawn 후 stderr 캡처 가능(stdout 은 MCP 전용, 로그는 stderr)
  - 정상 config.json(remote.username 존재로 remoteBaseDir 도출 가능) — config L317-323 가드 통과
  - config.crypto.passphraseEnv 기본 'WORMHOLE_PASSPHRASE'(config.ts:56), passphraseFile 기본 ''(config.ts:58)
- **대상 도구**: `buildEngine(부팅 부수효과)`, `wormhole_status`
- **절차**:
  1. [케이스 A — file 소스] 임시 파일 `<tmp>/pass.txt` 에 passphrase 한 줄 기록 후 POSIX 면 chmod 0600.
  2. 환경: WORMHOLE_PASSPHRASE 미설정(unset), WORMHOLE_PASSPHRASE_FILE=`<tmp>/pass.txt` 설정, 그 외 정상 WEBDAV_* 설정.
  3. server.mjs spawn → initialize handshake → stderr 스트림 전량 캡처.
  4. tools/call wormhole_status {} 1회 호출(부팅 완료 보장 및 정상 동작 확인).
  5. stderr 에서 'passphrase 소스: ' 로 시작하는 라인 추출.
  6. [케이스 B — env 소스, 대조] 동일 config·동일 passphraseFile 파일 유지, WORMHOLE_PASSPHRASE=`<원문 passphrase>` 추가 설정.
  7. server.mjs 재기동 → initialize → stderr 캡처 → wormhole_status {} 호출.
  8. stderr 의 'passphrase 소스: ' 라인 추출.
  9. [케이스 C — keychainService env override, 부팅 throw] env 패스프레이즈 미설정(WORMHOLE_PASSPHRASE unset) + passphrase 파일 부재(케이스 A/B 의 `<tmp>/pass.txt` 제거 또는 미배치) + config.crypto.passphraseFile='' 로 두고 WORMHOLE_KEYCHAIN_SERVICE=`wormhole-test` 설정. 비-Linux(secret-tool 부재) 또는 secret-tool 미등록 환경에서 server.mjs spawn → initialize 시도 → stderr 전량 캡처.
  10. resolvePassphrase 가 env>file>keychain 모든 소스 실패 → 부팅 throw → stderr 의 throw 에러 메시지 라인 추출(exit code 도 함께 수집).
- **기대 결과**:
  - 케이스 A: WORMHOLE_PASSPHRASE 미설정이라 resolvePassphrase(passphrase.ts:35-39) 의 env 분기 skip → readPassphraseFile(passphrase.ts:41) 가 `<tmp>/pass.txt` 첫 비주석·비공백 라인 반환 → source='file'
  - 케이스 A: bootstrap.ts:54 logger.info(`passphrase 소스: ${source}`) → stderr 에 정확히 'passphrase 소스: file' 포함 라인 1개
  - 케이스 A: wormhole_status 응답 isError 부재(부팅 정상 완료)
  - 케이스 B: WORMHOLE_PASSPHRASE 설정으로 resolvePassphrase env 분기(passphrase.ts:36) 우선 적중 → source='env'
  - 케이스 B: stderr 에 정확히 'passphrase 소스: env' 포함 라인(file 아님) — env>file 우선순위 입증
  - 케이스 C: env·file·keychain 모든 소스 실패로 resolvePassphrase 가 throw → 부팅 실패. throw 메시지(passphrase.ts:56-60)는 keychainService 설정 시에만 `keychain service ${cfg.keychainService}` 절을 덧붙이므로, WORMHOLE_KEYCHAIN_SERVICE=wormhole-test 가 config.crypto.keychainService 로 전파되었으면 stderr 에 `keychain service wormhole-test` 부분문자열이 정확히 포함됨
  - 케이스 C: 부팅 throw 이므로 프로세스 exit code≠0, stdout(MCP 채널)은 무오염(에러 메시지가 stdout 으로 새지 않음)
  - 케이스 A/B 모두 passphrase 원문 자체는 stderr 에 노출되지 않음(bootstrap 은 source 라벨만 info, 원문 미로깅); 케이스 C 의 throw 메시지도 passphrase 원문 미포함(소스 메타 라벨만 노출)
- **합격 기준**:
  - 케이스 A stderr 가 'passphrase 소스: file' 정확 부분문자열 포함 AND 'passphrase 소스: env' 미포함
  - 케이스 B stderr 가 'passphrase 소스: env' 정확 부분문자열 포함 AND 'passphrase 소스: file' 미포함
  - 케이스 A 의 file 적중은 WORMHOLE_PASSPHRASE_FILE env→crypto.passphraseFile override(config.ts:171) 가 동작했음을 입증(config.json 에 passphraseFile 미기재 상태에서 env 만으로 file 소스 도달)
  - 케이스 A/B 모두 부팅 성공(wormhole_status isError 부재), passphrase 원문 stderr 미노출
  - 케이스 C stderr 가 `keychain service wormhole-test` 정확 부분문자열 포함 — WORMHOLE_KEYCHAIN_SERVICE env→crypto.keychainService override(config.ts:172) 가 동작해 throw 메시지에 전파됨을 블랙박스 입증(config.json 에 keychainService 미기재 상태에서 env 만으로 throw 메시지 노출)
  - 케이스 C 부팅 throw 로 exit code≠0 AND stdout(MCP 채널) 무오염(에러 메시지 미유출)
- **신선도**: 기존 67 및 (a)(b)(c) 와 차이: 기존 시나리오는 passphrase 가 어떤 소스에서 해석되는지(env vs file)와 그 소스 메타 override(WORMHOLE_PASSPHRASE_FILE env→config.passphraseFile)를 부팅 관측 로그로 단언하지 않았다. (a) mock 테스트는 resolvePassphrase 함수를 직접 호출해 source 반환만 검증할 뿐 applyEnvOverrides→resolvePassphrase→bootstrap 로그의 end-to-end 와이어를 블랙박스로 보지 않는다. 본 신규는 server.mjs 부팅의 stderr 로그('passphrase 소스: file' / 'env')로 env override + env>file 우선순위를 동시에 증명.
- **자동화 힌트**: WORMHOLE_PASSPHRASE 의 set/unset 만 토글하며 동일 server.mjs 를 2회 spawn, 각 stderr 에서 'passphrase 소스:' 라인 grep. 케이스 A 는 unset, 케이스 B 는 set. POSIX 0600 chmod 누락 시 경고는 차단 아님(passphrase.ts:76-80)이므로 file 소스 적중 자체에는 무영향.

---

#### TRX-14 · normalizeBaseDir 정규화 — 지저분한 remoteBaseDir('//foo/bar//') 부팅 MKCOL 이 '/foo/bar' 컬렉션에 생성  `P2`

- **갭 클로저**: F-CONFIG-14 normalizeBaseDir. config.ts:181 normalizeBaseDir(선행 슬래시 전부 제거→정확히 1개, 후행 슬래시 제거) + deriveRemoteBaseDir(config.ts:189) 가 명시 remoteBaseDir 을 정규화함을 bootstrap ensureDir(MKCOL) 의 실제 원격 컬렉션 경로로 블랙박스 증명
- **전제조건**:
  - WRITABLE_WEBDAV: PROPFIND 로 컬렉션 존재 관측 가능한 쓰기 WebDAV 기동
  - STDIO_RPC_CLIENT: server.mjs spawn 가능; 독립 PROPFIND 클라이언트로 원격 디렉터리 교차확인
  - config.json remote.remoteBaseDir 를 케이스별 지저분한 값으로 설정(username 도출이 아닌 명시 override 경로 — deriveRemoteBaseDir config.ts:190-191 explicit 분기)
  - 정상 passphrase 로 buildEngine 성공(ensureDir 는 bootstrap 3단계, config.ts:42-43)
- **대상 도구**: `buildEngine(부팅 ensureDir → MKCOL)`
- **절차**:
  1. [케이스 1] config.json remote.remoteBaseDir='//foo/bar//' 설정 후 server.mjs spawn → initialize handshake → 부팅 완료까지 대기.
  2. 독립 PROPFIND(Depth:1) 를 WebDAV 루트에 발행해 생성된 컬렉션 경로 관측.
  3. 원격에 '/foo/bar' 컬렉션과 그 하위 '/foo/bar/blobs' 컬렉션 존재 확인(bootstrap config.ts:42-43 이 baseDir + baseDir/blobs 2개 MKCOL).
  4. '/foo' 만 있는 중복 슬래시 경로('//foo')나 후행 슬래시 경로('/foo/bar/')가 별도 컬렉션으로 생기지 않음 확인.
  5. [케이스 2] remoteBaseDir='foo'(선행 슬래시 없음) → 재기동 → PROPFIND 로 '/foo' 컬렉션 관측.
  6. [케이스 3] remoteBaseDir='/bar/'(후행 슬래시) → 재기동 → PROPFIND 로 '/bar' 컬렉션 관측.
  7. [케이스 4] remoteBaseDir='//x//'(선행 다수+후행 다수) → 재기동 → PROPFIND 로 '/x' 컬렉션 관측.
- **기대 결과**:
  - 케이스 1: normalizeBaseDir('//foo/bar//') = '/' + '//foo/bar//'.replace(/^\/+/,'').replace(/\/+$/,'') = '/' + 'foo/bar' = '/foo/bar' (config.ts:182). PROPFIND 결과에 '/foo/bar' 및 '/foo/bar/blobs' 컬렉션 존재
  - 케이스 2: normalizeBaseDir('foo') = '/foo'. PROPFIND 에 '/foo' 컬렉션 존재
  - 케이스 3: normalizeBaseDir('/bar/') = '/bar'. PROPFIND 에 '/bar' 컬렉션 존재
  - 케이스 4: normalizeBaseDir('//x//') = '/x'. PROPFIND 에 '/x' 컬렉션 존재
  - 모든 케이스: deriveRemoteBaseDir(config.ts:189-192) 가 explicit(trim 후 비공백) 분기로 normalizeBaseDir(remoteBaseDir) 적용 — username 도출 분기 비사용
  - 어떤 케이스에서도 빈 세그먼트(이중 슬래시) 또는 후행 슬래시를 가진 컬렉션 경로가 원격에 생성되지 않음
- **합격 기준**:
  - 케이스 1 PROPFIND 가 '/foo/bar' 정확 경로 컬렉션 + '/foo/bar/blobs' 반환, '//foo' 류 빈세그먼트 경로 부재
  - 케이스 2/3/4 각각 '/foo','/bar','/x' 정확 경로 컬렉션 반환
  - 정규화 결과 경로가 선행 슬래시 정확히 1개 + 후행 슬래시 0개임을 PROPFIND href 로 확인
  - 4 케이스 모두 부팅 성공(MKCOL 정상 완료, 어떤 tools/call 도 불필요)
- **신선도**: 기존 67 및 (a)(b)(c) 와 차이: 기존 시나리오(TRX 부팅 부수효과 계열)는 username 도출 baseDir 의 MKCOL 만 관측했고 명시 remoteBaseDir 의 정규화(선행 슬래시 다수/후행 슬래시 제거)를 원격 컬렉션 경로로 단언하지 않았다. (a) mock 테스트는 normalizeBaseDir 순수함수 입출력만 단위 검증할 뿐 deriveRemoteBaseDir→config.remote.remoteBaseDir→bootstrap ensureDir→실제 MKCOL 경로의 end-to-end 를 블랙박스로 보지 않는다. 본 신규는 지저분한 config 값('//foo/bar//' 등 4케이스)이 실제 원격에 정규화된 단일 컬렉션('/foo/bar')으로만 MKCOL 됨을 PROPFIND 로 증명.
- **자동화 힌트**: config.json remote.remoteBaseDir 값만 케이스별로 바꿔 server.mjs 재기동, 각 부팅 후 독립 PROPFIND(Depth:1)로 컬렉션 href 비교. tools/call 불필요(MKCOL 은 부팅 부수효과). 각 케이스는 격리된 원격 루트(또는 사전 정리)에서 실행해 이전 케이스 잔존 컬렉션 간섭 회피.

---

#### TRX-15 · passphraseFile 기본경로 해석 — crypto.passphraseFile='' 이면 <stateDir>/passphrase 로 해석되어 부팅 'passphrase 소스: file'  `P2`

- **갭 클로저**: F-CONFIG-16 passphraseFile 경로 해석. config.ts:206-215 가 passphraseFile 빈문자열→path.join(stateDir,'passphrase') 기본값, 비어있지않으면 expandTilde 후 비절대면 path.resolve(stateDir, 그것) 으로 해석함을 부팅 file 소스 적중으로 블랙박스 증명
- **전제조건**:
  - WRITABLE_WEBDAV 또는 READONLY_WEBDAV: buildEngine 성공 필요
  - STDIO_RPC_CLIENT: server.mjs spawn 후 stderr 캡처
  - WORMHOLE_PASSPHRASE 미설정(env 소스 차단해 file 소스로 강제) + WORMHOLE_PASSPHRASE_FILE env 미설정(override 차단해 config 기본값 경로 해석 입증)
  - config.crypto.passphraseFile='' (또는 케이스별 '~/...' / 상대경로), stateDir 은 config.stateDir 해석값(미지정 시 ~/.wormhole, config.ts:342-344)
- **대상 도구**: `buildEngine(부팅 부수효과: passphrase 해석)`, `wormhole_status`
- **절차**:
  1. [케이스 A — 기본경로] config.crypto.passphraseFile='' 로 두고, `<stateDir>/passphrase` 파일에 passphrase 한 줄 배치(POSIX 면 0600).
  2. 환경: WORMHOLE_PASSPHRASE 미설정, WORMHOLE_PASSPHRASE_FILE 미설정.
  3. server.mjs spawn → initialize → stderr 캡처 → tools/call wormhole_status {} 호출(부팅 완료 보장).
  4. stderr 의 'passphrase 소스: ' 라인 추출.
  5. [케이스 B — 상대경로] config.crypto.passphraseFile='secret/pass.txt'(비절대) 로 설정, `<stateDir>/secret/pass.txt` 에 passphrase 배치 → 재기동 → stderr 캡처.
  6. [케이스 C — 틸드경로] config.crypto.passphraseFile='~/wh-pass.txt' 로 설정, `<home>/wh-pass.txt` 에 passphrase 배치 → 재기동 → stderr 캡처.
  7. 각 케이스 wormhole_status 응답 isError 부재 확인.
- **기대 결과**:
  - 케이스 A: passphraseFile='' → resolvePaths(config.ts:207-209) 가 path.join(stateDir,'passphrase') 로 기본 해석 → readPassphraseFile(`<stateDir>/passphrase`) 적중 → source='file' → bootstrap.ts:54 stderr 'passphrase 소스: file'
  - 케이스 B: passphraseFile='secret/pass.txt' 비절대(config.ts:210-214) → expandTilde 무변→ path.resolve(stateDir,'secret/pass.txt')=`<stateDir>/secret/pass.txt` 적중 → source='file' → stderr 'passphrase 소스: file'
  - 케이스 C: passphraseFile='~/wh-pass.txt' → expandTilde(config.ts:211)=path.join(home,'wh-pass.txt')=`<home>/wh-pass.txt`(절대) → 적중 → source='file' → stderr 'passphrase 소스: file'
  - 세 케이스 모두 WORMHOLE_PASSPHRASE 미설정이라 env 분기(passphrase.ts:36) skip 후 file 분기(passphrase.ts:41) 적중 — env override(WORMHOLE_PASSPHRASE_FILE) 미사용으로 config 경로 해석 자체가 입증됨
  - 세 케이스 모두 wormhole_status isError 부재(부팅 정상)
- **합격 기준**:
  - 케이스 A stderr 가 'passphrase 소스: file' 포함 — 기본경로 `<stateDir>/passphrase` 해석(config.ts:208-209) 입증
  - 케이스 B stderr 가 'passphrase 소스: file' 포함 — 비절대 상대경로의 path.resolve(stateDir,x)(config.ts:212-213) 해석 입증
  - 케이스 C stderr 가 'passphrase 소스: file' 포함 — '~/' 의 expandTilde→home 해석(config.ts:211) 입증
  - 세 케이스 모두 WORMHOLE_PASSPHRASE_FILE env 미설정(override 비개입)이며 wormhole_status isError 부재
- **신선도**: 기존 67 및 (a)(b)(c) 와 차이: TRX-13 은 WORMHOLE_PASSPHRASE_FILE env override 경로(applyEnvOverrides)로 file 소스를 도달시키지만, 본 TRX-15 는 env override 를 의도적으로 차단(WORMHOLE_PASSPHRASE_FILE 미설정)하고 config.crypto.passphraseFile 값 자체의 resolvePaths 경로 해석(빈문자열 기본값 / 비절대 path.resolve / 틸드 확장)을 분리 증명한다. (a) mock 테스트는 resolveConfig 반환의 passphraseFile 문자열만 단언할 뿐 그 해석 경로에 실제 파일을 두고 부팅 시 file 소스로 적중하는 end-to-end 를 블랙박스로 보지 않는다. 본 신규는 3가지 경로 형태(빈문자열·상대·틸드) 각각이 부팅 'passphrase 소스: file' 로 귀결됨을 stderr 로 증명.
- **자동화 힌트**: config.crypto.passphraseFile 값만 케이스별('', 'secret/pass.txt', '~/wh-pass.txt')로 바꾸고 대응 경로에 passphrase 파일 사전 배치 후 server.mjs 재기동, stderr 에서 'passphrase 소스: file' grep. WORMHOLE_PASSPHRASE 와 WORMHOLE_PASSPHRASE_FILE 는 전 케이스 미설정 유지(env 분기·env override 동시 차단). stateDir 은 config 에 명시하거나 ~/.wormhole 기본값 사용.

---

### 6.2 confirm-gate-realwire

> **차원 개요**: confirm 게이트가 실제 원격 와이어에 무변경임을 MCP 도구 경계(stdio JSON-RPC tools/call)에서 증명한다. mock 엔진 분기 테스트(a)와 달리 `server.mjs` 를 실제 프로세스로 띄우고, confirm 생략/false 호출 전후 원격 manifest generation·blob 목록·로컬 파일을 독립 PROPFIND 또는 `wormhole_status` 로 교차확인한다. `confirm:true` 재호출 시에만 generation 이 전진하고 로컬이 변화함을 델타로 판정하여 "안전 기본값" 설계 계약을 블랙박스로 검증한다.

#### CGW-01 · wormhole_sync 미리보기 → pull+push 합본 구조 검증 및 와이어 불변 확인  `P0`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A(원격에 파일 있음) + 머신 B(독립 HOME, 원격과 diff 있음)
  - `WRITABLE_WEBDAV` 기동
  - 머신 B 에서 `server.mjs` stdio 기동
  - `STDIO_RPC_CLIENT` 연결 (머신 B)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신 B: tools/call `wormhole_status {}` → `GEN_BEFORE` 기록, items 스냅샷 저장
  2. 머신 B: tools/call `wormhole_sync {}` (confirm 생략) → 응답 캡처
  3. 머신 B: tools/call `wormhole_sync {"policy": "latest-wins"}` (confirm 생략) → 응답 캡처
  4. 머신 B: tools/call `wormhole_status {}` → `GEN_AFTER_DRY`, items 확인
  5. 독립 PROPFIND: `manifest.json.age` + `lock.json` 존재/크기/Last-Modified 확인
  6. 머신 B: tools/call `wormhole_sync {"confirm": true}` → 응답 캡처
  7. 머신 B: tools/call `wormhole_status {}` → `GEN_FINAL` 확인
- **기대 결과**:
  - step2 응답: `structuredContent.pull` 존재(dryRun:true), `structuredContent.push` 존재(dryRun:true), note 존재, resolve 키 없음
  - step3 응답: 동일 구조(policy 파라미터는 미리보기에서 무시됨)
  - step4: `GEN_AFTER_DRY === GEN_BEFORE`
  - step5: `manifest.json.age` Last-Modified 불변, `lock.json` 없음(잔존 락 없음)
  - step6 응답: `pull.dryRun===false` AND `push.dryRun===false`, isError 없음
  - step7: `GEN_FINAL > GEN_BEFORE`
- **합격 기준**:
  - step2 structuredContent 에 pull·push 두 키 모두 존재하고 각각 dryRun:true
  - step2·step3 모두 note 문자열 존재
  - `GEN_AFTER_DRY === GEN_BEFORE` (두 번의 미리보기 후 불변)
  - step5 PROPFIND: `manifest.json.age` Last-Modified 변화 없음
  - `GEN_FINAL > GEN_BEFORE` (confirm:true 1회 후 전진)
- **신선도**: (b)는 엔진 직접호출 단일 해피패스였으나, 본 시나리오는 `wormhole_sync` 의 미리보기 응답 구조(pull+push 합본)와 confirm:true 비교를 MCP 도구 경계에서 교차 검증한다.
- **자동화 힌트**: `STDIO_RPC_CLIENT` 로 JSON-RPC 배치 호출 가능. PROPFIND 는 `curl -X PROPFIND -H 'Depth:0' <url>/manifest.json.age` 로 Content-Length·Last-Modified 파싱.

#### CGW-02 · wormhole_resolve confirm:false → 충돌 목록 반환만, 로컬·원격 파일 불변 증명  `P1`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A와 B가 동일 키(예: `.claude/CLAUDE.md`)를 각각 독립 수정하여 conflict 상태 유발
  - 충돌 유발 방법: 머신 A push → 머신 B도 동일 키 수정 후 push → 머신 B `wormhole_status` 에서 conflicts 비어 있지 않음 확인
  - `WRITABLE_WEBDAV` 기동
  - `STDIO_RPC_CLIENT` 연결 (머신 B)
- **대상 도구**: `wormhole_resolve`, `wormhole_status`
- **절차**:
  1. 머신 B: tools/call `wormhole_status {}` → conflicts 배열의 logicalKey 목록 기록(`CONFLICT_KEYS`), `GEN_BEFORE` 기록
  2. 머신 B: 충돌 파일 체크섬 기록(sha256sum 등)
  3. 머신 B: tools/call `wormhole_resolve {}` (confirm 생략, policy 생략) → 응답 캡처
  4. 머신 B: tools/call `wormhole_resolve {"policy": "latest-wins"}` (confirm 생략) → 응답 캡처
  5. 머신 B: 충돌 파일 체크섬 재측정
  6. 머신 B: tools/call `wormhole_status {}` → `GEN_AFTER_DRY`, conflicts 확인
  7. 머신 B: tools/call `wormhole_resolve {"policy": "preserve-both", "confirm": true}` → 응답 캡처
  8. 머신 B: tools/call `wormhole_status {}` → `GEN_FINAL`, conflicts 확인
- **기대 결과**:
  - step3 응답: `structuredContent.dryRun === true`, note 존재, resolved 배열은 `CONFLICT_KEYS` 포함(계획만), conflictCopies 빈 배열, backupDir null
  - step4 응답: dryRun:true, note 존재(policy:latest-wins 도 dry)
  - step5: 체크섬 === step2 값(파일 미변경)
  - step6: `GEN_AFTER_DRY === GEN_BEFORE`, conflicts 동일하게 유지
  - step7 응답: dryRun 없음(실행), resolved 비어 있지 않음, conflictCopies 파일 경로 포함
  - step8: **preserve-both confirm:true 직후 `wormhole_status.summary.conflicts` 는 감소하지 않고 동일하게 잔존한다.** 근거: `engine.ts` `runResolve`(753-867)의 preserve-both 분기는 base/state watermark 를 미전진시킨다(코드: "base/state 갱신은 보류 — 사용자가 수동 정리 후 push"). latest-wins 만 `writeState` 호출(line 858 부근). 따라서 충돌 미해소, conflictCopies 사본만 디스크에 생성된다. (critic 교정 반영)
- **합격 기준**:
  - step5 체크섬 === step2 체크섬 (confirm:false 두 번 후 로컬 파일 불변)
  - `GEN_AFTER_DRY === GEN_BEFORE`
  - step3 `structuredContent.dryRun === true` AND note 존재 AND `conflictCopies.length === 0`
  - **preserve-both 성공 판정** (critic 교정 반영):
    1. `ResolveResult.conflictCopies` 각 항목 `copyPath = '<absPath>.conflict-{sanitizeToken(remoteMachineId)}-{sanitizeToken(remoteGeneration)}'` 파일이 디스크에 존재
    2. 로컬 원본(logicalKey 실파일) 바이트 무변경
    3. `ResolveResult.backupDir === null` (preserve-both 는 hadBackup 미설정)
    4. 직후 `wormhole_status.summary.conflicts` 가 resolve 이전과 동일 카운트
    5. 충돌 해소 확인이 목적이면 별도 latest-wins 케이스로 분리한다(latest-wins 는 `writeState` 로 watermark 전진 → conflicts 0)
- **신선도**: (a)는 mock 분기로 confirm 게이트만, (b)는 충돌 경로 미검증이었으나, 본 시나리오는 실제 충돌 상태에서 resolve dry run 이 로컬·원격에 아무 사본도 생성하지 않음을 파일시스템 레벨로 증명한다.

#### CGW-03 · wormhole_status 에 confirm 전달 → 와이어 무변경 각도만 유지 (범위 축소)  `P1`

> **overlaps 재서술**: SCH-05(미선언 프로퍼티 strip/reject)와 핵심 질문이 겹쳐, 본 시나리오는 **confirm 전달이 원격 generation 을 불변으로 두는가(와이어 무변경) 각도만 유지** 한다. 미선언 프로퍼티 strip/reject 동작 자체는 SCH-05 로 일원화한다. 시나리오는 삭제하지 않고 범위만 축소한다.

- **전제조건**:
  - `WRITABLE_WEBDAV` 기동 (읽기전용 `READONLY_WEBDAV` 도 병용 가능)
  - `server.mjs` stdio 기동
  - `STDIO_RPC_CLIENT` 연결
- **대상 도구**: `wormhole_status`
- **절차**:
  1. tools/call: `wormhole_status {"confirm": true}` → 응답 캡처
  2. tools/call: `wormhole_status {"confirm": false}` → 응답 캡처
  3. 호출 전후 독립 `wormhole_status` 로 원격 manifest generation 불변 교차확인
- **기대 결과**:
  - step1~2: confirm 추가 파라미터가 원격 와이어에 어떤 효과도 미치지 않음 — 실제 write 발생 없음
  - step1~2 어느 호출도 원격 manifest generation 을 변경하지 않음
- **합격 기준**:
  - **(범위 축소 핵심)** step1~2 어느 호출도 원격 manifest generation 을 변경하지 않음(`wormhole_status` 로 교차확인) — 와이어 무변경
  - 미선언 프로퍼티의 strip vs reject 동작 판정은 본 시나리오 범위 밖이며 SCH-05 에서 일원화 검증
- **신선도**: (a)는 inputSchema 거부를 mock 에서만, (b)는 이 경로 미검증이었으나, 본 시나리오는 읽기전용 도구에 confirm 을 실제로 전달했을 때 원격 와이어가 불변임을 서버 경계에서 확인한다.
- **자동화 힌트**: MCP Inspector 의 'Extra parameters' 입력란에 `confirm:true` 를 추가하여 제출. 호출 전후 독립 PROPFIND 로 manifest generation 불변 확인.

#### CGW-04 · confirm:false 연속 호출 후 confirm:true → generation 정확히 +1만 전진 (이중 쓰기 부재 증명)  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV` 기동
  - 로컬에 push 대상 파일 3개 이상 준비
  - `server.mjs` stdio 기동
  - `STDIO_RPC_CLIENT` 연결
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. tools/call `wormhole_status {}` → `GEN_0` 기록
  2. tools/call `wormhole_sync {}` (confirm 생략) → 응답 캡처 (미리보기 #1)
  3. tools/call `wormhole_sync {"confirm": false}` → 응답 캡처 (미리보기 #2)
  4. tools/call `wormhole_sync {}` (confirm 생략) → 응답 캡처 (미리보기 #3)
  5. tools/call `wormhole_status {}` → `GEN_AFTER_3_DRY` 확인
  6. tools/call `wormhole_sync {"confirm": true}` → 응답 캡처, `push.manifestGeneration` 필드 기록(`GEN_RESULT`)
  7. tools/call `wormhole_status {}` → `GEN_AFTER_REAL` 확인
  8. tools/call `wormhole_sync {"confirm": true}` → 응답 캡처 (변경 없는 재sync)
  9. tools/call `wormhole_status {}` → `GEN_FINAL` 확인
- **기대 결과**:
  - step2~4 응답: `pull.dryRun===true` AND `push.dryRun===true`, note 존재
  - step5: `GEN_AFTER_3_DRY === GEN_0` (3회 미리보기 후 불변)
  - step6 응답: `push.dryRun===false`, push.pushed 비어있지 않음, `push.manifestGeneration === GEN_0 + 1`
  - step7: `GEN_AFTER_REAL === GEN_0 + 1`
  - step8 응답: push.pushed 빈 배열, push.deleted 빈 배열 (변경 없으면 manifest 쓰기 생략 — engine.ts 430행 early return)
  - step9: `GEN_FINAL === GEN_AFTER_REAL` (재sync 후 generation 불변)
- **합격 기준**:
  - `GEN_AFTER_3_DRY === GEN_0` (3회 미리보기가 generation 에 무영향)
  - `GEN_AFTER_REAL === GEN_0 + 1` (confirm:true 1회 후 정확히 +1)
  - `step8 push.pushed.length === 0` AND `GEN_FINAL === GEN_AFTER_REAL` (멱등성 확인)
  - step6 응답의 `push.manifestGeneration === GEN_AFTER_REAL` (반환값과 실제 상태 일치)
- **신선도**: (b)는 두 번째 pull 의 no-op 멱등만 확인했으나, 본 시나리오는 N회 미리보기가 generation 누적을 일으키지 않고 confirm:true 단일 호출이 정확히 +1만 전진시킴을 수치로 증명한다.
- **자동화 힌트**: 각 단계 응답을 `JSON.parse(content[0].text).push.manifestGeneration` 으로 추출하여 산술 비교 자동화 가능.

#### CGW-05 · wormhole_sync confirm:true + pull 충돌 발생 시 resolve 자동 개입 → 각 단계 structuredContent 구조 및 와이어 효과 검증  `P1`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A와 B 동일 키 충돌 상태 유발(CGW-04 precondition 과 동일)
  - `WRITABLE_WEBDAV` 기동
  - 머신 B `server.mjs` stdio 기동
  - `STDIO_RPC_CLIENT` 연결 (머신 B)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신 B: tools/call `wormhole_status {}` → `GEN_BEFORE`, conflicts 목록 기록
  2. 머신 B: tools/call `wormhole_sync {}` (confirm 생략) → 응답 구조 캡처
  3. 머신 B: tools/call `wormhole_status {}` → `GEN_AFTER_DRY` 확인(불변 기대)
  4. 머신 B: tools/call `wormhole_sync {"policy": "preserve-both", "confirm": true}` → 응답 캡처
  5. 머신 B: tools/call `wormhole_status {}` → `GEN_FINAL`, conflicts 확인
  6. 머신 B: OS 파일시스템에서 `.conflict-*` 사본 파일 존재 확인(`ls ~/.claude/*.conflict-*`)
- **기대 결과**:
  - step2 응답: `structuredContent.pull.dryRun===true`, `structuredContent.push.dryRun===true`, note 존재, resolve 키 없음(dry 에서는 resolve 단계 없음)
  - step3: `GEN_AFTER_DRY === GEN_BEFORE`
  - step4 응답: `structuredContent.pull.dryRun===false`, `structuredContent.resolve` 키 존재(conflicts.length>0 이므로), `structuredContent.push.dryRun===false`, isError 없음
  - step4 응답: `structuredContent.resolve.policy === 'preserve-both'`, resolved 배열 비어 있지 않음
  - **step5: `GEN_FINAL > GEN_BEFORE`. generation 전진 원인은 `wormhole_sync` 의 push 단계(resolve 아님)에 귀속된다.** 근거: `runResolve` preserve-both 는 manifestStore 미쓰기라 generation 미전진. sync confirm:true 흐름은 pull → (conflicts>0 면 resolve preserve-both) → push 이고, preserve-both 가 충돌 미해소 상태로 push 단계에 진입 → push 가 로컬 원본(충돌 미해소분 포함)을 원격 manifest 에 반영하며 generation 전진. push 가 무엇을 업로드하는지(로컬 현재 상태)는 별도 PROPFIND/manifest 점검으로 확인한다. (critic 교정 반영)
  - step6: `.conflict-<machineId>-<gen>` 파일 존재(preserve-both 실행 증거)
- **합격 기준**:
  - step2 structuredContent 에 pull·push 키 존재 및 각 dryRun:true, resolve 키 없음
  - `GEN_AFTER_DRY === GEN_BEFORE` (미리보기 후 불변)
  - step4 structuredContent 에 pull·resolve·push 세 키 모두 존재
  - step6: OS 에 `.conflict-*` 파일 존재(preserve-both 정책이 실제로 실행됨을 물증으로 확인)
  - **(교정)** `GEN_FINAL > GEN_BEFORE` 는 sync 의 push 단계 기여로만 단언(resolve 기여 0). 비삭제 충돌 마커는 `'<absPath>.conflict-{sanitizeToken(mid)}-{sanitizeToken(gen)}'` 패턴(삭제 충돌은 `.conflict-deleted-{mid}-{gen}`). sync ResolveResult 단계의 `backupDir` 은 null(preserve-both). (critic 교정 반영)
- **신선도**: (a)는 sync tool 의 confirm 분기를 mock 에서만, (b)는 충돌 경로·sync 복합 실행 미검증이었으나, 본 시나리오는 충돌 존재 시 sync confirm:true 가 pull→resolve→push 세 단계를 실제 실행하고 `.conflict-*` 사본이 물리적으로 생성됨을 MCP 도구 경계에서 end-to-end 검증한다.
- **자동화 힌트**: step6 은 Bash 도구로 `ls ~/.claude/*.conflict-* 2>/dev/null | wc -l` 실행 후 > 0 판정.

#### CGW-06 · wormhole_sync confirm:true 비충돌 발산 실적용 — pull·push 실행, resolve 키 부재  `P1`

- **갭 클로저**: universeGap:sync-no-conflict-apply — sync.ts confirm:true 경로에서 pull.conflicts.length>0 가 false 일 때 resolve 를 건너뛰고 pull→push 만 실제 적용하는 비충돌 실적용 분기
- **전제조건**:
  - TWO_MACHINE: 두 HOME + 별도 stateDir, 동일 원격 WebDAV(WRITABLE_WEBDAV) + 동일 passphrase
  - 머신A에서 정상 부팅 후 wormhole_sync{confirm:true} 1회로 원격 매니페스트 베이스라인 수립(사전 status 의 manifestGeneration 값=베이스라인 기록)
  - 발산 상태를 비충돌로 구성: 머신A 로컬 ~/.claude/ 내 동기대상 1개를 신규 추가(로컬만 변경, 원격 미반영). 동일 키를 양쪽이 동시 변경하지 않아 충돌이 생기지 않도록 함
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR 로 머신A server.mjs 부팅 성공(ensureCryptoReady 통과)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신A: tools/call wormhole_status {} 로 added/modified 1건·conflicts 0건 사전 확인
  2. 머신A: tools/call wormhole_sync {"confirm": true} (policy 생략 → 기본 preserve-both)
  3. 응답 structuredContent 의 키 집합과 push.manifestGeneration·pull.applied 를 캡처
  4. 머신A: tools/call wormhole_status {} 재호출로 added/modified 가 0(또는 unchanged 로 수렴)인지 확인
- **기대 결과**:
  - structuredContent 는 정확히 {pull, push} 두 키만 — resolve 키 부재(sync.ts line43 if(pull.conflicts.length>0) 가 false 라 payload.resolve 미설정)
  - note 키 없음(미리보기 분기 아님)
  - pull.dryRun === false, pull.conflicts === [] (빈 배열), pull.applied·pull.removed 는 원격 측 변경 없으면 []
  - push.dryRun === false, push.pushed 에 로컬 신규 키 포함, push.manifestGeneration 이 사전 status 의 manifestGeneration 값(=베이스라인)보다 전진(runPush 가 CAS write 수행 → writtenGeneration)
  - push.conflicts === []
  - isError 미설정(정상 결과)
- **합격 기준**:
  - structuredContent 키 집합 == {pull, push} (resolve 부재) — 객관 비교
  - push.manifestGeneration > 사전 status 의 manifestGeneration
  - step4 status 에서 해당 키가 더 이상 added/modified 로 잡히지 않음
  - content[0].text 를 JSON.parse 한 결과가 structuredContent 와 일치
- **신선도**: 기존 CGW-07(confirm:true 충돌 자동개입 — resolve 키 존재)과 정반대로, 충돌 0건이라 resolve 분기를 건너뛰고 pull→push 만 실적용되어 payload 에 resolve 키가 없음을 검증한다 — (a)(b)(c) 미리보기/단일도구가 아닌 복합 실행 비충돌 경로. (critic 교정 반영)
- **자동화 힌트**: structuredContent 의 Object.keys 정렬 비교로 resolve 부재를 단정. push.manifestGeneration 전진은 sync 직전 status 호출값과 수치 비교.

#### CGW-07 · wormhole_sync 미리보기(confirm 생략) CORRUPT_REMOTE stop-on-error — pull 단계 throw 로 push 미산출, isError  `P1`

- **갭 클로저**: universeGap:sync-preview-stop-on-error — sync.ts confirm 생략 미리보기 분기(line26-27)에서 engine.pull({dryRun:true}) 가 throw 하면 engine.push({dryRun:true}) 가 await 되지 않아 push 미리보기 미계산 → 핸들러 catch → isError:true
- **전제조건**:
  - CORRUPT_REMOTE: 원격 WebDAV 에 매니페스트 파일은 존재하나 복호 후 JSON.parse 실패(손상 바이트) 또는 ManifestSchema 검증 실패(구조 비호환) 상태로 조작
  - server.mjs 부팅은 성공해야 함 — ensureCryptoReady 의 keyparams sentinel 은 정상이고 매니페스트 본문만 손상(부팅 단계가 아닌 pull 단계에서 실패하도록 분리)
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR 연결됨
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. tools/call wormhole_sync {} (confirm 생략 → args.confirm !== true → 미리보기 분기 진입)
  2. 핸들러 내부: engine.pull({dryRun:true}) → planPull → status() → manifestStore.read() 에서 throw
  3. 응답의 isError·content[0].text 캡처. structuredContent 부재 확인
- **기대 결과**:
  - isError === true (sync.ts line52-55 catch 블록)
  - content[0].text === String(err.message) — manifest.ts read() 가 던진 메시지: 손상이 JSON 깨짐이면 '원격 매니페스트 JSON 파싱 실패: ...', 구조 비호환이면 '원격 매니페스트 구조 검증 실패(손상/비호환): ...'
  - structuredContent 미설정(catch 경로는 content + isError 만 반환)
  - push 미리보기 필드 일절 부재 — pull throw 가 push dryRun await 보다 먼저 발생해 push({dryRun:true}) 자체가 호출되지 않음
  - payload(pull/push/note) 정상 객체 미반환
- **합격 기준**:
  - isError === true
  - content[0].text 가 '원격 매니페스트 JSON 파싱 실패' 또는 '원격 매니페스트 구조 검증 실패(손상/비호환)' 접두로 시작
  - 응답에 structuredContent 키 없음(또는 undefined)
  - 응답 본문 어디에도 push/pushed/manifestGeneration 미리보기 값 없음
- **신선도**: 기존 ELC-07/ELC-08(confirm:true 실행 분기 stop-on-error)과 달리 confirm 생략 미리보기 분기에서 pull dryRun throw 가 push dryRun 산출을 막는 경로를 검증 — 같은 stop-on-error 라도 dryRun:true 계획 단계의 단락임. (a)(b)(c) 와도 무관한 미리보기 에러 경로.
- **자동화 힌트**: isError 플래그 단정 + content 텍스트 정규식 매칭(^원격 매니페스트 (JSON 파싱 실패|구조 검증 실패)). structuredContent 부재는 응답 객체 키 검사.

---

### 6.3 input-schema-zod

> **차원 개요**: MCP 도구 경계에서 zod inputSchema 가 실제로 유효하지 않은 인자를 차단하고, 유효한 인자는 엔진에 도달시키는지를 검증한다. stdio JSON-RPC `tools/call` 메시지를 직접 전송하여 protocol-level 거부(MCP 에러 응답) 대 handler-level isError 를 구분하고, 엔진 미도달을 원격 상태 불변으로 증명한다. mock 엔진이 아닌 실제 `server.mjs` 프로세스 + 실제(또는 인메모리) WebDAV 를 사용하므로 (a) mock 단위테스트와 근본적으로 다르다.

#### SCH-01 · wormhole_sync — policy:'manual' 전달 시 zod 거부 (resolve 와 발산)  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
  - 원격 초기화 완료
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. `wormhole_sync` 에 policy:'manual' 전달: `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"wormhole_sync","arguments":{"policy":"manual","confirm":false}}}`
  2. 응답 기록(isError 여부, 메시지)
  3. 비교군: `wormhole_resolve` 에 동일 policy:'manual' 전달: `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"wormhole_resolve","arguments":{"policy":"manual","confirm":false}}}`
  4. 응답 기록 — resolve 는 수용, sync 는 거부 대조
  5. `wormhole_sync` 에 policy:'preserve-both' 전달하여 정상 수용 확인
  6. `wormhole_sync` 에 policy:'latest-wins' 전달하여 정상 수용 확인
- **기대 결과**:
  - id:10(sync+manual): `isError===true` 또는 protocol error — `z.enum(["preserve-both","latest-wins"])` 에 'manual' 미포함으로 zod 거부
  - id:11(resolve+manual): `isError===false`, `structuredContent.policy==='manual'`, note 포함(dryRun)
  - id:12(sync+preserve-both): `isError===false`, `structuredContent.pull` 및 `structuredContent.push` 존재
  - id:13(sync+latest-wins): `isError===false`, 동일 패턴
- **합격 기준**:
  - sync+manual 응답에 `isError===true` 또는 JSON-RPC error 존재
  - resolve+manual 응답에 isError 없고 ResolveResult 구조 반환
  - 두 도구의 policy enum 범위가 의도적으로 다름을 API 계약 레벨에서 실증
  - sync+preserve-both 및 sync+latest-wins 모두 정상 structuredContent 반환
- **신선도**: (a)에서 sync 도구의 policy enum 이 'manual' 을 제외함을 mock 으로만 확인; 본 시나리오는 실제 MCP 경계에서 resolve 와 sync 의 enum 범위 발산을 대조 호출로 증명한다.
- **자동화 힌트**: 동일 프로세스에 순차 JSON-RPC 전송 후 id 별 응답 파싱. Jest/vitest expect 로 isError 필드 단언.

#### SCH-02 · wormhole_resolve — keys 비배열/비문자열 원소 zod 거부  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
- **대상 도구**: `wormhole_resolve`
- **절차**:
  1. keys 에 문자열 단일값(배열 아님) 전달: `{"name":"wormhole_resolve","arguments":{"keys":".claude/CLAUDE.md"}}`
  2. 응답 기록
  3. keys 에 정수 원소 포함 배열 전달: `{"name":"wormhole_resolve","arguments":{"keys":[".claude/CLAUDE.md",42]}}`
  4. 응답 기록
  5. keys 에 null 원소 포함 배열 전달: `{"name":"wormhole_resolve","arguments":{"keys":[".claude/CLAUDE.md",null]}}`
  6. 응답 기록
  7. 비교군: keys 에 유효 문자열 배열 전달: `{"name":"wormhole_resolve","arguments":{"keys":[".claude/CLAUDE.md"],"confirm":false}}`
  8. 응답 기록 — 수용 확인
- **기대 결과**:
  - keys 단일 문자열: `isError===true` (z.array() 타입 불일치 거부)
  - keys 정수 원소 배열: `isError===true` (z.string() 원소 타입 거부)
  - keys null 원소 배열: `isError===true` (z.string() 원소 타입 거부)
  - keys 유효 문자열 배열: `isError===false`, `structuredContent.resolved` 배열 존재(빈 배열도 가능 — 충돌 없으면 빈 resolved)
- **합격 기준**:
  - 3개 비유효 케이스 모두 `isError===true` 또는 JSON-RPC error
  - 유효 케이스 응답에 policy, resolved, conflictCopies, backupDir 키 존재
  - 비유효 케이스 어디서도 engine.resolve 미도달 — 원격 상태 PROPFIND 불변으로 검증 가능
- **신선도**: (b) e2e 해피패스는 keys 파라미터 검증을 전혀 다루지 않음; 본 시나리오는 `z.array(z.string())` 의 원소 레벨 타입 검사를 실제 MCP 경계에서 3종 비유효 케이스로 검증한다.
- **자동화 힌트**: 각 케이스 JSON-RPC id 분리, 응답 배열 순회하며 isError 단언. vitest `test.each` 로 케이스 매트릭스화 가능.

#### SCH-03 · confirm 비불리언(문자열 'true', 숫자 1) 전달 시 모든 confirm 수용 도구에서 zod 거부  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
  - 원격에 동기화할 로컬 파일(`.claude/CLAUDE.md` 등) 존재
- **대상 도구**: `wormhole_resolve`, `wormhole_sync`
- **절차**:
  1. `wormhole_resolve` 에 confirm:'true'(문자열) 전달: `{"name":"wormhole_resolve","arguments":{"confirm":"true"}}`
  2. 응답 기록
  3. `wormhole_resolve` 에 confirm:1(숫자) 전달: `{"name":"wormhole_resolve","arguments":{"confirm":1}}`
  4. 응답 기록
  5. `wormhole_sync` 에 confirm:"true" 전달, 응답 기록
  6. 비교군: `wormhole_sync` 에 confirm:true(불리언) 전달 후 PROPFIND 로 원격 변화 확인
  7. 비교군: `wormhole_sync` 에 confirm 생략 후 `structuredContent.pull.dryRun===true`, note 필드 존재 확인
- **기대 결과**:
  - confirm:"true" 2개 도구(resolve·sync) 모두: `isError===true` 또는 protocol error (z.boolean() 거부)
  - confirm:1 resolve: `isError===true` (숫자는 z.boolean() 거부)
  - confirm:true(불리언) sync: `isError===false`, dryRun===false — 실제 동기화 발생
  - confirm 생략 sync: `isError===false`, pull.dryRun===true, note 필드 포함
- **합격 기준**:
  - 문자열/숫자 confirm 케이스 3개 모두 `isError===true`
  - confirm:true 불리언만 엔진 도달 — PROPFIND 원격 generation 변화로 증명
  - confirm 생략 케이스 pull.dryRun===true 이고 PROPFIND 불변
  - 2개 도구에서 동일 거부 패턴 — confirm 검증이 핸들러별이 아닌 zod 레이어에서 일관 적용됨을 증명
- **신선도**: (a) mock 단위테스트는 confirm 분기를 `confirm!==true` 조건으로만 검증; 본 시나리오는 타입 강제변환(coercion) 없이 비불리언이 거부되는지를 실제 MCP 경계 + 원격 와이어 효과로 검증한다.
- **자동화 힌트**: PROPFIND 응답 multistatus 파싱으로 generation 비교. confirm:true 전후 delta 로 sync 도달 여부 단언.

#### SCH-04 · wormhole_status 에 추가 프로퍼티 전달 시 통과 또는 무시 여부 확인  `P2`

> **(일원화 지점)** 미선언 프로퍼티 strip/reject 동작 및 null arguments 처리(MCP SDK zod strip 정책)는 본 시나리오로 일원화한다. CGW-05 는 와이어 무변경 각도만 다룬다.

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
- **대상 도구**: `wormhole_status`
- **절차**:
  1. 빈 인자 객체로 `wormhole_status` 호출(정상 기준선): `{"name":"wormhole_status","arguments":{}}`
  2. SyncStatus 응답 기록(generatedAt, machineId, summary 구조 확인)
  3. 알 수 없는 키 포함 호출: `{"name":"wormhole_status","arguments":{"unknown_field":"value","another":123}}`
  4. 응답 기록 — 거부 vs 수용(추가 프로퍼티 무시) 판정
  5. null 을 arguments 로 전달: `{"name":"wormhole_status","arguments":null}`
  6. 응답 기록
  7. arguments 키 자체 생략: `{"name":"wormhole_status"}`
  8. 응답 기록
- **기대 결과**:
  - 빈 인자 {}: `isError===false`, structuredContent 에 generatedAt(number), machineId(string), items(array), conflicts(array), summary 존재
  - 추가 프로퍼티 포함: MCP SDK 의 zod strict 설정에 따라 `isError===true`(strict) 또는 `isError===false`(passthrough/strip) — 실제 동작을 기록
  - null arguments: `isError===true` 또는 protocol error
  - arguments 생략: MCP SDK 기본 처리에 따라 빈 객체로 취급 후 정상 반환 또는 protocol error
- **합격 기준**:
  - 빈 인자 {} 케이스 SyncStatus 구조 완전 반환 확인(summary 모든 키 존재)
  - 추가 프로퍼티 케이스 동작(수용/거부) 명확히 기록 — 어느 쪽이든 일관성이 있어야 함
  - null arguments 케이스 에러 반환(정상 SyncStatus 반환되면 실패)
  - 결과가 `inputSchema:{}` 의 zod 동작(`z.object({})` strip 기본 동작)과 일치해야 함
- **신선도**: (a)에서 도구 등록 수만 확인; 본 시나리오는 파라미터 없는 도구의 추가 프로퍼티/null arguments 처리를 실제 MCP 경계에서 확인해 MCP SDK zod strip 정책을 문서화한다.
- **자동화 힌트**: 추가 프로퍼티 케이스 결과를 테스트 레포트에 기록 후 subsequent 릴리스와 비교하여 SDK 버전 업그레이드 시 행동 변화 감지.

#### SCH-05 · wormhole_resolve keys 빈 배열 + confirm:false — dryRun note 포함 확인 및 엔진 호출 증명  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
  - 충돌 없는 상태(원격 초기화 직후)
- **대상 도구**: `wormhole_resolve`
- **절차**:
  1. keys:[] (빈 배열), confirm 생략으로 호출: `{"name":"wormhole_resolve","arguments":{"keys":[]}}`
  2. 응답 기록 — isError 여부, `structuredContent.note` 존재, dryRun 플래그
  3. keys:[], policy:'preserve-both', confirm:false 로 호출
  4. 응답의 `structuredContent.policy`, resolved, conflictCopies, backupDir, note 기록
  5. keys:[], policy:'latest-wins', confirm:false 로 호출, 동일 필드 기록
  6. keys:[], policy:'manual', confirm:false 로 호출, 응답 기록(manual 수용 확인)
  7. 비교군: keys 생략(undefined), policy:'preserve-both', confirm:false — keys 생략 vs 빈배열 결과 동일성 확인
- **기대 결과**:
  - keys:[] confirm 생략: `isError===false`, dryRun===true, `note='미리보기 — 실제 적용하려면 confirm:true (사용자 확인 후)'`, resolved=[], conflictCopies=[], backupDir=null
  - policy:'preserve-both' + confirm:false: 동일 패턴, policy='preserve-both'
  - policy:'latest-wins' + confirm:false: 동일 패턴, policy='latest-wins'
  - policy:'manual' + confirm:false: `isError===false` — resolve 에서 'manual' 은 유효 enum 값으로 수용
  - keys 생략 vs keys:[] 결과 동일(충돌 없으면 resolved=[] 공통)
- **합격 기준**:
  - 4개 policy 케이스 모두 `isError===false`(manual 포함)
  - dryRun===true 인 모든 케이스 note 필드 존재
  - 빈 배열 keys 는 `z.array(z.string())` 통과 — isError 없음
  - keys 생략과 keys:[] 의 resolved 배열 동일 — 생략 시 optional 기본값 처리 일관성 증명
- **신선도**: (b) e2e 에서 resolve 는 미호출; 본 시나리오는 keys 빈배열/생략의 zod optional 처리 + dryRun note 자동 부가를 실제 MCP 경계에서 검증하며 manual policy 가 resolve 에서만 유효함을 재확인한다.
- **자동화 힌트**: keys=undefined(생략)와 keys=[] 응답을 JSON.stringify 후 resolved/conflictCopies/backupDir 필드만 deep-equal 단언.

#### SCH-06 · tools/list 응답 — inputSchema JSON Schema 자체 유효성 + 릴리스간 snapshot drift 감지 (범위 축소)  `P1`

> **overlaps 재서술**: TRX-01 이 이미 3개 도구 inputSchema 의 enum/required 재확인을 동형으로 검증한다. 단순 enum/required 재확인은 TRX-01 로 흡수하고, 본 시나리오는 **ajv 로 반환 JSON Schema 자체의 유효성 검증 + 릴리스간 snapshot drift 감지** 로 범위를 축소한다. 시나리오는 삭제하지 않고 차별화된 범위로 남긴다.

- **전제조건**:
  - `WRITABLE_WEBDAV`: 구동 및 config 설정 완료
  - `STDIO_RPC_CLIENT`: `server.mjs` 기동 + initialize 완료
- **대상 도구**: `wormhole_status`, `wormhole_resolve`, `wormhole_sync`
- **절차**:
  1. tools/list 호출: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`
  2. 응답의 tools 배열에서 3개 도구의 inputSchema 추출
  3. **ajv 로 각 inputSchema 를 JSON Schema(draft) 메타스키마에 대해 컴파일하여 스키마 자체가 유효한 JSON Schema 인지 검증** (zod→JSON Schema 변환 산출물 무결성)
  4. **tools/list 응답 전체를 Jest/vitest snapshot 으로 저장** 후, 릴리스 간 비교로 inputSchema drift(필드 추가/삭제/타입 변경) 감지
  5. (enum/required 값 자체의 정합성 단언은 TRX-01 로 위임 — 본 시나리오 비대상)
- **기대 결과**:
  - 3개 inputSchema 모두 ajv `compile()` 에서 예외 없이 통과(유효한 JSON Schema)
  - snapshot 저장 성공, 후속 릴리스에서 drift 발생 시 snapshot mismatch 로 감지
- **합격 기준**:
  - **(범위 축소 핵심)** 반환된 JSON Schema 자체가 ajv 로 유효성 검증을 통과 — zod→JSON Schema 변환 결과 무결성
  - snapshot drift 감지가 릴리스별로 동작(스키마 변경 시 알림)
  - 단순 enum/required 재확인은 TRX-01 에서 검증하며 본 시나리오는 중복하지 않음
- **신선도**: (a) mock 단위테스트는 등록 여부만 확인, zod→JSON Schema 변환 결과의 정확성을 미검증; 본 시나리오는 tools/list 반환 JSON Schema 를 ajv 로 검증하고 snapshot drift 를 감지해 API 소비자 관점에서 계약 안정성을 보장한다.
- **자동화 힌트**: tools/list 응답을 Jest snapshot 으로 저장 후 릴리스별 스키마 drift 감지에 활용. ajv 로 반환된 JSON Schema 자체의 유효성도 검증.

---

### 6.4 conflict-policies

> **차원 개요**: 충돌 생애주기를 실제 MCP stdio 도구 경계에서 검증한다. `TWO_MACHINE` 픽스처로 동일 logicalKey 양측 발산을 생성하고, `wormhole_status` 의 conflicts[] 구조 정합성, `wormhole_resolve` 의 세 정책(preserve-both/latest-wins/manual) 실 적용 효과, keys 부분집합 필터, policy 생략 시 config.conflictPolicy 폴백, isDeletionConflict 경로, `wormhole_sync` confirm:true 자동 해소 파이프라인을 도구 call/response JSON 레벨에서 검증한다.

#### CFL-01 · 양측 발산 후 wormhole_status 가 conflicts[] 를 완전한 구조로 노출하는가  `P0`

- **전제조건**:
  - `TWO_MACHINE`: 머신A(HOME_A, stateDir_A) + 머신B(HOME_B, stateDir_B), 동일 WEBDAV 원격, 동일 passphrase
  - `WRITABLE_WEBDAV`: 로컬 dufs/Caddy 등 쓰기 가능 WebDAV
  - `STDIO_RPC_CLIENT`: `server.mjs` 를 stdio 로 기동해 JSON-RPC 호출 가능
  - 픽스처: `HOME_A/.claude/CLAUDE.md = 'content-A'`, `HOME_B/.claude/CLAUDE.md = 'content-B'` (서로 다른 내용)
  - 머신A 에서 `wormhole_sync {"confirm": true}` 선행 실행하여 원격에 content-A 업로드
  - 머신B 에서는 아직 sync 없음 — state.json 비어있어 baseHash=null
- **대상 도구**: `wormhole_status`, `wormhole_sync`
- **절차**:
  1. 머신A: tools/call `wormhole_sync {"confirm": true}` — 원격에 CLAUDE.md(content-A) 업로드(push 단계)
  2. 머신B: `HOME_B/.claude/CLAUDE.md` 에 'content-B' 기록
  3. 머신B: tools/call `wormhole_sync {"confirm": true}` — 머신B 의 content-B 를 원격 반영(push 단계, 기존 generation 위에 덮어씀, machineId=B)
  4. 머신A: `HOME_A/.claude/CLAUDE.md` 를 'content-A-modified' 로 로컬 수정
  5. 머신A: tools/call `wormhole_status {}` — 충돌 감지 확인
  6. 응답 `structuredContent.conflicts` 배열 검사
- **기대 결과**:
  - `structuredContent.conflicts` 배열 길이 >= 1
  - `conflicts[0].logicalKey === '.claude/CLAUDE.md'`
  - `conflicts[0].localHash !== null` (content-A-modified 해시)
  - `conflicts[0].remoteHash !== null` (content-B 해시)
  - `conflicts[0].remoteMachineId === machineId_B`
  - `conflicts[0].remoteGeneration >= 1`
  - `conflicts[0].isDeletionConflict === false`
  - `structuredContent.summary.conflicts` 배열에 '.claude/CLAUDE.md' 포함
  - `structuredContent.items` 중 kind==='conflict' 항목 존재
  - isError 필드 없음 또는 false
- **합격 기준**:
  - conflicts[] 비어있지 않음
  - ConflictItem 의 모든 6개 필드(logicalKey/localHash/remoteHash/remoteMachineId/remoteGeneration/isDeletionConflict) 가 null 이 아닌 적절한 값으로 채워짐
  - `isDeletionConflict === false` (양측 모두 실존 파일)
  - summary.conflicts 와 items[kind=conflict] 가 일치함
- **신선도**: (a)는 mock 엔진이라 실제 TWO_MACHINE 발산 와이어 없음, (b)는 충돌 없는 단일 해피패스만 다루므로 conflict 감지 경로 자체가 미검증임.
- **자동화 힌트**: 두 HOME 을 임시 디렉터리로 잡고 로컬 dufs(`--allow-all`) + 두 `server.mjs` 프로세스(각각 HOME 다름)를 `node:child_process.spawn` 으로 기동. JSON-RPC stdin/stdout 통신.

#### CFL-02 · wormhole_resolve preserve-both confirm:true — conflictCopies 경로 기록, 로컬 원본 무변경  `P0`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - CFL-01 픽스처 완료 상태: 머신A 기준 '.claude/CLAUDE.md' 에 conflict 존재
  - 머신A state.json 에 CLAUDE.md baseHash = content-A 해시 (초기 push 이후 상태)
  - 원격 manifest 에 CLAUDE.md = content-B (머신B push 기준)
- **대상 도구**: `wormhole_resolve`
- **절차**:
  1. 머신A: tools/call `wormhole_resolve {"policy": "preserve-both", "confirm": false}` — dryRun 미리보기
  2. 응답 payload.note 존재 확인 + resolved 키 목록 확인 (dryRun 이므로 conflictCopies=[])
  3. 머신A: `HOME_A/.claude/CLAUDE.md` 원본 내용(content-A-modified) 스냅샷
  4. 머신A: tools/call `wormhole_resolve {"policy": "preserve-both", "confirm": true}` — 실 적용
  5. 응답 structuredContent 검사
  6. 머신A 파일시스템에서 `HOME_A/.claude/CLAUDE.md` 내용 읽기
  7. 머신A 파일시스템에서 `conflictCopies[0].copyPath` 파일 존재 및 내용 확인
- **기대 결과**:
  - dryRun 응답: payload.note 포함, `structuredContent.conflictCopies === []` (미리보기 시 빈 배열 — planResolve 코드 상 conflictCopies:[] 반환)
  - confirm:true 응답: `structuredContent.policy === 'preserve-both'`
  - `structuredContent.resolved` 배열에 '.claude/CLAUDE.md' 포함
  - `structuredContent.conflictCopies` 길이 >= 1
  - `conflictCopies[0].logicalKey === '.claude/CLAUDE.md'`
  - `conflictCopies[0].copyPath` 가 `.conflict-<machineId_B>-<gen>` 접미사 포함
  - `HOME_A/.claude/CLAUDE.md` 내용 === 'content-A-modified' (로컬 원본 무변경)
  - `conflictCopies[0].copyPath` 파일 내용 === 'content-B' (원격본 보존)
  - `backupDir === null` (preserve-both 는 백업 안 만듦 — 코드상 latest-wins 만 backupDir 채움)
- **합격 기준**:
  - dryRun 시 conflictCopies=[] 이고 note 필드 존재
  - confirm:true 시 로컬 CLAUDE.md 바이트가 변경 전과 동일
  - 원격 사본 파일이 disk 에 실존하고 content-B 내용
  - copyPath 파일명이 sanitizeToken 패턴(`.conflict-{alphanumeric_}-{alphanumeric_}`) 으로 구성됨
  - `backupDir === null`
- **신선도**: (a)는 mock 이므로 실제 disk 사본 생성 미검증, (b)는 충돌 시나리오 없음 — preserve-both 의 실제 파일시스템 사이드이펙트가 최초 검증.

#### CFL-03 · wormhole_resolve latest-wins confirm:true — 원격 우선 채택, backupDir 생성  `P0`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - CFL-01 픽스처 완료 상태: 머신A 에 '.claude/CLAUDE.md' conflict 존재
  - 머신A 로컬 CLAUDE.md = 'content-A-modified', 원격 = 'content-B'
- **대상 도구**: `wormhole_resolve`
- **절차**:
  1. 머신A: `HOME_A/.claude/CLAUDE.md` 내용 스냅샷 기록 ('content-A-modified')
  2. 머신A: tools/call `wormhole_resolve {"policy": "latest-wins", "confirm": true}`
  3. 응답 structuredContent 검사
  4. 머신A 파일시스템에서 `HOME_A/.claude/CLAUDE.md` 내용 읽기
  5. 머신A state.json 의 '.claude/CLAUDE.md' 엔트리 syncedHash 확인
  6. backupDir 경로 내 CLAUDE.md 백업 파일 존재 확인
- **기대 결과**:
  - `structuredContent.policy === 'latest-wins'`
  - `structuredContent.resolved` 배열에 '.claude/CLAUDE.md' 포함
  - `structuredContent.conflictCopies === []` (latest-wins 는 사본 생성 안 함)
  - `structuredContent.backupDir !== null` (이전 로컬 파일을 `backups/<runTs>/` 에 보존)
  - `HOME_A/.claude/CLAUDE.md` 내용 === 'content-B' (원격 우선 채택)
  - backupDir 경로 내 CLAUDE.md 에 'content-A-modified' 내용 존재 (이전 로컬 보존)
- **합격 기준**:
  - 로컬 CLAUDE.md 내용이 content-B 로 교체됨
  - backupDir 가 null 이 아니고 해당 경로가 disk 에 실존
  - 백업 파일에 content-A-modified 내용 보존
  - `conflictCopies === []`
  - 이후 `wormhole_status` 에서 conflicts[] === [] (충돌 해소됨 — state watermark 전진)
- **신선도**: (a) mock 단위는 'latest-wins' 분기 mock 매핑만 검증, 실제 로컬 파일 교체+backupDir 파일시스템 효과는 미검증.

#### CFL-04 · wormhole_resolve manual policy — resolved=[], conflictCopies=[], 충돌 잔존  `P1`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - CFL-01 픽스처 완료 상태: 머신A 에 '.claude/CLAUDE.md' conflict 존재
- **대상 도구**: `wormhole_resolve`, `wormhole_status`
- **절차**:
  1. 머신A: tools/call `wormhole_resolve {"policy": "manual", "confirm": true}`
  2. 응답 structuredContent 검사
  3. 머신A: tools/call `wormhole_status {}` — 충돌 잔존 여부 확인
  4. 머신A 파일시스템에서 `HOME_A/.claude/CLAUDE.md` 내용 변경 없음 확인
- **기대 결과**:
  - `wormhole_resolve` 응답: `structuredContent.policy === 'manual'`
  - `structuredContent.resolved === []` (manual 은 자동 처리 금지 — engine.ts:775 코드)
  - `structuredContent.conflictCopies === []`
  - `structuredContent.backupDir === null`
  - isError 없음 (에러 아님, 정상 응답)
  - 후속 `wormhole_status`: conflicts[] 에 '.claude/CLAUDE.md' 여전히 존재 (미해소)
  - `HOME_A/.claude/CLAUDE.md` 내용 변경 없음
- **합격 기준**:
  - resolved=[] 이고 isError 없음 — manual 은 에러가 아닌 no-op 정상 응답
  - policy 필드가 'manual' 로 에코됨
  - 후속 status 에서 동일 logicalKey 가 conflict 로 분류됨 (state watermark 미전진 확인)
  - 파일시스템 무변경
- **신선도**: (a) mock 은 manual 분기가 엔진에 전달되는지만 확인, 실제 no-op 반환 구조와 후속 status 에서 충돌 잔존 여부는 미검증.

#### CFL-05 · wormhole_resolve keys 부분집합 — 지정 키만 해소, 나머지 충돌 잔존  `P1`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - 두 개의 logicalKey 에 동시 충돌 생성:
    - key-A: '.claude/CLAUDE.md' — 머신A='content-A', 원격='content-B'
    - key-B: '.claude/skills/foo.md' — 머신A='skill-A', 원격='skill-B'
  - 머신A `wormhole_status` 에서 conflicts 길이 === 2 확인
- **대상 도구**: `wormhole_resolve`, `wormhole_status`
- **절차**:
  1. 머신A: tools/call `wormhole_status {}` — conflicts 2개 확인
  2. 머신A: tools/call `wormhole_resolve {"policy": "latest-wins", "keys": [".claude/CLAUDE.md"], "confirm": true}`
  3. 응답 structuredContent 검사 (resolved 1개만)
  4. 머신A: tools/call `wormhole_status {}` — 잔존 충돌 확인
- **기대 결과**:
  - resolve 응답: `structuredContent.resolved === ['.claude/CLAUDE.md']` (1개만)
  - `structuredContent.resolved` 에 '.claude/skills/foo.md' 미포함
  - 후속 `wormhole_status`: conflicts[] 길이 === 1
  - 후속 `wormhole_status`: `conflicts[0].logicalKey === '.claude/skills/foo.md'` (잔존)
  - `HOME_A/.claude/CLAUDE.md` 내용 === 원격 'content-B' (latest-wins 적용됨)
  - `HOME_A/.claude/skills/foo.md` 내용 === 'skill-A' (미변경)
- **합격 기준**:
  - resolved 배열에 keys 인자 기준 해소된 키만 포함됨
  - keys 에 없는 키는 state watermark 미전진 — 후속 status 에서 conflict 잔존
  - 파일시스템 효과가 keys 인자에 정확히 대응함
- **신선도**: (a)(b)(c) 모두 keys 부분집합 필터 기능을 전혀 다루지 않음 — selectConflicts 로직의 최초 실 검증.

#### CFL-06 · wormhole_resolve policy 생략 시 config.conflictPolicy 기본값 폴백 적용  `P1`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - 머신A config.json 에 `conflictPolicy: 'latest-wins'` 명시
  - CFL-01 픽스처와 동일하게 '.claude/CLAUDE.md' conflict 생성
  - 머신A `wormhole_status` 에서 conflict 확인
- **대상 도구**: `wormhole_resolve`
- **절차**:
  1. 머신A: tools/call `wormhole_resolve {"confirm": true}` — policy 파라미터 생략
  2. 응답 structuredContent 검사
  3. `HOME_A/.claude/CLAUDE.md` 내용 확인 (원격 우선 채택이면 latest-wins 폴백 동작 확인)
- **기대 결과**:
  - `structuredContent.policy === 'latest-wins'` (config.conflictPolicy 에서 폴백)
  - `structuredContent.resolved` 배열에 '.claude/CLAUDE.md' 포함
  - `HOME_A/.claude/CLAUDE.md` 내용 === 원격 content-B (latest-wins 효과)
  - isError 없음
- **합격 기준**:
  - policy 필드가 config.conflictPolicy 값과 일치 ('latest-wins')
  - 파일시스템 효과가 latest-wins 와 동일 (로컬 교체)
  - policy 를 preserve-both 로 바꾼 별도 config 로 재실행 시 preserve-both 효과 관찰 (선택 교차 검증)
- **신선도**: (a) mock 은 policy=undefined 인자 전달 시 엔진 메서드 매핑만 확인, config.conflictPolicy 값이 실제로 정책 분기에 영향 주는지는 미검증.

#### CFL-07 · 삭제 충돌(isDeletionConflict=true) — 원격 tombstone vs 로컬 수정, preserve-both 마커 생성  `P1`

- **전제조건**:
  - `TWO_MACHINE` + `WRITABLE_WEBDAV` + `STDIO_RPC_CLIENT`
  - 초기 상태: 양측 모두 '.claude/CLAUDE.md' sync 완료, 동기화됨
  - 머신B: `HOME_B/.claude/CLAUDE.md` 삭제 후 `wormhole_sync {"confirm": true}` (tombstone 원격 기록)
  - 머신A: `HOME_A/.claude/CLAUDE.md` 를 'content-A-modified' 로 수정 (삭제 전 기록된 base 기준 로컬 변경)
- **대상 도구**: `wormhole_status`, `wormhole_resolve`
- **절차**:
  1. 머신A: tools/call `wormhole_status {}` — isDeletionConflict 확인
  2. 머신A: tools/call `wormhole_resolve {"policy": "preserve-both", "confirm": true}`
  3. 응답 structuredContent 검사
  4. `HOME_A/.claude/CLAUDE.md` 존재 여부 및 내용 확인
  5. 마커 파일(`.conflict-deleted-<machineId_B>-<gen>`) 존재 확인
- **기대 결과**:
  - `wormhole_status`: `conflicts[0].isDeletionConflict === true`
  - `wormhole_status`: `conflicts[0].remoteHash === null` (tombstone 이므로)
  - `wormhole_status`: `conflicts[0].localHash !== null` (로컬 수정본 존재)
  - `wormhole_resolve` 응답: `structuredContent.resolved` 에 '.claude/CLAUDE.md' 포함
  - `conflictCopies[0].copyPath` 가 `.conflict-deleted-<sanitizedMachineId>-<gen>` 패턴
  - `HOME_A/.claude/CLAUDE.md` 내용 === 'content-A-modified' (로컬 보존)
  - 마커 파일 내용에 '원격' + '삭제' 관련 텍스트 포함
- **합격 기준**:
  - isDeletionConflict=true 가 `wormhole_status` JSON 에 올바르게 노출
  - preserve-both 하에서 로컬 파일 보존됨 (삭제 안 됨)
  - 마커 파일이 `.conflict-deleted-` 접두사로 disk 에 생성됨
  - 마커 파일 경로가 HOME 내부임 (경로 탈출 방어 통과)
- **신선도**: (a)(b)(c) 어느 쪽도 isDeletionConflict 경로를 다루지 않음 — tombstone vs 로컬 수정 발산 시 flags + 마커 파일 생성의 최초 도구 경계 검증.

#### CFL-08 · preserve-both resolve 멱등성 — 2회 실행 시 conflictCopies 사본 중복 미생성  `P1`

> gaps 패치 신규 시나리오 — conflict-policies 차원 보강.

- **전제조건**:
  - `TWO_MACHINE` 또는 단일 머신 + 인위 충돌 주입(원격 manifest 에 머신 외부 generation 의 비삭제 충돌 1건; 로컬 동일 logicalKey 가 다른 hash)
  - `WRITABLE_WEBDAV` (resolve 는 blob 다운로드 필요 — downloadBlob 가 원격 blob 접근)
  - `STDIO_RPC_CLIENT` 또는 `MCP_INSPECTOR`
- **대상 도구**: `wormhole_resolve`, `wormhole_status`
- **절차**:
  1. 1차: tools/call `wormhole_resolve {policy:'preserve-both', confirm:true}` 호출 → conflictCopies 1건 생성(`copyPath = '<absPath>.conflict-{mid}-{gen}'`)
  2. 생성된 copyPath 파일의 mtime/inode 또는 바이트 스냅샷 기록
  3. preserve-both 는 watermark 미전진(runResolve 753-867)이라 충돌 잔존 → status 로 conflicts 동일 확인
  4. 2차: 동일 `wormhole_resolve {policy:'preserve-both', confirm:true}` 재호출
  5. runResolve 의 `fs.access(copyPath)` 존재검사 가드 → 이미 존재하면 atomicWriteFile 생략, conflictCopies 에는 동일 copyPath push
  6. copyPath 파일이 재기록되지 않았는지(mtime 불변) + 추가 사본 파일(`.conflict-...-2` 등) 미생성 확인
- **기대 결과**:
  - 1차 후 conflictCopies 1건, copyPath 파일 존재, backupDir null
  - 1차/2차 사이 `wormhole_status.summary.conflicts` 동일(preserve-both watermark 미전진)
  - 2차 ResolveResult.conflictCopies 가 동일 copyPath 반환(중복 경로 없음, 새 인덱스 접미사 미생성)
  - copyPath 파일 mtime/바이트 1차와 동일(재기록 생략) — atomicWriteFile 미호출
- **합격 기준**:
  - 2차 호출 후 디스크상 `.conflict-{mid}-{gen}` 파일이 정확히 1개(중복 사본 0)
  - copyPath mtime 1차 == 2차(재기록 없음, fs.access 가드 발동)
  - 양 호출 모두 isError 없음 + backupDir null
  - conflicts 카운트가 두 호출 전후 불변(멱등 = 부작용 누적 없음)
- **신선도**: preserve-both 는 base 미전진으로 충돌 잔존→재호출 가능 상태 유지. 사본 멱등(fs.access 후 atomicWriteFile 생략) 가드를 2회 실행으로 검증하는 칸은 어느 시나리오도 미답. (b)해피 멱등은 pull no-op 이라 resolve 멱등과 별개.

---

### 6.5 settings-mcp-routing

> **차원 개요**: `settings.json` 의 머신 로컬키 분리 + `${HOME}` 토큰화 왕복, `.mcp.json` 의 self/wormhole 제외 + 비-self remote-wins, contentHash 안정성(영구 modified 루프 부재), 비밀 파일 업로드 제외를 실제 MCP stdio 경계(tools/call JSON-RPC)에서 검증한다. mock 엔진이 아닌 `server.mjs` 를 stdio 로 기동하고 `WRITABLE_WEBDAV` + `TWO_MACHINE` 환경에서 원격 blob/PROPFIND 를 직접 관측한다.

#### SMR-01 · settings.json 로컬키 push 격리 — 원격 blob 에 mcpServers.*.command/args/cwd/env, permissions.*, hooks, statusLine.command 누락 확인  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 dufs/rclone serve webdav 등 ETag 지원 쓰기가능 서버
  - `STDIO_RPC_CLIENT`: `@modelcontextprotocol/inspector` 또는 직접 JSON-RPC stdio 클라이언트
  - 머신 A HOME 에 `~/.claude/settings.json` 준비:
    ```json
    {
      "mcpServers": { "my-tool": { "command": "/usr/local/bin/mytool", "args": ["--port", "9000"], "cwd": "/home/alice/projects", "env": { "MY_ENV": "secret" } } },
      "theme": "dark",
      "model": "claude-opus-4-5",
      "permissions": { "allow": ["Bash"] },
      "hooks": { "PreToolUse": [] },
      "statusLine": { "command": "/home/alice/.local/bin/mystat" }
    }
    ```
  - `~/.wormhole/config.json` 및 `~/.wormhole/.env` 정상 설정(`WEBDAV_URL`/`USER`/`PASS`/`WORMHOLE_PASSPHRASE`)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. tools/call `wormhole_sync {"confirm": false}` — 미리보기 반환 확인
  2. tools/call `wormhole_sync {"confirm": true}` — 실제 sync(push 단계) 수행
  3. WebDAV PROPFIND `<remoteBaseDir>/blobs/` 로 업로드된 blob 파일명 목록 수집
  4. settings.json 에 해당하는 blob(`.claude/settings.json` 의 sha256 기반 이름)을 GET 후 age 복호+gunzip
  5. 복호된 평문 JSON 파싱
  6. tools/call `wormhole_status {}` — summary.unchanged 에 `.claude/settings.json` 포함 확인
- **기대 결과**:
  - step 2: `structuredContent.push.pushed` 에 `.claude/settings.json` 포함, push.dryRun: false
  - step 5 복호 평문 JSON: mcpServers 키 자체가 없거나 mcpServers.my-tool 이 없음 (로컬키 pruneLocal 제거)
  - step 5: permissions 키 없음, hooks 키 없음, statusLine.command 키 없음
  - step 5: `theme: "dark"`, `model: "claude-opus-4-5"` 는 존재 (공유 키 보존)
  - step 6: `structuredContent.summary.unchanged` 에 `.claude/settings.json` 포함 (contentHash 안정 = modified 루프 없음)
  - step 6: `structuredContent.summary.modified` 에 `.claude/settings.json` 미포함
- **합격 기준**:
  - blob 복호 JSON 에 mcpServers, permissions, hooks, statusLine.command 키가 없거나 pruneLocal 로 비워진 컨테이너가 없음
  - push 직후 `wormhole_status` 가 `.claude/settings.json` 을 unchanged 로 보고 (영구 modified 루프 부재)
  - theme/model 같은 공유 스칼라는 원격 blob 에 보존됨
- **신선도**: (a) mock 엔진 분기 테스트와 달리, 실제 MCP tools/call 경계로 push 하고 WebDAV blob 을 직접 복호해 로컬키 격리를 원격 와이어 레벨에서 증명한다.
- **자동화 힌트**: `STDIO_RPC_CLIENT` 로 tools/call JSON-RPC 후, `node -e` 로 blob GET + age-decrypt(wormhole 동일 KDF 파라미터) + JSON.parse 하여 키 존재 여부 assert.

#### SMR-02 · ${HOME} 토큰화 왕복 — 머신 A 홈경로가 blob 에 토큰으로 저장되고 머신 B pull 시 B 홈경로로 복원  `P0`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A(HOME=/home/alice) + 머신 B(HOME=/home/bob), 동일 원격 WebDAV, 동일 passphrase
  - `WRITABLE_WEBDAV`: ETag 지원 쓰기가능 서버
  - 머신 A `~/.claude/settings.json`: `{ "model": "claude-opus-4-5", "mcpServers": { "shared-tool": { "type": "stdio" } } }` — shared-tool 에 command/args 없음(공유 키만)
  - 머신 A `~/.claude/.mcp.json`: `{ "mcpServers": { "data-tool": { "command": "/home/alice/bin/datatool", "args": [] }, "wormhole": { "command": "/home/alice/.npm/bin/wormhole" } } }`
  - 머신 B 는 별도 stateDir, HOME=/home/bob, `~/.claude/.mcp.json` 미존재 또는 빈 상태
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 머신 A: tools/call `wormhole_sync {"confirm": true}`
  2. WebDAV GET `blobs/<.mcp.json blob 이름>` 후 age 복호+gunzip
  3. 복호 평문 JSON 에서 data-tool.command 값 확인
  4. 머신 B: tools/call `wormhole_sync {"confirm": true}`
  5. 머신 B `~/.claude/.mcp.json` 파일 내용 읽기
  6. 머신 B: tools/call `wormhole_sync {"confirm": false}` — 미리보기로 .mcp.json 상태 확인
- **기대 결과**:
  - step 3: `data-tool.command` 값이 `"${HOME}/bin/datatool"` (토큰화됨, /home/alice 제거)
  - step 3: wormhole 엔트리 없음 (self 제거)
  - step 5: `data-tool.command = "/home/bob/bin/datatool"` (머신 B HOME 으로 detokenize)
  - step 5: wormhole 엔트리는 머신 B 로컬 값 보존 (self 항목 원격에서 덮어쓰지 않음)
  - step 6: `structuredContent.push.pushed` 에 `.claude/.mcp.json` 미포함 또는 push.dryRun:true + push.pushed:[] (sync 직후 unchanged)
- **합격 기준**:
  - 원격 blob 에 /home/alice 리터럴 경로가 없고 `${HOME}` 토큰으로 저장됨
  - 머신 B .mcp.json 에 /home/bob 로 정확히 복원된 data-tool.command 존재
  - 머신 B .mcp.json 에 wormhole 엔트리 보존 (remote-wins 가 self 에 적용 안 됨)
  - 머신 B sync(pull 단계) 직후 sync 미리보기에서 .mcp.json 이 modified 로 잡히지 않음 (contentHash 안정)
- **신선도**: (b) 엔진 직접 호출 단일 HOME roundtrip 과 달리, `TWO_MACHINE` 환경에서 MCP tools/call 경계로 머신 A→원격→머신 B 의 `${HOME}` 토큰화 왕복을 실제 파일 내용으로 검증한다.

#### SMR-03 · contentHash 안정성 — push 직후 wormhole_status 가 settings.json/.mcp.json 을 modified 로 재분류하지 않음 (영구 modified 루프 부재)  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: ETag 지원 쓰기가능 서버
  - 머신 A: `~/.claude/settings.json` 에 공유 키(theme, model) + 로컬키(hooks, permissions.*) 혼재
  - 머신 A: `~/.claude/.mcp.json` 에 wormhole self 엔트리 + 비-self 엔트리 혼재
  - 첫 push 가 완료된 상태 (state.json, base 스냅샷 존재)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. tools/call `wormhole_sync {"confirm": true}` — 1차 sync (이미 완료 상태라면 스킵해도 됨)
  2. tools/call `wormhole_status {}` — status 조회 #1
  3. 로컬 settings.json / .mcp.json 파일을 수정하지 않음
  4. tools/call `wormhole_status {}` — status 조회 #2 (동일 파일, 변경 없음)
  5. tools/call `wormhole_sync {"confirm": false}` — sync 미리보기 (변경 없음 확인)
- **기대 결과**:
  - step 2: `structuredContent.items` 에서 `.claude/settings.json` 의 kind = "unchanged" 또는 "converged"
  - step 2: `structuredContent.items` 에서 `.claude/.mcp.json` 의 kind = "unchanged" 또는 "converged"
  - step 4: step 2 와 동일 결과 (결정적 해시, 호출 간 불변)
  - step 5: `structuredContent.push.pushed = []`, `structuredContent.push.dryRun = true`
  - step 5: `structuredContent.note` 포함 (미리보기 문자열)
- **합격 기준**:
  - 연속 `wormhole_status` 호출 2회에서 `.claude/settings.json`, `.claude/.mcp.json` 가 모두 unchanged/converged (modified 미출현)
  - sync 미리보기 결과 push.pushed 배열이 비어 있음
  - `wormhole_status` 의 summary.modified 카운트가 0 (로컬 파일 미변경 시)
- **신선도**: (a) mock 단위테스트는 normalizeSettingsForSync 호출 여부만 검증했으나, 이 시나리오는 실제 MCP 도구 경계에서 연속 status 호출로 해시 안정성을 관측한다. (b) e2e 는 두 번째 pull no-op 만 검증했고 settings 특수 라우팅 후 modified 루프는 미검증.

#### SMR-04 · settings.json 3-way 머지 — 머신 A 공유 키 변경이 머신 B 로컬키를 덮어쓰지 않음  `P1`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A + 머신 B, 동일 원격 WebDAV, 동일 passphrase
  - `WRITABLE_WEBDAV`
  - 초기 상태: 양 머신 동일 settings.json = `{ "theme": "light", "model": "claude-sonnet-4-5", "hooks": { "PreToolUse": [] }, "permissions": { "allow": [] } }`
  - 양 머신 모두 1회 sync 로 base 스냅샷 수립 완료
  - 머신 A: theme 을 "dark" 로 변경, model 을 "claude-opus-4-5" 로 변경 후 sync
  - 머신 B: hooks 를 `{ "PreToolUse": ["echo hook"] }` 로 변경, permissions.allow 에 "Bash" 추가 (로컬키만 수정)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신 A: tools/call `wormhole_sync {"confirm": true}` — theme/model 변경 반영(push 단계)
  2. 머신 B: tools/call `wormhole_sync {"confirm": true}` — 머신 A 변경 수신(pull 단계)
  3. 머신 B `~/.claude/settings.json` 파일 내용 직접 읽기
  4. 머신 B: tools/call `wormhole_status {}` — 결과 확인
  5. 머신 B: tools/call `wormhole_sync {"confirm": false}` — 미리보기 (추가 변경 없음 확인)
- **기대 결과**:
  - step 2: `structuredContent.pull.applied` 에 `.claude/settings.json` 포함, pull.conflicts = []
  - step 3: `theme = "dark"` (머신 A 공유 키 변경 반영)
  - step 3: `model = "claude-opus-4-5"` (머신 A 공유 키 변경 반영)
  - step 3: `hooks = { "PreToolUse": ["echo hook"] }` (머신 B 로컬키 보존)
  - step 3: `permissions.allow = ["Bash"]` (머신 B 로컬키 보존)
  - step 4: `.claude/settings.json` kind = "unchanged" 또는 summary.conflicts = 0
  - step 5: push.pushed = [] (pull 단계 후 추가 push 필요 없음)
- **합격 기준**:
  - pull 단계 결과 파일에 공유 키(theme/model) 는 원격 최신값으로 업데이트됨
  - pull 단계 결과 파일에 로컬키(hooks/permissions) 는 머신 B 로컬 값 그대로 보존됨
  - conflicts 배열 비어 있음 (로컬키 vs 원격 공유키 충돌 미발생)
  - sync(pull 단계) 직후 status 에서 settings.json 이 modified 로 잡히지 않음
- **신선도**: (b) e2e 해피패스는 동일 파일 바이트충실도만 검증했고, 이 시나리오는 `TWO_MACHINE` 에서 MCP 도구 경계로 공유 키 변경과 로컬키 독립 보존이 3-way 머지에서 올바르게 분리됨을 검증한다.

#### SMR-05 · .mcp.json self 엔트리 머신 간 격리 — 머신 B pull 후 B 자체 wormhole 엔트리 유지, 머신 A wormhole 엔트리 비적용  `P1`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A + 머신 B, 동일 원격 WebDAV, 동일 passphrase
  - `WRITABLE_WEBDAV`
  - 머신 A `~/.claude/.mcp.json`: `{ "mcpServers": { "wormhole": { "command": "/home/alice/.npm/bin/wormhole-mcp", "args": ["--config", "/home/alice/.wormhole/config.json"] }, "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }`
  - 머신 B `~/.claude/.mcp.json`: `{ "mcpServers": { "wormhole": { "command": "/home/bob/.local/bin/wormhole-mcp", "args": ["--config", "/home/bob/.wormhole/config.json"] } } }`
  - 양 머신 config.json 에 `selfMcpServerNames: ["wormhole"]`
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신 A: tools/call `wormhole_sync {"confirm": true}`
  2. WebDAV GET `blobs/<.mcp.json blob>` 후 age 복호, wormhole 키 존재 여부 확인
  3. 머신 B: tools/call `wormhole_sync {"confirm": true}`
  4. 머신 B `~/.claude/.mcp.json` 파일 내용 읽기
  5. 머신 B: tools/call `wormhole_status {}` 조회
- **기대 결과**:
  - step 2: 원격 blob JSON 에 mcpServers.wormhole 키 없음 (self 제거)
  - step 2: mcpServers.context7 존재 (비-self 공유됨)
  - step 4: `mcpServers.wormhole.command = "/home/bob/.local/bin/wormhole-mcp"` (머신 B 로컬 값 보존)
  - step 4: `mcpServers.context7.command = "npx"` (원격에서 수신한 비-self 엔트리 적용)
  - step 4: /home/alice 경로 문자열 없음 (머신 A wormhole 항목 미적용)
  - step 5: `.claude/.mcp.json` kind = "unchanged" (pull 후 stable)
- **합격 기준**:
  - 원격 blob 에 selfMcpServerNames 해당 키(wormhole) 없음
  - 머신 B 로컬 wormhole 엔트리가 pull 후에도 변경 없음 (command/args 보존)
  - 머신 A 의 context7 비-self 엔트리가 머신 B 에 remote-wins 로 적용됨
  - 머신 B .mcp.json 에 `${HOME}` 토큰 잔류 없음 (detokenize 완료)
- **신선도**: (a) mock 도구 테스트는 selfMcpServerNames 분기 존재만 확인했으나, 이 시나리오는 실제 MCP 도구 경계에서 `TWO_MACHINE` pull 후 로컬 wormhole 엔트리 보존을 파일 레벨로 증명한다.

#### SMR-06 · 비밀 파일 스캔 제외 확인 — .credentials.json, settings.local.json, *.token, *.key 가 push 대상에 포함되지 않음  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`
  - 머신 A HOME: `~/.claude/.credentials.json = { "token": "ghp_SUPERSECRET" }` 생성
  - 머신 A HOME: `~/.claude/settings.local.json = { "localOnly": true }` 생성
  - 머신 A HOME: `~/.claude/my.token = "tok_abc123"` 생성
  - 머신 A HOME: `~/.claude/age-key.key = "AGE-SECRET-KEY-..."` 생성
  - 머신 A HOME: `~/.claude/settings.json = { "model": "claude-opus-4-5" }` (정상 파일)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. tools/call `wormhole_sync {"confirm": false}` — 미리보기(dry-run) 계획 조회
  2. tools/call `wormhole_status {}` — 스캔 결과 확인
  3. tools/call `wormhole_sync {"confirm": true}` — 실제 sync(push 경로)
  4. WebDAV PROPFIND `<remoteBaseDir>/blobs/` 로 업로드 blob 목록 수집
  5. 각 blob 이름이 제외 대상 파일 logicalKey sha256 과 일치하는지 검사
- **기대 결과**:
  - step 1: `structuredContent.pushed` 에 `.claude/.credentials.json`, `.claude/settings.local.json`, `.claude/my.token`, `.claude/age-key.key` 미포함
  - step 1: `.claude/settings.json` 은 pushed 에 포함
  - step 2: `structuredContent.items` 에 .credentials.json, settings.local.json, my.token, age-key.key 관련 항목 없음
  - step 3: `structuredContent.pushed` 에 비밀 파일 경로 미포함
  - step 4: blob 목록에서 비밀 파일 해시 이름 미출현
- **합격 기준**:
  - `wormhole_sync {confirm:false}` pushed 배열에 DEFAULT_EXCLUDE 패턴 매칭 파일이 없음
  - `wormhole_sync {confirm:true}` 실행 후 원격 blob 디렉터리에 비밀 파일 blob 이름이 없음
  - `wormhole_status` items 배열에 비밀 파일 logicalKey 가 없음
- **신선도**: (b) e2e 해피패스는 CLAUDE.md/settings.json 양성 케이스만 검증했고, 이 시나리오는 MCP 도구 경계에서 DEFAULT_EXCLUDE 패턴의 실제 적용을 원격 blob 레벨까지 추적해 비밀 유출 부재를 증명한다.

#### SMR-07 · 로컬키 전용 컨테이너 빈 껍데기 누출 방지 — mcpServers 하위 공유 키 없을 때 원격 blob 에 mcpServers: {} 미포함  `P2`

- **전제조건**:
  - `WRITABLE_WEBDAV`
  - 머신 A `~/.claude/settings.json`: `{ "mcpServers": { "all-local": { "command": "/usr/bin/tool", "args": [], "cwd": "/tmp", "env": {} } }, "theme": "dark" }`
  - mcpServers.all-local 에 로컬키(command/args/cwd/env) 만 존재, 공유 키(type 등) 없음
  - config.json `settingsJson.localOnlyKeys = DEFAULT_SETTINGS_LOCAL_KEYS` (mcpServers.*.command/args/cwd/env 포함)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. tools/call `wormhole_sync {"confirm": true}`
  2. WebDAV GET `blobs/<settings.json blob>` 후 age 복호+gunzip
  3. 복호 평문 JSON 파싱, mcpServers 키 존재/내용 확인
  4. tools/call `wormhole_status {}` — settings.json 상태 확인
- **기대 결과**:
  - step 2 복호 JSON: mcpServers 키 자체가 없거나, 존재하더라도 {} 빈 객체 아님 (pruneLocal 의 빈 컨테이너 생략 로직 적용)
  - step 2 복호 JSON: `theme: "dark"` 존재 (공유 스칼라 보존)
  - step 4: `.claude/settings.json` kind = "unchanged" (sync 후 안정)
- **합격 기준**:
  - 원격 blob JSON 에 `mcpServers: {}` 빈 객체가 없음 — pruneLocal 이 로컬키만 있는 컨테이너를 부모까지 제거함을 증명
  - 공유 스칼라(theme)는 정상 보존됨
  - sync 후 status 에서 settings.json unchanged (contentHash 안정)
- **신선도**: (a) mock 테스트는 pruneLocal 분기가 실행되는지만 확인했고, 이 시나리오는 실제 MCP push 경로에서 원격 blob 복호 내용을 직접 검사해 빈 컨테이너 누출 부재를 와이어 레벨로 증명한다.
- **자동화 힌트**: blob GET + age decrypt + JSON.parse 후 `assert('mcpServers' in json === false || Object.keys(json.mcpServers).length > 0)`.

#### SMR-08 · settings.json 공유키 양측 발산 — pull 3-way 머지가 silent local-wins(충돌 미표면화)  `P1`

> gaps 패치 신규 시나리오 — settings-mcp-routing 차원 보강.

- **전제조건**:
  - `TWO_MACHINE` (머신 A/B = 별도 HOME+stateDir, 동일 `WRITABLE_WEBDAV` + 동일 passphrase)
  - 양 머신이 동일 base 스냅샷에서 출발(최초 1회 sync 로 base 정합)
  - 공유키 후보: settings.json 의 비-localKey leaf(예: 'theme' 또는 임의 shared scalar). settingsJson.localOnlyKeys(mcpServers.*.command/args/cwd/env, permissions.*, hooks, statusLine.command) 에 포함되지 않는 키여야 함
  - `STDIO_RPC_CLIENT` 두 인스턴스
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신 A: settings.json 공유키 theme='dark' 로 변경 후 `wormhole_sync {confirm:true}`
  2. 머신 B: 동일 공유키 theme='light' 로(base 와 다르게) 변경 — 양측이 base 대비 상이 변경(발산)
  3. 머신 B: `wormhole_sync {confirm:true}` 실행 → engine 이 applyPullSettings 의 threeWayMerge(local=light, remote=dark, base=원본) 수행
  4. settings-merge.ts mergeRecursive(153,209-210): 양측 상이 leaf → conflictKeys.push + local('light') 유지
  5. engine.ts:684-704: result.conflictKeys/hasConflict 미사용 — merged(local 유지분) 무조건 atomicWriteFile + nextState 정상 동기화 갱신
  6. 머신 B: 직후 `wormhole_status` 로 conflicts 표면화 여부 점검 + settings.json 실파일 theme 값 확인
- **기대 결과**:
  - 머신 B settings.json 의 theme 가 'light'(로컬값) 유지 — remote-wins 로 'dark' 덮이지 않음
  - PullResult.conflicts 에 settings.json 충돌이 ConflictItem 으로 올라오지 않음(엔진 충돌 시스템과 settings leaf 충돌은 분리)
  - 직후 `wormhole_status.summary.conflicts` 가 settings.json 기여분 증가 없음 — silent 처리
  - base 스냅샷이 mergedShared(local 유지분)로 갱신되어 다음 pull 에서 동일 키가 재충돌 분류되지 않음(조용히 수렴)
- **합격 기준**:
  - settings.json deep-equal: theme === 'light'(로컬 보존), 나머지 키는 정상 머지
  - PullResult.conflicts 길이에 settings.json logicalKey 부재
  - `wormhole_status` 응답에서 settings.json 의 kind 가 conflict 아님(converged 또는 modified-없음)
  - 재현: 두 번째 `wormhole_sync` 가 동일 키로 충돌/변경 재발생 안 함(base 전진 확인)
- **신선도**: SMR-04(공유키 vs 로컬키 비충돌 분리) 미답. 동일 공유 leaf 양측 발산 시 settings-merge 의 conflictKeys 가 엔진 표면으로 전파되지 않고 silent local-wins 로 적용되는 라우팅×충돌 교차점. critic 가정(충돌분류 또는 remote-wins) 둘 다와 다른 실제 동작 실증.

#### SMR-09 · 악성 원격 blob 의 __proto__/constructor/prototype 페이로드가 pull 경로(detokenize/mergeRecursive/deepAssign) 가드에 차단되어 Object.prototype 무오염  `P0`

- **갭 클로저**: F-SETTINGS-14
- **전제조건**:
  - 환경 라벨: CORRUPT_REMOTE + TWO_MACHINE. 머신A 가 정상 push 로 원격 vault(keyparams.json + blobs)를 부트스트랩한 상태. 머신B 는 동일 passphrase 를 가진 별도 STATEDIR/HOME 로 STDIO_RPC_CLIENT 부착.
  - 테스트가 passphrase 를 보유하므로 머신B 와 동일한 age recipient 로 임의 평문을 armored 암호문으로 직접 만들 수 있음(crypto.encrypt 등가). 원격 keyparams.json 의 salt/N/r/p 로 동일 identity 재파생 가능.
  - 공격 대상 키: settings.json(isSettingsKey → applyPullSettings, threeWayMerge 경로) 과 .mcp.json(isMcpJsonKey → applyPullMcpJson → mergeMcpJsonForPull 경로) 둘 다.
  - 코드 불변 확인(직접 read): `src/sync/settings-merge.ts` FORBIDDEN_KEYS={__proto__,constructor,prototype}(L15) + isForbiddenKey(L16). pull 측 가드 지점 — detokenizeHome L62(continue), mergeRecursive L169(continue), deepAssign L433(continue), mergeMcpJsonForPull 내 detokenizeHome 호출 L355. `src/sync/engine.ts` applyPullSettings L667(threeWayMerge L684 + detokenizeHome L692), applyPullMcpJson L707(mergeMcpJsonForPull L721).
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신A: tools/call wormhole_sync {"confirm":true} 로 정상 settings.json + .mcp.json shared subset 을 원격에 업로드해 vault 부트스트랩(push 단계). (또는 buildEngine 직접 push) 원격에 blobs/<settings 키>, blobs/<mcp 키>, manifest, keyparams.json 존재 확인.
  2. 공격 페이로드 준비(테스트 하니스, MCP 외부): settings 용 평문 JSON = {"__proto__":{"polluted":"SETTINGS_PWNED"},"constructor":{"prototype":{"polluted2":"x"}},"fontSize":99} 을 머신B recipient 로 age armored 암호화 → 원격 blobs 의 settings 키 blob 을 이 암호문으로 직접 덮어씀(CORRUPT_REMOTE 주입). 동일하게 .mcp.json 용 평문 = {"__proto__":{"polluted":"MCP_PWNED"},"mcpServers":{"evil":{"command":"x","__proto__":{"polluted3":"y"}}}} 을 암호화해 mcp 키 blob 을 덮어씀. manifest 의 contentHash/generation 도 머신B 가 변경 감지하도록 정합 갱신(또는 generation 증가).
  3. 머신B: tools/call wormhole_sync {"confirm":true}. pull 단계의 applyPull 이 downloadBlob 로 악성 암호문 복호 → settings 는 parseJson → tokenizeHome(local) → threeWayMerge(L684, mergeRecursive L169 가드 통과) → detokenizeHome(L692, L62 가드) → applyShared→deepAssign(L433 가드). .mcp.json 은 mergeMcpJsonForPull(L721) → detokenizeHome(L355) → deepAssign(deepAssign L433 미경유나 detokenize/구조복제 가드).
  4. 동일 머신B 프로세스(또는 동일 Node 런타임) 에서 즉시 오염 프로브: ({}).polluted, ({}).polluted2, ({}).polluted3, Object.prototype.polluted 가 전부 undefined 인지 검사. (MCP 서버가 별도 프로세스면 pull 직후 동일 프로세스 내 후속 tools/call 이 정상 응답하는지로 간접 관측).
  5. tools/call wormhole_status {} 로 pull 후 엔진이 정상 동작(다음 RPC 응답 정상, 크래시 없음)임을 확인.
- **기대 결과**:
  - wormhole_sync 응답이 정상 종료 — isError 없음(또는 무결성/머지 실패 시에도 graceful error 반환이지 프로세스 크래시 아님).
  - 오염 프로브 전부 undefined: ({}).polluted===undefined, ({}).polluted2===undefined, ({}).polluted3===undefined, Object.prototype.polluted===undefined. Object.prototype 에 어떤 신규 enumerable 키도 추가되지 않음.
  - 로컬 settings.json 에는 __proto__/constructor/prototype 키가 자기 프로퍼티로 기록되지 않음 — 이 키들은 detokenizeHome(L62)/mergeRecursive(L169)/deepAssign(L433) 의 isForbiddenKey continue 로 결과 객체에서 누락됨. 무해한 키(fontSize:99 등)는 원격 우선으로 정상 머지 반영 가능.
  - 로컬 .mcp.json 머지 결과에 __proto__ 자기 프로퍼티 없음. evil.command 같은 무해 키는 보존되나 중첩 __proto__ 는 detokenize 단계서 제거.
  - pull 직후 wormhole_status 응답 정상 — 엔진 프로세스 생존, 후속 RPC 처리 가능.
- **합격 기준**:
  - sync tools/call 결과 isError 가 truthy 가 아니거나, 무결성 사유로 isError 면 응답 본문이 명시적 오류 메시지(크래시·미정의 동작 아님).
  - sync(pull 단계) 완료 후 동일 런타임의 4개 오염 프로브가 모두 strictly undefined.
  - Object.getOwnPropertyNames(Object.prototype) 에 polluted/polluted2/polluted3 미포함.
  - 후속 wormhole_status tools/call 이 정상 응답(엔진 생존 증명).
- **신선도**: 기존 67 시나리오 중 SMR-09 본문을 전면 대체(REVISE). 기존 SMR-09 는 push 측 tokenizeHome 가드(L40)만 행사해 송신 경로 한쪽만 증명 → 본 재증명은 ★pull 측 detokenizeHome(L62)+mergeRecursive(L169)+deepAssign(L433)★ 3지점 가드를 신뢰불가 원격 blob 으로 직접 행사. (a) push 단방향 → 양방향(pull 까지) 커버, (b) tokenize 단일 가드 → detokenize/merge/deepAssign 3가드 + .mcp.json 경로 추가, (c) settings.json 단일 파일 → settings + .mcp.json 두 적용 경로 동시. CORRUPT_REMOTE 직접 암호화 주입(테스트 passphrase 보유)으로 black-box 관측. 줄끝 (재증명 강화) 표기.

#### SMR-10 · 로컬 settings.json 파싱실패 push 복원 — preparePushSettings/normalizeSettingsForSync 가 JSON.parse 실패 시 throw 없이 원본 바이트로 hash/size 산출  `P2`

- **갭 클로저**: F-SETTINGS-06 — normalizeSettingsForSync(L312-331)의 try/catch 폴백이 비-JSON 로컬 settings 를 isError 없이 원본 바이트(Buffer.from(rawText)) 기준 hash/size 로 처리, push 미리보기가 정상 분류됨을 실증
- **전제조건**:
  - WRITABLE_WEBDAV 단일 머신, server.mjs 부팅 가능(buildEngine 전 단계 통과)
  - 로컬 ~/.claude/settings.json 을 비-JSON 텍스트 '{broken' 로 기록(JSON.parse 시 SyntaxError 유발)
  - config.json 의 settings 동기화 대상에 settings.json 포함, settingsJson.localOnlyKeys 설정됨
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR 준비
- **대상 도구**: `wormhole_status`, `wormhole_sync`
- **절차**:
  1. 로컬 ~/.claude/settings.json 내용을 '{broken'(닫히지 않은 비-JSON)으로 설정
  2. 파일 mtime/내용 스냅샷 기록(후속 부작용 관측용)
  3. STDIO_RPC_CLIENT: tools/call wormhole_status {} 호출 → scanWithHashes→normalizeSettingsForSync(L49991) 경로가 settings.json 을 catch 폴백으로 원본바이트 해시
  4. STDIO_RPC_CLIENT: tools/call wormhole_sync {"confirm":false} 호출 → 미리보기 분기의 push planPush(dryRun) 경로, preparePushSettings 미호출(dryRun 은 status.summary 분류만) 확인
  5. sync{confirm:false} 응답 관측 후 로컬 settings.json 파일 내용·mtime 재확인 — '{broken' 그대로인지(영구 modified 부작용 없음)
- **기대 결과**:
  - wormhole_status 응답: isError 없음. structuredContent = {summary:{added/modified/deleted/remoteAdded/remoteModified/remoteDeleted/unchanged}, conflicts:[], manifestGeneration}. settings.json 논리키가 added 또는 modified 에 분류(원본바이트 해시가 원격과 불일치 시), unchanged 에는 미포함
  - wormhole_sync{confirm:false} 응답: isError 없음. structuredContent = {pull:{...,dryRun:true}, push:{dryRun:true, pushed:[...], deleted:[], skipped:number, manifestGeneration, conflicts:[]}, note:'미리보기 — 실제 적용하려면 confirm:true (사용자 확인 후)'}. push.pushed 에 settings.json 포함 가능
  - normalizeSettingsForSync 가 throw 하지 않음 — JSON.parse catch 에서 {text:rawText('{broken'), hash:sha256(Buffer.from('{broken')), size:7} 반환(원본 7바이트)
  - 로컬 settings.json 파일은 '{broken' 원본 유지 — status/sync-preview 경로는 파일을 재기록하지 않으므로 영구 modified 부작용 없음(atomicWriteFile 은 runPush/runPull 적용 단계에서만 호출)
- **합격 기준**:
  - wormhole_status 와 wormhole_sync{confirm:false} 둘 다 응답 객체에 isError 속성 없음(파싱실패가 핸들러 try/catch→isError 로 새지 않음)
  - sync 응답 structuredContent.note 가 정확히 '미리보기 — 실제 적용하려면 confirm:true (사용자 확인 후)' 이고 push.dryRun:true
  - 호출 전후 로컬 settings.json 의 바이트열·내용이 '{broken' 으로 불변(mtime 변화 무관하게 내용 동일)
  - settings.json 논리키가 status.summary.unchanged 에 없음(파싱실패해도 동기화 후보로 정상 분류됨)
- **신선도**: 기존 SMR-01~08 은 정상 JSON settings 의 머지·정규화·멱등성을 다루지만 비-JSON 로컬 settings 의 push 폴백(throw 없이 원본바이트 해시)과 미리보기 무부작용을 검증하는 케이스가 없으며, (a)(b)(c) 어느 것도 손상 입력에 대한 graceful degradation 을 표적하지 않는다.

#### SMR-11 · pull 로컬 .mcp.json 부재/손상 복구 — mergeMcpJsonForPull 이 localText null 일 때 원격기반+self비움 상태를 stableStringify 로 복구 산출(throw 없음)  `P2`

- **갭 클로저**: F-SETTINGS-13 — mergeMcpJsonForPull(L340-396)의 local===null 분기(L375 return stableStringify(remote))가 로컬 .mcp.json 부재/파싱실패 시 원격 비-self 엔트리 기반으로 복구 가능한 .mcp.json 을 throw 없이 재생성함을 실증
- **전제조건**:
  - TWO_MACHINE: 머신A/머신B 별도 HOME+stateDir, 동일 원격+passphrase
  - 머신A 가 비-self 서버 엔트리(예: {"mcpServers":{"other":{"command":"node","args":["${HOME}/x.js"]}}})를 포함한 .mcp.json 을 sync{confirm:true} 로 원격에 올림(push 단계에서 stripSelfMcpServers 로 self/wormhole 제거+tokenize 상태)
  - 머신B 의 selfMcpServerNames 에 'wormhole' 포함, config.home 설정됨
  - 머신B STDIO_RPC_CLIENT/MCP_INSPECTOR 부팅 가능
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 케이스1(손상): 머신B 로컬 ~/.claude/.mcp.json 을 '{broken' 으로 기록 / 케이스2(부재): 머신B 로컬 .mcp.json 삭제
  2. 머신B STDIO_RPC_CLIENT: tools/call wormhole_status {} 호출 → remoteAdded/remoteModified 에 .mcp.json 분류 확인
  3. 머신B STDIO_RPC_CLIENT: tools/call wormhole_sync {"confirm":true} 호출 → pull 단계의 applyPullMcpJson(L50369)→fs.readFile catch 시 localText=null→mergeMcpJsonForPull(L377) 경로 실행
  4. 머신B 로컬 ~/.claude/.mcp.json 재생성 내용 관측 — 원격 'other' 엔트리 존재, 'wormhole'(self) 엔트리 비거나 로컬 기본
  5. 재생성 파일을 JSON.parse 하여 유효 JSON(복구가능)인지, ${HOME} 토큰이 머신B home 절대경로로 detokenize 됐는지 확인
- **기대 결과**:
  - wormhole_sync 응답: isError 없음. structuredContent.pull = {dryRun:false, applied:['.mcp.json' 논리키 포함], removed:[], conflicts:[], backupDir:백업있으면 경로/없으면 null}
  - 재생성 .mcp.json = stableStringify(remote) 결과 — 키 정렬된 유효 JSON, 끝에 개행 1개. mcpServers.other.args[0] 이 머신B home 절대경로로 detokenize(${HOME}→config.home, posix→path.sep 재구성)
  - self/wormhole 엔트리: localText===null 분기는 로컬 self 보존 로직(L382-393)을 타지 않으므로 self 엔트리는 비어있음(원격은 이미 self 제거 상태 + L358 방어적 재삭제) — 로컬 기본 없으면 mcpServers 에 'wormhole' 부재
  - mergeMcpJsonForPull 이 throw 하지 않음 — 손상('{broken') localText 는 L369 catch 로 local=null 처리, 부재는 applyPullMcpJson L374 catch 로 localText=null
  - applyPullMcpJson 이 atomicWriteFile 로 복구 .mcp.json 기록 + writeBaseSnapshot(remoteSharedText) + nextState 갱신
- **합격 기준**:
  - wormhole_sync 응답 객체에 isError 속성 없음(손상/부재 입력이 예외로 새지 않음)
  - 케이스1·케이스2 모두 재생성된 ~/.claude/.mcp.json 이 JSON.parse 성공(복구가능 파일)
  - 재생성 .mcp.json 에 원격 비-self 엔트리 'other' 존재하고 args 경로가 머신B home 절대경로(${HOME} 토큰 잔존 없음)
  - 재생성 .mcp.json 의 mcpServers 에 self('wormhole') 엔트리 없음(또는 로컬 기본만) — local===null 경로라 self 보존 미적용
  - sync 응답 structuredContent.pull.applied 에 .mcp.json 논리키 포함, pull.dryRun:false
- **신선도**: 기존 SMR 시나리오는 정상 로컬 .mcp.json 존재 시 self 엔트리 보존 머지를 다루지만 로컬 부재/손상('{broken')에서 원격기반 복구(stableStringify(remote)) 산출과 self 미보존 경로를 검증하는 케이스가 없으며, (a)(b)(c) 와 달리 결손 로컬 상태로부터의 자기복구(recovery) 를 표적한다.

---

### 6.6 tombstone-convergence

> **차원 개요**: 삭제(tombstone) 전파, 양측 수렴(converged), 백업 보존, 멱등 재실행, 삭제 후 부활(revive) 경로를 MCP 도구 경계(stdio JSON-RPC tools/call)에서 블랙박스로 검증한다. `engine.ts` 의 tombstoneEntry → manifest CAS → pull toRemove 체인, advanceConverged 의 watermark 전진, backupFile + rollback 패스, state.json 갱신이 실제 와이어(WebDAV PROPFIND/GET)와 로컬 파일시스템에 올바르게 반영되는지를 mock 없이 확인한다.

#### TMB-01 · 로컬 삭제 → push(confirm:true) → PushResult.deleted 에 tombstone 기록, 원격 manifest generation 전진  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 로컬 dufs/Caddy 등 쓰기가능 WebDAV 서버 가동
  - 머신A HOME 에 '.claude/custom.md' 파일이 존재하고, 직전 sync(confirm:true)로 원격에 동기화된 상태(state.json baseline 존재)
  - `MCP_INSPECTOR` 또는 `STDIO_RPC_CLIENT` 로 `server.mjs` 기동 완료
  - 초기 manifestGeneration=N 을 `wormhole_status` 로 기록해 둠
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신A 로컬에서 '.claude/custom.md' 파일을 OS 명령으로 삭제
  2. tools/call `wormhole_status {}` → items 중 '.claude/custom.md' kind='deleted' 확인
  3. tools/call `wormhole_sync {"confirm":false}` → push.dryRun:true, push.deleted 에 '.claude/custom.md' 포함, push.pushed 비어있음 확인
  4. tools/call `wormhole_sync {"confirm":true}` → 실제 sync(push 단계) 실행
  5. WebDAV PROPFIND `{remoteBaseDir}/manifest.json.age` 로 ETag 변경 여부 확인
  6. tools/call `wormhole_status {}` → 해당 키 summary.deleted 사라지고 unchanged 또는 사라짐 확인
- **기대 결과**:
  - step4 `structuredContent.push.dryRun = false`
  - step4 `structuredContent.push.deleted = [".claude/custom.md"]`
  - step4 `structuredContent.push.pushed = []`
  - step4 `structuredContent.push.manifestGeneration = N+1` (N은 초기값)
  - step4 `structuredContent.push.conflicts = []`
  - step5 PROPFIND ETag 변경 확인(원격 manifest 덮어써짐)
  - step6 `structuredContent.summary.deleted = []` (더 이상 deleted 로 분류 안됨)
- **합격 기준**:
  - `wormhole_sync(confirm:true)` 응답 isError 필드 없음(truthy 아님)
  - `structuredContent.push.deleted` 배열에 '.claude/custom.md' 정확히 1회 포함
  - `structuredContent.push.pushed` 빈 배열
  - 연속 2회 `wormhole_status` 호출 시 두 번째에도 deleted 빈 배열 (멱등 확인)
- **신선도**: (b) e2e 해피패스는 push/pull 왕복 성공만 검증했고 tombstone 생성 + manifest generation 전진 + 후속 status 분류 변화는 미검증.

#### TMB-02 · 머신A tombstone push 후 머신B pull(confirm:true) → PullResult.removed, 로컬 파일 실제 삭제, backupDir 생성  `P0`

- **전제조건**:
  - `TWO_MACHINE`: 머신A(HOME_A, stateDir_A) + 머신B(HOME_B, stateDir_B), 동일 `WRITABLE_WEBDAV` + 동일 `WORMHOLE_PASSPHRASE`
  - '.claude/custom.md' 가 양 머신에 동기화된 상태(양측 state.json baseline 존재)
  - TMB-01 선행 완료 — 머신A 가 sync(confirm:true)로 tombstone 원격 기록 완료
  - 머신B 에서 `server.mjs` 기동(별도 stdio 채널)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신B tools/call `wormhole_status {}` → items 중 '.claude/custom.md' kind='remoteDeleted' 확인
  2. 머신B tools/call `wormhole_sync {"confirm":false}` → pull.dryRun:true, pull.removed=['.claude/custom.md'], pull.applied=[] 확인
  3. 머신B tools/call `wormhole_sync {"confirm":true}` → 실제 sync(pull 단계) 실행
  4. 머신B OS 에서 `HOME_B/.claude/custom.md` 파일 존재 여부 확인
  5. 머신B tools/call `wormhole_status {}` → '.claude/custom.md' 항목 분류 확인
  6. `structuredContent.pull.backupDir` 경로 존재 및 파일 내용 확인
- **기대 결과**:
  - step3 `structuredContent.pull.dryRun = false`
  - step3 `structuredContent.pull.removed = [".claude/custom.md"]`
  - step3 `structuredContent.pull.applied = []`
  - step3 `structuredContent.pull.conflicts = []`
  - step3 `structuredContent.pull.backupDir` 가 null 아닌 절대경로 문자열 (기존 파일 있었으므로 백업 생성)
  - step4 `HOME_B/.claude/custom.md` 파일 부재 (ENOENT)
  - step5 summary.deleted/remoteDeleted 모두 빈 배열 (더 이상 추적 대상 아님)
  - step6 backupDir 하위에 '.claude/custom.md' 사본 바이트 일치
- **합격 기준**:
  - `wormhole_sync(confirm:true)` isError 없음
  - pull.removed 배열에 tombstone 키 정확히 포함
  - pull.backupDir 경로가 null 이 아니고 해당 디렉터리가 OS 파일시스템에 실재
  - 백업 사본 내용이 삭제 전 원본과 동일
  - sync(pull 단계) 후 `wormhole_status` 에서 해당 키 remoteDeleted 분류 사라짐
- **신선도**: (b) e2e 해피패스는 파일 생성/수정 왕복만 검증했고 tombstone pull→로컬 삭제 + backupDir 실제 생성은 미검증.
- **자동화 힌트**: 머신B HOME 디렉터리를 tmpdir 로 격리하면 파일 존재 여부 단언이 쉬움.

#### TMB-03 · 양측 독립 동일콘텐츠 도달 → wormhole_status summary.converged 분류, push/pull 전송 없이 watermark 전진  `P1`

- **전제조건**:
  - `TWO_MACHINE`: 머신A + 머신B, 동일 원격
  - '.claude/synced.md' 가 양 머신에 동기화된 상태(state.json baseline 해시=H0)
  - 머신A 와 머신B 가 각각 오프라인 상태에서 동일한 콘텐츠(해시 H1)로 파일을 독립 수정 (state.json baseline 은 여전히 H0)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신A tools/call `wormhole_sync {"confirm":true}` → 원격에 H1 업로드, manifestGeneration=N+1
  2. 머신B tools/call `wormhole_status {}` → '.claude/synced.md' kind 확인
  3. 머신B tools/call `wormhole_sync {"confirm":true}`
  4. 머신B tools/call `wormhole_status {}` → converged 분류 또는 사라짐 확인
  5. 머신B tools/call `wormhole_sync {"confirm":true}` 2회차 실행
  6. step5 응답 push.pushed/push.deleted 확인
- **기대 결과**:
  - step2 `structuredContent.summary.converged = [".claude/synced.md"]` (로컬=원격=H1, base=H0 → 양측 변경+동일 해시)
  - step3 `structuredContent.push.pushed = []` (업로드 불필요)
  - step3 `structuredContent.push.deleted = []`
  - step3 `structuredContent.push.skipped >= 0`
  - step3 `structuredContent.push.manifestGeneration = N+1` (전진 없음 — 수렴은 manifest 재쓰기 안함)
  - step4 `summary.converged = []` 또는 해당 키 unchanged 분류 (watermark 전진으로 base=H1)
  - step5 push.pushed=[], push.deleted=[], push.skipped 증가 (멱등)
- **합격 기준**:
  - step2 status 에서 converged 배열에 해당 키 포함
  - step3 sync(push 단계) 이후 push.pushed/push.deleted 빈 배열 (실제 전송 없음)
  - step3 push.manifestGeneration 이 머신A sync 이후 값과 동일 (manifest 재쓰기 없음)
  - step5 2회차 sync 에서도 push.pushed/push.deleted 빈 배열 (완전 멱등)
- **신선도**: (b) e2e 해피패스는 단일 머신 왕복만 검증했고 양측 독립 수렴 → converged 분류 → manifest 불변 경로는 미검증.
- **자동화 힌트**: 두 HOME 을 별도 tmpdir 로, state.json 을 각각 H0 baseline 으로 사전 준비하면 오프라인 시뮬레이션 가능.

#### TMB-04 · tombstone push 후 동일 키 로컬 재생성(revive) → push(confirm:true) 로 되살리기, generation 전진 확인  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`
  - 머신A 에서 '.claude/revive.md' tombstone 을 sync(confirm:true)로 원격 기록 완료(TMB-01 유사 선행)
  - 원격 manifest 에 '.claude/revive.md' entry.deleted=true, generation=K
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신A 에서 `HOME_A/.claude/revive.md` 를 새 콘텐츠로 재생성
  2. tools/call `wormhole_status {}` → '.claude/revive.md' kind='added' 확인 (tombstone 있지만 로컬 신규생성)
  3. tools/call `wormhole_sync {"confirm":true}`
  4. tools/call `wormhole_status {}` → '.claude/revive.md' kind 확인
  5. `TWO_MACHINE` 환경: 머신B tools/call `wormhole_sync {"confirm":true}`
  6. 머신B `HOME_B/.claude/revive.md` 파일 내용 확인
- **기대 결과**:
  - step2 `structuredContent.summary.added = [".claude/revive.md"]` 또는 modified
  - step3 `structuredContent.push.pushed = [".claude/revive.md"]`
  - step3 `structuredContent.push.deleted = []`
  - step3 `structuredContent.push.manifestGeneration = K+1` (tombstone generation K 에서 +1)
  - step4 '.claude/revive.md' kind='unchanged' (되살리기 성공 후 watermark 전진)
  - step5 `structuredContent.pull.applied = [".claude/revive.md"]` (머신B 에 복원)
  - step6 파일 내용이 재생성 콘텐츠와 바이트 일치
- **합격 기준**:
  - step3 sync(push 단계) isError 없음, push.pushed 에 해당 키 포함
  - step3 push.manifestGeneration 이 tombstone generation 보다 정확히 1 큰 값
  - step5 sync(pull 단계) pull.applied 에 해당 키 포함
  - step6 머신B 파일이 재생성 콘텐츠와 동일 (암호화 왕복 바이트 충실도)
- **신선도**: (b) e2e 해피패스는 신규 파일 push/pull 만 검증했고 tombstone 후 동일 키 재생성(upsertEntry 의 deleted→alive generation 전진)은 미검증.

#### TMB-05 · tombstone pull 후 재pull 멱등 — removed/applied 빈 배열, backupDir null  `P1`

- **전제조건**:
  - `TWO_MACHINE`
  - TMB-02 선행 완료 — 머신B 에서 tombstone sync(pull 단계) 이미 적용됨 (state.json 에 삭제 baseline 존재, 로컬 파일 부재)
- **대상 도구**: `wormhole_sync`, `wormhole_status`
- **절차**:
  1. 머신B tools/call `wormhole_sync {"confirm":true}` (2회차)
  2. 머신B tools/call `wormhole_sync {"confirm":true}` (3회차)
  3. 머신B tools/call `wormhole_status {}`
- **기대 결과**:
  - step1 `structuredContent.pull.applied = []`
  - step1 `structuredContent.pull.removed = []`
  - step1 `structuredContent.pull.conflicts = []`
  - step1 `structuredContent.pull.backupDir = null`
  - step2 동일 결과 반복
  - step3 '.claude/custom.md' 항목이 items 에 없거나 kind='unchanged'
- **합격 기준**:
  - 2회 연속 sync(confirm:true) 모두 pull.applied=[], pull.removed=[], pull.backupDir=null
  - isError 없음
  - OS 파일시스템에 `HOME_B/.claude/custom.md` 여전히 부재
- **신선도**: (b) e2e 해피패스는 pull no-op 멱등을 콘텐츠 존재 케이스로만 검증했고 tombstone 이후의 removed 멱등(2회차 removed 빈 배열 + backupDir null)은 미검증.

#### TMB-06 · pull 시 기존 파일 덮어쓰기 — backupDir 내 원본 보존 검증  `P1`

- **전제조건**:
  - `TWO_MACHINE`
  - '.claude/shared.md' 가 양 머신에 동기화된 state
  - 머신A 가 콘텐츠를 변경하고 sync(confirm:true) 완료 (원격에 새 콘텐츠 H2)
  - 머신B 로컬에는 여전히 이전 콘텐츠 H1 (state.json baseline = H1)
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 머신B 로컬 파일 H1 내용 기록
  2. 머신B tools/call `wormhole_sync {"confirm":true}`
  3. `structuredContent.pull.backupDir` 경로 추출
  4. backupDir 하위 '.claude/shared.md' 파일 내용 확인
  5. `HOME_B/.claude/shared.md` 내용 확인
- **기대 결과**:
  - step2 `structuredContent.pull.applied = [".claude/shared.md"]`
  - step2 `structuredContent.pull.backupDir != null`
  - step4 backupDir 사본 내용 = H1 (적용 전 원본)
  - step5 `HOME_B/.claude/shared.md` 내용 = H2 (새 원격 콘텐츠)
- **합격 기준**:
  - backupDir 경로가 OS 파일시스템에 실재하고 하위에 복원 가능한 사본 존재
  - 백업 사본 내용이 pull 전 로컬 파일과 바이트 동일
  - 적용 후 로컬 파일이 원격 콘텐츠와 바이트 동일
  - isError 없음
- **신선도**: (b) e2e 해피패스는 신규 파일 pull 만 검증했고 기존 파일 덮어쓰기 시 backupDir 실제 생성 + 사본 내용 보존은 미검증.
- **자동화 힌트**: HOME_B 를 tmpdir 로 격리하면 backupDir 경로가 tmpdir 하위로 집중되어 파일 대조 자동화 용이.

#### TMB-07 · 양측 동시 삭제 수렴(양측 tombstone) → status converged, pull/push 모두 전송 없음  `P2`

- **전제조건**:
  - `TWO_MACHINE`
  - '.claude/both-deleted.md' 가 양 머신에 동기화된 상태 (baseline=H0)
  - 머신A 가 파일 삭제 후 sync(confirm:true) → 원격 tombstone (deleted=true)
  - 머신B 도 동일 파일을 오프라인에서 삭제 (state.json baseline 은 여전히 H0, 로컬 파일 부재)
- **대상 도구**: `wormhole_status`, `wormhole_sync`
- **절차**:
  1. 머신B tools/call `wormhole_status {}`
  2. 머신B tools/call `wormhole_sync {"confirm":true}`
  3. 머신B tools/call `wormhole_sync {"confirm":true}` (2회차)
  4. 머신B tools/call `wormhole_status {}` (2회차)
- **기대 결과**:
  - step1 '.claude/both-deleted.md' kind='converged' (로컬=null, 원격=null, 양측 삭제 수렴)
  - step2 `structuredContent.push.pushed = []`, `push.deleted = []` (tombstone 재전송 불필요)
  - step2 `structuredContent.push.manifestGeneration` 불변 (원격 재쓰기 없음)
  - step3 `structuredContent.pull.removed = []`, `pull.applied = []`, `pull.backupDir = null`
  - step4 '.claude/both-deleted.md' 항목 absent 또는 kind='unchanged'
- **합격 기준**:
  - step1 summary.converged 에 해당 키 포함 (kind=converged, localHash=null)
  - step2 sync(push 단계)가 manifest 를 재쓰지 않음 (push.manifestGeneration 불변)
  - step3 sync(pull 단계)의 pull.removed 빈 배열 (이미 수렴된 삭제를 재삭제 안함)
  - step4 status 에서 해당 키 더 이상 deleted/remoteDeleted 미분류
- **신선도**: (b) e2e 해피패스는 양측 동시 삭제 케이스를 다루지 않았고, diff.ts 의 양측 삭제 수렴 분기(localHash===null, remoteHash===null → converged)가 MCP 도구 경계에서 올바르게 전파되는지 미검증.
- **자동화 힌트**: advanceConverged 의 localHash===null 분기(removeBaseSnapshot + delete nextState[key])가 실행되어 state.json 에서 키 제거되는지 state 파일 직접 검사로 보완 가능.

#### TMB-08 · pull 다중키 적용 중 한 blob 손상 → all-or-nothing 롤백 (원자성: 부분 적용 잔존 없이 전부 원복 + 재throw isError)  `P1`

- **갭 클로저**: F-ENGINE-17 — runPull 의 try/catch 원자성: backedUp 백업 → 부분 적용 중 예외 → rollback(backedUp) → throw err 로 로컬을 pull 이전 상태로 전부 복원
- **전제조건**:
  - TWO_MACHINE: 머신A(HOME_A,stateDir_A)·머신B(HOME_B,stateDir_B)가 동일 WRITABLE_WEBDAV 원격 + 동일 passphrase 공유
  - STDIO_RPC_CLIENT 또는 MCP_INSPECTOR 로 머신B 의 plugin/dist/server.mjs 를 머신B HOME 환경에서 기동(buildEngine 부팅: config로드→machineId→remote.ensureDir(MKCOL)→passphrase→ensureCryptoReady(원격 keyparams sentinel 복호 검증) 통과)
  - 머신B 로컬에 이미 두 개 이상의 동기화 대상 파일이 존재(예: ~/.claude/CLAUDE.md='B-local-CLAUDE', ~/.claude/settings.json 또는 추가 일반키 파일='B-local-2'). 이들이 pull 적용 시 덮어쓰기될 기존 파일이어야 backupFile 이 null 아닌 backupPath 를 만든다
  - 머신A 에서 같은 키 2건+ 을 수정 후 wormhole_sync{confirm:true} 로 원격 manifest+blobs/* 갱신(머신B 입장에서 두 키가 remoteModified 로 분류되도록)
  - CORRUPT_REMOTE 주입: 원격 blobs/ 아래 적용 대상 키 중 정확히 1건의 blob 파일을 손상시킨다 — 복호/gunzip 이 throw 하도록 암호문 바이트를 변조(decrypt 실패 유발) 또는 CSZ1 매직 뒤 gzip 페이로드를 깨뜨림(gunzipAsync 실패 유발). 나머지 1건 이상은 정상 blob 으로 둔다
  - 주의: blob 파일 자체를 삭제하면 getTextIfExists→null→downloadBlob null→해당 키만 조용히 skip(throw 아님)이 되어 롤백이 트리거되지 않는다. 반드시 '존재하지만 손상된' blob 이어야 catch 경로 진입
- **대상 도구**: `wormhole_status`, `wormhole_sync`
- **절차**:
  1. 머신B 부팅 직후 pull 이전 베이스라인 캡처: tools/call wormhole_status {} 로 두 키가 remoteModified(적용 예정)임을 확인하고, 로컬 파일 두 건의 현재 바이트 내용을 디스크에서 직접 스냅샷('B-local-CLAUDE','B-local-2')
  2. 머신B 의 backupsDir(backups/) 하위 기존 runTs 디렉터리 목록을 사전 기록(신규 생성분 식별용)
  3. tools/call wormhole_sync {"confirm": true} 호출 — pull 단계의 runPull 이 toApply 2건을 mapLimit 병렬 적용하다가 손상 blob 키에서 downloadBlob 내부 decrypt/gunzip 예외 발생
  4. 핸들러 catch 가 결과를 isError 로 래핑한 응답을 수신
  5. 응답 수신 후 머신B 로컬 파일 두 건의 현재 디스크 내용을 다시 읽어 step1 스냅샷과 바이트 비교
  6. backups/ 하위에 이번 run 의 신규 runTs 디렉터리가 생겼는지, 그 안에 적용 직전 원본 사본(키 경로 분할 구조)이 보존됐는지 확인
  7. 머신B stderr 로그에서 롤백 트레이스 문자열 확인
- **기대 결과**:
  - wormhole_sync 응답: isError === true. content[0].type==='text', content[0].text === 예외 메시지 문자열(String(err.message)) — decrypt 실패 또는 gunzip 실패 유래 메시지. structuredContent 필드는 없음(에러 경로는 structuredContent 미포함)
  - 로컬 파일 원복: 정상 blob 키가 mapLimit 병렬에서 먼저 atomicWriteFile 로 적용됐더라도, rollback 이 backedUp[].backupPath(null 아님)에서 원본을 atomicWriteFile 로 되써서 step1 스냅샷과 바이트 동일('B-local-CLAUDE','B-local-2' 그대로). 부분 적용된 원격 내용('A-modified...')이 어느 파일에도 잔존하지 않음
  - 적용으로 새로 생성됐을 키(백업 시 ENOENT→backupPath=null)가 있었다면 rollback 이 deleteLocalFile 로 제거 — 적용 산물 파일 미존재
  - stderr 로그에 '[engine] pull 적용 중 오류 — 롤백 시도: ' 접두 메시지 1건 출력(this.logger.error). 개별 롤백 실패 시에만 '[engine] 롤백 실패 <key>: ' 출력되며 정상 롤백에서는 미출력
  - backups/<runTs>/ 신규 디렉터리 실존하고 그 하위에 키 경로(key.split('/'))로 분할된 원본 사본 파일이 존재(backupFile 이 fs.writeFile 로 기록) — 단, 이 backupDir 경로는 throw 로 인해 PullResult 로 반환되지 않으므로 디스크 직접 관측으로만 확인
  - engine 의 nextState 는 writeState 도달 전 throw 되므로 syncState 파일이 갱신되지 않음(다음 pull 재시도 시 동일 remoteModified 재분류 가능)
- **합격 기준**:
  - wormhole_sync{confirm:true} 응답의 isError === true 이고 structuredContent 키 부재
  - pull 이후 로컬 두 파일의 바이트가 step1 pull-이전 스냅샷과 완전 일치(deep byte-equal) — 정상 blob 키조차 원격 신규 내용으로 남지 않음(부분 적용 0건)
  - backups/<신규 runTs>/ 디렉터리가 OS 파일시스템에 실재하고 적용 직전 원본 사본 1건 이상 포함
  - stderr 에 '[engine] pull 적용 중 오류 — 롤백 시도:' 정확히 1회 등장, '[engine] 롤백 실패' 0회
  - 재현 후 wormhole_status 재호출 시 두 키가 여전히 remoteModified(미적용)로 보고됨(state watermark 미전진 확인)
- **신선도**: TMB-06 은 정상 pull 의 단순 덮어쓰기 백업(backupDir 내 원본 보존)만 검증하고 적용은 끝까지 성공하지만, TMB-08 은 다중키 적용 도중 한 blob 의 decrypt/gunzip 예외로 catch→rollback→throw 경로를 강제해 '실패 시 전부 원복' 원자성과 isError:true(structuredContent 부재)를 검증한다 — 기존 54 시나리오 어디에도 부분 적용 실패-원복 경로가 없고, (a)정상 백업·(b)해피패스 왕복·(c)멱등 no-op 과 달리 유일하게 예외 유발+롤백 잔존검사를 다룬다.
- **자동화 힌트**: CORRUPT_REMOTE 주입은 push 완료 후 원격 blobs/<blobName(key)> 파일 1건의 바이트를 변조(decrypt 실패) 또는 CSZ1 매직 뒤 gzip 페이로드 1바이트 flip(gunzip 실패)으로 자동화. mapLimit 병렬·키 순서 비결정성에 무관하게 '최종 로컬==pull이전 스냅샷' 불변식으로 단언하면 경합 영향 없음. backupDir 은 응답이 아닌 디스크에서 신규 runTs diff 로 식별.

---

### 6.7 error-lock-cas

> **차원 개요**: MCP 도구 경계(stdio JSON-RPC tools/call)에서 실패·경합·CAS 강건성을 블랙박스로 검증한다. 부팅 크래시(config 부재·잘못된 passphrase·`READONLY_WEBDAV`)부터 락 경합 소진, `NO_ETAG_WEBDAV` CAS 상실, sync stop-on-error, push CAS 재시도 소진까지 모든 에러 경로가 unhandled rejection 없이 `isError:true` 또는 프로세스 종료로 표면화하는지 확인한다.

#### ELC-01 · READONLY_WEBDAV — ensureDir MKCOL 405 시 부팅 성공·도구 정상 노출 확인  `P0`

- **전제조건**:
  - `READONLY_WEBDAV`: PROPFIND 허용, MKCOL/PUT 모두 405 반환하는 WebDAV(예: nginx dav_methods GET HEAD OPTIONS PROPFIND LOCK UNLOCK 만 허용)
  - `~/.wormhole/config.json` 존재, `WEBDAV_URL`/`USER`/`PASS` 설정, `WORMHOLE_PASSPHRASE` 설정
  - **remoteBaseDir 디렉터리는 존재하나 `<remoteBaseDir>/blobs` 는 미존재 (또는 둘 다 미존재)** 로 명확화. 근거: `client.ts` ensureDir(61-72)는 `client.exists()` 후 미존재일 때만 createDirectory(MKCOL) 호출 → 둘 다 이미 존재하면 MKCOL 시도 자체가 없어 405/warn 미발생. READONLY_WEBDAV 에서 미존재 blobs 에 대한 MKCOL 405 를 강제하려면 blobs 미존재 상태가 필수. (critic 교정 반영)
  - `STDIO_RPC_CLIENT`: `server.mjs` 를 `node plugin/dist/server.mjs` 로 실행하는 클라이언트 하네스
- **대상 도구**: `wormhole_status`, `wormhole_sync`
- **절차**:
  1. `node plugin/dist/server.mjs` 를 stdio 로 실행하고 MCP 핸드셰이크 완료 대기 (initialize + initialized)
  2. tools/list 요청 전송 → 응답 수신
  3. tools/call `{name:'wormhole_status', arguments:{}}` 전송 → 응답 수신
  4. tools/call `{name:'wormhole_sync', arguments:{confirm:false}}` 전송 → 응답 수신
  5. 서버 stderr 에서 ensureDir 경고 메시지 확인
- **기대 결과** (분기 명시, critic 교정 반영):
  - **(a) blobs(또는 remoteBaseDir) 미존재 + READONLY 서버** → createDirectory MKCOL 405 → catch 블록 stderr `'warn [RemoteStore] ensureDir 실패, 무시: <resolved>'` 출력 후 부팅 계속
  - **(b) 모든 대상 디렉터리 이미 존재** → MKCOL 미시도, warn 미출력(no-op)
  - 어느 경우든 핵심 패스 판정(도구 3개 노출 + `wormhole_status` 정상 응답 + 프로세스 생존)은 유효
  - 서버 프로세스가 종료되지 않음 (exit code 없음) — ensureDir 는 warn+continue 라 부팅 성공
  - tools/list 응답에 3개 도구 포함
  - `wormhole_status` 응답: isError 없음, structuredContent.summary 포함
  - `wormhole_sync {confirm:false}` 응답: isError 없음, structuredContent.push.dryRun=true (읽기전용 미리보기는 MKCOL 불필요)
- **합격 기준**:
  - tools/list 에서 도구 3개 정확히 열거됨
  - `wormhole_status` 응답 content[0].type === 'text', JSON 파싱 성공, generatedAt 필드 존재
  - `wormhole_sync(미리보기)` isError 필드 없거나 false
  - 프로세스 pid 가 응답 수신 후에도 살아 있음 (kill -0 확인)
- **신선도**: (c)는 Apache 실서버의 PUT 405 쓰기 블록 현상을 문서화했을 뿐이고, (a)(b)는 mock/직접호출이라 실 MCP stdio 경계에서 ensureDir 실패가 부팅에 미치는 영향을 한 번도 블랙박스 관측한 적 없음.
- **자동화 힌트**: nc/socat 또는 Node `child_process.spawn` 으로 `server.mjs` 실행 후 JSON-RPC 라인을 stdin/stdout 으로 교환; stderr 파이프로 warn 메시지 grep.

#### ELC-02 · 잘못된 WORMHOLE_PASSPHRASE — 기존 vault 있는 서버에서 부팅 시 sentinel 복호 실패 → process.exit(1)  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 쓰기 가능한 WebDAV (dufs/rclone serve 등)
  - 원격에 이미 올바른 passphrase 로 bootstrap 된 keyparams.json 존재 (sentinel 암호화됨)
  - `~/.wormhole/.env` 의 `WORMHOLE_PASSPHRASE` 를 의도적으로 틀린 값('wrong-passphrase-xyz')으로 설정
  - `STDIO_RPC_CLIENT`
- **대상 도구**: (부팅 단계 — buildEngine 도달 전 sentinel 복호)
- **절차**:
  1. `node plugin/dist/server.mjs` 를 stdio 로 실행
  2. 프로세스 종료를 기다림 (최대 30초 타임아웃)
  3. exit code 확인
  4. stderr 전체 수집
- **기대 결과**:
  - 프로세스가 exit code 1 로 종료됨 (buildEngine 실패 → main().catch → process.exit(1))
  - MCP 핸드셰이크 완료 전에 종료됨 (tools/list 응답 없음)
  - stderr 에 'passphrase 검증 실패' 문자열 포함
  - stderr 에 '치명적 부트스트랩 오류:' 문자열 포함
  - stdout 에 MCP JSON-RPC 응답 없음 (stdout 은 MCP 전용 채널이므로 에러 메시지 없음)
- **합격 기준**:
  - exit code === 1
  - stderr 에서 'passphrase 검증 실패' 패턴 매칭
  - stdout 이 비어 있거나 MCP initialize 응답만 있고 도구 응답 없음
  - 프로세스가 30초 이내 종료됨 (hang 없음)
- **신선도**: (b)e2e 는 올바른 passphrase 단일 해피패스만 검증했고 (a)mock 은 passphrase 계층 자체를 우회함; 실 MCP stdio 경계에서 sentinel 복호 실패가 부팅 크래시로 전파되는지는 미검증.
- **자동화 힌트**: spawn 후 `waitForExit(30000)`; `exitCode === 1` 단언; stderr 버퍼에서 `includes('passphrase 검증 실패')` 확인.

#### ELC-03 · config.json 부재 — ~/.wormhole/config.json 없을 때 부팅 크래시 및 에러 메시지 검증  `P0`

- **전제조건**:
  - `WRITABLE_WEBDAV` (또는 어떤 WebDAV 든 무방 — config 로드 단계에서 실패)
  - `~/.wormhole/config.json` 을 임시 제거하거나 `WORMHOLE_CONFIG` 환경변수로 존재하지 않는 경로 지정
  - `STDIO_RPC_CLIENT`
- **대상 도구**: (부팅 단계 — main → buildEngine → loadConfig)
- **절차**:
  1. `WORMHOLE_CONFIG=/tmp/nonexistent-wormhole-config-12345.json node plugin/dist/server.mjs` 실행
  2. 프로세스 종료 대기 (최대 5초)
  3. exit code 및 stderr 수집
- **기대 결과**:
  - 프로세스가 exit code 1 로 종료됨
  - stderr 에 'config.json 없음' 또는 '/tmp/nonexistent-wormhole-config-12345.json' 경로 포함 메시지
  - stderr 에 '/wormhole-setup' 또는 'config.example.json' 안내 문자열 포함
  - stdout 에 MCP 응답 없음
- **합격 기준**:
  - exit code === 1
  - stderr 에 구체적 설정 파일 경로가 에러 메시지에 포함됨 (단순 'Error' 아님)
  - 프로세스가 5초 이내 종료됨
- **신선도**: (a)(b)(c) 모두 config.json 이 존재하는 전제에서만 실행했고 부재 시 에러 표면을 MCP stdio 경계에서 실측한 적 없음; loadConfig 의 ENOENT 분기가 실제로 올바른 안내 메시지를 내는지 블랙박스 확인.
- **자동화 힌트**: env `WORMHOLE_CONFIG` 로 경로 주입; 5초 타임아웃 내 exit 확인; `stderr.includes('config.json 없음')` 단언.

#### ELC-04 · 락 경합 소진 — 두 클라이언트 동시 push(confirm:true) 시 한쪽 acquireRetries=3 소진 후 isError  `P0`

- **전제조건**:
  - `TWO_MACHINE`: 머신 A, B — 별도 HOME+stateDir, 동일 원격 WebDAV, 동일 passphrase
  - `WRITABLE_WEBDAV`: 쓰기 가능 WebDAV (dufs 또는 Nginx WebDAV)
  - 두 머신 각각 `server.mjs` 실행 중 (두 개의 독립 MCP 프로세스)
  - 두 머신 모두 원격과 초기 동기화 완료 상태 (push 하나씩 해서 매니페스트 존재)
  - `STDIO_RPC_CLIENT` x2
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 머신 A에 tools/call `{name:'wormhole_sync', arguments:{confirm:true}}` 전송 (응답 대기 없이 비동기)
  2. 동시에 (< 100ms 간격) 머신 B에 tools/call `{name:'wormhole_sync', arguments:{confirm:true}}` 전송
  3. 두 응답 모두 수집
  4. 원격 lock.json 을 PROPFIND 로 조회하여 최종 상태 확인
- **기대 결과**:
  - 두 응답 중 정확히 하나는 `isError:true`, content[0].text 에 'failed to acquire remote lock' 포함
  - 나머지 하나는 isError 없음, `structuredContent.push.dryRun === false`
  - 성공한 sync 는 push.pushed[] 또는 push.deleted[] 비어있더라도 `structuredContent.push.manifestGeneration` 존재
  - 원격 lock.json 이 TTL 만료 후 삭제되거나 부재 상태 (정상 release)
- **합격 기준**:
  - 두 응답 중 정확히 하나에 `isError:true` 존재
  - 실패 응답 content[0].text === 'failed to acquire remote lock' (withLock 실패 메시지 정확히 일치)
  - 성공 응답에 structuredContent 필드 존재
  - 30초 후 원격 lock.json PROPFIND 가 404 또는 응답에 lock.json 없음 (정상 해제 확인)
- **신선도**: (a)는 mock 엔진이라 실 RemoteLock CAS 경쟁 미검증; (b)는 단일 머신 단일 경로라 경합 없음; 실 두 MCP 프로세스가 동시 sync(push 단계) 할 때 acquireRetries 소진 후 isError 변환까지의 실 와이어 경로가 미답.
- **자동화 힌트**: Promise.all 로 두 tools/call 동시 발사; 응답에 isError 분류 후 카운트 단언; 30초 후 PROPFIND 로 lock.json 부재 확인.

#### ELC-05 · 만료 lock.json 탈취 — TTL 경과 후 다음 push가 CAS putIfMatch로 락 탈취하고 성공  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 쓰기 가능 WebDAV
  - 단일 머신, `server.mjs` 실행 중
  - 원격 lock.json 을 수동으로 `acquiredAt=(now - 35000)`, `ttlMs=30000` 인 JSON 으로 직접 PUT 주입 (TTL 초과 상태)
  - **`WORMHOLE_LOG_LEVEL=debug` (탈취 머신 프로세스 env) 추가.** 근거: `lock.ts:154` 'remote lock acquired' 는 `logger?.debug` 이고 `logger.ts:30` defaultLevel 은 `WORMHOLE_LOG_LEVEL ?? 'info'` 라 기본 환경(info)에서 debug 로그 미출력 → 단언 실패. (critic 교정 반영)
  - `STDIO_RPC_CLIENT`
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 원격 WebDAV 에 만료된 lock.json 직접 PUT: `{"machineId":"other-machine","acquiredAt":<now-35000>,"ttlMs":30000}`
  2. tools/call `{name:'wormhole_sync', arguments:{confirm:true}}` 전송
  3. 응답 수신 및 stderr 수집
- **기대 결과**:
  - `wormhole_sync` 응답: isError 없음, `structuredContent.push.dryRun === false`
  - 원격 lock.json 이 자기 machineId 로 교체된 후 작업 완료 시 삭제됨
  - **(보조 신호)** `WORMHOLE_LOG_LEVEL=debug` 설정 시에만 stderr 에 'remote lock acquired' 로그 포함 (탈취 성공). 기본 info 환경에서는 미출력 (critic 교정 반영)
  - stderr 에 'remote lock held by other-machine' 메시지 없음 (대기 없이 즉시 탈취)
- **합격 기준** (stderr 로그 비의존으로 재정의, critic 교정 반영):
  1. tools/call 응답에 isError 없음
  2. 독립 PROPFIND+GET 로 lock.json 본문 machineId 가 탈취 머신 자기 machineId 로 교체 확인
  3. 작업 완료 후 lock.json 이 release(deleteFile)되어 PROPFIND 404
  4. '재시도 없이 즉시 탈취' 는 acquire 전체 소요 < `acquireRetryDelayMs`(1000ms)*1, 즉 ~4초 미만(만료 락은 retry 루프 미진입)으로 측정
  5. `WORMHOLE_LOG_LEVEL=debug` 설정 시에만 stderr 'remote lock acquired' 단언을 보조 신호로 추가
- **신선도**: (a)는 RemoteLock 단위테스트가 있지만 mock 엔진이라 실 MCP 도구 경계에서 만료 락 탈취→push 성공 경로가 검증된 적 없음; acquireRetries 소진 시나리오(ELC-04)와 달리 탈취 성공 경로.
- **자동화 힌트**: beforeEach 에서 WebDAV PUT 으로 만료 lock.json 주입; tools/call 후 경과시간 측정; PROPFIND 로 lock.json 404 확인.

#### ELC-06 · NO_ETAG_WEBDAV — ETag 미반환 서버에서 push 시 best-effort PUT 폴백·CAS 상실 경고 확인  `P1`

- **전제조건**:
  - `NO_ETAG_WEBDAV`: ETag 헤더를 응답에 포함하지 않는 WebDAV 서버 (nginx 에서 `add_header ETag ''` 제거하거나 커스텀 프록시로 ETag 헤더 strip)
  - 단일 머신, `server.mjs` 실행 중 (해당 WebDAV 사용)
  - 로컬에 동기화 대상 파일 1개 이상 존재 (예: `~/.claude/CLAUDE.md`)
  - `STDIO_RPC_CLIENT`
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. tools/call `{name:'wormhole_sync', arguments:{confirm:true}}` 전송 → 응답 수신
  2. stderr 수집하여 warn 메시지 확인
  3. 즉시 동일 호출 재전송 (rapid back-to-back): tools/call `{name:'wormhole_sync', arguments:{confirm:true}}`
  4. 두 번째 응답 수신
- **기대 결과**:
  - 첫 번째 sync: isError 없음, `structuredContent.push.pushed` 배열에 파일 포함
  - stderr 에 'putIfMatch: ETag 없음(서버 미지원?)' 및 'best-effort PUT으로 폴백' 경고 포함
  - 두 번째 sync: isError 없음 (no-op 멱등 또는 skipped 처리), push.dryRun:false
  - 원격 `manifest.json.age` 는 두 번 PUT 되었으나 generation 충돌 없음 (보조 generation CAS 가 ETag 없이도 충돌 검출)
- **합격 기준**:
  - 두 응답 모두 isError 없거나 false
  - stderr 에 'best-effort PUT으로 폴백' 패턴 포함
  - 두 번째 sync 의 `structuredContent.push.pushed` 배열이 비어 있음 (no-op 멱등)
  - 원격 manifest generation 이 정확히 1 증가 (첫 번째 sync 만 실제 업로드)
- **신선도**: (b)e2e 해피패스는 인메모리 WebDAV 하네스(strong ETag 반환)를 썼고, (c)는 Apache ETag 현상을 문서화했지만 NO_ETAG 서버(ETag 완전 부재)는 별개 시나리오임; putIfMatch etag=null 분기의 폴백 경고와 보조 generation CAS 동작을 MCP 도구 경계에서 미검증.
- **자동화 힌트**: nginx/Caddy 리버스 프록시 설정에서 ETag 헤더 strip; tools/call 2회 연속 실행; `stderr grep 'best-effort PUT'`.

#### ELC-07 · sync stop-on-error — pull 단계 강제 실패 시 push 미실행 및 isError 전파  `P1`

- **전제조건**:
  - `WRITABLE_WEBDAV`: 쓰기 가능 WebDAV
  - 단일 머신, `server.mjs` 실행 중
  - 원격에 매니페스트 존재 (이전 push 완료 상태)
  - `CORRUPT_REMOTE`: 원격 `manifest.json.age` 를 의도적으로 손상된 내용으로 덮어쓰기 (복호 실패 유발): WebDAV PUT 으로 평문 'CORRUPTED' 업로드
  - `STDIO_RPC_CLIENT`
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 원격 `manifest.json.age` 에 WebDAV PUT 으로 'CORRUPTED-NOT-AGE-ARMORED' 평문 업로드
  2. tools/call `{name:'wormhole_sync', arguments:{confirm:true}}` 전송
  3. 응답 수신
  4. 원격에 PROPFIND 로 새 blob 이 추가됐는지 확인
- **기대 결과**:
  - `wormhole_sync` 응답: `isError:true`
  - content[0].text 에 복호 실패 관련 에러 메시지 포함 (age decrypt 실패 또는 JSON 파싱 실패)
  - 원격 blob 디렉터리에 새 파일 없음 (push 단계 미실행 확인)
  - unhandled rejection 없음 (프로세스 살아있음)
- **합격 기준**:
  - 응답 `isError === true`
  - content[0].text 가 빈 문자열 아님 (구체적 에러 메시지)
  - tools/call 후 tools/call `{name:'wormhole_status', arguments:{}}` 가 정상 응답 반환 (프로세스 건강)
  - PROPFIND blobs/ 목록에 신규 파일 없음 (push 미실행)
- **신선도**: (a)mock 단위테스트의 stop-on-error 는 mock 엔진의 분기 코드 커버리지이고, sync.ts 의 실 throw→catch→isError 경로를 실 손상 매니페스트로 실제 MCP 경계에서 관측한 적 없음; pull 실패 시 push 미실행을 와이어 레벨(blob PROPFIND)로 독립 확인하는 점이 신선.
- **자동화 힌트**: setupPhase 에서 PROPFIND 로 blobs/ 파일 목록 캡처; sync 실패 후 PROPFIND 재조회; 파일 수 동일하면 pass.

#### ELC-08 · push 의 manifest CAS 재시도 소진 → ManifestConflictError 가 isError:true 로 표면화  `P0`

> gaps 패치 신규 시나리오 — error-lock-cas 차원 보강.

- **전제조건**:
  - `WRITABLE_WEBDAV` (ETag 지원 — putIfMatch CAS 동작 보장; dufs/Caddy/rclone serve webdav 중 강한 ETag 반환 후보)
  - `MCP_INSPECTOR` 또는 `STDIO_RPC_CLIENT` 로 `server.mjs` stdio 기동(머신 A)
  - 외부 경합 에이전트: 매 push 시도 사이에 원격 manifest.json 의 generation 을 선점 전진시키는 독립 스크립트(별도 WebDAV 클라이언트로 manifest 를 read→generation+1→putIfMatch). MAX_CAS_RETRIES(3) 회 이상 매번 선점하도록 동기화
  - 머신 A 로컬에 push 대상 변경 1건 이상 존재(빈 push 가 아니어야 runPush 가 manifest 쓰기 단계 도달)
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. tools/call `wormhole_sync {confirm:true}` 호출 시작 (내부 push 단계가 manifest 쓰기에 도달)
  2. 경합 에이전트가 runPush 의 매 시도 직전(또는 putIfMatch 직전 윈도)마다 원격 manifest generation 을 전진시켜 ManifestConflictError(412/409) 를 3회 유발
  3. runPushWithRetry(engine.ts 299-319) 가 지수백오프(`min(2000,100*2^attempt)+지터`)로 attempt 0..2 재시도 후 소진
  4. 소진 시 `throw lastErr`(ManifestConflictError) → 핸들러 try/catch 가 `isError:true` 로 변환
  5. 독립 PROPFIND 로 manifest generation 이 머신 A 의 push 로 전진하지 않았음(경합 에이전트 값 유지) 확인
- **기대 결과**:
  - tools/call 응답이 `{content:[{type:text,text: err.message}], isError:true}` 형태
  - err.message 가 ManifestConflictError 계열(또는 'push CAS 재시도 소진') 메시지 포함
  - stderr 에 `'[engine] push CAS 충돌 — {N}ms 후 재시도 {a}/3'` 경고가 (debug 아님 warn 레벨이므로 기본 info 환경에서) 출력
  - 원격 manifest 가 머신 A 변경분을 반영하지 않음(generation/contentHash 가 경합 에이전트 마지막 쓰기와 일치)
- **합격 기준**:
  - 응답 `isError === true` 이며 structuredContent 없음
  - warn 로그가 정확히 MAX_CAS_RETRIES(3) 회 출력(attempt 1/3,2/3,3/3) — 재시도 횟수 = 코드 상수 일치
  - 전체 소요시간 >= 누적 백오프 하한(100+200+400ms ≈ 0.7s, 지터 제외) — 즉시 실패 아님 입증
  - 독립 PROPFIND 로 머신 A push 의 와이어 무반영 확인(CAS 소진 = 부분 쓰기 없음)
- **신선도**: ELC-04(락 경합)/ELC-06(ETag 부재)와 다른 manifest 레벨 CAS 소진 실패 표면. (a)mock, (b)해피 왕복 미답. isError 변환 + 재시도 상수 + 와이어 무변경 3중 검증.

#### ELC-09 · AsyncMutex 인프로세스 직렬화 — 단일 server.mjs 에 push·pull 무대기 연속 발사 시 mutex.runExclusive tail 체이닝으로 순차화·교차손상 없음 증명  `P1`

- **갭 클로저**: F-WIRE-14 — 단일 프로세스 내 push/pull/resolve 가 AsyncMutex.runExclusive(tail Promise 체이닝)로 직렬화되어 동시 호출이 와이어 인터리브 손상을 내지 않음
- **전제조건**:
  - WRITABLE_WEBDAV: 강한 ETag 서버(dufs/Caddy/Nginx) 구동, config 설정 완료, 원격 keyparams.json/manifest.json 초기화됨(부팅 1회로 sentinel·generation 수립)
  - STDIO_RPC_CLIENT: server.mjs 단일 프로세스 기동 + initialize 핸드셰이크 완료 (buildEngine 통과: loadConfig→machineId→ensureDir(MKCOL)→passphrase→ensureCryptoReady 성공)
  - 로컬에 동기화 대상 변경 1건 이상 존재(push 가 manifest generation 을 실제 전진시키도록)
  - 독립 PROPFIND/GET 와이어 관측 클라이언트(webdav npm 또는 curl) 준비 — manifest.json 복호 후 generation 비교용
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 호출 전 독립 status 또는 PROPFIND+복호로 GEN_BEFORE 기록 (wormhole_status 의 structuredContent.manifestGeneration)
  2. 동일 STDIO_RPC_CLIENT 연결에서 응답 대기 없이 두 JSON-RPC 요청을 연속 전송: req A = tools/call {"name":"wormhole_sync","arguments":{"confirm":true}} (id=101), 직후 req B = tools/call {"name":"wormhole_sync","arguments":{"confirm":true}} (id=102) — 두 요청을 flush 사이 await 없이 같은 tick 에 stdin 으로 write. 각 sync 는 내부적으로 pull→push 를 순차 수행하므로 두 호출이 동일 mutex 를 두고 경쟁한다
  3. 두 응답(id=101, id=102) 모두 수신될 때까지 수집
  4. 각 응답의 isError 부재 확인, structuredContent 파싱
  5. 호출 후 독립 PROPFIND+복호로 GEN_AFTER 기록 및 manifest.json 단일 정합본(파싱 가능, KeyParamsSchema/Manifest 구조 유효) 확인
  6. 원격 blobs/ 및 manifest.json 에 orphan tmp(.tmp.* 접미사 잔존) 부재 확인(putAtomic move 완료)
- **기대 결과**:
  - id=101(sync) 응답: isError 필드 없음, structuredContent.push.manifestGeneration = 정수(GEN_BEFORE 보다 큼)
  - id=102(sync) 응답: isError 필드 없음, structuredContent 가 {pull, push} 합본(정상 객체)
  - 두 응답 모두 content[0].text 가 JSON.stringify(payload) 와 동일(핸들러 정상 경로)
  - GEN_AFTER 는 단일 generation 경로 — 먼저 직렬화된 sync 의 push 가 정확히 +1 전진시키고 뒤따른 sync 의 push 는 변경 없음 no-op, 즉 GEN_AFTER === GEN_BEFORE+1
  - 원격 manifest.json 은 손상 없이 1개 정합 복호본(armored age 페이로드 복호 성공), orphan .tmp.* 잔존 없음
  - 로깅(stderr)에 push CAS 충돌 재시도 흔적 없거나 있어도 최종 수렴(isError 없음) — 인터리브로 인한 ManifestConflictError 영구 실패 부재
- **합격 기준**:
  - 두 응답 모두 isError 미존재 (직렬화로 동시 호출이 둘 다 성공)
  - GEN_AFTER === GEN_BEFORE + 1 (push 단일 전진, 이중쓰기/이중전진 없음 — mutex 가 두 작업을 겹치지 않게 함)
  - 독립 PROPFIND 로 읽은 manifest.json 이 단일 정합 복호본이며 orphan tmp 부재 (와이어 교차손상 없음)
  - 두 응답의 content[0].text === JSON.stringify(해당 structuredContent) (핸들러 정상 경로 통과)
- **신선도**: 기존 ELC-07(sync stop-on-error)·ELC-08(CAS 재시도 소진 isError)은 단일 호출의 실패 전파를 보았고, (a)(b)(c)는 순차 단일 호출만 다뤘다 — 본 시나리오만 동일 프로세스에 두 쓰기 호출을 무대기 동시 발사해 AsyncMutex tail 체이닝이 인터리브 손상 없이 둘 다 성공·단일 generation 전진시킴을 와이어로 증명한다.
- **자동화 힌트**: STDIO_RPC_CLIENT 에서 두 tools/call 프레임을 await 없이 같은 동기 블록에서 stdin.write 후 Promise.all 로 두 응답을 수집. GEN_AFTER === GEN_BEFORE+1 와 orphan .tmp.* 부재를 PROPFIND 결과로 단언.

#### ELC-10 · config.json 비-ENOENT(깨진 JSON) 래핑 — WORMHOLE_CONFIG 로 '{broken' 지정 부팅 시 'config 파일 읽기 실패' 래핑 throw·exit≠0·stdout 무오염·핸드셰이크 미수립  `P0`

- **갭 클로저**: F-CONFIG-08 — loadConfig 가 config.json 의 비-ENOENT 오류(JSON.parse 실패/권한)를 'config 파일 읽기 실패 (경로): 메시지' 로 래핑해 throw 하며, 이는 ENOENT(부재) 경로(ELC-03)와 구별됨
- **전제조건**:
  - WRITABLE_WEBDAV 불필요 — 부팅이 config 로드 단계에서 중단되므로 원격 미접속
  - 깨진 JSON config 파일 준비: 임의 경로(예: /tmp/broken-config.json)에 정확히 '{broken' 내용 기록 (JSON.parse 실패 유발, ENOENT 아님)
  - WORMHOLE_CONFIG 환경변수를 위 깨진 파일 절대경로로 지정
  - STDIO_RPC_CLIENT: server.mjs 를 spawn 하되 stdout/stderr/exit code 를 각각 캡처 가능하게 구동
- **대상 도구**: `(부팅 단계 — 도구 호출 이전)`
- **절차**:
  1. 파일 시스템에 '{broken' 내용으로 config 파일 생성 후 절대경로 확보
  2. WORMHOLE_CONFIG=<절대경로> 환경에서 server.mjs 를 spawn (stdout/stderr 분리 캡처, exit code 수집)
  3. initialize 핸드셰이크 시도(tools/list 또는 initialize JSON-RPC 전송) — 응답 수신 여부 관측
  4. 프로세스 종료까지 대기 후 exit code 기록
  5. 캡처된 stdout 전체와 stderr 전체를 분리 검사
- **기대 결과**:
  - 프로세스 exit code ≠ 0 (main().catch → process.exit(1), loadConfig 가 throw 하므로 buildEngine 미완)
  - stderr 에 '치명적 부트스트랩 오류' 접두 + 'config 파일 읽기 실패 (' + 지정한 절대경로 + ')' + JSON.parse 에러 메시지 포함 (config.ts: `config 파일 읽기 실패 (${cfgPath}): ${(err as Error).message}`)
  - stderr 메시지는 ENOENT 경로의 'config.json 없음' / '/wormhole-setup' 문구와 다름 (비-ENOENT 분기 확정)
  - stdout: MCP JSON-RPC 프레임 한 줄도 출력되지 않음(완전 무오염) — 부팅 실패로 server.connect(transport) 미도달
  - initialize/tools/list 응답 미수신 — MCP 핸드셰이크 미수립
- **합격 기준**:
  - exit code 가 0 이 아님(엄밀히 1)
  - stderr 에 'config 파일 읽기 실패' 와 지정 절대경로가 동시 포함, 'config.json 없음'·'/wormhole-setup' 미포함 (ELC-03 ENOENT 경로와 명확 구별)
  - stdout 바이트 길이 0 또는 유효 JSON-RPC 프레임 0개 (stdout 무오염)
  - 핸드셰이크 응답 객체 0개 수신
- **신선도**: ELC-03 은 config.json 부재(ENOENT) 경로의 'config.json 없음'/'/wormhole-setup' 메시지를 봤고, ELC-02 는 passphrase 실패 경로다 — 본 시나리오만 깨진 JSON('{broken')으로 loadConfig 의 비-ENOENT catch 분기를 타 'config 파일 읽기 실패 (경로)' 래핑 메시지와 stdout 무오염·핸드셰이크 미수립을 별도 입증한다.
- **자동화 힌트**: child_process.spawn 으로 server.mjs 구동, env 에 WORMHOLE_CONFIG 주입. stdout 버퍼가 비었는지(또는 '{"jsonrpc' 미포함), stderr 가 'config 파일 읽기 실패' 정규식 매칭, exitCode!==0 을 단언.

#### ELC-11 · 빈 원격 동시 2서버 부팅 generation 생성경쟁 — manifest create 경로 putIfNoneMatch 412/405/409→PreconditionFailedError→ManifestConflictError 패자 수렴; NO_ETAG_WEBDAV putIfMatch best-effort 폴백 warn 관측  `P1`

- **갭 클로저**: F-WIRE-13 — manifest 동시 생성/갱신 경합의 두 메커니즘을 분리 검증: create 경합 = putIfNoneMatch(If-None-Match:*, ETag 무관) 패자 412/405/409 수렴; update 재시도 = putIfMatch etag=null best-effort 폴백(NO_ETAG 환경 lost-update 가능). (critic 교정 반영)
- **전제조건**:
  - NO_ETAG_WEBDAV: ETag 헤더를 반환하지 않는(또는 weak-ETag) WebDAV 서버 구동 — putIfMatch 폴백·생성경쟁 관측용
  - 빈 원격: keyparams.json·manifest.json 모두 부재 상태에서 시작(첫 생성경쟁 유발)
  - TWO_MACHINE 등가: 동일 원격 base + 동일 passphrase 를 가진 두 server.mjs 인스턴스를 별도 HOME+stateDir 로 준비, 각각 로컬에 push 할 변경 1건 보유
  - STDIO_RPC_CLIENT x2: 두 인스턴스 각각 stdin/stdout/stderr 분리 캡처
  - 독립 PROPFIND/GET 관측 클라이언트로 manifest.json generation 복호 비교 준비
- **대상 도구**: `wormhole_sync`
- **절차**:
  1. 두 server.mjs 인스턴스를 거의 동시에 spawn — buildEngine 의 ensureCryptoReady 가 keyparams 부재를 보고 첫 기기 경로(putAtomic)로 keyparams.json 생성 경쟁(한쪽 created:true). 두 부팅 모두 핸드셰이크 성공까지 확인
  2. 두 인스턴스에 거의 동시에 tools/call {"name":"wormhole_sync","arguments":{"confirm":true}} 발사 — 각 sync 의 push 단계가 둘 다 원격 manifest 부재(read()==null)를 보고 create 경로 진입 → 각자 putIfNoneMatch(If-None-Match:*) 시도
  3. 두 응답 수집: 승자 isError 없음·structuredContent.push.manifestGeneration 기록, 패자는 putIfNoneMatch 412/405/409 → PreconditionFailedError → ManifestConflictError → runPushWithRetry 재시도(원격 재read 시 manifest 존재 → update 경로) 후 최종 수렴
  4. NO_ETAG 서버이므로 패자 재시도의 update 경로에서 putIfMatch etag=null 분기 진입 — 각 인스턴스 stderr 에서 '[RemoteStore] putIfMatch: ETag 없음(서버 미지원?) — best-effort PUT 으로 폴백' warn 관측
  5. 독립 PROPFIND+복호로 최종 manifest.json 단일 정합본·generation 수렴값 확인
- **기대 결과**:
  - 승자 sync 응답: isError 없음, structuredContent.push.manifestGeneration = 정수(create 경로 +1)
  - 패자 sync 응답: 최종 isError 없음(재시도 수렴) — runPushWithRetry 가 MAX_CAS_RETRIES 내 재read→update 경로로 성공. (재시도 소진 시에만 isError:true + 'ManifestConflictError' 메시지)
  - 패자 인스턴스 stderr: '[engine] push CAS 충돌' 재시도 로그 1회 이상
  - NO_ETAG 환경 stderr: '[RemoteStore] putIfMatch: ETag 없음(서버 미지원?) — best-effort PUT 으로 폴백:' warn 문자열 관측(client.ts putIfMatch etag===null 분기) — 진짜 CAS 상실 경고
  - 최종 원격 manifest.json: manifest.json 이 ManifestSchema 로 파싱 성공(손상 없음), generation 은 두 push 중 최소 하나 이상 반영(승자 +1, NO_ETAG 환경에서 패자 update 는 best-effort 폴백이라 lost-update 가능)
- **합격 기준**:
  - 두 sync 응답 중 최소 하나는 즉시 isError 없이 성공, 다른 하나도 재시도 후 isError 없이 수렴(생성경쟁 패자가 PreconditionFailedError→ManifestConflictError→CAS 재시도로 정합 도달)
  - 패자 stderr 에 'push CAS 충돌' 재시도 흔적 존재(putIfNoneMatch 412/405/409 경로 발동 증거)
  - NO_ETAG 환경에서 stderr 에 'putIfMatch: ETag 없음' + 'best-effort PUT 으로 폴백' warn 정확 매칭(폴백 발동·CAS 상실 명시)
  - 독립 PROPFIND 로 읽은 최종 manifest.json 이 ManifestSchema 로 파싱 성공(손상 없음)하며, generation 이 두 push 중 최소 하나 이상 반영(NO_ETAG 환경 lost-update 가능성 허용)
- **신선도**: ELC-06 은 단일 NO_ETAG push 의 best-effort PUT 폴백·CAS 상실 warn 을 봤고 ELC-08 은 단일 머신 CAS 재시도 소진의 isError 표면화를 봤다 — 본 시나리오만 빈 원격에 두 서버를 동시 부팅·동시 push 해 manifest create 경로 putIfNoneMatch 생성경쟁(412/405/409→PreconditionFailedError→ManifestConflictError 패자 수렴)과 putIfMatch etag=null 폴백 warn 을 같은 와이어 흐름에서 동시 입증한다. (critic 교정 반영)
- **자동화 힌트**: 두 child_process 를 동시 spawn 후 Promise.all 로 두 push 응답 수집. 패자 식별은 stderr 의 'push CAS 충돌' 매칭으로, 폴백은 'putIfMatch: ETag 없음' 정규식으로 단언. 최종 manifest generation 은 독립 PROPFIND+복호로 수렴값 확인.

---

#### ELC-12 · 부팅 시 파생 age identity 가 derivedKeyPath 에 0600 + 헤더주석으로 캐시되고 AGE-SECRET-KEY-1 본문을 포함  `P1`

- **갭 클로저**: F-WIRE-17
- **전제조건**:
  - 환경 라벨: WRITABLE_WEBDAV + STDIO_RPC_CLIENT(또는 MCP_INSPECTOR). 깨끗한 STATEDIR(파생키 캐시 부재). passphrase 는 env 또는 0600 파일로 제공.
  - 코드 불변 확인(직접 read): `src/crypto/age.ts` initWithIdentity L20-34 — identity.trim().startsWith('AGE-SECRET-KEY-1') 아니면 throw "유효하지 않은 age identity — 'AGE-SECRET-KEY-1' 로 시작해야 함"(L23), age.identityToRecipient 로 검증·recipient 산출(L26), derivedKeyPath 주어지면 #cacheIdentity(L31). #cacheIdentity L84-94 — mkdir -p(L85), body=`# wormhole 파생 age 키 — passphrase 로부터 자동 생성됨. 수동 편집 금지.\n<identity>\n`(L86), fs.writeFile(mode:0o600)(L87) + fs.chmod 0o600(L89, Windows 는 catch 무시 L90-92).
  - `src/crypto/keyparams.ts` ensureCryptoReady 가 양 분기(기존 vault L76 / 신규 vault L97) 모두 crypto.initWithIdentity(identity, derivedKeyPath) 호출 → 부팅 시 항상 캐시 기록. derivedKeyPath 기본값 `<stateDir>/age-key.txt`(config.crypto.derivedKeyPath).
- **대상 도구**: `wormhole_status`
- **절차**:
  1. 깨끗한 STATEDIR 로 MCP 서버 부팅(buildEngine). passphrase 제공(env WORMHOLE_PASSPHRASE 또는 0600 파일).
  2. tools/call wormhole_status {} 로 부팅 완료(엔진 조립 성공) 확인 — 부팅이 ensureCryptoReady→initWithIdentity→#cacheIdentity 를 통과했음을 보장.
  3. 파일 관측: `<stateDir>/age-key.txt`(config.crypto.derivedKeyPath) 가 존재하는지 ls/stat. (CORRUPT_REMOTE 아닌 정상 부팅이므로 파일이 생성돼 있어야 함).
  4. 파일 내용 관측: 1행이 헤더 주석 '# wormhole 파생 age 키 — passphrase 로부터 자동 생성됨. 수동 편집 금지.' 이고 2행이 'AGE-SECRET-KEY-1' 로 시작하는 identity, 파일 끝에 개행.
  5. POSIX(리눅스/macOS): stat -c '%a' `<stateDir>/age-key.txt` 로 mode 가 정확히 600 인지 관측. Windows: chmod 무의미하므로 mode 검사 면제(파일 존재 + 내용만).
- **기대 결과**:
  - `<stateDir>/age-key.txt` 파일이 부팅 후 존재.
  - 파일 1행 == '# wormhole 파생 age 키 — passphrase 로부터 자동 생성됨. 수동 편집 금지.' (age.ts L86 헤더 정확 일치).
  - 파일 2행이 'AGE-SECRET-KEY-1' 로 시작(파생 identity 본문), 파일이 개행으로 끝남(body 의 trailing \n).
  - POSIX 에서 파일 권한 == 0600(소유자 rw, group/other 없음). Windows 는 mode 단언 제외(L90-92 catch 로 chmod 무시).
  - wormhole_status 응답 정상(isError 없음) — 부팅 파이프라인이 캐시 기록을 포함해 완주했음을 증명.
- **합격 기준**:
  - age-key.txt 존재(존재 = 부팅 시 initWithIdentity 가 derivedKeyPath 로 #cacheIdentity 호출했다는 직접 증거).
  - 1행 헤더 문자열이 코드 L86 과 바이트 단위 일치, 2행이 'AGE-SECRET-KEY-1' prefix.
  - POSIX: 권한 정확히 600. Windows: 권한 단언 스킵(나머지 단언만).
  - wormhole_status 정상 응답.
- **신선도**: 기존 67 시나리오에 없던 신규(ELC-12). 기존 ELC-01~11 중 어느 것도 파생키 캐시 파일의 영속·내용·권한을 관측하지 않음 → F-WIRE-17 의 black-box 관측 가능 표면(파일 존재 + 헤더주석 + AGE-SECRET-KEY-1 + 0600)을 신규 커버. (a) age.ts #cacheIdentity(L84-94) 의 0600 writeFile+chmod 가 처음으로 관측됨, (b) 헤더 주석 정확 문구(L86)와 identity prefix 동시 단언, (c) POSIX/Windows 권한 분기 명시. 방어심층 주의: initWithIdentity L22-23 의 prefix 검증 throw 는 identity 가 passphrase 에서 재파생돼 prefix 가 항상 정상이므로 정상 부팅선에서 비트리거(내부 불변·defense-in-depth) — 본 시나리오는 throw 가 아니라 캐시 산출물만 black-box 로 증명.

---

## 7. 검토(critic) 요약

### 7.1 신선도·커버리지 판정

- **freshnessVerdict**: 신선도 양호하나 일부 상호 중복 존재(overlaps 참조).
- **coverageVerdict**: 커버리지 높으나 빈 칸 존재(gaps 참조).
- **overallVerdict**: `revise` — 교정·중복축소·갭패치 반영 후 확정.

### 7.2 overlaps 2건 처리 결과

| 시나리오 | 중복 대상 | 처리 |
|---|---|---|
| SCH-06 | TRX-01 | 단순 enum/required 재확인은 TRX-01 로 흡수. SCH-06 은 **ajv 로 반환 JSON Schema 자체 유효성 검증 + 릴리스간 snapshot drift 감지** 로 범위 축소(삭제하지 않음). |
| CGW-03 | SCH-05 | 미선언 프로퍼티 strip/reject 동작은 SCH-05 로 일원화. CGW-03 은 **confirm 전달이 원격 generation 을 불변으로 두는가(와이어 무변경) 각도만 유지**(삭제하지 않음). |

### 7.3 corrections 반영 목록

| 시나리오 | 교정 대상 필드 | 교정 내용 |
|---|---|---|
| CGW-02 | step8 expected / passCriteria | preserve-both 는 watermark 미전진이라 충돌이 감소하지 않고 **동일 잔존**. 성공 판정을 conflictCopies 파일 존재 + 로컬 원본 무변경 + backupDir null + conflicts 카운트 동일로 한정. 충돌 해소 확인은 latest-wins 케이스로 분리. |
| ELC-05 | preconditions / passCriteria | `WORMHOLE_LOG_LEVEL=debug` precondition 추가(debug 로그 기본 미출력). 탈취 성공 판정을 **stderr 로그 비의존**(isError 없음 + PROPFIND 로 machineId 교체 + release 404 + ~4초 미만)으로 재정의. |
| ELC-01 | preconditions / expected | precondition 을 'remoteBaseDir 는 존재하나 blobs 미존재(또는 둘 다 미존재)'로 명확화하여 MKCOL 405 경로 강제. expected 를 (a) 미존재→405 warn / (b) 존재→no-op 분기로 명시. |
| CGW-05 | step5 / passCriteria | generation 전진 원인을 **sync 의 push 단계(resolve 아님)**로 귀속. preserve-both resolve 는 manifest 미쓰기. GEN_FINAL > GEN_BEFORE 는 push 기여로만 단언. |
| TRX-04 | passCriteria | `-32002 ServerNotInitialized` 단언은 MCP SDK 구현 의존이라 pass/fail 에서 제거하고 '관측·기록(문서화)'로 강등. wormhole 자체 계약(serverInfo.name=wormhole, version=0.1.1, capabilities.tools 존재)에만 pass/fail. |

> 위 5건은 critic `corrections` + patch `appliedCorrections`(9개 revisedField) 를 합산 반영한 것이다. 각 해당 시나리오 본문(6절)의 교정 지점에는 `(critic 교정 반영)` 표기를 두었다.

### 7.4 gaps 5건 → 패치 신규 시나리오 매핑

| 누락 차원 | 누락 시나리오 요지 | 매핑된 신규 시나리오 |
|---|---|---|
| error-lock-cas | push CAS 재시도 소진 → ManifestConflictError isError 표면화 | **ELC-08** |
| transport-registration | WEBDAV_USER 부재 + remoteBaseDir 미설정 시 부팅 halt | **TRX-08** |
| settings-mcp-routing | settings.json 공유키 양측 발산 시 3-way 머지 동작 | **SMR-08** |
| input-schema-zod | (v4 제거) dry_run direction:pull 의 PullResult 결과타입 계약 — dry_run 도구 노출 제거로 시나리오 삭제, sync 미리보기 {pull,push} 합본 계약은 CGW-01 이 흡수 | **삭제(구 SCH-08)** |
| conflict-policies | preserve-both resolve 멱등성(사본 중복 미생성) | **CFL-08** |

### 7.6 커버리지 갭 클로저 (v2 보강)

적대적 커버리지 감사(`docs/MCP_COVERAGE_MATRIX.md`)가 식별한 mcp-boundary 갭을 닫기 위해 13개 신규 시나리오를 추가했다. 각 시나리오는 `gapClosed` 필드로 자신이 메우는 featureId(`F-*` / `universeGap:*`)와 결손을 명시하며, 아래 표는 그 갭→신규 시나리오 매핑과 severity(priority 기반: P0=Critical / P1=High / P2=Medium)를 정리한다.

| featureId / 갭 요약 | 신규 ID | severity |
|---|---|---|
| F-CONFIG-04 — loadDotEnvIntoProcess 가 이미 존재하는 process.env 키를 덮지 않음(host env 우선)을 부팅 산출물로 관측 | **TRX-09** | Medium |
| F-CONFIG-02/03/05 — loadDotEnvIntoProcess 파싱 규칙(따옴표 1쌍 1회 제거, 트레일링 # 값 보존, 전체줄 주석 skip, 파일 부재 silent) 도출 config 로 관측 | **TRX-10** | Medium |
| F-CONFIG-17 — buildEngine 의 평문 http 감지 분기가 logger.warn 을 stderr 로 1회 방출하고 stdout 미오염임을 관측 | **TRX-11** | High |
| universeGap(description) — tools/list 와이어 노출되는 3개 도구 title/description 의 confirm 안전 가이드 문구 존재/부재 단언(문구 drift 회귀 감지) | **TRX-12** | High |
| universeGap:sync-no-conflict-apply — sync.ts confirm:true 비충돌 경로에서 resolve 를 건너뛰고 pull→push 만 실제 적용하는 분기 | **CGW-06** | High |
| universeGap:sync-preview-stop-on-error — sync.ts 미리보기 분기에서 pull dryRun throw 가 push dryRun 산출을 막아 isError 로 귀결 | **CGW-07** | High |
| F-SETTINGS-14 — settings-merge 의 isForbiddenKey/FORBIDDEN_KEYS 가드가 원격 신뢰불가 JSON 의 프로토타입 오염 키를 모든 객체 재구성 지점에서 차단 | **SMR-09** | High |
| F-SETTINGS-06 — normalizeSettingsForSync 의 try/catch 폴백이 비-JSON 로컬 settings 를 throw 없이 원본 바이트 hash/size 로 처리 | **SMR-10** | Medium |
| F-SETTINGS-13 — mergeMcpJsonForPull 의 local===null 분기가 로컬 .mcp.json 부재/손상 시 원격기반 stableStringify 로 복구 산출 | **SMR-11** | Medium |
| F-WIRE-14 — 단일 프로세스 내 push/pull/resolve 가 AsyncMutex.runExclusive 로 직렬화되어 동시 호출이 와이어 인터리브 손상을 내지 않음 | **ELC-09** | High |
| F-CONFIG-08 — loadConfig 가 config.json 의 비-ENOENT 오류를 'config 파일 읽기 실패 (경로)' 로 래핑해 throw(ENOENT 경로와 구별) | **ELC-10** | Critical |
| F-WIRE-13 — manifest 동시 생성/갱신 경합 두 메커니즘 분리(create=putIfNoneMatch 패자 수렴, update=putIfMatch best-effort 폴백) | **ELC-11** | High |
| F-ENGINE-17 — runPull 의 try/catch 원자성: 부분 적용 중 예외 시 rollback→throw 로 로컬을 pull 이전 상태로 전부 복원 | **TMB-08** | High |

### 7.7 잔여 갭 마감 (v2 재감사 — 적대적 재증명)

`proven=true` 도달을 위한 적대적 재증명(v2 재감사)이 v2 보강 이후에도 남은 잔여 갭을 식별했다: SMR-09 가 push 측 tokenize 가드만 행사하는 partial 상태였고, 사각(blind) 4건(F-CONFIG-10 passphrase 소스메타 override, F-CONFIG-14 normalizeBaseDir 정규화, F-CONFIG-16 passphraseFile 경로해석, F-WIRE-17 파생키 0600 캐시)이 어떤 시나리오로도 블랙박스 행사되지 않았다. 이를 SMR-09 강화(pull 측 3가드 + .mcp.json 경로) + 신규 TRX-13/14/15 + ELC-12 로 닫았고, 추가로 TRX-12 를 거짓양성(과도 부분문자열·title 정확값) 제거 정밀화로 재증명했다.

| 갭 featureId | 처리 시나리오 | 비고 |
|---|---|---|
| F-SETTINGS-14 (SMR-09 partial) | **SMR-09** (강화) | push 단방향 tokenize(L40) → pull 측 detokenize(L62)/mergeRecursive(L169)/deepAssign(L433) 3가드 + .mcp.json 경로 행사. P1→P0 승격 |
| F-CONFIG-10 — passphrase 소스메타 override | **TRX-13** (신규·보강) | WORMHOLE_PASSPHRASE_FILE env→config.passphraseFile override + env>file 우선순위를 부팅 stderr 'passphrase 소스:' 로 증명. 추가로 WORMHOLE_KEYCHAIN_SERVICE env→config.keychainService override(config.ts:172)를 전 소스 실패 시 부팅 throw 메시지의 `keychain service wormhole-test` 부분문자열로 증명 (재증명 완전화) |
| F-CONFIG-14 — normalizeBaseDir 정규화 | **TRX-14** (신규) | 지저분한 remoteBaseDir(4케이스)이 실제 MKCOL 컬렉션 경로로 정규화됨을 독립 PROPFIND 로 증명 |
| F-CONFIG-16 — passphraseFile 경로해석 | **TRX-15** (신규) | config.crypto.passphraseFile 의 빈문자열 기본값/상대 path.resolve/틸드 확장 해석을 부팅 file 소스 적중으로 증명 |
| F-WIRE-17 — 파생키 0600 캐시 | **ELC-12** (신규) | derivedKeyPath 파일 존재 + 헤더주석 + AGE-SECRET-KEY-1 본문 + POSIX 0600 를 블랙박스 관측 |
| universeGap(description) — 거짓양성 정밀화 | **TRX-12** (정밀화) | 신규 갭 아님. 2차 부분문자열·6 title 정확값 단언을 제거해 description 미세 수정 시 거짓양성 fail 회피 |

---

## 7.8 최종 증명 결과 (v3 무사각 기준)

3차 적대적 재증명(코드 기능우주 98 mcp-boundary 전수 재매핑) 결과: **none=0(무사각, no blind spot)** — 모든 mcp-boundary 기능이 ≥1 시나리오로 커버됨. 신규 거짓커버 0, 회귀 0.

- **증명 기준 명시**: 본 계획서의 'proven' 은 **무사각 기준** = "모든 mcp-boundary 기능에 그 동작을 행사하는 시나리오가 ≥1개 존재(none=0)" 를 의미한다. 이 기준으로 **proven=true**.
- **정직 단서(직접/간접 분해)**: 98 mcp-boundary 중 direct(전용 직접 단언) 74 · partial(기존 시나리오가 간접 행사하되 전용 직접 단언만 부재) 24 · none 0. partial 24는 별도 `MCP_COVERAGE_MATRIX.md v3` 의 간접커버 등록부에 severity 와 함께 기재되며, 고가치 항목(보안 path-traversal F-ENGINE-24 등)은 향후 직접 단언 승격 후보다.

### 7.8.1 v2 표적 6건 클로저 요약

| 표적 | 처리 | 상태 |
|---|---|---|
| F-SETTINGS-14 (SMR-09 partial) | SMR-09 강화 — pull 측 detokenize/mergeRecursive/deepAssign 3가드 + .mcp.json 경로 행사, P1→P0 승격 | closed |
| universeGap(description) 거짓양성 | TRX-12 FP 정밀화 — 2차 부분문자열·6 title 정확값 단언 제거 | closed |
| F-CONFIG-10 passphrase 소스메타 override | TRX-13 — passphraseFile env override(기존) + keychainService env override(본 편집 보강) | closed (본 편집으로 완전화) |
| F-CONFIG-14 normalizeBaseDir 정규화 | TRX-14 — 지저분한 remoteBaseDir 4케이스 정규화를 독립 PROPFIND 로 증명 | closed |
| F-CONFIG-16 passphraseFile 경로해석 | TRX-15 — 빈문자열 기본값/상대 path.resolve/틸드 확장 해석을 부팅 file 소스 적중으로 증명 | closed |
| F-WIRE-17 파생키 0600 캐시 | ELC-12 — derivedKeyPath 존재·헤더주석·본문·POSIX 0600 블랙박스 관측 | closed |

> v2 표적 6건은 **전부 closed** (F-CONFIG-10 은 본 편집으로 완전화). none=0 무사각 기준에서 **proven=true**.

---

## 7.9 실행 결과 (자동화 스위트)

계획서를 실제 `plugin/dist/server.mjs` 에 stdio JSON-RPC 로 구동해 실측했다(투영 아님).

- **하네스**: `test/mcp/harness.mjs` — server.mjs `child_process.spawn` + 줄바꿈 구분 JSON-RPC 클라이언트 + `webdav-harness.mjs`(인메모리 쓰기 WebDAV) 연결 + 2머신/격리 헬퍼. 실행: `npm run test:mcp`.
- **결과**: **40 시나리오 / 40 PASS** (7차원 전부). 기존 스위트 무회귀(unit 466/0, e2e 3/0), typecheck 클린.

| 차원 | 실행 시나리오 |
|---|---|
| Transport·등록 | smoke, TRX-01, TRX-04, TRX-12, TRX-13, TRX-14 |
| confirm-gate | CGW-01, CGW-02, CGW-03, CGW-04, CGW-05, CGW-06, CGW-07 |
| input-schema | SCH-01, SCH-02, SCH-03, SCH-04 |
| conflict | CFL-01, CFL-02, CFL-03, CFL-04, CFL-06 |
| settings-routing | SMR-01, SMR-02, SMR-03, SMR-05, SMR-06, SMR-08, **SMR-09**(보안) |
| tombstone | RT 왕복, TMB-02, TMB-03, TMB-08 |
| error-lock-cas | ELC-02, ELC-03, ELC-04, ELC-09, ELC-10, **F-ENGINE-24**(보안) |

- **그레이박스 보안 실증**: F-ENGINE-24(경로탈출)·SMR-09(프로토타입 오염) — 테스트가 vault 키를 재파생해 악성 원격 manifest/blob 을 직접 주입, pull 가드가 거부함을 MCP 경계에서 확인.
- **모드 B 자율 수정 = 코드 버그 0**: SMR-01/SMR-05 2건은 **테스트 결함**(base 부재 양측 발산을 remote-wins 로 오가정)이었고, 진단으로 실동작이 일관된 conflict-gating(settings·.mcp.json 모두 충돌 분류·로컬 보존·미적용)임을 확인 후 테스트를 교정, SMR-08 로 그 동작을 positively 기록. 소스 결함 발견 0.
- **발견 처리**: (F1) server version `0.1.1`→`0.1.3` 동기화(`src/index.ts` + `build:plugin` 재빌드, smoke 회귀가드 추가). (F2) MCP stdio framing 은 Content-Length 가 아니라 줄바꿈 구분 — §4.2·TRX-02/07 교정 반영.
- **환경 제약 미실행(가짜 미충족 — 명시 기록)**: TRX-05 SIGINT(Windows 시그널 상이), ELC-12 0600 권한(POSIX 전용), ELC-06/11 NO_ETAG·ELC-01 readonly-WebDAV(인메모리 하네스가 항상 강 ETag·쓰기 허용), ELC-05 lock TTL 실시간 타이밍, TRX-11 평문 http 경고(non-localhost http 필요). 이들은 실서버/타 OS 환경에서 별도 실행.

---

## 8. 실행 가이드

### 8.1 권장 실행 순서 (P0 먼저)

1. **전송·등록** (TRX 차원) — 환경 가볍고 격리 쉬움. 특히 무경합 부팅/스키마 시나리오(TRX-08, SCH-01) 우선.
2. **confirm 게이트** (CGW 차원) — 단일 머신 또는 경량 TWO_MACHINE.
3. **스키마** (SCH 차원) — zod 거부·계약 검증, 환경 가벼움.
4. **충돌** (CFL 차원) — 단일 머신 충돌 주입(CFL-08) 후 TWO_MACHINE 발산.
5. **라우팅** (SMR 차원) — TWO_MACHINE + `${HOME}` 토큰화 공간 필요.
6. **tombstone** (TMB 차원) — 삭제 전파·수렴, TWO_MACHINE.
7. **에러/락/CAS** (ELC 차원) — CORRUPT_REMOTE/경합에이전트/NO_ETAG 등 가장 무거운 셋업.

> crossCuttingNotes 실행 순서 권고: (1) 부팅·스키마 무경합(TRX-08, SCH-01) → (2) 단일 머신 충돌주입(CFL-08, ELC-08, CORRUPT_REMOTE/경합 셋업) → (3) TWO_MACHINE(SMR-08, CGW-05) 마지막. 각 시나리오는 신선한 remote prefix(또는 purge)로 격리해 generation 누적 오염을 방지한다.

### 8.2 환경별 묶음 실행

| 환경 라벨 | 묶음 시나리오 |
|---|---|
| `WRITABLE_WEBDAV` 단일 머신 | TRX-01~07, CGW-01/05/06, SCH-*, SMR-01/03/06/07, TMB-01/04, ELC-05/06/07/08 |
| `TWO_MACHINE` | CGW-02/03/04/07, CFL-01~08, SMR-02/04/05/08, TMB-02/03/05/06/07, ELC-04 |
| `READONLY_WEBDAV` | ELC-01 |
| `NO_ETAG_WEBDAV` | ELC-06 |
| `CORRUPT_REMOTE` | ELC-07 |
| 격리 부팅(WebDAV 불필요) | TRX-06/08, ELC-02/03 |

### 8.3 판정 자동화 요약

- **structuredContent 키 집합 단언**: 응답을 JSON Schema(ajv) 또는 키 셋 비교로 단언한다. sync 미리보기의 {pull, push} 합본 키 집합은 키 셋 비교로 자동판정(CGW-01).
- **isError 단언**: `응답.isError===true && structuredContent 부재` 로 판정.
- **로그 단언**(ELC-01/05/08): stderr 라인 정규식 매칭. 단, 레벨 의존성 주의 — debug 로그는 `WORMHOLE_LOG_LEVEL=debug` 선결(ELC-05).
- **재시도 횟수 단언**(ELC-08): 'push CAS 충돌' warn 라인 카운트 === `MAX_CAS_RETRIES`(코드 상수)로 일치 검증.
- **와이어 무변경 단언**(CGW 차원): 독립 PROPFIND/GET 으로 `manifest.json` generation·`lock.json` machineId·`blobs/*` 존재를 호출 전후 비교. generation 은 평문 필드면 직접, 암호화면 도구 status 의 `manifestGeneration` 보조 사용.
- **stdout/stderr 분리**(TRX-08, ELC-01/05): `spawn` 시 `stdio:['pipe','pipe','pipe']` 로 fd1/fd2 독립 수집.

---

## 9. 부수 발견·후속 (Findings)

| # | 발견 | 신호·후속 |
|---|---|---|
| 1 | **server version 하드코딩 불일치** | `index.ts` serverInfo.version = `"0.1.1"` 인데 `package.json` 은 `0.1.3`. 릴리스 시 동기화 누락 신호. TRX-01/TRX-04 의 serverInfo 단언은 `"0.1.1"` 기준으로 pass/fail 을 걸되, 불일치 자체는 별도 문서화 항목으로 기록(릴리스 동기화 점검 필요). |
| 2 | **NO_ETAG best-effort CAS 폴백의 lost-update 위험** | `NO_ETAG_WEBDAV` 의 best-effort PUT 폴백이 weak-ETag 환경(Apache `mod_dav`)에서 `putIfMatch` CAS 를 깨 lost-update 위험. ELC-06(폴백 경고) 및 보조 generation CAS 동작과 연계. CAS 의존 시나리오(ELC-05/08)는 강한 ETag 서버 필수. |
| 3 | **READONLY_WEBDAV 부팅 거동 확인 필요** | ELC-01 의 `ensureDir` MKCOL 405 분기는 디렉터리 존재 여부에 따라 405 warn(미존재) 또는 no-op(존재)로 갈린다. `client.ts` ensureDir(61-72)의 `client.exists()` 선행 분기 거동을 실측으로 확정 필요. |
| 4 | **preserve-both watermark 미전진 거동** | `engine.ts` runResolve preserve-both 는 base/state watermark 를 의도적으로 미전진(사용자 수동 정리 전제). 충돌이 잔존하므로 CGW-04/CFL-08 의 멱등·재호출 가능 상태가 유지된다. 설계 의도이나 사용자 혼란 가능 — 문서·UX 점검 후보. |

---

> 본 계획서는 설계(7차원) → critic 검토(overlaps/corrections/gaps) → 패치(appliedCorrections/additionalScenarios/crossCuttingNotes) 산출물을 조립한 것이다. push/pull/dry_run 도구 제거(v4) 반영 후 총 67개 시나리오, P0 22 / P1 34 / P2 11.

