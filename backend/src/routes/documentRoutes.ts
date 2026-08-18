import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../lib/asyncRoute";
import {
  contentTypeForDocumentType,
  validateDocumentFile,
} from "../lib/documentTypes";
import type {
  DocumentContent,
  DocumentScope,
  DocumentStore,
} from "../lib/documentStore";
import { DocumentStoreError } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import {
  encodePageCursor,
  pageRequest,
  PageCursorError,
} from "../lib/pagination";
import { buildContentDisposition } from "../lib/storage";
import { singleFileUpload } from "../lib/upload";

class DocumentRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const reject = (status: number, detail: string): never => {
  throw new DocumentRequestError(status, detail);
};

const scope = (res: Response): DocumentScope => ({
  userId: res.locals.userId as string,
  userEmail: res.locals.userEmail as string | undefined,
});

const versionId = (req: Request) =>
  typeof req.query.version_id === "string" ? req.query.version_id : null;

const filename = (req: Request, original: string) =>
  typeof req.body?.filename === "string" && req.body.filename.trim()
    ? req.body.filename.trim().slice(0, 200)
    : original;

function validatedFileType(name: string, bytes: Buffer) {
  const validated = validateDocumentFile(name, bytes);
  return validated.ok ? validated.fileType : reject(400, validated.error);
}

function documentRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return asyncRoute(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof DocumentRequestError ||
          error instanceof DocumentStoreError ||
          error instanceof PageCursorError) {
        return void res.status(
          error instanceof PageCursorError ? 400 : error.status,
        ).json({ detail: error.message });
      }
      console.error("[documents] operation failed", error);
      res.status(500).json({ detail: "Document operation failed" });
    }
  });
}

function sendContent(res: Response, content: DocumentContent,
  disposition: "inline" | "attachment") {
  res.setHeader("Content-Type", contentTypeForDocumentType(content.fileType));
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(disposition, content.filename),
  );
  res.send(content.bytes);
}

async function sendDownload(
  documents: DocumentStore,
  req: Request,
  res: Response,
  preferPdf: boolean,
  disposition: "inline" | "attachment",
) {
  const download = await documents.download(
    scope(res), req.params.documentId, versionId(req), preferPdf, disposition,
  ) ?? reject(404, "Document not found");
  res.setHeader("Cache-Control", "private, no-store");
  if (download.kind === "redirect") return void res.redirect(302, download.url);
  sendContent(res, download.content, disposition);
}

