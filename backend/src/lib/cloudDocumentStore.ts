import { recordAudit } from "./audit";
import { cloudData, cloudScope, type CloudScope } from "./access";
import { docxToPdf } from "./convert";
import { buildDownloadUrl } from "./downloadTokens";
import { loadActiveVersion, type ActiveVersion } from "./documentVersions";
import { contentTypeForDocumentType, shouldConvertToPdf } from "./documentTypes";
import type {
  DocumentContent, DocumentProvenance, DocumentScope, DocumentStore, DocumentVersion,
} from "./documentStore";
import { DocumentStoreError } from "./documentStore";
import { extractTrackedChangeIds, resolveTrackedChange } from "./docxTrackedChanges";
import { countLegalPdfPages } from "./legalPdfSourceDoc";
import {
  deleteFile, downloadFile, getSignedUrl, storageKey, uploadFile, versionStorageKey,
} from "./storage";
type Db = CloudScope["db"];

const arrayBuffer = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset,
  buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation: string) =>
  cloudData<T>(operation, query);

async function createCloudDocument(scope: CloudScope, input: {
  projectId: string | null; libraryKind?: "file" | "template";
  libraryFolderId?: string | null;
  file: { originalname: string; buffer: Buffer };
  fileType: string; provenance?: DocumentProvenance;
}) {
  const { db, userId, userEmail } = scope;
  const { projectId, file, fileType } = input;
  const { data: document, error: insertError } = await db
    .from("documents")
    .insert({ project_id: projectId, user_id: userId, status: "processing",
      library_kind: input.libraryKind ?? "file",
      library_folder_id: input.libraryFolderId ?? null }).select("*").single();
  if (insertError || !document) {
    console.error("[document/upload] failed to create document row", { userId,
      projectId, fileType, code: insertError?.code ?? "unknown" });
    throw new Error("Failed to create document record");
  }

  const documentId = document.id as string;
  const surface = projectId ? "project" : input.libraryKind ? "library" : "assistant";
  const generated = input.provenance?.actor === "assistant" &&
    input.provenance.action === "created";
  try {
    const key = storageKey(userId, documentId, file.originalname);
    await uploadFile(key, arrayBuffer(file.buffer),
      contentTypeForDocumentType(fileType));
    const pageCount = fileType === "pdf"
      ? await countLegalPdfPages(file.buffer).catch(() => null)
      : null;
    const pdfStoragePath = fileType === "pdf" ? key : null;
    const { data: version, error: versionError } = await db
      .from("document_versions")
      .insert({ document_id: documentId, storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: generated ? "assistant_generated" : "upload", version_number: 1,
        filename: file.originalname, file_type: fileType,
        size_bytes: file.buffer.byteLength, page_count: pageCount,
        provenance: input.provenance ?? null }).select("id").single();
    if (versionError || !version) {
      failed(versionError, "Failed to record upload version");
      throw new Error("Failed to record upload version");
    }
    const { data: updated, error: updateError } = await db
      .from("documents")
      .update({ current_version_id: version.id, status: "ready",
        updated_at: new Date().toISOString() }).eq("id", documentId)
      .select("*").single();
    if (updateError || !updated) {
      failed(updateError, "Failed to activate upload version");
      throw new Error("Failed to activate upload version");
    }
    void recordAudit(db, { userId, userEmail,
      action: generated ? "document.generated" : "document.uploaded",
      title: file.originalname, surface, projectId, documentId });
    return { ...updated, filename: file.originalname, storage_path: key,
      pdf_storage_path: pdfStoragePath, folder_id: updated.library_folder_id ?? null,
      file_type: fileType, size_bytes: file.buffer.byteLength, page_count: pageCount,
      active_version_number: 1 };
  } catch (error) {
    await db.from("documents").update({ status: "error" }).eq("id", documentId);
    void recordAudit(db, { userId, userEmail,
      action: generated ? "document.generated" : "document.uploaded",
      status: "failed", title: file.originalname, surface, projectId, documentId });
    console.error("[document/upload] processing failed", {
      userId, projectId, error: error instanceof Error ? error.name : "unknown",
    });
    throw new Error("Document processing failed");
  }
}

