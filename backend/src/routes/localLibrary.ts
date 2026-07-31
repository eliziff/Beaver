import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
  createLocalDocument,
  createLocalFolder,
  deleteLocalFolder,
  getLocalVersionFile,
  listLocalLibrary,
  moveLocalDocument,
  updateLocalDocument,
  updateLocalFolder,
} from "../lib/localDocumentStore";
import {
  parseLocalPdfOnDemand,
  queueLocalPdfParse,
  readLocalPdfParseState,
} from "../lib/localPdfIngestion";
import {
  lookupLocalPdfStructure,
  readLocalPdfEvidenceReceipt,
  rehydrateLocalPdfEvidence,
  type LocalPdfLocatorKind,
} from "../lib/localPdfLookup";
import { linkLocalDocxCitations } from "../lib/docxCitationLinking";
import {
  fixLocalDocxSupraCrossReferences,
  inspectLocalDocxAutomation,
} from "../lib/docxDeterministicCleanup";
import { singleFileUpload } from "../lib/upload";
import { imageValidationError } from "../lib/llm/images";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { asyncRoute } from "../lib/asyncRoute";
import {
  normalizeDocumentFilename,
  normalizeLibraryKind as libraryKind,
} from "../lib/normalize";

export const localLibraryRouter = Router();

localLibraryRouter.use((_req, _res, next) => {
  if (!isAnonymousLocalMode()) return next("router");
  next();
});
localLibraryRouter.use(requireAuth);

localLibraryRouter.get(
  "/:kind",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    res.json(await listLocalLibrary(res.locals.userId as string, kind));
  }),
);

localLibraryRouter.post(
  "/:kind/documents",
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    if (!req.file)
      return void res.status(400).json({ detail: "file is required" });
    const imageError = imageValidationError(
      req.file.originalname,
      req.file.buffer,
    );
    if (imageError) return void res.status(400).json({ detail: imageError });
    try {
      const document = await createLocalDocument({
        userId: res.locals.userId as string,
        kind,
        filename: req.file.originalname,
        bytes: req.file.buffer,
      });
      res.status(201).json(document);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Upload failed";
      res
        .status(detail.startsWith("Unsupported file type") ? 400 : 500)
        .json({ detail });
    }
  }),
);

localLibraryRouter.get(
  "/:kind/documents/:documentId/automation",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (kind !== "file") {
      return void res
        .status(400)
        .json({ detail: "Document automation applies to Library files" });
    }
    try {
      res.json(
        await inspectLocalDocxAutomation(
          res.locals.userId as string,
          req.params.documentId,
        ),
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "DOCX inspection failed";
      res.status(detail === "Document not found" ? 404 : 400).json({ detail });
    }
  }),
);

localLibraryRouter.post(
  "/:kind/folders",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const parentFolderId =
      typeof req.body?.parent_folder_id === "string"
        ? req.body.parent_folder_id
        : null;
    if (!name) return void res.status(400).json({ detail: "name is required" });
    const folder = await createLocalFolder(
      res.locals.userId as string,
      kind,
      name,
      parentFolderId,
    );
    if (!folder)
      return void res.status(404).json({ detail: "Parent folder not found" });
    res.status(201).json(folder);
  }),
);

localLibraryRouter.post(
  "/:kind/documents/:documentId/actions/fix-supras",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (kind !== "file") {
      return void res
        .status(400)
        .json({ detail: "Supra cleanup applies to Library files" });
    }
    try {
      res.json(
        await fixLocalDocxSupraCrossReferences(
          res.locals.userId as string,
          req.params.documentId,
        ),
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "DOCX supra cleanup failed";
      res.status(detail === "Document not found" ? 404 : 400).json({ detail });
    }
  }),
);

localLibraryRouter.post(
  "/:kind/documents/:documentId/actions/link-citations",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (kind !== "file") {
      return void res
        .status(400)
        .json({ detail: "Citation linking applies to Library files" });
    }
    try {
      res.json(
        await linkLocalDocxCitations(
          res.locals.userId as string,
          req.params.documentId,
        ),
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "DOCX citation linking failed";
      res.status(detail === "Document not found" ? 404 : 400).json({ detail });
    }
  }),
);

localLibraryRouter.get(
  "/:kind/documents/:documentId/pdf-parse",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const collection = await listLocalLibrary(userId, kind);
    if (
      !collection.documents.some((item) => item.id === req.params.documentId)
    ) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const versionId =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const file = await getLocalVersionFile(
      userId,
      req.params.documentId,
      versionId,
    );
    if (!file)
      return void res.status(404).json({ detail: "Version not found" });
    if (file.fileType !== "pdf") {
      return void res.status(409).json({ detail: "Version is not a PDF" });
    }
    const state = await readLocalPdfParseState(file.path);
    if (!state) {
      return void res.status(404).json({
        detail: "No structural PDF parse state exists for this version",
      });
    }
    res.json(state);
  }),
);

