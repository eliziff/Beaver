import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { validateDocumentFile } from "../lib/documentTypes";
import { type DocumentStore } from "../lib/documentStore";
import {
  type LibraryScope,
  type LibraryStore,
} from "../lib/libraryStore";
import {
  normalizeLibraryKind,
} from "../lib/normalize";
import { encodePageCursor, pageRequest } from "../lib/pagination";
import { singleFileUpload } from "../lib/upload";
import {
  documentProjectionService,
  type PdfLocatorKind,
} from "../lib/documentProjectionService";
import { linkDocxCitations } from "../lib/docxCitationLinking";
import {
  fixDocumentSupras,
  inspectDocxAutomation,
} from "../lib/docxDeterministicCleanup";
import { getCodexModelCatalog } from "../lib/codexCatalog";
import { modelSupportsImageInput, type UserApiKeys } from "../lib/llm";
import type { LegalPdfLayoutConfig } from "../lib/legalPdfProcess";

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

export function createLibraryRouter(store: LibraryStore, documents: DocumentStore,
  modelApiKeys: (userId: string) => Promise<UserApiKeys | undefined>) {
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
      const fileType = validated.ok
        ? validated.fileType
        : reject(400, validated.error);
      res.status(201).json(await documents.create(scope, {
        filename: file.originalname,
        fileType,
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
  docxAction(router, documents, "/:kind/documents/:documentId/actions/link-citations",
    "Citation linking", linkDocxCitations);
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
    return { ...file, path: await documentProjectionService.publishPdf(
      file.bytes, file.version.source_sha256,
    ) };
  };

  router.get("/:kind/documents/:documentId/pdf-parse", libraryRoute(async (req, res, scope) => {
    const file = await pdf(scope, req.params.documentId, req.query.version_id);
    const state = await documentProjectionService.pdfState(file.path);
    if (!state) reject(404, "No structural PDF parse state exists for this version");
    res.json(state);
  }));

  router.post("/:kind/documents/:documentId/lookup", libraryRoute(async (req, res, scope) => {
    const file = await pdf(scope, req.params.documentId, req.body?.version_id);
    await documentProjectionService.parsePdf({ documentId: req.params.documentId,
      versionId: file.version.id, sourcePath: file.path,
      sourceSha256: file.version.source_sha256 });
    const lookup = await documentProjectionService.lookupPdf(file.path, {
      locatorKind: req.body?.locator_kind as PdfLocatorKind,
      locator: typeof req.body?.locator === "string" ? req.body.locator : "",
      endLocator: typeof req.body?.end_locator === "string" ? req.body.end_locator : undefined,
      contextBlocks: typeof req.body?.context_blocks === "number" ? req.body.context_blocks : undefined,
      page: typeof req.body?.page === "number" ? req.body.page : undefined,
      occurrence: typeof req.body?.occurrence === "number" ? req.body.occurrence : undefined,
    });
    res.status(lookup.status === "invalid" ? 400 : 200).json(lookup);
  }));

  router.post("/:kind/evidence/rehydrate", libraryRoute(async (req, res, scope) => {
    const handle = typeof req.body?.handle === "string" ? req.body.handle.trim() : "";
    if (!handle) reject(400, "handle is required");
    const receipt = await documentProjectionService.readPdfEvidence(handle).catch((error) =>
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409,
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "PDF evidence receipt not found" : "PDF evidence receipt is invalid"));
    try {
      const file = await pdf(scope, receipt.source.document_id, receipt.source.version_id);
      res.json(await documentProjectionService.rehydratePdfEvidence(file.path, handle));
    } catch {
      reject(409, "PDF evidence source or artifact is unavailable");
    }
  }));

  router.post("/:kind/documents/:documentId/actions/retry-pdf-parse",
    libraryRoute(async (req, res, scope) => {
      const file = await pdf(scope, req.params.documentId, req.body?.version_id);
      const ocr = req.body?.ocr_provider;
      if (ocr !== undefined && ocr !== "tesseract" && ocr !== "kraken-lite")
        reject(400, "ocr_provider must be kraken-lite or tesseract");
      const layoutProvider = req.body?.layout_provider;
      if (layoutProvider !== undefined && !["none", "local", "mllm"].includes(layoutProvider))
        reject(400, "layout_provider must be none, local, or mllm");
      const layout: LegalPdfLayoutConfig | null | undefined = layoutProvider === "none" ? null
        : layoutProvider === "local" ? { provider: "local" }
        : layoutProvider === "mllm" ? { provider: "mllm",
            model: typeof req.body?.layout_model === "string"
              ? req.body.layout_model.trim() : "gpt-5.6-luna" }
        : undefined;
      if (layout?.provider === "mllm" && !modelSupportsImageInput(layout.model))
        reject(400, "layout_model must be an available vision-capable model");
      const repairBody = req.body?.repair;
      let repair: { model: string; effort: string } | undefined;
      if (repairBody !== undefined) {
        const encoded = typeof repairBody?.model === "string" ? repairBody.model : "";
        if (!encoded.startsWith("codex:") || encoded.length > 166 ||
            encoded.slice(6).trim() !== encoded.slice(6) ||
            !/^[A-Za-z0-9_-]{1,32}$/u.test(repairBody?.effort))
          reject(400, "Structural repair requires a Codex model and reasoning effort selected in Assistant");
        repair = { model: encoded.slice(6), effort: repairBody.effort };
        const catalog = await getCodexModelCatalog();
        const model = catalog.models.find(({ slug }) => slug === repair?.model);
        if (catalog.source === "unavailable") reject(503, "Codex model catalog is unavailable");
        if (!model?.supportedReasoningLevels.some(({ effort }) => effort === repair?.effort))
          reject(400, "The selected Codex model or reasoning effort is not available");
      }
      const current = ocr || repair || layoutProvider
        ? await documentProjectionService.pdfState(file.path) : null;
      if (ocr && !(Number(current?.diagnostic_summary?.by_code?.OCR_REQUIRED) > 0))
        reject(409, "No PDF pages currently require OCR");
      if (repair && current?.structural_repair_available !== true)
        reject(409, "No unresolved PDF structure is eligible for bounded repair");
      try {
        const apiKeys = layout?.provider === "mllm" ? await modelApiKeys(scope.userId) : undefined;
        res.status(202).json(await documentProjectionService.queuePdf({
          documentId: req.params.documentId, versionId: file.version.id,
          sourcePath: file.path, sourceSha256: file.version.source_sha256, force: true,
          ...(ocr ? { ocrProvider: ocr } : {}), ...(repair ? { repair } : {}),
          ...(layoutProvider ? { layout } : {}), ...(apiKeys ? { apiKeys } : {}),
        }));
      } catch (error) {
        if (repair) reject(503, "Structural repair could not start. Check the local Codex installation and retry.");
        if (layoutProvider) reject(503, "PDF layout analysis could not start. Check the selected model and local runtime or provider credentials.");
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
