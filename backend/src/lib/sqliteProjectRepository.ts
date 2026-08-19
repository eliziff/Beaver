import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sqliteDatabase, sqliteTransaction } from "./sqliteDatabase";
import type { ProjectFolder, ProjectRecord, ProjectRepository } from "./projectStore";

type ProjectRow = {
  id: string; name: string; cm_number: string | null; practice: string | null;
  metadata_json: string; notes: string | null; created_at: string; updated_at: string;
};
type DirectoryRow = {
  kind: "folder" | "document"; id: string; bucket: number; sort_name: string;
  name: string | null; parent_folder_id: string | null;
  created_at: string | null; updated_at: string | null;
};
const database = () => sqliteDatabase();
const projectColumns = "id,name,cm_number,practice,metadata_json,notes,created_at,updated_at";
const record = (userId: string, row: ProjectRow): ProjectRecord => {
  let metadata: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.metadata_json);
    if (value && typeof value === "object" && !Array.isArray(value)) metadata = value;
  } catch {}
  const { metadata_json: _metadata, ...project } = row;
  return { ...project, metadata, user_id: userId, is_owner: true,
    owner_display_name: null, owner_email: null, shared_with: [] };
};
const findProject = (userId: string, id: string, db: DatabaseSync = database()) =>
  (db.prepare(`SELECT ${projectColumns} FROM projects WHERE user_id=? AND id=?`)
    .get(userId, id) as ProjectRow | undefined) ?? null;
const findFolder = (userId: string, projectId: string, id: string) =>
  database().prepare(`SELECT id,user_id,project_id,name,parent_folder_id,created_at,updated_at
    FROM project_subfolders WHERE id=? AND user_id=? AND project_id=?`)
    .get(id, userId, projectId) as ProjectFolder | undefined;