localLibraryRouter.post(
  "/:kind/documents/:documentId/lookup",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const collection = await listLocalLibrary(userId, kind);
    if (
      !collection.documents.some((item) => item.id === req.params.documentId)
    ) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const versionId =
      typeof req.body?.version_id === "string" ? req.body.version_id : null;
    const file = await getLocalVersionFile(
      userId,
      req.params.documentId,
      versionId,
    );
    if (!file)
      return void res.status(404).json({ detail: "Version not found" });
    if (file.fileType !== "pdf") {
      return void res.status(409).json({ detail: "Version is not a PDF" });
    }
    await parseLocalPdfOnDemand({
      documentId: req.params.documentId,
      versionId: file.version.id,
      sourcePath: file.path,
      sourceSha256: file.version.source_sha256,
    });
    const lookup = await lookupLocalPdfStructure(file.path, {
      locatorKind: req.body?.locator_kind as LocalPdfLocatorKind,
      locator: typeof req.body?.locator === "string" ? req.body.locator : "",
      endLocator:
        typeof req.body?.end_locator === "string"
          ? req.body.end_locator
          : undefined,
      contextBlocks:
        typeof req.body?.context_blocks === "number"
          ? req.body.context_blocks
          : undefined,
      page: typeof req.body?.page === "number" ? req.body.page : undefined,
      occurrence:
        typeof req.body?.occurrence === "number"
          ? req.body.occurrence
          : undefined,
    });
    res.status(lookup.status === "invalid" ? 400 : 200).json(lookup);
  }),
);

localLibraryRouter.post(
  "/:kind/evidence/rehydrate",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const handle =
      typeof req.body?.handle === "string" ? req.body.handle.trim() : "";
    if (!handle) {
      return void res.status(400).json({ detail: "handle is required" });
    }
    let receipt: Awaited<ReturnType<typeof readLocalPdfEvidenceReceipt>>;
    try {
      receipt = await readLocalPdfEvidenceReceipt(handle);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return void res.status(code === "ENOENT" ? 404 : 409).json({
        detail:
          code === "ENOENT"
            ? "PDF evidence receipt not found"
            : "PDF evidence receipt is invalid",
      });
    }
    const file = await getLocalVersionFile(
      res.locals.userId as string,
      receipt.source.document_id,
      receipt.source.version_id,
    );
    if (
      !file ||
      file.fileType !== "pdf" ||
      file.document.library_kind !== kind
    ) {
      return void res
        .status(409)
        .json({ detail: "PDF evidence source or artifact is unavailable" });
    }
    try {
      res.json(await rehydrateLocalPdfEvidence(file.path, handle));
    } catch {
      res
        .status(409)
        .json({ detail: "PDF evidence source or artifact is unavailable" });
    }
  }),
);

