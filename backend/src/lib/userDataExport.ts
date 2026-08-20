import { ApplicationError } from "./applicationError";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;
type Row = Record<string, unknown>;
const PAGE_SIZE = 250;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export function userExportFilename(kind: "account" | "chats" | "tabular-reviews",
  userId: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `beaver-${kind}-export-${userId.slice(0, 8)}-${stamp}.json`;
}

const idsFrom = (rows: Row[], column = "id") => [...new Set(rows.flatMap((row) =>
  typeof row[column] === "string" ? [row[column] as string] : []))];

function exportReader(db: Db) {
  let bytes = 0;
  const all = async (table: string, configure: (query: any) => any,
    columns = "*"): Promise<Row[]> => {
    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await configure((db as any).from(table).select(columns)
        .range(from, from + PAGE_SIZE - 1));
      if (error) throw new Error(`Failed to export ${table}`);
      const batch = (data ?? []) as Row[];
      bytes += Buffer.byteLength(JSON.stringify(batch));
      if (bytes > MAX_EXPORT_BYTES) throw new ApplicationError(413,
        "Export exceeds the safe in-memory size limit");
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return rows;
  };
  const byIds = (table: string, column: string, ids: string[]) => ids.length
    ? all(table, (query) => query.in(column, ids)) : Promise.resolve([] as Row[]);
  return { all, byIds };
}
type Reader = ReturnType<typeof exportReader>;

async function loadUserChats(read: Reader, userId: string) {
  const chats = await read.all("chats", (query) => query.eq("user_id", userId)
    .order("created_at", { ascending: true }));
  return { chats, messages: await read.byIds("chat_messages", "chat_id", idsFrom(chats)) };
}

const exportHeader = (userId: string, userEmail?: string | null) => ({
  exported_at: new Date().toISOString(),
  user: { id: userId, email: userEmail ?? null },
});

export async function buildUserChatsExport(db: Db, userId: string,
  userEmail?: string | null) {
  return { ...exportHeader(userId, userEmail),
    chats: await loadUserChats(exportReader(db), userId) };
}

export async function buildUserTabularReviewsExport(db: Db, userId: string,
  userEmail?: string | null) {
  const read = exportReader(db);
  const tabularReviews = await read.all("tabular_reviews", (query) =>
    query.eq("user_id", userId).order("created_at", { ascending: true }));
  const [cells, chats] = await Promise.all([
    read.byIds("tabular_cells", "review_id", idsFrom(tabularReviews)),
    read.byIds("chats", "tabular_review_id", idsFrom(tabularReviews)),
  ]);
  return { ...exportHeader(userId, userEmail), tabular_reviews: tabularReviews,
    tabular_cells: cells, chats: { chats,
      messages: await read.byIds("chat_messages", "chat_id", idsFrom(chats)) } };
}

export async function buildUserAccountExport(db: Db, userId: string,
  userEmail?: string | null) {
  const read = exportReader(db);
  const owned = (table: string, order = "created_at") => read.all(table, (query) =>
    query.eq("user_id", userId).order(order, { ascending: true }));
  const shared = (table: string, columns: string) => userEmail
    ? read.all(table, (query) => query.filter("shared_with", "cs",
      JSON.stringify([userEmail])).neq("user_id", userId)
      .order("created_at", { ascending: true }), columns)
    : Promise.resolve([] as Row[]);
  const apiKeyStatus = read.all("user_api_keys", (query) => query.eq("user_id", userId)
    .order("provider", { ascending: true }), "provider, created_at, updated_at")
    .then((rows) => rows.map(({ provider, created_at, updated_at }) =>
      ({ provider, has_key: true, created_at, updated_at })));
  const [profile, apiKeys, projects, standaloneDocuments, workflows,
    workflowOpenSourceSubmissions, hiddenWorkflows, workflowSharesByUser,
    workflowSharesWithUser, assistantChats, tabularReviews, sharedProjects,
    sharedTabularReviews, auditEvents] = await Promise.all([
    read.all("user_profiles", (query) => query.eq("user_id", userId)),
    apiKeyStatus, owned("projects"),
    read.all("documents", (query) => query.eq("user_id", userId)
      .is("project_id", null).order("created_at", { ascending: true })),
    owned("workflows"),
    read.all("workflow_open_source_submissions", (query) =>
      query.eq("submitted_by_user_id", userId).order("submitted_at", { ascending: true })),
    owned("hidden_workflows"),
    read.all("workflow_shares", (query) => query.eq("shared_by_user_id", userId)
      .order("created_at", { ascending: true })),
    userEmail ? read.all("workflow_shares", (query) =>
      query.eq("shared_with_email", userEmail).order("created_at", { ascending: true })) : [],
    loadUserChats(read, userId), owned("tabular_reviews"),
    shared("projects", "id, user_id, name, cm_number, created_at, updated_at"),
    shared("tabular_reviews",
      "id, user_id, project_id, title, practice, created_at, updated_at"),
    owned("audit_events"),
  ]);
  const projectIds = idsFrom(projects);
  const projectDocuments = await read.byIds("documents", "project_id", projectIds);
  const documents = [...standaloneDocuments, ...projectDocuments];
  const [folders, versions, edits, tabularCells] = await Promise.all([
    read.byIds("project_subfolders", "project_id", projectIds),
    read.byIds("document_versions", "document_id", idsFrom(documents)),
    read.byIds("document_edits", "document_id", idsFrom(documents)),
    read.byIds("tabular_cells", "review_id", idsFrom(tabularReviews)),
  ]);
  return { ...exportHeader(userId, userEmail), profile, api_keys: apiKeys, projects,
    project_subfolders: folders, documents, document_versions: versions,
    document_edits: edits, workflows,
    workflow_open_source_submissions: workflowOpenSourceSubmissions,
    hidden_workflows: hiddenWorkflows, workflow_shares_by_user: workflowSharesByUser,
    workflow_shares_with_user: workflowSharesWithUser, chats: assistantChats,
    tabular_reviews: tabularReviews, tabular_cells: tabularCells,
    shared_access: { projects: sharedProjects, tabular_reviews: sharedTabularReviews },
    audit_events: auditEvents };
}
