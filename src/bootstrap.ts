// 공유 부트스트랩 — config 로드 → machineId → 원격/베이스 레이아웃 → passphrase →
// crypto 준비 → SyncEngine 조립까지 공통 단계를 한곳에 모은다.
// MCP 진입점(index.ts)과 데몬 진입점이 동일 순서로 엔진을 조립할 수 있게 한다.
// 순서 불변식: ensureDir(원격 레이아웃)가 ensureCryptoReady(원격 keyparams 읽음)보다 먼저,
//             resolvePassphrase 가 ensureCryptoReady 보다 먼저 와야 한다.

import { loadConfig } from "./config.js";
import { AgeCrypto } from "./crypto/age.js";
import { RemoteStore } from "./webdav/client.js";
import { loadOrCreateMachineId } from "./sync/machine.js";
import { SyncEngine } from "./sync/engine.js";
import { resolvePassphrase } from "./crypto/passphrase.js";
import { ensureCryptoReady } from "./crypto/keyparams.js";
import type { Config, Logger } from "./types.js";

export async function buildEngine(logger: Logger): Promise<{
  engine: SyncEngine;
  config: Config;
  machineId: string;
  crypto: AgeCrypto;
  remote: RemoteStore;
}> {
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

  return { engine, config, machineId, crypto, remote };
}
