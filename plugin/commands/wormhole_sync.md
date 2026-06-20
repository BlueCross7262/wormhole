---
description: wormhole — pull → resolve → push 일괄 동기화
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs sync $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- pull → (충돌 시 resolve) → push 순서로 실행한다.
- 기본 정책은 `preserve-both` (비파괴적, 양쪽 버전 보존).
- 덮어쓰기 원하면 `--policy latest-wins` (원격 최신본 = 마지막 push 채택, 파일 mtime 아님) 를 전달한다 (`$ARGUMENTS` 에 포함).
- `manual` 정책은 sync 에서 사용 불가 — 충돌 수동 해소는 `/wormhole_resolve` 를 실행한다.
- pull 또는 resolve 단계에서 오류 발생 시 push 없이 중단된다.
