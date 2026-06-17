// 자동 동기화 watcher — chokidar 로 로컬 변경 감지 → debounce 후 engine.push,
// 시작 시 1회 pull + 주기 pull. 모든 동기화는 engine 내부 mutex 로 직렬화.
// 자기쓰기 루프 방지: engine 적용(push/pull) 중에는 watch 이벤트를 무시(suppress).
//
// watcher 수명 한계:
//   (a) 이 watcher 는 MCP stdio 프로세스(= Claude Code 세션)가 살아있는 동안만 동작한다.
//   (b) 세션 종료 시 자동 push 도 함께 중단된다 — 상시 동작하는 데몬이 아니다.
//   (c) 오프라인(세션 미가동) 중 발생한 로컬 변경은 다음 기동의 startup pull +
//       사용자가 명시적으로 부르는 수동 sync_push 로 보정한다.
//   (d) 원격(다른 머신)에서 발생한 변경은 이 watcher 로 감지할 수 없다 →
//       기동 시 pull + 주기 pull 로만 반영된다.

import { watch, type FSWatcher } from "chokidar";
import * as fsSync from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import type { SyncEngine } from "../sync/engine.js";
import type { Config, Logger } from "../types.js";

// include 글로브에서 글로브 메타문자 이전의 정적 prefix(실디렉터리)를 추출.
// 예: ".claude/skills/**" → ".claude/skills", ".claude/CLAUDE.md" → ".claude".
function staticRoot(glob: string): string {
  const segs = glob.split("/");
  const stable: string[] = [];
  for (const seg of segs) {
    if (/[*?[\]{}!()]/.test(seg)) break;
    stable.push(seg);
  }
  // 마지막 정적 세그먼트가 파일명일 수 있으므로 디렉터리까지만 사용.
  if (stable.length === segs.length) {
    // 글로브 메타 없음 = 단일 파일 경로 → 부모 디렉터리를 watch root 로.
    stable.pop();
  }
  return stable.join("/");
}

// chokidar awaitWriteFinish 안정화 윈도우(ms). 이 값 이상으로 파일 크기가
// 변하지 않아야 이벤트가 방출된다. 자기쓰기 억제 해제 지연 계산과 공유하여
// awaitWriteFinish 설정과 지연 윈도우가 항상 일치하도록 한다.
const STABILITY_THRESHOLD_MS = 300;

// 자기쓰기 억제 카운터 감소를 지연시키는 시간(ms).
// engine.push/pull 이 쓴 파일의 chokidar 이벤트는 stabilityThreshold 윈도우가
// 지나야 방출되므로, 억제를 즉시 풀면 그 이벤트가 통과해 self-write 루프가 된다.
// stabilityThreshold + 버퍼(300ms) 만큼 감소를 늦춰 자기쓰기 이벤트를 흡수한다.
const SUPPRESS_RELEASE_DELAY_MS = STABILITY_THRESHOLD_MS + 300;

export class AutoSync {
  private readonly engine: SyncEngine;
  private readonly config: Config;
  private readonly logger?: Logger;
  // enabled=false 여도 강제 기동(데몬 모드 등). config.autoSync.enabled 우회.
  private readonly forceEnabled: boolean;

  private watcher: FSWatcher | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  // 자기쓰기 루프 방지: engine 적용 중이면 watch 이벤트 무시.
  // boolean 대신 정수 카운터로 재진입 안전성 확보 — push 와 interval-pull 이
  // engine mutex 큐에서 겹쳐도 카운터가 중첩되어 자기쓰기 억제가 깨지지 않는다.
  #suppressDepth = 0;
  // 지연 카운터 감소를 위한 pending timer 추적 — stop() 에서 일괄 clear.
  readonly #suppressTimers = new Set<NodeJS.Timeout>();
  // 정지 중에는 새 작업을 시작하지 않음.
  private stopping = false;

  constructor(
    engine: SyncEngine,
    config: Config,
    logger?: Logger,
    opts?: { forceEnabled?: boolean },
  ) {
    this.engine = engine;
    this.config = config;
    this.logger = logger;
    this.forceEnabled = opts?.forceEnabled ?? false;
  }

  // 시작: 1회 pull → chokidar watch + debounce push → 주기 pull 스케줄러.
  // enabled=false 면 no-op.
  async start(): Promise<void> {
    if (!this.config.autoSync.enabled && !this.forceEnabled) {
      this.logger?.info("[autosync] disabled — not starting");
      return;
    }
    if (this.watcher) {
      this.logger?.warn("[autosync] already started");
      return;
    }

    // 시작 시 1회 pull. engine mutex 경유, suppress 로 자기쓰기 무시.
    await this.runPull("startup");

    // chokidar v4 는 glob 미지원 → 정적 디렉터리 root 만 watch 하고,
    // include/exclude 매칭은 picomatch 기반 ignored predicate 로 처리.
    const home = this.config.home;
    const roots = new Set<string>();
    for (const g of this.config.targets.include) {
      const root = staticRoot(g);
      const absRoot = root === "" ? home : path.join(home, ...root.split("/"));
      // 존재하는 디렉터리만 watch 대상에 추가.
      try {
        if (fsSync.statSync(absRoot).isDirectory()) roots.add(absRoot);
      } catch {
        // 부재 디렉터리는 상위로 대체.
        roots.add(path.dirname(absRoot));
      }
    }
    const watchPaths = roots.size > 0 ? [...roots] : [home];

    // include/exclude 매처(home 기준 posix 상대경로 = logicalKey 에 적용).
    const includeMatch = picomatch(this.config.targets.include, { dot: true });
    const excludeMatch = picomatch(this.config.targets.exclude, { dot: true });

    // ignored predicate: 디렉터리는 항상 통과(하위 탐색 유지),
    // 파일은 include 매칭 && !exclude 일 때만 통과(나머지는 ignore).
    const ignored = (testPath: string, stats?: fsSync.Stats): boolean => {
      const rel = path.relative(home, testPath).split(path.sep).join("/");
      if (rel === "" || rel.startsWith("..")) return false;
      // stats 미제공 시(경로만) 디렉터리 여부 불명 → 통과시켜 탐색 유지.
      if (!stats || stats.isDirectory()) return false;
      return !(includeMatch(rel) && !excludeMatch(rel));
    };

    this.watcher = watch(watchPaths, {
      ignored,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: STABILITY_THRESHOLD_MS,
        pollInterval: 100,
      },
    });

