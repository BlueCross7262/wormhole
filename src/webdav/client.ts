import { createClient, type WebDAVClient } from "webdav";
import type { RemoteConfig, RemoteEntry, Logger } from "../types.js";

/**
 * 조건부 PUT(If-Match / If-None-Match) 실패 시 throw.
 * 서버가 412 Precondition Failed(또는 405/409 등 동등 응답)를 반환했을 때,
 * 즉 "기대한 ETag 와 현재 리소스가 불일치" 또는 "이미 존재함"을 의미한다.
 */
export class PreconditionFailedError extends Error {
  /** 서버가 반환한 HTTP 상태 코드(412/405/409 등). */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PreconditionFailedError";
    this.status = status;
  }
}

// putAtomic tmp 파일명 충돌 방지용 모듈 카운터.
// 같은 ms 에 동일 머신이 여러 번 putAtomic 해도 tmp 경로가 고유하게 유지된다.
let atomicTmpCounter = 0;

// 에러 객체에서 HTTP 상태 코드 추출(webdav 는 err.status, 일부는 err.response.status).
function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

export class RemoteStore {
  private readonly client: WebDAVClient;
  private readonly baseDir: string;
  private readonly logger?: Logger;

  constructor(config: RemoteConfig, logger?: Logger) {
    this.client = createClient(config.url, {
      username: config.username,
      password: config.password,
    });
    this.baseDir = config.remoteBaseDir;
    this.logger = logger;
    // 자격 누락 경고 — 익명 WebDAV 가 아니면 원격 작업이 401 로 실패한다.
    if (config.username === "" && config.password === "") {
      this.logger?.warn(
        "[RemoteStore] WebDAV 자격(username/password) 미설정 — 익명 접근으로 시도. 인증 서버면 원격 작업이 401 로 실패함",
      );
    }
  }

  // 경로를 baseDir 기준으로 결합. 절대경로면 그대로, 아니면 baseDir 접두.
  private resolvePath(path: string): string {
    if (path.startsWith("/") && !path.startsWith(this.baseDir)) {
      return path;
    }
    if (path.startsWith(this.baseDir)) {
      return path;
    }
    return `${this.baseDir}/${path}`.replace(/\/+/g, "/");
  }

  // 디렉터리 보장(recursive). 이미 있으면 no-op.
  async ensureDir(path: string): Promise<void> {
    const resolved = this.resolvePath(path);
    try {
      const exists = await this.client.exists(resolved);
      if (!exists) {
        await this.client.createDirectory(resolved, { recursive: true });
        this.logger?.debug(`[RemoteStore] 디렉터리 생성: ${resolved}`);
      }
    } catch (err) {
      this.logger?.warn(`[RemoteStore] ensureDir 실패, 무시: ${resolved}`, err);
    }
  }

