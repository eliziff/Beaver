import { z } from "zod";
import { sha256 } from "./hash";
import {
  sqliteDatabase,
  sqliteTransaction,
} from "./sqliteDatabase";

const idSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const codexSessionSchema = z.object({
  user_id: idSchema,
  chat_id: idSchema,
  project_id: idSchema.nullable(),
  continuation_id: idSchema,
  compatibility_key: digestSchema,
  transcript_version: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

type Session = z.infer<typeof codexSessionSchema>;
const SELECT = `SELECT user_id,chat_id,project_id,continuation_id,compatibility_key,
  transcript_version,created_at,updated_at FROM provider_sessions`;

function sessionFromRow(row: Session | undefined) {
  if (!row) return null;
  const parsed = codexSessionSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function providerSessionCompatibilityKey(value: unknown) {
  return sha256(JSON.stringify(value) ?? "null");
}

export function readProviderSession(userId: string, chatId: string) {
  if (!idSchema.safeParse(userId).success || !idSchema.safeParse(chatId).success) {
    return null;
  }
  return sessionFromRow(sqliteDatabase().prepare(
    `${SELECT} WHERE user_id=? AND chat_id=?`,
  ).get(userId, chatId) as Session | undefined);
}

export function writeProviderSession(params: {
  userId: string;
  chatId: string;
  projectId: string | null;
  continuationId: string;
  compatibilityKey: string;
  transcriptVersion: number;
  createdAt?: string;
}) {
  const now = new Date().toISOString();
  return sqliteTransaction((database) => {
    const previous = sessionFromRow(database.prepare(
      `${SELECT} WHERE user_id=? AND chat_id=?`,
    ).get(params.userId, params.chatId) as Session | undefined);
    const state = codexSessionSchema.parse({
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
      `INSERT INTO provider_sessions
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

export function claimProviderSession(params: {
  userId: string;
  chatId: string;
  projectId: string | null;
  compatibilityKey: string;
  transcriptVersion: number;
}): Session | null {
  if (!idSchema.safeParse(params.userId).success ||
      !idSchema.safeParse(params.chatId).success ||
      !digestSchema.safeParse(params.compatibilityKey).success) return null;
  return sqliteTransaction((database) => {
    const state = sessionFromRow(database.prepare(
      `${SELECT} WHERE chat_id=?`,
    ).get(params.chatId) as Session | undefined);
    database.prepare("DELETE FROM provider_sessions WHERE chat_id=?")
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

export function deleteProviderSession(chatId: string) {
  if (idSchema.safeParse(chatId).success) {
    sqliteDatabase().prepare(
      "DELETE FROM provider_sessions WHERE chat_id=?",
    ).run(chatId);
  }
}
