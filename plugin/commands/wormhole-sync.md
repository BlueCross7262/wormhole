---
description: wormhole 동기화 실행 (pull→push)
argument-hint: "[--policy latest-wins] [--force-up | --force-down] [--dry-run]"
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- pull → (충돌 시 resolve) → push 순서로 실행한다.
- 기본 정책은 `preserve-both` (비파괴적, 양쪽 버전 보존).
- 덮어쓰기 원하면 `--policy latest-wins` (원격 최신본 = 마지막 push 채택, 파일 mtime 아님) 를 전달한다 (`$ARGUMENTS` 에 포함).
- `manual` 정책은 sync 에서 사용 불가 — 충돌 수동 해소는 `/wormhole-resolve` 를 실행한다.
- pull 또는 resolve 단계에서 오류 발생 시 push 없이 중단된다.

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

- 원격 manifest 의 모든 항목을 로컬에 raw 덮어쓰기한다 (settings/.mcp.json 도 3-way 머지 없이 원격 그대로).
- 원격에 없는 로컬 관리 파일은 삭제된다 (미러 삭제).
- **경고**: 로컬 전용 변경이 모두 사라진다. 덮어쓰기/삭제 전 자동 백업을 생성한다.
- `--dry-run` 을 붙이면 변경 없이 적용 예정 목록만 반환한다.

`--force-up` 과 `--force-down` 은 동시에 사용할 수 없으며 `--policy` 와 함께 쓸 수 없다.
