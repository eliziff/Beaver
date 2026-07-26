import { readFile } from "node:fs/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
  addLocalVersion,
  createLocalDocument,
  deleteLocalDocument,
  deleteLocalVersion,
  getLocalVersionFile,
  listLocalLibrary,
  listLocalVersions,
  renameLocalVersion,
  replaceLocalVersion,
} from "../lib/localDocumentStore";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { extractTrackedChangeIds } from "../lib/docxTrackedChanges";
import { buildContentDisposition } from "../lib/storage";
import { singleFileUpload } from "../lib/upload";

export const localDocumentsRouter = Router();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function requestedVersionId(req: Request) {
  return typeof req.query.version_id === "string" ? req.query.version_id : null;
}

localDocumentsRouter.use((_req, _res, next) => {
  if (!isAnonymousLocalMode()) return next("router");
  next();
});

localDocumentsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (_req, res) => {
    const collection = await listLocalLibrary(res.locals.userId as string, "file");
    res.json(collection.documents.slice().reverse());
  }),
);

localDocumentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) return void res.status(400).json({ detail: "file is required" });
    try {
      const document = await createLocalDocument({
        userId: res.locals.userId as string,
        kind: "file",
        filename: req.file.originalname,
        bytes: req.file.buffer,
      });
      res.status(201).json(document);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Upload failed";
      res.status(detail.startsWith("Unsupported file type") ? 400 : 500).json({ detail });
    }
  }),
);

localDocumentsRouter.post(
  "/download-zip",
  requireAuth,
  asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.document_ids)
      ? req.body.document_ids.filter((item: unknown): item is string => typeof item === "string")
      : [];
    if (ids.length === 0) {
      return void res.status(400).json({ detail: "document_ids is required" });
    }
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const documentId of ids) {
      const file = await getLocalVersionFile(
        res.locals.userId as string,
        documentId,
      );
      if (!file) continue;
      zip.file(file.version.filename, await readFile(file.path));
    }
    const content = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
    res.send(content);
  }),
);

localDocumentsRouter.delete(
  "/:documentId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const deleted = await deleteLocalDocument(
      res.locals.userId as string,
      req.params.documentId,
    );
    if (!deleted) return void res.status(404).json({ detail: "Document not found" });
    res.status(204).send();
  }),
);

localDocumentsRouter.get(
  "/:documentId/display",
  requireAuth,
  asyncRoute(async (req, res) => {
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      requestedVersionId(req),
      true,
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    res.setHeader("Content-Type", contentTypeForDocumentType(file.fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", file.version.filename),
    );
    res.send(await readFile(file.path));
  }),
);

localDocumentsRouter.get(
  "/:documentId/file",
  requireAuth,
  asyncRoute(async (req, res) => {
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      requestedVersionId(req),
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    res.setHeader("Content-Type", contentTypeForDocumentType(file.fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("attachment", file.version.filename),
    );
    res.send(await readFile(file.path));
  }),
);

localDocumentsRouter.get(
  "/:documentId/url",
  requireAuth,
  asyncRoute(async (req, res) => {
    const versionId = requestedVersionId(req);
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      versionId,
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    const query = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    res.json({
      url: `${req.protocol}://${req.get("host")}/single-documents/${req.params.documentId}/file${query}`,
      document_id: req.params.documentId,
      filename: file.version.filename,
      version_id: file.version.id,
      has_pdf_rendition: !!file.document.pdf_storage_path,
    });
  }),
);

localDocumentsRouter.get(
  "/:documentId/docx",
  requireAuth,
  asyncRoute(async (req, res) => {
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      requestedVersionId(req),
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    res.setHeader("Content-Type", contentTypeForDocumentType(file.fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", file.version.filename),
    );
    res.send(await readFile(file.path));
  }),
);

localDocumentsRouter.get(
  "/:documentId/versions",
  requireAuth,
  asyncRoute(async (req, res) => {
    const versions = await listLocalVersions(
      res.locals.userId as string,
      req.params.documentId,
    );
    if (!versions) return void res.status(404).json({ detail: "Document not found" });
    res.json(versions);
  }),
);

localDocumentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) return void res.status(400).json({ detail: "file is required" });
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : req.file.originalname;
    try {
      const version = await addLocalVersion({
        userId: res.locals.userId as string,
        documentId: req.params.documentId,
        filename,
        bytes: req.file.buffer,
      });
      if (!version) return void res.status(404).json({ detail: "Document not found" });
      res.status(201).json(version);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Upload failed";
      res.status(detail.startsWith("Unsupported file type") ? 400 : 500).json({ detail });
    }
  }),
);

localDocumentsRouter.post(
  "/:documentId/versions/from-document",
  requireAuth,
  asyncRoute(async (req, res) => {
    const sourceId =
      typeof req.body?.source_document_id === "string"
        ? req.body.source_document_id
        : "";
    if (!sourceId || sourceId === req.params.documentId) {
      return void res.status(400).json({ detail: "Invalid source document" });
    }
    const source = await getLocalVersionFile(res.locals.userId as string, sourceId);
    if (!source) return void res.status(404).json({ detail: "Source document not found" });
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : source.version.filename;
    const version = await addLocalVersion({
      userId: res.locals.userId as string,
      documentId: req.params.documentId,
      filename,
      bytes: await readFile(source.path),
    });
    if (!version) return void res.status(404).json({ detail: "Document not found" });
    await deleteLocalDocument(res.locals.userId as string, sourceId);
    res.status(201).json(version);
  }),
);

localDocumentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const filename =
      typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
    if (!filename) return void res.status(400).json({ detail: "filename is required" });
    const version = await renameLocalVersion(
      res.locals.userId as string,
      req.params.documentId,
      req.params.versionId,
      filename,
    );
    if (!version) return void res.status(404).json({ detail: "Version not found" });
    res.json(version);
  }),
);

localDocumentsRouter.put(
  "/:documentId/versions/:versionId/file",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) return void res.status(400).json({ detail: "file is required" });
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : req.file.originalname;
    const version = await replaceLocalVersion({
      userId: res.locals.userId as string,
      documentId: req.params.documentId,
      versionId: req.params.versionId,
      filename,
      bytes: req.file.buffer,
    });
    if (!version) {
      return void res.status(400).json({ detail: "Version not found or file type changed" });
    }
    res.json(version);
  }),
);

localDocumentsRouter.delete(
  "/:documentId/versions/:versionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await deleteLocalVersion(
      res.locals.userId as string,
      req.params.documentId,
      req.params.versionId,
    );
    if (result.status === "missing") {
      return void res.status(404).json({ detail: "Version not found" });
    }
    if (result.status === "only") {
      return void res.status(400).json({ detail: "Cannot delete the only document version." });
    }
    res.json({
      deleted_version_id: req.params.versionId,
      current_version_id: result.currentVersionId,
    });
  }),
);

localDocumentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  asyncRoute(async (req, res) => {
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      requestedVersionId(req),
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    if (file.fileType !== "docx") return void res.json({ ids: [] });
    res.json({ ids: await extractTrackedChangeIds(await readFile(file.path)) });
  }),
);
