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
    return path.resolve(localAppData, "OpenLegalData");
  }
  if (platform === "darwin") {
    return path.resolve(
      home,
      "Library",
      "Application Support",
      "OpenLegalData",
    );
  }
  const dataHome =
    env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.resolve(dataHome, "OpenLegalData");
}

export function legalProviderDatabase(provider: string, filename: string) {
  return path.join(legalDataHome(), "providers", provider, filename);
}

// Read-only handles an operation keeps for its length (`withSqliteRun`), closed when its last run ends; outside a run
// each query opens and closes its own, so a validated snapshot can replace the live file between operations.
let runs = 0;
const held = new Map<string, { database: DatabaseSync; search: boolean }>();
const runEnds = new Set<() => void>();
// Stores an operation found missing: it does not ask the disk again while it runs, though its lookups ask for each.
const absent = new Set<string>();
/** Calls `end` whenever the last run ends: a reader that keeps its own handles closes them. */
export const onSqliteRunEnd = (end: () => void) => { runEnds.add(end); };

/** Runs `work` with every read-only database it reads held open until it ends. */
export async function withSqliteRun<T>(work: () => Promise<T>): Promise<T> {
  runs++;
  try {
    return await work();
  } finally {
    if (--runs === 0) {
      for (const { database } of held.values()) database.close();
      held.clear();
      absent.clear();
      for (const end of runEnds) end();
    }
  }
}

/** Whether an operation is running (withSqliteRun): what it reads is kept until it ends. */
export const inSqliteRun = () => runs > 0;

/** Whether a store's file is there; an operation that found it missing finds it missing until it ends. */
export function storeExists(filename: string) {
  if (held.has(filename) || !absent.has(filename) && existsSync(filename)) return true;
  if (runs) absent.add(filename);
  return false;
}

function readonlyHandle(filename: string, search: boolean) {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const open = (database: DatabaseSync) => {
    if (search) database.exec("PRAGMA query_only=ON; PRAGMA mmap_size=2147418112; PRAGMA cache_size=-131072");
    return database;
  };
  if (!runs) return { database: open(new DatabaseSync(filename, { readOnly: true })), close: true };
  let kept = held.get(filename);
  if (!kept) {
    const database = new DatabaseSync(filename, { readOnly: true });
    // An operation reads many pages: they come from a mapping of the file, not a call each.
    database.exec("PRAGMA mmap_size=2147418112");
    held.set(filename, kept = { database, search: false });
  }
  if (search && !kept.search) { open(kept.database); kept.search = true; }
  return { database: kept.database, close: false };
}

export function withReadonlySqlite<T>(
  filename: string,
  operation: (database: DatabaseSync) => T,
  search = false,
): T | null {
  if (!storeExists(filename)) return null;
  const { database, close } = readonlyHandle(filename, search);
  try {
    return operation(database);
  } finally {
    if (close) database.close();
  }
}

/** A search's handle, with the read settings searches take. */
export function withSearchReadonlySqlite<T>(
  filename: string,
  operation: (database: DatabaseSync) => T,
): T | null {
  return withReadonlySqlite(filename, operation, true);
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
