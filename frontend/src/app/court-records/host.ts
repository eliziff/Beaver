import type { Document } from "@/app/components/shared/types";
import type { InputResolution, WorkProduct, WorkProductInput, WorkProductOutput,
  WorkProductOutputRef, WorkProductStore } from "@/app/lib/workProducts";
import { downloadBlob } from "@/app/lib/download";
import type { BuildArtifact, CourtRecordDraft, CourtRecordReceipt, CoverValues,
  RecordEntry } from "./types";
import type { CourtSourceFormat } from "./types";
import { sourceFormat } from "./formats";

export type PreparationProgress = (message: string, completed?: number, total?: number) => void;
export type PreparationContext = { workProductId?: string };

export type PreparedFile = Pick<RecordEntry,
  "file" | "pdfRendition" | "pageCount" | "searchable" | "encrypted" | "textlessPageCount" |
  "textlessPages" | "sourceBookmarks" | "ocrTextByPage" | "origin" | "binding" | "inspectionError" |
  "sourceFields">;

export type SelectedFile = { file: File; input?: WorkProductInput };
export type DraftOutputChoice = {
  workProductId: string;
  workProductTitle: string;
  role: string;
  output: WorkProductOutput;
  document: Document;
};

export interface CourtRecordsHost {
  mode: "standalone" | "beaver";
  drafts: WorkProductStore;
  newDraftCover?(): Promise<CoverValues>;
  prepareDeviceFile(file: File, progress?: PreparationProgress,
    context?: PreparationContext): Promise<PreparedFile>;
  pickDeviceFiles?(multiple: boolean): Promise<SelectedFile[]>;
  resolveInput(input: WorkProductInput, progress?: PreparationProgress): Promise<InputResolution & { prepared?: PreparedFile }>;
  relinkInput?(input: WorkProductInput): Promise<InputResolution & { prepared?: PreparedFile }>;
  runOcr?(entry: RecordEntry, progress?: PreparationProgress): Promise<Partial<RecordEntry>>;
  searchLibrary?(query: string, formats: CourtSourceFormat[], context?: PreparationContext):
    Promise<Document[]>;
  importLibraryDocument?(document: Document, progress?: PreparationProgress): Promise<PreparedFile>;
  searchDraftOutputs?(query: string, formats: CourtSourceFormat[], excludeId?: string):
    Promise<DraftOutputChoice[]>;
  importDraftOutput?(choice: DraftOutputChoice, progress?: PreparationProgress):
    Promise<PreparedFile>;
  saveArtifacts?(input: { artifacts: BuildArtifact[]; product: WorkProduct<CourtRecordDraft>;
    entries: RecordEntry[]; receipt: CourtRecordReceipt }): Promise<{
    documents: Document[];
    outputs: Record<string, WorkProductOutputRef>;
    product: WorkProduct<CourtRecordDraft>;
  }>;
}

export const needsOcr = (entry: Pick<RecordEntry,
  "encrypted" | "searchable" | "textlessPageCount">) =>
  entry.encrypted !== true &&
    (entry.searchable === false || (entry.textlessPageCount ?? 0) > 0);

export function outputDocument(product: WorkProduct, output: WorkProductOutput): Document {
  return { id: output.documentId, project_id: product.projectId,
    filename: output.filename,
    file_type: sourceFormat({ name: output.filename, type: output.mimeType }) ?? null,
    pdf_storage_path: null, size_bytes: null, page_count: output.pageCount,
    created_at: product.updatedAt, current_version_id: output.versionId,
    source_sha256: output.sha256 };
}

export function draftOutputChoice(product: WorkProduct, role: string,
  output: WorkProductOutput): DraftOutputChoice {
  return { workProductId: product.id, workProductTitle: product.title, role, output,
    document: outputDocument(product, output) };
}

export function downloadArtifact(artifact: BuildArtifact) {
  downloadBlob(new Blob([artifact.bytes.slice().buffer], { type: artifact.mimeType }),
    artifact.filename);
}
