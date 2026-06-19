---
description: wormhole 초기 설정 — ~/.wormhole/.env 템플릿 생성
---

`~/.wormhole/.env` 가 없으면 템플릿을 생성한다. 이미 존재하면 덮어쓰지 않는다.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs
```

실행 후 `~/.wormhole/.env` 를 열어 다음 항목을 실제 값으로 채운다.

- `WEBDAV_URL` — WebDAV 서버 URL
- `WEBDAV_USER` — WebDAV 계정 이름
- `WEBDAV_PASS` — WebDAV 비밀번호 (앱 비밀번호 권장)
- `WEBDAV_BASEDIR` — 원격 저장 경로 (기본 `/wormhole`)
- 패스프레이즈: `WORMHOLE_PASSPHRASE` (직접 입력) 또는 `WORMHOLE_PASSPHRASE_FILE` (파일 경로) 중 하나 선택

입력 완료 후 `/wormhole_sync`, `/wormhole_push`, `/wormhole_pull` 등 슬래시 커맨드를 바로 사용할 수 있다. 서버 재시작 불필요.
