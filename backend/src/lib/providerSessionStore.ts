import { z } from "zod";
import { sha256 } from "./hash";
import { relationalDatabase, sql } from "./relationalDatabase";

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.object({
  user_id: id, chat_id: id, project_id: id.nullable(), continuation_id: id,
  compatibility_key: digest, transcript_version: z.number().int().nonnegative(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();
type Session = z.infer<typeof schema>;
const value = (row: unknown) => { const result = schema.safeParse(row);
  return result.success ? result.data : null; };

export const providerSessionCompatibilityKey = (input: unknown) =>
  sha256(JSON.stringify(input) ?? "null");

export async function readProviderSession(userId: string, chatId: string) {
  if (!id.safeParse(userId).success || !id.safeParse(chatId).success) return null;
  const database = await relationalDatabase();
  return value((await database.query<Session>(sql`SELECT * FROM provider_sessions
    WHERE user_id=${userId} AND chat_id=${chatId}`)).rows[0]);
}

export async function writeProviderSession(input: { userId: string; chatId: string;
  projectId: string | null; continuationId: string; compatibilityKey: string;
  transcriptVersion: number; createdAt?: string }) {
  const timestamp = new Date().toISOString();
  const session = schema.parse({ user_id: input.userId, chat_id: input.chatId,
    project_id: input.projectId, continuation_id: input.continuationId,
    compatibility_key: input.compatibilityKey, transcript_version: input.transcriptVersion,
    created_at: input.createdAt ?? timestamp, updated_at: timestamp });
  const database = await relationalDatabase();
  const stored = (await database.query<Session>(sql`INSERT INTO provider_sessions(
    chat_id,user_id,project_id,continuation_id,compatibility_key,transcript_version,
    created_at,updated_at) VALUES(${session.chat_id},${session.user_id},${session.project_id},
    ${session.continuation_id},${session.compatibility_key},${session.transcript_version},
    ${session.created_at},${session.updated_at}) ON CONFLICT(chat_id) DO UPDATE SET
    user_id=excluded.user_id,project_id=excluded.project_id,
    continuation_id=excluded.continuation_id,compatibility_key=excluded.compatibility_key,
    transcript_version=excluded.transcript_version,
    created_at=CASE WHEN ${input.createdAt ?? null} IS NULL
      THEN provider_sessions.created_at ELSE excluded.created_at END,
    updated_at=excluded.updated_at RETURNING *`)).rows[0];
  return value(stored);
}

export async function claimProviderSession(input: { userId: string; chatId: string;
  projectId: string | null; compatibilityKey: string; transcriptVersion: number }) {
  if (!id.safeParse(input.userId).success || !id.safeParse(input.chatId).success ||
      !digest.safeParse(input.compatibilityKey).success) return null;
  const database = await relationalDatabase();
  const session = value((await database.query<Session>(sql`DELETE FROM provider_sessions
    WHERE chat_id=${input.chatId} RETURNING *`)).rows[0]);
  return session?.user_id === input.userId && session.project_id === input.projectId &&
    session.compatibility_key === input.compatibilityKey &&
    session.transcript_version === input.transcriptVersion ? session : null;
}

export async function deleteProviderSession(chatId: string) {
  if (id.safeParse(chatId).success)
    await (await relationalDatabase()).query(sql`DELETE FROM provider_sessions WHERE chat_id=${chatId}`);
}
