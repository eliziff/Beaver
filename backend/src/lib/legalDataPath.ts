import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

type Environment = Record<string, string | undefined>;

/**
 * Shared provider databases and caches live outside any one application.
 * App-specific documents, projects, preferences, and outputs do not.
 */
export function legalDataHome(options?: {
  env?: Environment;
  platform?: NodeJS.Platform;
  home?: string;
}) {
  const env = options?.env ?? process.env;
  const configured = env.OPEN_LEGAL_DATA_HOME?.trim();
  if (configured) return path.resolve(configured);

  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? os.homedir();
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.resolve(localAppData, "OpenLegalProducts", "LegalData");
  }
  if (platform === "darwin") {
    return path.resolve(
      home,
      "Library",
      "Application Support",
      "OpenLegalProducts",
      "LegalData",
    );
  }
  const dataHome =
    env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.resolve(dataHome, "OpenLegalProducts", "LegalData");
}

export function legalProviderDatabase(provider: string, filename: string) {
  return path.join(legalDataHome(), "providers", provider, filename);
}

export function legalProviderCache(provider: string) {
  return path.join(legalDataHome(), "cache", provider);
}

export function withReadonlySqlite<T>(
  filename: string,
  operation: (database: DatabaseSync) => T,
): T | null {
  if (!existsSync(filename)) return null;
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

export function mikeLocalDataHome(options?: {
  env?: Environment;
  platform?: NodeJS.Platform;
  home?: string;
}) {
  const configured = (options?.env ?? process.env).MIKE_LOCAL_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  return path.join(legalDataHome(options), "apps", "mike", "library");
}
