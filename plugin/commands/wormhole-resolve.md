---
description: wormhole 충돌 해소
argument-hint: [--policy preserve-both | latest-wins | manual] [--keys k1,k2] [--dry-run]
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs resolve $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 해소된 항목과 남은 항목을 표시한다.

인수 옵션:
- `--policy preserve-both` — 양쪽 버전 모두 보존 (기본값)
- `--policy latest-wins` — 원격 최신본(매니페스트 generation 우선) 채택. "최신" 은 **마지막으로 push 된** 쪽(generation 이 높은 쪽)을 뜻하며 파일 mtime/벽시계 시각이 아니다. 덮어쓰기 전 로컬 변경분은 백업된다
- `--policy manual` — 직접 지정 (`--keys k1,k2` 와 함께 사용)
- `--dry-run` — 실제 변경 없이 미리보기
