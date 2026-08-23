import type { DocumentStore } from "./documentStore";
import {
  fixDocxSupraCrossReferencesNative,
  hasDocxSupraReferencesNative,
} from "./structureNative";

export async function fixDocumentSupras(
  documents: DocumentStore,
  userId: string,
  documentId: string,
  options: {
    saveVersion?: (input: {
      sourceVersionId: string;
      filename: string;
      bytes: Buffer;
    }) => Promise<{
      id: string;
      filename: string;
      version_number?: number;
      file_type?: string;
      source_sha256?: string;
      parentVersionId?: string;
    } | null>;
  } = {},
) {
  const file = await documents.read({ userId }, documentId, null, false);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Supra cleanup currently requires a DOCX document");
  }
  const cleanup = await fixDocxSupraCrossReferencesNative(file.bytes);
  if (!cleanup.converted) {
    return {
      ok: true,
      changed: false,
      document_id: documentId,
      version_id: file.version.id,
      filename: file.version.filename,
      ...cleanup,
      bytes: undefined,
    };
  }

  const baseName = file.filename.replace(/\.docx$/iu, "");
  const filename = `${baseName} - supras fixed.docx`;
  const version = options.saveVersion
    ? await options.saveVersion({
        sourceVersionId: file.version.id,
        filename,
        bytes: cleanup.bytes,
      })
    : await documents.addVersion(
        { userId }, documentId, { filename, bytes: cleanup.bytes, fileType: "docx" },
      );
  if (!version) throw new Error("Document disappeared before saving");
  const downloadUrl =
    `/api/single-documents/${encodeURIComponent(documentId)}/file` +
    `?version_id=${encodeURIComponent(version.id)}`;
  return {
    ok: true,
    receipt: "mike-document:v1",
    action: "revised",
    changed: true,
    document_id: documentId,
    parent_version_id:
      ("parentVersionId" in version ? version.parentVersionId : undefined) ??
      file.version.id,
    version_id: version.id,
    version_number: version.version_number,
    filename: version.filename,
    file_type: version.file_type ?? "docx",
    source_sha256: version.source_sha256,
    download_url: downloadUrl,
    annotations: [],
    ...cleanup,
    bytes: undefined,
  };
}

export async function inspectDocxAutomation(
  documents: DocumentStore,
  userId: string,
  documentId: string,
) {
  const file = await documents.read({ userId }, documentId, null, false);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Document automation currently requires a DOCX document");
  }
  return {
    supra_references: await hasDocxSupraReferencesNative(file.bytes),
  };
}
