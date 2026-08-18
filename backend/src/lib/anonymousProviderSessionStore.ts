import { z } from "zod";
import { sha256 } from "./hash";
import {
  localApplicationDatabase,
  localApplicationTransaction,
} from "./localApplicationDatabase";

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const codexSessionSchema = z.object({
  schema_version: z.literal(1),
  provider: z.literal("codex"),
  user_id: idSchema,
  chat_id: idSchema,
  project_id: idSchema.nullable(),
  continuation_id: idSchema,
  compatibility_key: digestSchema,
  transcript_version: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type AnonymousCodexSession = z.infer<typeof codexSessionSchema>;
type SessionRow = Omit<AnonymousCodexSession, "schema_version" | "provider">;

function sessionFromRow(row: SessionRow | undefined) {
  if (!row) return null;
  const parsed = codexSessionSchema.safeParse({
    schema_version: 1,
    provider: "codex",
    ...row,
  });
  return parsed.success ? parsed.data : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function providerSessionCompatibilityKey(value: unknown) {
  return sha256(canonicalJson(value));
}

export function readAnonymousCodexSession(userId: string, chatId: string) {
  if (!idSchema.safeParse(userId).success || !idSchema.safeParse(chatId).success) {
    return null;
  }
  return sessionFromRow(localApplicationDatabase().prepare(
    `SELECT user_id,chat_id,project_id,continuation_id,compatibility_key,
            transcript_version,created_at,updated_at
     FROM local_codex_sessions WHERE user_id=? AND chat_id=?`,
  ).get(userId, chatId) as SessionRow | undefined);
}

export function writeAnonymousCodexSession(params: {
  userId: string;
  chatId: string;
  projectId: string | null;
  continuationId: string;
  compatibilityKey: string;
  transcriptVersion: number;
  createdAt?: string;
}) {
  const now = new Date().toISOString();
  return localApplicationTransaction((database) => {
    const previous = sessionFromRow(database.prepare(
      `SELECT user_id,chat_id,project_id,continuation_id,compatibility_key,
              transcript_version,created_at,updated_at
       FROM local_codex_sessions WHERE user_id=? AND chat_id=?`,
    ).get(params.userId, params.chatId) as SessionRow | undefined);
    const state = codexSessionSchema.parse({
      schema_version: 1,
      provider: "codex",
      user_id: params.userId,
      chat_id: params.chatId,
      project_id: params.projectId,
      continuation_id: params.continuationId,
      compatibility_key: params.compatibilityKey,
      transcript_version: params.transcriptVersion,
      created_at: params.createdAt ?? previous?.created_at ?? now,
      updated_at: now,
    });
    database.prepare(
      `INSERT INTO local_codex_sessions
        (chat_id,user_id,project_id,continuation_id,compatibility_key,
         transcript_version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET
         user_id=excluded.user_id,project_id=excluded.project_id,
         continuation_id=excluded.continuation_id,
         compatibility_key=excluded.compatibility_key,
         transcript_version=excluded.transcript_version,
         updated_at=excluded.updated_at`,
    ).run(
      state.chat_id, state.user_id, state.project_id, state.continuation_id,
      state.compatibility_key, state.transcript_version, state.created_at,
      state.updated_at,
    );
    return state;
  });
}

export function claimAnonymousCodexSession(params: {
  userId: string;
  chatId: string;
  projectId: string | null;
  compatibilityKey: string;
  transcriptVersion: number;
}): AnonymousCodexSession | null {
  if (!idSchema.safeParse(params.userId).success ||
      !idSchema.safeParse(params.chatId).success ||
      !digestSchema.safeParse(params.compatibilityKey).success) return null;
  return localApplicationTransaction((database) => {
    const state = sessionFromRow(database.prepare(
      `SELECT user_id,chat_id,project_id,continuation_id,compatibility_key,
              transcript_version,created_at,updated_at
       FROM local_codex_sessions WHERE chat_id=?`,
    ).get(params.chatId) as SessionRow | undefined);
    database.prepare("DELETE FROM local_codex_sessions WHERE chat_id=?")
      .run(params.chatId);
    return state?.user_id === params.userId &&
      state.chat_id === params.chatId &&
      state.project_id === params.projectId &&
      state.compatibility_key === params.compatibilityKey &&
      state.transcript_version === params.transcriptVersion
      ? state
      : null;
  });
}

export function deleteAnonymousProviderSessions(chatId: string) {
  if (!idSchema.safeParse(chatId).success) return;
  localApplicationTransaction((database) => {
    database.prepare("DELETE FROM local_codex_sessions WHERE chat_id=?").run(chatId);
  });
}
