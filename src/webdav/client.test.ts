import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { RemoteStore, PreconditionFailedError } from "./client.js";
import type { RemoteConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 인프로세스 최소 WebDAV 서버 (127.0.0.1, node:http) — 외부 네트워크 없음.
// RemoteStore 는 `webdav` 패키지의 createClient 로 실제 HTTP 클라이언트를 만든다.
// 주입 가능한 클라이언트 seam 이 없으므로 실제 WebDAV 프로토콜을 말하는 서버를 띄운다.
// 지원: GET / PUT / DELETE / PROPFIND / MKCOL / MOVE + ETag / If-Match / If-None-Match.
// ---------------------------------------------------------------------------

interface StoredFile {
  body: Buffer;
  etag: string;
  type: "file" | "directory";
}

let etagSeq = 0;
function nextEtag(): string {
  return `"etag-${++etagSeq}"`;
}

// PROPFIND 응답 1개 항목 XML (멀티스테이터스 response 엘리먼트).
function propResponse(href: string, entry: StoredFile): string {
  const resourcetype =
    entry.type === "directory" ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>";
  const etagTag = entry.etag ? `<D:getetag>${entry.etag}</D:getetag>` : "";
  const lenTag =
    entry.type === "file" ? `<D:getcontentlength>${entry.body.length}</D:getcontentlength>` : "";
  return (
    `<D:response>` +
    `<D:href>${href}</D:href>` +
    `<D:propstat>` +
    `<D:prop>` +
    resourcetype +
    lenTag +
    etagTag +
    `<D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>` +
    `</D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status>` +
    `</D:propstat>` +
    `</D:response>`
  );
}

function multistatus(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`;
}

interface ServerHandle {
  baseUrl: string;
  store: Map<string, StoredFile>;
  close(): Promise<void>;
  // 마지막 요청 헤더 기록(검증용).
  lastHeaders: http.IncomingHttpHeaders | null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 경로 정규화: 트레일링 슬래시 제거(루트 제외). 디코딩 포함.
function normKey(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  if (decoded.length > 1 && decoded.endsWith("/")) return decoded.slice(0, -1);
  return decoded;
}

async function startServer(): Promise<ServerHandle> {
  const store = new Map<string, StoredFile>();
  const handle: ServerHandle = {
    baseUrl: "",
    store,
    lastHeaders: null,
    close: async () => {},
  };

  const server = http.createServer(async (req, res) => {
    handle.lastHeaders = req.headers;
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const key = normKey(url.pathname);
    const body = await readBody(req);

    const send = (status: number, payload?: string | Buffer, headers?: Record<string, string>) => {
      res.writeHead(status, headers ?? {});
      res.end(payload ?? "");
    };

    if (method === "PROPFIND") {
      const depth = (req.headers["depth"] as string) ?? "0";
      const entry = store.get(key);
      if (!entry) {
        send(404);
        return;
      }
      if (depth === "0") {
        send(207, multistatus(propResponse(url.pathname, entry)), {
          "Content-Type": "application/xml; charset=utf-8",
        });
        return;
      }
      // Depth:1 — 디렉터리 자기 자신 + 직속 자식.
      const dirPrefix = key === "/" ? "/" : key + "/";
      let inner = propResponse(url.pathname, entry);
      for (const [childKey, childEntry] of store) {
        if (childKey === key) continue;
        if (!childKey.startsWith(dirPrefix)) continue;
        const rest = childKey.slice(dirPrefix.length);
        if (rest.includes("/")) continue; // 직속 자식만
        inner += propResponse(childKey, childEntry);
      }
      send(207, multistatus(inner), { "Content-Type": "application/xml; charset=utf-8" });
      return;
    }

    if (method === "GET") {
      const entry = store.get(key);
      if (!entry || entry.type === "directory") {
        send(404);
        return;
      }
      send(200, entry.body, { ETag: entry.etag, "Content-Type": "application/octet-stream" });
      return;
    }

    if (method === "PUT") {
      const existing = store.get(key);
      const ifMatch = req.headers["if-match"] as string | undefined;
      const ifNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (ifNoneMatch === "*" && existing) {
        send(412);
        return;
      }
      if (ifMatch !== undefined) {
        if (!existing || existing.etag !== ifMatch) {
          send(412);
          return;
        }
      }
      const etag = nextEtag();
      store.set(key, { body, etag, type: "file" });
      send(existing ? 204 : 201, undefined, { ETag: etag });
      return;
    }

    if (method === "DELETE") {
      if (!store.has(key)) {
        send(404);
        return;
      }
      store.delete(key);
      send(204);
      return;
    }

    if (method === "MKCOL") {
      if (store.has(key)) {
        send(405); // already exists
        return;
      }
      store.set(key, { body: Buffer.alloc(0), etag: nextEtag(), type: "directory" });
      send(201);
      return;
    }

    if (method === "MOVE") {
      const dest = req.headers["destination"] as string | undefined;
      const overwrite = (req.headers["overwrite"] as string | undefined) ?? "T";
      const entry = store.get(key);
      if (!entry) {
        send(404);
        return;
      }
      const destKey = dest ? normKey(new URL(dest).pathname) : "";
      if (!destKey) {
        send(400);
        return;
      }
      const destExisted = store.has(destKey);
      if (destExisted && overwrite === "F") {
        send(412);
        return;
      }
      store.delete(key);
      store.set(destKey, { ...entry, etag: nextEtag() });
      send(destExisted ? 204 : 201);
      return;
    }

    send(405);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  handle.baseUrl = `http://127.0.0.1:${addr.port}`;
  handle.close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return handle;
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const BASE_DIR = "/dav";

function makeStore(server: ServerHandle): RemoteStore {
  const config: RemoteConfig = {
    url: server.baseUrl,
    username: "",
    password: "",
    remoteBaseDir: BASE_DIR,
  };
  return new RemoteStore(config);
}

// 서버 store 에 직접 파일을 심는다(원격 사전 상태 위조용).
function seedFile(server: ServerHandle, key: string, body: string): string {
  const etag = nextEtag();
  server.store.set(key, { body: Buffer.from(body), etag, type: "file" });
  return etag;
}

// ---------------------------------------------------------------------------
// describe: RemoteStore — put/get 라운드트립
// ---------------------------------------------------------------------------

describe("RemoteStore put/get roundtrip", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("put(text) -> getText 라운드트립", async () => {
    await store.put("notes.txt", "hello world");
    const got = await store.getText("notes.txt");
    assert.equal(got, "hello world");
    // baseDir 기준으로 저장되었는지 확인.
    assert.ok(server.store.has("/dav/notes.txt"));
  });

  test("put(buffer) -> getBinary 라운드트립", async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await store.put("blob.bin", data);
    const got = await store.getBinary("blob.bin");
    assert.ok(Buffer.isBuffer(got));
    assert.deepEqual(got, data);
  });

  test("getTextIfExists: 없으면 null, 있으면 본문", async () => {
    assert.equal(await store.getTextIfExists("missing.txt"), null);
    await store.put("present.txt", "yo");
    assert.equal(await store.getTextIfExists("present.txt"), "yo");
  });

  test("getText: 부재 시 throw (404 그대로 전파)", async () => {
    await assert.rejects(
      () => store.getText("nope.txt"),
      (err: unknown) => (err as { status?: number }).status === 404,
    );
  });

  test("getTextWithETag: 부재 시 null, 존재 시 본문 + ETag 전파", async () => {
    assert.equal(await store.getTextWithETag("absent.txt"), null);
    await store.put("withtag.txt", "body-here");
    const res = await store.getTextWithETag("withtag.txt");
    assert.ok(res);
    assert.equal(res!.text, "body-here");
    // 서버가 GET 응답에 ETag 헤더를 주므로 propagate 되어야 한다.
    assert.ok(typeof res!.etag === "string" && res!.etag!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// describe: exists / deleteFile
// ---------------------------------------------------------------------------

describe("RemoteStore exists / deleteFile", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("exists: 없으면 false, 있으면 true", async () => {
    assert.equal(await store.exists("ghost.txt"), false);
    await store.put("real.txt", "x");
    assert.equal(await store.exists("real.txt"), true);
  });

  test("deleteFile: 존재 파일 삭제 후 exists=false", async () => {
    await store.put("temp.txt", "data");
    assert.equal(await store.exists("temp.txt"), true);
    await store.deleteFile("temp.txt");
    assert.equal(await store.exists("temp.txt"), false);
  });

  test("deleteFile: 없는 파일은 멱등(throw 안 함)", async () => {
    await store.deleteFile("never-existed.txt");
    assert.equal(await store.exists("never-existed.txt"), false);
  });
});

// ---------------------------------------------------------------------------
// describe: ensureDir (MKCOL) 멱등성
// ---------------------------------------------------------------------------

describe("RemoteStore ensureDir", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("ensureDir: 디렉터리 생성", async () => {
    await store.ensureDir("sub");
    assert.equal(server.store.get("/dav/sub")?.type, "directory");
  });

  test("ensureDir: 이미 존재해도 멱등(에러 흡수)", async () => {
    await store.ensureDir("sub");
    // 두 번째 호출 — exists 체크 후 createDirectory skip, 또는 MKCOL 405 흡수.
    await store.ensureDir("sub");
    assert.equal(server.store.get("/dav/sub")?.type, "directory");
  });
});

// ---------------------------------------------------------------------------
// describe: list (PROPFIND Depth:1)
// ---------------------------------------------------------------------------

describe("RemoteStore list", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("list: 디렉터리 직속 자식 열거(자기 자신 제외)", async () => {
    server.store.set("/dav/dir", { body: Buffer.alloc(0), etag: nextEtag(), type: "directory" });
    seedFile(server, "/dav/dir/a.txt", "A");
    seedFile(server, "/dav/dir/b.txt", "B");
    // 손자(깊은 경로)는 Depth:1 에서 제외되어야 한다.
    server.store.set("/dav/dir/nested", {
      body: Buffer.alloc(0),
      etag: nextEtag(),
      type: "directory",
    });
    seedFile(server, "/dav/dir/nested/deep.txt", "D");

    const entries = await store.list("dir");
    const names = entries.map((e) => e.basename).sort();
    assert.deepEqual(names, ["a.txt", "b.txt", "nested"]);
    const file = entries.find((e) => e.basename === "a.txt");
    assert.equal(file?.type, "file");
    const dir = entries.find((e) => e.basename === "nested");
    assert.equal(dir?.type, "directory");
  });

  test("list: 디렉터리 부재(404)면 빈 배열", async () => {
    const entries = await store.list("does-not-exist");
    assert.deepEqual(entries, []);
  });
});

// ---------------------------------------------------------------------------
// describe: putAtomic (PUT tmp + MOVE)
// ---------------------------------------------------------------------------

describe("RemoteStore putAtomic", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("putAtomic: tmp 업로드 후 최종 경로로 이동, tmp 잔존 없음", async () => {
    await store.putAtomic("final.txt", "payload", "machine-1");
    assert.equal(await store.getText("final.txt"), "payload");
    // tmp orphan 이 남지 않아야 한다.
    const tmpKeys = [...server.store.keys()].filter((k) => k.includes(".tmp."));
    assert.deepEqual(tmpKeys, []);
  });
});

// ---------------------------------------------------------------------------
// describe: CAS — putIfNoneMatch (원자적 생성)
// ---------------------------------------------------------------------------

describe("RemoteStore putIfNoneMatch (CAS create)", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("부재 시 생성 성공", async () => {
    await store.putIfNoneMatch("lock.json", "{}", "machine-1");
    assert.equal(await store.getText("lock.json"), "{}");
  });

  test("이미 존재하면 412 -> PreconditionFailedError", async () => {
    seedFile(server, "/dav/lock.json", "existing");
    await assert.rejects(
      () => store.putIfNoneMatch("lock.json", "new", "machine-2"),
      (err: unknown) => {
        assert.ok(err instanceof PreconditionFailedError);
        assert.equal((err as PreconditionFailedError).status, 412);
        return true;
      },
    );
    // 기존 본문은 그대로여야 한다.
    assert.equal(await store.getText("lock.json"), "existing");
  });
});

