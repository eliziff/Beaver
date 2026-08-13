import { Router } from "express";
import {
  getLocalVersionFile,
  getLocalDocumentResponse,
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
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { asyncRoute } from "../lib/asyncRoute";
import { normalizeLibraryKind as libraryKind } from "../lib/normalize";

export const localLibraryExtensionsRouter = Router();

localLibraryExtensionsRouter.get(
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
localLibraryExtensionsRouter.post(
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
localLibraryExtensionsRouter.post(
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

localLibraryExtensionsRouter.get(
  "/:kind/documents/:documentId/pdf-parse",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const document = await getLocalDocumentResponse(userId, req.params.documentId);
    if (!document || document.library_kind !== kind) {
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

localLibraryExtensionsRouter.post(
  "/:kind/documents/:documentId/lookup",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const document = await getLocalDocumentResponse(userId, req.params.documentId);
    if (!document || document.library_kind !== kind) {
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

localLibraryExtensionsRouter.post(
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

localLibraryExtensionsRouter.post(
  "/:kind/documents/:documentId/actions/retry-pdf-parse",
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const userId = res.locals.userId as string;
    const document = await getLocalDocumentResponse(userId, req.params.documentId);
    if (!document || document.library_kind !== kind) {
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
