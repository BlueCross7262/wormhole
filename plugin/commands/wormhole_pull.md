---
description: wormhole — 원격 WebDAV 설정을 로컬로 다운로드
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs pull $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 다운로드된 파일 목록, 충돌 항목, 건너뛴 파일을 표시한다.
- 충돌이 감지되면 `/wormhole_resolve` 실행을 안내한다.
- `--dry-run` 을 붙이면 실제 변경 없이 미리보기만 한다 (`$ARGUMENTS` 에 전달 가능).
