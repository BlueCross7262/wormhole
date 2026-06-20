// End-to-end round-trip test against the REAL sync engine + a REAL local HTTP
// WebDAV server (test/webdav-harness.mjs). Run with: npm run test:e2e
//
// What this proves:
//   push (HOME A) -> gzip -> age-encrypt -> HTTP PUT/MOVE to harness
//   pull (HOME B) -> HTTP GET -> age-decrypt -> gunzip -> write local file
//   and that HOME B reconstructs HOME A's plaintext byte-for-byte.
//
// Approach — TWO HOMES, ONE REMOTE (the realistic multi-machine scenario):
//   - HOME A and HOME B are independent temp dirs with their OWN stateDir and
//     OWN derived-key cache, but point at the SAME harness URL and use the SAME
//     passphrase. The age key is derived deterministically from
//     passphrase + salt, and the salt lives REMOTELY in keyparams.json
//     (see src/crypto/keyparams.ts: ensureCryptoReady). HOME A bootstraps it on
//     first push; HOME B reads that same remote salt on pull and therefore
//     derives the IDENTICAL age key. This is exactly how two machines converge,
//     so no salt/keyparams juggling is needed across the two homes.
//   - buildEngine() reads config via loadConfig() with no args, which honors the
//     WORMHOLE_CONFIG / WEBDAV_URL / WORMHOLE_PASSPHRASE env vars. We set those
//     per-home before each buildEngine() call (the two engines run sequentially
//     in one process, so we just re-point the env between them).
//   - kdfN is set low in the config so scrypt is fast in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { start } from "./webdav-harness.mjs";
// tsx resolves the .js specifier to the .ts source.
import { buildEngine } from "../src/bootstrap.js";
import type { Logger } from "../src/types.js";

