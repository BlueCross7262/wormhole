import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "completed" | "failed";

export interface JobRecord {
  jobId: string;
  kind: "push" | "pull";
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  result: unknown | null;
  error: string | null;
}

// 비동기 sync job 추적(인메모리 싱글톤). MCP stdio 핸들러가 장시간 블로킹되지 않도록
// async=true 요청 시 작업을 백그라운드로 돌리고 jobId 로 상태를 폴링하게 한다.
class JobManager {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #maxJobs = 100;

  // run 을 백그라운드 실행하고 job 레코드를 즉시 반환(응답 비블로킹).
  start(kind: "push" | "pull", run: () => Promise<unknown>): JobRecord {
    const jobId = randomUUID();
    const rec: JobRecord = {
      jobId,
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    this.#jobs.set(jobId, rec);
    this.#prune();
    void run().then(
      (r) => {
        rec.status = "completed";
        rec.result = r;
        rec.finishedAt = new Date().toISOString();
      },
      (e) => {
        rec.status = "failed";
        rec.error = String((e as Error).message);
        rec.finishedAt = new Date().toISOString();
      },
    );
    return rec;
  }

  get(jobId: string): JobRecord | null {
    return this.#jobs.get(jobId) ?? null;
  }

  list(): JobRecord[] {
    return [...this.#jobs.values()];
  }

  // 완료/실패한 오래된 job 부터 정리(running 은 보존).
  #prune(): void {
    if (this.#jobs.size <= this.#maxJobs) return;
    const done = [...this.#jobs.values()]
      .filter((j) => j.status !== "running")
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    while (this.#jobs.size > this.#maxJobs && done.length > 0) {
      this.#jobs.delete(done.shift()!.jobId);
    }
  }
}

export const jobManager = new JobManager();
