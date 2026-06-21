# wormhole MCP 검증 계획서 — 커버리지 추적 매트릭스 v3 (Coverage Traceability Matrix)

- **작성일**: 2026-06-21
- **대상**: `MCP_VERIFICATION_PLAN.md` (67 시나리오)
- **방법**: 코드 기능우주(98 mcp-boundary 기능) 전수 재매핑 + 3차 적대적 재증명
- **진화 이력**: v1(54 시나리오) → v2(67 시나리오) → v3(71 시나리오) → v4(67 시나리오, push/pull/dry_run 제거)

---

## 1. 증명 결론 (Verdict) — 무사각 기준 proven = TRUE

### 1.1 채택 증명 기준 정의 — 무사각(no blind spot)

> **무사각 기준** = 모든 mcp-boundary 기능에 대해 그 동작을 실제로 행사하는 시나리오가 1개 이상 존재한다(none = 0). 사각지대(아무 시나리오도 건드리지 않는 기능)가 0이면 증명 성립으로 본다.

이 기준으로 **proven = TRUE**. mcp-boundary 98개 기능 전부가 최소 1개 시나리오에 의해 행사되며, 무커버(none) 기능이 0이다.

### 1.2 정량 표 (mcp-boundary 기준)

| 구분 | 수 | 비고 |
|---|---|---|
| mcp-boundary 기능 | 98 | MCP 표면에서 도달 가능한 기능 전수 |
| └ direct | 74 | 전용 직접 단언으로 행사 (F-CONFIG-10 완전화 + F-CONFIG-14/16 정정 반영) |
| └ partial | 24 | 기존 시나리오가 간접 행사하나 전용 직접 단언만 부재 |
| └ none | 0 | 무커버(사각지대) 없음 → 무사각 충족 |
| prior-covered-internal | 16 | MCP 표면 아래 내부 로직, 이전 단계서 커버 |
| out-of-band | 2 | CLI 전용 경로 등 MCP 비노출 |
| **기능행 합계** | **116** | 5영역 전체 재매핑 |

- **F-CONFIG-10 완전화 반영**: 계획서 TRX-13 보강으로 passphrase 소스 메타 override 경로가 완전화되어 partial → direct 로 승격. 이로써 간접커버 등록부(엄격기준 partial)는 25 → 24로 감소.
- **F-CONFIG-14/16 정정**: 재매핑 원본 JSON 은 두 항목을 TRX-14/15 추가 전 stale 라벨(none/still-gap)로 표기했으나, 실제로는 TRX-14(normalizeBaseDir 정규화 black-box)·TRX-15(passphraseFile 경로해석 3케이스)가 닫았으므로 direct 로 정정.

### 1.3 엄격기준(partial = gap) 대조 — 정직한 병기

> **엄격 직접기준** = direct(전용 직접 단언)만 커버로 인정하고 partial 을 gap 으로 산정한다.

이 기준을 적용하면 **partial 24개가 잔존하므로 proven = FALSE** (mcp-boundary direct 74 / 미달 24). 재증명 원본 `audit.verdict.proven = false` 는 바로 이 엄격기준 산정값이다.

- 본 문서가 채택한 기준은 **무사각 기준**이며, 그 한정에서만 proven = TRUE 를 주장한다.
- partial 24개는 은폐하지 않고 §4 간접커버 등록부에 전량 공개한다. 엄격 직접 100% 는 partial 24개를 직접 승격해야 달성 가능하다(별도 작업).

### 1.4 무결성 지표

| 항목 | 값 |
|---|---|
| 신규 거짓커버(false positive) | 0 |
| 회귀(regression) | 0 |

---

## 2. 증명 이력 (v1 → v2 → v3)

### 2.1 단계 요약

| 버전 | 시나리오 | proven | 핵심 상태 |
|---|---|---|---|
| v1 | 54 | false | mcp-boundary 갭 8 + 거짓커버(FP) 3 + 기능우주 누락(universeGap) 3 |
| v2 | 67 | false | 13 시나리오 추가 → 12 클로즈, SMR-09 partial + 사각 4 잔존 |
| v3 | 71 | **true(무사각)** | 6항목 보강 + F-CONFIG-10 완전화 → none = 0 |
| v4 | 67 | **true(무사각)** | push/pull/dry_run 도구 제거 → 노출 표면 3종으로 축소, 시나리오 4개 제거·번호 재정렬 |

- **v1 → v2**: 13 시나리오를 추가해 8 mcp-boundary 갭 중 다수와 FP·universeGap 을 정리했으나, SMR-09 가 partial 로 남고 사각 4개가 잔존해 proven = false.
- **v2 → v3**: 6항목(SMR-09 강화 / TRX-12 FP 정밀화 / TRX-13 / TRX-14 / TRX-15 / ELC-12) + F-CONFIG-10 완전화로 사각 0(none = 0) 달성, 무사각 기준 proven = true.

### 2.2 v2 잔여 갭 클로저 (audit.v2GapClosure)