const PASSPHRASE = "e2e-test-passphrase-do-not-use-irl";
const CLAUDE_MD_CONTENT = [
  "# CLAUDE.md round-trip fixture",
  "",
  "Some unicode to exercise encoding: 한글 ✓ — éè",
  "Line three.",
  "",
].join("\n");
const SETTINGS_JSON_CONTENT = JSON.stringify(
  { theme: "dark", note: "round-trip fixture" },
  null,
  2,
);

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// Materialize a temp HOME with a .claude/ tree and a wormhole config.json that
// points stateDir under that home. Returns the paths the test needs.
function makeHome(label: string, remoteUrl: string, files: Record<string, string>) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `wormhole-e2e-${label}-`));
  const stateDir = path.join(homeDir, ".wormhole");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(homeDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const config = {
    home: homeDir,
    stateDir,
    remote: {
      url: remoteUrl,
      username: "",
      password: "",
      remoteBaseDir: "/wormhole",
    },
    crypto: {
      passphraseEnv: "WORMHOLE_PASSPHRASE",
      // Fast scrypt for tests (default is 2^16). Both homes MUST agree, but the
      // remote keyparams.json records the params used at bootstrap, so HOME B
      // inherits them from the remote regardless of its local config value.
      kdfN: 1024,
      kdfR: 8,
      kdfP: 1,
    },
    lock: { ttlMs: 30000, acquireRetries: 3, acquireRetryDelayMs: 50 },
  };
  const configPath = path.join(stateDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { homeDir, stateDir, configPath };
}

// Point the process env at a given home + remote, then build a fresh engine.
async function engineFor(remoteUrl: string, configPath: string) {
  process.env.WORMHOLE_CONFIG = configPath;
  process.env.WEBDAV_URL = remoteUrl;
  process.env.WORMHOLE_PASSPHRASE = PASSPHRASE;
  return buildEngine(silentLogger);
}

function rmrf(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test("e2e round-trip: push(HOME A) -> harness -> pull(HOME B) reconstructs plaintext", async (t) => {
  const harness = await start();

  // Snapshot env we mutate, restore on teardown.
  const savedEnv = {
    WORMHOLE_CONFIG: process.env.WORMHOLE_CONFIG,
    WEBDAV_URL: process.env.WEBDAV_URL,
    WEBDAV_BASEDIR: process.env.WEBDAV_BASEDIR,
    WORMHOLE_PASSPHRASE: process.env.WORMHOLE_PASSPHRASE,
  };
  // A stray WEBDAV_BASEDIR in the ambient env would override config.json.
  delete process.env.WEBDAV_BASEDIR;

  const homeA = makeHome("A", harness.url, {
    ".claude/CLAUDE.md": CLAUDE_MD_CONTENT,
    ".claude/settings.json": SETTINGS_JSON_CONTENT,
  });
  // HOME B starts with an EMPTY .claude tree — pull must create the files.
  const homeB = makeHome("B", harness.url, {});

  t.after(async () => {
    await harness.close();
    rmrf(homeA.homeDir);
    rmrf(homeB.homeDir);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── 1) PUSH from HOME A (real encrypt + upload to the harness) ──────────
  const a = await engineFor(harness.url, homeA.configPath);
  const pushRes = await a.engine.push();
  assert.equal(pushRes.dryRun, false, "push should be a real run");
  assert.ok(
    pushRes.pushed.includes(".claude/CLAUDE.md"),
    `expected CLAUDE.md in pushed set, got: ${JSON.stringify(pushRes.pushed)}`,
  );
  assert.ok(
    pushRes.pushed.includes(".claude/settings.json"),
    `expected settings.json in pushed set, got: ${JSON.stringify(pushRes.pushed)}`,
  );

  // Remote really received encrypted artifacts (manifest + keyparams + blobs).
  const remoteKeys = [...harness.store.keys()];
  assert.ok(
    remoteKeys.some((k) => k.includes("/wormhole/keyparams.json")),
    `keyparams.json must exist remotely; remote keys: ${JSON.stringify(remoteKeys)}`,
  );
  assert.ok(
    remoteKeys.some((k) => k.includes("/wormhole/manifest")),
    `manifest must exist remotely; remote keys: ${JSON.stringify(remoteKeys)}`,
  );
  const blobKeys = remoteKeys.filter((k) => k.includes("/wormhole/blobs/"));
  assert.ok(blobKeys.length >= 2, `expected >=2 blobs, got ${blobKeys.length}`);
  // Ciphertext must NOT contain the plaintext (proves encryption on the wire).
  for (const bk of blobKeys) {
    const raw = harness.store.get(bk)?.body ?? Buffer.alloc(0);
    assert.ok(
      !raw.includes(Buffer.from("round-trip fixture")),
      `blob ${bk} leaked plaintext — encryption failed`,
    );
  }

  // ── 2) PULL into HOME B (real download + decrypt) ──────────────────────
  const claudeMdB = path.join(homeB.homeDir, ".claude", "CLAUDE.md");
  const settingsB = path.join(homeB.homeDir, ".claude", "settings.json");
  assert.ok(!fs.existsSync(claudeMdB), "precondition: HOME B has no CLAUDE.md yet");

  const b = await engineFor(harness.url, homeB.configPath);
  const pullRes = await b.engine.pull();
  assert.equal(pullRes.dryRun, false, "pull should be a real run");
  assert.ok(
    pullRes.applied.includes(".claude/CLAUDE.md"),
    `expected CLAUDE.md applied, got: ${JSON.stringify(pullRes.applied)}`,
  );

  // ── 3) THE ROUND-TRIP ASSERTION: byte-for-byte fidelity ────────────────
  assert.ok(fs.existsSync(claudeMdB), "HOME B CLAUDE.md must exist after pull");
  assert.equal(
    fs.readFileSync(claudeMdB, "utf-8"),
    CLAUDE_MD_CONTENT,
    "HOME B CLAUDE.md content must equal HOME A original",
  );
  assert.ok(fs.existsSync(settingsB), "HOME B settings.json must exist after pull");
  // settings.json is special-cased by the engine (settings-merge canonicalizes
  // key order on apply), so assert SEMANTIC JSON equality rather than raw bytes.
  // CLAUDE.md above already proves byte-for-byte fidelity for ordinary files.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(settingsB, "utf-8")),
    JSON.parse(SETTINGS_JSON_CONTENT),
    "HOME B settings.json must deep-equal HOME A original",
  );

  // ── 4) IDEMPOTENCY: a second pull is a clean no-op, status is in-sync ───
  const b2 = await engineFor(harness.url, homeB.configPath);
  const pull2 = await b2.engine.pull();
  assert.equal(pull2.applied.length, 0, "second pull must apply nothing");
  assert.equal(pull2.removed.length, 0, "second pull must remove nothing");
  assert.equal(pull2.conflicts.length, 0, "second pull must have no conflicts");

  const status = await b2.engine.status();
  assert.equal(
    status.summary.conflicts.length,
    0,
    `HOME B status must show no conflicts: ${JSON.stringify(status.summary)}`,
  );
  // After a converged pull, B has no outbound changes to push.
  assert.equal(
    status.summary.added.length + status.summary.modified.length + status.summary.deleted.length,
    0,
    `HOME B should have no local divergence: ${JSON.stringify(status.summary)}`,
  );
});
