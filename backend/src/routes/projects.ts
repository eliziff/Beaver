import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
  attachActiveVersionPaths,
} from "../lib/documentVersions";
import {
  deleteFile,
  downloadFile,
  uploadFile,
  storageKey,
} from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { deleteUserProjects } from "../lib/userDataCleanup";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { imageValidationError } from "../lib/llm/images";
import {
  createLocalDocument,
  deleteLocalDocument,
  listLocalDocumentsById,
  renameLocalDocument,
  type LocalLibraryKind,
} from "../lib/localDocumentStore";
import {
  legalKnowledgeGraphStore,
  type LocalMatter,
} from "../lib/legalKnowledgeGraphStore";
import {
  deleteAnonymousProjectChats,
  listAnonymousProjectChats,
} from "../lib/anonymousChatStore";
import {
  findMissingUserEmails,
  loadProfileUsersByEmail,
} from "../lib/userLookup";
import { localTabularStore } from "../lib/localTabularStore";
import { handleDocumentUpload } from "./documents";

export const projectsRouter = Router();

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

async function localMatterDocuments(userId: string, projectId: string) {
  const documentIds =
    legalKnowledgeGraphStore().listMatterDocumentIds(userId, projectId) ?? [];
  return (await listLocalDocumentsById(userId, documentIds)).map((document) => ({
    ...document,
    project_id: projectId,
    folder_id: null,
  }));
}

async function localMatterResponse(
  userId: string,
  matter: LocalMatter,
  includeDocuments = false,
) {
  const documents = await localMatterDocuments(userId, matter.id);
  return {
    id: matter.id,
    user_id: userId,
    is_owner: true,
    owner_display_name: null,
    owner_email: null,
    name: matter.name,
    cm_number: matter.cm_number,
    practice: matter.practice,
    shared_with: [],
    created_at: matter.created_at,
    updated_at: matter.updated_at,
    document_count: documents.length,
    chat_count: listAnonymousProjectChats(userId, matter.id).length,
    review_count: localTabularStore().list(userId, matter.id).length,
    ...(includeDocuments ? { documents, folders: [] } : {}),
  };
}

async function deleteProjectDocumentsAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  documentIds: string[],
) {
  if (documentIds.length === 0) return null;
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", documentIds);
  if (versionsError) return versionsError;

  const paths = new Set<string>();
  for (const v of versions ?? []) {
    if (typeof v.storage_path === "string" && v.storage_path.length > 0) {
      paths.add(v.storage_path);
    }
    if (typeof v.pdf_storage_path === "string" && v.pdf_storage_path.length > 0) {
      paths.add(v.pdf_storage_path);
    }
  }
  await Promise.all([...paths].map((p) => deleteFile(p).catch(() => {})));

  const { error } = await db
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);
  return error ?? null;
}

