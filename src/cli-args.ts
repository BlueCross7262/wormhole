import type { ResolvePolicy } from "./types.js";

export const USAGE = `wormhole — Claude Code 전역 설정 동기화 CLI

Usage:
  wormhole status                                  원격/로컬 diff 상태를 JSON 으로 출력
  wormhole resolve [--policy P] [--keys k1,k2] [--dry-run]
                                                    충돌 해소 (P = preserve-both|latest-wins|ours|manual|merge)
  wormhole sync  [--policy preserve-both|latest-wins|merge]
                                                    복합: pull → (충돌 시) resolve → push
  wormhole sync  --force-up  [--dry-run]            원격 초기화 후 로컬 전체 업로드 (파괴적)
  wormhole sync  --force-down  [--dry-run]          로컬을 원격으로 무조건 덮어쓰기 + 미러삭제 (파괴적)
  wormhole doctor                                  환경 진단(읽기 전용): config·연결·passphrase·vault·transport
  wormhole --help | -h                              이 도움말을 출력

Exit code 0 on success, nonzero on error.`;

export function parsePolicy(value: string | boolean | undefined): ResolvePolicy | undefined {
  if (value === undefined || value === true) return undefined;
  if (
    value === "preserve-both" ||
    value === "latest-wins" ||
    value === "ours" ||
    value === "manual" ||
    value === "merge"
  ) {
    return value;
  }
  throw new Error(
    `알 수 없는 정책: ${String(value)} (preserve-both|latest-wins|ours|manual|merge 중 하나)`,
  );
}
