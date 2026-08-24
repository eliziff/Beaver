import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { ChatStore } from "../lib/chatStore";
import { type DocumentStore } from "../lib/documentStore";
import {
  type ProjectScope,
  type ProjectStore,
} from "../lib/projectStore";
import { pageRequest, pageResponse } from "../lib/pagination";
import { singleFileUpload, uploadedDocument } from "../lib/upload";
import { isJsonRecord, jsonRecord } from "../lib/value";

const bodyOf = (req: Request): Record<string, unknown> =>
  jsonRecord(req.body) ?? {};

function requiredText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim()) {
    return reject(400, `${name} is required`);
  }
  const text = value.trim();
  if (text.length > max) reject(400, `${name} must be at most ${max} characters`);
  return text;
}

function optionalText(value: unknown, name: string, max: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    return reject(400, `${name} must be text or null`);
  }
  const text = value.trim();
  if (text.length > max) reject(400, `${name} must be at most ${max} characters`);
  return text || null;
}

function nullableId(value: unknown, name: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  return reject(400, `${name} must be a string or null`);
}

function projectMetadata(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (!isJsonRecord(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
    return reject(400, "metadata must be an object no larger than 64 KB");
  }
  return value;
}

function sharing(value: unknown, ownEmail?: string) {
  const parsed = z.array(z.string().trim().toLowerCase().email().max(320))
    .max(100).safeParse(value);
  if (!parsed.success) return reject(400, "shared_with must contain at most 100 email addresses");
  const own = ownEmail?.trim().toLowerCase();
  const emails = [...new Set(parsed.data)];
  if (own && emails.includes(own)) {
    reject(400, "You cannot share a project with yourself.");
  }
  return emails;
}

type Handler = (
  req: Request,
  res: Response,
  scope: ProjectScope,
) => Promise<unknown>;

export function createProjectsRouter(
  store: ProjectStore,
  chats: ChatStore,
  documents: DocumentStore,
) {
  const router = Router();
  router.use(requireAuth);

  const route = (handler: Handler) => asyncRoute((req, res) =>
    handler(req, res, applicationScope(res)));

  router.get("/", route(async (req, res, scope) => {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim().toLocaleLowerCase() : "";
    const filter = req.query.scope === "mine" ||
      req.query.scope === "shared-with-me" ? req.query.scope : "all";
    const filters = { q, scope: filter };
    const { after, limit } = pageRequest<[string, string]>(
      req.query, "projects", filters, ["string", "string"]);
    const page = await store.page(scope, { q, scope: filter, limit, after });
    res.json(pageResponse("projects", filters, page));
  }));

  router.post("/", route(async (req, res, scope) => {
    const body = bodyOf(req);
    res.status(201).json(await store.create(scope, {
      name: requiredText(body.name, "name", 120),
      cmNumber: optionalText(body.cm_number, "cm_number", 200),
      practice: optionalText(body.practice, "practice", 200),
      sharedWith: body.shared_with === undefined
        ? [] : sharing(body.shared_with, scope.userEmail),
      metadata: projectMetadata(body.metadata),
      notes: optionalText(body.notes, "notes", 500),
    }));
  }));

  router.get("/:projectId/directory", route(async (req, res, scope) => {
    const { projectId } = req.params;
    const q = typeof req.query.q === "string"
      ? req.query.q.trim().toLocaleLowerCase() : "";
    const parentFolderId = nullableId(req.query.parent_id, "parent_id");
    if (q && parentFolderId) reject(400, "q and parent_id cannot be used together");
    const filters = { project_id: projectId, q, parent_id: q ? null : parentFolderId };
    const { after, limit } = pageRequest<[number, string, string]>(
      req.query, "project-directory", filters, ["number", "string", "string"]);
    const page = await store.directory(scope, projectId, {
      q, parentFolderId: filters.parent_id, limit, after,
    });
    res.json(pageResponse("project-directory", filters, page));
  }));

  router.get("/:projectId", route(async (req, res, scope) => {
    const project = await store.get(scope, req.params.projectId);
    if (!project) reject(404, "Project not found");
    res.json(project);
  }));

  router.get("/:projectId/people", route(async (req, res, scope) => {
    const people = await store.people(scope, req.params.projectId);
    if (!people) reject(404, "Project not found");
    res.json(people);
  }));

  router.patch("/:projectId", route(async (req, res, scope) => {
    const body = bodyOf(req);
    const update: Parameters<ProjectStore["update"]>[2] = {};
    if (Object.hasOwn(body, "name")) {
      update.name = requiredText(body.name, "name", 120);
    }
    if (Object.hasOwn(body, "cm_number")) {
      update.cmNumber = optionalText(body.cm_number, "cm_number", 200);
    }
    if (Object.hasOwn(body, "practice")) {
      update.practice = optionalText(body.practice, "practice", 200);
    }
    if (Object.hasOwn(body, "shared_with")) {
      update.sharedWith = sharing(body.shared_with, scope.userEmail);
    }
    if (Object.hasOwn(body, "metadata")) {
      update.metadata = projectMetadata(body.metadata) ?? {};
    }
    if (Object.hasOwn(body, "notes")) {
      update.notes = optionalText(body.notes, "notes", 500);
    }
    const project = await store.update(scope, req.params.projectId, update);
    if (!project) reject(404, "Project not found");
    res.json(project);
  }));

  router.delete("/:projectId", route(async (req, res, scope) => {
    if (!await store.delete(scope, req.params.projectId)) {
      reject(404, "Project not found");
    }
    res.status(204).send();
  }));

  router.delete("/:projectId/documents/:documentId", route(
    async (req, res, scope) => {
      const { projectId, documentId } = req.params;
      if (!await store.detachDocument(scope, projectId, documentId)) {
        reject(404, "Document not found");
      }
      res.status(204).send();
    },
  ));

  router.post("/:projectId/documents/:documentId", route(
    async (req, res, scope) => {
      const { projectId, documentId } = req.params;
      const result = await store.attachDocument(scope, projectId, documentId);
      res.status(result.created ? 201 : 200).json(result.document);
    },
  ));

  router.patch("/:projectId/documents/:documentId", route(
    async (req, res, scope) => {
      const { projectId, documentId } = req.params;
      res.json(await store.renameDocument(
        scope, projectId, documentId, bodyOf(req).filename,
      ));
    },
  ));

  router.post(
    "/:projectId/documents",
    singleFileUpload("file"),
    route(async (req, res, scope) => {
      const file = req.file ?? reject(400, "file is required");
      res.status(201).json(await documents.create(scope, {
        ...uploadedDocument(file),
        projectId: req.params.projectId,
      }));
    }),
  );

  router.get("/:projectId/chats", route(async (req, res, scope) => {
    res.json(await chats.list(scope, {
      projectId: req.params.projectId,
    }));
  }));

  router.post("/:projectId/folders", route(async (req, res, scope) => {
    const body = bodyOf(req);
    res.status(201).json(await store.createFolder(scope, req.params.projectId, {
      name: requiredText(body.name, "name", 200),
      parentFolderId: nullableId(body.parent_folder_id, "parent_folder_id"),
    }));
  }));

  router.patch("/:projectId/folders/:folderId", route(
    async (req, res, scope) => {
      const body = bodyOf(req);
      const update: Parameters<ProjectStore["updateFolder"]>[3] = {};
      if (Object.hasOwn(body, "name")) {
        update.name = requiredText(body.name, "name", 200);
      }
      if (Object.hasOwn(body, "parent_folder_id")) {
        update.parentFolderId = nullableId(
          body.parent_folder_id, "parent_folder_id",
        );
      }
      res.json(await store.updateFolder(
        scope, req.params.projectId, req.params.folderId, update,
      ));
    },
  ));

  router.delete("/:projectId/folders/:folderId", route(
    async (req, res, scope) => {
      await store.deleteFolder(scope, req.params.projectId, req.params.folderId);
      res.status(204).send();
    },
  ));

  router.patch("/:projectId/documents/:documentId/folder", route(
    async (req, res, scope) => {
      const { projectId, documentId } = req.params;
      res.json(await store.moveDocument(
        scope,
        projectId,
        documentId,
        nullableId(bodyOf(req).folder_id, "folder_id"),
      ));
    },
  ));

  return router;
}
