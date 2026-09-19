import { projectRoleRank, roleFromRank } from "./resourceAccess";
import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { ProjectFolder, ProjectRecord, ProjectRepository } from "./projectStore";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, deleteDocumentRows, directoryPage, missingProfileEmail, now, one, projectAccess,
  replaceMembers, resourcePeople, rows, type Row } from "./relationalRepositorySupport";
import { searchFilter } from "./searchQuery";

const projectRecord = (_scope: ApplicationScope, row: Row): ProjectRecord => ({
  id: String(row.id), user_id: String(row.user_id), name: String(row.name),
  org_id: typeof row.org_id === "string" ? row.org_id : null,
  cm_number: row.cm_number ?? null, practice: row.practice ?? null,
  metadata: decode(row.metadata, {}), notes: row.notes ?? null,
  shared_with: decode<string[]>(row.shared_with, []),
  created_at: String(row.created_at), updated_at: String(row.updated_at),
  is_owner: Number(row.access_rank) === 3, role: roleFromRank(row.access_rank),
  owner_email: row.owner_email ?? null, owner_display_name: row.owner_display_name ?? null,
});
async function findProject(scope: ApplicationScope, id: string, owner: boolean | "edit" = false,
  db?: RelationalDatabase, lock: "share" | "update" | false = false) {
  const row = await one(sql`SELECT p.*,${projectRoleRank(scope)} access_rank FROM projects p WHERE p.id=${id}
    AND ${projectAccess(scope, owner === "edit" ? "edit" : owner ? "owner" : "view")}
    ${lock && db?.engine === "postgres"
      ? sql.raw(`FOR ${lock.toUpperCase()} OF p`) : sql.raw("")}`, db);
  return row ? projectRecord(scope, row) : null;
}
const projectFolder = (row: Row): ProjectFolder => ({ ...row, id: String(row.id),
  name: String(row.name), parent_folder_id: row.parent_folder_id ?? null });