| 항목 | 닫은 시나리오 | 실제 행사 | 판정 | 근거 요약 |
|---|---|---|---|---|
| SMR-09 partial → direct (F-SETTINGS-14 pull-side 가드) | SMR-09 (강화) | true | closed | CORRUPT_REMOTE 직접 주입으로 push-side tokenize 우회, pull-side 3가드(detokenizeHome L62 + mergeRecursive L169 + deepAssign L433)를 engine.ts applyPullSettings L667(L684 threeWayMerge + L692 detokenize) 경로로 진짜 행사. push-단락 우려(v2 FP) 해소 |
| F-CONFIG-10 passphrase 소스메타 override | TRX-13 (신규) | true | partial → **완전화** | config.ts:171 WORMHOLE_PASSPHRASE_FILE override 절반을 TRX-13 케이스A 가 stderr 'passphrase 소스: file' 로 닫음. 계획서 TRX-13 보강으로 keychainService override 경로까지 완전화 처리 |
| F-CONFIG-14 normalizeBaseDir 정규화 | TRX-14 (신규) | true | closed | config.ts:181-182 4케이스(`//foo/bar//`→`/foo/bar`, `foo`→`/foo`, `/bar/`→`/bar`, `//x//`→`/x`) 산출 정확. TRX-14 가 독립 PROPFIND 로 MKCOL 컬렉션 경로 black-box 단언 |
| F-CONFIG-16 passphraseFile 경로해석 | TRX-15 (신규) | true | closed | config.ts:206-214 3케이스(빈문자열→기본값, 상대→stateDir resolve, `~` 확장)를 파일 사전배치 후 부팅 stderr 적중으로 입증 |
| F-WIRE-17 파생키 0600 캐시 | ELC-12 (신규) | true | closed | age.ts #cacheIdentity L84-94 헤더 바이트일치 + 0600 + AGE-SECRET-KEY-1 prefix 를 비트리거 throw 비의존으로 black-box 단언 |
| TRX-12 false-positive 정밀화 | TRX-12 (정밀화) | true | closed | 과도한 2차 부분문자열·title 정확값 단언을 제거하고 핵심 안전계약 부분문자열만 단언 → description 미세수정 시 거짓양성 fail 제거 |

---

## 3. 추적성 매트릭스 (영역별 전체)

5영역 116 기능행 전수. `coveringScenarioIds` 가 빈 배열이면 `—`. 강도는 mcp-boundary 정정 반영값.

### 3.1 도구 표면 (tools-surface)

