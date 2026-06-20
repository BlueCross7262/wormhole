# wormhole 검증 계획 (Verification Plan)

wormhole 의 동기화 파이프라인(스캔 → diff → gzip → age 암호화 → WebDAV 업로드,
그리고 그 역방향)이 실제로 올바르게 동작함을 입증하기 위한 3층 검증 전략을 정의한다.

- 계약(engine/config)은 안정적이며 두 인터페이스(CLI, MCP 툴)가 `buildEngine()` 을 통해
  동일한 엔진을 공유한다. 따라서 엔진 자체를 한 번 입증하면 두 인터페이스 모두에 대한 신뢰가
  확보된다.
- 본 문서의 검증은 위→아래로 갈수록 통합 수준이 높아진다: 단위(엔진 내부) → 툴 어댑터 →
  실 HTTP 왕복.

---

## (a) 툴 레이어 테스트 — `src/tools/tools.test.ts`

MCP 툴 레이어는 엔진을 호출하는 **얇은 어댑터**다. 입력 스키마(zod) 검증, 엔진 메서드로의
정확한 매핑, 결과 포맷팅, 에러 → `isError` 변환만 책임진다. 실제 동기화 로직은 엔진에 있으므로
툴 테스트는 **mock 엔진**으로 어댑터 계약만 검증한다(네트워크/암호화 불필요).

### 커버 대상 (확정 설계 기준)

툴 이름은 LOCKED decision 에 따라 `wormhole_status`, `wormhole_dry_run`, `wormhole_push`,
`wormhole_pull`, `wormhole_resolve`, `wormhole_sync` 다.

- **등록(registration)** — `registerAllTools` 가 정확히 위 6개 툴을 기대한 이름/타이틀/설명과
  함께 등록한다.
- **입력 스키마 검증** — 각 툴이 유효 입력은 수락하고 무효 입력(잘못된 타입, 누락된 필수값,
  enum 범위 밖 정책 값 등)은 zod 에러로 거부한다.
- **엔진 매핑** — 각 핸들러가 대응 엔진 메서드를 정확한 인자로 호출한다:
  - `wormhole_status` → `engine.status()`
  - `wormhole_dry_run` → `engine.push({dryRun:true})` / `engine.pull({dryRun:true})`
  - `wormhole_push` / `wormhole_pull` / `wormhole_resolve` → 대응 엔진 메서드
  - `wormhole_sync` → pull → resolve → push 순차 호출
- **confirm 게이트(쓰기 툴 안전성)** — 본 프로젝트의 핵심 안전 계약:
  - 읽기 전용 툴(`wormhole_status`, `wormhole_dry_run`)은 변경 없음 → 자율 호출 허용.
  - 쓰기 툴(`wormhole_push`, `wormhole_pull`, `wormhole_resolve`, `wormhole_sync`)은
    `confirm:boolean`(기본 `false`)을 받는다.
    - `confirm !== true` → 엔진을 `{dryRun:true}` 로 실행하고 **미리보기 + 안내문**을 반환한다.
    - `confirm === true` → 실제 실행.
  - 테스트는 두 분기(미리보기 vs 실행)가 각각 올바른 `dryRun` 값으로 엔진을 호출하는지,
    기본값이 안전한 미리보기인지 검증한다.
- **결과 포맷팅** — `SyncStatus` / `PushResult` / `PullResult` / `ResolveResult` 가 사람이
  읽을 수 있는 `CallToolResult` 텍스트로 변환된다.
- **에러 격리** — 엔진 메서드가 throw 하면 unhandled rejection 없이 `isError:true` 툴 결과로
  표면화된다.

> **현재 상태 주의** — 저장소의 `src/tools/tools.test.ts` 는 pivot 이전(`sync_*` 이름,
> async/jobManager 경로, confirm 게이트 없음) 버전이 아직 남아 있을 수 있다. 툴 레이어 복원
> 작업에서 위 확정 설계(`wormhole_*` 이름, 동기 전용, confirm 게이트)에 맞춰 재작성된다.
> 본 e2e 검증은 툴 레이어와 **독립적**이며 안정적인 engine/config 계약에만 의존하므로, 툴
> 재작성과 무관하게 그린 상태를 유지한다.

실행: `npm test` (`tsx --test "src/**/*.test.ts"` — 엔진 단위 테스트 포함 전체).

---

## (b) 로컬 쓰기 가능 WebDAV 하네스 + e2e 왕복

순수 단위/mock 테스트만으로는 **실제 HTTP 와이어 동작**(조건부 PUT 의 412, MKCOL,
PROPFIND multistatus 파싱, MOVE 기반 원자 쓰기, ETag 헤더 회수)을 입증할 수 없다. 그러나
사용자의 실서버(Apache mod_dav)는 사실상 읽기 전용이라(아래 (c) 참조) 쓰기 왕복 테스트의
타깃이 될 수 없다. 이 간극을 메우기 위해 **자체 완결형 로컬 WebDAV 서버**를 둔다.

### `test/webdav-harness.mjs` — 실 HTTP WebDAV 서버

