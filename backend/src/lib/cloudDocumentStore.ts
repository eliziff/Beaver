import { recordAudit } from "./audit";
import { contentTypeForDocumentType } from "./documentTypes";
import { countLegalPdfPages } from "./legalPdfSourceDoc";
import { storageKey, uploadFile } from "./storage";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const arrayBuffer = (buffer: Buffer) => buffer.buffer.slice(
  buffer.byteOffset,
  buffer.byteOffset + buffer.byteLength,
) as ArrayBuffer;

export async function createCloudDocument(db: Db, input: {
  userId: string;
  userEmail?: string;
  projectId: string | null;
  libraryKind?: "file" | "template";
  libraryFolderId?: string | null;
  file: { originalname: string; buffer: Buffer };
  fileType: string;
}) {
  const { userId, projectId, file, fileType } = input;
  const { data: document, error: insertError } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      status: "processing",
      library_kind: input.libraryKind ?? "file",
      library_folder_id: input.libraryFolderId ?? null,
    })
    .select("*")
    .single();
  if (insertError || !document) {
    console.error("[document/upload] failed to create document row", {
      userId,
      projectId,
      filename: file.originalname,
      fileType,
      error: insertError,
    });
    throw new Error("Failed to create document record");
  }

  const documentId = document.id as string;
  const surface = projectId ? "project" : input.libraryKind ? "library" : "assistant";
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
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        filename: file.originalname,
        file_type: fileType,
        size_bytes: file.buffer.byteLength,
        page_count: pageCount,
      })
      .select("id")
      .single();
    if (versionError || !version) {
      throw new Error(
        `Failed to record upload version: ${versionError?.message ?? "unknown"}`,
      );
    }
    const { data: updated, error: updateError } = await db
      .from("documents")
      .update({
        current_version_id: version.id,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .select("*")
      .single();
    if (updateError || !updated) {
      throw new Error(
        `Failed to activate upload version: ${updateError?.message ?? "unknown"}`,
      );
    }
    void recordAudit(db, {
      userId,
      userEmail: input.userEmail,
      action: "document.uploaded",
      title: file.originalname,
      surface,
      projectId,
      documentId,
    });
    return {
      ...updated,
      filename: file.originalname,
      storage_path: key,
      pdf_storage_path: pdfStoragePath,
      folder_id: updated.library_folder_id ?? null,
      file_type: fileType,
      size_bytes: file.buffer.byteLength,
      page_count: pageCount,
      active_version_number: 1,
    };
  } catch (error) {
    await db.from("documents").update({ status: "error" }).eq("id", documentId);
    void recordAudit(db, {
      userId,
      userEmail: input.userEmail,
      action: "document.uploaded",
      status: "failed",
      title: file.originalname,
      surface,
      projectId,
      documentId,
    });
    throw new Error(`Document processing failed: ${String(error)}`);
  }
}
