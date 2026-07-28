import { readFile } from "node:fs/promises";
import { Router, type Request, type Response } from "express";
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
  resolveLocalTrackedEdit,
} from "../lib/localDocumentStore";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { extractTrackedChangeIds } from "../lib/docxTrackedChanges";
import { buildContentDisposition } from "../lib/storage";
import { singleFileUpload } from "../lib/upload";
import { imageValidationError } from "../lib/llm/images";
import {
  rehydrateLocalPdfLinkEvidence,
  verifyLocalPdfLinkEvidence,
} from "../lib/localPdfLookup";
import { asyncRoute } from "../lib/asyncRoute";

export const localDocumentsRouter = Router();

function requestedVersionId(req: Request) {
  return typeof req.query.version_id === "string" ? req.query.version_id : null;
}

function requestedEvidence(req: Request) {
  if (!Object.prototype.hasOwnProperty.call(req.query, "evidence")) {
    return undefined;
  }
  return typeof req.query.evidence === "string" && req.query.evidence.trim()
    ? req.query.evidence.trim()
    : null;
}

function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

async function receiptEvidence<T extends { documentId: string; versionId: string }>(
  req: Request,
  res: Response,
  file: NonNullable<Awaited<ReturnType<typeof getLocalVersionFile>>>,
  load: () => Promise<T>,
) {
  try {
    const evidence = await load();
    if (
      evidence.documentId !== req.params.documentId ||
      evidence.versionId !== file.version.id
    ) {
      throw new Error("Evidence source mismatch");
    }
    return evidence;
  } catch {
    res.status(410).json({ detail: "Evidence is no longer available" });
    return null;
  }
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
    const imageError = imageValidationError(
      req.file.originalname,
      req.file.buffer,
    );
    if (imageError) return void res.status(400).json({ detail: imageError });
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
  "/:documentId/evidence-view",
  requireAuth,
  asyncRoute(async (req, res) => {
    const versionId = requestedVersionId(req);
    const handle = requestedEvidence(req);
    if (!versionId || !handle) {
      return void res
        .status(400)
        .json({ detail: "version_id and evidence are required" });
    }
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      versionId,
    );
    if (!file || file.fileType.toLowerCase() !== "pdf") {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const evidence = await receiptEvidence(req, res, file, () =>
      rehydrateLocalPdfLinkEvidence(file.path, handle),
    );
    if (!evidence) return;

    const query = new URLSearchParams({
      version_id: file.version.id,
      evidence: handle,
    });
    const firstPage = evidence.pageNumbers[0];
    const originalHref =
      `/single-documents/${encodeURIComponent(req.params.documentId)}/display?` +
      `${query.toString()}${firstPage ? `#page=${firstPage}` : ""}`;
    const pages = evidence.pages
      .map(
        (page) => `<article class="page" id="page=${page.pageNumber}" aria-labelledby="page-${page.pageNumber}-heading">
          <h2 id="page-${page.pageNumber}-heading">Page ${page.pageNumber}</h2>
          <p>${escapeHtml(page.blockText)}</p>
        </article>`,
      )
      .join("\n");
    const filename = escapeHtml(file.version.filename);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${filename} — verified evidence</title>
  <style>
    :root { color-scheme: light; font-family: Georgia, "Times New Roman", serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #231f20; background: #f7f5f2; line-height: 1.65; }
    header { border-top: .45rem solid #c8102e; border-bottom: 1px solid #ddd5cf; background: #fff; }
    header, main { padding: 1rem max(1rem, calc((100% - 52rem) / 2)); }
    h1 { margin: 0 0 .4rem; color: #8b0d24; font-size: clamp(1.35rem, 3vw, 2rem); }
    a { color: #8b0d24; text-underline-offset: .18em; }
    a:focus-visible { outline: 3px solid #c8102e; outline-offset: 3px; }
    .page { margin: 1.25rem 0; padding: 1.5rem; border: 1px solid #ddd5cf; border-left: .3rem solid #c8102e; background: #fff; }
    .page h2 { margin-top: 0; color: #8b0d24; font: 700 1rem/1.3 system-ui, sans-serif; }
    .page p { margin-bottom: 0; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>${filename}</h1>
    <a href="${escapeHtml(originalHref)}">Open the receipt-bound original PDF</a>
  </header>
  <main aria-label="Verified PDF evidence">
    ${pages}
  </main>
</body>
</html>`);
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
    const handle = requestedEvidence(req);
    if (handle === null) {
      return void res.status(400).json({ detail: "Invalid evidence handle" });
    }
    if (
      handle &&
      !(await receiptEvidence(req, res, file, () =>
        verifyLocalPdfLinkEvidence(file.path, handle),
      ))
    ) {
      return;
    }
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
    const imageError = imageValidationError(filename, req.file.buffer);
    if (imageError) return void res.status(400).json({ detail: imageError });
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
    const imageError = imageValidationError(filename, req.file.buffer);
    if (imageError) return void res.status(400).json({ detail: imageError });
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

async function handleTrackedEditResolution(
  req: Request,
  res: Response,
  mode: "accept" | "reject",
) {
  const result = await resolveLocalTrackedEdit({
    userId: res.locals.userId as string,
    documentId: req.params.documentId,
    editId: req.params.editId,
    mode,
  });
  if (result.status === "missing") {
    return void res.status(404).json({ detail: "Tracked edit not found" });
  }
  if (result.status === "conflict") {
    return void res
      .status(409)
      .json({ detail: `Tracked edit is already ${result.edit.status}` });
  }
  if (result.status === "invalid") {
    return void res
      .status(409)
      .json({ detail: "Tracked edit no longer matches this document version" });
  }
  const downloadUrl =
    `/single-documents/${encodeURIComponent(req.params.documentId)}/file` +
    `?version_id=${encodeURIComponent(result.version.id)}` +
    `&rev=${encodeURIComponent(result.version.source_sha256 ?? "")}`;
  res.json({
    ok: true,
    status: result.edit.status,
    version_id: result.version.id,
    version_number: result.version.version_number,
    download_url: downloadUrl,
  });
}

localDocumentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  asyncRoute((req, res) => handleTrackedEditResolution(req, res, "accept")),
);

localDocumentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  asyncRoute((req, res) => handleTrackedEditResolution(req, res, "reject")),
);
