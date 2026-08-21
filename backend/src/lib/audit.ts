import { randomUUID } from "node:crypto";

import type { ApplicationScope } from "./applicationError";
import type { AssistantEvent } from "./chat/turnEngine";
import { encodeJson, sql, type RelationalDatabase } from "./relational";
import { safeErrorLog } from "./safeError";

export type AuditStatus = "completed" | "cancelled" | "failed";
export type AuditEventInput = {
  userId: string; userEmail?: string | null; action: string; status?: AuditStatus;
  title?: string | null; surface?: string | null; projectId?: string | null;
  chatId?: string | null; documentId?: string | null; reviewId?: string | null;
  model?: string | null; detail?: Record<string, unknown> | null;
};
export type AuditQuery = {
  q?: string; action?: string; status?: string; surface?: string;
  from?: string; to?: string; sortBy: "created_at" | "user_email" | "title" | "model";
  sortDirection: "asc" | "desc"; page: number; limit: number;
};

export const escapeLikePattern = (value: string) =>
  value.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");

const valueRows = (events: readonly AuditEventInput[]) => sql.join(events.map((event) => sql`(
  ${randomUUID()},${event.userId},${event.userEmail ?? null},${event.action},
  ${event.status ?? "completed"},${event.title?.slice(0, 300) ?? null},
  ${event.surface ?? null},${event.projectId ?? null},${event.chatId ?? null},
  ${event.documentId ?? null},${event.reviewId ?? null},${event.model ?? null},
  ${event.detail ? encodeJson(event.detail) : null},${new Date().toISOString()})`));

/** Audit recording is deliberately best-effort and never fails the operation being recorded. */
export async function recordAudit(db: RelationalDatabase, ...events: AuditEventInput[]) {
  if (!events.length) return;
  try {
    await db.query(sql`INSERT INTO audit_events(id,user_id,user_email,action,status,title,
      surface,project_id,chat_id,document_id,review_id,model,detail,created_at)
      VALUES ${valueRows(events)}`);
  } catch (error) { console.error("[audit] insert failed", safeErrorLog(error)); }
}

export function recordChatTurn(db: RelationalDatabase, base: Omit<AuditEventInput, "action">,
  events: readonly AssistantEvent[] | null | undefined) {
  const surface = base.projectId ? "project" : "assistant";
  return recordAudit(db, { ...base, action: "chat.message", surface },
    ...(events ?? []).filter((event) => event.type === "document_artifact").map((event) => ({
      ...base, action: event.action === "created" ? "document.generated" : "document.edited",
      surface, title: event.filename ?? null, documentId: event.document_id ?? null,
    })));
}

export function createAuditStore(db: RelationalDatabase) {
  return {
    record: (...events: AuditEventInput[]) => recordAudit(db, ...events),
    recordChatTurn: (base: Omit<AuditEventInput, "action">,
      events: readonly AssistantEvent[] | null | undefined) => recordChatTurn(db, base, events),
    async list(scope: ApplicationScope, query: AuditQuery) {
      const email = scope.userEmail?.trim().toLowerCase() || "";
      let where = email ? sql`(a.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
        WHERE p.id=a.project_id AND (p.user_id=${scope.userId} OR EXISTS(SELECT 1
          FROM project_members pm WHERE pm.project_id=p.id AND pm.email=${email}))))`
        : sql`a.user_id=${scope.userId}`;
      if (query.action) where = sql`${where} AND a.action=${query.action}`;
      if (query.status) where = sql`${where} AND a.status=${query.status}`;
      if (query.surface) where = sql`${where} AND a.surface=${query.surface}`;
      if (query.q) where = sql`${where} AND lower(COALESCE(a.title,'')) LIKE
        ${`%${escapeLikePattern(query.q.toLowerCase())}%`} ESCAPE '\\'`;
      if (query.from) where = sql`${where} AND a.created_at>=${query.from}`;
      if (query.to) where = sql`${where} AND a.created_at<=${query.to}T23:59:59.999Z`;
      const order = sql.raw(`a.${query.sortBy} ${query.sortDirection} NULLS LAST,a.id ${query.sortDirection}`);
      const offset = (query.page - 1) * query.limit;
      const [events, count] = await Promise.all([
        db.query<Record<string, unknown>>(sql`SELECT a.* FROM audit_events a WHERE ${where}
          ORDER BY ${order} LIMIT ${query.limit} OFFSET ${offset}`),
        db.query<{ total: number }>(sql`SELECT COUNT(*) total FROM audit_events a WHERE ${where}`),
      ]);
      return { events: events.rows, total: Number(count.rows[0]?.total ?? 0) };
    },
  };
}
export type AuditStore = ReturnType<typeof createAuditStore>;