// ---------------------------------------------------------------------------
// describe: CAS — putIfMatch (조건부 업데이트)
// ---------------------------------------------------------------------------

describe("RemoteStore putIfMatch (CAS update)", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("ETag 일치 시 업데이트 성공", async () => {
    const etag = seedFile(server, "/dav/lock.json", "v1");
    await store.putIfMatch("lock.json", "v2", etag, "machine-1");
    assert.equal(await store.getText("lock.json"), "v2");
  });

  test("ETag 불일치 시 412 -> PreconditionFailedError", async () => {
    seedFile(server, "/dav/lock.json", "v1");
    await assert.rejects(
      () => store.putIfMatch("lock.json", "v2", '"stale-etag"', "machine-1"),
      (err: unknown) => {
        assert.ok(err instanceof PreconditionFailedError);
        assert.equal((err as PreconditionFailedError).status, 412);
        return true;
      },
    );
    // 불일치이므로 본문은 변하지 않아야 한다.
    assert.equal(await store.getText("lock.json"), "v1");
  });

  test("etag=null 이면 best-effort PUT 으로 폴백(무조건 덮어씀)", async () => {
    seedFile(server, "/dav/lock.json", "v1");
    await store.putIfMatch("lock.json", "forced", null, "machine-1");
    assert.equal(await store.getText("lock.json"), "forced");
  });

  test("getTextWithETag 로 받은 ETag 로 라운드트립 CAS", async () => {
    await store.put("doc.json", "init");
    const read = await store.getTextWithETag("doc.json");
    assert.ok(read && read.etag);
    // 받은 ETag 로 업데이트 → 성공해야 한다.
    await store.putIfMatch("doc.json", "updated", read!.etag, "machine-1");
    assert.equal(await store.getText("doc.json"), "updated");
    // 이전(stale) ETag 로 다시 시도 → 412.
    await assert.rejects(
      () => store.putIfMatch("doc.json", "again", read!.etag, "machine-1"),
      (err: unknown) => err instanceof PreconditionFailedError,
    );
  });
});

// ---------------------------------------------------------------------------
// describe: moveFile (외부 사용)
// ---------------------------------------------------------------------------

describe("RemoteStore moveFile", () => {
  let server: ServerHandle;
  let store: RemoteStore;

  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.store.clear();
    store = makeStore(server);
  });

  test("moveFile: 소스 -> 대상 이동", async () => {
    await store.put("src.txt", "moved-body");
    await store.moveFile("src.txt", "dst.txt");
    assert.equal(await store.exists("src.txt"), false);
    assert.equal(await store.getText("dst.txt"), "moved-body");
  });
});