외부 의존성 없이 `node:http` + `node:crypto` 만으로 구현한 인메모리 WebDAV 서버.
`src/webdav/client.ts` 의 `RemoteStore` 가 `webdav` npm 클라이언트를 통해 구동하는 HTTP
부분집합을 **정확히** 미러링한다.

| RemoteStore 메서드            | webdav 클라이언트 동작        | 하네스 HTTP                        |
|------------------------------|------------------------------|-----------------------------------|
| `ensureDir`                  | `createDirectory(recursive)` | PROPFIND d0(탐침) + MKCOL          |
| `exists` / `getTextIfExists` | `exists` → `getStat`         | PROPFIND d0 (부재 시 404)          |
| `putAtomic`                  | `putFileContents` + `moveFile` | PUT(tmp) + MOVE(Destination)    |
| `put`                        | `putFileContents`            | PUT                                |
| `getText` / `getTextWithETag`| `getFileContents(text,details)` | GET (ETag 헤더)               |
| `getBinary`                  | `getFileContents(binary)`    | GET                                |
| `putIfMatch`                 | `customRequest` If-Match     | PUT (불일치 시 412)                |
| `putIfNoneMatch`             | `customRequest` If-None-Match:* | PUT (존재 시 412)              |
| `list`                       | `getDirectoryContents`       | PROPFIND d1 (207 multistatus)      |
| `deleteFile`                 | `exists` + `deleteFile`      | PROPFIND d0 + DELETE               |

핵심 충실도(fidelity) 포인트:

- **ETag** — 강한(strong) ETag 를 콘텐츠 해시에서 파생한다. 동일 콘텐츠는 동일 ETag,
  변경 시 ETag 회전 → `putIfMatch` CAS 가 실서버처럼 동작한다.
- **조건부 PUT** — `If-None-Match: *` 는 리소스 존재 시 412, `If-Match: <etag>` 는 현재
  ETag 와 강비교하여 불일치 시 412. (매니페스트 CAS·락 획득의 핵심)
- **PROPFIND XML** — RFC4918 207 multistatus 를 반환한다. `webdav` 클라이언트의 파서는
  `removeNSPrefix:true` 이므로 `d:` 네임스페이스 접두는 자동 제거되며, `resourcetype` 의
  `collection` 유무로 디렉터리/파일을 구분한다. 컬렉션 href 에는 후행 슬래시를 붙인다.
- **MKCOL** — 신규 생성 시 201, 이미 존재 시 405(`createDirectory(recursive)` 가 PROPFIND
  으로 먼저 탐침하므로 정상 경로에서는 405 가 거의 발생하지 않음).
- **MOVE** — `Destination` 헤더(절대 URL)를 경로로 환원하여 원자적 이동을 수행. `putAtomic`
  의 tmp → 최종 경로 이동을 실제 HTTP 로 입증한다.

API: `start(port?) → Promise<{ url, port, store, close() }>`. 포트 미지정 시 127.0.0.1 의
임시(ephemeral) 포트에 바인딩한다. `store` 는 테스트가 와이어 상태(암호문 누출 여부 등)를
직접 검사할 수 있도록 노출한다.

### `test/roundtrip.test.ts` — e2e 왕복

`node:test`(tsx 실행) 기반. **실제 엔진**(`buildEngine`)과 **실제 하네스**를 결합한다.

**접근 방식 — 두 HOME, 하나의 원격 (현실적 다중 머신 시나리오):**

- HOME A 와 HOME B 는 각자 독립된 임시 디렉터리·`stateDir`·파생키 캐시를 갖되, **같은
  하네스 URL** 과 **같은 passphrase** 를 사용한다.
- age 키는 `passphrase + salt` 에서 결정적으로 파생되고, **salt 는 원격
  `keyparams.json` 에 저장**된다(`src/crypto/keyparams.ts: ensureCryptoReady`). HOME A 가
  첫 push 때 이를 부트스트랩하고, HOME B 는 pull 때 **같은 원격 salt** 를 읽어 **동일한 age
  키** 를 파생한다. 이것이 실제 두 머신이 수렴하는 방식 그대로이므로, 두 HOME 간 salt/keyparams
  를 수동으로 맞출 필요가 없다.
- `buildEngine()` 은 인자 없이 `loadConfig()` 를 호출하며, 이는 `WORMHOLE_CONFIG` /
  `WEBDAV_URL` / `WORMHOLE_PASSPHRASE` 환경변수를 존중한다. 두 엔진은 한 프로세스에서 순차
  실행되므로 각 HOME 빌드 직전 env 를 재설정한다.
- 테스트 속도를 위해 config 의 `kdfN` 을 낮춘다(기본 2^16 → 1024). 단, 부트스트랩 시점의
  파라미터가 원격 keyparams 에 기록되므로 HOME B 는 로컬 config 값과 무관하게 원격 값을
  상속한다.

**절차 및 단언(assertions):**