  // 파일/디렉터리 존재 여부.
  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path);
    try {
      return await this.client.exists(resolved);
    } catch {
      return false;
    }
  }

  // 원자적 업로드: tmp 파일에 쓴 후 최종 경로로 이동.
  // 원자적 업로드: tmp 파일에 쓴 후 최종 경로로 이동.
  // tmp 이름에 머신ID + 모듈 카운터를 붙여 동시/연속 호출 간 충돌을 방지한다.
  // moveFile 실패 시 남은 tmp(orphan)를 삭제한 뒤 원인 에러를 재throw.
  async putAtomic(path: string, data: string | Buffer, machineId: string): Promise<void> {
    const resolved = this.resolvePath(path);
    const token = `${machineId}.${atomicTmpCounter++}`;
    const tmpPath = `${resolved}.tmp.${token}`;

    await this.client.putFileContents(tmpPath, data, { overwrite: true });
    this.logger?.debug(`[RemoteStore] tmp 업로드 완료: ${tmpPath}`);

    try {
      await this.client.moveFile(tmpPath, resolved);
      this.logger?.debug(`[RemoteStore] 원자적 이동 완료: ${resolved}`);
    } catch (err) {
      // 이동 실패 → orphan tmp 정리 후 원인 재throw. 정리 실패는 흡수(원인 에러 우선).
      try {
        await this.client.deleteFile(tmpPath);
        this.logger?.debug(`[RemoteStore] 이동 실패, orphan tmp 정리: ${tmpPath}`);
      } catch (cleanupErr) {
        this.logger?.warn(`[RemoteStore] orphan tmp 정리 실패: ${tmpPath}`, cleanupErr);
      }
      throw err;
    }
  }

  // 단순 업로드(원자성 불필요한 경우: lock.json 등).
  async put(path: string, data: string | Buffer): Promise<void> {
    const resolved = this.resolvePath(path);
    await this.client.putFileContents(resolved, data, { overwrite: true });
    this.logger?.debug(`[RemoteStore] 업로드 완료: ${resolved}`);
  }

  // 텍스트로 읽기. 없으면 throw.
  async getText(path: string): Promise<string> {
    const resolved = this.resolvePath(path);
    const result = await this.client.getFileContents(resolved, { format: "text" });
    return result as string;
  }

  // 본문 + ETag 동시 회수. 없으면(404) null.
  // ETag 는 낙관적 잠금(조건부 PUT)에 사용. 서버가 ETag 를 안 주면 etag=null.
  async getTextWithETag(path: string): Promise<{ text: string; etag: string | null } | null> {
    const resolved = this.resolvePath(path);
    try {
      const result = (await this.client.getFileContents(resolved, {
        format: "text",
        details: true,
      })) as { data: string; headers: Record<string, string> };
      const headers = result.headers ?? {};
      // 헤더 키 대소문자 차이 대비(etag / ETag).
      const rawEtag = headers.etag ?? headers.ETag ?? headers.Etag ?? null;
      return { text: result.data, etag: rawEtag };
    } catch (err: unknown) {
      if (errorStatus(err) === 404) return null;
      throw err;
    }
  }

  // If-Match 조건부 PUT: 원격 리소스의 현재 ETag 가 expectedEtag 와 일치할 때만 덮어쓴다.
  // 서버측 원자 비교-후-쓰기(CAS)이므로 read→put 사이 경쟁이 끼어들 수 없다.
  // 불일치(412/405/409)면 PreconditionFailedError throw.
  // expectedEtag 가 null(서버가 ETag 미지원)이면 best-effort 로 무조건 PUT(경고 로깅).
  async putIfMatch(
    path: string,
    data: string | Buffer,
    etag: string | null,
    machineId: string,
  ): Promise<void> {
    const resolved = this.resolvePath(path);
    if (etag === null) {
      // ETag 미지원 폴백 — 진짜 CAS 불가, 일반 PUT 으로 대체.
      this.logger?.warn(
        `[RemoteStore] putIfMatch: ETag 없음(서버 미지원?) — best-effort PUT 으로 폴백: ${resolved} (machineId=${machineId})`,
      );
      await this.client.putFileContents(resolved, data, { overwrite: true });
      return;
    }
    try {
      await this.client.customRequest(resolved, {
        method: "PUT",
        headers: { "If-Match": etag },
        data,
      });
      this.logger?.debug(`[RemoteStore] putIfMatch 성공: ${resolved} (etag=${etag})`);
    } catch (err: unknown) {
      const status = errorStatus(err);
      if (status === 412 || status === 405 || status === 409) {
        throw new PreconditionFailedError(
          `If-Match 조건 실패(${status}): ${resolved} expected etag=${etag}`,
          status,
        );
      }
      throw err;
    }
  }

  // If-None-Match:* 조건부 PUT: 원격에 리소스가 "없을 때만" 생성한다.
  // 동시에 여러 머신이 생성을 시도해도 서버측에서 한쪽만 성공시킨다(원자적 생성).
  // 이미 존재(412/405/409)면 PreconditionFailedError throw.
  async putIfNoneMatch(path: string, data: string | Buffer, machineId: string): Promise<void> {
    const resolved = this.resolvePath(path);
    try {
      await this.client.customRequest(resolved, {
        method: "PUT",
        headers: { "If-None-Match": "*" },
        data,
      });
      this.logger?.debug(`[RemoteStore] putIfNoneMatch 성공: ${resolved} (machineId=${machineId})`);
    } catch (err: unknown) {
      const status = errorStatus(err);
      if (status === 412 || status === 405 || status === 409) {
        throw new PreconditionFailedError(
          `If-None-Match 조건 실패(${status}, 이미 존재): ${resolved}`,
          status,
        );
      }
      throw err;
    }
  }

  // 바이너리로 읽기.
  async getBinary(path: string): Promise<Buffer> {
    const resolved = this.resolvePath(path);
    const result = await this.client.getFileContents(resolved, { format: "binary" });
    return result as Buffer;
  }

  // 텍스트 읽되 없으면(404) null 반환.
  async getTextIfExists(path: string): Promise<string | null> {
    const resolved = this.resolvePath(path);
    try {
      const exists = await this.client.exists(resolved);
      if (!exists) return null;
      const result = await this.client.getFileContents(resolved, { format: "text" });
      return result as string;
    } catch (err: unknown) {
      const status = (err as { status?: number; response?: { status?: number } })?.status
        ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  // 디렉터리 항목 열거. 없거나 에러면 빈 배열.
  // 디렉터리 항목 열거. 디렉터리 부재(404)만 빈 배열, 그 외 에러(401/403/5xx)는 재throw.
  // 기존엔 catch{} 로 모든 에러를 빈 배열로 흡수해 인증/서버 오류를 "빈 디렉터리"로 오인했다.
  async list(path: string): Promise<RemoteEntry[]> {
    const resolved = this.resolvePath(path);
    try {
      const contents = await this.client.getDirectoryContents(resolved);
      const items = Array.isArray(contents) ? contents : (contents as { data: unknown[] }).data;

      return (items as Array<{ basename: string; filename: string; type: string }>)
        .filter((item) => item.basename !== "" && item.filename !== resolved)
        .map((item) => ({
          basename: item.basename,
          filename: item.filename,
          type: item.type === "directory" ? "directory" : "file",
        })) as RemoteEntry[];
    } catch (err: unknown) {
      // 디렉터리 부재만 빈 배열로 취급(멱등). 인증/서버 오류는 그대로 전파.
      if (errorStatus(err) === 404) return [];
      this.logger?.warn(`[RemoteStore] list 실패: ${resolved}`, err);
      throw err;
    }
  }

  // 파일 삭제. 없으면 무시(멱등).
  async deleteFile(path: string): Promise<void> {
    const resolved = this.resolvePath(path);
    try {
      const exists = await this.client.exists(resolved);
      if (!exists) return;
      await this.client.deleteFile(resolved);
      this.logger?.debug(`[RemoteStore] 파일 삭제: ${resolved}`);
    } catch (err: unknown) {
      const status = (err as { status?: number; response?: { status?: number } })?.status
        ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
      if (status === 404) return;
      throw err;
    }
  }

  // 파일 이동(putAtomic 내부 및 외부 사용).
  async moveFile(from: string, to: string): Promise<void> {
    const resolvedFrom = this.resolvePath(from);
    const resolvedTo = this.resolvePath(to);
    await this.client.moveFile(resolvedFrom, resolvedTo);
    this.logger?.debug(`[RemoteStore] 이동: ${resolvedFrom} -> ${resolvedTo}`);
  }
}
