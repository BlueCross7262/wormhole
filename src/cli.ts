// CLI 진입점 — argv 디스패처. Claude Code 슬래시 커맨드가 이 CLI 를 shell-out 한다.
// 결과 JSON 은 stdout 으로, 오류는 stderr + 비0 종료코드로 낸다. logger 는 이미 stderr 로 쓴다.
// 서버/기동-pull/jobManager 없음 — 각 서브커맨드는 일회성(one-shot)으로 엔진을 조립·실행한다.

import { logger } from "./logger.js";
import { buildEngine } from "./bootstrap.js";
import { runDoctor } from "./doctor.js";
import type { ResolvePolicy } from "./types.js";

const USAGE = `wormhole — Claude Code 전역 설정 동기화 CLI

Usage:
  wormhole status                                  원격/로컬 diff 상태를 JSON 으로 출력
  wormhole resolve [--policy P] [--keys k1,k2] [--dry-run]
                                                    충돌 해소 (P = preserve-both|latest-wins|manual)
  wormhole sync  [--policy preserve-both|latest-wins]
                                                    복합: pull → (충돌 시) resolve → push
  wormhole doctor                                  환경 진단(읽기 전용): config·연결·passphrase·vault·transport
  wormhole --help | -h                              이 도움말을 출력

Exit code 0 on success, nonzero on error.`;

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { flags, positionals };
}

function emit(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parsePolicy(value: string | boolean | undefined): ResolvePolicy | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "preserve-both" || value === "latest-wins" || value === "manual") {
    return value;
  }
  throw new Error(
    `알 수 없는 정책: ${String(value)} (preserve-both|latest-wins|manual 중 하나)`,
  );
}

function parseKeys(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const keys = value
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length > 0 ? keys : undefined;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0];

  // --help / -h / 서브커맨드 없음 → 비밀 없이 오프라인 동작. buildEngine 호출하지 않는다.
  if (command === undefined || flags.help === true || flags.h === true || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const dryRunFlag = flags["dry-run"] === true;

  switch (command) {
    case "status": {
      const { engine } = await buildEngine(logger);
      emit(await engine.status());
      return;
    }

    case "resolve": {
      const policy = parsePolicy(flags.policy);
      const keys = parseKeys(flags.keys);
      const { engine } = await buildEngine(logger);
      emit(await engine.resolve(policy, keys, { dryRun: dryRunFlag }));
      return;
    }

    case "sync": {
      const policy = parsePolicy(flags.policy) ?? "preserve-both";
      if (policy === "manual") {
        throw new Error("manual not allowed for sync; run /wormhole-resolve");
      }
      const { engine } = await buildEngine(logger);

      // 복합: pull → (충돌 있으면) resolve(policy) → push. stop-on-error.
      const pull = await engine.pull();
      const combined: Record<string, unknown> = { pull };
      if (pull.conflicts.length > 0) {
        combined.resolve = await engine.resolve(policy);
      }
      combined.push = await engine.push();
      emit(combined);
      return;
    }

    case "doctor": {
      // doctor 는 buildEngine 불요 — 자체적으로 loadConfig 등을 tolerant 하게 재실행한다.
      const result = await runDoctor(logger);
      emit(result);
      if (!result.ok) process.exit(1);
      return;
    }

    default:
      throw new Error(`알 수 없는 커맨드: ${command}\n\n${USAGE}`);
  }
}

run().catch((err) => {
  const e = err as Error;
  logger.error(`치명적 오류: ${String(e.stack ?? e.message)}`);
  process.exit(1);
});
