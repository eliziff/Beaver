import { Router, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { requireAuth } from "../middleware/auth";
import { ApplicationError, applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import {
  contentTypeForDocumentType,
  isSpreadsheetDocumentType,
} from "../lib/documentTypes";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import { pageRequest, pageResponse } from "../lib/pagination";
import { downloadHeaders, MAX_OBJECT_SIZE_BYTES,
  normalizeDownloadFilename } from "../lib/storage";
import { singleFileUpload, uploadedDocument } from "../lib/upload";
import { documentProjectionService } from "../lib/documentProjectionService";
import { sha256 } from "../lib/hash";
import { spreadsheetToLLMStructure } from "../lib/spreadsheet";
import { z } from "zod";
import { commitResearchFile, pageResearchItems, readResearchFile,
  researchFileActionSchema, researchSourceKey } from "../lib/researchFile";
import { researchCaptureRuleSchema, runResearchFileQuery,
  verifyResearchPassage } from "../lib/researchFileQuery";

const scope = applicationScope, MAX_ZIP_FILES = 100;
const researchVersion = z.string().trim().min(1).max(200);
const revisionNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workingRevision = z.union([
  revisionNumber, z.string().regex(/^\d+$/u).transform(Number),
]).pipe(revisionNumber);
const versionComment = (value: unknown) => value === undefined ? undefined
  : z.string().max(1_000).parse(value);
const deleteExpectation = z.object({
  expected_current_version_id: researchVersion,
  expected_working_revision: workingRevision,
  expected_project_id: researchVersion.nullable(),
  expected_folder_id: researchVersion.nullable(),
}).strict();
const researchQuery = z.object({ version_id: researchVersion,
  working_revision: workingRevision,
  text: z.string().trim().min(1).max(10_000).optional(),
  syntax: z.enum(["literal", "terms"]), target: z.enum(["sources", "passages"]),
  sourceIds: z.array(z.string().uuid()).max(10_000).optional(),
  labelIds: z.array(z.string().uuid()).max(1_000).optional(),
  unlabelled: z.boolean().optional(),
  rules: z.array(researchCaptureRuleSchema).max(50).optional(),
  conflict: z.enum(["prompt", "first", "longer", "shorter", "append"]).optional(),
  after: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(5_000).optional() }).strict()
  .refine((input) => Boolean(input.text) !== Boolean(input.rules?.length),
    "Supply either text or capture rules");
const researchConflict = (): never => { throw new ApplicationError(409,
  "This research file changed. Reload it.", { code: "revision_conflict" }); };

const versionId = (req: Request) =>
  typeof req.query.version_id === "string" ? req.query.version_id : null;

const evidenceHandle = (req: Request) => !Object.hasOwn(req.query, "evidence")
  ? undefined
  : typeof req.query.evidence === "string" && req.query.evidence.trim()
    ? req.query.evidence.trim() : null;

const html = (value: unknown) => String(value).replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

async function evidence<T>(load: () => Promise<T>) {
  try {
    return await load();
  } catch { return reject(410, "Evidence is no longer available"); }
}

const projectionReference = (documentId: string, versionId: string, sourceSha256: string) => ({
  documentId,
  versionId,
  sourceSha256,
});

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
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
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

  router.get("/:documentId/research", asyncRoute(async (req, res) => {
    const file = await readResearchFile(documents, scope(res), req.params.documentId)
      ?? reject(404, "Research file not found");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(file);
  }));

  router.get("/:documentId/research/items", asyncRoute(async (req, res) => {
    const kind = z.enum(["passages", "queries"]).parse(req.query.kind), sourceId =
      z.string().uuid().optional().parse(req.query.source_id), file = await readResearchFile(
        documents, scope(res), req.params.documentId) ?? reject(404, "Research file not found");
    if (sourceId && !file.state.sources[sourceId]) reject(404, "Research source not found");
    const contentRevision = kind === "queries" ? file.state.queries?.sha256 ?? ""
      : sourceId ? file.state.sources[sourceId]!.passages?.sha256 ?? ""
      : sha256(JSON.stringify(Object.values(file.state.sources).map(({ id, passages }) =>
          [id, passages?.sha256 ?? ""]))),
      filters = { document_id: req.params.documentId, content_revision: contentRevision,
        kind, source_id: sourceId ?? null },
      { after, limit } = pageRequest<[number]>(req.query as Record<string, unknown>,
        "research-items", filters, ["number"]), page = await pageResearchItems(
        documents, scope(res), file, kind, after?.[0] ?? 0, limit,
        sourceId && kind === "passages" ? [sourceId] : undefined);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ ...pageResponse("research-items", filters, { items: page.items,
      nextAfter: page.nextOffset === null ? null : [page.nextOffset] }), total: page.total });
  }));

  router.post("/:documentId/research/actions", asyncRoute(async (req, res) => {
    const version = researchVersion.parse(req.body?.version_id);
    const revision = workingRevision.parse(req.body?.working_revision);
    const current = await readResearchFile(documents, scope(res), req.params.documentId)
      ?? researchConflict();
    if (current.versionId !== version || current.workingRevision !== revision)
      researchConflict();
    const requested = researchFileActionSchema.parse(req.body?.action),
      action = await verifyResearchPassage(current, requested);
    const file = await commitResearchFile(documents, scope(res), current, action)
      ?? researchConflict();
    const sourceId = requested.type === "passage" ? requested.sourceId
      : requested.type === "source" ? Object.values(file.state.sources).find(({ reference }) =>
        researchSourceKey(reference) === researchSourceKey(requested.reference))?.id : undefined,
      receipt = sourceId && action.type === "merge" ? action.evidence?.[0] : undefined;
    res.json({ ...file, ...(sourceId ? { sourceId } : {}),
      ...(receipt ? { evidenceId: receipt.evidence_id } : {}) });
  }));

  router.post("/:documentId/research/query", asyncRoute(async (req, res) => {
    const input = researchQuery.parse(req.body);
    const result = await runResearchFileQuery(documents, scope(res), req.params.documentId, {
      versionId: input.version_id, workingRevision: input.working_revision,
      text: input.text, syntax: input.syntax, target: input.target,
      sourceIds: input.sourceIds, labelIds: input.labelIds, unlabelled: input.unlabelled, limit: input.limit,
      rules: input.rules, conflict: input.conflict, after: input.after,
    });
    res.json({ file: result.file, receipt: result.receipt, coverage: result.coverage });
  }));

  router.get("/:documentId/spreadsheet", asyncRoute(async (req, res) => {
    const file = await documents.read(
      scope(res), req.params.documentId, versionId(req), false,
    ) ?? reject(404, "Document not found");
    if (!isSpreadsheetDocumentType(file.fileType)) {
      return reject(400, "Document is not a spreadsheet");
    }
    if (sha256(file.bytes) !== file.version.source_sha256)
      throw new Error("Document source bytes no longer match their version");
    const grid = await spreadsheetToLLMStructure(file.bytes, file.fileType);
    const sheets = new Map<string, Array<{
      address: string; value: string; row: number; column: number;
      rowSpan?: number; columnSpan?: number;
    }>>();
    for (const cell of grid.tableCells) {
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
    const expected = deleteExpectation.parse(req.body);
    if (!await documents.deleteDocument(scope(res), req.params.documentId, true, {
      versionId: expected.expected_current_version_id,
      workingRevision: expected.expected_working_revision,
      projectId: expected.expected_project_id,
      folderId: expected.expected_folder_id,
    })) reject(409, "Document changed before it could be deleted");
    res.status(204).send();
  }));

  router.get("/:documentId/evidence-view", asyncRoute(async (req, res) => {
    const handle = evidenceHandle(req) ?? reject(400, "version_id and evidence are required");
    const requested = versionId(req) ?? reject(400, "version_id and evidence are required");
    const [found, metadata] = await Promise.all([
      documents.projectionSource(scope(res), req.params.documentId, requested),
      documents.metadata(scope(res), req.params.documentId),
    ]);
    const source = found ?? reject(404, "Document not found");
    if (source.fileType.toLowerCase() !== "pdf") reject(404, "Document not found");
    const receipt = await evidence(() => documentProjectionService.rehydratePdfEvidence(
      handle,
      projectionReference(req.params.documentId, source.versionId, source.sourceSha256),
    ));
    const query = new URLSearchParams({ version_id: source.versionId,
      evidence: handle, rendition: "pdf" });
    const page = receipt.link.page_numbers[0];
    const original = `/api/single-documents/${encodeURIComponent(req.params.documentId)}/file?${query}` +
      (page ? `#page=${page}` : "");
    const pages = receipt.pages.map((item) =>
      `<article id="page=${item.page_number}"><h2>Page ${item.page_number}</h2><p>${html(item.text)}</p></article>`,
    ).join("");
    const name = html(metadata?.filename || "document.pdf");
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
      await evidence(() => documentProjectionService.verifyPdfEvidence(
        file.bytes,
        handle,
        projectionReference(
          req.params.documentId,
          file.version.id,
          file.version.source_sha256,
        ),
      ));
      res.setHeader("Cache-Control", "private, no-store");
      res.set(downloadHeaders(
        contentTypeForDocumentType(file.fileType),
        file.filename,
        rendition === "pdf" ? "inline" : "attachment",
      ));
      return void res.send(file.bytes);
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
      const expectedCurrentVersionId = researchVersion.parse(
        req.body?.expected_current_version_id);
      const expectedCurrentWorkingRevision = workingRevision.parse(
        req.body?.expected_working_revision);
      const version = await documents.addVersion(
        scope(res),
        req.params.documentId,
        { ...uploadedDocument(file, resolvedName), expectedCurrentVersionId,
          expectedCurrentWorkingRevision, comment: versionComment(req.body?.comment) },
      );
      if (!version) reject(409, "Document changed before the upload completed");
      res.status(201).json(version);
    }),
  );

  router.post("/:documentId/versions/:versionId/restore", asyncRoute(async (req, res) => {
    const expected = researchVersion.parse(req.body?.expected_current_version_id);
    const revision = workingRevision.parse(req.body?.expected_working_revision);
    const result = await documents.restoreVersion(
      scope(res), req.params.documentId, req.params.versionId, expected, revision,
      versionComment(req.body?.comment),
    );
    if (result.status === "restored") return void res.status(201).json(result.version);
    reject(result.status === "missing" ? 404 : 409, result.status === "missing"
      ? "Version not found" : result.status === "conflict"
        ? "Document changed before it could be restored"
        : "Versions with pending tracked changes cannot be restored");
  }));

  router.post("/:documentId/versions/checkpoint", asyncRoute(async (req, res) => {
    const expected = researchVersion.parse(req.body?.expected_current_version_id);
    const result = await documents.checkpointVersion(scope(res), req.params.documentId,
      expected, workingRevision.parse(req.body?.expected_working_revision),
      versionComment(req.body?.comment));
    if (result.status === "missing") reject(404, "Document not found");
    if (result.status === "conflict") reject(409, "Document changed before the version was created");
    if (result.status === "pending-edits")
      reject(409, "Resolve pending tracked changes before creating a version");
    if (result.status === "created") res.status(201).json(result.version);
  }));

  router.get("/:documentId/versions/:versionId/compare", asyncRoute(async (req, res) => {
    const baseline = researchVersion.parse(req.query.baseline_version_id);
    const result = await documents.compareVersions(
      scope(res), req.params.documentId, baseline, req.params.versionId,
    );
    if (result.status === "compared") {
      res.set(downloadHeaders(contentTypeForDocumentType("docx"), result.filename));
      return void res.send(result.bytes);
    }
    reject(result.status === "missing" ? 404 : 400, result.status === "missing"
      ? "Version not found" : result.status === "type-mismatch"
        ? "Comparison requires two DOCX versions" : "Choose two different versions");
  }));

  const resolveEdits = (mode: "accept" | "reject") => asyncRoute(
    async (req, res) => {
      const editIds = req.body?.edit_ids;
      if (!Array.isArray(editIds) || !editIds.length || editIds.length > 1_000 ||
          editIds.some((id) => typeof id !== "string" || !id.trim()))
        reject(400, "edit_ids must contain 1 to 1000 tracked edit IDs");
      const result = await documents.resolveEdits(
        scope(res), req.params.documentId, [...new Set(editIds as string[])], mode,
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

  router.post("/:documentId/edits/accept", resolveEdits("accept"));
  router.post("/:documentId/edits/reject", resolveEdits("reject"));
  return router;
}
