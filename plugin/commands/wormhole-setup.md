---
description: wormhole 초기 설정 — ~/.wormhole/.env 및 config.json 템플릿 생성
---

`~/.wormhole/.env` 와 `~/.wormhole/config.json` 이 없으면 각각 템플릿을 생성한다. 이미 존재하면 덮어쓰지 않는다 (idempotent).

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs
```

실행 후 아래 두 파일을 설정한다.

**`~/.wormhole/.env`** — WebDAV 연결 정보 및 패스프레이즈 (필수)

- `WEBDAV_URL` — WebDAV 서버 URL
- `WEBDAV_USER` — WebDAV 계정 이름
- `WEBDAV_PASS` — WebDAV 비밀번호 (앱 비밀번호 권장)
- `WEBDAV_BASEDIR` — 원격 저장 경로 (기본 `/wormhole`)
- 패스프레이즈: `WORMHOLE_PASSPHRASE` (직접 입력) 또는 `WORMHOLE_PASSPHRASE_FILE` (파일 경로) 중 하나 선택

**`~/.wormhole/config.json`** — 동기화 범위 및 동작 설정 (선택적으로 편집)

- `targets.include` / `targets.exclude` — 동기화할 glob 패턴 목록. 기본값은 `.claude/` 하위 주요 파일을 포함한다.
- `settingsLocalKeys` — 머신별로 유지할 settings.json 키 경로 목록 (동기화에서 제외).
- `conflictPolicy` — 충돌 시 처리 방식 (`preserve-both` / `latest-wins` / `manual`).
- `crypto`, `lock` 등 고급 설정은 파일 내 값을 직접 수정한다.

두 파일 설정 완료 후 `/wormhole_sync`, `/wormhole_push`, `/wormhole_pull` 등 슬래시 커맨드를 바로 사용할 수 있다. 서버 재시작 불필요.
