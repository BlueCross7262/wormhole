import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface KnownMarketplaceEntry {
  installLocation?: string;
}

export interface PluginInstallGuidance {
  installCommands: string[];
  unresolvedMarketplaces: string[];
}

const SAFE_PLUGIN_KEY = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const SAFE_GITHUB_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SAFE_GIT_URL = /^(https:\/\/|git@)[A-Za-z0-9._~:/@+%-]+$/;

const BUILTIN_MARKETPLACE_REPOS: Record<string, string> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export function readKnownMarketplaces(pluginsDir: string): Record<string, KnownMarketplaceEntry> {
  try {
    const raw = readFileSync(path.join(pluginsDir, "known_marketplaces.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, KnownMarketplaceEntry>) : {};
  } catch {
    return {};
  }
}

export function isMarketplaceRegistered(
  marketplace: string,
  known: Record<string, KnownMarketplaceEntry>,
): boolean {
  const entry = ownValue(known, marketplace) as KnownMarketplaceEntry | undefined;
  return !!entry && !!entry.installLocation && existsSync(entry.installLocation);
}

function addCommandFromSource(source: unknown): string | null {
  if (!isRecord(source)) return null;
  const keys = Object.keys(source).sort().join(",");
  if (source.source === "github" && keys === "repo,source") {
    const repo = source.repo;
    return typeof repo === "string" && SAFE_GITHUB_REPO.test(repo)
      ? `/plugin marketplace add ${repo}`
      : null;
  }
  if (source.source === "git" && keys === "source,url") {
    const url = source.url;
    return typeof url === "string" && SAFE_GIT_URL.test(url)
      ? `/plugin marketplace add ${url}`
      : null;
  }
  return null;
}

function resolveAddCommand(marketplace: string, settings: unknown): string | null {
  if (isRecord(settings) && isRecord(settings.extraKnownMarketplaces)) {
    const entry = ownValue(settings.extraKnownMarketplaces, marketplace);
    if (isRecord(entry)) return addCommandFromSource(entry.source);
  }
  const builtinRepo = ownValue(BUILTIN_MARKETPLACE_REPOS, marketplace);
  return typeof builtinRepo === "string" ? `/plugin marketplace add ${builtinRepo}` : null;
}

export function buildPluginInstallGuidance(
  missing: string[],
  settings: unknown,
  pluginsDir: string,
): PluginInstallGuidance {
  const known = readKnownMarketplaces(pluginsDir);
  const addCommands: string[] = [];
  const installCommands: string[] = [];
  const unresolved: string[] = [];
  const resolvedAdds = new Map<string, boolean>();

  for (const key of missing) {
    if (!SAFE_PLUGIN_KEY.test(key)) continue;
    const marketplace = key.slice(key.lastIndexOf("@") + 1);

    let usable = resolvedAdds.get(marketplace);
    if (usable === undefined) {
      if (isMarketplaceRegistered(marketplace, known)) {
        usable = true;
      } else {
        const addCommand = resolveAddCommand(marketplace, settings);
        if (addCommand === null) {
          unresolved.push(marketplace);
          usable = false;
        } else {
          addCommands.push(addCommand);
          usable = true;
        }
      }
      resolvedAdds.set(marketplace, usable);
    }

    if (usable) installCommands.push(`/plugin install ${key}`);
  }

  return {
    installCommands: [...addCommands, ...installCommands],
    unresolvedMarketplaces: unresolved,
  };
}
