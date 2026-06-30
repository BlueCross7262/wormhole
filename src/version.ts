import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

declare const __WORMHOLE_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __WORMHOLE_VERSION__ !== "undefined") return __WORMHOLE_VERSION__;
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION: string = resolveVersion();
