import type { createServerSupabase } from "./supabase";
import { safeErrorLog } from "./safeError";
import type { AssistantEvent } from "./chat/turnEngine";

type Db = ReturnType<typeof createServerSupabase>;

export type AuditStatus = "completed" | "cancelled" | "failed";

export type AuditEventInput = {
  userId: string;
  userEmail?: string | null;
  action: string;
  status?: AuditStatus;
  title?: string | null;
  surface?: string | null;
  projectId?: string | null;
  chatId?: string | null;
  documentId?: string | null;
  reviewId?: string | null;
  model?: string | null;
  detail?: Record<string, unknown> | null;
};

/** Audit recording must never block or fail the user-facing operation. */
export async function recordAudit(db: Db, event: AuditEventInput) {
  try {
    const { error } = await db.from("audit_events").insert({
      user_id: event.userId,
      user_email: event.userEmail ?? null,
      action: event.action,
      status: event.status ?? "completed",
      title: event.title?.slice(0, 300) ?? null,
      surface: event.surface ?? null,
      project_id: event.projectId ?? null,
      chat_id: event.chatId ?? null,
      document_id: event.documentId ?? null,
      review_id: event.reviewId ?? null,
      model: event.model ?? null,
      detail: event.detail ?? null,
    });
    if (error) console.error("[audit] insert failed", safeErrorLog(error));
  } catch (error) {
    console.error("[audit] insert threw", safeErrorLog(error));
  }
}

export async function recordChatTurn(
  db: Db,
  base: {
    userId: string;
    userEmail?: string | null;
    chatId: string | null;
    projectId?: string | null;
    title?: string | null;
    model?: string | null;
    status?: AuditStatus;
  },
  events: readonly AssistantEvent[] | null | undefined,
) {
  const surface = base.projectId ? "project" : "assistant";
  await recordAudit(db, {
    ...base,
    action: "chat.message",
    surface,
  });
  for (const event of events ?? []) {
    if (event.type !== "document_artifact") continue;
    await recordAudit(db, {
      ...base,
      action: event.action === "created" ? "document.generated" : "document.edited",
      surface,
      title: event.filename ?? null,
      documentId: event.document_id ?? null,
    });
  }
}