export function createDocumentsRouter(
  library: LibraryStore,
  documents: DocumentStore,
) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", documentRoute(async (req, res) => {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim().toLocaleLowerCase()
      : "";
    const filters = { q };
    const { after, limit } = pageRequest<[number, string, string]>(
      req.query,
      "single-documents",
      filters,
      ["number", "string", "string"],
    );
    const page = await library.page({ ...scope(res), kind: "file" }, {
      q,
      parentFolderId: null,
      limit,
      after,
      documentsOnly: true,
    });
    res.json({
      items: page.items.flatMap((item) =>
        item.kind === "document" ? [item.document] : []),
      next_cursor: page.nextAfter
        ? encodePageCursor("single-documents", filters, page.nextAfter)
        : null,
    });
  }));

  router.post(
    "/",
    singleFileUpload("file"),
    documentRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      const fileType = validatedFileType(file.originalname, file.buffer);
      res.status(201).json(await documents.create(scope(res), {
        filename: file.originalname,
        fileType,
        bytes: file.buffer,
        libraryKind: "file",
      }));
    }),
  );

  router.post("/download-zip", documentRoute(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.document_ids)
      ? (req.body.document_ids as unknown[]).filter(
        (item: unknown): item is string => typeof item === "string",
      )
      : [];
    if (!ids.length) reject(400, "document_ids is required");
    const files = await documents.files(scope(res), [...new Set(ids)]);
    if (!files.length) reject(404, "No documents found");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const file of files) zip.file(file.filename, file.bytes);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
    res.send(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }));

  router.delete("/:documentId", documentRoute(async (req, res) => {
    if (!await documents.deleteDocument(scope(res), req.params.documentId)) {
      reject(404, "Document not found");
    }
    res.status(204).send();
  }));

  router.get("/:documentId/file", documentRoute(async (req, res) => {
    const rendition = req.query.rendition;
    if (rendition !== undefined && rendition !== "pdf") {
      reject(400, "rendition must be pdf");
    }
    await sendDownload(
      documents, req, res, rendition === "pdf",
      rendition === "pdf" ? "inline" : "attachment",
    );
  }));

  router.get("/:documentId/versions", documentRoute(async (req, res) => {
    const versions = await documents.versions(scope(res), req.params.documentId)
      ?? reject(404, "Document not found");
    res.json(versions);
  }));

  router.post(
    "/:documentId/versions",
    singleFileUpload("file"),
    documentRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      const resolvedName = filename(req, file.originalname);
      const fileType = validatedFileType(resolvedName, file.buffer);
      const version = await documents.addVersion(
        scope(res),
        req.params.documentId,
        { filename: resolvedName, fileType, bytes: file.buffer },
      );
      if (!version) reject(404, "Document not found");
      res.status(201).json(version);
    }),
  );

  router.post(
    "/:documentId/versions/from-document",
    documentRoute(async (req, res) => {
      const sourceId = typeof req.body?.source_document_id === "string"
        ? req.body.source_document_id.trim()
        : "";
      if (!sourceId || sourceId === req.params.documentId) {
        reject(400, "Invalid source document");
      }
      const requestedName = typeof req.body?.filename === "string" &&
          req.body.filename.trim()
        ? req.body.filename.trim().slice(0, 200)
        : undefined;
      const result = await documents.copyVersion(
        scope(res), req.params.documentId, sourceId, requestedName,
      );
      if (result.status !== "created") {
        if (result.status === "target-missing") reject(404, "Document not found");
        if (result.status === "source-missing") {
          reject(404, "Source document not found");
        }
        return reject(403, "Only the source document owner can move it into a version");
      }
      res.status(201).json(result.version);
    }),
  );

  router.patch(
    "/:documentId/versions/:versionId",
    documentRoute(async (req, res) => {
      const resolvedName = typeof req.body?.filename === "string"
        ? req.body.filename.trim().slice(0, 200)
        : "";
      if (!resolvedName) reject(400, "filename is required");
      const version = await documents.renameVersion(
        scope(res), req.params.documentId, req.params.versionId, resolvedName,
      );
      if (!version) reject(404, "Version not found");
      res.json(version);
    }),
  );

  router.put(
    "/:documentId/versions/:versionId/file",
    singleFileUpload("file"),
    documentRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      const resolvedName = filename(req, file.originalname);
      const fileType = validatedFileType(resolvedName, file.buffer);
      const result = await documents.replaceVersion(
        scope(res), req.params.documentId, req.params.versionId,
        { filename: resolvedName, fileType, bytes: file.buffer },
      );
      if (result.status !== "replaced") {
        if (result.status === "missing") reject(404, "Version not found");
        return reject(400, "Uploaded file type does not match version type");
      }
      res.json(result.version);
    }),
  );

  router.delete(
    "/:documentId/versions/:versionId",
    documentRoute(async (req, res) => {
      const result = await documents.deleteVersion(
        scope(res), req.params.documentId, req.params.versionId,
      );
      if (result.status !== "deleted") {
        if (result.status === "missing") reject(404, "Version not found");
        return reject(400, "Cannot delete the only document version.");
      }
      res.json({
        deleted_version_id: req.params.versionId,
        current_version_id: result.currentVersionId,
      });
    }),
  );

  const resolveEdit = (mode: "accept" | "reject") => documentRoute(
    async (req, res) => {
      const result = await documents.resolveEdit(
        scope(res), req.params.documentId, req.params.editId, mode,
      );
      if (result.status !== "resolved" && result.status !== "unchanged") {
        if (result.status === "missing") reject(404, "Tracked edit not found");
        if (result.status === "conflict") {
          reject(409, `Tracked edit is already ${result.editStatus}`);
        }
        return reject(409, "Tracked edit no longer matches this document version");
      }
      res.json({
        ok: true,
        status: result.editStatus,
        version_id: result.versionId,
        version_number: result.versionNumber,
        download_url: result.downloadUrl,
      });
    },
  );

  router.post("/:documentId/edits/:editId/accept", resolveEdit("accept"));
  router.post("/:documentId/edits/:editId/reject", resolveEdit("reject"));
  return router;
}
