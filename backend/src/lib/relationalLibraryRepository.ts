import { randomUUID } from "node:crypto";
import type { LibraryFolder, LibraryRepository, LibraryScope } from "./libraryStore";
import { relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, now, one, rows, type Row } from "./relationalRepositorySupport";

const libraryFolder = (row: Row): LibraryFolder => ({ ...row,
  id: String(row.id), name: String(row.name), parent_folder_id: row.parent_folder_id ?? null });
async function findLibraryFolder(scope: LibraryScope, id: string, db?: RelationalDatabase) {
  const row = await one(sql`SELECT * FROM library_folders WHERE id=${id}
    AND user_id=${scope.userId} AND library_kind=${scope.kind}`, db);
  return row ? libraryFolder(row) : null;
}
export const libraryRepository: LibraryRepository = {
  async page(scope, options) {
    const after = options.after;
    const seek = after ? sql`AND (bucket>${after[0]} OR (bucket=${after[0]} AND
      (sort_name>${after[1]} OR (sort_name=${after[1]} AND id>${after[2]}))))` : sql.raw("");
    const filter = options.q || options.documentsOnly
      ? sql`SELECT 'document' kind,id,1 bucket,lower(filename) sort_name,NULL name,
          NULL parent_folder_id,NULL created_at,NULL updated_at FROM documents
        WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
          ${options.q ? sql`AND lower(filename) LIKE ${`%${options.q}%`}` : sql.raw("")}`
      : sql`SELECT * FROM (SELECT 'folder' kind,id,0 bucket,lower(name) sort_name,name,
          parent_folder_id,created_at,updated_at FROM library_folders
        WHERE user_id=${scope.userId} AND library_kind=${scope.kind}
          AND COALESCE(parent_folder_id,'')=${options.parentFolderId ?? ""}
        UNION ALL SELECT 'document',id,1,lower(filename),NULL,NULL,NULL,NULL FROM documents
        WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
          AND COALESCE(library_folder_id,'')=${options.parentFolderId ?? ""}) directory
        WHERE 1=1 ${seek}`;
    const result = await rows(sql`${filter} ORDER BY bucket,sort_name,id LIMIT ${options.limit + 1}`);
    const page = result.slice(0, options.limit), last = page.at(-1);
    return { items: page.map((row) => row.kind === "folder"
      ? { kind: "folder" as const, folder: libraryFolder(row) }
      : { kind: "document" as const, id: String(row.id) }),
    nextAfter: result.length > options.limit && last
      ? [Number(last.bucket), String(last.sort_name), String(last.id)] : null };
  },
  folder: findLibraryFolder,
  async createFolder(scope, name, parentId) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      if (parentId && !await findLibraryFolder(scope, parentId, tx)) return null;
      const id = randomUUID(), created = now();
      await changes(sql`INSERT INTO library_folders(id,user_id,library_kind,name,
        parent_folder_id,created_at,updated_at) VALUES(${id},${scope.userId},${scope.kind},
        ${name},${parentId},${created},${created})`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async updateFolder(scope, id, update) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      const current = await findLibraryFolder(scope, id, tx);
      if (!current) return null;
      const parent = update.parentFolderId === undefined
        ? current.parent_folder_id : update.parentFolderId;
      if (parent && !await findLibraryFolder(scope, parent, tx)) return null;
      await changes(sql`UPDATE library_folders SET name=${update.name ?? current.name},
        parent_folder_id=${parent},updated_at=${now()} WHERE id=${id}
        AND user_id=${scope.userId} AND library_kind=${scope.kind}`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async folderDocumentIds(scope, id) {
    if (!await findLibraryFolder(scope, id)) return null;
    return (await rows<{ id: string }>(sql`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM library_folders WHERE id=${id} AND user_id=${scope.userId}
        AND library_kind=${scope.kind} UNION ALL SELECT f.id FROM library_folders f
      JOIN descendants d ON f.parent_folder_id=d.id WHERE f.user_id=${scope.userId}
        AND f.library_kind=${scope.kind}) SELECT id FROM documents
      WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}
        AND library_folder_id IN(SELECT id FROM descendants)`)).map(({ id: value }) => value);
  },
  async deleteFolder(scope, id) {
    return await changes(sql`DELETE FROM library_folders WHERE id=${id}
      AND user_id=${scope.userId} AND library_kind=${scope.kind}`) > 0;
  },
};
