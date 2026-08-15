import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../lib/asyncRoute";
import { validateDocumentFile } from "../lib/documentTypes";
import {
  DocumentStoreError,
  type DocumentStore,
} from "../lib/documentStore";
import type { LibraryScope, LibraryStore } from "../lib/libraryStore";
import {
  normalizeDocumentFilename,
  normalizeDocumentMetadata,
  normalizeDocumentNotes,
  normalizeLibraryKind,
} from "../lib/normalize";
import {
  encodePageCursor,
  pageRequest,
  PageCursorError,
} from "../lib/pagination";
import { singleFileUpload } from "../lib/upload";

class LibraryRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const reject = (status: number, detail: string): never => {
  throw new LibraryRequestError(status, detail);
};

function nullableId(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  return reject(400, `${name} must be a string or null`);
}

type Handler = (
  req: Request,
  res: Response,
  scope: LibraryScope,
) => Promise<unknown>;

function libraryRoute(handler: Handler) {
  return asyncRoute(async (req, res) => {
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    try {
      await handler(req, res, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        kind,
      });
    } catch (error) {
      if (error instanceof LibraryRequestError ||
          error instanceof DocumentStoreError ||
          error instanceof PageCursorError) {
        return void res.status(
          error instanceof PageCursorError ? 400 : error.status,
        ).json({ detail: error.message });
      }
      console.error("[library] operation failed", error);
      res.status(500).json({ detail: "Library operation failed" });
    }
  });
}

async function requireFolder(
  store: LibraryStore,
  scope: LibraryScope,
  folderId: string,
  detail = "Parent folder not found",
) {
  return await store.folder(scope, folderId) ?? reject(404, detail);
}

export function createLibraryRouter(store: LibraryStore, documents: DocumentStore) {
  const router = Router();
  router.use(requireAuth);

  router.get("/:kind", libraryRoute(async (req, res, scope) => {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim().toLocaleLowerCase()
      : "";
    const parentFolderId = nullableId(req.query.parent_id, "parent_id");
    if (q && parentFolderId) reject(400, "q and parent_id cannot be used together");
    const filters = { kind: scope.kind, q, parent_id: q ? null : parentFolderId };
    const { after, limit } = pageRequest<[number, string, string]>(
      req.query,
      `library/${scope.kind}`,
      filters,
      ["number", "string", "string"],
    );
    const page = await store.page(scope, {
      q,
      parentFolderId: filters.parent_id,
      limit,
      after,
    });
    res.json({
      items: page.items,
      next_cursor: page.nextAfter
        ? encodePageCursor(`library/${scope.kind}`, filters, page.nextAfter)
        : null,
    });
  }));

  router.post(
    "/:kind/documents",
    singleFileUpload("file"),
    libraryRoute(async (req, res, scope) => {
      const file = req.file ?? reject(400, "file is required");
      const validated = validateDocumentFile(file.originalname, file.buffer);
      if (!validated.ok) throw new LibraryRequestError(400, validated.error);
      res.status(201).json(await documents.create(scope, {
        filename: file.originalname,
        fileType: validated.fileType,
        bytes: file.buffer,
        libraryKind: scope.kind,
      }));
    }),
  );

  router.post("/:kind/folders", libraryRoute(async (req, res, scope) => {
    const name = typeof req.body?.name === "string"
      ? req.body.name.trim().slice(0, 200)
      : "";
    if (!name) reject(400, "name is required");
    const parentFolderId = nullableId(
      req.body?.parent_folder_id,
      "parent_folder_id",
    );
    if (parentFolderId) await requireFolder(store, scope, parentFolderId);
    const folder = await store.createFolder(scope, name, parentFolderId);
    if (!folder) reject(404, "Parent folder not found");
    res.status(201).json(folder);
  }));

  router.patch(
    "/:kind/folders/:folderId",
    libraryRoute(async (req, res, scope) => {
      const { folderId } = req.params;
      await requireFolder(store, scope, folderId, "Folder not found");
      const update: { name?: string; parentFolderId?: string | null } = {};
      if (Object.hasOwn(req.body ?? {}, "name")) {
        const name = typeof req.body.name === "string"
          ? req.body.name.trim().slice(0, 200)
          : "";
        if (!name) reject(400, "name is required");
        update.name = name;
      }
      if (Object.hasOwn(req.body ?? {}, "parent_folder_id")) {
        const parentFolderId = nullableId(
          req.body.parent_folder_id,
          "parent_folder_id",
        );
        const seen = new Set<string>();
        let cursor = parentFolderId;
        while (cursor) {
          if (cursor === folderId) {
            reject(400, "Cannot move a folder into itself or a descendant");
          }
          if (seen.has(cursor)) reject(500, "Folder hierarchy contains a cycle");
          seen.add(cursor);
          cursor = (await requireFolder(store, scope, cursor)).parent_folder_id;
        }
        update.parentFolderId = parentFolderId;
      }
      const folder = await store.updateFolder(scope, folderId, update);
      if (!folder) reject(404, "Folder not found");
      res.json(folder);
    }),
  );

  router.delete(
    "/:kind/folders/:folderId",
    libraryRoute(async (req, res, scope) => {
      await requireFolder(store, scope, req.params.folderId, "Folder not found");
      if (!await store.deleteFolder(scope, req.params.folderId)) {
        reject(404, "Folder not found");
      }
      res.status(204).send();
    }),
  );

  router.patch(
    "/:kind/documents/:documentId/folder",
    libraryRoute(async (req, res, scope) => {
      if (!Object.hasOwn(req.body ?? {}, "folder_id")) {
        reject(400, "folder_id is required");
      }
      const folderId = nullableId(req.body.folder_id, "folder_id");
      if (folderId) await requireFolder(store, scope, folderId);
      const document = await store.moveDocument(
        scope,
        req.params.documentId,
        folderId,
      );
      if (!document) reject(404, "Document not found");
      res.json(document);
    }),
  );

  router.patch(
    "/:kind/documents/:documentId",
    libraryRoute(async (req, res, scope) => {
      const current = await store.document(scope, req.params.documentId);
      if (!current) throw new LibraryRequestError(404, "Document not found");
      const currentName = typeof current.filename === "string" && current.filename.trim()
        ? current.filename.trim()
        : "Untitled document";
      const filename = normalizeDocumentFilename(req.body?.filename, currentName);
      if (!filename) throw new LibraryRequestError(400, "filename is required");
      const document = await store.updateDocument(scope, req.params.documentId, {
        filename,
        ...(Object.hasOwn(req.body ?? {}, "metadata")
          ? { metadata: normalizeDocumentMetadata(req.body.metadata) }
          : {}),
        ...(Object.hasOwn(req.body ?? {}, "notes")
          ? { notes: normalizeDocumentNotes(req.body.notes) }
          : {}),
      });
      if (!document) reject(404, "Document not found");
      res.json(document);
    }),
  );

  return router;
}
