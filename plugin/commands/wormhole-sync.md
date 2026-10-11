---
description: wormhole 동기화 실행 (pull→push)
argument-hint: "[--policy latest-wins | merge] | [--force-up | --force-down] [--dry-run]"
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- `sync` 는 pull → (충돌 시 resolve) → push 순서로 실행한다.
  `sync` 는 내부적으로 `syncAtomic` 을 거친다.
- 기본 정책은 `preserve-both` (비파괴적, 양쪽 버전 보존).
- 덮어쓰기를 원하면 `--policy latest-wins` 를 전달한다 (`$ARGUMENTS` 에 포함).
  - 이 정책을 받은 `sync` 는 원격 최신본(마지막 push)을 채택한다.
    기준은 파일 mtime 이 아니다.
- 자동 해소를 원하되 비파괴적으로 하려면 `--policy merge` 를 전달한다.
  - 이 정책을 받은 `sync` 는 `settings.json` 만 키 단위로 3-way 자동 머지한다.
  - 그 외 파일·leaf 충돌·삭제 충돌은 `preserve-both` 로 폴백한다.
- `manual` 정책과 `ours` 정책은 sync 에서 쓸 수 없다.
  `sync` 는 두 값을 오류로 거부한다.
  충돌을 수동으로 해소하거나 로컬본을 채택하려면 `/wormhole-resolve` 를 실행한다.
- `sync` 는 `--dry-run` 을 `--force-up`·`--force-down` 에서만 쓴다.
  `sync` 는 일반 실행에서 이 플래그를 무시하고 실제로 pull 과 push 를 한다.
- pull 또는 resolve 단계에서 오류가 나면 `sync` 는 push 없이 중단한다.
- `syncAtomic` 은 설치 전제조건(미설치 플러그인·마켓플레이스 참조)과 잔존 충돌을 하드배리어로 검사한다.
  하나라도 걸리면 `syncAtomic` 은 push 를 차단하고 종료 코드 1 로 끝난다.

## 성공 결과 요약 서식

결과 JSON 이 아래 셋 중 하나면 이 서식으로 요약한다.

- 일반 sync — `aborted: false` 와 `pull`·`push` 를 담는다.
- `--force-up` — `forceUpload` 키 하나를 담는다.
  그 값은 `push` 와 같은 모양이다.
- `--force-down` — `forceDownload` 키 하나를 담는다.
  그 값은 `pull` 과 같은 모양이다.

- 값은 결과 JSON 에서 그대로 옮긴다.
- 결과 JSON 에 없는 사실을 요약에 적지 않는다.
- 요약은 아래 첫 줄과 본문 표의 행으로만 구성한다.
  표에 없는 필드, 결과에 대한 추론, 종료 코드·실행 경위를 덧붙이지 않는다.
  예외는 이 문서의 다른 절이 요구하는 안내(Force 모드 경고 등)뿐이다.
- 성공 결과에서는 사용자에게 질문하지 않는다.
- force 모드에서는 아래 `pull.` 을 `forceDownload.` 으로, `push.` 를 `forceUpload.` 으로 읽는다.

### 첫 줄

첫 줄에 결과 한 줄을 적는다.
모드마다 아래 서식을 쓴다.

```
일반 sync  — sync 완료 — pull 적용 <applied 수>·삭제 <removed 수>, push 업로드 <pushed 수>·삭제 <deleted 수>, 세대 <manifestGeneration>
force-up   — force-up 완료 — 업로드 <pushed 수>·삭제 <deleted 수>, 세대 <manifestGeneration>
force-down — force-down 완료 — 적용 <applied 수>·삭제 <removed 수>
```

- `dryRun: true` 면 「완료」를 「계획(dry-run, 변경 없음)」으로 바꾼다.
  이때 `manifestGeneration` 은 예상치라 세대 뒤에 「(예상)」을 붙인다.
- `manifestGeneration` 이 `null` 이면 세대 자리에 「원격 manifest 없음」을 적는다.

### 본문

첫 줄 아래에 pull 블록, push 블록 순서로 적는다.
force 모드는 해당 블록 하나만 적는다.

