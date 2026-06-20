// Self-contained in-memory WebDAV server for wormhole e2e tests.
//
// No external deps (node:http + node:crypto only). Mirrors exactly the subset of
// WebDAV that wormhole's RemoteStore (src/webdav/client.ts) drives through the
// `webdav` npm client:
//
//   RemoteStore method      webdav client op              HTTP here
//   ─────────────────────   ───────────────────────────   ─────────────────────────
//   ensureDir               createDirectory(recursive)    PROPFIND d0 (probe) + MKCOL
//   exists / getTextIfExists exists -> getStat            PROPFIND d0  (404 if absent)
//   putAtomic               putFileContents + moveFile    PUT (tmp) + MOVE
//   put                     putFileContents               PUT
//   getText / getTextWithETag getFileContents(text,det)   GET  (ETag header)
//   getBinary               getFileContents(binary)       GET
//   putIfMatch              customRequest If-Match         PUT  (412 on mismatch)
//   putIfNoneMatch          customRequest If-None-Match:*  PUT  (412 if exists)
//   list                    getDirectoryContents          PROPFIND d1 (207)
//   deleteFile              exists + deleteFile            PROPFIND d0 + DELETE
//
// Storage is a flat Map<path, {body:Buffer, etag, type:'file'|'collection', mtime}>.
// ETags are strong, derived from a content hash (so identical content keeps a
// stable etag, and any change rotates it). PROPFIND returns RFC4918 207
// multistatus XML that fast-xml-parser (removeNSPrefix:true) inside the webdav
// client parses for `resourcetype` (collection vs file), `getcontentlength`,
// `getetag`, etc.
//
// start(port?) -> { url, port, close(), store } ; binds 127.0.0.1, ephemeral port
// when none given.

import http from "node:http";
import crypto from "node:crypto";

const TEXT_XML = "application/xml; charset=utf-8";

function strongEtag(body) {
  const h = crypto.createHash("sha256").update(body).digest("hex").slice(0, 24);
  return `"${h}"`;
}

function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Collapse "//" and strip trailing "/" (except root). Decode %xx so stored keys
// match what later GET/PROPFIND requests resolve to.
function normalizePath(raw) {
  let p = decodeURIComponent(raw.split("?")[0]);
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") p = "/";
  return p;
}

