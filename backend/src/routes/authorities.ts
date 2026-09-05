import { Router } from "express";
import { applicationScope, reject } from "../lib/applicationError";
import type {
  AuthorityOccurrence,
} from "../lib/authoritiesDomain";
import { AUTHORITIES_BOOK_ROLES, authoritiesProfileIds, type AuthoritiesBuildSettings,
  type AuthoritiesCover, type AuthoritiesDiscrepancyAction,
  type AuthoritiesProfileId } from "../lib/authoritiesDomain";
import type {
  AuthoritiesInitialSettings,
  AuthoritiesUserAction,
  AuthoritiesWorkspaceApplication,
} from "../lib/authoritiesWorkspaceApplication";
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
const nullableText = (value: unknown, max = 500) =>
  value === null ? null : text(value, max);
const plain = (value: unknown, max = 500) => {
  if (typeof value !== "string" || value.length > max ||
      /[\u0000-\u001f\u007f]/u.test(value)) return bad();
  return value.trim();
};
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
const authorityKinds = ["case", "legislation", "commentary", "other"] as const;
const settingsChoices = {
  sourceMode: ["automatic", "manual-originals", "render"], tabStyle: ["numeric", "alpha"],
  tableOrder: ["first-reference", "alphabetical"],
  tableDelivery: ["native-marks", "native-append", "linked-append"],
  tableLocation: ["pages", "pinpoints", "combined"],
  passageMarking: ["none", "margin", "paragraph", "text", "sidelined"],
  scannedPdfPolicy: ["page-margin", "cited-pages", "full"],
  missingSourcePolicy: ["placeholder", "omit"],
  filingMedium: ["electronic", "paper"],
  bookRole: AUTHORITIES_BOOK_ROLES,
} as const satisfies { [K in keyof AuthoritiesBuildSettings]: readonly AuthoritiesBuildSettings[K][] };

export function decodeAuthoritiesInitialSettings(value: unknown): AuthoritiesInitialSettings {
  return settings(value, true);
}
function settings(value: unknown, initial: true): AuthoritiesInitialSettings;
function settings(value: unknown, initial?: false): Partial<AuthoritiesBuildSettings>;
function settings(value: unknown, initial = false) {
  const item = object(value), allowed = new Set([
    ...Object.keys(settingsChoices), ...(initial
      ? ["profileId", "outputMode", "insertIntoDocument"] : []),
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) return bad();
  const result: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(settingsChoices)) if (item[key] !== undefined) {
    result[key] = choice(item[key], values);
  }
  if (initial && item.profileId !== undefined) result.profileId = choice(
    item.profileId, authoritiesProfileIds) as AuthoritiesProfileId;
  if (initial && item.outputMode !== undefined) result.outputMode = choice(
    item.outputMode, ["table", "book", "both"] as const);
  if (initial && item.insertIntoDocument !== undefined) result.insertIntoDocument =
    typeof item.insertIntoDocument === "boolean" ? item.insertIntoDocument : bad();
  if (!Object.keys(result).length) return bad();
  return result as AuthoritiesInitialSettings;
}

function reference(value: unknown): AuthorityOccurrence["reference"] {
  if (value === null) return null;
  const item = object(value);
  return { kind: choice(item.kind, ["supra", "ibid"] as const),
    targetAuthorityId: text(item.targetAuthorityId) };
}

function cover(value: unknown): AuthoritiesCover {
  const item = object(value), keys = ["courtFileNumber", "partyGroups", "applicationUnder", "title"];
  if (Object.keys(item).some((key) => !keys.includes(key)) ||
      !Array.isArray(item.partyGroups) || item.partyGroups.length > 50) return bad();
  return { courtFileNumber: plain(item.courtFileNumber, 100),
    applicationUnder: plain(item.applicationUnder, 2_000), title: plain(item.title),
    partyGroups: item.partyGroups.map((value) => {
      const group = object(value);
      if (Object.keys(group).some((key) => !["role", "parties"].includes(key)) ||
          !Array.isArray(group.parties) || group.parties.length > 50) return bad();
      return { role: plain(group.role, 100),
        parties: group.parties.map((party) => plain(party)) };
    }) };
}

