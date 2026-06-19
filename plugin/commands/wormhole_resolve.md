---
description: wormhole — 충돌 항목을 지정한 정책으로 해소
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs resolve $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 해소된 항목과 남은 항목을 표시한다.

인수 옵션:
- `--policy preserve-both` — 양쪽 버전 모두 보존 (기본값)
- `--policy latest-wins` — 최신 타임스탬프 버전 채택
- `--policy manual` — 직접 지정 (`--keys k1,k2` 와 함께 사용)
- `--dry-run` — 실제 변경 없이 미리보기
