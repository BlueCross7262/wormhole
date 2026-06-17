// AutoSync.forceEnabled 동작 검증 — config.autoSync.enabled=false 여도
// forceEnabled:true 면 start() 가 early-return 하지 않고 startup pull 을 수행한다.
// FAKE engine (push/pull/status 스텁) + tmp home 으로 chokidar 가 실디렉터리를
// watch 하게 한다. 네트워크/실HOME 미사용. stop() 으로 watcher·타이머 완전 정리.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AutoSync } from "./auto-sync.js";
import type { SyncEngine } from "../sync/engine.js";
import type { Config, Logger, PushResult, PullResult } from "../types.js";

// push/pull 호출 횟수만 추적하는 최소 가짜 engine. AutoSync 는 push/pull 만 호출.
function makeFakeEngine(): { engine: SyncEngine; pullCount: () => number; pushCount: () => number } {
  let pulls = 0;
  let pushes = 0;
  const pullResult: PullResult = {
    dryRun: false,
    applied: [],
    removed: [],
    conflicts: [],
    backupDir: null,
  };
  const pushResult: PushResult = {
    dryRun: false,
    pushed: [],
    deleted: [],
    skipped: 0,
    manifestGeneration: null,
    conflicts: [],
  };
  const fake = {
    async pull(): Promise<PullResult> {
      pulls++;
      return pullResult;
    },
    async push(): Promise<PushResult> {
      pushes++;
      return pushResult;
    },
    status(): never {
      throw new Error("status not used");
    },
  };
  return {
    engine: fake as unknown as SyncEngine,
    pullCount: () => pulls,
    pushCount: () => pushes,
  };
}

function buildConfig(home: string): Config {
  return {
    stateDir: path.join(home, ".wormhole"),
    home,
    remote: { url: "http://mock.invalid", username: "", password: "", remoteBaseDir: "/wormhole" },
    crypto: {
      passphraseEnv: "WORMHOLE_PASSPHRASE",
      passphraseFile: path.join(home, ".wormhole", "passphrase"),
      derivedKeyPath: path.join(home, ".wormhole", "age-key.txt"),
      kdfN: 2,
      kdfR: 8,
      kdfP: 1,
    },
    targets: { include: [".claude/**"], exclude: [] },
    settingsLocalKeys: [],
    selfMcpServerNames: [],
    conflictPolicy: "preserve-both",
    // enabled=false 이지만 forceEnabled 로 기동되어야 함.
    autoSync: { enabled: false, debounceMs: 5, pullIntervalMs: 0 },
    lock: { ttlMs: 60_000, acquireRetries: 2, acquireRetryDelayMs: 1 },
  };
}