function parentDirs(p) {
  // All ancestor collection paths of p (excluding p itself), shallow->deep.
  const segs = p.split("/").filter(Boolean);
  const out = [];
  let cur = "";
  for (let i = 0; i < segs.length - 0; i++) {
    cur += "/" + segs[i];
    out.push(cur);
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Build a single <response> block for a stored entry.
function responseXml(href, entry) {
  const isDir = entry.type === "collection";
  const resourcetype = isDir ? "<d:collection/>" : "";
  const sizeProp = isDir
    ? ""
    : `<d:getcontentlength>${entry.body.length}</d:getcontentlength>` +
      `<d:getcontenttype>application/octet-stream</d:getcontenttype>`;
  const etagProp = isDir ? "" : `<d:getetag>${xmlEscape(entry.etag)}</d:getetag>`;
  const lastmod = new Date(entry.mtime).toUTCString();
  // Directory hrefs get a trailing slash (collections), matching real servers.
  const outHref = isDir && href !== "/" ? `${href}/` : href;
  return (
    `<d:response>` +
    `<d:href>${xmlEscape(outHref)}</d:href>` +
    `<d:propstat>` +
    `<d:prop>` +
    `<d:resourcetype>${resourcetype}</d:resourcetype>` +
    `<d:getlastmodified>${lastmod}</d:getlastmodified>` +
    sizeProp +
    etagProp +
    `</d:prop>` +
    `<d:status>HTTP/1.1 200 OK</d:status>` +
    `</d:propstat>` +
    `</d:response>`
  );
}

export function start(port) {
  // path -> { body:Buffer, etag, type:'file'|'collection', mtime }
  const store = new Map();
  // Root is always a collection.
  store.set("/", { body: Buffer.alloc(0), etag: '"root"', type: "collection", mtime: Date.now() });

  function ensureCollection(p) {
    if (!store.has(p)) {
      store.set(p, { body: Buffer.alloc(0), etag: `"col-${p}"`, type: "collection", mtime: Date.now() });
    }
  }

  function setFile(p, body) {
    // Materialize any missing ancestor collections (mirrors a server that
    // already had MKCOL run for them; tolerant if a client PUTs deep).
    for (const d of parentDirs(p).slice(0, -1)) ensureCollection(d);
    store.set(p, { body, etag: strongEtag(body), type: "file", mtime: Date.now() });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`harness error: ${err && err.message ? err.message : String(err)}`);
    });
  });

  async function handle(req, res) {
    const method = (req.method || "GET").toUpperCase();
    const p = normalizePath(req.url || "/");
    const entry = store.get(p);

    switch (method) {
      case "PROPFIND": {
        const depth = (req.headers["depth"] ?? "0").toString();
        if (!entry) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        const responses = [responseXml(p, entry)];
        if (depth === "1" && entry.type === "collection") {
          const prefix = p === "/" ? "/" : p + "/";
          for (const [key, child] of store) {
            if (key === p || key === "/") continue;
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            if (rest.includes("/")) continue; // only immediate children
            responses.push(responseXml(key, child));
          }
        }
        const xml =
          `<?xml version="1.0" encoding="utf-8"?>` +
          `<d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;
        res.writeHead(207, { "Content-Type": TEXT_XML });
        res.end(xml);
        return;
      }

      case "MKCOL": {
        if (entry) {
          // Already exists -> 405 (RFC4918 9.3.1).
          res.writeHead(405, { Allow: "GET,HEAD,PUT,DELETE,PROPFIND" });
          res.end("Method Not Allowed (collection exists)");
          return;
        }
        ensureCollection(p);
        res.writeHead(201);
        res.end();
        return;
      }

      case "HEAD": {
        if (!entry || entry.type === "collection") {
          res.writeHead(entry ? 200 : 404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Length": String(entry.body.length),
          ETag: entry.etag,
          "Content-Type": "application/octet-stream",
        });
        res.end();
        return;
      }

      case "GET": {
        if (!entry || entry.type === "collection") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        res.writeHead(200, {
          "Content-Length": String(entry.body.length),
          ETag: entry.etag,
          "Content-Type": "application/octet-stream",
        });
        res.end(entry.body);
        return;
      }

      case "PUT": {
        const body = await readBody(req);
        const ifMatch = req.headers["if-match"];
        const ifNoneMatch = req.headers["if-none-match"];

        // If-None-Match: * -> create only if absent.
        if (ifNoneMatch !== undefined) {
          const v = ifNoneMatch.toString().trim();
          if (v === "*" && entry && entry.type === "file") {
            res.writeHead(412, { "Content-Type": "text/plain" });
            res.end("Precondition Failed (exists)");
            return;
          }
        }

        // If-Match: <etag> -> overwrite only if current etag matches (strong).
        if (ifMatch !== undefined) {
          const want = ifMatch.toString().trim();
          const have = entry && entry.type === "file" ? entry.etag : null;
          // Strong comparison; a "*" If-Match means "must exist".
          const ok = want === "*" ? have !== null : have !== null && have === want;
          if (!ok) {
            res.writeHead(412, { "Content-Type": "text/plain" });
            res.end("Precondition Failed (If-Match)");
            return;
          }
        }

        const created = !entry || entry.type !== "file";
        setFile(p, body);
        res.writeHead(created ? 201 : 204, { ETag: store.get(p).etag });
        res.end();
        return;
      }

      case "MOVE": {
        if (!entry) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        const dest = req.headers["destination"];
        if (!dest) {
          res.writeHead(400);
          res.end("Missing Destination");
          return;
        }
        // Destination is an absolute URL; reduce to a path.
        let destPath;
        try {
          destPath = normalizePath(new URL(dest.toString()).pathname);
        } catch {
          destPath = normalizePath(dest.toString());
        }
        const overwrite = (req.headers["overwrite"] ?? "T").toString().toUpperCase() !== "F";
        const destExists = store.get(destPath)?.type === "file";
        if (destExists && !overwrite) {
          res.writeHead(412);
          res.end("Precondition Failed (overwrite=F)");
          return;
        }
        store.delete(p);
        setFile(destPath, entry.body);
        res.writeHead(destExists ? 204 : 201);
        res.end();
        return;
      }

      case "DELETE": {
        if (!entry) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        // Delete the entry and (if a collection) everything under it.
        if (entry.type === "collection") {
          const prefix = p === "/" ? "/" : p + "/";
          for (const key of [...store.keys()]) {
            if (key === p || key.startsWith(prefix)) store.delete(key);
          }
        } else {
          store.delete(p);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      case "OPTIONS": {
        res.writeHead(200, {
          Allow: "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,PROPFIND",
          DAV: "1,2",
        });
        res.end();
        return;
      }

      default: {
        res.writeHead(405, { Allow: "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,PROPFIND" });
        res.end("Method Not Allowed");
      }
    }
  }

  return new Promise((resolve) => {
    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://127.0.0.1:${boundPort}`;
      resolve({
        url,
        port: boundPort,
        store,
        close: () =>
          new Promise((res2) => {
            server.close(() => res2());
          }),
      });
    });
  });
}

// Allow `node test/webdav-harness.mjs` to spin up an ad-hoc server for manual poking.
if (import.meta.url === `file://${process.argv[1]}`) {
  start().then((h) => {
    console.log(`webdav-harness listening at ${h.url}`);
  });
}
