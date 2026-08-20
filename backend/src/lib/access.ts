import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;
type Identity = { userId: string; userEmail?: string | null };
type Row = Record<string, any> & { id: string; user_id: string };
type Project = Row & { shared_with?: unknown }; type Document = Row & { project_id: string | null };
type Review = Document & { shared_with?: unknown }; type Chat = Row & { project_id: string | null; tabular_review_id: string | null };
export type CloudAccess<T extends Row = Row> = { row: T; isOwner: boolean };

const email = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** Run a provider query without exposing provider diagnostics to HTTP callers. */
async function cloudData<T>(
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

  private async owned<T extends Row>(table: string, id: string) {
    return this.row(`Failed to load ${table}`, this.db.from(table).select("*")
      .eq("id", id).eq("user_id", this.userId).maybeSingle()) as Promise<T | null>;
  }

  async project(id: string, owner = false) {
    const access = (await this.projects()).find(({ row }) => row.id === id) ?? null;
    return access && (!owner || access.isOwner) ? access : null;
  }

  async projects() {
    const [owned, sharedRows] = await Promise.all([
      cloudData("Failed to load projects", this.db.from("projects")
        .select("*").eq("user_id", this.userId)) as Promise<Project[] | null>,
      this.userEmail ? cloudData("Failed to load shared projects", this.db.from("projects")
        .select("*").contains("shared_with", [this.userEmail])) as Promise<Project[] | null> : [],
    ]);
    return [...(owned ?? []).map((row) => ({ row, isOwner: true })),
      ...(sharedRows ?? []).filter((row) => row.user_id !== this.userId)
        .map((row) => ({ row, isOwner: false }))];
  }

  async document(id: string, owner = false) {
    const access = (await this.documents([id]))[0] ?? null;
    return access && (!owner || access.isOwner) ? access : null;
  }

  async documents(ids: string[]) {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const projectIds = (await this.projects()).map(({ row }) => row.id);
    const [owned, sharedRows] = await Promise.all([
      cloudData("Failed to load documents", this.db.from("documents").select("*")
        .in("id", unique).eq("user_id", this.userId)) as Promise<Document[] | null>,
      projectIds.length ? cloudData("Failed to load shared documents", this.db.from("documents")
        .select("*").in("id", unique).in("project_id", projectIds)) as Promise<Document[] | null> : [],
    ]);
    return [...(owned ?? []).map((row) => ({ row, isOwner: true })),
      ...(sharedRows ?? []).filter((row) => row.user_id !== this.userId)
        .map((row) => ({ row, isOwner: false }))];
  }

  async review(id: string, owner = false) {
    const owned = await this.owned<Review>("tabular_reviews", id);
    if (owned) return { row: owned, isOwner: true };
    if (owner) return null;
    const projectIds = (await this.projects()).map(({ row }) => row.id);
    const [direct, project] = await Promise.all([
      this.userEmail ? this.row("Failed to load shared review", this.db.from("tabular_reviews")
        .select("*").eq("id", id).contains("shared_with", [this.userEmail]).maybeSingle()) : null,
      projectIds.length ? this.row("Failed to load project review", this.db.from("tabular_reviews")
        .select("*").eq("id", id).in("project_id", projectIds).maybeSingle()) : null,
    ]);
    const row = (direct ?? project) as Review | null;
    return row ? { row, isOwner: false } : null;
  }

  async chat(id: string, owner = false) {
    const owned = await this.row("Failed to load chat", this.db.from("chats").select("*")
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).maybeSingle()) as Chat | null;
    if (owned) return { row: owned, isOwner: true };
    if (owner) return null;
    const projectIds = (await this.projects()).map(({ row }) => row.id);
    const reviews = this.userEmail ? await cloudData("Failed to load shared reviews",
      this.db.from("tabular_reviews").select("id").contains("shared_with", [this.userEmail])) as { id: string }[] | null : [];
    const reviewIds = (reviews ?? []).map(({ id }) => id);
    const [project, review] = await Promise.all([
      projectIds.length ? this.row("Failed to load project chat", this.db.from("chats").select("*")
        .eq("id", id).in("project_id", projectIds).is("deleted_at", null).maybeSingle()) : null,
      reviewIds.length ? this.row("Failed to load review chat", this.db.from("chats").select("*")
        .eq("id", id).in("tabular_review_id", reviewIds).is("deleted_at", null).maybeSingle()) : null,
    ]);
    const row = (project ?? review) as Chat | null;
    return row ? { row, isOwner: false } : null;
  }
}

export const cloudScope = (identity: Identity, db?: Db) => new CloudScope(identity, db);
