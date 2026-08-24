import { Router, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import {
  contentTypeForDocumentType,
  isSpreadsheetDocumentType,
} from "../lib/documentTypes";
import type {
  DocumentContent,
  DocumentStore,
} from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import { pageRequest, pageResponse } from "../lib/pagination";
import { downloadHeaders, MAX_OBJECT_SIZE_BYTES,
  normalizeDownloadFilename } from "../lib/storage";
import { singleFileUpload, uploadedDocument } from "../lib/upload";
import { documentProjectionService } from "../lib/documentProjectionService";

const scope = applicationScope, MAX_ZIP_FILES = 100;

const versionId = (req: Request) =>
  typeof req.query.version_id === "string" ? req.query.version_id : null;

const evidenceHandle = (req: Request) => !Object.hasOwn(req.query, "evidence")
  ? undefined
  : typeof req.query.evidence === "string" && req.query.evidence.trim()
    ? req.query.evidence.trim() : null;

const html = (value: unknown) => String(value).replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

async function evidence<T extends { documentId: string; versionId: string }>(
  documentId: string, file: DocumentContent, load: () => Promise<T>,
) {
  try {
    const receipt = await load();
    if (receipt.documentId !== documentId || receipt.versionId !== file.version.id)
      throw new Error("Evidence source mismatch");
    return receipt;
  } catch { return reject(410, "Evidence is no longer available"); }
}

const filename = (req: Request, original: string) =>
  typeof req.body?.filename === "string" && req.body.filename.trim()
    ? req.body.filename.trim().slice(0, 200)
    : original;

const archiveName = (name: string, index: number) => {
  const safe = normalizeDownloadFilename(name).replace(/[:*?"<>|]/gu, "_")
    .replace(/^[. ]+|[. ]+$/gu, "") || "document";
  return `${String(index + 1).padStart(3, "0")}-${safe}`;
};

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
  res.set(downloadHeaders(contentTypeForDocumentType(download.content.fileType),
    download.content.filename, disposition));
  res.send(download.content.bytes);
}

export function createDocumentsRouter(
  library: LibraryStore,
  documents: DocumentStore,
) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", asyncRoute(async (req, res) => {
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
    res.json(pageResponse("single-documents", filters, { ...page,
      items: page.items.flatMap((item) =>
        item.kind === "document" ? [item.document] : []),
    }));
  }));

  router.post("/parse-states", asyncRoute(async (req, res) => {
    const ids: unknown = req.body?.document_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some((id) => typeof id !== "string" || !id))
      reject(400, "document_ids must contain 1 to 100 document IDs");
    res.json(await documents.parseStates(scope(res), ids as string[]));
  }));

  router.get("/:documentId", asyncRoute(async (req, res) => {
    const document = await documents.metadata(scope(res), req.params.documentId)
      ?? reject(404, "Document not found");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(document);
  }));

  router.get("/:documentId/spreadsheet", asyncRoute(async (req, res) => {
    const file = await documents.read(
      scope(res), req.params.documentId, versionId(req), false,
    ) ?? reject(404, "Document not found");
    if (!isSpreadsheetDocumentType(file.fileType)) {
      return reject(400, "Document is not a spreadsheet");
    }
    const projection = await documentProjectionService.read({
      documentId: req.params.documentId,
      versionId: file.version.id,
      filename: file.filename,
      fileType: file.fileType,
      sourceSha256: file.version.source_sha256,
      readBytes: () => file.bytes,
    });
    if (projection.kind !== "spreadsheet-grid") {
      return reject(422, "Spreadsheet could not be displayed");
    }
    const sheets = new Map<string, Array<{
      address: string; value: string; row: number; column: number;
      rowSpan?: number; columnSpan?: number;
    }>>();
    for (const cell of projection.tableCells) {
      const values = sheets.get(cell.tableName) ?? [];
      values.push({
        address: cell.address,
        value: cell.displayValue,
        row: cell.row,
        column: cell.column,
        ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
        ...(cell.columnSpan ? { columnSpan: cell.columnSpan } : {}),
      });
      sheets.set(cell.tableName, values);
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      version_id: file.version.id,
      sheets: [...sheets].map(([name, cells]) => ({ name, cells })),
    });
  }));

  router.post(
    "/",
    singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      res.status(201).json(await documents.create(scope(res), {
        ...uploadedDocument(file),
        libraryKind: "file",
      }));
    }),
  );

  router.post("/download-zip", asyncRoute(async (req, res) => {
    const requested: unknown = req.body?.document_ids;
    if (!Array.isArray(requested) || !requested.length ||
        requested.length > MAX_ZIP_FILES || requested.some((id) =>
          typeof id !== "string" || !id.trim() || id.length > 200)) {
      reject(400, `document_ids must contain 1 to ${MAX_ZIP_FILES} document IDs`);
    }
    const ids = [...new Set((requested as string[]).map((id) => id.trim()))];
    const files = await documents.files(scope(res), ids, MAX_OBJECT_SIZE_BYTES);
    if (!files.length) reject(404, "No documents found");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    files.forEach((file, index) => zip.file(archiveName(file.filename, index), file.bytes));
    res.set(downloadHeaders("application/zip", "documents.zip"));
    await pipeline(zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }), res);
  }));

  router.delete("/:documentId", asyncRoute(async (req, res) => {
    if (!await documents.deleteDocument(scope(res), req.params.documentId)) {
      reject(404, "Document not found");
    }
    res.status(204).send();
  }));

  router.get("/:documentId/evidence-view", asyncRoute(async (req, res) => {
    const handle = evidenceHandle(req) ?? reject(400, "version_id and evidence are required");
    const requested = versionId(req) ?? reject(400, "version_id and evidence are required");
    const file = await documents.read(scope(res), req.params.documentId, requested, false)
      ?? reject(404, "Document not found");
    if (file.fileType.toLowerCase() !== "pdf") reject(404, "Document not found");
    const receipt = await evidence(req.params.documentId, file, () =>
      documentProjectionService.rehydratePdfLink(file.bytes, handle));
    const query = new URLSearchParams({ version_id: file.version.id,
      evidence: handle, rendition: "pdf" });
    const page = receipt.pageNumbers[0];
    const original = `/api/single-documents/${encodeURIComponent(req.params.documentId)}/file?${query}` +
      (page ? `#page=${page}` : "");
    const pages = receipt.pages.map((item) =>
      `<article id="page=${item.pageNumber}"><h2>Page ${item.pageNumber}</h2><p>${html(item.blockText)}</p></article>`,
    ).join("");
    const name = html(file.filename);
    res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
    res.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name} — verified evidence</title><style>body{margin:auto;max-width:52rem;padding:1rem;font:1rem/1.6 Georgia,serif}article{margin:1rem 0;padding:1rem;border-left:.3rem solid #c8102e;background:#f7f5f2}p{white-space:pre-wrap}a{color:#8b0d24}</style><h1>${name}</h1><a href="${html(original)}">Open the receipt-bound original PDF</a><main>${pages}</main></html>`);
  }));

  router.get("/:documentId/file", asyncRoute(async (req, res) => {
    const rendition = req.query.rendition;
    if (rendition !== undefined && rendition !== "pdf") {
      reject(400, "rendition must be pdf");
    }
    const handle = evidenceHandle(req);
    if (handle === null) reject(400, "Invalid evidence handle");
    if (handle) {
      const file = await documents.read(
        scope(res), req.params.documentId, versionId(req), rendition === "pdf",
      ) ?? reject(404, "Document not found");
      await evidence(req.params.documentId, file, () =>
        documentProjectionService.verifyPdfEvidence(file.bytes, handle));
    }
    await sendDownload(
      documents, req, res, rendition === "pdf",
      rendition === "pdf" ? "inline" : "attachment",
    );
  }));

  router.get("/:documentId/versions", asyncRoute(async (req, res) => {
    const versions = await documents.versions(scope(res), req.params.documentId)
      ?? reject(404, "Document not found");
    res.json(versions);
  }));

  router.post(
    "/:documentId/versions",
    singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      const resolvedName = filename(req, file.originalname);
      const version = await documents.addVersion(
        scope(res),
        req.params.documentId,
        uploadedDocument(file, resolvedName),
      );
      if (!version) reject(404, "Document not found");
      res.status(201).json(version);
    }),
  );

  router.post(
    "/:documentId/versions/from-document",
    asyncRoute(async (req, res) => {
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
    asyncRoute(async (req, res) => {
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
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      const resolvedName = filename(req, file.originalname);
      const result = await documents.replaceVersion(
        scope(res), req.params.documentId, req.params.versionId,
        uploadedDocument(file, resolvedName),
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
    asyncRoute(async (req, res) => {
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

  const resolveEdit = (mode: "accept" | "reject") => asyncRoute(
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
