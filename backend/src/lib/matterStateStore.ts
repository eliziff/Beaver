// Durable per-chat matter-state event logs. Mirrors the anonymousChatStore
// conventions: one schema-validated JSON file per chat under the shared
// LegalData home, atomic wx-tmp writes, and an in-process cache.

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { legalDataHome } from "./legalDataPath";
import { matterStateLogSchema, type MatterStateLog } from "./chat/matterState";

const storedLogSchema = z
  .object({ version: z.literal(1), log: matterStateLogSchema })
  .strict();

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);

const stateDirectory = path.join(
  legalDataHome(),
  "apps",
  "mike",
  "matter-state",
);
const logs = new Map<string, MatterStateLog>();

function statePath(chatId: string) {
  return path.join(stateDirectory, `${chatId}.json`);
}

/**
 * Load the matter-state log for a chat. Returns null when no log exists or
 * the stored file is corrupt/invalid (warned, never thrown) — the caller
 * degrades to no-matter-state rather than failing the turn.
 */
export function loadMatterState(chatId: string): MatterStateLog | null {
  if (!idSchema.safeParse(chatId).success) return null;
  const cached = logs.get(chatId);
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync(statePath(chatId), "utf8");
  } catch {
    return null; // Missing file is the normal "no state yet" case.
  }
  try {
    const parsed = storedLogSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.log.chat_id !== chatId) {
      console.warn(
        `[matter-state] ignoring invalid state file for chat ${chatId}`,
      );
      return null;
    }
    logs.set(chatId, parsed.data.log);
    return parsed.data.log;
  } catch {
    console.warn(
      `[matter-state] ignoring corrupt state file for chat ${chatId}`,
    );
    return null;
  }
}

/** Validate-or-throw, then write atomically and refresh the cache. */
export function saveMatterState(log: MatterStateLog): void {
  const parsed = storedLogSchema.safeParse({ version: 1, log });
  if (!parsed.success) throw new Error("Invalid matter-state log");

  mkdirSync(stateDirectory, { recursive: true });
  const temporaryPath = path.join(
    stateDirectory,
    `.${log.chat_id}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, log }), {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, statePath(log.chat_id));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  logs.set(log.chat_id, log);
}
