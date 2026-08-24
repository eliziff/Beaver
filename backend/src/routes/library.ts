import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { type DocumentStore } from "../lib/documentStore";
import {
  type LibraryScope,
  type LibraryStore,
} from "../lib/libraryStore";
import {
  normalizeLibraryKind,
} from "../lib/normalize";
import { pageRequest, pageResponse } from "../lib/pagination";
import { singleFileUpload, uploadedDocument } from "../lib/upload";
import { enqueuePdfReprocess } from "../lib/pdfJobs";
import {
  fixDocumentSupras,
  inspectDocxAutomation,
} from "../lib/docxDeterministicCleanup";

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
    const kind = normalizeLibraryKind(req.params.kind) ??
      reject(404, "Library not found");
    await handler(req, res, { ...applicationScope(res), kind });
  });
}

const versionId = (value: unknown) => typeof value === "string" ? value : null;

function docxAction(
  router: Router,
  documents: DocumentStore,
  path: string,
  label: string,
  action: (documents: DocumentStore, userId: string, documentId: string) => Promise<unknown>,
) {
  router.post(path, libraryRoute(async (req, res, scope) => {
    if (scope.kind !== "file") reject(400, `${label} applies to Library files`);
    try {
      res.json(await action(documents, scope.userId, req.params.documentId));
    } catch (error) {
      const missing = error instanceof Error && error.message === "Document not found";
      reject(missing ? 404 : 400, missing ? "Document not found" : `${label} failed`);
    }
  }));
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
    res.json(pageResponse(`library/${scope.kind}`, filters, page));
  }));

  router.post(
    "/:kind/documents",
    singleFileUpload("file"),
    libraryRoute(async (req, res, scope) => {
      const file = req.file ?? reject(400, "file is required");
      res.status(201).json(await documents.create(scope, {
        ...uploadedDocument(file),
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
    const folder = await store.createFolder(scope, name, parentFolderId);
    if (!folder) reject(404, "Parent folder not found");
    res.status(201).json(folder);
  }));

  router.patch(
    "/:kind/folders/:folderId",
    libraryRoute(async (req, res, scope) => {
      const { folderId } = req.params;
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
      const document = await store.updateDocument(scope, req.params.documentId, {
        filename: req.body?.filename,
        ...(Object.hasOwn(req.body ?? {}, "metadata")
          ? { metadata: req.body.metadata }
          : {}),
        ...(Object.hasOwn(req.body ?? {}, "notes")
          ? { notes: req.body.notes }
          : {}),
      });
      if (!document) reject(404, "Document not found");
      res.json(document);
    }),
  );

  docxAction(router, documents, "/:kind/documents/:documentId/actions/fix-supras",
    "Supra cleanup", fixDocumentSupras);
  router.get("/:kind/documents/:documentId/automation", libraryRoute(async (req, res, scope) => {
    if (scope.kind !== "file") reject(400, "Document automation applies to Library files");
    try {
      res.json(await inspectDocxAutomation(documents, scope.userId, req.params.documentId));
    } catch (error) {
      const missing = error instanceof Error && error.message === "Document not found";
      reject(missing ? 404 : 400, missing ? "Document not found" : "DOCX inspection failed");
    }
  }));

  const pdf = async (scope: LibraryScope, documentId: string, requested: unknown) => {
    const document = await documents.metadata(scope, documentId);
    if (!document || document.library_kind !== scope.kind) reject(404, "Document not found");
    const file = await documents.read(scope, documentId, versionId(requested), false)
      ?? reject(404, "Version not found");
    if (file.fileType !== "pdf") reject(409, "Version is not a PDF");
    return file;
  };

  router.post("/:kind/documents/:documentId/actions/retry-pdf-parse",
    libraryRoute(async (req, res, scope) => {
      const file = await pdf(scope, req.params.documentId, req.body?.version_id);
      const ocr = req.body?.ocr_provider;
      if (ocr !== undefined && ocr !== "tesseract" && ocr !== "kraken-lite")
        reject(400, "ocr_provider must be kraken-lite or tesseract");
      const layoutProvider = req.body?.layout_provider;
      if (layoutProvider !== undefined && !["none", "local"].includes(layoutProvider))
        reject(400, "layout_provider must be none or local");
      const layout: boolean | null | undefined = layoutProvider === "none" ? null
        : layoutProvider === "local" ? true
        : undefined;
      try {
        const job = await enqueuePdfReprocess({
          userId: scope.userId,
          documentId: req.params.documentId, versionId: file.version.id,
          sourceSha256: file.version.source_sha256,
          ...(ocr ? { ocrProvider: ocr } : {}),
          ...(layoutProvider ? { layout } : {}),
        });
        res.status(202).json({ id: job.id, status: job.status });
      } catch (error) {
        if (layoutProvider) reject(503, "PDF layout analysis could not start. Check the local runtime and model files.");
        if (!ocr) throw error;
        const message = error instanceof Error ? error.message : "";
        reject(503, ocr === "tesseract" && message.startsWith("Tesseract was not found")
          ? "Tesseract was not found. Install it or configure its executable."
          : ocr === "tesseract"
            ? "OCR could not start. Check the local Tesseract installation and retry."
            : "OCR could not start. Check the local Kraken-lite runtime and retry.");
      }
    }));

  return router;
}