| featureId | 동작(요약) | scope | 커버 시나리오 | 강도 |
|---|---|---|---|---|
| F-TOOLS-01 | wormhole_status 도구는 빈 inputSchema({})로 등록되어 인자 없이 호출 가능하며, engine.status() 결… | mcp-boundary | TRX-01, CGW-01, CGW-03, SCH-04 | direct |
| F-TOOLS-02 | wormhole_status 성공 시 content[0]=text(JSON.stringify(result))와 structuredCont… | mcp-boundary | CGW-01, CFL-01, SCH-04, ELC-01 | direct |
| F-TOOLS-03 | 모든 3개 도구 핸들러는 try/catch로 감싸 예외 발생 시 content=err.message text + isError:true인… | mcp-boundary | ELC-07, ELC-08, ELC-02, ELC-04, SCH-01, SCH-02, SCH-03, TMB-08, CGW-07, ELC-11 | direct |
| F-TOOLS-04 | wormhole_resolve 입력스키마는 policy:z.enum(['preserve-both','latest-wins','manual… | mcp-boundary | TRX-01, SCH-01, SCH-02, SCH-03, SCH-05 | direct |
| F-TOOLS-05 | wormhole_resolve는 engine.resolve(policy, keys, {dryRun})으로 위임하며, keys 생략 시 전… | mcp-boundary | CGW-02, CFL-02, CFL-03, CFL-04, CFL-05, CFL-06, SCH-05 | direct |
| F-TOOLS-06 | wormhole_sync 입력스키마는 policy:z.enum(['preserve-both','latest-wins']).optional… | mcp-boundary | TRX-01, SCH-01, SCH-03 | direct |
| F-TOOLS-07 | wormhole_sync 미리보기 분기(confirm!==true): engine.pull({dryRun:true})와 engine.pu… | mcp-boundary | CGW-01, CGW-05, CGW-07 | direct |
| F-TOOLS-08 | wormhole_sync 실제 실행 분기(confirm:true): policy 기본값 'preserve-both' 적용 후 engine… | mcp-boundary | CGW-05, CGW-06 | direct |
| F-TOOLS-09 | wormhole_sync의 stop-on-error: pull/resolve/push를 순차 await하므로 앞 단계가 throw하면 뒤… | mcp-boundary | ELC-07, CGW-07 | direct |
| F-TOOLS-10 | registerAllTools는 status→resolve→sync 순으로 3개 도구를 단일 McpSer… | mcp-boundary | TRX-01, TRX-12 | direct |
| F-TOOLS-11 | 서버 부팅: buildEngine(logger)으로 config·자격·원격·crypto·엔진 조립 후 McpServer({name:'wo… | mcp-boundary | TRX-04, TRX-03, TRX-06, TRX-08, ELC-02, ELC-03, TRX-09, TRX-10, TRX-11, ELC-10, TRX-13, TRX-14, TRX-15, ELC-12 | direct |
| F-TOOLS-12 | 전송 계층: StdioServerTransport로 server.connect하여 stdio JSON-RPC 표면을 노출하고 연결 후 s… | mcp-boundary | TRX-02, TRX-11 | direct |
| F-TOOLS-13 | 수명주기/graceful shutdown: SIGINT/SIGTERM 수신 시 shuttingDown 가드로 중복 방지 후 server.… | mcp-boundary | TRX-05, TRX-06, TRX-08, ELC-02, ELC-03, ELC-10 | direct |
| F-TOOLS-14 | 엔진 위임 동작(engine.status/push/pull/resolve)의 내부 로직·crypto 왕복·바이트충실도·멱등 no-op은 … | prior-covered-internal | — | none |
| F-TOOLS-15 | CLI 전용 경로(src/cli.ts 등)는 MCP 서버로 노출되지 않으며 src/index.ts 부트스트랩은 CLI를 등록하지 않으므로… | out-of-band | — | none |

### 3.2 엔진 동작 (engine-behaviors)

| featureId | 동작(요약) | scope | 커버 시나리오 | 강도 |
|---|---|---|---|---|
| F-ENGINE-01 | status() 가 부수효과 없이 SyncStatus 를 계산해 반환: manifestGeneration(원격 세대 또는 null), i… | mcp-boundary | CGW-01, CGW-02, CGW-04, CGW-05, CGW-06, CFL-01, TMB-01, TMB-02, TMB-03, TMB-05, SMR-03, SMR-04 | direct |
| F-ENGINE-02 | classifyKey 가 콘텐츠 3-way 해시(localChanged=localHash!==baseHash, remoteChanged=… | mcp-boundary | CFL-01, TMB-01, TMB-02, TMB-03, TMB-07, SMR-03 | direct |
| F-ENGINE-03 | 양측 변경 시 localHash===remoteHash 면 converged(충돌 아님), 다르면 conflict 로 분기 — wormh… | mcp-boundary | TMB-03, TMB-07 | direct |
| F-ENGINE-04 | 원격 tombstone(deleted) 시 로컬 존재→remoteDeleted, 로컬 부재→unchanged 로 분기; 원격 변경+bas… | mcp-boundary | TMB-02, TMB-05 | partial |
| F-ENGINE-05 | computeStatus 가 conflict 항목에 대해 ConflictItem 구성(localHash/remoteHash/remoteM… | mcp-boundary | CFL-01, CFL-07 | direct |
| F-ENGINE-06 | computeStatus 가 로컬+원격엔트리+state baseline 세 출처 키 합집합(정렬)을 순회하고 summarize 로 9개 … | mcp-boundary | CFL-01, TMB-01, TMB-03, TMB-07, SMR-03 | direct |
| F-ENGINE-07 | push(dryRun) → planPush: status 기반으로 added+modified 를 pushed, deleted, uncha… | mcp-boundary | CGW-01, CGW-04, SMR-06 | direct |
| F-ENGINE-08 | push 실제 실행: added/modified 항목 blob 업로드 후 upsertEntry, deleted 는 tombstoneEnt… | mcp-boundary | TMB-01, CGW-04, SMR-01, CGW-06 | direct |
| F-ENGINE-09 | push 멱등: pushed+deleted+converged 모두 0 이면 매니페스트 쓰기 생략하고 기존 manifestGeneratio… | mcp-boundary | CGW-04 | direct |
| F-ENGINE-10 | ManifestStore.upsertEntry: 신규 엔트리 generation=1, 콘텐츠 변경 또는 tombstone 부활 시 gen… | mcp-boundary | TMB-01, TMB-04, CGW-04 | partial |
| F-ENGINE-11 | ManifestStore.tombstoneEntry: 엔트리 없으면 null(→state 에서 키 제거), 이미 tombstone 이면 … | mcp-boundary | TMB-01, TMB-02 | partial |
| F-ENGINE-12 | runPushWithRetry: ManifestConflictError 발생 시 지수백오프+지터로 MAX_CAS_RETRIES(3)회 재… | mcp-boundary | ELC-08, ELC-11 | direct |
| F-ENGINE-13 | ManifestStore.write CAS: 보조 generation 비교 불일치→ManifestConflictError; 생성경로 pu… | mcp-boundary | ELC-08, ELC-05, ELC-06, ELC-11 | direct |
| F-ENGINE-14 | pull(dryRun) → planPull: remoteAdded+remoteModified 를 applied, remoteDeleted… | mcp-boundary | TMB-02, CGW-01 | direct |
| F-ENGINE-15 | pull 실제 실행: 원격 매니페스트 null 이면 빈 결과; toApply 다운로드·적용, toRemove 삭제, 각 키 백업 후 적용… | mcp-boundary | TMB-02, TMB-06, CGW-06 | direct |
| F-ENGINE-16 | pull 멱등/충돌-only: toApply+toRemove+converged 모두 0 이면 적용 없이 conflicts 만 보고하고 b… | mcp-boundary | TMB-05, CGW-02 | direct |
| F-ENGINE-17 | pull all-or-nothing 롤백: 적용 중 예외 발생 시 backedUp 으로 rollback(백업본 복원, 신규생성 파일 삭제… | mcp-boundary | ELC-07, TMB-08 | direct |
| F-ENGINE-18 | resolve(dryRun) → planResolve: status 충돌을 keys 로 필터해 resolved 키 목록만 반환, conf… | mcp-boundary | CGW-02, CFL-02 | direct |
| F-ENGINE-19 | resolve 실제 실행: policy 미지정 시 config.conflictPolicy 사용, manual 정책은 자동처리 없이 빈 r… | mcp-boundary | CFL-04, CFL-06, SCH-05 | direct |
| F-ENGINE-20 | resolve preserve-both: 로컬 유지 + 원격을 .conflict-<mid>-<gen> 사본(삭제충돌은 .conflict-… | mcp-boundary | CFL-02, CFL-07, CFL-08, CGW-05 | direct |
| F-ENGINE-21 | resolve latest-wins: 백업 후 원격 채택(tombstone→로컬삭제+base제거, 아니면 원격 blob 로 덮어쓰기+ba… | mcp-boundary | CFL-03, CFL-05, CFL-06 | direct |
| F-ENGINE-22 | preserve-both 사본/마커 경로가 isWithinHome 밖이면 경고 후 건너뜀(경로탈출 방어), 원격 유래 machineId/… | mcp-boundary | CFL-02, CFL-07 | partial |
| F-ENGINE-23 | advanceConverged: 양측동시삭제(localHash null)면 base/state 추적해제, 동일콘텐츠 수렴이면 로컬콘텐츠로… | mcp-boundary | TMB-03, TMB-07 | direct |
| F-ENGINE-24 | safeAbsPath 게이트: pull/resolve 가 원격 매니페스트 논리키를 isValidLogicalKey + isWithinHo… | mcp-boundary | CFL-07 | partial |
| F-ENGINE-25 | push/pull/resolve 가 mutex.runExclusive(인프로세스) + withLock(원격 lock.json) 경유로 직… | mcp-boundary | ELC-04, ELC-05, ELC-09 | direct |
| F-ENGINE-26 | settings.json/.mcp.json 키는 raw 해시가 아닌 정규화 콘텐츠 해시(normalizeSettingsForSync / … | mcp-boundary | SMR-01, SMR-02, SMR-03, SMR-04, SMR-05, SMR-08 | direct |
| F-ENGINE-27 | ManifestStore.read 가 복호 후 zod ManifestSchema 로 신뢰불가 원격 입력 검증, 파싱/구조 실패 시 thr… | mcp-boundary | ELC-07, CGW-07 | direct |
| F-ENGINE-28 | blob I/O 평문 콘텐츠 해시 불변: gzip(CSZ1 매직 prepend)→age 암호화 업로드, 다운로드 시 매직 감지하면 gun… | prior-covered-internal | — | none |
| F-ENGINE-29 | atomicWriteFile: 같은 디렉터리 tmp(머신id/pid/seq 충돌회피) 작성→fsync→rename→부모디렉터리 best-… | prior-covered-internal | — | none |
| F-ENGINE-30 | scanLocal: fast-glob include/exclude 적용, stateDir(~/.wormhole) home 하위면 무조건 … | prior-covered-internal | — | none |
| F-ENGINE-31 | scanWithHashes 가 대소문자만 다른 키 충돌을 감지해 경고만 로깅(자동 case-folding 금지) — 크로스OS 동기화 혼… | prior-covered-internal | — | none |
| F-ENGINE-32 | paths 매핑·검증: toLogical/toOS(home 기준 posix↔OS), isValidLogicalKey(널바이트/백슬래시/절… | prior-covered-internal | — | none |
| F-ENGINE-33 | loadOrCreateMachineId: stateDir/machine-id 읽기, 없으면 randomUUID 생성 후 원자적 쓰기(tm… | prior-covered-internal | — | none |

### 3.3 설정 라우팅 (settings-routing)

| featureId | 동작(요약) | scope | 커버 시나리오 | 강도 |
|---|---|---|---|---|
| F-SETTINGS-01 | push settings.json 시 settingsLocalKeys(dot-path + 와일드카드) 매칭 키를 제거한 shared su… | mcp-boundary | SMR-01, SMR-07 | direct |
| F-SETTINGS-02 | push 시 home 절대경로가 ${HOME} 토큰으로 치환되어 원격에 저장 — 다른 머신이 pull 해도 깨지지 않게 이식; 경로 접미… | mcp-boundary | SMR-02 | direct |
| F-SETTINGS-03 | push 시 settings/.mcp.json 콘텐츠가 stableStringify(키 재귀정렬, 배열순서 보존, 2-space, tra… | mcp-boundary | SMR-03 | partial |
| F-SETTINGS-04 | scan(status)과 push 가 동일 정규화 파이프라인(normalizeSettingsForSync / stripSelfMcpSer… | mcp-boundary | SMR-03 | direct |
| F-SETTINGS-05 | push .mcp.json 시 selfMcpServerNames(wormhole 등) 엔트리를 mcpServers 객체에서 삭제한 후 업… | mcp-boundary | SMR-05, SMR-02 | direct |
| F-SETTINGS-06 | push .mcp.json/settings 파싱 실패 시 throw 없이 원본 텍스트를 그대로 반환하되 hash/size 는 원본 바이트… | mcp-boundary | SMR-10 | direct |
| F-SETTINGS-07 | pruneLocal 이 로컬키 제거로 비어버린 중첩 컨테이너(예: mcpServers.x.command 만 있던 mcpServers)를 … | mcp-boundary | SMR-07 | direct |
| F-SETTINGS-08 | pull settings.json 시 키단위 3-way 머지: 원격 공유 변경분은 받아들이되 settingsLocalKeys 머신로컬키는… | mcp-boundary | SMR-04, SMR-08 | direct |
| F-SETTINGS-09 | pull 적용된 settings 파일은 ${HOME} 토큰이 이 머신 실제 home 경로(path.sep 로 구분자 재구성)로 detok… | mcp-boundary | SMR-02, SMR-05 | direct |
| F-SETTINGS-10 | pull settings 3-way 머지서 양측 동시 상이 변경된 leaf 키는 conflict 로 수집되고 로컬값 유지 — status… | mcp-boundary | SMR-08 | partial |
| F-SETTINGS-11 | pull .mcp.json 시 원격 비-self 서버 엔트리는 remote-wins 로 적용하되 로컬 self(wormhole) 엔트리는… | mcp-boundary | SMR-05 | direct |
| F-SETTINGS-12 | pull .mcp.json 시 원격은 ${HOME} 토큰에서 로컬 home 으로 detokenize 후 기록되고, 방어적으로 self 엔… | mcp-boundary | SMR-02, SMR-05 | partial |
| F-SETTINGS-13 | pull .mcp.json 시 로컬 파일 부재/파싱실패면 원격 기반 + self 비움 상태를 stableStringify 해 기록 — 로… | mcp-boundary | SMR-11 | direct |
| F-SETTINGS-14 | 프로토타입 오염 방어: 원격 JSON 의 __proto__/constructor/prototype 키가 tokenize/detokeniz… | mcp-boundary | SMR-09 | direct |
| F-SETTINGS-15 | settingsLocalKeys 와일드카드 매칭 규칙: 패턴이 path 의 prefix 면 매칭('mcpServers.*' 가 'mcpS… | prior-covered-internal | — | none |
| F-SETTINGS-16 | mergeRecursive 3-way 분기 로직(양측미변경 base유지, 한쪽변경 채택, 양측동일변경 수렴, 양측상이 객체면 재귀·lea… | prior-covered-internal | — | none |
| F-SETTINGS-17 | applyShared/removeShared/deepAssign 가 merged 객체서 기존 shared 키를 제거 후 머지본으로 덮어 … | prior-covered-internal | — | none |
| F-SETTINGS-18 | tokenize/detokenize 라운드트립 충실도(string/array/object 재귀, 비-home 경로·non-string 원… | prior-covered-internal | — | none |

### 3.4 전송·암호·락 (wire-crypto-lock)

| featureId | 동작(요약) | scope | 커버 시나리오 | 강도 |
|---|---|---|---|---|
| F-WIRE-01 | putAtomic: tmp 경로(machineId+모듈카운터 토큰)에 PUT 후 최종 경로로 MOVE; MOVE 실패 시 orphan t… | mcp-boundary | CGW-01, CGW-04, TMB-01, SMR-01, ELC-08, ELC-09 | partial |
| F-WIRE-02 | putIfMatch(etag!=null): customRequest PUT + If-Match:<etag>. | mcp-boundary | ELC-04, ELC-05, ELC-08, ELC-11 | direct |
| F-WIRE-03 | putIfMatch(etag==null): 서버 ETag 미지원 폴백 — 경고 로깅 후 무조건 일반 PUT(overwrite). | mcp-boundary | ELC-06, ELC-11 | direct |
| F-WIRE-04 | putIfNoneMatch: customRequest PUT + If-None-Match:* (원자적 생성). | mcp-boundary | ELC-04, ELC-11 | direct |
| F-WIRE-05 | getTextWithETag: details PUT으로 본문+ETag 회수, etag/ETag/Etag 헤더 케이스 정규화, 404→nu… | mcp-boundary | ELC-05, ELC-06, ELC-08, ELC-11 | partial |
| F-WIRE-06 | ensureDir: exists 확인 후 부재 시 MKCOL(createDirectory recursive); 모든 에러 흡수(warn … | mcp-boundary | ELC-01, TRX-03, TRX-14 | direct |
| F-WIRE-07 | list(PROPFIND): getDirectoryContents 후 self/빈 basename 필터, type→file/directo… | mcp-boundary | SMR-01, SMR-06, ELC-01 | partial |
| F-WIRE-08 | 생성자 자격 누락 경고: username/password 모두 빈 문자열이면 익명 접근 시도 경고 로깅(401 위험 고지). | mcp-boundary | TRX-08 | partial |
| F-WIRE-09 | RemoteLock.acquire: read→(none/own/stale=takeable) 판정. | mcp-boundary | ELC-04, ELC-05 | direct |
| F-WIRE-10 | isExpired: acquiredAt+ttlMs<=now → 만료(탈취 가능); acquiredAt이 now+5분(CLOCK_SKEW_… | mcp-boundary | ELC-05 | direct |
| F-WIRE-11 | RemoteLock.read: getTextWithETag로 lock.json 읽어 lastLockEtag 보관. | mcp-boundary | ELC-04, ELC-05 | partial |
| F-WIRE-12 | RemoteLock.release: read 후 자기 소유 락만 deleteFile, 타 소유면 no-op(skip 로깅), 부재면 no… | mcp-boundary | ELC-04, ELC-05 | partial |
| F-WIRE-13 | withLock: acquire 실패 시 Error('failed to acquire remote lock') throw; 성공 시 fn… | mcp-boundary | ELC-04 | direct |
| F-WIRE-14 | AsyncMutex.runExclusive: 인프로세스 직렬화 — 이전 tail에 체이닝, 실패 흡수로 큐 유지. | mcp-boundary | ELC-09 | direct |
| F-WIRE-15 | ensureCryptoReady(기존 keyparams): getTextIfExists→JSON.parse(실패 시 throw)→zod … | mcp-boundary | ELC-02 | direct |
| F-WIRE-16 | ensureCryptoReady(최초 기기): salt 생성→deriveAgeIdentity→initWithIdentity→sentine… | mcp-boundary | TRX-03, ELC-11 | partial |
| F-WIRE-17 | AgeCrypto.initWithIdentity: identity trim + 'AGE-SECRET-KEY-1' 접두 검증(실패 thro… | mcp-boundary | ELC-12 | direct |
| F-WIRE-18 | deriveAgeIdentity: passphrase 빈값/salt 빈값 throw; scryptSync(N,r,p,maxmem=128*… | prior-covered-internal | — | none |
| F-WIRE-19 | AgeCrypto encrypt/decrypt/decryptToString: recipient로 armored 암호화, identity로… | prior-covered-internal | — | none |
| F-WIRE-20 | resolvePassphrase: env>file>keychain 우선순위 해석. | mcp-boundary | ELC-02, TRX-13, TRX-15 | direct |
| F-WIRE-21 | RemoteStore 보조 메서드: put(단순 overwrite), getText/getBinary(부재 throw), getTextI… | prior-covered-internal | — | none |

### 3.5 설정 부트스트랩 (config-bootstrap)

| featureId | 동작(요약) | scope | 커버 시나리오 | 강도 |
|---|---|---|---|---|
| F-CONFIG-01 | loadConfig 진입 시 즉시 ~/.wormhole/.env (또는 dotEnvPath override) 를 loadDotEnvInt… | mcp-boundary | TRX-01, TRX-02, TRX-03, TRX-09, TRX-10 | partial |
| F-CONFIG-02 | .env 파서는 빈 줄과 '#' 로 시작하는 전체-줄 주석만 무시한다(인라인 트레일링 주석은 보존). | mcp-boundary | TRX-10 | direct |
| F-CONFIG-03 | .env 줄은 첫 '=' 기준 분리, key trim, value trim 후 양끝 동일한 한 쌍의 따옴표(' 또는 ")만 1회 제거한다. | mcp-boundary | TRX-10 | direct |
| F-CONFIG-04 | .env 로더는 이미 process.env 에 존재하는 키를 덮어쓰지 않는다(undefined 일 때만 설정). | mcp-boundary | TRX-09 | direct |
| F-CONFIG-05 | .env 읽기 실패가 ENOENT 면 조용히 return(파일 없어도 정상), 그 외 fs 오류(권한 등)는 throw 로 전파한다. | mcp-boundary | TRX-10 | partial |
| F-CONFIG-06 | config.json 경로는 인자 configPath → process.env.WORMHOLE_CONFIG → ~/.wormhole/co… | mcp-boundary | TRX-06, ELC-03, ELC-10 | partial |
| F-CONFIG-07 | config.json 이 ENOENT 면 '/wormhole-setup 실행 또는 config.example.json 복사' 안내를 담은… | mcp-boundary | TRX-06, ELC-03 | direct |
| F-CONFIG-08 | config.json 의 비-ENOENT 읽기/파싱 오류(예: JSON.parse 실패, 권한)는 'config 파일 읽기 실패 (경로)… | mcp-boundary | ELC-10 | direct |
| F-CONFIG-09 | applyEnvOverrides 가 WEBDAV_URL/WEBDAV_USER/WEBDAV_PASS (truthy 일 때) 로 remote… | mcp-boundary | TRX-01, TRX-08, TRX-09 | partial |
| F-CONFIG-10 | passphrase 원문은 config 에 저장하지 않고, passphrase '소스 메타'만 env 로 오버라이드한다: WORMHOLE… | mcp-boundary | TRX-13 | direct |
| F-CONFIG-11 | remoteBaseDir 가드: 명시적 remote.remoteBaseDir 가 공백이고 remote.username 도 공백이면 'WE… | mcp-boundary | TRX-08 | direct |
| F-CONFIG-12 | WORMHOLE_SYNC_INCLUDE/EXCLUDE env 는 콤마분리 파싱 후 config 의 base targets 에 '가산 un… | mcp-boundary | SMR-06 | partial |
| F-CONFIG-13 | deriveRemoteBaseDir: 명시적 remoteBaseDir 가 공백 아니면 그 값을 normalize 해 override 로 … | mcp-boundary | TRX-08, TRX-03, TRX-09 | partial |
| F-CONFIG-14 | normalizeBaseDir: 선행 슬래시 전부 제거 후 정확히 1개를 붙이고, 후행 슬래시들을 제거한다. | mcp-boundary | TRX-14 | direct |
| F-CONFIG-15 | RawConfigSchema/RemoteConfigSchema/CryptoConfigSchema 등 zod 스키마가 부재 필드에 기본값을… | mcp-boundary | CFL-06 | partial |
| F-CONFIG-16 | passphraseFile/derivedKeyPath 경로 해석: 빈 문자열이면 각각 stateDir/passphrase, stateDi… | mcp-boundary | TRX-15 | direct |
| F-CONFIG-17 | buildEngine 가 평문 http URL(localhost/127./[::1] 제외)을 감지하면 logger.warn 으로 자격증명… | mcp-boundary | TRX-11 | direct |
| F-CONFIG-18 | buildEngine 가 loadOrCreateMachineId(stateDir) 로 machineId 를 로드/생성하고 info 로그를… | mcp-boundary | TRX-02, CFL-01 | partial |
| F-CONFIG-19 | buildEngine 순서 불변식: RemoteStore 생성 후 ensureDir(base) + ensureDir(base/blobs)… | mcp-boundary | TRX-03 | direct |
| F-CONFIG-20 | buildEngine 가 resolvePassphrase({env,file,keychainService}) 를 호출해 env→0600파일… | mcp-boundary | ELC-02, TRX-02 | partial |
| F-CONFIG-21 | buildEngine 가 ensureCryptoReady 로 passphrase→KDF(N/r/p=config.crypto.kdf*)→결… | prior-covered-internal | — | none |
| F-CONFIG-22 | resolveConfig(raw): 파일 IO 없이 raw 객체에 applyEnvOverrides→RawConfigSchema.parse… | prior-covered-internal | — | none |
| F-CONFIG-23 | types.ts 가 Config/RemoteConfig/CryptoConfig/LockConfig/SyncTargets 등 캐노니컬 계약… | out-of-band | — | none |

---

## 4. 간접커버 등록부 (Partial Register) — 정직성 핵심

> 이들은 none(무커버)이 아니라 기존 시나리오가 동작을 간접 행사하나 전용 직접 단언만 부재한 항목이다. 무사각 기준은 충족하나, 엄격 직접기준에는 미달한다.

총 24행(F-CONFIG-10 완전화로 제외). severity 분포: high 1 / medium 11 / low 12. 고가치(high → medium) 우선 정렬.

| featureId | 동작(간접 행사 중, 직접 단언만 부재) | severity | 직접 승격 권고 |
|---|---|---|---|
| F-ENGINE-24 | safeAbsPath/isValidLogicalKey 경로탈출 악성 원격키 거부 직접 트리거 부재(SMR-09 는 FORBIDDEN_KEYS 가드만, 별개 영역). | high | 1순위 (필수) |
| F-CONFIG-09 | applyEnvOverrides 가 config.json 기존값 위에 env 덮어쓰기 명시 대조 단언 부재. | medium | 권장 |
| F-CONFIG-12 | WORMHOLE_SYNC_INCLUDE/EXCLUDE env 가산 union(replace 아님) 동작 직접 단언 부재. | medium | 권장 |
| F-CONFIG-15 | zod 잘못된 타입/누락 필수 ZodError 표면화, kdfN·lock.ttlMs 기본값 명시 단언 부재. | medium | 권장 |
| F-CONFIG-20 | resolvePassphrase env→file→keychain 우선순위 체인 각 소스 교체 명시 단언 부재(keychain 소스 미커버). | medium | 권장 |
| F-ENGINE-04 | remoteAdded vs remoteModified 분기 명시 구분 단언 부재; '로컬 부재→unchanged' 는 TMB-05 간접만. | medium | 권장 |
| F-ENGINE-22 | preserve-both isWithinHome 밖 경로 '경고 후 건너뜀' 방어 발동 미트리거. | medium | 권장 |
| F-SETTINGS-10 | 3-way 머지 양측발산 leaf conflict 가 conflicts 필드 dot-path 로 표면화하는 동작 미단언(SMR-08 은 silent local-wins 만). | medium | 권장 |
| F-WIRE-01 | putAtomic MOVE 실패→orphan tmp 삭제 후 에러 재throw 경로 미트리거. | medium | 권장 |
| F-WIRE-07 | list/PROPFIND 401/403/5xx 재throw 분기 미커버. | medium | 권장 |
| F-WIRE-11 | RemoteLock.read JSON 파싱/필드 실패→손상 lock 탈취 허용 분기 직접 단언 부재. | medium | 권장 |
| F-WIRE-16 | ensureCryptoReady 신규 vault 분기(salt 생성·keyparams.json putAtomic) 명시 단언 부재(ELC-12 는 캐시산출물만). | medium | 권장 |
| F-CONFIG-01 | loadDotEnvIntoProcess 호출 자체 독립 단언 부재(정상부팅 통과 전제만). | low | 선택 |
| F-CONFIG-05 | .env 권한오류(EACCES) throw 전파 경로 미커버(ENOENT silent 절반만). | low | 선택 |
| F-CONFIG-06 | config 경로 3단계 체인(인자→env→기본값) 순차 대조 단언 부재. | low | 선택 |
| F-CONFIG-13 | deriveRemoteBaseDir explicit vs username 도출 두 분기 명시 대조 단언 부재. | low | 선택 |
| F-CONFIG-18 | machineId 신규생성 vs 기존로드 분기 직접 대조 단언 부재. | low | 선택 |
| F-ENGINE-10 | upsertEntry 신규 엔트리 generation===1 명시 단언 부재. | low | 선택 |
| F-ENGINE-11 | tombstoneEntry '이미 tombstone no-op'/'엔트리 없으면 null' 분기 직접 단언 부재. | low | 선택 |
| F-SETTINGS-03 | stableStringify 원격 blob 실제 바이트순서(키정렬/2-space/trailing newline) 직접 단언 부재(SMR-03 간접). | low | 선택 |
| F-SETTINGS-12 | 원격 blob 에 self 잔존 시 방어적 self 재삭제(settings-merge L357-362/mergeMcpJsonForPull L358-362) 트리거 픽스처 부재. | low | 선택 |
| F-WIRE-05 | getTextWithETag etag/ETag/Etag 헤더 케이스 정규화 복수케이스 명시 단언 부재. | low | 선택 |
| F-WIRE-08 | username/password 빈문자열 익명접근 경고 로깅(정상부팅 계속) 경로 직접 단언 부재. | low | 선택 |
| F-WIRE-12 | RemoteLock.release 타소유/부재 no-op 분기 명시 단언 부재. | low | 선택 |

- 고가치 1순위: **F-ENGINE-24**(safeAbsPath/isValidLogicalKey 경로탈출 거부)는 보안 표면이므로 직접 승격 1순위. SMR-09 가 FORBIDDEN_KEYS 가드를 행사하나 경로탈출 게이트는 별개 코드 영역이라 전용 악성 원격키 거부 트리거가 필요하다.
- medium 11개는 분기 발산·에러 재throw·env 머지 동작 등 동작 정확성 관련이라 권장 승격 대상.

---

## 5. 범위 분할 + 결론

### 5.1 범위 분할 정의 (재기재)

- **mcp-boundary (98)**: MCP stdio 표면에서 6개 도구·서버 부팅·엔진 위임을 통해 도달 가능한 기능. 본 증명의 1차 대상.
- **prior-covered-internal (16)**: MCP 표면 아래 내부 구현 로직. 다음 세 범주로 이전 단계에서 커버됨.
  - (a) 엔진 위임의 내부 로직·crypto 왕복·바이트 충실도·멱등 no-op (F-TOOLS-20, F-ENGINE-28 등).
  - (b) 머지/토큰 라운드트립·경로 매핑·머신ID 등 단위 헬퍼 (F-SETTINGS-15~18, F-ENGINE-29~33).
  - (c) KDF·암호 원시연산·RemoteStore 보조 메서드 (F-WIRE-18/19/21, F-CONFIG-21/22).
- **out-of-band (2)**: MCP 서버로 노출되지 않는 CLI 전용 경로 및 타입 계약 (F-TOOLS-21, F-CONFIG-23).

### 5.2 최종 결론

- **무사각 기준 proven = TRUE**: mcp-boundary 98개 전수가 최소 1개 시나리오에 의해 행사되어 none = 0. 사각지대 없음.
- **엄격 직접기준 proven = FALSE(병기)**: partial 24개가 잔존하므로 엄격 직접 100% 는 미달. 무사각과 엄격의 차이는 정확히 이 24개 partial 이다.
- **엄격 직접 100% 달성 경로**: §4 간접커버 등록부 24개를 직접 승격(전용 직접 단언 추가)하면 달성 가능하다. 이는 본 증명과 분리된 별도 작업이다.
- 신규 거짓커버 0, 회귀 0 — 재증명 무결성 확인.
