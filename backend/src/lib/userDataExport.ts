import { ApplicationError, type ApplicationScope } from "./applicationError";
import { sql, type RelationalDatabase, type SqlStatement } from "./relational";
import { chatAccess, documentAccess, projectAccess, reviewAccess, workflowAccessPredicate } from "./resourceAccess";
import type { UserExportKind } from "./userApplication";
import { sealExport } from "mike/shared/export-integrity.mjs";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
type Row = Record<string, unknown>;

function snapshotReader(db: RelationalDatabase) {
  let bytes = 0;
  return async (query: SqlStatement) => {
    const result: Row[] = [];
    for (let offset = 0; ; offset += 250) {
      const batch = (await db.query({ text: `${query.text} LIMIT 250 OFFSET ${offset}`, params: query.params })).rows;
      bytes += Buffer.byteLength(JSON.stringify(batch));
      if (bytes > MAX_EXPORT_BYTES) throw new ApplicationError(413, "Export exceeds the safe in-memory size limit");
      result.push(...batch);
      if (batch.length < 250) return result;
    }
  };
}

/** A consistent, permission-scoped snapshot. Credentials and invitation secrets never enter it. */
export async function buildUserDataExport(database: RelationalDatabase, kind: UserExportKind, scope: ApplicationScope) {
  return database.transaction(async (db) => {
    if (db.engine === "postgres") await db.query(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
    const read = snapshotReader(db);
    const ids = (rows: Row[]) => sql.join(rows.map((row) => String(row.id)));
    const children = (table: string, column: string, parents: Row[]) => parents.length
      ? read(sql`SELECT * FROM ${sql.raw(table)} WHERE ${sql.raw(column)} IN(${ids(parents)})
          ORDER BY ${sql.raw(column)},${sql.raw(table === "chat_message_events" ? "ordinal"
            : table === "document_version_parts" ? "version_id,name" : table === "workflow_documents" ? "document_id" : "id")}`)
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
        (d.user_id=${scope.userId} OR d.project_id IN(${ids(projects)}) OR d.id IN(
          SELECT wd.document_id FROM workflow_documents wd JOIN workflows w ON w.id=wd.workflow_id
          WHERE w.user_id=${scope.userId} AND ${workflowAccessPredicate(scope)}))
        AND ${documentAccess(scope)} ORDER BY d.created_at,d.id`);
      data.projects = projects;
      data.project_subfolders = await children("project_subfolders", "project_id", projects);
      data.documents = documents;
      for (const table of ["document_versions", "document_version_parts", "document_edits"])
        data[table] = await children(table, "document_id", documents);
      const workflows = await read(sql`SELECT w.* FROM workflows w WHERE w.user_id=${scope.userId}
        AND ${workflowAccessPredicate(scope)} ORDER BY w.created_at,w.id`);
      data.workflows = workflows;
      data.workflow_documents = await children("workflow_documents", "workflow_id", workflows);
      data.workflow_shares = await children("workflow_shares", "workflow_id", workflows);
      data.workflow_open_source_submissions = await children("workflow_open_source_submissions", "workflow_id", workflows);
      data.work_products = await read(sql`SELECT w.* FROM work_products w WHERE w.user_id=${scope.userId}
        AND (w.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=w.project_id AND ${projectAccess(scope)})) ORDER BY w.id`);
      for (const table of ["audit_events", "user_preferences"])
        data[table] = await read(sql`SELECT * FROM ${sql.raw(table)} WHERE user_id=${scope.userId}
          ORDER BY ${sql.raw(table === "audit_events" ? "id" : "user_id")}`);
      data.api_keys = await read(sql`SELECT provider,created_at,updated_at FROM user_api_keys
        WHERE user_id=${scope.userId} ORDER BY provider`);
      data.memory = await read(sql`SELECT m.* FROM memory_files m WHERE
        (m.scope='app' AND m.owner_id=${scope.userId}) OR (m.scope='project' AND EXISTS(
          SELECT p.id FROM projects p WHERE p.id=m.project_id AND ${projectAccess(scope)})) ORDER BY m.scope,m.owner_id`);
      data.organizations = await read(sql`SELECT o.*,m.role FROM organizations o JOIN org_members m
        ON m.org_id=o.id WHERE m.user_id=${scope.userId} ORDER BY o.id`);
      data.shared_access = {
        projects: await read(sql`SELECT p.id,p.name,p.org_id FROM projects p WHERE p.user_id<>${scope.userId} AND ${projectAccess(scope)} ORDER BY p.id`),
        tabular_reviews: await read(sql`SELECT r.id,r.title,r.project_id FROM tabular_reviews r WHERE r.user_id<>${scope.userId} AND ${reviewAccess(scope)} ORDER BY r.id`),
      };
    }
    return { filename: `beaver-${kind}-export-${scope.userId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      data: sealExport({ format: "beaver-account-export", version: 1, data }) };
  });
}

/** A manifest describes captured source bytes and edit decisions; it does not package file bytes. */
export async function buildProjectExportManifest(database: RelationalDatabase, scope: ApplicationScope, projectId: string) {
  return database.transaction(async (db) => {
    if (db.engine === "postgres") await db.query(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
    const read = snapshotReader(db);
    const project = (await read(sql`SELECT p.id,p.name,p.cm_number,p.practice,p.created_at,p.updated_at
      FROM projects p WHERE p.id=${projectId} AND ${projectAccess(scope)} ORDER BY p.id`))[0];
    if (!project) throw new ApplicationError(404, "Project not found");
    const documents = await read(sql`SELECT d.id,d.filename,d.folder_id,d.current_version_id,d.created_at,d.updated_at
      FROM documents d WHERE d.project_id=${projectId} AND ${documentAccess(scope)} ORDER BY d.id`);
    const versions = await read(sql`SELECT v.id,v.document_id,v.parent_version_id,v.version_number,v.working_revision,
      v.source,v.created_by,v.author_email,v.comment,v.created_at,v.filename,v.file_type,v.size_bytes,v.source_sha256,v.provenance
      FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.project_id=${projectId}
      AND ${documentAccess(scope)} ORDER BY v.document_id,v.version_number,v.id`);
    const edits = await read(sql`SELECT e.* FROM document_edits e JOIN documents d ON d.id=e.document_id
      WHERE d.project_id=${projectId} AND ${documentAccess(scope)} ORDER BY e.document_id,e.version_id,e.id`);
    const parts = await read(sql`SELECT v.document_id,v.version_id,v.name,v.size_bytes,v.sha256
      FROM document_version_parts v JOIN documents d ON d.id=v.document_id
      WHERE d.project_id=${projectId} AND ${documentAccess(scope)} ORDER BY v.version_id,v.name`);
    return sealExport({ format: "beaver-project-manifest", version: 1, data: {
      exported_at: new Date().toISOString(), project, documents, document_versions: versions,
      document_edits: edits, document_version_parts: parts,
    } });
  });
}