1. 하네스 기동.
2. **PUSH (HOME A)** — `.claude/CLAUDE.md` + `.claude/settings.json` 작성 후
   `engine.push()`(실제 암호화 + 업로드).
   - `pushed` 에 두 파일이 포함됨을 단언.
   - 원격에 `keyparams.json` · `manifest` · 2개 이상의 암호화 blob 이 실제로 존재함을 단언.
   - **암호화 입증** — 어떤 blob 도 평문(`"round-trip fixture"`)을 포함하지 않음을 단언
     (와이어 상에서 암호화됨).
3. **PULL (HOME B)** — 빈 `.claude` 에서 `engine.pull()`(실제 다운로드 + 복호).
   - pull 전 HOME B 에 `CLAUDE.md` 가 없음을 사전조건으로 확인.
   - `applied` 에 `.claude/CLAUDE.md` 포함을 단언.
4. **왕복 충실도(핵심)** — HOME B 의 `.claude/CLAUDE.md` 가 HOME A 원본과 **바이트 단위로
   동일**함을 단언(push→gzip→암호화→업로드→다운로드→복호→gunzip→적용 전체 왕복 입증).
   `settings.json` 은 엔진이 settings-merge 로 키 순서를 정규화하므로 **의미적(JSON deep)
   동일성** 으로 단언한다.
5. **멱등성** — 두 번째 pull 이 깨끗한 no-op(적용/삭제/충돌 0)이고, `status` 가 in-sync
   (로컬 발산 없음, 충돌 없음)임을 단언.
6. 임시 디렉터리 정리 + 하네스 종료 + env 복원.

결정적·자체완결형이며 외부 네트워크가 필요 없다.

**실행:** `npm run test:e2e`  (`tsx --test "test/**/*.test.ts"`)

**입증하는 것:** wormhole 의 동기화 파이프라인이 **실제 HTTP WebDAV** 위에서 end-to-end 로
정확하게 동작한다 — 조건부 PUT(CAS)·MKCOL·PROPFIND·MOVE·ETag 회수의 와이어 의미론, 그리고
암호화 왕복의 바이트 충실도.

---

## (c) 실서버 주의사항 (REAL-server caveat)

사용자의 실 WebDAV 서버(`wormhole.mybestweb.site`, Apache `mod_dav`)는 **현재 구성상 사실상
읽기 전용**이라 wormhole 의 쓰기 경로를 받아낼 수 없다.

### 관측된 증상

- **`PUT` → 405 Method Not Allowed** — blob/매니페스트 업로드 불가.
- **`MKCOL` → 405 Method Not Allowed** — `/wormhole`, `/wormhole/blobs` 레이아웃 생성 불가.
- **`/wormhole` 가 DAV 경로가 아님** — 해당 location 에 `mod_dav` 가 활성화되어 있지 않아
  WebDAV 메서드(PROPFIND/PUT/MKCOL/MOVE/DELETE/PROPPATCH)가 핸들링되지 않는다.

즉 GET/PROPFIND 일부는 동작할 수 있으나, 동기화에 필수인 **쓰기 메서드 전반이 거부**되어
push 가 부트스트랩(keyparams) 단계부터 실패한다.

### 필요한 서버측 수정 (운영자 작업)

쓰기 가능한 DAV location 을 노출해야 한다. Apache 예시:

```apache
# 쓰기 가능한 물리 디렉터리 (httpd 사용자가 쓰기 권한 보유해야 함)
Alias /wormhole /var/www/dav/wormhole

<Location /wormhole>
    DAV On

    # 인증 (익명 쓰기 금지 권장)
    AuthType Basic
    AuthName "wormhole"
    AuthUserFile /etc/apache2/wormhole.htpasswd
    Require valid-user

    # 동기화에 필요한 쓰기 메서드 허용
    <LimitExcept GET HEAD OPTIONS PROPFIND>
        Require valid-user
    </LimitExcept>
</Location>
```

핵심 요건:

- 대상 location 에서 **`DAV On`** — PROPFIND / **PUT** / **MKCOL** / **MOVE** / **DELETE** /
  **PROPPATCH** 가 핸들링되도록.
- `mod_dav` · `mod_dav_fs` 모듈 로드.
- DAV 물리 경로에 httpd 프로세스 사용자의 **쓰기 권한** 부여.
- `DavLockDB` 설정(`mod_dav` 락 지원; MOVE/원자 쓰기 안정성).
- wormhole 측 **`WEBDAV_BASEDIR`(또는 config `remote.remoteBaseDir`)를 쓰기 가능한 DAV
  경로로** 지정(예: `/wormhole`). 평문 http 라면 Tailscale 등 암호화 전송을 함께 권장
  (buildEngine 이 평문 http 에 대해 경고함).

### 결론

- 실서버의 위 한계는 **서버 구성 문제**이며 wormhole 코드/파이프라인의 결함이 아니다.
- wormhole 의 동기화 파이프라인은 위 (b) 의 로컬 하네스(실 HTTP, 실 암호화)에 대해 이미
  end-to-end 로 **입증 완료**되었다. 운영자가 서버에 쓰기 가능한 DAV location 을 활성화하면,
  동일 파이프라인이 실서버에서도 그대로 동작한다.