    const onChange = (path: string): void => {
      // engine 적용 중(또는 적용 직후 안정화 윈도우)에 발생한 이벤트는
      // 자기쓰기이므로 무시. 카운터가 0 보다 크면 억제 활성 상태.
      if (this.#suppressDepth > 0 || this.stopping) return;
      this.logger?.debug(`[autosync] change detected: ${path}`);
      this.scheduleDebouncedPush();
    };

    this.watcher
      .on("add", onChange)
      .on("change", onChange)
      .on("unlink", onChange)
      .on("error", (err) =>
        this.logger?.error(`[autosync] watcher error: ${String(err)}`),
      );

    // 주기 pull 스케줄러 (pullIntervalMs > 0 일 때만).
    const interval = this.config.autoSync.pullIntervalMs;
    if (interval > 0) {
      this.pullTimer = setInterval(() => {
        if (this.stopping) return;
        void this.runPull("interval");
      }, interval);
    }

    this.logger?.info(
      `[autosync] started — watching ${watchPaths.length} target(s), ` +
        `debounce=${this.config.autoSync.debounceMs}ms, pullInterval=${interval}ms`,
    );
  }

  // 정지: watcher close + 타이머 clear. 진행 중 debounce push 는 취소.
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    // 지연 억제-해제 타이머 정리 — 지연 감소가 stop/shutdown 과 경쟁하지 않도록
    // pending timer 를 모두 clear 하고 카운터를 0 으로 리셋한다.
    for (const t of this.#suppressTimers) clearTimeout(t);
    this.#suppressTimers.clear();
    this.#suppressDepth = 0;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.logger?.info("[autosync] stopped");
  }

  // debounce 후 push 예약. 연속 변경은 마지막 이벤트 기준으로 1회만 push.
  private scheduleDebouncedPush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runPush();
    }, this.config.autoSync.debounceMs);
  }

  // engine.push 실행. suppress 플래그로 push 가 만드는 로컬 쓰기(자기쓰기) 무시.
  // engine.push 실행. 억제 카운터로 push 가 만드는 로컬 쓰기(자기쓰기) 무시.
  private async runPush(): Promise<void> {
    if (this.stopping) return;
    this.#suppressDepth++;
    try {
      const result = await this.engine.push();
      this.logger?.info(
        `[autosync] push — pushed=${result.pushed.length}, ` +
          `deleted=${result.deleted.length}, conflicts=${result.conflicts.length}`,
      );
    } catch (err) {
      this.logger?.error(`[autosync] push failed: ${String(err)}`);
    } finally {
      this.#releaseSuppressDelayed();
    }
  }

  // engine.pull 실행. suppress 플래그로 pull 의 로컬 쓰기(자기쓰기) 무시.
  // engine.pull 실행. 억제 카운터로 pull 의 로컬 쓰기(자기쓰기) 무시.
  private async runPull(reason: string): Promise<void> {
    if (this.stopping) return;
    this.#suppressDepth++;
    try {
      const result = await this.engine.pull();
      this.logger?.info(
        `[autosync] pull(${reason}) — applied=${result.applied.length}, ` +
          `removed=${result.removed.length}, conflicts=${result.conflicts.length}`,
      );
    } catch (err) {
      this.logger?.warn(`[autosync] pull(${reason}) failed: ${String(err)}`);
    } finally {
      this.#releaseSuppressDelayed();
    }
  }

  // 억제 카운터 감소를 stabilityThreshold + 버퍼만큼 지연시킨다.
  // engine 이 쓴 파일의 chokidar 이벤트가 안정화 윈도우를 벗어난 뒤에 억제를
  // 풀어야 self-write 루프가 생기지 않는다. pending timer 는 추적하여 stop() 에서
  // 정리하고, 콜백 진입 시 stopping/clear 와의 경쟁을 막기 위해 Set 멤버십을 검사한다.
  #releaseSuppressDelayed(): void {
    const timer = setTimeout(() => {
      // stop() 이 먼저 정리했다면(멤버 부재) 카운터를 건드리지 않는다.
      if (!this.#suppressTimers.delete(timer)) return;
      if (this.#suppressDepth > 0) this.#suppressDepth--;
    }, SUPPRESS_RELEASE_DELAY_MS);
    this.#suppressTimers.add(timer);
  }
}
