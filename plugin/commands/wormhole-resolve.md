---
description: wormhole 충돌 해소
argument-hint: "[--policy preserve-both | latest-wins | ours | manual | merge] [--keys k1,k2] [--dry-run]"
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs resolve $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 해소된 항목과 남은 항목을 표시한다.

인수 옵션:
- `--policy preserve-both` — 양쪽 버전 모두 보존 (기본값)
- `--policy latest-wins` — 원격 최신본(매니페스트 generation 우선) 채택. "최신" 은 마지막으로 push 된 쪽(generation 이 높은 쪽)을 뜻하며 파일 mtime/벽시계 시각이 아니다. 덮어쓰기 전 로컬 변경분은 백업된다. (theirs 채택)
- `--policy ours` — 로컬 콘텐츠를 채택한다. base 스냅샷을 원격 상태로 갱신해 다음 push 에서 로컬본이 업로드된다 — resolve 자체가 원격에 업로드하지는 않는다. 로컬 수정 보존이 목적. 수동 병합 후 ours 로 병합본 채택도 가능하다. latest-wins 가 theirs(원격) 채택이라면 ours 는 로컬 채택
- `--policy manual` — 직접 지정 (`--keys k1,k2` 와 함께 사용)
- `--policy merge` — settings.json 만 키 단위 3-way 자동 머지(base/로컬/원격)한다. leaf 충돌이 하나라도 있으면 그 파일은 머지하지 않고 preserve-both 로 폴백한다
  - settings.json 이 아닌 파일, 삭제 충돌도 preserve-both 로 폴백한다
  - 폴백 사유 9종 — `not-settings`, `deleted`, `leaf-conflict`, `blob-missing`, `local-missing`, `local-unparseable`, `remote-unparseable`, `install-prereq`, `adopt-failed`
  - 결과의 `mergeFallbacks` 배열에서 키별 폴백 사유를 확인한다
- `--dry-run` — 실제 변경 없이 미리보기. 결과의 `preview` 배열에 키별 판단 근거(삭제충돌 여부, 예정 sidecar 경로, 로컬·원격 해시, `merge` 정책이면 머지 가능 여부와 충돌 키 목록)가 담긴다
  - preview 는 예측값이다. 다운로드 시점과 실제 실행 시점 사이 원격이 바뀌면 결과가 달라질 수 있다

충돌 sidecar (`<파일>.conflict-<machineId>-<generation>`, 삭제 충돌은 `.conflict-deleted-` 접두)에 기록되는 settings.json 의 원격 내용은 raw 파일이 아니라 정규화(키 정렬 + `${HOME}` 토큰화)를 거친 원문이다. 로컬 settings.json 과 1:1 비교하면 키 순서와 홈 경로 표기가 달라 보이는 게 정상이다.
