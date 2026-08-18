import { readFile } from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/asyncRoute";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { getLocalVersionFile } from "../lib/localDocumentStore";
import { documentProjectionService } from "../lib/documentProjectionService";
import { buildContentDisposition } from "../lib/storage";
import { requireAuth } from "../middleware/auth";

const router = Router();

const requestedVersionId = (req: Request) =>
  typeof req.query.version_id === "string" ? req.query.version_id : null;

function requestedEvidence(req: Request) {
  if (!Object.hasOwn(req.query, "evidence")) return undefined;
  return typeof req.query.evidence === "string" && req.query.evidence.trim()
    ? req.query.evidence.trim()
    : null;
}

const escapeHtml = (value: unknown) => String(value).replace(
  /[&<>"']/gu,
  (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!,
);

async function receiptEvidence<T extends { documentId: string; versionId: string }>(
  req: Request,
  res: Response,
  file: NonNullable<Awaited<ReturnType<typeof getLocalVersionFile>>>,
  load: () => Promise<T>,
) {
  try {
    const evidence = await load();
    if (evidence.documentId !== req.params.documentId ||
        evidence.versionId !== file.version.id) {
      throw new Error("Evidence source mismatch");
    }
    return evidence;
  } catch {
    res.status(410).json({ detail: "Evidence is no longer available" });
    return null;
  }
}

router.get(
  "/:documentId/evidence-view",
  requireAuth,
  asyncRoute(async (req, res) => {
    const versionId = requestedVersionId(req);
    const handle = requestedEvidence(req);
    if (!versionId || !handle) {
      return void res.status(400).json({
        detail: "version_id and evidence are required",
      });
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
      documentProjectionService.rehydratePdfLink(file.path, handle),
    );
    if (!evidence) return;
    const query = new URLSearchParams({
      version_id: file.version.id, evidence: handle, rendition: "pdf",
    });
    const firstPage = evidence.pageNumbers[0];
    const originalHref =
      `/single-documents/${encodeURIComponent(req.params.documentId)}/file?` +
      `${query}${firstPage ? `#page=${firstPage}` : ""}`;
    const pages = evidence.pages.map((page) =>
      `<article class="page" id="page=${page.pageNumber}" aria-labelledby="page-${page.pageNumber}-heading">
        <h2 id="page-${page.pageNumber}-heading">Page ${page.pageNumber}</h2>
        <p>${escapeHtml(page.blockText)}</p>
      </article>`,
    ).join("\n");
    const name = escapeHtml(file.version.filename);
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
  <title>${name} — verified evidence</title>
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
    <h1>${name}</h1>
    <a href="${escapeHtml(originalHref)}">Open the receipt-bound original PDF</a>
  </header>
  <main aria-label="Verified PDF evidence">${pages}</main>
</body>
</html>`);
  }),
);

router.get(
  "/:documentId/file",
  requireAuth,
  asyncRoute(async (req, res, next) => {
    const handle = requestedEvidence(req);
    if (handle === undefined) return void next("route");
    if (handle === null) {
      return void res.status(400).json({ detail: "Invalid evidence handle" });
    }
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      req.params.documentId,
      requestedVersionId(req),
      true,
    );
    if (!file) return void res.status(404).json({ detail: "Document not found" });
    if (!await receiptEvidence(req, res, file, () =>
      documentProjectionService.verifyPdfEvidence(file.path, handle))) return;
    res.setHeader("Content-Type", contentTypeForDocumentType(file.fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", file.version.filename),
    );
    res.send(await readFile(file.path));
  }),
);

export const localDocumentExtensionsRouter = router;
