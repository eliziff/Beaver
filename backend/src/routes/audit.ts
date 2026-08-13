import { Router } from "express";

import { createServerSupabase } from "../lib/supabase";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";

export const auditRouter = Router();
auditRouter.use(requireAuth);

const PAGE_SIZE = 50;
const EXPORT_LIMIT = 2_000;
const MAX_PAGE = 100_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SORT_FIELDS = ["created_at", "user_email", "title", "model"] as const;
type SortField = (typeof SORT_FIELDS)[number];

type AuditQuery = {
  q?: string;
  action?: string;
  status?: string;
  surface?: string;
  from?: string;
  to?: string;
  sortBy: SortField;
  sortDirection: "asc" | "desc";
  page: number;
  limit: number;
};

export function parseQuery(
  raw: Record<string, unknown>,
  limit: number,
): { ok: true; query: AuditQuery } | { ok: false; error: string } {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const parsedPage = Number.parseInt(String(raw.page ?? "1"), 10) || 1;
  const from = stringValue(raw.from);
  const to = stringValue(raw.to);
  const sortBy = stringValue(raw.sort_by);
  const sortDirection = stringValue(raw.sort_dir);
  if (from && !DATE_RE.test(from))
    return { ok: false, error: "Invalid 'from' date; expected YYYY-MM-DD" };
  if (to && !DATE_RE.test(to))
    return { ok: false, error: "Invalid 'to' date; expected YYYY-MM-DD" };
  if (sortBy && !SORT_FIELDS.includes(sortBy as SortField))
    return { ok: false, error: "Invalid audit sort field" };
  if (sortDirection && sortDirection !== "asc" && sortDirection !== "desc")
    return { ok: false, error: "Invalid audit sort direction" };
  return {
    ok: true,
    query: {
      q: stringValue(raw.q)?.slice(0, 200),
      action: stringValue(raw.action)?.slice(0, 60),
      status: stringValue(raw.status)?.slice(0, 20),
      surface: stringValue(raw.surface)?.slice(0, 30),
      from,
      to,
      sortBy: (sortBy as SortField | undefined) ?? "created_at",
      sortDirection: (sortDirection as "asc" | "desc" | undefined) ?? "desc",
      page: Math.min(Math.max(parsedPage, 1), MAX_PAGE),
      limit,
    },
  };
}

export function escapeLikePattern(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");
}

export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

async function accessibleProjectIds(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  email: string | undefined,
) {
  const ids = new Set<string>();
  const owned = await db.from("projects").select("id").eq("user_id", userId);
  for (const row of owned.data ?? []) ids.add(row.id as string);
  if (email) {
    const shared = await db
      .from("projects")
      .select("id")
      .contains("shared_with", [email]);
    for (const row of shared.data ?? []) ids.add(row.id as string);
  }
  return [...ids];
}

async function queryEvents(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  email: string | undefined,
  query: AuditQuery,
) {
  const projectIds = await accessibleProjectIds(db, userId, email);
  let request = db.from("audit_events").select("*", { count: "exact" });
  request = projectIds.length
    ? request.or(`user_id.eq.${userId},project_id.in.(${projectIds.join(",")})`)
    : request.eq("user_id", userId);
  if (query.action) request = request.eq("action", query.action);
  if (query.status) request = request.eq("status", query.status);
  if (query.surface) request = request.eq("surface", query.surface);
  if (query.q)
    request = request.ilike("title", `%${escapeLikePattern(query.q)}%`);
  if (query.from) request = request.gte("created_at", query.from);
  if (query.to)
    request = request.lte("created_at", `${query.to}T23:59:59.999Z`);
  return request
    .order(query.sortBy, {
      ascending: query.sortDirection === "asc",
      nullsFirst: false,
    })
    .range(
      (query.page - 1) * query.limit,
      query.page * query.limit - 1,
    );
}

auditRouter.get("/export", requireMfaIfEnrolled, async (req, res) => {
  const parsed = parseQuery(req.query, EXPORT_LIMIT);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
  const userId = res.locals.userId as string;
  const result = await queryEvents(
    createServerSupabase(),
    userId,
    res.locals.userEmail as string | undefined,
    { ...parsed.query, page: 1 },
  );
  if (result.error)
    return void res.status(500).json({ detail: result.error.message });
  const columns = [
    "created_at",
    "user_email",
    "action",
    "status",
    "title",
    "surface",
    "project_id",
    "chat_id",
    "document_id",
    "review_id",
    "model",
  ];
  const lines = [
    columns.join(","),
    ...(result.data ?? []).map((row) =>
      columns.map((column) => csvCell(row[column])).join(","),
    ),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="beaver-history-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
});

auditRouter.get("/", async (req, res) => {
  const parsed = parseQuery(req.query, PAGE_SIZE);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.error });
  const result = await queryEvents(
    createServerSupabase(),
    res.locals.userId as string,
    res.locals.userEmail as string | undefined,
    parsed.query,
  );
  if (result.error)
    return void res.status(500).json({ detail: result.error.message });
  res.json({
    events: result.data ?? [],
    total: result.count ?? 0,
    page: parsed.query.page,
    pageSize: PAGE_SIZE,
  });
});
