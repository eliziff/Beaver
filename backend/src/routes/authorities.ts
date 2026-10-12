import { Router } from "express";
import { applicationScope, reject } from "../lib/applicationError";
import type { AuthoritiesWorkspaceApplication } from "../lib/authoritiesWorkspaceApplication";
import { bad, choice, decodeAuthoritiesDiscrepancyAction,
  decodeAuthoritiesInitialSettings, decodeAuthoritiesUserAction, decodePdfOpening, integer, object,
  text } from "../lib/authoritiesActionContract";
import { asyncRoute } from "../lib/asyncRoute";
import { applyAuthoritiesUserAction, readPinpoints } from "../lib/authoritiesActions";
import { statuteExcerptPageCounts } from "../lib/authoritiesBuild";
import { authoritiesBookFrontPdf } from "../lib/authoritiesCore";
import { decodeAuthoritiesDraft } from "../lib/authoritiesDomain";
import { followedRoute } from "../lib/followedRoute";
import { wordToPdfAvailable } from "../lib/convert";
import { AUTHORITIES_BOOK_SLOTS } from "mike/shared/authorities-sources.mjs";
import { requireAuth } from "../middleware/auth";
import { requiredFile, requiredUpload, singleFileUpload, uploadedDocument } from "../lib/upload";

function digest(value: unknown) {
  const result = text(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(result) ? result : bad();
}
function revision(value: unknown, multipart = false) {
  return integer(multipart && typeof value === "string" ? Number(value) : value, 1);
}

function frontActions(value: unknown) {
  const actions = object(value).actions;
  return (Array.isArray(actions) && actions.length <= 3 ? actions : bad()).map(decodeAuthoritiesUserAction);
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
    slot: choice(target.slot, AUTHORITIES_BOOK_SLOTS),
    ...(target.supplementId === undefined ? {} : { supplementId: text(target.supplementId) }) } };
}

export function createAuthoritiesRouter(application: AuthoritiesWorkspaceApplication) {
  const router = Router();
  router.use(requireAuth);
  router.get("/capabilities", (_req, res) => void res.json({ wordToPdf: wordToPdfAvailable() }));
  // A front drawn from a draft never saved (the import's preview book): no source of it is stored to read.
  router.post("/book-front", asyncRoute(async (req, res) => {
    const body = object(req.body);
    res.type("application/pdf").send(await authoritiesBookFrontPdf(
      decodeAuthoritiesDraft({ ...object(body.draft), ledger: object(body.draft).ledger ?? null }) ?? bad(),
      frontActions(body), text(body.title, 300)));
  }));
  router.post("/pinpoints", asyncRoute(async (req, res) => {
    const body = object(req.body);
    res.json(readPinpoints(body.text, body.start, body.end));
  }));
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
    res.status(201).json(await application.saveFile(
      applicationScope(res), requiredUpload(req),
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
  // The book's cover and first index page with the changes not yet made to the draft.
  router.post("/:id/book-front", asyncRoute(async (req, res) => {
    const actions = frontActions(req.body);
    const product = await application.get(applicationScope(res), text(req.params.id));
    const saved = decodeAuthoritiesDraft(product.state) ?? reject(409, "Authorities draft state is invalid");
    const state = actions.reduce((state, action) => applyAuthoritiesUserAction(state, action), saved);
    // A statute the book excerpts counts the pages a build keeps of it, read from its stored file.
    res.type("application/pdf").send(await authoritiesBookFrontPdf(saved, actions, product.title,
      await statuteExcerptPageCounts(state, application.sourceText(applicationScope(res), state))));
  }));
  router.post("/:id/refresh", asyncRoute(async (req, res) => {
    res.json(await application.refresh(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision)));
  }));
  router.post("/:id/sources", followedRoute(async (req, res, progress) => {
    const preparation = new AbortController(); res.once("close", () => preparation.abort());
    res.json(await application.prepareSources(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), preparation.signal,
      req.body?.authorityId === undefined ? undefined : text(req.body.authorityId, 200), progress));
  }));
  router.post("/:id/inputs/:role/refresh", asyncRoute(async (req, res) => {
    res.json(await application.refreshInput(applicationScope(res), text(req.params.id), {
      revision: revision(object(req.body).revision), role: text(req.params.role, 200),
    }));
  }));
  router.post("/:id/attachments/:authorityId", singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = requiredFile(req);
      res.json(await application.attachPdf(applicationScope(res), text(req.params.id), {
        revision: revision(req.body?.revision, true),
        authorityId: text(req.params.authorityId), file: uploadedDocument(file),
        language: choice(req.body?.language, ["en", "fr", "bilingual"] as const),
        autoFetched: req.body?.auto_fetched === "true",
      }));
    }));
  router.post("/:id/pdf-authority", asyncRoute(async (req, res) => {
    res.json({ authorityId: await application.pdfAuthority(applicationScope(res), text(req.params.id),
      decodePdfOpening(req.body)) });
  }));
  router.post("/:id/library-pdfs", asyncRoute(async (req, res) => {
    res.json(await application.attachLibraryPdf(applicationScope(res), text(req.params.id),
      libraryPdf(req.body)));
  }));
  router.post("/:id/book-parts/:slot", singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = requiredFile(req);
      res.json(await application.attachBookPdf(applicationScope(res), text(req.params.id), {
        revision: revision(req.body?.revision, true),
        slot: choice(req.params.slot, AUTHORITIES_BOOK_SLOTS),
        supplementId: typeof req.body?.supplement_id === "string"
          ? text(req.body.supplement_id) : undefined,
        file: uploadedDocument(file),
      }));
    }));
  router.post("/:id/annotations", asyncRoute(async (req, res) => {
    const body = object(req.body), abort = new AbortController(); res.once("close", () => abort.abort());
    res.json(await application.annotations(applicationScope(res), text(req.params.id), {
      authorityId: text(body.authorityId), bindingRole: text(body.bindingRole), sourceSha256: digest(body.sourceSha256),
      ...(body.passageMarking === undefined ? {} : { passageMarking: choice(body.passageMarking,
        ["none", "margin", "paragraph", "text", "sidelined"] as const) }),
    }, abort.signal));
  }));
  router.post("/:id/source-ocr", asyncRoute(async (req, res) => {
    const body = object(req.body), roles: unknown = body.roles;
    if (!Array.isArray(roles) || !roles.length || roles.length > 200)
      reject(400, "roles must contain 1 to 200 binding roles");
    const pages = body.pages === undefined ? undefined : Array.isArray(body.pages) &&
      body.pages.length > 0 && body.pages.length <= 2_000 ? body.pages.map((page) => integer(page, 1)) : bad();
    res.json(await application.sourceOcr(applicationScope(res), text(req.params.id),
      (roles as unknown[]).map((role) => text(role)), body.cancel === true, pages));
  }));
  router.post("/:id/build", followedRoute(async (req, res, progress) => {
    const build = new AbortController();
    res.once("close", () => build.abort());
    res.json(await application.build(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), build.signal, progress));
  }));
  return router;
}
