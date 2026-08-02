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
import { sha256 } from "./hash";

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const codexSessionSchema = z
  .object({
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
  })
  .strict();

export type AnonymousCodexSession = z.infer<typeof codexSessionSchema>;

const sessionDirectory = path.join(
  legalDataHome(),
  "apps",
  "mike",
  "provider-sessions",
  "codex",
);

function sessionPath(chatId: string) {
  return path.join(sessionDirectory, `${chatId}.json`);
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

export function readAnonymousCodexSession(
  userId: string,
  chatId: string,
): AnonymousCodexSession | null {
  if (
    !idSchema.safeParse(userId).success ||
    !idSchema.safeParse(chatId).success
  ) {
    return null;
  }
  try {
    const parsed = codexSessionSchema.safeParse(
      JSON.parse(readFileSync(sessionPath(chatId), "utf8")),
    );
    return parsed.success &&
      parsed.data.user_id === userId &&
      parsed.data.chat_id === chatId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
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
  const previous = readAnonymousCodexSession(params.userId, params.chatId);
  const now = new Date().toISOString();
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
  mkdirSync(sessionDirectory, { recursive: true });
  const temporary = path.join(
    sessionDirectory,
    `.${params.chatId}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, JSON.stringify(state), {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, sessionPath(params.chatId));
  } finally {
    rmSync(temporary, { force: true });
  }
  return state;
}

export function claimAnonymousCodexSession(params: {
  userId: string;
  chatId: string;
  projectId: string | null;
  compatibilityKey: string;
  transcriptVersion: number;
}): AnonymousCodexSession | null {
  if (
    !idSchema.safeParse(params.userId).success ||
    !idSchema.safeParse(params.chatId).success ||
    !digestSchema.safeParse(params.compatibilityKey).success
  ) {
    return null;
  }
  const claimed = path.join(
    sessionDirectory,
    `.${params.chatId}.${process.pid}.${randomUUID()}.claim`,
  );
  try {
    renameSync(sessionPath(params.chatId), claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = codexSessionSchema.safeParse(
      JSON.parse(readFileSync(claimed, "utf8")),
    );
    if (!parsed.success) return null;
    const state = parsed.data;
    return state.user_id === params.userId &&
      state.chat_id === params.chatId &&
      state.project_id === params.projectId &&
      state.compatibility_key === params.compatibilityKey &&
      state.transcript_version === params.transcriptVersion
      ? state
      : null;
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

export function deleteAnonymousProviderSessions(chatId: string) {
  if (!idSchema.safeParse(chatId).success) return;
  try {
    rmSync(sessionPath(chatId), { force: true });
  } catch {
    // Provider state is an optimization; canonical chat deletion must win.
  }
}
