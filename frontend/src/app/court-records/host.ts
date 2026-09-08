import type { Document } from "@/app/lib/api/documents";
import type { InputResolution, WorkProduct, WorkProductContext, WorkProductInput, WorkProductOutput,
  WorkProductOutputRef, WorkProductStore } from "@/app/lib/workProducts";
import { downloadBlob } from "@/app/lib/download";
import type { BuildArtifact, CourtRecordDraft, CourtRecordReceipt, CoverValues,
  DocumentKind, RecordEntry } from "./types";
import type { CourtRecordWorkProductOutput } from "../../../../shared/court-record-work-products.mjs";
import { sourceFormat } from "./formats";
import type { OutputFolderPort } from "@/app/components/shared/OutputFolderSetting";

import type { FilingContact } from "../../../../shared/user-preferences.mjs";
export type { FilingContact } from "../../../../shared/user-preferences.mjs";
export const FILING_CONTACT_FIELDS = ["counselName", "counselAddress", "counselPhone",
  "counselFax", "counselEmail"] as const;
export type FilingContactCover = Partial<Pick<CoverValues,
  (typeof FILING_CONTACT_FIELDS)[number]>>;

export const filingContactCover = (contact: FilingContact): FilingContactCover => ({
  counselName: contact.name, counselAddress: contact.address, counselPhone: contact.phone,
  counselFax: contact.fax, counselEmail: contact.email,
});

export const mergeFilingContact = (contact: FilingContact,
  cover: FilingContactCover): FilingContact => ({
  name: cover.counselName?.trim() ?? contact.name,
  address: cover.counselAddress?.trim() ?? contact.address,
  phone: cover.counselPhone?.trim() ?? contact.phone,
  fax: cover.counselFax?.trim() ?? contact.fax,
  email: cover.counselEmail?.trim() ?? contact.email,
});

export type PreparationProgress = (message: string, completed?: number, total?: number) => void;
export type PreparationContext = { workProductId?: string; destination?: DocumentKind };

export type PreparedFile = Pick<RecordEntry,
  "file" | "pdfRendition" | "pageCount" | "searchable" | "encrypted" | "textlessPageCount" |
  "textlessPages" | "sourceBookmarks" | "pageLabels" | "ocrTextByPage" | "ocrAttemptedPages" | "origin" | "binding" | "inspectionError" |
  "sourceFields">;

export type SelectedFile = { file: File; input?: WorkProductInput };
export type DraftOutputChoice = CourtRecordWorkProductOutput & {
  workProductId: string;
  workProductTitle: string;
  output: WorkProductOutput;
  document: Document;
};

export interface CourtRecordsHost {
  mode: "standalone" | "beaver";
  drafts: WorkProductStore;
  newDraftCover?(): Promise<FilingContactCover>;
  saveFilingContact?(cover: FilingContactCover): Promise<void>;
  prepareDeviceFile(file: File, progress?: PreparationProgress,
    context?: PreparationContext): Promise<PreparedFile>;
  resolveInput(input: WorkProductInput, progress?: PreparationProgress,
    destination?: DocumentKind): Promise<InputResolution & { prepared?: PreparedFile }>;
  relinkInput?(input: WorkProductInput): Promise<InputResolution & { prepared?: PreparedFile }>;
  runOcr?(entry: RecordEntry, progress?: PreparationProgress,
    signal?: AbortSignal): Promise<Partial<RecordEntry>>;
  importLibraryDocument?(document: Document, progress?: PreparationProgress,
    destination?: DocumentKind): Promise<PreparedFile>;
  searchDraftOutputs?(query: string, destination: DocumentKind, draft: WorkProductContext, signal?: AbortSignal):
    Promise<DraftOutputChoice[]>;
  importDraftOutput?(choice: DraftOutputChoice, destination: DocumentKind,
    progress?: PreparationProgress):
    Promise<PreparedFile>;
  saveArtifacts?(input: { artifacts: BuildArtifact[]; product: WorkProduct<CourtRecordDraft>;
    entries: RecordEntry[]; receipt: CourtRecordReceipt }): Promise<{
    documents: Document[];
    outputs: Record<string, WorkProductOutputRef>;
    product: WorkProduct<CourtRecordDraft>;
    notice?: string;
  }>;
  outputFolder?: OutputFolderPort;
}

/** Recognition runs once per file: a second pass over pages it already read finds nothing new. */
export const needsOcr = (entry: Pick<RecordEntry, "encrypted" | "searchable" |
  "textlessPageCount" | "ocrAttemptedPages" | "nonTextPagesConfirmed">) =>
  !entry.nonTextPagesConfirmed && entry.encrypted !== true && !entry.ocrAttemptedPages &&
    (entry.searchable === false || (entry.textlessPageCount ?? 0) > 0);

type OutputProduct = Pick<WorkProduct,
  "id" | "kind" | "title" | "projectId" | "updatedAt"> & {
    profileId?: string; state?: unknown;
  };

export function outputDocument(product: OutputProduct, output: WorkProductOutput): Document {
  return { id: output.documentId, project_id: product.projectId,
    filename: output.filename,
    file_type: sourceFormat({ name: output.filename, type: output.mimeType }) ?? null,
    pdf_storage_path: null, size_bytes: null, page_count: output.pageCount,
    created_at: product.updatedAt, current_version_id: output.versionId,
    source_sha256: output.sha256 };
}

export function draftOutputChoice(product: OutputProduct, role: string,
  output: WorkProductOutput): DraftOutputChoice {
  const profileId = product.kind === "court-record" ? product.profileId ??
    (product.state as Partial<CourtRecordDraft> | undefined)?.profileId : undefined;
  return { workProductId: product.id, workProductTitle: product.title,
    kind: product.kind, ...(profileId && { profileId }), role, output,
    document: outputDocument(product, output) };
}

export function downloadArtifact(artifact: BuildArtifact) {
  downloadBlob(new Blob([artifact.bytes.slice().buffer], { type: artifact.mimeType }),
    artifact.filename);
}
