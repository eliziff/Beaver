import type { ApplicationScope } from "./applicationError";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql,
  type RelationalDatabase, type SqlStatement } from "./relationalDatabase";
import { searchFilter } from "./searchQuery";
import { tabularSubjectId, type TabularSelection } from "./tabularStore";

export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const email = (scope: ApplicationScope) => scope.userEmail?.trim().toLowerCase() || "";
export const rows = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query<T>(statement)).rows;
export const one = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await rows<T>(statement, db))[0] ?? null;
export const changes = async (statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query(statement)).changes;

/** Sources are already authorized; both expose parent_folder_id for browsing. */
export async function directoryPage<F>(options: { q: string; parentFolderId: string | null;
  limit: number; after: [number, string, string] | null; documentsOnly?: boolean },
  sources: { folders: ReturnType<typeof sql>; documents: ReturnType<typeof sql> },
  folder: (row: Row) => F) {
  const search = options.q || options.documentsOnly, after = options.after;
  const documents = sql`SELECT 'document' kind,id,1 bucket,lower(filename) sort_name,
    NULL name,NULL parent_folder_id,NULL created_at,NULL updated_at FROM (${sources.documents}) d
    WHERE ${options.q ? searchFilter(sql`lower(filename)`, options.q) : search ? sql.raw("1=1")
      : sql`COALESCE(parent_folder_id,'')=${options.parentFolderId ?? ""}`}`;
  const entries = search ? documents : sql`SELECT 'folder' kind,id,0 bucket,
    lower(name) sort_name,name,parent_folder_id,created_at,updated_at FROM (${sources.folders}) f
    WHERE COALESCE(parent_folder_id,'')=${options.parentFolderId ?? ""} UNION ALL ${documents}`;
  const seek = after ? sql`AND (bucket>${after[0]} OR (bucket=${after[0]} AND
    (sort_name>${after[1]} OR (sort_name=${after[1]} AND id>${after[2]}))))` : sql.raw("");
  const result = await rows(sql`SELECT * FROM (${entries}) entries WHERE 1=1 ${seek}
    ORDER BY bucket,sort_name,id LIMIT ${options.limit + 1}`);
  const page = result.slice(0, options.limit), last = page.at(-1);
  return { items: page.map((row) => row.kind === "folder"
    ? { kind: "folder" as const, folder: folder(row) }
    : { kind: "document" as const, id: String(row.id) }),
  nextAfter: result.length > options.limit && last
    ? [Number(last.bucket), String(last.sort_name), String(last.id)] as [number, string, string] : null };
}

export async function queueObjectCleanup(db: RelationalDatabase, keys: string[]) {
  const unique = [...new Set(keys)];
  const createdAt = new Date(0).toISOString(); // Dereferenced blobs are ready; existing upload reservations keep their grace period.
  for (let start = 0; start < unique.length; start += 250) {
    const batch = unique.slice(start, start + 250);
    await changes(sql`INSERT INTO object_cleanup(storage_path,created_at) VALUES
      ${sql.join(batch.map((key) => sql`(${key},${createdAt})`))}
      ON CONFLICT(storage_path) DO NOTHING`, db);
  }
}

