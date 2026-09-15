---
description: wormhole 동기화 실행 (pull→push)
argument-hint: "[--policy latest-wins | merge] [--force-up | --force-down] [--dry-run]"
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- pull → (충돌 시 resolve) → push 순서로 실행한다. 내부적으로 `syncAtomic` 을 거친다.
- 기본 정책은 `preserve-both` (비파괴적, 양쪽 버전 보존).
- 덮어쓰기 원하면 `--policy latest-wins` (원격 최신본 = 마지막 push 채택, 파일 mtime 아님) 를 전달한다 (`$ARGUMENTS` 에 포함).
- 자동 해소를 원하되 비파괴적으로 하려면 `--policy merge` 를 전달한다. settings.json 만 키 단위 3-way 자동 머지하고, 그 외 파일·leaf 충돌·삭제 충돌은 preserve-both 로 폴백한다.
- `manual` 정책은 sync 에서 사용 불가 — 충돌 수동 해소는 `/wormhole-resolve` 를 실행한다.
- pull 또는 resolve 단계에서 오류 발생 시 push 없이 중단된다.
- `syncAtomic` 이 설치 전제조건(미설치 플러그인·마켓플레이스 참조)과 잔존 충돌을 하드배리어로 검사한다. 하나라도 걸리면 push 를 막고 종료코드 1 로 종료한다.

## 충돌 차단 및 해소 안내

충돌이 자동 해소되지 않으면(`preserve-both`·`manual` 정책, 또는 `merge` 정책에서 폴백된 키가 남은 경우) push 가 전면 차단되고, 충돌별 상세와 함께 해소 안내가 반환되며 종료코드도 1 이다.
`/wormhole-resolve` 로 키별 theirs(`--policy latest-wins`), ours(`--policy ours`), 또는 merge(`--policy merge`, settings.json 3-way 자동 머지) 를 선택한 뒤 재 sync 한다.
`--policy latest-wins` sync 는 충돌을 자동 해소하므로 차단되지 않는다. `--policy merge` sync 는 폴백 없이 전부 머지되면 차단되지 않고, 폴백된 키가 남으면 그 키가 잔존 충돌로 push 를 막는다.

### resolve 실행 여부 확인 (필수)

- 결과 JSON 이 `aborted: true` + `reason: "conflicts"` 면 그 자리에서 재시도하지 않는다. 먼저 `conflicts` 배열의 `logicalKey`·`remoteMachineId`·`copyPath` 를 요약해 보여준다.
- 요약에 양쪽 변경 내용을 함께 싣는다. `conflicts[]` 의 `remoteChangeDiff`(원격이 무엇을 바꿨나, 그 머신이 push 할 때 저장한 값)와 `localChangeDiff`(이 머신이 base 대비 무엇을 바꿨나, 보고 시점 계산값)를 쓴다.
  - 각 diff 는 `added`·`removed` 줄수와 `text`(unified diff 본문)를 담는다. 요약에는 줄수와 핵심 변경 줄만 내고 전문은 `diffPath` 파일을 가리킨다.
  - `remoteChangeDiff` 가 `null` 이면 원격 엔트리가 없거나 구버전 wormhole 이 쓴 항목이다 — 변경 없음이 아니라 정보 없음으로 보고한다.
  - `format` 이 `binary`·`deleted` 이거나 `pruned: true` 면 본문이 비어 있다. 각각 바이너리·삭제·원격 예산 초과로 구분해 적는다. `truncated: true` 는 본문이 앞부분만 남은 것이다.
- 요약 직후 `AskUserQuestion` 으로 `/wormhole-resolve` 실행 여부를 묻는다. 묻지 않고 자동 실행하지 않는다. 선택지 3개를 제시한다. 이 질문에서 파일 단위 정책을 확정하지 않는다 — 정책 선택은 아래 항목별 확인 결과가 정한다.
  - 항목별로 확인하며 해소 (Recommended) — `/wormhole-resolve` 를 `--policy` 없이 실행한다. 그 문서의 「충돌 항목별 확인 (필수)」 절차가 비교 표를 먼저 내고 갈린 항목마다 `base`·로컬·원격·직접 입력 중에서 묻는다
  - 정책 하나로 일괄 해소 — 사용자가 표 없이 빠른 처리를 원할 때만 고른다. 이 선택지를 고르면 그때 `merge` / `latest-wins` / `ours` 중 하나를 다시 묻고 `/wormhole-resolve --policy <선택값>` 을 실행한다. 충돌 키가 전부 `settings.json` 이면 `merge` 를 권장값으로 둔다
  - 실행하지 않음 — 충돌 sidecar 를 사용자가 직접 확인
- 해소가 끝나 남은 항목이 없을 때만 sync 를 1회 재실행한다. 일부 키만 해소하려면 `--policy manual --keys k1,k2` 를 쓴다.
- 재실행에서도 `aborted: true` 면 잔존 충돌을 보고하고 멈춘다. 같은 질문을 반복하거나 다른 정책으로 자동 전환하지 않는다.
- 실행하지 않음을 고르면 어떤 명령도 실행하지 않고 충돌 목록과 sidecar 경로만 남긴 채 끝낸다.
- 해소 후 남는 충돌 sidecar 는 wormhole 관리 대상이 아니라 push 에 섞이지 않는다. 경로를 보고하고 삭제 여부는 사용자가 정한다. 같은 위치의 `<파일>.conflict-<machineId>-<generation>.diff`(양쪽 변경 내용 기록, `conflicts[].diffPath`)도 같은 대상이므로 함께 보고한다.
- `reason: "missing-plugins"` 차단은 이 질문 대상이 아니다 — `missing` 목록을 보고하고 플러그인 설치를 안내한다.

## Force 모드 (파괴적 — 주의)

### `--force-up` (원격 초기화 후 로컬 전체 업로드)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync --force-up
```

- 원격의 manifest 와 모든 blob 을 삭제한 뒤 로컬 파일 전체를 새로 업로드한다.
- **경고**: 다른 머신이 push 한 원격 데이터가 모두 사라진다. 이 머신 로컬 상태만 남는다.
- `keyparams.json` (암호화 키) 은 절대 삭제되지 않는다 — 삭제 시 vault 복호 불능.
- `--dry-run` 을 붙이면 와이프 없이 업로드 예정 목록만 반환한다.

### `--force-down` (로컬을 원격으로 무조건 덮어쓰기 + 미러삭제)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync --force-down
```

- 원격 manifest 의 모든 항목을 로컬에 적용한다. 단, `.claude.json`(로그인 identity: oauthAccount·userID 등)·`settings.json`(localOnlyKeys 머신고유 설정: permissions·mcp 머신경로 등)은 raw 덮어쓰기에서 제외하고 로컬 전용 키를 보존 머지한다. 그 외 파일은 원격 raw 로 덮어쓴다.
- 원격에 없는 로컬 관리 파일은 삭제된다 (미러 삭제).
- **경고**: 로컬 전용 변경이 모두 사라진다. 덮어쓰기/삭제 전 자동 백업을 생성한다.
- `--dry-run` 을 붙이면 변경 없이 적용 예정 목록만 반환한다.

`--force-up` 과 `--force-down` 은 동시에 사용할 수 없으며 `--policy` 와 함께 쓸 수 없다.
