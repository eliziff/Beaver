import { randomUUID } from "node:crypto";
import type { LibraryFolder, LibraryRepository, LibraryScope } from "./libraryStore";
import { relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { changes, deleteDocumentRows, directoryPage, now, one, rows, type Row } from "./relationalRepositorySupport";

const libraryFolder = (row: Row): LibraryFolder => ({ ...row,
  id: String(row.id), name: String(row.name), parent_folder_id: row.parent_folder_id ?? null });
async function findLibraryFolder(scope: LibraryScope, id: string, db?: RelationalDatabase,
  lock: "share" | "update" | false = false) {
  const row = await one(sql`SELECT f.* FROM library_folders f WHERE f.id=${id}
    AND f.user_id=${scope.userId} AND f.library_kind=${scope.kind}
    ${lock && db?.engine === "postgres" ? sql.raw(`FOR ${lock.toUpperCase()} OF f`) : sql.raw("")}`, db);
  return row ? libraryFolder(row) : null;
}
async function lockLibrary(scope: LibraryScope, db: RelationalDatabase) {
  if (db.engine === "postgres") await rows(sql`SELECT id FROM auth.users
    WHERE id=${scope.userId} FOR UPDATE`, db);
}
export const libraryRepository: LibraryRepository = {
  async page(scope, options) {
    return directoryPage(options, {
      folders: sql`SELECT * FROM library_folders
        WHERE user_id=${scope.userId} AND library_kind=${scope.kind}`,
      documents: sql`SELECT id,filename,library_folder_id parent_folder_id FROM documents
        WHERE user_id=${scope.userId} AND project_id IS NULL AND library_kind=${scope.kind}`,
    }, libraryFolder);
  },
  folder: findLibraryFolder,
  async createFolder(scope, name, parentId, stableId) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      await lockLibrary(scope, tx);
      if (parentId && !await findLibraryFolder(scope, parentId, tx, "share")) return null;
      const id = stableId ?? randomUUID(), created = now();
      await changes(sql`INSERT INTO library_folders(id,user_id,library_kind,name,
        parent_folder_id,created_at,updated_at) VALUES(${id},${scope.userId},${scope.kind},
        ${name},${parentId},${created},${created}) ON CONFLICT(id) DO NOTHING`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async updateFolder(scope, id, update) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      await lockLibrary(scope, tx);
      const current = await findLibraryFolder(scope, id, tx, "update");
      if (!current) return null;
      const parent = update.parentFolderId === undefined
        ? current.parent_folder_id : update.parentFolderId;
      if (parent && !await findLibraryFolder(scope, parent, tx, "share")) return null;
      await changes(sql`UPDATE library_folders SET name=${update.name ?? current.name},
        parent_folder_id=${parent},updated_at=${now()} WHERE id=${id}
        AND user_id=${scope.userId} AND library_kind=${scope.kind}`, tx);
      return findLibraryFolder(scope, id, tx);
    });
  },
  async deleteFolder(scope, id) {
    const db = await relationalDatabase();
    return db.transaction(async (tx) => {
      await lockLibrary(scope, tx);
      if (!await findLibraryFolder(scope, id, tx)) return false;
      const documentIds = (await rows<{ id: string }>(sql`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM library_folders WHERE id=${id} AND user_id=${scope.userId}
          AND library_kind=${scope.kind} UNION ALL SELECT f.id FROM library_folders f
        JOIN descendants d ON f.parent_folder_id=d.id WHERE f.user_id=${scope.userId}
          AND f.library_kind=${scope.kind}) SELECT d.id FROM documents d
        WHERE d.user_id=${scope.userId} AND d.project_id IS NULL
          AND d.library_kind=${scope.kind}
          AND d.library_folder_id IN(SELECT id FROM descendants)
        ${tx.engine === "postgres" ? sql.raw("FOR UPDATE OF d") : sql.raw("")}`, tx))
        .map(({ id: documentId }) => documentId);
      await deleteDocumentRows(tx, documentIds);
      return await changes(sql`DELETE FROM library_folders WHERE id=${id}
        AND user_id=${scope.userId} AND library_kind=${scope.kind}`, tx) > 0;
    });
  },
};
