// CLI 진입점 — argv 디스패처. Claude Code 슬래시 커맨드가 이 CLI 를 shell-out 한다.
// 결과 JSON 은 stdout 으로, 오류는 stderr + 비0 종료코드로 낸다. logger 는 이미 stderr 로 쓴다.
// 서버/기동-pull/jobManager 없음 — 각 서브커맨드는 일회성(one-shot)으로 엔진을 조립·실행한다.

import { logger } from "./logger.js";
import { maybeMigrateLegacyConfig } from "./migrate-config.js";
import { buildEngine } from "./bootstrap.js";
import { runDoctor } from "./doctor.js";
import { USAGE, parsePolicy } from "./cli-args.js";
import { runSyncCommand } from "./cli-sync.js";

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

  await maybeMigrateLegacyConfig({ logger });

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
      const forceUp = flags["force-up"] === true;
      const forceDown = flags["force-down"] === true;
      if (forceUp && forceDown) throw new Error("--force-up 와 --force-down 동시 사용 불가");
      if ((forceUp || forceDown) && flags.policy !== undefined)
        throw new Error("force 모드는 --policy 와 함께 쓸 수 없음");
      const { engine } = await buildEngine(logger);
      if (forceUp) { emit({ forceUpload: await engine.forceUpload({ dryRun: dryRunFlag }) }); return; }
      if (forceDown) { emit({ forceDownload: await engine.forceDownload({ dryRun: dryRunFlag }) }); return; }

      const policy = parsePolicy(flags.policy) ?? "preserve-both";
      if (policy === "manual" || policy === "ours") {
        throw new Error(`${policy} not allowed for sync; run /wormhole-resolve`);
      }

      const { payload, exitCode } = await runSyncCommand(engine, { policy });
      emit(payload);
      if (exitCode !== 0) process.exit(exitCode);
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