type CloudDocument = { id: string; user_id: string; project_id: string | null;
  current_version_id: string | null; isOwner: boolean };

const failed = (error: { code?: string; status?: number } | null, operation: string) => {
  if (!error) return;
  console.error("[cloud-document] operation failed", {
    operation, code: error.code ?? "unknown", status: error.status ?? null,
  });
  throw new Error(operation);
};

const deleteFiles = (paths: (string | null | undefined)[]) => Promise.all(
  [...new Set(paths.filter((value): value is string => !!value))]
    .map((value) => deleteFile(value).catch(() => undefined)),
);

const versionResponse = (version: ActiveVersion): DocumentVersion => ({
  id: version.id, version_number: version.version_number, source: version.source,
  created_at: version.created_at ?? null, filename: version.filename,
  storage_path: version.storage_path, file_type: version.file_type,
  size_bytes: version.size_bytes, page_count: version.page_count, deleted_at: null });

function downloadName(version: ActiveVersion) {
  const name = version.filename?.trim() || "Untitled document.docx";
  if (version.source !== "assistant_edit" || !version.version_number) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name} [Edited V${version.version_number}]${
    dot > 0 ? name.slice(dot) : ""
  }`;
}

async function accessibleDocument(scope: CloudScope, documentId: string, owner = false) {
  const access = await scope.document(documentId, owner);
  return access ? { ...access.row, isOwner: access.isOwner } as CloudDocument : null;
}

async function removeDocument(db: Db, documentId: string) {
  const versions = await run(db.from("document_versions")
    .select("storage_path, pdf_storage_path").eq("document_id", documentId),
  "Failed to load document files");
  await run(db.from("documents").delete().eq("id", documentId),
    "Failed to delete document");
  await deleteFiles((versions ?? []).flatMap((row) =>
    [row.storage_path, row.pdf_storage_path]));
}

async function nextVersionNumber(db: Db, documentId: string) {
  const data = await run(db.from("document_versions")
    .select("version_number").eq("document_id", documentId)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle(), "Failed to load document version number");
  return ((data?.version_number as number | null) ?? 1) + 1;
}

async function insertVersion(db: Db, documentId: string,
  values: Record<string, unknown>) {
  const data = await run(db.from("document_versions")
    .insert({ document_id: documentId, source: "user_upload", ...values })
    .select("id, version_number, source, created_at, filename, storage_path, file_type, size_bytes, page_count, deleted_at")
    .single(), "Failed to record document version");
  if (!data) throw new Error("Failed to record document version");
  const { error: updateError } = await db.from("documents")
    .update({ current_version_id: data.id, updated_at: new Date().toISOString() })
    .eq("id", documentId);
  if (updateError) {
    await db.from("document_versions").delete().eq("id", data.id);
    failed(updateError, "Failed to activate document version");
  }
  return data as DocumentVersion;
}

async function pdfPages(bytes: Buffer) {
  return countLegalPdfPages(bytes).catch(() => null);
}

async function readCloudDocument(
  identity: DocumentScope,
  documentId: string,
  versionId: string | null,
  preferPdf: boolean,
): Promise<DocumentContent | null> {
  const scope = cloudScope(identity), { db } = scope;
  if (!await accessibleDocument(scope, documentId)) return null;
  const active = await loadActiveVersion(documentId, db, versionId);
  if (!active) return null;
  let source: ArrayBuffer | null = null;
  let pdfPath = active.pdf_storage_path;
  if (preferPdf && shouldConvertToPdf(active.file_type) && !pdfPath) {
    source = await downloadFile(active.storage_path);
    if (source) {
      const key = `converted-pdfs/${scope.userId}/${documentId}/${active.id}.pdf`;
      try {
        const pdf = await docxToPdf(Buffer.from(source));
        await uploadFile(key, arrayBuffer(pdf), "application/pdf");
        const { error } = await db.from("document_versions")
          .update({ pdf_storage_path: key }).eq("id", active.id);
        if (error) await deleteFile(key).catch(() => undefined);
        else pdfPath = key;
      } catch (error) {
        console.error("[document-display] Office to PDF conversion failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
  const usePdf = preferPdf && !!pdfPath && shouldConvertToPdf(active.file_type);
  const raw = usePdf
    ? await downloadFile(pdfPath!)
    : source ?? await downloadFile(active.storage_path);
  return raw ? {
    bytes: Buffer.from(raw),
    version: versionResponse(active),
    filename: downloadName(active),
    fileType: usePdf ? "pdf" : active.file_type ?? "",
    hasPdfRendition: !!pdfPath,
  } : null;
}

export const cloudDocuments = {
  async create(identity, input) {
    const scope = cloudScope(identity);
    if (input.projectId && !await scope.project(input.projectId)) {
      throw new DocumentStoreError(404, "Project not found");
    }
    return await createCloudDocument(scope, {
      projectId: input.projectId ?? null,
      libraryKind: input.libraryKind,
      libraryFolderId: input.folderId,
      file: { originalname: input.filename, buffer: input.bytes },
      fileType: input.fileType,
      provenance: input.provenance,
    });
  },

  async deleteDocument(identity, documentId) {
    const scope = cloudScope(identity);
    if (!await accessibleDocument(scope, documentId, true)) return false;
    await removeDocument(scope.db, documentId);
    return true;
  },

  async files(identity, documentIds) {
    if (!documentIds.length) return [];
    const scope = cloudScope(identity), { db } = scope;
    const documents = (await scope.documents(documentIds)).map(({ row }) => row);
    const versionIds = documents.flatMap((document) =>
      document.current_version_id ? [document.current_version_id] : [],
    );
    if (!versionIds.length) return [];
    const { data: rows, error: versionError } = await db
      .from("document_versions")
      .select("id, document_id, storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count, created_at")
      .in("id", versionIds).is("deleted_at", null);
    failed(versionError, "Failed to load document versions");
    const loaded: (DocumentContent | null)[] = await Promise.all(
      (rows ?? []).map(async (row): Promise<DocumentContent | null> => {
      if (!row.storage_path) return null;
      const raw = await downloadFile(row.storage_path);
      if (!raw) return null;
      const active = row as ActiveVersion;
      return {
        bytes: Buffer.from(raw),
        version: versionResponse(active),
        filename: downloadName(active),
        fileType: active.file_type ?? "",
        hasPdfRendition: !!active.pdf_storage_path,
      };
      }),
    );
    return loaded.flatMap((value) => value ? [value] : []);
  },

  read: readCloudDocument,

  async link(identity, documentId, versionId) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId)) return null;
    const active = await loadActiveVersion(documentId, db, versionId);
    if (!active) return null;
    const name = downloadName(active);
    return {
      url: await getSignedUrl(active.storage_path, 3600, name),
      version: versionResponse(active),
      filename: name,
      fileType: active.file_type ?? "",
      hasPdfRendition: !!active.pdf_storage_path,
    };
  },

  async versions(identity, documentId) {
    const scope = cloudScope(identity), { db } = scope;
    const document = await accessibleDocument(scope, documentId);
    if (!document) return null;
    const { data, error } = await db.from("document_versions")
      .select("id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at, deleted_by")
      .eq("document_id", documentId).order("created_at", { ascending: true });
    failed(error, "Failed to load document versions");
    return {
      current_version_id: document.current_version_id,
      versions: (data ?? []) as DocumentVersion[],
    };
  },

  async addVersion(identity, documentId, file) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId)) return null;
    const slug = crypto.randomUUID().replaceAll("-", "");
    const key = versionStorageKey(scope.userId, documentId, slug, file.filename);
    await uploadFile(key, arrayBuffer(file.bytes),
      contentTypeForDocumentType(file.fileType));
    try {
      return await insertVersion(db, documentId, {
        storage_path: key,
        pdf_storage_path: file.fileType === "pdf" ? key : null,
        version_number: await nextVersionNumber(db, documentId),
        filename: file.filename,
        file_type: file.fileType,
        size_bytes: file.bytes.byteLength,
        page_count: file.fileType === "pdf" ? await pdfPages(file.bytes) : null,
      });
    } catch (error) {
      await deleteFiles([key]);
      throw error;
    }
  },

  async commitAssistantVersion(identity, documentId, input) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId)) {
      return { status: "missing" as const };
    }
    const active = await loadActiveVersion(documentId, db);
    if (
      !active || active.id !== input.sourceVersionId ||
      (input.turnVersionId && input.turnVersionId !== active.id)
    ) return { status: "conflict" as const };
    if (input.turnVersionId) {
      const { data, error } = await db.from("document_edits")
        .select("del_w_id, ins_w_id, status")
        .eq("document_id", documentId)
        .eq("version_id", active.id);
      failed(error, "Failed to load prior assistant edits");
      const retainedIds = new Set(
        (await extractTrackedChangeIds(input.bytes)).map(({ w_id }) => w_id),
      );
      if ((data ?? []).some((edit) =>
        edit.status === "pending" &&
        [edit.del_w_id, edit.ins_w_id].filter(Boolean)
          .some((id) => !retainedIds.has(String(id)))
      )) {
        throw new DocumentStoreError(
          409,
          "A later same-turn edit overlaps an earlier tracked change; split it into a new turn so every accept/reject receipt remains valid",
        );
      }
    }

    const key = versionStorageKey(
      scope.userId,
      documentId,
      crypto.randomUUID().replaceAll("-", ""),
      input.filename,
    );
    await uploadFile(
      key,
      arrayBuffer(input.bytes),
      contentTypeForDocumentType("docx"),
    );
    let version: DocumentVersion | undefined;
    let editIds: string[] = [];
    try {
      version = input.turnVersionId
        ? versionResponse(active)
        : await insertVersion(db, documentId, {
            storage_path: key,
            pdf_storage_path: null,
            source: "assistant_edit",
            version_number: await nextVersionNumber(db, documentId),
            filename: input.filename,
            file_type: "docx",
            size_bytes: input.bytes.byteLength,
            page_count: null,
          });
      if (!version) throw new Error("Failed to record assistant version");
      const versionId = version.id;

      const rows = input.edits.map((edit) => ({
        document_id: documentId,
        version_id: versionId,
        change_id: edit.changeId,
        del_w_id: edit.delWId ?? null,
        ins_w_id: edit.insWId ?? null,
        deleted_text: edit.deletedText,
        inserted_text: edit.insertedText,
        context_before: edit.contextBefore,
        context_after: edit.contextAfter,
        status: input.status,
        ...(input.status === "pending"
          ? {}
          : { resolved_at: new Date().toISOString() }),
      }));
      const { data, error } = await db.from("document_edits").insert(rows)
        .select("id, change_id");
      failed(error, "Failed to record assistant edits");
      if (!data || data.length !== input.edits.length) {
        throw new Error("Failed to record assistant edits");
      }
      editIds = data.map(({ id }) => String(id));
      if (input.turnVersionId) {
        const { data: updated, error: updateError } = await db
          .from("document_versions").update({
            storage_path: key,
            pdf_storage_path: null,
            filename: input.filename,
            file_type: "docx",
            size_bytes: input.bytes.byteLength,
            page_count: null,
          }).eq("id", active.id).eq("document_id", documentId)
          .select("id, version_number, source, created_at, filename, storage_path, file_type, size_bytes, page_count, deleted_at")
          .single();
        failed(updateError, "Failed to update assistant version");
        if (!updated) throw new Error("Failed to update assistant version");
        version = updated as DocumentVersion;
        if (active.storage_path !== key) {
          await deleteFile(active.storage_path).catch(() => undefined);
        }
      }
      return {
        status: "committed" as const,
        version,
        edits: input.edits.map((edit, index) => ({
          ...edit,
          id: String(data[index].id),
          status: input.status,
        })),
      };
    } catch (error) {
      await deleteFile(key).catch(() => undefined);
      if (editIds.length) {
        await db.from("document_edits").delete().in("id", editIds);
      }
      if (!input.turnVersionId && version) {
        await db.from("documents").update({
          current_version_id: input.sourceVersionId,
        }).eq("id", documentId).eq("current_version_id", version.id);
        await db.from("document_versions").delete().eq("id", version.id);
      }
      throw error;
    }
  },

  async copyVersion(identity, targetId, sourceId, filename) {
    const scope = cloudScope(identity), { db } = scope;
    const target = await accessibleDocument(scope, targetId);
    if (!target) return { status: "target-missing" as const };
    const source = await accessibleDocument(scope, sourceId);
    if (!source) return { status: "source-missing" as const };
    const move = source.project_id && target.project_id
      ? source.project_id === target.project_id
      : !source.project_id && !target.project_id &&
        source.user_id === scope.userId && target.user_id === scope.userId;
    if (move && !source.isOwner) return { status: "forbidden" as const };
    const active = await loadActiveVersion(sourceId, db);
    if (!active) return { status: "source-missing" as const };
    const raw = await downloadFile(active.storage_path);
    if (!raw) return { status: "source-missing" as const };
    const name = filename ?? active.filename?.trim() ?? "Untitled document";
    const slug = crypto.randomUUID().replaceAll("-", "");
    const key = versionStorageKey(scope.userId, targetId, slug, name);
    await uploadFile(key, raw, contentTypeForDocumentType(active.file_type));
    let version: DocumentVersion;
    try {
      version = await insertVersion(db, targetId, {
        storage_path: key,
        pdf_storage_path: active.file_type === "pdf" ? key : null,
        version_number: await nextVersionNumber(db, targetId),
        filename: name,
        file_type: active.file_type,
        size_bytes: active.size_bytes ?? raw.byteLength,
        page_count: active.page_count,
      });
    } catch (error) {
      await deleteFiles([key]);
      throw error;
    }
    if (move) await removeDocument(db, sourceId);
    return { status: "created" as const, version };
  },

  async renameVersion(identity, documentId, versionId, filename) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId)) return null;
    const { data, error } = await db.from("document_versions")
      .update({ filename }).eq("id", versionId).eq("document_id", documentId)
      .is("deleted_at", null)
      .select("id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at")
      .maybeSingle();
    failed(error, "Failed to rename document version");
    return data as DocumentVersion | null;
  },

  async replaceVersion(identity, documentId, versionId, file) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId, true)) {
      return { status: "missing" as const };
    }
    const { data: target, error } = await db.from("document_versions")
      .select("id, storage_path, pdf_storage_path, file_type, deleted_at")
      .eq("id", versionId).eq("document_id", documentId).maybeSingle();
    failed(error, "Failed to load document version");
    if (!target || target.deleted_at) return { status: "missing" as const };
    if (target.file_type && target.file_type !== file.fileType) {
      return { status: "type-mismatch" as const };
    }
    const key = versionStorageKey(
      scope.userId,
      documentId,
      crypto.randomUUID().replaceAll("-", ""),
      file.filename,
    );
    await uploadFile(key, arrayBuffer(file.bytes),
      contentTypeForDocumentType(file.fileType));
    const pdfPath = file.fileType === "pdf" ? key : null;
    const { data, error: updateError } = await db.from("document_versions")
      .update({
        storage_path: key,
        pdf_storage_path: pdfPath,
        filename: file.filename,
        file_type: file.fileType,
        size_bytes: file.bytes.byteLength,
        page_count: file.fileType === "pdf" ? await pdfPages(file.bytes) : null,
        created_at: new Date().toISOString(),
      })
      .eq("id", versionId).eq("document_id", documentId)
      .select("id, version_number, source, created_at, filename, file_type, size_bytes, page_count, deleted_at")
      .maybeSingle();
    if (updateError || !data) {
      await deleteFiles([key]);
      failed(updateError, "Failed to replace document version");
      return { status: "missing" as const };
    }
    await deleteFiles([target.storage_path, target.pdf_storage_path]);
    return { status: "replaced" as const, version: data as DocumentVersion };
  },

  async deleteVersion(identity, documentId, versionId) {
    const scope = cloudScope(identity), { db } = scope;
    const document = await accessibleDocument(scope, documentId, true);
    if (!document) return { status: "missing" as const };
    const { data, error } = await db.from("document_versions")
      .select("id, storage_path, pdf_storage_path, version_number, created_at")
      .eq("document_id", documentId).is("deleted_at", null);
    failed(error, "Failed to load document versions");
    const versions = data ?? [];
    const target = versions.find((version) => version.id === versionId);
    if (!target) return { status: "missing" as const };
    if (versions.length === 1) return { status: "only" as const };
    const remaining = versions.filter((version) => version.id !== versionId)
      .sort((left, right) =>
        (right.version_number ?? -1) - (left.version_number ?? -1) ||
        Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""),
      );
    const currentVersionId = document.current_version_id === versionId
      ? remaining[0]?.id ?? null
      : document.current_version_id;
    if (document.current_version_id === versionId) {
      const { error: updateError } = await db.from("documents")
        .update({ current_version_id: currentVersionId,
          updated_at: new Date().toISOString() })
        .eq("id", documentId);
      failed(updateError, "Failed to activate remaining document version");
    }
    const { error: deleteError } = await db.from("document_versions")
      .update({ storage_path: null, pdf_storage_path: null,
        deleted_at: new Date().toISOString(), deleted_by: scope.userId })
      .eq("id", versionId).eq("document_id", documentId)
      .is("deleted_at", null);
    failed(deleteError, "Failed to delete document version");
    await deleteFiles([target.storage_path, target.pdf_storage_path]);
    return { status: "deleted" as const, currentVersionId };
  },

  async resolveEdit(identity, documentId, editId, mode) {
    const scope = cloudScope(identity), { db } = scope;
    if (!await accessibleDocument(scope, documentId)) {
      return { status: "missing" as const };
    }
    const { data: edit, error } = await db.from("document_edits")
      .select("id, version_id, del_w_id, ins_w_id, status")
      .eq("id", editId).eq("document_id", documentId).maybeSingle();
    failed(error, "Failed to load tracked edit");
    if (!edit) return { status: "missing" as const };
    const desired = mode === "accept" ? "accepted" : "rejected";
    const active = await loadActiveVersion(documentId, db);
    if (!active || edit.version_id !== active.id) {
      return { status: "invalid" as const };
    }
    if (edit.status !== "pending") {
      return edit.status === desired
        ? {
            status: "unchanged" as const,
            editStatus: edit.status,
            versionId: active.id,
            versionNumber: active.version_number,
            downloadUrl: buildDownloadUrl(active.storage_path, downloadName(active)),
          }
        : { status: "conflict" as const, editStatus: edit.status };
    }
    const raw = await downloadFile(active.storage_path);
    if (!raw) return { status: "invalid" as const };
    const ids = [edit.del_w_id, edit.ins_w_id]
      .filter((value): value is string => !!value);
    const resolved = await resolveTrackedChange(Buffer.from(raw), ids, mode);
    if (!resolved.found) return { status: "invalid" as const };
    await uploadFile(
      active.storage_path,
      arrayBuffer(resolved.bytes),
      contentTypeForDocumentType(active.file_type),
    );
    const now = new Date().toISOString();
    const { error: editError } = await db.from("document_edits")
      .update({ status: desired, resolved_at: now }).eq("id", editId);
    failed(editError, "Failed to resolve tracked edit");
    const { error: versionError } = await db.from("document_versions")
      .update({ pdf_storage_path: null, size_bytes: resolved.bytes.byteLength })
      .eq("id", active.id);
    failed(versionError, "Failed to update resolved document version");
    if (active.pdf_storage_path && active.pdf_storage_path !== active.storage_path) {
      await deleteFiles([active.pdf_storage_path]);
    }
    return {
      status: "resolved" as const,
      editStatus: desired,
      versionId: active.id,
      versionNumber: active.version_number,
      downloadUrl: buildDownloadUrl(active.storage_path, downloadName(active)),
    };
  },
} satisfies DocumentStore;
