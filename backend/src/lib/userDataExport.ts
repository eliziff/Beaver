import { ApplicationError, type ApplicationScope } from "./applicationError";
import { sql, type RelationalDatabase, type SqlStatement } from "./relational";
import { chatAccess, documentAccess, projectAccess, reviewAccess, workflowAccessPredicate } from "./resourceAccess";
import type { UserExportKind } from "./userApplication";
import { canonicalJsonSha256 } from "./hash";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
type Row = Record<string, unknown>;

/** A consistent, permission-scoped snapshot. Credentials and invitation secrets never enter it. */
export async function buildUserDataExport(database: RelationalDatabase, kind: UserExportKind, scope: ApplicationScope) {
  return database.transaction(async (db) => {
    if (db.engine === "postgres") await db.query(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
    let bytes = 0;
    const read = async (query: SqlStatement) => {
      const result: Row[] = [];
      for (let offset = 0; ; offset += 250) {
        const batch = (await db.query({ text: `${query.text} LIMIT 250 OFFSET ${offset}`, params: query.params })).rows;
        bytes += Buffer.byteLength(JSON.stringify(batch));
        if (bytes > MAX_EXPORT_BYTES) throw new ApplicationError(413, "Export exceeds the safe in-memory size limit");
        result.push(...batch);
        if (batch.length < 250) return result;
      }
    };
    const ids = (rows: Row[]) => sql.join(rows.map((row) => String(row.id)));
    const children = (table: string, column: string, parents: Row[]) => parents.length
      ? read(sql`SELECT * FROM ${sql.raw(table)} WHERE ${sql.raw(column)} IN(${ids(parents)}) ORDER BY ${sql.raw(column)}`)
      : Promise.resolve([] as Row[]);
    const data: Record<string, unknown> = { exported_at: new Date().toISOString(),
      user: { id: scope.userId, email: scope.userEmail ?? null } };
    const chats = await read(sql`SELECT c.* FROM chats c WHERE c.user_id=${scope.userId}
      AND ${chatAccess(scope)} ORDER BY c.created_at,c.id`);
    const reviews = kind === "chats" ? [] : await read(sql`SELECT r.* FROM tabular_reviews r
      WHERE r.user_id=${scope.userId} AND ${reviewAccess(scope)} ORDER BY r.created_at,r.id`);
    if (kind === "tabular-reviews") {
      const reviewChats = reviews.length ? await read(sql`SELECT c.* FROM chats c
        WHERE c.tabular_review_id IN(${ids(reviews)}) AND ${chatAccess(scope)} ORDER BY c.created_at,c.id`) : [];
      chats.splice(0, chats.length, ...reviewChats);
    }
    const messages = await children("chat_messages", "chat_id", chats);
    data.chats = { chats, messages, events: await children("chat_message_events", "message_id", messages) };
    if (kind !== "chats") {
      data.tabular_reviews = reviews;
      data.tabular_cells = await children("tabular_cells", "review_id", reviews);
      data.tabular_changes = await children("tabular_changes", "review_id", reviews);
    }
    if (kind === "account") {
      const projects = await read(sql`SELECT p.* FROM projects p WHERE p.user_id=${scope.userId}
        AND ${projectAccess(scope)} ORDER BY p.created_at,p.id`);
      const documents = await read(sql`SELECT d.* FROM documents d WHERE
        (d.user_id=${scope.userId} OR d.project_id IN(${ids(projects)}))
        AND ${documentAccess(scope)} ORDER BY d.created_at,d.id`);
      data.projects = projects;
      data.project_subfolders = await children("project_subfolders", "project_id", projects);
      data.documents = documents;
      for (const table of ["document_versions", "document_version_parts", "document_edits"])
        data[table] = await children(table, "document_id", documents);
      const workflows = await read(sql`SELECT w.* FROM workflows w WHERE w.user_id=${scope.userId}
        AND ${workflowAccessPredicate(scope)} ORDER BY w.created_at,w.id`);
      data.workflows = workflows;
      data.workflow_shares = await children("workflow_shares", "workflow_id", workflows);
      data.workflow_open_source_submissions = await children("workflow_open_source_submissions", "workflow_id", workflows);
      data.work_products = await read(sql`SELECT w.* FROM work_products w WHERE w.user_id=${scope.userId}
        AND (w.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=w.project_id AND ${projectAccess(scope)})) ORDER BY w.id`);
      for (const table of ["audit_events", "user_preferences"])
        data[table] = await read(sql`SELECT * FROM ${sql.raw(table)} WHERE user_id=${scope.userId} ORDER BY user_id`);
      data.api_keys = await read(sql`SELECT provider,created_at,updated_at FROM user_api_keys
        WHERE user_id=${scope.userId} ORDER BY provider`);
      data.organizations = await read(sql`SELECT o.*,m.role FROM organizations o JOIN org_members m
        ON m.org_id=o.id WHERE m.user_id=${scope.userId} ORDER BY o.id`);
      data.shared_access = {
        projects: await read(sql`SELECT p.id,p.name,p.org_id FROM projects p WHERE p.user_id<>${scope.userId} AND ${projectAccess(scope)} ORDER BY p.id`),
        tabular_reviews: await read(sql`SELECT r.id,r.title,r.project_id FROM tabular_reviews r WHERE r.user_id<>${scope.userId} AND ${reviewAccess(scope)} ORDER BY r.id`),
      };
    }
    return { filename: `beaver-${kind}-export-${scope.userId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      data: { format: "beaver-account-export", version: 1, data, integrity: { algorithm: "sha256", payload_sha256: canonicalJsonSha256(data) } } };
  });
}
