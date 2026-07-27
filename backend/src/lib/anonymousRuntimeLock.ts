import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "./legalDataPath";

export function acquireAnonymousRuntimeLock(
  root = mikeLocalDataHome(),
): () => void {
  mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(path.join(root, "backend.lock.sqlite"));
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