test("forceEnabled:true starts even when autoSync.enabled=false (startup pull runs)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
  // chokidar 가 실디렉터리를 watch 하도록 include root 를 생성.
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const { engine, pullCount } = makeFakeEngine();
  const config = buildConfig(home);
  const auto = new AutoSync(engine, config, undefined, { forceEnabled: true });

  try {
    await auto.start();
    // early-return 하지 않았다면 startup pull 이 정확히 1회 호출됨.
    assert.equal(pullCount(), 1, "startup pull should run when forceEnabled");
  } finally {
    await auto.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("enabled=false and no forceEnabled early-returns (no startup pull)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const { engine, pullCount } = makeFakeEngine();
  const config = buildConfig(home);
  const auto = new AutoSync(engine, config);

  try {
    await auto.start();
    assert.equal(pullCount(), 0, "disabled AutoSync must not pull");
  } finally {
    await auto.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 분기 커버리지 확장: staticRoot/watch-root 도출, debounce push, 자기쓰기 억제,
//    interval pull, 이미-시작 가드, watcher error 핸들러, stop 정리. ───────────

// SUPPRESS_RELEASE_DELAY_MS = STABILITY_THRESHOLD_MS(300) + 300 = 600ms.
// startup pull 이 억제 카운터를 1 올리므로, 그 해제를 기다린 뒤에야 watch 이벤트가
// push 로 이어진다. 600ms 보다 넉넉히 기다린다.
const SUPPRESS_WINDOW_MS = 700;
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// 호출/실패를 제어 가능한 가짜 engine. throwPush/throwPull 로 에러 분기를 친다.
function makeControllableEngine(opts?: {
  throwPush?: boolean;
  throwPull?: boolean;
}): {
  engine: SyncEngine;
  pullCount: () => number;
  pushCount: () => number;
} {
  let pulls = 0;
  let pushes = 0;
  const pullResult: PullResult = {
    dryRun: false,
    applied: [],
    removed: [],
    conflicts: [],
    backupDir: null,
  };
  const pushResult: PushResult = {
    dryRun: false,
    pushed: [],
    deleted: [],
    skipped: 0,
    manifestGeneration: null,
    conflicts: [],
  };
  const fake = {
    async pull(): Promise<PullResult> {
      pulls++;
      if (opts?.throwPull) throw new Error("pull boom");
      return pullResult;
    },
    async push(): Promise<PushResult> {
      pushes++;
      if (opts?.throwPush) throw new Error("push boom");
      return pushResult;
    },
    status(): never {
      throw new Error("status not used");
    },
  };
  return {
    engine: fake as unknown as SyncEngine,
    pullCount: () => pulls,
    pushCount: () => pushes,
  };
}

// debug/info/warn/error 호출을 레벨별로 기록하는 가짜 logger.
function makeFakeLogger(): {
  logger: Logger;
  errors: () => string[];
  warns: () => string[];
} {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    logger: {
      debug() {},
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error(msg: string) {
        errors.push(msg);
      },
    },
    errors: () => errors,
    warns: () => warns,
  };
}

// private watcher(EventEmitter) 접근. 실 FS 이벤트(awaitWriteFinish 300ms 안정화)는
// 느리고 비결정적이라, onChange/error 핸들러를 합성 이벤트 emit 으로 직접 친다.
function watcherOf(auto: AutoSync): { emit: (ev: string, ...a: unknown[]) => void } {
  const w = (auto as unknown as { watcher: { emit: (ev: string, ...a: unknown[]) => void } | null }).watcher;
  assert.ok(w, "watcher should be created after start()");
  return w;
}

// pullIntervalMs:0(기본) + 임의 include 글로브로 config 구성.
function configWith(
  home: string,
  overrides?: {
    include?: string[];
    debounceMs?: number;
    pullIntervalMs?: number;
    enabled?: boolean;
  },
): Config {
  const base = buildConfig(home);
  return {
    ...base,
    targets: {
      ...base.targets,
      include: overrides?.include ?? base.targets.include,
    },
    autoSync: {
      enabled: overrides?.enabled ?? base.autoSync.enabled,
      debounceMs: overrides?.debounceMs ?? base.autoSync.debounceMs,
      pullIntervalMs: overrides?.pullIntervalMs ?? base.autoSync.pullIntervalMs,
    },
  };
}

describe("AutoSync branch coverage", () => {
  test("start() twice: second call hits 'already started' guard (no extra pull/watcher)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pullCount } = makeControllableEngine();
    const { logger, warns } = makeFakeLogger();
    const auto = new AutoSync(engine, configWith(home, { enabled: true }), logger);
    try {
      await auto.start();
      const w1 = (auto as unknown as { watcher: unknown }).watcher;
      assert.equal(pullCount(), 1, "first start runs startup pull");
      await auto.start();
      const w2 = (auto as unknown as { watcher: unknown }).watcher;
      assert.equal(pullCount(), 1, "second start must NOT pull again");
      assert.strictEqual(w1, w2, "watcher instance unchanged on second start");
      assert.ok(
        warns().some((m) => m.includes("already started")),
        "already-started warning logged",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("interval pull scheduled when pullIntervalMs>0 (fires beyond startup pull)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pullCount } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, pullIntervalMs: 25 }),
    );
    try {
      await auto.start();
      assert.equal(pullCount(), 1, "startup pull");
      // 인터벌 pull 이 최소 1회 더 발생할 만큼 대기.
      await sleep(90);
      assert.ok(
        pullCount() >= 2,
        `interval pull should fire (saw ${pullCount()} pulls)`,
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no interval pull when pullIntervalMs=0 (only startup pull)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pullCount } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, pullIntervalMs: 0 }),
    );
    try {
      await auto.start();
      await sleep(60);
      assert.equal(pullCount(), 1, "no interval timer → exactly one (startup) pull");
      assert.strictEqual(
        (auto as unknown as { pullTimer: unknown }).pullTimer,
        null,
        "pullTimer must stay null when interval=0",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("burst of file-change events debounces to exactly one push", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pushCount } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, debounceMs: 10, pullIntervalMs: 0 }),
    );
    try {
      await auto.start();
      // startup pull 억제 윈도우가 끝나야 watch 이벤트가 push 로 이어진다.
      await sleep(SUPPRESS_WINDOW_MS);
      assert.equal(pushCount(), 0, "no push before any event");
      const w = watcherOf(auto);
      // 빠른 연속 이벤트 = 하나의 burst.
      w.emit("add", path.join(home, ".claude", "a.md"));
      w.emit("add", path.join(home, ".claude", "b.md"));
      w.emit("change", path.join(home, ".claude", "c.md"));
      // debounce(10ms) + push 완료까지 대기.
      await sleep(60);
      assert.equal(pushCount(), 1, "burst coalesces into a single push");
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("self-write suppression: events during in-flight pull do not push", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pushCount } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, debounceMs: 10, pullIntervalMs: 0 }),
    );
    try {
      await auto.start();
      // start() 직후: startup pull 의 억제 카운터가 아직 살아있다(>0).
      const w = watcherOf(auto);
      w.emit("add", path.join(home, ".claude", "during-suppress.md"));
      // debounce 가 만료될 만큼 기다려도 suppress 로 인해 push 가 예약조차 안 됨.
      await sleep(60);
      assert.equal(
        pushCount(),
        0,
        "events while #suppressDepth>0 must be ignored (no push)",
      );
      // 억제가 풀린 뒤의 이벤트는 정상적으로 push 한다(대조군).
      await sleep(SUPPRESS_WINDOW_MS);
      w.emit("change", path.join(home, ".claude", "after-release.md"));
      await sleep(60);
      assert.equal(pushCount(), 1, "after suppression release a push fires");
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("staticRoot: glob include (.claude/**) watches the static dir root", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    const { engine } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, {
        enabled: true,
        include: [".claude/skills/**"],
      }),
    );
    try {
      await auto.start();
      // 존재하는 .claude/skills 가 watch root 로 잡혀 watcher 가 생성됨.
      assert.ok(
        (auto as unknown as { watcher: unknown }).watcher,
        "watcher created for existing glob root",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("staticRoot: absent glob-root dir falls back to its parent (no crash)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    // .claude 만 만들고 nested/deep 은 만들지 않음 → statSync throw → 부모로 대체.
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, {
        enabled: true,
        include: [".claude/nope-missing/deeper/**"],
      }),
    );
    try {
      await auto.start();
      assert.ok(
        (auto as unknown as { watcher: unknown }).watcher,
        "start() must not throw when glob root dir is absent (parent fallback)",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("staticRoot: file-path include (.claude/CLAUDE.md) derives parent dir as root", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine } = makeControllableEngine();
    // 글로브 메타 없는 단일 파일 경로 → staticRoot 가 파일명을 pop 하고
    // 부모(.claude)를 root 로 사용. .claude 는 존재하므로 정상 watch.
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, include: [".claude/CLAUDE.md"] }),
    );
    try {
      await auto.start();
      assert.ok(
        (auto as unknown as { watcher: unknown }).watcher,
        "watcher created for single-file include",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("watcher 'error' event is logged via logger.error", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine } = makeControllableEngine();
    const { logger, errors } = makeFakeLogger();
    const auto = new AutoSync(engine, configWith(home, { enabled: true }), logger);
    try {
      await auto.start();
      const w = watcherOf(auto);
      w.emit("error", new Error("watcher kaboom"));
      assert.ok(
        errors().some((m) => m.includes("watcher error") && m.includes("kaboom")),
        "watcher error must be logged at error level",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("engine.push failure is caught and logged (push error branch)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pushCount } = makeControllableEngine({ throwPush: true });
    const { logger, errors } = makeFakeLogger();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, debounceMs: 10, pullIntervalMs: 0 }),
      logger,
    );
    try {
      await auto.start();
      await sleep(SUPPRESS_WINDOW_MS);
      const w = watcherOf(auto);
      w.emit("add", path.join(home, ".claude", "x.md"));
      await sleep(60);
      assert.equal(pushCount(), 1, "push attempted once");
      assert.ok(
        errors().some((m) => m.includes("push failed")),
        "push failure logged at error level",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("engine.pull failure is caught and logged (pull error branch)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pullCount } = makeControllableEngine({ throwPull: true });
    const { logger, warns } = makeFakeLogger();
    const auto = new AutoSync(engine, configWith(home, { enabled: true }), logger);
    try {
      await auto.start();
      assert.equal(pullCount(), 1, "startup pull attempted once");
      assert.ok(
        warns().some((m) => m.includes("pull(startup)") && m.includes("failed")),
        "pull failure logged at warn level",
      );
    } finally {
      await auto.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stop() clears timers + watcher; events after stop do not push", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "cs-test-autosync-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const { engine, pushCount } = makeControllableEngine();
    const auto = new AutoSync(
      engine,
      configWith(home, { enabled: true, debounceMs: 10, pullIntervalMs: 25 }),
    );
    await auto.start();
    await sleep(SUPPRESS_WINDOW_MS);
    const w = watcherOf(auto);
    // stop 전에 debounce 예약을 걸어두고, stop 이 이를 취소하는지 본다.
    w.emit("add", path.join(home, ".claude", "pending.md"));
    await auto.stop();
    // stop 후 내부 핸들 정리 확인.
    assert.strictEqual(
      (auto as unknown as { watcher: unknown }).watcher,
      null,
      "watcher nulled after stop",
    );
    assert.strictEqual(
      (auto as unknown as { pullTimer: unknown }).pullTimer,
      null,
      "pullTimer cleared after stop",
    );
    assert.strictEqual(
      (auto as unknown as { debounceTimer: unknown }).debounceTimer,
      null,
      "debounceTimer cleared after stop",
    );
    const pushesAtStop = pushCount();
    // stop 이후 충분히 기다려도 추가 push/타이머 실행이 없어야 한다(클린 종료).
    await sleep(SUPPRESS_WINDOW_MS + 60);
    assert.equal(
      pushCount(),
      pushesAtStop,
      "no push fires after stop (debounce cancelled, timers cleared)",
    );
    rmSync(home, { recursive: true, force: true });
  });
});
