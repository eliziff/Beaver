import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mikeLocalDataHome } from "../../src/lib/legalDataPath";

export const SQLITE_SCHEMA_VERSION = 9;
let database: DatabaseSync | null = null;

export function openSqliteDatabase(filename = path.join(mikeLocalDataHome(), "application.sqlite")) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const opened = new DatabaseSync(filename);
  opened.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  return opened;
}
export function sqliteDatabase() {
  return database ??= openSqliteDatabase();
}
export function sqliteTransaction<T>(operation: (value: DatabaseSync) => T,
  target = sqliteDatabase()) {
  target.exec("BEGIN IMMEDIATE");
  try { const result = operation(target); target.exec("COMMIT"); return result; }
  catch (error) { target.exec("ROLLBACK"); throw error; }
}
export function closeSqliteDatabase() {
  database?.close(); database = null;
}
