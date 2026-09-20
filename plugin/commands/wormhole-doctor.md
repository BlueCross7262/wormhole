---
description: wormhole 상태 진단
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs doctor
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.

각 체크 항목을 ✓ / ✗ / ⚠ 기호로 표시한다.
실패·경고 항목은 detail 메시지와 함께 조치 방법을 안내한다.

## 체크 항목

### 체크 1 — config 파일

- `doctor` 는 `~/.wormhole/.env` 존재, 필수 키 로드, `config.json` 유효성을 검증한다.
- 필수 키는 `WEBDAV_URL`·`WEBDAV_USER`·`WEBDAV_PASS` 다.

### 체크 2 — WebDAV 연결·인증

- `doctor` 는 원격 서버에 보낸 PROPFIND 요청이 성공하는지 확인한다.
- `doctor` 는 실패 원인을 401 인증 실패와 네트워크 오류로 구분한다.

### 체크 3 — passphrase 소스

- `doctor` 는 passphrase 를 env 변수·파일·keychain 중 어느 소스에서 로드했는지 표시한다.

### 체크 4 — passphrase↔vault 정합

- `doctor` 는 원격 `keyparams` sentinel 을 복호화해 passphrase 가 일치하는지 검증한다.

### 체크 5 — vault 상태

- `doctor` 는 `keyparams` 와 manifest 가 있는지 확인한다.
- `doctor` 는 `manifestGeneration` 과 항목 수를 표시한다.

### 체크 6 — transport 보안

- `doctor` 는 평문 http 를 쓰면 자격증명 노출을 경고한다.
- `doctor` 는 localhost 를 이 경고에서 제외한다.

### 체크 7 — CAS/ETag 능력

- `doctor` 는 원격 `keyparams` 의 ETag 강도로 조건부 PUT(CAS)의 신뢰성을 휴리스틱으로 점검한다.
- ETag 가 weak 이거나 없으면 `doctor` 는 경고한다.

### 체크 8 — 원격 락 상태

- `doctor` 는 `lock.json` 의 보유자·만료·손상을 진단한다.
- 다른 머신이 유효한 락을 가지고 있으면 `doctor` 는 경고한다.

### 체크 9 — machine-id

- `doctor` 는 로컬 머신 식별자가 있는지 확인한다.

실패 항목이 하나라도 있으면 종료 코드가 0이 아니다.
