import fg from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, ScannedFile } from "../types.js";
import { toLogical, CLAUDE_JSON_LOGICAL_KEY, toOS } from "./paths.js";

// fast-glob 로 include/exclude 적용해 로컬 파일 열거 후 ScannedFile 배열 반환 (logicalKey 오름차순)
export async function scanLocal(config: Config): Promise<ScannedFile[]> {
  const { home, targets, stateDir } = config;

  const ignore = [...targets.exclude];
  // stateDir(~/.wormhole: 백업/base 스냅샷/age-key.txt/passphrase 등)가 home 하위면
  // 무조건 스캔 제외 — 동기화 상태 파일/비밀이 절대 sync 대상이 되지 않게 한다.
  const relState = path.relative(home, stateDir);
  if (relState !== "" && !relState.startsWith("..") && !path.isAbsolute(relState)) {
    ignore.push(`${relState.split(path.sep).join("/")}/**`);
  }

  const matches = await fg(targets.include, {
    cwd: home,
    dot: true,
    ignore,
    onlyFiles: true,
    followSymbolicLinks: false,
    absolute: false,
  });

  const results: ScannedFile[] = [];

  for (const rel of matches) {
    // fast-glob 는 항상 posix 슬래시 반환이지만 OS 경로는 path.join 으로 안전하게 결합
    const absPath = path.join(home, ...rel.split("/"));
    const logicalKey = toLogical(home, absPath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      // 스캔 중 삭제된 파일 무시
      continue;
    }

    // 디렉터리가 섞여 들어오면 제외 (onlyFiles 보장이지만 이중 검사)
    if (!stat.isFile()) continue;

    results.push({
      logicalKey,
      absPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  // home-root 파일 열거: config.homeRootTargets 에 등록된 파일이 존재할 때만 추가.
  // fast-glob include 패턴(".claude/**")은 ".claude/" 하위만 커버하므로 home-root 파일은
  // 별도 처리가 필요하다. 일반 RAW sync 진입 금지(engine 에서 isClaudeJsonKey 로 라우팅).
  if (config.homeRootTargets) {
    for (const logicalKey of Object.keys(config.homeRootTargets)) {
      const absPath = toOS(home, logicalKey);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      results.push({
        logicalKey: logicalKey as typeof CLAUDE_JSON_LOGICAL_KEY,
        absPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  // logicalKey 오름차순 정렬
  results.sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));

  return results;
}