async function attachDocumentOwnerLabels(
  db: ReturnType<typeof createServerSupabase>,
  docs: { user_id?: string | null }[],
) {
  const ownerIds = docs
    .map((doc) => doc.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (ownerIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", ownerIds);
  if (profilesError) {
    console.warn("[projects] failed to load document owner profiles", profilesError);
  }
  for (const profile of profiles ?? []) {
    const displayName =
      typeof profile.display_name === "string"
        ? profile.display_name.trim()
        : "";
    if (displayName) {
      displayNameByUserId.set(profile.user_id as string, displayName);
    }
  }

  for (const doc of docs as ({
    user_id?: string | null;
    owner_email?: string | null;
    owner_display_name?: string | null;
  })[]) {
    if (!doc.user_id) continue;
    doc.owner_email = null;
    doc.owner_display_name = displayNameByUserId.get(doc.user_id) ?? null;
  }
}

async function attachChatCreatorLabels(
  db: ReturnType<typeof createServerSupabase>,
  chats: { user_id?: string | null }[],
) {
  const creatorIds = chats
    .map((chat) => chat.user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (creatorIds.length === 0) return;

  const displayNameByUserId = new Map<string, string>();
  const { data: profiles, error: profilesError } = await db
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", creatorIds);
  if (profilesError) {
    console.warn("[projects] failed to load chat creator profiles", profilesError);
  }
  for (const profile of profiles ?? []) {
    const displayName =
      typeof profile.display_name === "string"
        ? profile.display_name.trim()
        : "";
    if (displayName) {
      displayNameByUserId.set(profile.user_id as string, displayName);
    }
  }

  for (const chat of chats as ({
    user_id?: string | null;
    creator_display_name?: string | null;
  })[]) {
    if (!chat.user_id) continue;
    chat.creator_display_name = displayNameByUserId.get(chat.user_id) ?? null;
  }
}

projectsRouter.get("/", requireAuth, async (req, res) => {
  if (isAnonymousLocalMode()) {
    const userId = res.locals.userId as string;
    const includeDocuments = req.query.include === "documents";
    res.json(
      await Promise.all(
        legalKnowledgeGraphStore()
          .listMatters(userId)
          .map((matter) =>
            localMatterResponse(userId, matter, includeDocuments),
          ),
      ),
    );
    return;
  }
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const includeDocuments = req.query.include === "documents";
    const db = createServerSupabase();

    const { data, error } = await db.rpc("get_projects_overview", {
      p_user_id: userId,
      p_user_email: userEmail ?? null,
    });
    if (error) return void res.status(500).json({ detail: error.message });

    const projects = (data ?? []) as { id: string }[];
    if (!includeDocuments || projects.length === 0) {
      return void res.json(projects);
    }

    const { data: docs, error: docsError } = await db
      .from("documents")
      .select("*")
      .in(
        "project_id",
        projects.map((p) => p.id),
      )
      .order("created_at", { ascending: true });
    if (docsError)
      return void res.status(500).json({ detail: docsError.message });

    const docsTyped = (docs ?? []) as unknown as {
      id: string;
      project_id?: string | null;
      user_id?: string | null;
      current_version_id?: string | null;
    }[];
    await attachActiveVersionPaths(db, docsTyped);
    await attachDocumentOwnerLabels(db, docsTyped);

    const docsByProject = new Map<string, typeof docsTyped>();
    for (const doc of docsTyped) {
      if (!doc.project_id) continue;
      const bucket = docsByProject.get(doc.project_id);
      if (bucket) bucket.push(doc);
      else docsByProject.set(doc.project_id, [doc]);
    }
    res.json(
      projects.map((p) => ({
        ...p,
        documents: docsByProject.get(p.id) ?? [],
      })),
    );
  } catch (error) {
    console.error("[projects] failed to load projects", error);
    res.status(500).json({ detail: "Failed to load projects" });
  }
});

projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const { name, cm_number, practice, shared_with } = body;
  if (isAnonymousLocalMode()) {
    if (typeof name !== "string" || !name.trim()) {
      return void res.status(400).json({ detail: "name is required" });
    }
    if (
      (cm_number != null && typeof cm_number !== "string") ||
      (practice != null && typeof practice !== "string")
    ) {
      return void res
        .status(400)
        .json({ detail: "Project fields must be text" });
    }
    try {
      const matter = legalKnowledgeGraphStore().createMatter(userId, {
        name,
        cmNumber: cm_number,
        practice,
      });
      res.status(201).json({
        ...(await localMatterResponse(userId, matter, true)),
        documents: [],
      });
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Invalid project",
      });
    }
    return;
  }
  if (typeof name !== "string" || !name.trim())
    return void res.status(400).json({ detail: "name is required" });
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const cleanedSharedWith: string[] = [];
  const seenSharedEmails = new Set<string>();
  if (Array.isArray(shared_with)) {
    for (const raw of shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seenSharedEmails.has(e)) continue;
      if (normalizedUserEmail && e === normalizedUserEmail) {
        return void res
          .status(400)
          .json({ detail: "You cannot share a project with yourself." });
      }
      seenSharedEmails.add(e);
      cleanedSharedWith.push(e);
    }
  }

  const db = createServerSupabase();
  const missingSharedUsers = await findMissingUserEmails(db, cleanedSharedWith);
  if (missingSharedUsers.length > 0) {
    return void res.status(400).json({
      detail: `${missingSharedUsers[0]} does not belong to a Beaver user.`,
    });
  }

  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: normalizeOptionalString(cm_number),
      practice: normalizeOptionalString(practice),
      shared_with: cleanedSharedWith,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json({ ...data, documents: [] });
});

projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    const matter = legalKnowledgeGraphStore().getMatter(userId, projectId);
    if (!matter)
      return void res.status(404).json({ detail: "Project not found" });
    res.json(await localMatterResponse(userId, matter, true));
    return;
  }
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    res.json({
      owner: {
        user_id: userId,
        email: null,
        display_name: null,
      },
      members: [],
    });
    return;
  }
  const db = createServerSupabase();

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Use the mirrored profile email so sharing checks do not scan auth.users.
  const { userByEmail, userById } = await loadProfileUsersByEmail(db);

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name: ownerInfo?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u?.display_name ?? null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    try {
      const matter = legalKnowledgeGraphStore().updateMatter(
        userId,
        projectId,
        {
          name: req.body.name,
          cmNumber: req.body.cm_number,
          practice: Object.hasOwn(req.body ?? {}, "practice")
            ? req.body.practice
            : undefined,
        },
      );
      if (!matter)
        return void res.status(404).json({ detail: "Project not found" });
      res.json(await localMatterResponse(userId, matter, true));
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Invalid project",
      });
    }
    return;
  }
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if ("practice" in req.body) {
    updates.practice = normalizeOptionalString(req.body.practice);
  }
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const normalizedUserEmail = userEmail?.trim().toLowerCase();
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      if (normalizedUserEmail && e === normalizedUserEmail) {
        return void res
          .status(400)
          .json({ detail: "You cannot share a project with yourself." });
      }
      seen.add(e);
      cleaned.push(e);
    }
    updates.shared_with = cleaned;
  }

  const db = createServerSupabase();
  if (Array.isArray(updates.shared_with)) {
    const missingSharedUsers = await findMissingUserEmails(
      db,
      updates.shared_with as string[],
    );
    if (missingSharedUsers.length > 0) {
      return void res.status(400).json({
        detail: `${missingSharedUsers[0]} does not belong to a Beaver user.`,
      });
    }
  }

  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    user_id?: string | null;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  await attachDocumentOwnerLabels(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    try {
      if (!legalKnowledgeGraphStore().deleteProject(userId, projectId)) {
        return void res.status(404).json({ detail: "Project not found" });
      }
      localTabularStore().deleteProjectReviews(userId, projectId);
      deleteAnonymousProjectChats(userId, projectId);
      res.status(204).send();
    } catch (error) {
      res.status(400).json({
        detail: error instanceof Error ? error.message : "Invalid project",
      });
    }
    return;
  }
  const db = createServerSupabase();
  try {
    const deletedCount = await deleteUserProjects(db, userId, [projectId]);
    if (deletedCount === 0)
      return void res.status(404).json({ detail: "Project not found" });
    res.status(204).send();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail });
  }
});

projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    res.json(await localMatterDocuments(userId, projectId));
    return;
  }
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// document from one matter without deleting the canonical file.
projectsRouter.delete(
  "/:projectId/documents/:documentId",
  requireAuth,
  (req, res) => {
    if (!isAnonymousLocalMode()) {
      return void res.status(404).json({ detail: "Not found" });
    }
    const userId = res.locals.userId as string;
    const { projectId, documentId } = req.params;
    const store = legalKnowledgeGraphStore();
    if (!store.getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    if (!store.removeMatterDocument(userId, projectId, documentId)) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    res.status(204).send();
  },
);

projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    if (isAnonymousLocalMode()) {
      const store = legalKnowledgeGraphStore();
      if (!store.getMatter(userId, projectId)) {
        return void res.status(404).json({ detail: "Project not found" });
      }
      const [document] = await listLocalDocumentsById(userId, [documentId]);
      if (!document) {
        return void res.status(404).json({ detail: "Document not found" });
      }
      if (!store.attachMatterDocument(userId, projectId, documentId)) {
        return void res.status(404).json({ detail: "Project not found" });
      }
      res.json({
        ...document,
        project_id: projectId,
        folder_id: null,
      });
      return;
    }
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    await attachActiveVersionPaths(
      db,
      [doc as { id: string; current_version_id?: string | null }],
    );

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const { data: updated, error } = await db
        .from("documents")
        .update({
          project_id: projectId,
          library_folder_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      await attachActiveVersionPaths(
        db,
        [updated as { id: string; current_version_id?: string | null }],
      );
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      if (!doc.current_version_id) {
        return void res
          .status(404)
          .json({ detail: "Source document has no active version" });
      }

      const { data: srcV } = await db
        .from("document_versions")
        .select(
          "storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count",
        )
        .eq("id", doc.current_version_id)
        .single();
      if (!srcV?.storage_path) {
        return void res
          .status(404)
          .json({ detail: "Source document has no active version" });
      }

      const activeVersionFilename =
        (srcV.filename as string | null)?.trim() || "Untitled document";
      const srcBytes = await downloadFile(srcV.storage_path);
      if (!srcBytes) {
        return void res
          .status(500)
          .json({ detail: "Failed to read source document bytes" });
      }

      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      const newKey = storageKey(
        userId,
        copy.id as string,
        activeVersionFilename,
      );
      let newPdfPath: string | null = null;
      try {
        const contentType = contentTypeForDocumentType(
          (srcV.file_type as string | null) ?? doc.file_type,
        );
        await uploadFile(newKey, srcBytes, contentType);

        // PDFs share one object for source + display rendition. DOCX
        // store the converted PDF at a separate `converted-pdfs/` key —
        // copy that too if it exists so the copy renders without going
        // back through libreoffice.
        if (srcV.pdf_storage_path) {
          if (srcV.pdf_storage_path === srcV.storage_path) {
            newPdfPath = newKey;
          } else {
            const pdfBytes = await downloadFile(srcV.pdf_storage_path);
            if (pdfBytes) {
              const newPdfKey = convertedPdfKey(userId, copy.id as string);
              await uploadFile(newPdfKey, pdfBytes, "application/pdf");
              newPdfPath = newPdfKey;
            }
          }
        }

        const { data: newV, error: newVError } = await db
          .from("document_versions")
          .insert({
            document_id: copy.id,
            storage_path: newKey,
            pdf_storage_path: newPdfPath,
            source: (srcV.source as string | null) ?? "upload",
            version_number: srcV.version_number ?? 1,
            filename: activeVersionFilename,
            file_type: (srcV.file_type as string | null) ?? doc.file_type,
            size_bytes:
              (srcV.size_bytes as number | null) ?? doc.size_bytes ?? null,
            page_count:
              (srcV.page_count as number | null) ?? doc.page_count ?? null,
          })
          .select("id")
          .single();
        const copyVersionRowId = (newV?.id as string | null) ?? null;
        if (newVError || !copyVersionRowId) {
          throw new Error(
            `Failed to create copied document version: ${newVError?.message ?? "unknown"}`,
          );
        }

        const { data: updatedCopy, error: updateCopyError } = await db
          .from("documents")
          .update({
            current_version_id: copyVersionRowId,
          })
          .eq("id", copy.id)
          .select("*")
          .single();
        if (updateCopyError || !updatedCopy) {
          throw new Error(
            `Failed to activate copied document version: ${updateCopyError?.message ?? "unknown"}`,
          );
        }

        await attachActiveVersionPaths(
          db,
          [updatedCopy as { id: string; current_version_id?: string | null }],
        );
        return void res.status(201).json(updatedCopy);
      } catch (err) {
        console.error("[projects/documents/copy] failed", err);
        await Promise.all([
          deleteFile(newKey).catch(() => {}),
          newPdfPath && newPdfPath !== newKey
            ? deleteFile(newPdfPath).catch(() => {})
            : Promise.resolve(),
          db.from("documents").delete().eq("id", copy.id),
        ]);
        return void res.status(500).json({ detail: "Failed to copy document" });
      }
    }
  },
);

projectsRouter.patch("/:projectId/documents/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  if (isAnonymousLocalMode()) {
    const store = legalKnowledgeGraphStore();
    if (!store.getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    if (!(store.listMatterDocumentIds(userId, projectId) ?? []).includes(documentId)) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const [current] = await listLocalDocumentsById(userId, [documentId]);
    if (!current)
      return void res.status(404).json({ detail: "Document not found" });
    const filename = normalizeDocumentFilename(
      req.body?.filename,
      current.filename,
    );
    if (!filename)
      return void res.status(400).json({ detail: "filename is required" });
    const updated = await renameLocalDocument(
      userId,
      current.library_kind as LocalLibraryKind,
      documentId,
      filename,
    );
    if (!updated)
      return void res.status(404).json({ detail: "Document not found" });
    res.json({ ...updated, project_id: projectId, folder_id: null });
    return;
  }
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });

  const active = doc.current_version_id
    ? await db
        .from("document_versions")
        .select("filename")
        .eq("id", doc.current_version_id)
        .eq("document_id", documentId)
        .single()
    : null;
  const currentName =
    typeof active?.data?.filename === "string" &&
    active.data.filename.trim()
      ? active.data.filename.trim()
      : "Untitled document";
  const filename = normalizeDocumentFilename(req.body?.filename, currentName);
  if (!filename)
    return void res.status(400).json({ detail: "filename is required" });

  const { data: updated, error } = await db
    .from("documents")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("project_id", projectId)
    .select("*")
    .single();
  if (error || !updated)
    return void res.status(404).json({ detail: "Document not found" });

  if (doc.current_version_id) {
    await db
      .from("document_versions")
      .update({ filename })
      .eq("id", doc.current_version_id)
      .eq("document_id", documentId);
  }

  res.json({
    ...updated,
    filename,
  });
});

projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    if (isAnonymousLocalMode()) {
      const store = legalKnowledgeGraphStore();
      if (!store.getMatter(userId, projectId)) {
        return void res.status(404).json({ detail: "Project not found" });
      }
      if (!req.file)
        return void res.status(400).json({ detail: "file is required" });
      const imageError = imageValidationError(
        req.file.originalname,
        req.file.buffer,
      );
      if (imageError)
        return void res.status(400).json({ detail: imageError });
      try {
        const document = await createLocalDocument({
          userId,
          kind: "file",
          filename: req.file.originalname,
          bytes: req.file.buffer,
        });
        if (!store.attachMatterDocument(userId, projectId, document.id)) {
          await deleteLocalDocument(userId, document.id);
          return void res.status(404).json({ detail: "Project not found" });
        }
        res.status(201).json({
          ...document,
          project_id: projectId,
          folder_id: null,
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Upload failed";
        res
          .status(detail.startsWith("Unsupported file type") ? 400 : 500)
          .json({ detail });
      }
      return;
    }
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    res.json(
      listAnonymousProjectChats(userId, projectId).map(
        ({ messages: _messages, ...chat }) => ({
          ...chat,
          creator_display_name: null,
        }),
      ),
    );
    return;
  }
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const chats = data ?? [];
  await attachChatCreatorLabels(db, chats);
  res.json(chats);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    return void res.status(409).json({
      detail: "Folders are not available in account-free matters yet.",
    });
  }
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    return void res.status(404).json({ detail: "Folder not found" });
  }
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      const parent = await loadProjectFolder(db, projectId, body.parent_folder_id);
      if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });

      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const p = await loadProjectFolder(db, projectId, cur);
        if (!p) return void res.status(404).json({ detail: "Parent folder not found" });
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    return void res.status(404).json({ detail: "Folder not found" });
  }
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const { data: allFolders, error: foldersError } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("project_id", projectId);
  if (foldersError)
    return void res.status(500).json({ detail: foldersError.message });
  if (!(allFolders ?? []).some((f) => f.id === folderId))
    return void res.status(404).json({ detail: "Folder not found" });

  const childrenByParent = new Map<string, string[]>();
  for (const f of allFolders ?? []) {
    const parentId = f.parent_folder_id as string | null;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(f.id as string);
    childrenByParent.set(parentId, children);
  }

  const folderIds = new Set<string>();
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (folderIds.has(id)) continue;
    folderIds.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }

  const { data: docs, error: docsError } = await db
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .in("folder_id", [...folderIds]);
  if (docsError) return void res.status(500).json({ detail: docsError.message });

  const docIds = (docs ?? []).map((d) => d.id as string);
  const deleteDocsError = await deleteProjectDocumentsAndVersionFiles(
    db,
    projectId,
    docIds,
  );
  if (deleteDocsError)
    return void res.status(500).json({ detail: deleteDocsError.message });

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };
  if (isAnonymousLocalMode()) {
    if (!legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    if (folder_id) {
      return void res.status(409).json({
        detail: "Folders are not available in account-free matters yet.",
      });
    }
    const [document] = await listLocalDocumentsById(userId, [documentId]);
    const belongsToMatter = (
      legalKnowledgeGraphStore().listMatterDocumentIds(userId, projectId) ?? []
    ).includes(documentId);
    if (!document || !belongsToMatter) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    res.json({ ...document, project_id: projectId, folder_id: null });
    return;
  }

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  if (folder_id) {
    const folder = await loadProjectFolder(db, projectId, folder_id);
    if (!folder) return void res.status(404).json({ detail: "Folder not found" });
  }

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

async function loadProjectFolder(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  folderId: string,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("project_id", projectId)
    .maybeSingle();
  return (data as { id: string; parent_folder_id: string | null } | null) ?? null;
}
