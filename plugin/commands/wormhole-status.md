---
description: wormhole — 원격 WebDAV 와 로컬 설정 동기화 상태 확인
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs status
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.
- 로컬/원격 매니페스트 파일 수, 마지막 동기화 시각, 충돌 항목 목록을 표시한다.
- 충돌이 있으면 `/wormhole-resolve` 실행을 안내한다.