| 필드 | 조건 | 표기 |
|---|---|---|
| `pull.applied`·`pull.removed` | 둘 다 빈 배열 | 「원격 변경 없음」 한 줄 |
| `pull.applied` | 비어 있지 않음 | 「적용」 아래에 `logicalKey` 목록 |
| `pull.removed` | 비어 있지 않음 | 「로컬 삭제(원격 삭제 반영)」 아래에 `logicalKey` 목록 |
| `pull.conflicts` | 비어 있지 않음 | 「정책으로 해소한 충돌」 아래에 `logicalKey`·`remoteMachineId`. 정책 이름을 함께 적는다 — 인자의 `--policy` 값, 인자에 없으면 「설정 기본 정책」 |
| `pull.backupDir` | `null` 이 아님 | 「백업」 과 그 경로. 덮어쓴 로컬 파일을 되살릴 위치라 생략하지 않는다 |
| `push.pushed`·`push.deleted` | 둘 다 빈 배열 | 「올릴 변경 없음」 한 줄 |
| `push.pushed` | 비어 있지 않음 | 「업로드」 아래에 `logicalKey` 목록 |
| `push.deleted` | 비어 있지 않음 | 「원격 삭제(tombstone)」 아래에 `logicalKey` 목록 |
| `push.skipped` | 항상 | 「변경 없어 건너뜀 <수>」 |
| `push.conflicts` | 비어 있지 않음 | 「push 보류」 아래에 `logicalKey`·`remoteMachineId`. push 시점에 새로 감지된 충돌이라 이 키들은 올라가지 않았다. sync 재실행을 안내한다 |

- 조건이 맞지 않는 행은 적지 않는다.
  빈 배열을 「없음」으로 따로 보고하지 않는다.
  예외는 「원격 변경 없음」·「올릴 변경 없음」 두 줄뿐이다.
- `logicalKey` 는 받은 그대로 적는다.
  절대경로로 바꾸지 않는다.
- 한 목록이 20개 이하면 전부 적는다.
- 한 목록이 20개를 넘으면 총 개수와 상위 디렉터리별 개수만 적는다.
  전체 목록은 결과 JSON 에 있다고 적는다.

## 충돌 차단 및 해소 안내

충돌이 자동으로 해소되지 않으면 `sync` 는 push 를 전면 차단한다.
- 이 경우는 `preserve-both`·`manual` 정책, 또는 `merge` 정책에서 폴백된 키가 남은 경우다.
- `sync` 는 충돌별 상세와 해소 안내를 반환한다.
- 종료 코드는 1 이다.

`/wormhole-resolve` 로 키별로 theirs(`--policy latest-wins`), `ours`(`--policy ours`), `merge`(`--policy merge`, `settings.json` 3-way 자동 머지) 중 하나를 선택한다.
그 뒤 sync 를 다시 실행한다.
`--policy latest-wins` sync 는 충돌을 자동으로 해소하므로 push 를 차단하지 않는다.
`--policy merge` sync 는 폴백 없이 전부 머지하면 push 를 차단하지 않는다.
폴백된 키가 남으면 그 키가 잔존 충돌로 push 를 차단한다.

### resolve 실행 여부 확인 (필수)

- 결과 JSON 이 `aborted: true` + `reason: "conflicts"` 면 그 자리에서 재시도하지 않는다.
  먼저 `conflicts` 배열의 `logicalKey`·`remoteMachineId`·`copyPath` 를 요약해 보여준다.
- 요약에 양쪽 변경 내용을 함께 싣는다.
  `conflicts[]` 의 `remoteChangeDiff` 와 `localChangeDiff` 를 쓴다.
  - `remoteChangeDiff` 는 원격이 무엇을 바꿨는지 담는다.
    그 머신이 push 할 때 저장한 값이다.
  - `localChangeDiff` 는 이 머신이 base 대비 무엇을 바꿨는지 담는다.
    보고 시점에 계산한 값이다.
  - 각 diff 는 `added`·`removed` 줄수와 `text`(unified diff 본문)를 담는다.
    요약에는 줄수와 핵심 변경 줄만 낸다.
    전문은 `diffPath` 파일을 가리킨다.
  - `remoteChangeDiff` 가 `null` 이면 원격 엔트리가 없거나 구버전 wormhole 이 쓴 항목이다.
    이때는 변경 없음이 아니라 정보 없음으로 보고한다.
  - `format` 이 `binary`·`deleted` 이거나 `pruned: true` 면 본문이 비어 있다.
    각각 바이너리·삭제·원격 예산 초과로 구분해 적는다.
    `truncated: true` 는 본문이 앞부분만 남은 것이다.
