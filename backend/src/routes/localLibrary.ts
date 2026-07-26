import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
  createLocalDocument,
  createLocalFolder,
  deleteLocalFolder,
  listLocalLibrary,
  moveLocalDocument,
  renameLocalDocument,
  updateLocalFolder,
  type LocalLibraryKind,
} from "../lib/localDocumentStore";
import { singleFileUpload } from "../lib/upload";

export const localLibraryRouter = Router();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function libraryKind(value: unknown): LocalLibraryKind | null {
  if (value === "file" || value === "files") return "file";
  if (value === "template" || value === "templates") return "template";
  return null;
}

function renamedFilename(value: unknown, current: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim().slice(0, 200);
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  return `${trimmed}${current.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? ""}`;
}

localLibraryRouter.use((_req, _res, next) => {
  if (!isAnonymousLocalMode()) return next("router");
  next();
});

localLibraryRouter.get(
  "/:kind",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    res.json(await listLocalLibrary(res.locals.userId as string, kind));
  }),
);

localLibraryRouter.post(
  "/:kind/documents",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    if (!req.file) return void res.status(400).json({ detail: "file is required" });
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
      res.status(detail.startsWith("Unsupported file type") ? 400 : 500).json({ detail });
    }
  }),
);

localLibraryRouter.post(
  "/:kind/folders",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
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
    if (!folder) return void res.status(404).json({ detail: "Parent folder not found" });
    res.status(201).json(folder);
  }),
);

localLibraryRouter.patch(
  "/:kind/folders/:folderId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    const name =
      typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : undefined;
    const hasParent = Object.prototype.hasOwnProperty.call(req.body ?? {}, "parent_folder_id");
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
    if (!folder) return void res.status(404).json({ detail: "Folder not found" });
    res.json(folder);
  }),
);

localLibraryRouter.delete(
  "/:kind/folders/:folderId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    const deleted = await deleteLocalFolder(
      res.locals.userId as string,
      kind,
      req.params.folderId,
    );
    if (!deleted) return void res.status(404).json({ detail: "Folder not found" });
    res.status(204).send();
  }),
);

localLibraryRouter.patch(
  "/:kind/documents/:documentId/folder",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    const folderId =
      typeof req.body?.folder_id === "string" ? req.body.folder_id : null;
    const document = await moveLocalDocument(
      res.locals.userId as string,
      kind,
      req.params.documentId,
      folderId,
    );
    if (!document) return void res.status(404).json({ detail: "Document not found" });
    res.json(document);
  }),
);

localLibraryRouter.patch(
  "/:kind/documents/:documentId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const kind = libraryKind(req.params.kind);
    if (!kind) return void res.status(404).json({ detail: "Library not found" });
    const collection = await listLocalLibrary(res.locals.userId as string, kind);
    const current = collection.documents.find((item) => item.id === req.params.documentId);
    if (!current) return void res.status(404).json({ detail: "Document not found" });
    const filename = renamedFilename(req.body?.filename, current.filename);
    if (!filename) return void res.status(400).json({ detail: "filename is required" });
    const document = await renameLocalDocument(
      res.locals.userId as string,
      kind,
      req.params.documentId,
      filename,
    );
    if (!document) return void res.status(404).json({ detail: "Document not found" });
    res.json(document);
  }),
);
