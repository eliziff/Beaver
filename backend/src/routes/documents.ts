import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import {
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_TYPES_LABEL,
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../lib/documentTypes";
import { imageValidationError } from "../lib/llm/images";

export const documentsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
type Req = import("express").Request;
type Res = import("express").Response;

const toArrayBuffer = (buf: Buffer) =>
  buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;

const suffixOf = (name: string) =>
  name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";

const trimmedName = <T>(raw: unknown, fallback: T): string | T =>
  typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : fallback;

const versionIdQuery = (req: Req) =>
  typeof req.query.version_id === "string" ? req.query.version_id : null;

const deleteFiles = (paths: (string | null | undefined)[]) =>
  Promise.all(
    paths
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => deleteFile(p).catch(() => {})),
  );

const activeName = (
  v: {
    filename?: string | null;
    version_number?: number | null;
    source?: string | null;
  } | null,
) =>
  downloadFilenameForVersion(
    v?.filename,
    v?.version_number ?? null,
    v?.source === "assistant_edit",
  );

/** Load a document row and enforce access; sends the 404 itself on failure. */
async function requireDoc(
  res: Res,
  db: Db,
  documentId: string,
  opts: { select?: string; owner?: boolean; detail?: string } = {},
): Promise<{
  id: string;
  user_id: string;
  project_id: string | null;
  current_version_id: string | null;
  isOwner: boolean;
} | null> {
  const detail = opts.detail ?? "Document not found";
  const { data } = await db
    .from("documents")
    .select(opts.select ?? "id, user_id, project_id")
    .eq("id", documentId)
    .single();
  const doc = data as unknown as {
    id: string;
    user_id: string;
    project_id: string | null;
    current_version_id: string | null;
  } | null;
  if (!doc) {
    res.status(404).json({ detail });
    return null;
  }
  const access = await ensureDocAccess(
    doc,
    res.locals.userId as string,
    res.locals.userEmail as string | undefined,
    db,
  );
  if (!access.ok || (opts.owner && !access.isOwner)) {
    res.status(404).json({ detail });
    return null;
  }
  return { ...doc, isOwner: access.isOwner };
}

/** Enforces the extension allowlist + image checks; sends the 400 itself. */
function validFileSuffix(
  res: Res,
  file: { originalname: string; buffer: Buffer },
): string | null {
  const suffix = suffixOf(file.originalname);
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
    res.status(400).json({
      detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
    });
    return null;
  }
  const imageError = imageValidationError(file.originalname, file.buffer);
  if (imageError) {
    res.status(400).json({ detail: imageError });
    return null;
  }
  return suffix;
}

/** Best-effort PDF rendition; source persistence never depends on it. */
async function pdfRenditionFor(
  suffix: string,
  key: string,
  buf: Buffer,
  pdfKey: string,
  tag: string,
): Promise<string | null> {
  if (suffix === "pdf") return key;
  if (!shouldConvertToPdf(suffix)) return null;
  try {
    const pdfBuf = await docxToPdf(buf);
    await uploadFile(pdfKey, toArrayBuffer(pdfBuf), "application/pdf");
    return pdfKey;
  } catch (err) {
    console.error(`[${tag}] Office→PDF conversion failed:`, err);
    return null;
  }
}

// Version numbers are sequential within a document; the counter spans
// upload + user_upload + assistant_edit sources.
async function nextVersionNumber(db: Db, documentId: string): Promise<number> {
  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .in("source", ["upload", "user_upload", "assistant_edit"])
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return ((maxRow?.version_number as number | null) ?? 1) + 1;
}