export function decodeAuthoritiesUserAction(value: unknown): AuthoritiesUserAction {
  const item = object(value), type = text(item.type, 60);
  switch (type) {
    case "add-authority": {
      if (item.authority !== undefined) return bad();
      return { type, kind: choice(item.kind, authorityKinds),
      citation: text(item.citation, 2_000),
      ...(item.name === undefined ? {} : {
        name: item.name === null ? null : text(item.name, 2_000),
      }) };
    }
    case "remove-authority": return { type, authorityId: text(item.authorityId) };
    case "exclude-authority": return { type, authorityId: text(item.authorityId),
      excluded: typeof item.excluded === "boolean" ? item.excluded : bad() };
    case "edit-authority": return { type, authorityId: text(item.authorityId),
      kind: choice(item.kind, authorityKinds), citation: text(item.citation, 2_000),
      name: nullableText(item.name, 2_000) };
    case "rename-authority": return { type, authorityId: text(item.authorityId),
      displayName: nullableText(item.displayName, 2_000) };
    case "split-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      cursor: integer(item.cursor, 1) };
    case "merge-occurrence": return { type, occurrenceId: text(item.occurrenceId) };
    case "remove-occurrence": return { type, occurrenceId: text(item.occurrenceId) };
    case "set-authority-span":
    case "set-pinpoint-span": return { type, occurrenceId: text(item.occurrenceId),
      start: integer(item.start), end: integer(item.end, 1) };
    case "relink-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      authorityId: item.authorityId === null ? null : text(item.authorityId) };
    case "set-reviewed": return { type, occurrenceId: text(item.occurrenceId),
      reviewed: typeof item.reviewed === "boolean" ? item.reviewed : bad() };
    case "set-reference": return { type, occurrenceId: text(item.occurrenceId),
      reference: reference(item.reference) };
    case "begin-canlii-handoff": {
      if (item.pageUrl !== undefined) return bad();
      return { type, authorityId: text(item.authorityId) };
    }
    case "clear-authority-source": return { type, authorityId: text(item.authorityId) };
    case "clear-book-part": return { type,
      slot: choice(item.slot, ["cover", "index"] as const) };
    case "remove-book-supplement": return { type, id: text(item.id) };
    case "set-cover": return { type, cover: cover(item.cover) };
    case "set-profile": return { type,
      profileId: choice(item.profileId, authoritiesProfileIds) };
    case "set-settings": return { type, settings: settings(item.settings) };
    case "set-output-mode": return { type,
      outputMode: choice(item.outputMode, ["table", "book", "both"] as const) };
    case "set-document-output": return { type,
      enabled: typeof item.enabled === "boolean" ? item.enabled : bad() };
    default: return bad();
  }
}

function revision(value: unknown, multipart = false) {
  return integer(multipart && typeof value === "string" ? Number(value) : value, 1);
}

export function decodeAuthoritiesDiscrepancyAction(value: unknown): {
  id: string; action: AuthoritiesDiscrepancyAction; revision: number;
} {
  const item = object(value);
  if (Object.keys(item).sort().join(",") !== "action,id,revision") return bad();
  return { id: text(item.id, 64), action: choice(item.action,
    ["ignore", "pinpoint", "quote_exact", "quote_editorial"] as const),
  revision: revision(item.revision) };
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
  router.post("/:id/source", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const file = req.file ?? reject(400, "file is required");
    res.json(await application.replaceSource(applicationScope(res), text(req.params.id), {
      revision: revision(req.body?.revision, true), file: uploadedDocument(file),
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
  router.post("/:id/build", asyncRoute(async (req, res) => {
    const build = new AbortController();
    res.once("close", () => build.abort());
    res.json(await application.build(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision), build.signal));
  }));
  return router;
}
