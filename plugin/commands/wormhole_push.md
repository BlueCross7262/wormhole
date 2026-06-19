---
description: wormhole — 로컬 설정을 원격 WebDAV 에 업로드
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs push $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 업로드된 파일 목록과 건너뛴 파일을 표시한다.
- `--dry-run` 을 붙이면 실제 업로드 없이 미리보기만 한다 (`$ARGUMENTS` 에 전달 가능).
