import { Router, type Response } from "express";

import { type AuditQuery, type AuditStore, escapeLikePattern } from "../lib/audit";
import { asyncRoute } from "../lib/asyncRoute";
import { downloadHeaders } from "../lib/storage";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";

export { escapeLikePattern };
const PAGE_SIZE = 50, EXPORT_LIMIT = 2_000, MAX_PAGE = 100_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SORT_FIELDS = ["created_at", "user_email", "title", "model"] as const;
type SortField = (typeof SORT_FIELDS)[number];

export function parseQuery(raw: Record<string, unknown>, limit: number):
  { ok: true; query: AuditQuery } | { ok: false; error: string } {
  const value = (input: unknown) =>
    typeof input === "string" && input.trim() ? input.trim() : undefined;
  const page = Number.parseInt(String(raw.page ?? "1"), 10) || 1;
  const from = value(raw.from), to = value(raw.to);
  const sortBy = value(raw.sort_by), sortDirection = value(raw.sort_dir);
  if (from && !DATE_RE.test(from))
    return { ok: false, error: "Invalid 'from' date; expected YYYY-MM-DD" };
  if (to && !DATE_RE.test(to))
    return { ok: false, error: "Invalid 'to' date; expected YYYY-MM-DD" };
  if (sortBy && !SORT_FIELDS.includes(sortBy as SortField))
    return { ok: false, error: "Invalid audit sort field" };
  if (sortDirection && sortDirection !== "asc" && sortDirection !== "desc")
    return { ok: false, error: "Invalid audit sort direction" };
  return { ok: true, query: {
    q: value(raw.q)?.slice(0, 200), action: value(raw.action)?.slice(0, 60),
    status: value(raw.status)?.slice(0, 20), surface: value(raw.surface)?.slice(0, 30),
    from, to, sortBy: (sortBy as SortField | undefined) ?? "created_at",
    sortDirection: (sortDirection as "asc" | "desc" | undefined) ?? "desc",
    page: Math.min(Math.max(page, 1), MAX_PAGE), limit,
  } };
}

export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}
const scope = (res: Response) => ({ userId: String(res.locals.userId),
  userEmail: typeof res.locals.userEmail === "string" ? res.locals.userEmail : undefined });
const failed = (res: Response, error: unknown) => {
  console.error("[audit] query failed", { error: error instanceof Error ? error.name : "provider" });
  res.status(500).json({ detail: "Failed to load history" });
};

export function createAuditRouter(store: AuditStore) {
  const router = Router();
  router.use(requireAuth);
  router.get("/export", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const parsed = parseQuery(req.query, EXPORT_LIMIT);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
    let result;
    try { result = await store.list(scope(res), { ...parsed.query, page: 1 }); }
    catch (error) { return void failed(res, error); }
    const columns = ["created_at", "user_email", "action", "status", "title",
      "surface", "project_id", "chat_id", "document_id", "review_id", "model"];
    const lines = [columns.join(","), ...result.events.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","))];
    res.set(downloadHeaders("text/csv; charset=utf-8",
      `beaver-history-${new Date().toISOString().slice(0, 10)}.csv`));
    res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
  }));
  router.get("/", asyncRoute(async (req, res) => {
    const parsed = parseQuery(req.query, PAGE_SIZE);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
    try {
      const result = await store.list(scope(res), parsed.query);
      res.json({ ...result, page: parsed.query.page, pageSize: PAGE_SIZE });
    } catch (error) { failed(res, error); }
  }));
  return router;
}
