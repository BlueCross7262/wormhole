---
description: wormhole 충돌 해소
argument-hint: "[--policy preserve-both | latest-wins | ours | manual | merge] [--keys k1,k2] [--dry-run]"
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs resolve $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 해소된 항목과 남은 항목을 표시한다.

## 충돌 항목별 확인 (필수)

인수에 `--policy` 가 있으면 이 절차를 건너뛰고 그 정책으로 바로 실행한다. `--policy` 없이 호출됐으면 아래 순서를 지킨다. 파일 단위 정책 하나를 먼저 묻지 않는다 — 한 파일 안에서 머신마다 반대 방향으로 바뀐 키들이 통째로 한쪽으로 넘어가기 때문이다.

### 값 수집

- 로컬 값 — 로컬 파일을 그대로 읽는다.
- 원격 값 — 충돌 sidecar (`<파일>.conflict-<machineId>-<generation>`) 를 읽는다.
- `base` 값 — `<stateDir>/base/<sha256(logicalKey)>` 를 읽는다. `stateDir` 은 wormhole 설정값이고 파일명은 논리키 문자열의 sha256 hex 다. 파일이 없으면 `base` 는 빈 객체로 본다.
- `merge` 예측이 필요하면 `--policy merge --dry-run` 으로 `mergeable` 과 `conflictKeys` 를 먼저 확인한다.
- 변경 내용 — `--dry-run` 결과 `preview[]` 의 `remoteChangeDiff`(원격이 base 대비 무엇을 바꿨나)와 `localChangeDiff`(로컬이 base 대비 무엇을 바꿨나)를 읽는다. 이전 sync 가 남긴 `<파일>.conflict-<machineId>-<generation>.diff` 에도 같은 내용이 사람 읽는 형태로 기록돼 있다.
  - 어느 쪽이 `null` 이면 그 쪽 변경 내용을 구할 수 없다는 뜻이다. 변경 없음으로 읽지 않는다.
  - `format` 이 `binary`·`deleted` 이거나 `pruned: true` 면 본문이 없다. 이때는 아래 값 수집 결과로만 비교한다.

### 비교 표

- 질문보다 먼저 표를 출력한다. 행은 실제로 값이 갈린 leaf 경로, 열은 `base` · 로컬 · 원격이다.
- 표기 차이는 실제 차이가 아니므로 제외한다 — `${HOME}` 토큰화 차이, 객체 키 순서 차이, 배열 내 동일 원소의 순서 차이. 제외한 항목은 「차이 아님」 표로 따로 묶어 보여준다.
- 값이 비밀일 수 있는 경로 (`env` 하위, 이름에 `token`·`secret`·`key`·`passphrase` 포함) 는 원문 대신 길이만 표시한다.
- 값이 긴 객체·배열은 갈린 하위 leaf 까지 펼쳐 적는다. 최상위 키 이름만 적지 않는다.

### 항목별 질문

- 표 직후 갈린 항목마다 `AskUserQuestion` 을 하나씩 호출한다. 항목 여러 개를 한 질문에 묶지 않는다.
- 선택지는 네 개다 — `base` 값, 로컬 값, 원격 값, 직접 입력. 각 라벨에 실제 값을 함께 적어 사용자가 표를 다시 찾아보지 않게 한다.
- 권장값을 첫번째에 두고 라벨 끝에 `(Recommended)` 를 붙인다. description 에 권장 근거를 한 줄 적는다.
- 권장값 판정 기준 — `base` 대비 한쪽만 바뀐 항목은 그 바뀐 쪽을 권장한다 (다른 쪽은 그 변경을 아직 못 본 것이므로 채택해도 손실이 없다). 양쪽 다 바뀐 항목은 어느 쪽을 버리게 되는지 명시하고 하나를 골라 권장한다.
- 항목 수가 많아 질문이 과하면 표를 보여준 뒤 일괄 선택 여부를 먼저 묻고, 사용자가 일괄을 고르면 그때 정책 하나로 진행한다.

