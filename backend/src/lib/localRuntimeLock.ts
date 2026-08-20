import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

export function acquireLocalRuntimeLock(
  root = mikeLocalDataHome(),
): () => void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(root, 0o700);
  const lock = path.join(root, "backend.lock.sqlite");
  const database = new DatabaseSync(lock);
  if (process.platform !== "win32") chmodSync(lock, 0o600);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if ((error as Error).message.toLowerCase().includes("locked")) {
      throw new Error(
        "Account-free local mode is already running against this Beaver data directory.",
      );
    }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  };
  process.once("exit", release);
  return release;
}
