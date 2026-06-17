// SingleInstanceLock — 머신당 데몬 단일 인스턴스 보장 + MCP 의 라이브 데몬 감지.
// 락 파일은 holder 메타(pid/hostname/타임스탬프)를 담는다.
// 탈취 조건: pid 사망(ESRCH) | 호스트명 불일치 | heartbeat stale(ttl 초과) | 손상.
// 쓰기는 engine.ts 의 원자적 tmp→fsync→rename 패턴을 미러링한다.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Logger } from "../types.js";

export interface LockPayload {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  hostname: string;
}

export interface SingleInstanceLockOptions {
  ttlMs?: number;
  logger?: Logger;
}

const DEFAULT_TTL_MS = 120_000;

// 원자적 tmp 파일명 충돌 회피용 시퀀스(엔진과 동일 전략).
let atomicWriteSeq = 0;

export class SingleInstanceLock {
  private readonly lockPath: string;
  private readonly ttlMs: number;
  private readonly logger: Logger | undefined;
  private readonly hostname: string;

  constructor(lockPath: string, opts?: SingleInstanceLockOptions) {
    this.lockPath = lockPath;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = opts?.logger;
    this.hostname = os.hostname();
  }

  /** 락 획득. true=획득(또는 탈취), false=라이브 데몬이 이미 점유 중. */
  async acquire(): Promise<boolean> {
    const dir = path.dirname(this.lockPath);
    await fs.mkdir(dir, { recursive: true });

    // 1) wx 배타 생성 시도. 성공 시 우리가 최초 holder.
    try {
      const fh = await fs.open(this.lockPath, "wx");
      await fh.close();
      await this.writePayload(this.makePayload());
      this.logger?.debug("single-instance: 락 획득(신규)", { path: this.lockPath });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // 2) 이미 존재 → 기존 holder 검사.
    const existing = await this.read();
    if (existing !== null && this.isLive(existing)) {
      this.logger?.debug("single-instance: 라이브 holder 점유 중", {
        pid: existing.pid,
        hostname: existing.hostname,
      });
      return false;
    }

    // 3) 손상 | 사망 | 호스트 불일치 | stale → 탈취(덮어쓰기).
    await this.writePayload(this.makePayload());
    this.logger?.info("single-instance: 락 탈취(reclaim)", { path: this.lockPath });
    return true;
  }

  /** heartbeatAt 을 현재 시각으로 원자적 갱신. 소유자가 아니면 no-op. */
  async heartbeat(): Promise<void> {
    const current = await this.read();
    if (current === null || !this.isSelf(current)) return;
    await this.writePayload({ ...current, heartbeatAt: new Date().toISOString() });
  }

  /** 자기 소유(pid+hostname 일치)일 때만 락 파일 삭제. */
  async release(): Promise<void> {
    const current = await this.read();
    if (current === null || !this.isSelf(current)) return;
    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** 현재 holder payload 파싱. 없거나 손상 시 null. */
  async read(): Promise<LockPayload | null> {
    let text: string;
    try {
      text = await fs.readFile(this.lockPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return this.parse(text);
  }

  /** stale 하지 않은 라이브 holder 존재 여부(MCP 감지용). */
  async isHeld(): Promise<boolean> {
    const current = await this.read();
    return current !== null && this.isLive(current);
  }

  // ── 내부 ────────────────────────────────────────────────────

  private makePayload(): LockPayload {
    const now = new Date().toISOString();
    return {
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      hostname: this.hostname,
    };
  }

  /** 자기 자신(이 프로세스)이 소유한 락인지. */
  private isSelf(p: LockPayload): boolean {
    return p.pid === process.pid && p.hostname === this.hostname;
  }

  /** holder 가 살아있고 신선한지(=탈취 불가). */
  private isLive(p: LockPayload): boolean {
    // 다른 호스트면 pid 비교가 무의미 → 라이브로 보지 않음(탈취 가능).
    if (p.hostname !== this.hostname) return false;
    // stale: heartbeat 이 ttl 초과.
    const hb = Date.parse(p.heartbeatAt);
    if (Number.isNaN(hb) || Date.now() - hb > this.ttlMs) return false;
    // pid 생존 확인.
    return this.isPidAlive(p.pid);
  }

  /** process.kill(pid,0): ESRCH=사망, EPERM=생존(권한만 없음). */
  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      return false;
    }
  }

  private parse(text: string): LockPayload | null {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    if (obj === null || typeof obj !== "object") return null;
    const p = obj as Record<string, unknown>;
    if (
      typeof p["pid"] !== "number" ||
      typeof p["startedAt"] !== "string" ||
      typeof p["heartbeatAt"] !== "string" ||
      typeof p["hostname"] !== "string"
    ) {
      return null;
    }
    return {
      pid: p["pid"],
      startedAt: p["startedAt"],
      heartbeatAt: p["heartbeatAt"],
      hostname: p["hostname"],
    };
  }

  /** 원자적 쓰기: 같은 디렉터리에 tmp 작성 → fsync → rename. (engine.ts 미러) */
  private async writePayload(payload: LockPayload): Promise<void> {
    const dir = path.dirname(this.lockPath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify(payload);
    const tmpPath = path.join(
      dir,
      `.${path.basename(this.lockPath)}.tmp.${process.pid}.${atomicWriteSeq++}`,
    );
    // 임시파일에 쓰고 fsync 후 rename → 전원손실/크래시 시 0바이트/부분파일 방지.
    const fh = await fs.open(tmpPath, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, this.lockPath);
    // 부모 디렉터리 fsync 로 rename 영속화. 일부 FS/Windows 는 미지원 → best-effort.
    try {
      const dh = await fs.open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // 디렉터리 fsync 미지원 — 무시.
    }
  }
}