### 실행 경로 결정

- 선택 조합이 전부 로컬이면 `--policy ours` 로 실행한다.
- 선택 조합이 전부 원격이면 `--policy latest-wins` 로 실행한다.
- 조합이 섞였거나 직접 입력이 있으면, 다수를 차지하는 쪽 정책으로 실행한 뒤 나머지 키만 파일에서 직접 편집한다. 편집 대상이 소수면 `ours` 후 직접 편집이 `merge` 후 되돌리기보다 단순하다.
- 실행 후 선택한 값이 파일에 실제로 반영됐는지 키별로 재확인하고 결과를 보고한다.
- 로컬본을 채택하는 선택은 다음 push 에서 원격을 덮는다. 다른 머신이 그 pull 로 잃게 되는 항목을 결과 보고에 한 줄로 명시한다.

인수 옵션:
- `--policy preserve-both` — 양쪽 버전 모두 보존 (기본값)
- `--policy latest-wins` — 원격 최신본(매니페스트 generation 우선) 채택. "최신" 은 마지막으로 push 된 쪽(generation 이 높은 쪽)을 뜻하며 파일 mtime/벽시계 시각이 아니다. 덮어쓰기 전 로컬 변경분은 백업된다. (theirs 채택)
- `--policy ours` — 로컬 콘텐츠를 채택한다. base 스냅샷을 원격 상태로 갱신해 다음 push 에서 로컬본이 업로드된다 — resolve 자체가 원격에 업로드하지는 않는다. 로컬 수정 보존이 목적. 수동 병합 후 ours 로 병합본 채택도 가능하다. latest-wins 가 theirs(원격) 채택이라면 ours 는 로컬 채택
- `--policy manual` — 직접 지정 (`--keys k1,k2` 와 함께 사용)
- `--policy merge` — settings.json 만 키 단위 3-way 자동 머지(base/로컬/원격)한다. leaf 충돌이 하나라도 있으면 그 파일은 머지하지 않고 preserve-both 로 폴백한다
  - settings.json 이 아닌 파일, 삭제 충돌도 preserve-both 로 폴백한다
  - 폴백 사유 9종 — `not-settings`, `deleted`, `leaf-conflict`, `blob-missing`, `local-missing`, `local-unparseable`, `remote-unparseable`, `install-prereq`, `adopt-failed`
  - 결과의 `mergeFallbacks` 배열에서 키별 폴백 사유를 확인한다
- `--dry-run` — 실제 변경 없이 미리보기. 결과의 `preview` 배열에 키별 판단 근거(삭제충돌 여부, 예정 sidecar 경로, 로컬·원격 해시, 양쪽 변경 내용 `remoteChangeDiff`·`localChangeDiff`, `merge` 정책이면 머지 가능 여부와 충돌 키 목록)가 담긴다
  - preview 는 예측값이다. 다운로드 시점과 실제 실행 시점 사이 원격이 바뀌면 결과가 달라질 수 있다

충돌 sidecar (`<파일>.conflict-<machineId>-<generation>`, 삭제 충돌은 `.conflict-deleted-` 접두)에 기록되는 settings.json 의 원격 내용은 raw 파일이 아니라 정규화(키 정렬 + `${HOME}` 토큰화)를 거친 원문이다. 로컬 settings.json 과 1:1 비교하면 키 순서와 홈 경로 표기가 달라 보이는 게 정상이다.

같은 위치의 `<파일>.conflict-<machineId>-<generation>.diff` 는 sync 가 충돌을 보고할 때 남기는 양쪽 변경 내용 기록이다. 원격 diff 는 그 머신이 push 할 때 매니페스트에 저장한 값이고, 로컬 diff 는 보고 시점에 base 스냅샷과 대조해 계산한 값이다. 두 sidecar 모두 wormhole 동기화 범위 밖이라 push 에 섞이지 않는다.
