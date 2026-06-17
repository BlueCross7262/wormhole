// 부트스트랩 진입점 — config 로드 → 자격/원격/엔진 조립 → MCP 툴 등록 →
// 시작 시 pull(best-effort) → autoSync(설정 시) → StdioServerTransport connect.
// stdout 은 MCP 전송 전용 — 모든 로깅은 stderr(logger) 경유.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { AgeCrypto } from "./crypto/age.js";
import { RemoteStore } from "./webdav/client.js";
import { loadOrCreateMachineId } from "./sync/machine.js";
import { SyncEngine } from "./sync/engine.js";
import { registerAllTools } from "./tools/index.js";
import { AutoSync } from "./watcher/auto-sync.js";
import { resolvePassphrase } from "./crypto/passphrase.js";
import { ensureCryptoReady } from "./crypto/keyparams.js";

// identity 파일 존재 여부(접근 가능) 판정.


async function main(): Promise<void> {
  // 1) config 로드.
  const config = await loadConfig();

  // 평문 http 경고: 전송 암호화(Tailscale 등)가 없으면 WebDAV 자격증명·메타데이터가 노출될 수 있다.
  if (
    /^http:\/\//i.test(config.remote.url) &&
    !/^http:\/\/(localhost|127\.|\[::1\])/i.test(config.remote.url)
  ) {
    logger.warn(
      "WebDAV URL 이 평문 http 임 — Tailscale 등 암호화 전송이 아니면 자격증명 노출 위험. https 권장.",
    );
  }

  // 2) machineId 로드/생성.
  const machineId = await loadOrCreateMachineId(config.stateDir);
  logger.info(`machine id: ${machineId}`);

  // 3) 원격 스토어 + 베이스 레이아웃 보장. (crypto 부트스트랩이 원격 keyparams 를 읽으므로 먼저 준비)
  const remote = new RemoteStore(config.remote, logger);
  await remote.ensureDir(config.remote.remoteBaseDir);
  await remote.ensureDir(`${config.remote.remoteBaseDir}/blobs`);

  // 4) passphrase 해석(env → 0600파일 → keychain). 원문은 메모리에만 둔다.
  const { passphrase, source } = await resolvePassphrase(
    {
      env: config.crypto.passphraseEnv,
      file: config.crypto.passphraseFile,
      keychainService: config.crypto.keychainService,
    },
    logger,
  );
  logger.info(`passphrase 소스: ${source}`);

  // 5) crypto 준비: passphrase → KDF → 결정적 age 키 파생 + age-key.txt 캐시.
  //    원격 keyparams 존재 시 sentinel 복호로 passphrase 정합성 검증(새 기기 init 검증, locked #1).
  const crypto = new AgeCrypto(logger);
  const keyResult = await ensureCryptoReady({
    remote,
    crypto,
    passphrase,
    params: { N: config.crypto.kdfN, r: config.crypto.kdfR, p: config.crypto.kdfP },
    derivedKeyPath: config.crypto.derivedKeyPath,
    machineId,
    logger,
  });
  logger.info(
    `age 키 준비 완료(${keyResult.created ? "신규 vault" : "기존 vault"}) recipient=${keyResult.recipient}`,
  );

  // 6) 동기화 엔진 조립(ManifestStore/경로매핑 등은 엔진 내부 책임).
  const engine = new SyncEngine({ config, crypto, remote, machineId, logger });

  // 7) MCP 서버 + 툴 등록.
  const server = new McpServer({ name: "claude-sync", version: "0.1.0" });
  registerAllTools(server, engine);

  // 8) autoSync 설정.
  //    주의(watcher 수명 한계): 이 watcher 는 MCP stdio 프로세스(=Claude Code 세션)에 종속된다.
  //    세션 종료 시 watcher 도 죽으므로 상시 데몬이 아니다. 오프라인 변경은 다음 기동의 startup pull
  //    또는 수동 sync_push 로 보정한다(README 참고).
  let autoSync: AutoSync | null = null;
  if (config.autoSync.enabled) {
    autoSync = new AutoSync(engine, config, logger);
    await autoSync.start(); // start() 내부에서 startup pull 1회 수행.
    logger.info("autoSync 시작됨(기동 pull 포함)");
  } else {
    // autoSync 비활성 시에는 여기서 기동 pull 을 1회 수행한다(중복 pull 방지).
    try {
      const result = await engine.pull();
      logger.info(
        `시작 pull 완료: applied=${result.applied.length} removed=${result.removed.length} conflicts=${result.conflicts.length}`,
      );
    } catch (err) {
      logger.warn(`시작 pull 실패(무시하고 계속): ${String((err as Error).message)}`);
    }
  }

  // 9) graceful shutdown — autoSync.stop + 진행 작업 정리 후 종료.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} 수신 — 종료 중`);
    try {
      if (autoSync) await autoSync.stop();
      await server.close();
    } catch (err) {
      logger.error(`종료 정리 중 오류: ${String((err as Error).message)}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 10) stdio 전송 연결.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP 서버 연결됨 (stdio)");
}

main().catch((err) => {
  logger.error(`치명적 부트스트랩 오류: ${String((err as Error).stack ?? (err as Error).message)}`);
  process.exit(1);
});