- 요약 직후 `AskUserQuestion` 으로 `/wormhole-resolve` 실행 여부를 묻는다.
  묻지 않고 자동 실행하지 않는다.
  선택지 3개를 제시한다.
  이 질문에서 파일 단위 정책을 확정하지 않는다.
  정책은 아래 항목별 확인 결과가 정한다.
  - 항목별로 확인하며 해소 (Recommended) — `/wormhole-resolve` 를 `--policy` 없이 실행한다.
    그 문서의 「충돌 항목별 확인 (필수)」 절차가 비교 표를 먼저 낸다.
    그 뒤 그 절차가 갈린 항목마다 `base`·로컬·원격·직접 입력 중에서 묻는다.
  - 정책 하나로 일괄 해소 — 사용자가 표 없이 빠른 처리를 원할 때만 고른다.
    사용자가 이 선택지를 고르면 `merge` / `latest-wins` / `ours` 중 하나를 다시 묻는다.
    그 뒤 `/wormhole-resolve --policy <선택값>` 을 실행한다.
    충돌 키가 전부 `settings.json` 이면 `merge` 를 권장값으로 둔다.
  - 실행하지 않음 — 사용자가 충돌 sidecar 를 직접 확인한다.
- 해소가 끝나 남은 항목이 없을 때만 sync 를 1회 재실행한다.
  일부 키만 해소하려면 `--policy manual --keys k1,k2` 를 쓴다.
- 재실행에서도 `aborted: true` 면 잔존 충돌을 보고하고 멈춘다.
  같은 질문을 반복하거나 다른 정책으로 자동 전환하지 않는다.
- 실행하지 않음을 고르면 어떤 명령도 실행하지 않고 충돌 목록과 sidecar 경로만 남긴 채 끝낸다.
- 해소 후 남는 충돌 sidecar 는 wormhole 관리 대상이 아니라 push 에 섞이지 않는다.
  sidecar 경로를 보고한다.
  삭제 여부는 사용자가 정한다.
  같은 위치의 `<파일>.wormhole-conflict-<machineId>-<generation>.diff`(양쪽 변경 내용 기록, `conflicts[].diffPath`)도 같은 대상이므로 함께 보고한다.
- `reason: "missing-plugins"` 차단은 이 질문 대상이 아니다.
  이때는 `missing` 목록을 보고하고 `installCommands` 를 배열 순서 그대로 사용자에게 보여 준다.
  - 각 항목은 사용자가 Claude Code 입력창에 직접 입력하는 슬래시 명령이다.
    Bash 로 실행하지 않는다.
  - `/plugin marketplace add` 항목이 `/plugin install` 항목보다 앞에 있다.
    순서를 바꾸지 않는다.
  - `unresolvedMarketplaces` 는 소스를 알 수 없는 마켓플레이스다.
    `installCommands` 에 그 마켓플레이스의 명령은 없다.
    별도 줄로 보고하고, 그 마켓플레이스를 등록한 머신에서 소스를 확인해 직접 등록하도록 안내한다.
  - 명령을 입력한 뒤 sync 를 다시 실행하도록 안내한다.

## Force 모드 (파괴적 — 주의)

### `--force-up` (원격 초기화 후 로컬 전체 업로드)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync --force-up
```

- 경고 — 다른 머신이 push 한 원격 데이터가 모두 사라진다.
  이 머신 로컬 상태만 남는다.
- 이 모드의 `sync` 는 원격의 manifest 와 모든 blob 을 삭제한 뒤 로컬 파일 전체를 새로 업로드한다.
- 이 모드의 `sync` 는 `keyparams.json` (암호화 키) 을 절대 삭제하지 않는다.
  `keyparams.json` 을 삭제하면 vault 를 복호화할 수 없다.
- `--dry-run` 을 붙이면 이 모드의 `sync` 는 와이프 없이 업로드 예정 목록만 반환한다.

### `--force-down` (로컬을 원격으로 무조건 덮어쓰기 + 미러삭제)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync --force-down
```

- 경고 — 로컬 전용 변경이 모두 사라진다.
- 이 모드의 `sync` 는 원격 manifest 의 모든 항목을 로컬에 적용한다.
  - 이 모드의 `sync` 는 `.claude.json`(로그인 identity: oauthAccount·userID 등)과 `settings.json`(localOnlyKeys 머신고유 설정: permissions·mcp 머신경로 등)을 raw 덮어쓰기에서 제외한다.
    이 모드의 `sync` 는 이 두 파일의 로컬 전용 키를 보존해 머지한다.
  - 이 모드의 `sync` 는 그 외 파일을 원격 raw 로 덮어쓴다.
- 이 모드의 `sync` 는 원격에 없는 로컬 관리 파일을 삭제한다 (미러 삭제).
- 이 모드의 `sync` 는 덮어쓰기/삭제 전에 자동 백업을 생성한다.
- `--dry-run` 을 붙이면 이 모드의 `sync` 는 변경 없이 적용 예정 목록만 반환한다.

`--force-up` 과 `--force-down` 은 동시에 쓸 수 없다.
두 플래그는 `--policy` 와 함께 쓸 수 없다.
