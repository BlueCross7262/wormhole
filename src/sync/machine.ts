import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import type { MachineId } from "../types.js";

// stateDir/machine-id 파일에서 머신 ID 로드. 없으면 UUID 생성 후 저장.
export async function loadOrCreateMachineId(stateDir: string): Promise<MachineId> {
  const filePath = path.join(stateDir, "machine-id");

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const id = content.trim();
    if (id.length > 0) return id;
  } catch {
    // 파일 없음 → 생성 경로로 진행
  }

  // 부모 디렉터리 보장
  await fs.mkdir(stateDir, { recursive: true });

  const id: MachineId = crypto.randomUUID();

  // 원자적 쓰기: temp 파일에 먼저 기록한 뒤 rename 으로 교체한다.
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, id, "utf-8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // rename 실패 시 잔여 temp 파일 정리 후 에러 전파.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return id;
}

export async function readMachineIdIfExists(stateDir: string): Promise<MachineId | null> {
  const filePath = path.join(stateDir, "machine-id");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const id = content.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