async function findProjectFolder(scope: ApplicationScope, projectId: string, id: string,
  db?: RelationalDatabase) {
  const row = await one(sql`SELECT f.* FROM project_subfolders f JOIN projects p
    ON p.id=f.project_id WHERE f.id=${id} AND f.project_id=${projectId}
      AND ${projectAccess(scope)}`, db);
  return row ? projectFolder(row) : null;
}
export const projectRepository: ProjectRepository = {
  async page(scope, options) {
    const access = options.scope === "mine" ? sql`p.user_id=${scope.userId}`
      : options.scope === "shared-with-me" ? sql`p.user_id<>${scope.userId}`
        : projectAccess(scope);
    const result = await rows(sql`SELECT p.*,${projectRoleRank(scope)} access_rank FROM projects p WHERE ${access} AND ${projectAccess(scope)}
      ${options.q ? sql`AND ${searchFilter(sql`lower(p.name||' '||COALESCE(p.cm_number,'')||' '||COALESCE(p.practice,''))`, options.q)}` : sql.raw("")}
      ${options.after ? sql`AND (p.created_at<${options.after[0]} OR
        (p.created_at=${options.after[0]} AND p.id<${options.after[1]}))` : sql.raw("")}
      ORDER BY p.created_at DESC,p.id DESC LIMIT ${options.limit + 1}`);
    const items = result.slice(0, options.limit).map((row) => projectRecord(scope, row));
    const last = items.at(-1);
    return { items, nextAfter: result.length > options.limit && last
      ? [String(last.created_at), last.id] : null };
  },
  async missingRecipient(_scope, emails) {
    return missingProfileEmail(await relationalDatabase(), emails);
  },
  async create(scope, input) {
    const db = await relationalDatabase(), id = randomUUID(), created = now();
    return db.transaction(async (tx) => {
      await changes(sql`INSERT INTO projects(id,user_id,name,cm_number,practice,shared_with,
        metadata,notes,created_at,updated_at) VALUES(${id},${scope.userId},${input.name},
        ${input.cmNumber},${input.practice},${encode(input.sharedWith)},
        ${encode(input.metadata ?? {})},${input.notes ?? null},${created},${created})`, tx);
      await replaceMembers(tx, "project_members", id, input.sharedWith);
      return (await findProject(scope, id, true, tx))!;
    });
  },
  async directory(scope, projectId, options) {
    if (!await findProject(scope, projectId)) return { items: [], nextAfter: null };
    return directoryPage(options, {
      folders: sql`SELECT * FROM project_subfolders WHERE project_id=${projectId}`,
      documents: sql`SELECT id,filename,folder_id parent_folder_id FROM documents
        WHERE project_id=${projectId}`,
    }, (row) => projectFolder({ ...row, project_id: projectId }));
  },
  project: findProject,
  async people(scope, id) {
    const project = await findProject(scope, id);
    return project ? resourcePeople(await relationalDatabase(),
      String(project.user_id), project.shared_with as string[]) : null;
  },
  async update(scope, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findProject(scope, id, true, tx, "update");
      if (!current) return null;
      if (current.org_id && input.sharedWith) throw new ApplicationError(409, "Manage access through the organization.");
      const shared = input.sharedWith ?? current.shared_with as string[];
      await changes(sql`UPDATE projects SET name=${input.name ?? String(current.name)},
        cm_number=${input.cmNumber === undefined ? current.cm_number as string | null : input.cmNumber},
        practice=${input.practice === undefined ? current.practice as string | null : input.practice},
        shared_with=${encode(shared)},metadata=${encode(input.metadata ?? current.metadata ?? {})},
        notes=${input.notes === undefined ? current.notes as string | null : input.notes},
        updated_at=${now()} WHERE id=${id}`, tx);
      if (input.sharedWith) await replaceMembers(tx, "project_members", id, shared);
      return findProject(scope, id, true, tx);
    });
  },
  async remove(scope, id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, id, true, tx, "update")) return null;
      const documentIds = (await rows<{ id: string }>(sql`SELECT d.id FROM documents d
        WHERE d.project_id=${id}
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF d") : sql.raw("")}`, tx))
        .map(({ id: documentId }) => documentId);
      await deleteDocumentRows(tx, documentIds);
      const ids = (await rows<{ id: string }>(sql`SELECT id FROM chats WHERE project_id=${id}`, tx))
        .map(({ id: chatId }) => chatId);
      return await changes(sql`DELETE FROM projects WHERE id=${id}`, tx)
        ? ids : null;
    });
  },
  folder: findProjectFolder,
  async createFolder(scope, projectId, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, projectId, "edit", tx, "share") || input.parentFolderId &&
        !await findProjectFolder(scope, projectId, input.parentFolderId, tx)) return null;
      const id = input.stableId ?? randomUUID(), created = now();
      await changes(sql`INSERT INTO project_subfolders(id,user_id,project_id,name,
        parent_folder_id,created_at,updated_at) VALUES(${id},${scope.userId},${projectId},
        ${input.name},${input.parentFolderId},${created},${created})
        ON CONFLICT(id) DO NOTHING`, tx);
      return findProjectFolder(scope, projectId, id, tx);
    });
  },
  async updateFolder(scope, projectId, id, input) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, projectId, "edit", tx, "share")) return null;
      const current = await findProjectFolder(scope, projectId, id, tx);
      if (!current) return null;
      const parent = input.parentFolderId === undefined
        ? current.parent_folder_id : input.parentFolderId;
      if (parent && !await findProjectFolder(scope, projectId, parent, tx)) return null;
      await changes(sql`UPDATE project_subfolders SET name=${input.name ?? current.name},
        parent_folder_id=${parent},updated_at=${now()} WHERE id=${id} AND project_id=${projectId}`, tx);
      return findProjectFolder(scope, projectId, id, tx);
    });
  },
  async deleteFolder(scope, projectId, id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (!await findProject(scope, projectId, "edit", tx, "update")) return false;
      if (!await findProjectFolder(scope, projectId, id, tx)) return false;
      const documentIds = (await rows<{ id: string }>(sql`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM project_subfolders WHERE id=${id} AND project_id=${projectId}
        UNION ALL SELECT f.id FROM project_subfolders f JOIN descendants d
          ON f.parent_folder_id=d.id WHERE f.project_id=${projectId})
        SELECT d.id FROM documents d WHERE d.project_id=${projectId}
          AND d.folder_id IN(SELECT id FROM descendants)
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF d") : sql.raw("")}`, tx))
        .map(({ id: documentId }) => documentId);
      await deleteDocumentRows(tx, documentIds);
      return await changes(sql`DELETE FROM project_subfolders WHERE id=${id}
        AND project_id=${projectId}` , tx) > 0;
    });
  },
};
