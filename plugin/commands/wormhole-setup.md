---
description: wormhole 초기 설정 (env·config 생성)
argument-hint: "[--reset-config]"
---

`setup` 은 `~/.wormhole/.env` 와 `~/.claude/wormhole-config.json` 이 없으면 각각 템플릿을 생성한다.
두 파일이 이미 있으면 `setup` 은 그 파일을 덮어쓰지 않는다 (idempotent).

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs
```

실행 후 아래 두 파일을 설정한다.

`~/.wormhole/.env` — WebDAV 연결 정보와 passphrase (필수)

- `WEBDAV_URL` — WebDAV 서버 URL
- `WEBDAV_USER` — WebDAV 계정 이름
- `WEBDAV_PASS` — WebDAV 비밀번호 (앱 비밀번호 권장)
- wormhole 은 원격 기본 디렉터리를 `WEBDAV_USER` 값에서 자동으로 정한다 (URL 아래 `/<WEBDAV_USER>`).
  이 값을 바꾸려면 `config.json` 의 `remote.remoteBaseDir` 를 직접 편집한다.
- passphrase — `WORMHOLE_PASSPHRASE` (직접 입력)와 `WORMHOLE_PASSPHRASE_FILE` (파일 경로) 중 하나를 고른다.

`~/.claude/wormhole-config.json` — 동기화 범위와 동작 설정 (선택적으로 편집)

- `targets.include` / `targets.exclude` — 동기화할 glob 패턴 목록이다.
  기본값은 `.claude/` 하위 주요 파일을 포함한다.
- wormhole 은 `settings.json` 을 별도 키 필터 없이 통째로 동기화한다 (프로토타입 오염 방지용 `__proto__` 류만 제외).
- `conflictPolicy` — 충돌 시 처리 방식 (`preserve-both` / `latest-wins` / `ours` / `manual` / `merge`).
- `crypto`, `lock` 등 고급 설정은 파일 내 값을 직접 수정한다.

두 파일 설정을 마치면 `/wormhole-status`, `/wormhole-resolve`, `/wormhole-sync`, `/wormhole-doctor` 슬래시 커맨드를 바로 쓸 수 있다.
서버 재시작은 필요 없다.

## `--reset-config` — config.json 기본값 강제 복원

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs --reset-config
```

`--reset-config` 를 붙인 `setup` 은 `config.json` 을 기본값으로 강제로 덮어쓴다 (기존 내용 폐기).
`--reset-config` 를 붙인 `setup` 도 `.env` (WebDAV 비밀번호·passphrase) 는 절대 건드리지 않는다.

일반 setup (플래그 없음) 은 두 파일 모두 idempotent 로 동작한다.
파일이 이미 있으면 일반 setup 은 그 파일을 생성하지 않는다.