export async function deleteDocumentRows(db: RelationalDatabase, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return 0;
  const selected = new Set(unique);
  const reviews = new Map<string, { id: string; document_ids: unknown; scope_config: unknown }>();
  for (let start = 0; start < unique.length; start += 250) {
    const batch = unique.slice(start, start + 250);
    for (const review of await rows<{ id: string; document_ids: unknown; scope_config: unknown }>(
      db.engine === "postgres" ? sql`SELECT id,document_ids,scope_config FROM tabular_reviews
        WHERE document_ids ?| ARRAY[${sql.join(batch)}] OR
          EXISTS(SELECT 1 FROM jsonb_array_elements(scope_config->'subjects') subject
            WHERE subject->'reference'->>'kind'='document' AND subject->'reference'->>'id' IN(${sql.join(batch)})) OR
          scope_config->>'research_file_id' IN(${sql.join(batch)}) ORDER BY id FOR UPDATE`
        : sql`SELECT id,document_ids,scope_config FROM tabular_reviews WHERE EXISTS(
          SELECT 1 FROM json_each(tabular_reviews.document_ids)
          WHERE value IN(${sql.join(batch)})) OR
          EXISTS(SELECT 1 FROM json_each(tabular_reviews.scope_config,'$.subjects') subject
            WHERE subject.value->>'$.reference.kind'='document' AND subject.value->>'$.reference.id' IN(${sql.join(batch)})) OR
          scope_config->>'research_file_id' IN(${sql.join(batch)}) ORDER BY id`, db)) reviews.set(review.id, review);
  }
  for (const review of reviews.values()) {
    const current = decode<string[]>(review.document_ids, []), selection = decode<TabularSelection>(review.scope_config, { subjects: [] }),
      removed = new Set([...current.filter((id) => selected.has(id)), ...selection.subjects.filter(({ reference }) =>
        reference.kind === "document" && selected.has(reference.id)).map(tabularSubjectId)]),
      next = current.filter((id) => !removed.has(id));
    selection.subjects = selection.subjects.filter((subject) => !removed.has(tabularSubjectId(subject)));
    if (selection.research_file_id && selected.has(selection.research_file_id)) {
      delete selection.research_file_id; delete selection.selection; delete selection.arrangement; delete selection.findings;
    } else if (selection.arrangement) {
      selection.arrangement.rows = selection.arrangement.rows.filter(({ id }) => !removed.has(id));
      selection.arrangement.cells = selection.arrangement.cells.filter(({ rowId }) => !removed.has(rowId));
    }
    for (const rowId of removed) await changes(sql`DELETE FROM tabular_cells WHERE review_id=${review.id} AND document_id=${rowId}`, db);
    await changes(sql`UPDATE tabular_reviews SET document_ids=${encode(next)},
      scope_config=${encode(selection)},updated_at=${now()} WHERE id=${review.id}`, db);
  }
  let deleted = 0;
  for (let start = 0; start < unique.length; start += 250) {
    const batch = unique.slice(start, start + 250);
    await changes(sql`UPDATE chats SET research_selection=${null} WHERE research_file_id IN(${sql.join(batch)})`, db);
    await changes(sql`DELETE FROM tabular_cells WHERE document_id IN(${sql.join(batch)})`, db);
    const objects = await rows<{ storage_path: string }>(sql`
      SELECT v.storage_path FROM document_versions v WHERE v.document_id IN(${sql.join(batch)})
      UNION SELECT v.pdf_storage_path FROM document_versions v
        WHERE v.document_id IN(${sql.join(batch)})
          AND v.pdf_storage_path IS NOT NULL
      UNION SELECT p.storage_path FROM document_version_parts p
        WHERE p.document_id IN(${sql.join(batch)})`, db);
    await queueObjectCleanup(db, objects.map(({ storage_path }) => storage_path));
    deleted += await changes(sql`DELETE FROM documents WHERE id IN(${sql.join(batch)})`, db);
  }
  return deleted;
}

export const projectAccess = (scope: ApplicationScope, owner = false) => owner || !email(scope)
  ? sql`p.user_id=${scope.userId}`
  : sql`(p.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM project_members pm
      WHERE pm.project_id=p.id AND pm.email=${email(scope)}))`;
export const reviewAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`r.user_id=${scope.userId}`
  : sql`(r.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM tabular_review_members rm
      WHERE rm.review_id=r.id AND rm.email=${email(scope)}) OR EXISTS(
      SELECT 1 FROM projects p WHERE p.id=r.project_id AND ${projectAccess(scope)}))`;
export const documentAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`d.user_id=${scope.userId}`
  : sql`(d.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=d.project_id AND ${projectAccess(scope)}))`;
export const chatAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`c.user_id=${scope.userId}`
  : sql`(c.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=c.project_id AND ${projectAccess(scope)}) OR EXISTS(
      SELECT 1 FROM tabular_reviews r WHERE r.id=c.tabular_review_id
        AND ${reviewAccess(scope)}))`;

// Callers must authorize the resource before hydrating its owner and direct members.
export async function resourcePeople(db: RelationalDatabase, ownerId: string, shared: string[]) {
  const profiles = db.engine === "postgres" ? await rows<{ user_id: string; email: string | null;
    display_name: string | null }>(sql`SELECT p.user_id,p.email,u.display_name
    FROM user_profiles p LEFT JOIN user_preferences u ON u.user_id=p.user_id
    WHERE p.user_id=${ownerId} OR lower(p.email) IN(${sql.join(shared)})`, db) : [];
  const owner = profiles.find(({ user_id }) => user_id === ownerId);
  const byEmail = new Map(profiles.flatMap((profile) => profile.email
    ? [[profile.email.toLowerCase(), profile.display_name] as const] : []));
  return { owner: { user_id: ownerId, email: owner?.email ?? null,
    display_name: owner?.display_name ?? null }, members: shared.map((value) => ({
      email: value, display_name: byEmail.get(value) ?? null })) };
}

export async function missingProfileEmail(db: RelationalDatabase, emails: string[]) {
  if (db.engine === "sqlite") return emails[0] ?? null;
  const normalized = [...new Set(emails.map((value) => value.trim().toLowerCase()))];
  if (!normalized.length) return null;
  const found = new Set((await rows<{ email: string }>(sql`SELECT lower(email) email
    FROM user_profiles WHERE lower(email) IN(${sql.join(normalized)})`, db))
    .map(({ email: value }) => value));
  return normalized.find((value) => !found.has(value)) ?? null;
}
export async function replaceMembers(db: RelationalDatabase, table: "project_members" |
  "tabular_review_members", id: string, emails: string[]) {
  if (db.engine === "postgres") return;
  const foreignKey = table === "project_members" ? "project_id" : "review_id";
  await changes(sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(foreignKey)}=${id}`, db);
  for (const value of [...new Set(emails.map((item) => item.trim().toLowerCase()))]) {
    await changes(sql`INSERT INTO ${sql.raw(table)}(${sql.raw(foreignKey)},email)
      VALUES(${id},${value})`, db);
  }
}