export const sqliteProjectRepository: ProjectRepository = {
  async page(scope, options) {
    if (options.scope === "shared-with-me") return { items: [], nextAfter: null };
    const filters = ["user_id=?"], params: (string | number)[] = [scope.userId];
    if (options.q) {
      filters.push("instr(lower(name||' '||coalesce(cm_number,'')||' '||coalesce(practice,'')),?)>0");
      params.push(options.q.toLowerCase());
    }
    if (options.after) {
      filters.push("(created_at<? OR (created_at=? AND id<?))");
      params.push(options.after[0], options.after[0], options.after[1]);
    }
    params.push(options.limit + 1);
    const rows = database().prepare(`SELECT ${projectColumns} FROM projects
      WHERE ${filters.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...params) as ProjectRow[];
    const items = rows.slice(0, options.limit).map((row) => record(scope.userId, row));
    const last = items.at(-1);
    return { items, nextAfter: rows.length > options.limit && last
      ? [String(last.created_at), last.id] : null };
  },
  async missingRecipient(_scope, emails) { return emails[0] ?? null; },
  async create(scope, input) {
    return sqliteTransaction((db) => {
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO projects
        (user_id,id,name,cm_number,practice,metadata_json,notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(scope.userId, id, input.name, input.cmNumber,
        input.practice, JSON.stringify(input.metadata ?? {}), input.notes ?? null, now, now);
      return record(scope.userId, findProject(scope.userId, id, db)!);
    });
  },
  async directory(scope, projectId, options) {
    if (!findProject(scope.userId, projectId)) return { items: [], nextAfter: null };
    const params: (string | number | null)[] = [scope.userId, projectId];
    let sql: string;
    if (options.q) {
      params.push(options.q, options.limit + 1);
      sql = `SELECT 'document' kind,id,1 bucket,lower(filename) sort_name,
        NULL name,NULL parent_folder_id,NULL created_at,NULL updated_at
        FROM documents WHERE user_id=? AND project_id=?
          AND instr(lower(filename),?)>0 ORDER BY sort_name,id LIMIT ?`;
    } else {
      params.push(options.parentFolderId, scope.userId, projectId, options.parentFolderId);
      const after = options.after ? `WHERE (bucket>? OR (bucket=? AND
        (sort_name>? OR (sort_name=? AND id>?))))` : "";
      if (options.after) params.push(options.after[0], options.after[0],
        options.after[1], options.after[1], options.after[2]);
      params.push(options.limit + 1);
      sql = `SELECT * FROM (
        SELECT 'folder' kind,id,0 bucket,lower(name) sort_name,name,parent_folder_id,
          created_at,updated_at FROM project_subfolders
          WHERE user_id=? AND project_id=? AND parent_folder_id IS ?
        UNION ALL SELECT 'document',id,1,lower(filename),NULL,NULL,NULL,NULL
          FROM documents WHERE user_id=? AND project_id=? AND folder_id IS ?
        ) ${after} ORDER BY bucket,sort_name,id LIMIT ?`;
    }
    const rows = database().prepare(sql).all(...params) as DirectoryRow[];
    const page = rows.slice(0, options.limit);
    const items = page.map((row) => row.kind === "document"
      ? { kind: "document" as const, id: row.id }
      : { kind: "folder" as const, folder: { id: row.id, user_id: scope.userId,
          project_id: projectId, name: row.name ?? "", parent_folder_id: row.parent_folder_id,
          created_at: row.created_at, updated_at: row.updated_at } });
    const last = page.at(-1);
    return { items, nextAfter: rows.length > options.limit && last
      ? [last.bucket, last.sort_name, last.id] : null };
  },
  async project(scope, id) {
    const row = findProject(scope.userId, id);
    return row ? record(scope.userId, row) : null;
  },
  async people(scope, id) {
    return findProject(scope.userId, id)
      ? { owner: { user_id: scope.userId, email: null, display_name: null }, members: [] }
      : null;
  },
  async update(scope, id, input) {
    return sqliteTransaction((db) => {
      const current = findProject(scope.userId, id, db);
      if (!current) return null;
      let metadata: unknown = {};
      try { metadata = JSON.parse(current.metadata_json); } catch {}
      db.prepare(`UPDATE projects SET name=?,cm_number=?,practice=?,metadata_json=?,notes=?,
        updated_at=? WHERE user_id=? AND id=?`).run(input.name ?? current.name,
        input.cmNumber === undefined ? current.cm_number : input.cmNumber,
        input.practice === undefined ? current.practice : input.practice,
        JSON.stringify(input.metadata ?? metadata),
        input.notes === undefined ? current.notes : input.notes,
        new Date().toISOString(), scope.userId, id);
      return record(scope.userId, findProject(scope.userId, id, db)!);
    });
  },
  async remove(scope, id) {
    return sqliteTransaction((db) => {
      if (!findProject(scope.userId, id, db)) return null;
      const chats = (db.prepare("SELECT id FROM chats WHERE user_id=? AND project_id=?")
        .all(scope.userId, id) as { id: string }[]).map(({ id }) => id);
      db.prepare("DELETE FROM projects WHERE user_id=? AND id=?").run(scope.userId, id);
      return chats;
    });
  },
  async folder(scope, projectId, id) {
    return findFolder(scope.userId, projectId, id) ?? null;
  },
  async createFolder(scope, projectId, input) {
    return sqliteTransaction((db) => {
      if (!findProject(scope.userId, projectId, db) ||
        (input.parentFolderId && !findFolder(scope.userId, projectId, input.parentFolderId))) return null;
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO project_subfolders
        (id,user_id,project_id,name,parent_folder_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, scope.userId, projectId, input.name,
        input.parentFolderId, now, now);
      return findFolder(scope.userId, projectId, id) ?? null;
    });
  },
  async updateFolder(scope, projectId, id, input) {
    return sqliteTransaction((db) => {
      const current = findFolder(scope.userId, projectId, id);
      if (!current) return null;
      db.prepare(`UPDATE project_subfolders SET name=?,parent_folder_id=?,updated_at=?
        WHERE id=? AND user_id=? AND project_id=?`).run(input.name ?? current.name,
        input.parentFolderId === undefined ? current.parent_folder_id : input.parentFolderId,
        new Date().toISOString(), id, scope.userId, projectId);
      return findFolder(scope.userId, projectId, id) ?? null;
    });
  },
  async folderDocumentIds(scope, projectId, id) {
    if (!findFolder(scope.userId, projectId, id)) return null;
    return (database().prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM project_subfolders WHERE id=? AND user_id=? AND project_id=?
      UNION ALL SELECT child.id FROM project_subfolders child
        JOIN descendants parent ON child.parent_folder_id=parent.id
        WHERE child.user_id=? AND child.project_id=?
      ) SELECT id FROM documents WHERE user_id=? AND project_id=?
        AND folder_id IN(SELECT id FROM descendants)`)
      .all(id, scope.userId, projectId, scope.userId, projectId,
        scope.userId, projectId) as { id: string }[]).map(({ id }) => id);
  },
  async deleteFolder(scope, projectId, id) {
    return database().prepare(
      "DELETE FROM project_subfolders WHERE id=? AND user_id=? AND project_id=?",
    ).run(id, scope.userId, projectId).changes > 0;
  },
};
