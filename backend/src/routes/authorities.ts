import { Router } from "express";
import { applicationScope, reject } from "../lib/applicationError";
import type {
  AuthorityOccurrence,
} from "../lib/authoritiesDomain";
import type {
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
function integer(value: unknown, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min) return bad();
  return Number(value);
}
function stringArray(value: unknown, max = 500) {
  if (!Array.isArray(value) || value.length > max) return bad();
  return value.map((item) => text(item));
}
function digest(value: unknown) {
  const result = text(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(result) ? result : bad();
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : bad();
}
const authorityKinds = ["case", "legislation", "commentary", "other"] as const;

function reference(value: unknown): AuthorityOccurrence["reference"] {
  if (value === null) return null;
  const item = object(value);
  return { kind: choice(item.kind, ["supra", "ibid"] as const),
    targetAuthorityId: text(item.targetAuthorityId) };
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
    case "rename-authority": return { type, authorityId: text(item.authorityId),
      displayName: nullableText(item.displayName, 2_000) };
    case "reorder-authorities": return { type, authorityIds: stringArray(item.authorityIds) };
    case "split-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      cursor: integer(item.cursor, 1) };
    case "merge-occurrence": return { type, occurrenceId: text(item.occurrenceId) };
    case "relink-occurrence": return { type, occurrenceId: text(item.occurrenceId),
      authorityId: item.authorityId === null ? null : text(item.authorityId) };
    case "set-reference": return { type, occurrenceId: text(item.occurrenceId),
      reference: reference(item.reference) };
    case "begin-canlii-handoff": {
      if (item.pageUrl !== undefined) return bad();
      return { type, authorityId: text(item.authorityId) };
    }
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

function documentImport(value: unknown): Parameters<
  AuthoritiesWorkspaceApplication["importDraft"]
>[1] {
  const item = object(value), source = object(item.source);
  if (source.kind === "manual") return { source: { kind: "manual" },
    ...(item.title === undefined ? {} : { title: text(item.title, 300) }),
    ...(item.projectId === undefined ? {} : {
      projectId: item.projectId === null ? null : text(item.projectId),
    }) };
  if (source.kind !== "document") return bad();
  const version = source.version === "latest" ? "latest" as const : (() => {
    const pinned = object(source.version);
    return { versionId: text(pinned.versionId), sha256: digest(pinned.sha256) };
  })();
  return { source: { kind: "document", documentId: text(source.documentId), version },
    ...(item.title === undefined ? {} : { title: text(item.title, 300) }),
    ...(item.projectId === undefined ? {} : {
      projectId: item.projectId === null ? null : text(item.projectId),
    }) };
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
  router.post("/:id/actions", asyncRoute(async (req, res) => {
    const body = object(req.body);
    res.json(await application.act(applicationScope(res), text(req.params.id),
      revision(body.revision), decodeAuthoritiesUserAction(body.action)));
  }));
  router.post("/:id/refresh", asyncRoute(async (req, res) => {
    res.json(await application.refresh(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision)));
  }));
  router.post("/:id/attachments/:authorityId", singleFileUpload("file"),
    asyncRoute(async (req, res) => {
      const file = req.file ?? reject(400, "file is required");
      res.json(await application.attachPdf(applicationScope(res), text(req.params.id), {
        revision: revision(req.body?.revision, true),
        authorityId: text(req.params.authorityId), file: uploadedDocument(file),
      }));
    }));
  router.post("/:id/build", asyncRoute(async (req, res) => {
    res.json(await application.build(applicationScope(res), text(req.params.id),
      revision(object(req.body).revision)));
  }));
  return router;
}
