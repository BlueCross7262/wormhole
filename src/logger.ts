import type { Logger, LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(level: LogLevel = "info", prefix?: string): Logger {
  const minLevel = LEVELS[level];
  const tag = prefix ? `[${prefix}] ` : "";

  function log(msgLevel: LogLevel, msg: string, ...args: unknown[]): void {
    if (LEVELS[msgLevel] < minLevel) return;
    const line = args.length > 0
      ? `${tag}[${msgLevel.toUpperCase()}] ${msg} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`
      : `${tag}[${msgLevel.toUpperCase()}] ${msg}`;
    console.error(line);
  }

  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
  };
}

const defaultLevel = (process.env["WORMHOLE_LOG_LEVEL"] as LogLevel | undefined) ?? "info";
export const logger: Logger = createLogger(defaultLevel);
