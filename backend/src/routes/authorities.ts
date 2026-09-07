import { Router } from "express";
import { applicationScope, reject } from "../lib/applicationError";
import type { AuthoritiesWorkspaceApplication } from "../lib/authoritiesWorkspaceApplication";
import { decodeAuthoritiesDiscrepancyAction, decodeAuthoritiesInitialSettings,
  decodeAuthoritiesUserAction } from "../lib/authoritiesActionContract";
import { asyncRoute } from "../lib/asyncRoute";
import { isJsonRecord } from "../lib/value";
import { requireAuth } from "../middleware/auth";
import { singleFileUpload, uploadedDocument } from "../lib/upload";

const bad = (): never => reject(400, "Invalid Authorities request");
const object = (value: unknown) => isJsonRecord(value) ? value : bad();
function text(value: unknown, max = 500) {
  if (typeof value !== "string") return bad();
  const result = value.trim();
  return result && result.length <= max ? result : bad();
}
function integer(value: unknown, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min) return bad();
  return Number(value);
}
function digest(value: unknown) {
  const result = text(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(result) ? result : bad();
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : bad();
}
function revision(value: unknown, multipart = false) {
  return integer(multipart && typeof value === "string" ? Number(value) : value, 1);
}

function documentImport(value: unknown): Parameters<
  AuthoritiesWorkspaceApplication["importDraft"]
>[1] {
  const item = object(value), source = object(item.source);
  const options = {
    ...(item.title === undefined ? {} : { title: text(item.title, 300) }),
    ...(item.projectId === undefined ? {} : {
      projectId: item.projectId === null ? null : text(item.projectId),
    }),
    ...(item.settings === undefined ? {} : {
      settings: decodeAuthoritiesInitialSettings(item.settings),
    }),
  };
  if (source.kind === "manual") return { source: { kind: "manual" }, ...options };
  if (source.kind !== "document") return bad();
  const version = source.version === "latest" ? "latest" as const : (() => {
    const pinned = object(source.version);
    return { versionId: text(pinned.versionId), sha256: digest(pinned.sha256) };
  })();
  return { source: { kind: "document", documentId: text(source.documentId), version },
    ...options };
}

function libraryPdf(value: unknown): Parameters<
  AuthoritiesWorkspaceApplication["attachLibraryPdf"]
>[2] {
  const item = object(value), target = object(item.target);
  if (Object.keys(item).sort().join(",") !== "documentId,revision,target,versionId") return bad();
  const common = { revision: revision(item.revision), documentId: text(item.documentId),
    versionId: text(item.versionId) };
  if (target.kind === "authority" &&
      Object.keys(target).sort().join(",") === "authorityId,kind,language") {
    return { ...common, target: { kind: "authority", authorityId: text(target.authorityId),
      language: choice(target.language, ["en", "fr", "bilingual"] as const) } };
  }
  const keys = Object.keys(target).sort().join(",");
  if (target.kind !== "book" || !["kind,slot", "kind,slot,supplementId"].includes(keys)) return bad();
  return { ...common, target: { kind: "book",
    slot: choice(target.slot, ["cover", "index", "supplemental"] as const),
    ...(target.supplementId === undefined ? {} : { supplementId: text(target.supplementId) }) } };
}

export function createAuthoritiesRouter(application: AuthoritiesWorkspaceApplication) {
  const router = Router();
  router.use(requireAuth);
  router.get("/", asyncRoute(async (req, res) => {
    const limit = req.query.limit === undefined ? undefined : integer(Number(req.query.limit), 1);
    if (limit !== undefined && limit > 100) return bad();
    const projectId = req.query.projectId === undefined
      ? undefined : text(req.query.projectId);
    res.json(await application.list(applicationScope(res), { projectId, limit }));
  }));
  router.post("/", asyncRoute(async (req, res) => {
    res.status(201).json(await application.importDraft(
      applicationScope(res), documentImport(req.body)));
  }));
  router.post("/documents", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const file = req.file ?? reject(400, "file is required");
    res.status(201).json(await application.saveFile(
      applicationScope(res), uploadedDocument(file),
      req.body?.projectId === undefined ? undefined : text(req.body.projectId)));
  }));
  router.get("/:id", asyncRoute(async (req, res) => {
    res.json(await application.get(applicationScope(res), text(req.params.id)));
  }));
  router.post("/:id/discrepancies", asyncRoute(async (req, res) => {
    const review = new AbortController(); res.once("close", () => review.abort());
    res.json(await application.discrepancies(
      applicationScope(res), text(req.params.id), review.signal));
  }));
  router.post("/:id/discrepancies/actions", asyncRoute(async (req, res) => {
    const review = new AbortController(); res.once("close", () => review.abort());
    res.json(await application.resolveDiscrepancy(applicationScope(res),
      text(req.params.id), decodeAuthoritiesDiscrepancyAction(req.body), review.signal));
  }));
  router.post("/:id/actions", asyncRoute(async (req, res) => {
    const body = object(req.body);
    res.json(await application.act(applicationScope(res), text(req.params.id),
      revision(body.revision), decodeAuthoritiesUserAction(body.action)));
  }));
  router.post("/:id/refresh", asyncRoute(async (req, res) => {
    res.json(await application.refresh(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision)));
  }));
  router.post("/:id/sources", asyncRoute(async (req, res) => {
    const preparation = new AbortController(); res.once("close", () => preparation.abort());
    res.json(await application.prepareSources(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), preparation.signal));
  }));
  router.post("/:id/inputs/:role/refresh", asyncRoute(async (req, res) => {
    res.json(await application.refreshInput(applicationScope(res), text(req.params.id), {
      revision: revision(object(req.body).revision), role: text(req.params.role, 200),
    }));
  }));
  router.post("/:id/attachments/:authorityId", singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      res.json(await application.attachPdf(applicationScope(res), text(req.params.id), {
        revision: revision(req.body?.revision, true),
        authorityId: text(req.params.authorityId), file: uploadedDocument(file),
        language: choice(req.body?.language, ["en", "fr", "bilingual"] as const),
      }));
    }));
  router.post("/:id/library-pdfs", asyncRoute(async (req, res) => {
    res.json(await application.attachLibraryPdf(applicationScope(res), text(req.params.id),
      libraryPdf(req.body)));
  }));
  router.post("/:id/book-parts/:slot", singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      res.json(await application.attachBookPdf(applicationScope(res), text(req.params.id), {
        revision: revision(req.body?.revision, true),
        slot: choice(req.params.slot, ["cover", "index", "supplemental"] as const),
        supplementId: typeof req.body?.supplement_id === "string"
          ? text(req.body.supplement_id) : undefined,
        file: uploadedDocument(file),
      }));
    }));
  router.post("/:id/prepare-highlights", asyncRoute(async (req, res) => {
    const preparation = new AbortController();
    res.once("close", () => preparation.abort());
    res.json(await application.prepareHighlights(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), preparation.signal));
  }));
  router.post("/:id/build", asyncRoute(async (req, res) => {
    const build = new AbortController();
    res.once("close", () => build.abort());
    res.json(await application.build(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), build.signal));
  }));
  return router;
}