localLibraryRouter.post(
  "/:kind/documents/:documentId/actions/retry-pdf-parse",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const collection = await listLocalLibrary(userId, kind);
    if (
      !collection.documents.some((item) => item.id === req.params.documentId)
    ) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const versionId =
      typeof req.body?.version_id === "string" ? req.body.version_id : null;
    const file = await getLocalVersionFile(
      userId,
      req.params.documentId,
      versionId,
    );
    if (!file)
      return void res.status(404).json({ detail: "Version not found" });
    if (file.fileType !== "pdf") {
      return void res.status(409).json({ detail: "Version is not a PDF" });
    }
    const requestedOcrProvider = req.body?.ocr_provider;
    if (
      requestedOcrProvider !== undefined &&
      requestedOcrProvider !== "tesseract"
    ) {
      return void res
        .status(400)
        .json({ detail: "ocr_provider must be tesseract" });
    }
    const repairBody = req.body?.repair;
    let requestedRepair:
      | {
          model: string;
          effort: string;
        }
      | undefined;
    if (repairBody !== undefined) {
      if (
        !repairBody ||
        typeof repairBody !== "object" ||
        Array.isArray(repairBody) ||
        typeof repairBody.model !== "string" ||
        !repairBody.model.startsWith("codex:") ||
        repairBody.model.length <= "codex:".length ||
        repairBody.model.length > 166 ||
        /[\u0000-\u001f\u007f]/u.test(repairBody.model) ||
        repairBody.model.slice("codex:".length).trim() !==
          repairBody.model.slice("codex:".length) ||
        typeof repairBody.effort !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/u.test(repairBody.effort)
      ) {
        return void res.status(400).json({
          detail:
            "Structural repair requires a Codex model and reasoning effort selected in Assistant",
        });
      }
      requestedRepair = {
        model: repairBody.model.slice("codex:".length),
        effort: repairBody.effort,
      };
      const catalog = await getCodexModelCatalog();
      if (catalog.source === "unavailable") {
        return void res
          .status(503)
          .json({ detail: "Codex model catalog is unavailable" });
      }
      const catalogModel = catalog.models.find(
        (model) => model.slug === requestedRepair?.model,
      );
      if (
        !catalogModel ||
        !catalogModel.supportedReasoningLevels.some(
          (level) => level.effort === requestedRepair?.effort,
        )
      ) {
        return void res.status(400).json({
          detail:
            "The selected Codex model or reasoning effort is not available",
        });
      }
    }
    const current =
      requestedOcrProvider === "tesseract" || requestedRepair
        ? await readLocalPdfParseState(file.path)
        : null;
    if (requestedOcrProvider === "tesseract") {
      if (
        !current?.diagnostic_summary?.by_code ||
        !(Number(current.diagnostic_summary.by_code.OCR_REQUIRED) > 0)
      ) {
        return void res
          .status(409)
          .json({ detail: "No PDF pages currently require OCR" });
      }
    }
    if (requestedRepair && current?.structural_repair_available !== true) {
      return void res.status(409).json({
        detail: "No unresolved PDF structure is eligible for bounded repair",
      });
    }
    try {
      const state = await queueLocalPdfParse({
        documentId: req.params.documentId,
        versionId: file.version.id,
        sourcePath: file.path,
        sourceSha256:
          typeof file.version.source_sha256 === "string"
            ? file.version.source_sha256
            : undefined,
        force: true,
        ...(requestedOcrProvider === "tesseract"
          ? { ocrProvider: "tesseract" as const }
          : {}),
        ...(requestedRepair ? { repair: requestedRepair } : {}),
      });
      res.status(202).json(state);
    } catch (error) {
      if (requestedRepair) {
        return void res.status(503).json({
          detail:
            "Structural repair could not start. Check the local Codex installation and retry.",
        });
      }
      if (requestedOcrProvider !== "tesseract") throw error;
      const message = error instanceof Error ? error.message : "";
      res.status(503).json({
        detail: message.startsWith("Tesseract was not found")
          ? message
          : "OCR could not start. Check the local Tesseract installation and retry.",
      });
    }
  }),
);

localLibraryRouter.patch(
  "/:kind/folders/:folderId",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const name =
      typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : undefined;
    const hasParent = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "parent_folder_id",
    );
    const parentFolderId = hasParent
      ? typeof req.body.parent_folder_id === "string"
        ? req.body.parent_folder_id
        : null
      : undefined;
    const folder = await updateLocalFolder({
      userId: res.locals.userId as string,
      kind,
      folderId: req.params.folderId,
      name,
      parentFolderId,
    });
    if (!folder)
      return void res.status(404).json({ detail: "Folder not found" });
    res.json(folder);
  }),
);

localLibraryRouter.delete(
  "/:kind/folders/:folderId",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const deleted = await deleteLocalFolder(
      res.locals.userId as string,
      kind,
      req.params.folderId,
    );
    if (!deleted)
      return void res.status(404).json({ detail: "Folder not found" });
    res.status(204).send();
  }),
);

localLibraryRouter.patch(
  "/:kind/documents/:documentId/folder",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const folderId =
      typeof req.body?.folder_id === "string" ? req.body.folder_id : null;
    const document = await moveLocalDocument(
      res.locals.userId as string,
      kind,
      req.params.documentId,
      folderId,
    );
    if (!document)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(document);
  }),
);

localLibraryRouter.patch(
  "/:kind/documents/:documentId",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const collection = await listLocalLibrary(
      res.locals.userId as string,
      kind,
    );
    const current = collection.documents.find(
      (item) => item.id === req.params.documentId,
    );
    if (!current)
      return void res.status(404).json({ detail: "Document not found" });
    const filename = normalizeDocumentFilename(req.body?.filename, current.filename);
    if (!filename)
      return void res.status(400).json({ detail: "filename is required" });
    const document = await updateLocalDocument({
      userId: res.locals.userId as string,
      kind,
      documentId: req.params.documentId,
      filename,
      ...(Object.hasOwn(req.body ?? {}, "metadata")
        ? { metadata: req.body.metadata }
        : {}),
      ...(Object.hasOwn(req.body ?? {}, "notes")
        ? { notes: req.body.notes }
        : {}),
    });
    if (!document)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(document);
  }),
);
