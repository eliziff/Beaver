import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;
type Identity = { userId: string; userEmail?: string | null };
type Row = Record<string, any> & { id: string; user_id: string };
type Project = Row & { shared_with?: unknown }; type Document = Row & { project_id: string | null };
type Review = Document & { shared_with?: unknown }; type Chat = Row & { project_id: string | null; tabular_review_id: string | null };
export type CloudAccess<T extends Row = Row> = { row: T; isOwner: boolean };

const email = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const shared = (value: unknown, userEmail: string) =>
  !!userEmail && Array.isArray(value) && value.some((item) => email(item) === userEmail);

/** Run a provider query without exposing provider diagnostics to HTTP callers. */
export async function cloudData<T>(
  operation: string,
  query: PromiseLike<{ data: T; error: { code?: string; status?: number } | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (!error) return data;
  console.error("[cloud-data] operation failed", {
    operation,
    code: error.code ?? "unknown",
    status: error.status ?? null,
  });
  throw new Error(operation);
}

/**
 * The only application-data capability backed by Beaver's service-role client.
 * Identity is normalized once and every root-resource read is resolved here.
 */
export class CloudScope {
  readonly db: Db;
  readonly userId: string;
  readonly userEmail: string;

  constructor(identity: Identity, db: Db = createServerSupabase()) {
    this.db = db;
    this.userId = identity.userId;
    this.userEmail = email(identity.userEmail);
  }

  private async row<T>(operation: string, query: PromiseLike<{ data: T;
    error: { code?: string; status?: number } | null }>): Promise<T | null> {
    try { return await cloudData(operation, query); } catch { return null; }
  }

  private projectAccess(row: Project | null): CloudAccess<Project> | null {
    if (!row) return null;
    const isOwner = row.user_id === this.userId;
    return isOwner || shared(row.shared_with, this.userEmail)
      ? { row, isOwner } : null;
  }

  async project(id: string, owner = false) {
    const row = await this.row("Failed to load project", this.db.from("projects")
      .select("*").eq("id", id).maybeSingle()) as Project | null;
    const access = this.projectAccess(row);
    return access && (!owner || access.isOwner) ? access : null;
  }

  async projects() {
    const rows = await cloudData("Failed to load projects", this.db.from("projects")
      .select("*")) as Project[] | null;
    return (rows ?? []).flatMap((row) => {
      const access = this.projectAccess(row);
      return access ? [access] : [];
    });
  }

  async document(id: string, owner = false) {
    const row = await this.row("Failed to load document", this.db.from("documents")
      .select("*").eq("id", id).maybeSingle()) as Document | null;
    if (!row) return null;
    const isOwner = row.user_id === this.userId;
    const allowed = isOwner || (!!row.project_id && !!await this.project(row.project_id));
    return allowed && (!owner || isOwner) ? { row, isOwner } : null;
  }

  async documents(ids: string[]) {
    if (!ids.length) return [];
    const rows = await cloudData("Failed to load documents", this.db.from("documents")
      .select("*").in("id", [...new Set(ids)])) as Document[] | null;
    const projects = new Map((await this.projects()).map((access) => [access.row.id, access]));
    return (rows ?? []).flatMap((row): CloudAccess<Document>[] => {
      const isOwner = row.user_id === this.userId;
      return isOwner || (!!row.project_id && projects.has(row.project_id))
        ? [{ row, isOwner }] : [];
    });
  }

  async review(id: string, owner = false) {
    const row = await this.row("Failed to load review", this.db.from("tabular_reviews")
      .select("*").eq("id", id).maybeSingle()) as Review | null;
    if (!row) return null;
    const isOwner = row.user_id === this.userId;
    const allowed = isOwner || shared(row.shared_with, this.userEmail) ||
      (!!row.project_id && !!await this.project(row.project_id));
    return allowed && (!owner || isOwner) ? { row, isOwner } : null;
  }

  async chat(id: string, owner = false) {
    const row = await this.row("Failed to load chat", this.db.from("chats")
      .select("*").eq("id", id).is("deleted_at", null).maybeSingle()) as Chat | null;
    if (!row) return null;
    const isOwner = row.user_id === this.userId;
    const allowed = isOwner || (!!row.project_id && !!await this.project(row.project_id)) ||
      (!!row.tabular_review_id && !!await this.review(row.tabular_review_id));
    return allowed && (!owner || isOwner) ? { row, isOwner } : null;
  }
}

export const cloudScope = (identity: Identity, db?: Db) => new CloudScope(identity, db);