/** Insert a version row and point current_version_id at it; sends 500s itself. */
async function insertVersionAsCurrent(
  res: Res,
  db: Db,
  documentId: string,
  row: Record<string, unknown>,
  tag: string,
) {
  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({ document_id: documentId, source: "user_upload", ...row })
    .select("id, version_number, source, created_at, filename")
    .single();
  if (verErr || !versionRow) {
    console.error(`[${tag}] insert failed`, verErr);
    res.status(500).json({ detail: "Failed to record new version." });
    return null;
  }
  const { error: updateDocErr } = await db
    .from("documents")
    .update({ current_version_id: versionRow.id })
    .eq("id", documentId);
  if (updateDocErr) {
    console.error(`[${tag}] current version update failed`, updateDocErr);
    res
      .status(500)
      .json({ detail: "Failed to update document current version." });
    return null;
  }
  return versionRow;
}

async function deleteDocumentAndVersionFiles(db: Db, documentId: string) {
  // Delete every source and rendition before dropping its owning row.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await deleteFiles(
    (versions ?? []).flatMap((v) => [v.storage_path, v.pdf_storage_path]),
  );
  return db.from("documents").delete().eq("id", documentId);
}

documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .or("library_kind.eq.file,library_kind.is.null")
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db, {
      libraryKind: "file",
    });
  },
);

documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  await deleteDocumentAndVersionFiles(db, documentId);
  res.status(204).send();
});

documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const { documentId } = req.params;
  const db = createServerSupabase();
  if (!(await requireDoc(res, db, documentId))) return;

  const active = await loadActiveVersion(documentId, db, versionIdQuery(req));
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = active.file_type ?? "";
  const usePdf = shouldConvertToPdf(fileType) && !!active.pdf_storage_path;
  const raw = await downloadFile(
    usePdf ? active.pdf_storage_path! : active.storage_path,
  );
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  res.setHeader(
    "Content-Type",
    fileType === "pdf" || usePdf
      ? "application/pdf"
      : contentTypeForDocumentType(fileType),
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", activeName(active)),
  );
  res.send(Buffer.from(raw));
});

documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(activeName(active), Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const { documentId } = req.params;
  const db = createServerSupabase();
  if (!(await requireDoc(res, db, documentId))) return;

  const active = await loadActiveVersion(documentId, db, versionIdQuery(req));
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = activeName(active);
  const url = await getSignedUrl(active.storage_path, 3600, downloadFilename);
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// Proxy DOCX bytes to avoid browser CORS failures on signed storage URLs.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const { documentId } = req.params;
  const db = createServerSupabase();
  if (!(await requireDoc(res, db, documentId))) return;

  const active = await loadActiveVersion(documentId, db, versionIdQuery(req));
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", activeName(active)),
  );
  res.send(Buffer.from(raw));
});

function downloadFilenameForVersion(
  filename: string | null | undefined,
  versionNumber: number | null,
  edited = false,
): string {
  const resolved = filename?.trim() || "Untitled document.docx";
  if (!edited || !versionNumber || versionNumber < 1) return resolved;
  const dot = resolved.lastIndexOf(".");
  const stem = dot > 0 ? resolved.slice(0, dot) : resolved;
  const ext = dot > 0 ? resolved.slice(dot) : "";
  return `${stem} [Edited V${versionNumber}]${ext}`;
}

documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const { documentId } = req.params;
  const db = createServerSupabase();
  const doc = await requireDoc(res, db, documentId, {
    select: "id, current_version_id, user_id, project_id",
  });
  if (!doc) return;

  const { data: rows } = await db
    .from("document_versions")
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at, deleted_by",
    )
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// Copy server-side so signed storage URLs never enter the browser fetch path.
documentsRouter.post(
  "/:documentId/versions/from-document",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const { documentId } = req.params;
    const sourceDocumentId =
      typeof req.body?.source_document_id === "string"
        ? req.body.source_document_id
        : "";
    const db = createServerSupabase();

    if (!sourceDocumentId) {
      return void res
        .status(400)
        .json({ detail: "source_document_id is required" });
    }
    if (sourceDocumentId === documentId) {
      return void res
        .status(400)
        .json({ detail: "Source and target documents must be different." });
    }

    const targetDoc = await requireDoc(res, db, documentId);
    if (!targetDoc) return;
    const sourceDoc = await requireDoc(res, db, sourceDocumentId, {
      detail: "Source document not found",
    });
    if (!sourceDoc) return;

    const willDeleteSource =
      (sourceDoc.project_id &&
        targetDoc.project_id &&
        sourceDoc.project_id === targetDoc.project_id) ||
      (!sourceDoc.project_id &&
        !targetDoc.project_id &&
        sourceDoc.user_id === userId &&
        targetDoc.user_id === userId);
    if (willDeleteSource && !sourceDoc.isOwner) {
      return void res.status(403).json({
        detail: "Only the source document owner can move it into a version.",
      });
    }

    const active = await loadActiveVersion(sourceDocumentId, db);
    if (!active)
      return void res
        .status(404)
        .json({ detail: "Source document has no active version." });
    const sourceType = active.file_type ?? "";

    const bytes = await downloadFile(active.storage_path);
    if (!bytes)
      return void res
        .status(404)
        .json({ detail: "Source document bytes not available." });

    const filename = trimmedName(
      req.body?.filename,
      active.filename?.trim() || "Untitled document",
    );
    const suffix = sourceType || suffixOf(filename);
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, filename);

    try {
      await uploadFile(key, bytes, contentTypeForDocumentType(suffix));
    } catch (e) {
      console.error("[versions/copy] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to create new version." });
    }

    const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
    let pdfStoragePath: string | null = null;
    if (suffix === "pdf") {
      pdfStoragePath = key;
    } else if (active.pdf_storage_path) {
      if (active.pdf_storage_path === active.storage_path) {
        pdfStoragePath = key;
      } else {
        const pdfBytes = await downloadFile(active.pdf_storage_path);
        if (pdfBytes) {
          await uploadFile(pdfKey, pdfBytes, "application/pdf");
          pdfStoragePath = pdfKey;
        }
      }
    } else {
      pdfStoragePath = await pdfRenditionFor(
        suffix,
        key,
        Buffer.from(bytes),
        pdfKey,
        "versions/copy",
      );
    }

    const versionRow = await insertVersionAsCurrent(
      res,
      db,
      documentId,
      {
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        version_number: await nextVersionNumber(db, documentId),
        filename,
        file_type: sourceType || null,
        size_bytes: active.size_bytes ?? bytes.byteLength,
        page_count: active.page_count,
      },
      "versions/copy",
    );
    if (!versionRow) return;

    if (willDeleteSource) {
      const { error: deleteErr } = await deleteDocumentAndVersionFiles(
        db,
        sourceDocumentId,
      );
      if (deleteErr) {
        console.error(
          "[versions/copy] source document delete failed",
          deleteErr,
        );
        return void res
          .status(500)
          .json({ detail: "Failed to delete source document." });
      }
    }

    res.status(201).json(versionRow);
  },
);

documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const doc = await requireDoc(res, db, documentId, {
      select: "id, user_id, project_id, current_version_id",
    });
    if (!doc) return;

    const suffix = validFileSuffix(res, file);
    if (suffix === null) return;

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    try {
      await uploadFile(
        key,
        toArrayBuffer(file.buffer),
        contentTypeForDocumentType(suffix),
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // Preview conversion is best effort; source-version persistence is not.
    const pdfStoragePath = await pdfRenditionFor(
      suffix,
      key,
      file.buffer,
      `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
      "versions/upload",
    );
    const pageCount =
      suffix === "pdf" ? await countPdfPages(toArrayBuffer(file.buffer)) : null;

    const versionRow = await insertVersionAsCurrent(
      res,
      db,
      documentId,
      {
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        version_number: await nextVersionNumber(db, documentId),
        filename: trimmedName(req.body?.filename, file.originalname),
        file_type: suffix,
        size_bytes: file.buffer.byteLength,
        page_count: pageCount,
      },
      "versions/upload",
    );
    if (versionRow) res.status(201).json(versionRow);
  },
);

documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();
    if (!(await requireDoc(res, db, documentId))) return;

    const filename = trimmedName(req.body?.filename, null);

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ filename })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null)
      .select(
        "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
      )
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// Replaces bytes in place; owner-only.
documentsRouter.put(
  "/:documentId/versions/:versionId/file",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    if (!(await requireDoc(res, db, documentId, { owner: true }))) return;

    const { data: target, error: targetErr } = await db
      .from("document_versions")
      .select("id, storage_path, pdf_storage_path, file_type, deleted_at")
      .eq("id", versionId)
      .eq("document_id", documentId)
      .single();
    if (targetErr || !target)
      return void res.status(404).json({ detail: "Version not found" });
    if (target.deleted_at)
      return void res.status(400).json({ detail: "Version is deleted." });

    const suffix = validFileSuffix(res, file);
    if (suffix === null) return;
    if (target.file_type && target.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match version type (${target.file_type}).`,
      });
    }

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );

    try {
      await uploadFile(
        key,
        toArrayBuffer(file.buffer),
        contentTypeForDocumentType(suffix),
      );
    } catch (e) {
      console.error("[versions/replace] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload replacement version." });
    }

    const pdfStoragePath = await pdfRenditionFor(
      suffix,
      key,
      file.buffer,
      `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
      "versions/replace",
    );
    const pageCount =
      suffix === "pdf" ? await countPdfPages(toArrayBuffer(file.buffer)) : null;

    const { data: updated, error: updateErr } = await db
      .from("document_versions")
      .update({
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        filename: trimmedName(req.body?.filename, file.originalname),
        file_type: suffix,
        size_bytes: file.buffer.byteLength,
        page_count: pageCount,
        created_at: new Date().toISOString(),
      })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select(
        "id, version_number, source, created_at, filename, file_type, size_bytes, page_count",
      )
      .single();
    if (updateErr || !updated) {
      await deleteFiles([key, pdfStoragePath]);
      return void res.status(500).json({
        detail: updateErr?.message ?? "Failed to replace version.",
      });
    }

    await deleteFiles([target.storage_path, target.pdf_storage_path]);

    res.json(updated);
  },
);

// Delete one version. The last remaining version cannot be deleted; if the
// deleted version is current, the newest remaining version becomes current.
documentsRouter.delete(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const doc = await requireDoc(res, db, documentId, {
      select: "id, user_id, project_id, current_version_id",
      owner: true,
    });
    if (!doc) return;

    const { data: versions, error: versionsErr } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, version_number, created_at, deleted_at",
      )
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (versionsErr) {
      return void res.status(500).json({ detail: versionsErr.message });
    }

    const rows = (versions ?? []) as {
      id: string;
      storage_path: string | null;
      pdf_storage_path: string | null;
      version_number: number | null;
      created_at: string | null;
      deleted_at?: string | null;
    }[];
    const target = rows.find((row) => row.id === versionId);
    if (!target)
      return void res.status(404).json({ detail: "Version not found" });
    if (rows.length <= 1) {
      return void res
        .status(400)
        .json({ detail: "Cannot delete the only document version." });
    }

    const remaining = rows
      .filter((row) => row.id !== versionId)
      .sort((a, b) => {
        const versionDelta =
          (b.version_number ?? -1) - (a.version_number ?? -1);
        if (versionDelta !== 0) return versionDelta;
        return (
          new Date(b.created_at ?? 0).getTime() -
          new Date(a.created_at ?? 0).getTime()
        );
      });
    const nextCurrentVersionId =
      doc.current_version_id === versionId
        ? (remaining[0]?.id ?? null)
        : doc.current_version_id;
    const deletedAt = new Date().toISOString();

    if (doc.current_version_id === versionId) {
      const { error: updateErr } = await db
        .from("documents")
        .update({
          current_version_id: nextCurrentVersionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (updateErr) {
        return void res.status(500).json({ detail: updateErr.message });
      }
    }

    const { error: deleteErr } = await db
      .from("document_versions")
      .update({
        storage_path: null,
        pdf_storage_path: null,
        deleted_at: deletedAt,
        deleted_by: userId,
      })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (deleteErr) {
      return void res.status(500).json({ detail: deleteErr.message });
    }

    await deleteFiles([target.storage_path, target.pdf_storage_path]);

    res.json({
      deleted_version_id: versionId,
      current_version_id: nextCurrentVersionId,
      deleted_at: deletedAt,
    });
  },
);

// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const { documentId } = req.params;
    const db = createServerSupabase();
    if (!(await requireDoc(res, db, documentId))) return;

    const active = await loadActiveVersion(documentId, db, versionIdQuery(req));
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

async function handleEditResolution(
  req: Req,
  res: Res,
  mode: "accept" | "reject",
) {
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  const { data: edit } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  if (!edit) return void res.status(404).json({ detail: "Edit not found" });

  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    const resolvedDoc = await requireDoc(res, db, documentId, {
      select: "current_version_id, user_id, project_id",
    });
    if (!resolvedDoc) return;
    const activeForResolved = await loadActiveVersion(documentId, db);
    return void res.status(200).json({
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: resolvedDoc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            activeName(activeForResolved),
          )
        : null,
      remaining_pending: 0,
    });
  }

  const doc = await requireDoc(res, db, documentId, {
    select: "id, current_version_id, user_id, project_id",
  });
  if (!doc) return;

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  const status = mode === "accept" ? "accepted" : "rejected";
  if (!found) {
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    await db
      .from("document_edits")
      .update({ status, resolved_at: new Date().toISOString() })
      .eq("id", editId);
    return void res.status(200).json({
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(latestPath, activeName(active)),
      remaining_pending: 0,
    });
  }

  // Accept/reject mutates the assistant-edit version instead of creating one
  // version per decision.
  await uploadFile(
    latestPath,
    toArrayBuffer(resolvedBytes),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  await db
    .from("document_edits")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", editId);

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");

  res.json({
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(latestPath, activeName(active)),
    remaining_pending: remainingPending ?? 0,
  });
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

export async function handleDocumentUpload(
  req: Req,
  res: Res,
  userId: string,
  projectId: string | null,
  db: Db,
  options: {
    libraryKind?: "file" | "template";
    libraryFolderId?: string | null;
  } = {},
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = validFileSuffix(res, file);
  if (suffix === null) return;

  const content = file.buffer;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      status: "processing",
      library_kind: options.libraryKind ?? "file",
      library_folder_id: options.libraryFolderId ?? null,
    })
    .select("*")
    .single();

  if (insertErr || !doc) {
    console.error("[single-documents/upload] failed to create document row", {
      userId,
      projectId,
      filename,
      suffix,
      error: insertErr,
    });
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });
  }

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    await uploadFile(
      key,
      toArrayBuffer(content),
      contentTypeForDocumentType(suffix),
    );

    const pageCount =
      suffix === "pdf" ? await countPdfPages(toArrayBuffer(content)) : null;
    const pdfStoragePath = await pdfRenditionFor(
      suffix,
      key,
      content,
      convertedPdfKey(userId, docId),
      "upload",
    );

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        filename: filename,
        file_type: suffix,
        size_bytes: content.byteLength,
        page_count: pageCount,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    const responseDoc = updated
      ? {
          ...updated,
          filename,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
          folder_id:
            (updated.library_folder_id as string | null | undefined) ?? null,
          file_type: suffix,
          size_bytes: content.byteLength,
          page_count: pageCount,
          active_version_number: 1,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({
      // Untrusted uploads: never let pdf.js compile font programs via eval.
      data: new Uint8Array(buf),
      isEvalSupported: false,
    }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}
