---
name: make-conflict
description: 실제 vault 에 재현 가능한 wormhole sync 충돌을 만든다. 가짜 2번째 머신을 temp HOME 으로 세워 `.claude/settings.json` 의 `env` fixture 키를 push 하고, 이 머신 로컬에도 같은 키를 다른 값으로 넣어 양쪽을 base 에서 이탈시킨다. `/wormhole-sync` → `/wormhole-resolve` 의 항목별 충돌 UX 를 설치본에서 검증할 때 쓴다. 이 저장소 내부 개발 도구이며 플러그인 사용자에게 배포되지 않는다.
argument-hint: "[--cleanup | --revert-remote] [--key-a <이름>] [--key-b <이름>]"
user-invocable: true
disable-model-invocation: true
---

## 변수

| 변수 | 확정 시점 | 원천 | 기본값 |
|---|---|---|---|
| `mode` | 인자 파싱 | `--cleanup` / `--revert-remote` / 없음 | `create` |
| `key_a` | 인자 파싱 | `--key-a` | `WORMHOLE_FIXTURE_A` |
| `key_b` | 인자 파싱 | `--key-b` | `WORMHOLE_FIXTURE_B` |
| `temp_root` | 실행 시작 | `os.tmpdir()/wormhole-make-conflict` 고정 | — |
| `backup` | `create` Step 5 직전 | `<temp_root>-settings-backup.json` | — |
| `fake_machine_id` | 고정 | `00000000-f1c7-4000-8000-000000000001` | — |

`key_a` 는 양쪽이 서로 다른 값을 넣어 leaf 충돌을 만드는 키다. `key_b` 는 원격만 추가해
자동 채택 경로를 만드는 키다. 둘 다 `settings.json` 의 `env` 하위에만 들어간다.

## 실행

```bash
node .claude/skills/make-conflict/scripts/make-conflict.mjs $ARGUMENTS
```

JSON 결과를 읽고 한국어로 요약한다. `create` 성공이면 다음 행동으로 `/wormhole-sync` 를 안내한다.

## 무엇을 하는가

- 가짜 머신을 `temp_root` 에 세운다. 실 `~/.wormhole/.env` 를 줄 단위로 복사하되
  `WORMHOLE_CONFIG`·`WORMHOLE_SYNC_INCLUDE`·`WORMHOLE_SYNC_EXCLUDE` 줄은 버린다.
  실 `wormhole-config.json` 을 사본으로 쓰되 `home`·`stateDir` 을 temp 로 바꾸고,
  `targets.include` 를 `.claude/settings.json` 하나로 줄이며, `skills_keyword` 를 지우고
  `homeRootTargets` 를 비운다.
- 실 `~/.claude/plugins/{installed_plugins,known_marketplaces}.json` 을 temp 로 복사한다.
  설치 선결조건 검사가 `home/.claude/plugins` 를 읽기 때문이다.
- 가짜 머신이 `settings.json` 만 pull 해 base 를 만든 뒤, `env` 에 fixture 키를 넣어 push 한다.
- 실 머신 `settings.json` 에도 `key_a` 를 다른 값으로 넣어 양쪽이 base 에서 이탈하게 한다.

## 왜 스코프를 1개 키로 줄이는가

삭제·tombstone 은 그 키가 그 머신 `state` 에 있을 때만 발생한다. 가짜 머신 state 에
`.claude/settings.json` 하나만 들어가면 다른 키를 지우는 경로가 구조적으로 존재하지 않는다.
manifest 는 키 단위 merge 라 나머지 엔트리는 그대로 남는다.

## 게이트

스크립트가 아래를 어기면 그 자리에서 중단한다. 전부 `status`(읽기 전용) 로 판정한다.

- Step 0 — 실 머신이 수렴 상태(`added`·`modified`·`deleted`·`conflicts` 전부 비었음)여야 한다.
- 게이트 A — 가짜 머신 초기 상태가 같은 조건을 만족해야 한다. `remoteAdded` 는 스코프와
  무관하게 매니페스트 전 키를 담으므로 판정에 쓰지 않는다.
- Step 3 — 가짜 baseline sync 의 `pull.applied` 가 정확히 `.claude/settings.json` 1건이고
  `push.pushed`·`push.deleted` 가 비어야 한다. 스코프 축소의 실측 증명이 이 줄이다.
- 게이트 A2 — 그 직후 다시 수렴 상태여야 한다.
- 게이트 B — fixture 를 넣은 뒤 `modified` 가 `.claude/settings.json` 1건이고
  `added`·`deleted`·`conflicts` 가 비어야 한다.
- Step 8 — 실제 push 의 `pushed` 가 1건, `deleted` 가 0건. generation 이 직전+1 이 아니면
  경고만 낸다. 412 로 실패하면 1회 재시도한다.
- Step 9 — 실 머신 `status` 의 conflicts 가 `.claude/settings.json` 1건이고
  `remoteDeleted` 가 비어야 한다.

## 실패 시 복원

- push 성공을 확인하기 전 단계에서 실패하면 실 `settings.json` 을 `backup` 에서 되돌리고 중단한다.
- push 를 확인한 뒤(Step 9 사후 확인 포함) 실패하면 복원하지 않는다. 원격은 이미 fixture 를
  담은 의도된 상태이고, 로컬만 되돌리면 원격 단독 이탈이 되어 충돌 조건이 깨진다. 이 경우
  판정만 보고하고 종료 코드 1 로 끝낸다.

## 정리

- `--revert-remote` — 가짜 머신을 재사용해 temp 쪽 `settings.json` 에서 fixture 키 줄을 지우고
  다시 push 한다. tombstone 없이 앞으로 고치는 경로다. 원격 blob·manifest 를 직접 손대지 않는다.
- `--cleanup` — `temp_root` 를 지우고 남은 충돌 sidecar 경로를 나열한다. sidecar 삭제 여부는
  사용자가 정한다.
- 로컬 fixture 키 제거 — `/wormhole-resolve` 흐름을 끝낸 뒤 실 `settings.json` 에서 그 키를
  지우고 `/wormhole-sync` 를 돌린다.

## 제약

- fixture 키 이름은 대문자 식별자여야 하고 `_PAT`·`_TOKEN`·`_SECRET` 으로 끝날 수 없다.
  `settings.json` 의 `env` 는 secret strip 대상이 아니지만 실 비밀값과 혼동하지 않기 위함이다.
- fixture 는 `enabledPlugins` 를 건드리지 않는다. 설치 선결조건 검사에 영향이 없어야 한다.
- 실 `~/.wormhole` 은 읽기만 한다. `.env` 복사 원본으로만 쓴다.
- passphrase 가 파일·keychain 방식이면 중단한다. temp HOME 에서 `~` 가 다르게 풀린다.
- `temp_root` 가 이미 있으면 직전 실행 미정리로 보고 중단한다. `--cleanup` 을 먼저 돌린다.
