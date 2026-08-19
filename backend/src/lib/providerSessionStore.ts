import { z } from "zod";
import { sha256 } from "./hash";
import { localDatabaseSync, localTransaction } from "./relationalDatabase";

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.object({
  user_id: id, chat_id: id, project_id: id.nullable(), continuation_id: id,
  compatibility_key: digest, transcript_version: z.number().int().nonnegative(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();
type Session = z.infer<typeof schema>;
const SELECT = `SELECT user_id,chat_id,project_id,continuation_id,compatibility_key,
  transcript_version,created_at,updated_at FROM provider_sessions`;
const parsed = (row: unknown) => {
  const result = schema.safeParse(row);
  return result.success ? result.data : null;
};

export const providerSessionCompatibilityKey = (value: unknown) =>
  sha256(JSON.stringify(value) ?? "null");

export function readProviderSession(userId: string, chatId: string) {
  if (!id.safeParse(userId).success || !id.safeParse(chatId).success) return null;
  return parsed(localDatabaseSync().prepare(`${SELECT} WHERE user_id=? AND chat_id=?`)
    .get(userId, chatId));
}

export function writeProviderSession(input: {
  userId: string; chatId: string; projectId: string | null; continuationId: string;
  compatibilityKey: string; transcriptVersion: number; createdAt?: string;
}) {
  return localTransaction((db) => {
    const previous = parsed(db.prepare(`${SELECT} WHERE user_id=? AND chat_id=?`)
      .get(input.userId, input.chatId));
    const timestamp = new Date().toISOString();
    const value = schema.parse({ user_id: input.userId, chat_id: input.chatId,
      project_id: input.projectId, continuation_id: input.continuationId,
      compatibility_key: input.compatibilityKey, transcript_version: input.transcriptVersion,
      created_at: input.createdAt ?? previous?.created_at ?? timestamp, updated_at: timestamp });
    db.prepare(`INSERT INTO provider_sessions(chat_id,user_id,project_id,continuation_id,
      compatibility_key,transcript_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET user_id=excluded.user_id,
      project_id=excluded.project_id,continuation_id=excluded.continuation_id,
      compatibility_key=excluded.compatibility_key,
      transcript_version=excluded.transcript_version,updated_at=excluded.updated_at`)
      .run(value.chat_id, value.user_id, value.project_id, value.continuation_id,
        value.compatibility_key, value.transcript_version, value.created_at, value.updated_at);
    return value;
  });
}

export function claimProviderSession(input: { userId: string; chatId: string;
  projectId: string | null; compatibilityKey: string; transcriptVersion: number }) {
  if (!id.safeParse(input.userId).success || !id.safeParse(input.chatId).success ||
      !digest.safeParse(input.compatibilityKey).success) return null;
  return localTransaction((db): Session | null => {
    const value = parsed(db.prepare(`${SELECT} WHERE chat_id=?`).get(input.chatId));
    db.prepare("DELETE FROM provider_sessions WHERE chat_id=?").run(input.chatId);
    return value?.user_id === input.userId && value.project_id === input.projectId &&
      value.compatibility_key === input.compatibilityKey &&
      value.transcript_version === input.transcriptVersion ? value : null;
  });
}

export function deleteProviderSession(chatId: string) {
  if (id.safeParse(chatId).success)
    localDatabaseSync().prepare("DELETE FROM provider_sessions WHERE chat_id=?").run(chatId);
}
