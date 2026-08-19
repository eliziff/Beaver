import type { createServerSupabase } from "./supabase";

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
    if (error) console.error("[audit] insert failed:", error.message);
  } catch (error) {
    console.error(
      "[audit] insert threw:",
      error instanceof Error ? error.message : error,
    );
  }
}

type TurnEvent = {
  type?: string;
  action?: string;
  filename?: string;
  document_id?: string;
  title?: string;
  workflow_id?: string;
  copies?: Array<{ new_filename?: string; document_id?: string }>;
};

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
  events: unknown[] | null | undefined,
) {
  const surface = base.projectId ? "project" : "assistant";
  await recordAudit(db, {
    ...base,
    action: "chat.message",
    surface,
  });
  for (const raw of events ?? []) {
    const event = raw as TurnEvent;
    if (event.type === "doc_replicated") {
      for (const copy of event.copies ?? []) {
        await recordAudit(db, {
          ...base,
          action: "document.generated",
          surface,
          title: copy.new_filename ?? null,
          documentId: copy.document_id ?? null,
        });
      }
      continue;
    }
    const action =
      event.type === "document_artifact" && event.action === "created"
        ? "document.generated"
        : event.type === "document_artifact" && event.action === "edited"
          ? "document.edited"
          : event.type === "workflow_applied"
            ? "workflow.applied"
            : null;
    if (!action) continue;
    await recordAudit(db, {
      ...base,
      action,
      surface,
      title: event.filename ?? event.title ?? null,
      documentId: event.document_id ?? null,
      detail: event.workflow_id ? { workflow_id: event.workflow_id } : null,
    });
  }
}
