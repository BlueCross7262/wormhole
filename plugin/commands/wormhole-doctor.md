---
description: wormhole 상태 진단
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs doctor
```

JSON 결과를 읽고 사용자에게 한국어로 요약한다.

각 체크 항목을 ✓ / ✗ / ⚠ 기호로 표시하고, 실패·경고 항목은 detail 메시지와 함께 조치 방법을 안내한다.

체크 항목:
1. **config 파일** — `~/.wormhole/.env` 존재, 필수 키(WEBDAV_URL/USER/PASS) 로드, `config.json` 유효성 검증
2. **WebDAV 연결·인증** — 원격 서버 PROPFIND 성공(401 인증 실패 / 네트워크 오류 구분)
3. **passphrase 소스** — env 변수 / 파일 / keychain 중 어느 소스에서 로드됐는지 표시
4. **passphrase↔vault 정합** — 원격 keyparams sentinel 복호화로 passphrase 일치 여부 검증
5. **vault 상태** — keyparams / manifest 존재 여부, manifestGeneration 및 항목 수
6. **transport 보안** — 평문 http 사용 시 자격증명 노출 경고 (localhost 제외)
7. **CAS/ETag 능력** — 원격 keyparams ETag 강도로 조건부 PUT(CAS) 신뢰성 휴리스틱 점검(weak/no-ETag 경고)
8. **원격 락 상태** — lock.json 보유자·만료·손상 진단(타 머신 유효 락이면 경고)
9. **machine-id** — 로컬 머신 식별자 존재 여부

실패 항목이 하나라도 있으면 종료 코드가 0이 아니다.
