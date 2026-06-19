---
description: wormhole — push 또는 pull 을 실제 변경 없이 미리보기
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs dry-run $ARGUMENTS
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 실제 파일 변경은 발생하지 않으며, 어떤 파일이 영향받는지 미리 보여준다.

인수: `push` 또는 `pull` 을 전달한다.
- 인수 없이 실행하면 기본값 `push` 로 동작한다.
- 예: `/wormhole_dry_run pull`
