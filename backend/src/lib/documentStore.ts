import type { LibraryKind } from "./normalize";
import type { EditDiffSegment } from "./docxTrackedChanges";
import type { ApplicationScope } from "./applicationError";
import type { WorkProductBuildReceipt } from "./workProduct";
import type { AuthorityCitationLedger } from "./authoritiesDomain";

export type DocumentScope = ApplicationScope;
export type LegalPdfOcrProvider = "kraken-lite" | "tesseract";
export type LegalPdfProfile = {
  ocr?: { provider: LegalPdfOcrProvider; settings: Record<string, unknown> };
  layout?: { provider: "ppdoc"; settings: Record<string, unknown> };
};
export type PdfProfileSelection = {
  cacheKey: string;
  profile: LegalPdfProfile;
  status: "ready" | "degraded";
};
export function decodePdfProfileSelection(value: unknown): PdfProfileSelection | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const profile = record?.profile && typeof record.profile === "object" &&
    !Array.isArray(record.profile) ? record.profile as Record<string, unknown> : null;
  const setting = (value: unknown, provider: string | readonly string[]) => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    const providers = typeof provider === "string" ? [provider] : provider;
    return typeof entry.provider === "string" && providers.includes(entry.provider) &&
      !!entry.settings && typeof entry.settings === "object" && !Array.isArray(entry.settings);
  };
  return record && profile && typeof record.cacheKey === "string" &&
    /^[a-f0-9]{64}$/u.test(record.cacheKey) &&
    (record.status === "ready" || record.status === "degraded") &&
    Object.keys(profile).every((key) => key === "ocr" || key === "layout") &&
    setting(profile.ocr, ["tesseract", "kraken-lite"]) &&
    setting(profile.layout, "ppdoc")
    ? { cacheKey: record.cacheKey, profile: profile as LegalPdfProfile,
      status: record.status }
    : undefined;
}
export type DocumentParseState = {
  status: "queued" | "parsing" | "ready" | "degraded" | "failed" | "cancelled";
  phase?: "inspecting" | "extracting" | "ocr";
  pages?: number[];
  page_count?: number;
  error?: string;
};
export type DocumentRecord = { id: string; user_id: string; filename: string;
  current_version_id: string; active_version_number: number; file_type: string;
  current_working_revision: number; source_sha256: string;
  project_id: string | null; folder_id: string | null; library_kind: LibraryKind;
  library_folder_id: string | null; size_bytes: number; page_count: number | null;
  status: string; created_at: string; updated_at: string; metadata: unknown;
  notes: string | null; parse_state: DocumentParseState | null };
export type DocumentVersion = Record<string, unknown> & { id: string; version_number: number;
  working_revision: number;
  created_by: string | null; author_email?: string; comment?: string | null;
  parent_version_id: string | null;
  source: string; created_at: string; filename: string;
  file_type: string; size_bytes: number; page_count?: number | null;
  source_sha256: string };
export type DocumentHeadExpectation = { versionId: string; workingRevision: number;
  projectId: string | null; folderId: string | null };
export type CreatedDocumentVersion = DocumentVersion & {
  project_id: string | null; folder_id: string | null };
export type DocumentRollback = { documentId: string; versionId?: string;
  expected: DocumentHeadExpectation };
export type DocumentProjectionSource = Readonly<{
  documentId: string; versionId: string; fileType: string; sourceSha256: string;
  pdfProfile?: PdfProfileSelection; provenance?: DocumentProvenance;
  readBytes: () => Buffer | Promise<Buffer>;
}>;
export type DocumentContent = { bytes: Buffer; version: DocumentVersion; filename: string;
  fileType: string; hasPdfRendition: boolean; pdfProfile?: PdfProfileSelection };
export type DocumentDownload = { kind: "bytes"; content: DocumentContent }
  | { kind: "redirect"; url: string };
export type DocumentDownloadOptions = {
  preferPdf: boolean; disposition: "inline" | "attachment"; evidence?: string;
};
export type DocumentSpreadsheet = { version_id: string; sheets: Array<{
  name: string; cells: Array<{ address: string; value: string; row: number; column: number;
    rowSpan?: number; columnSpan?: number }>;
}> };
export type DocumentEvidenceView = { versionId: string; filename: string;
  pageNumbers: number[]; pages: Array<{ page_number: number; text: string }> };
export type AssistantEdit = { changeId: string; delWId?: string; insWId?: string;
  deletedText: string; insertedText: string; contextBefore: string; contextAfter: string;
  reason?: string; diff: EditDiffSegment[] };
export type StoredAssistantEdit = AssistantEdit & { id: string;
  status: "pending" | "accepted" | "rejected" };
export type AssistantDocumentProvenance = { schemaVersion: 1; actor: "assistant";
  action: "created" | "revised"; turnId?: string; changeCount?: number; generation?: {
    rendererVersion: "beaver.docx-markdown.v2"; markdownSha256: string;
    fieldValuesSha256: string; sourceRegistrySha256: string; evidenceBindings: Array<{
      id: string; evidenceIds: string[]; sourceSha256s: string[]; locators: string[];
      mainUrls: string[]; pinpointUrls: string[] }>;
    authorityLedger?: Omit<AuthorityCitationLedger, "document"> } };
export type DocumentProvenance = AssistantDocumentProvenance |
  { schemaVersion: 1; actor: "work-product"; action: "built";
    receipt: WorkProductBuildReceipt };
export type CommitAssistantVersionResult = { status: "committed"; version: DocumentVersion;
  edits: StoredAssistantEdit[] } | { status: "conflict" | "missing" };
export type RestoreVersionResult = { status: "restored"; version: DocumentVersion }
  | { status: "missing" | "conflict" | "pending-edits" };
export type CheckpointVersionResult = { status: "created"; version: DocumentVersion }
  | { status: "missing" | "conflict" | "pending-edits" };
export type CompareVersionResult = { status: "compared"; bytes: Buffer; filename: string }
  | { status: "missing" | "type-mismatch" | "same" };
export type ReplaceVersionResult = { status: "replaced"; version: DocumentVersion }
  | { status: "missing" | "type-mismatch" | "conflict" };
export type DeleteVersionResult = { status: "deleted"; currentVersionId: string | null }
  | { status: "missing" | "only" };
export type RelocateDocumentResult = { status: "moved"; document: DocumentRecord }
  | { status: "missing" | "conflict" };
export type ResolveEditResult = { status: "missing" | "invalid" }
  | { status: "conflict"; editStatus: string }
  | { status: "resolved" | "unchanged"; editStatus: string; versionId: string | null;
      versionNumber: number | null; downloadUrl: string | null };
export type DocumentFile = { filename: string; fileType: string; expectedSha256?: string } & (
  { bytes: Buffer } | { path: string; sizeBytes: number }
);
export type DocumentPartFile = { name: string; bytes: Buffer; expectedSha256?: string };
export type DocumentPartsChange = { put?: DocumentPartFile[]; remove?: string[] };
export type DocumentPartContent = { name: string; bytes: Buffer; sha256: string };

export type DocumentStore = {
  resumeCleanup(): Promise<void>;
  metadata(scope: DocumentScope, id: string, owner?: boolean): Promise<DocumentRecord | null>;
  metadataMany(scope: DocumentScope, ids: string[], owner?: boolean): Promise<DocumentRecord[]>;
  parseStates(scope: DocumentScope, ids: string[]): Promise<Array<{
    id: string; parse_state: DocumentParseState | null; page_count: number | null;
  }>>;
  create(scope: DocumentScope, input: DocumentFile & { projectId?: string | null;
    libraryKind?: LibraryKind; folderId?: string | null; provenance?: DocumentProvenance;
    parts?: DocumentPartFile[] }):
    Promise<DocumentRecord>;
  deleteDocument(scope: DocumentScope, id: string, owner?: boolean,
    expected?: DocumentHeadExpectation): Promise<boolean>;
  deleteUserDocuments(scope: DocumentScope, input: { projectIds: string[];
    includeOwned: boolean }): Promise<number>;
  relocate(scope: DocumentScope, id: string, input: { expectedProjectId: string | null;
    expectedFolderId: string | null;
    projectId: string | null; folderId: string | null; owner: boolean }):
    Promise<RelocateDocumentResult>;
  updateMetadata(scope: DocumentScope, id: string,
    input: { metadata?: unknown; notes?: string | null }): Promise<DocumentRecord | null>;
  files(scope: DocumentScope, ids: string[], maxBytes?: number): Promise<DocumentContent[]>;
  read(scope: DocumentScope, id: string, versionId: string | null,
    preferPdf: boolean): Promise<DocumentContent | null>;
  readParts(scope: DocumentScope, id: string, versionId: string | null,
    names: string[]): Promise<DocumentPartContent[] | null>;
  recordPdfPreparation(scope: DocumentScope, id: string, input: { versionId: string;
    sourceSha256: string; pageCount: number; pdfProfile: PdfProfileSelection }): Promise<boolean>;
  projectionSource(scope: DocumentScope, id: string, versionId: string | null):
    Promise<DocumentProjectionSource | null>;
  spreadsheet(scope: DocumentScope, id: string, versionId: string | null):
    Promise<DocumentSpreadsheet | null>;
  evidenceView(scope: DocumentScope, id: string, versionId: string, handle: string):
    Promise<DocumentEvidenceView | null>;
  download(scope: DocumentScope, id: string, versionId: string | null,
    options: DocumentDownloadOptions): Promise<DocumentDownload | null>;
  versions(scope: DocumentScope, id: string): Promise<{ current_version_id: string | null;
    versions: DocumentVersion[] } | null>;
  addVersion(scope: DocumentScope, id: string,
    file: DocumentFile & { provenance?: DocumentProvenance;
      comment?: string | null; expectedCurrentVersionId?: string;
      expectedCurrentWorkingRevision?: number; expectedCurrentSha256?: string;
      parts?: DocumentPartsChange }):
    Promise<CreatedDocumentVersion | null>;
  commitAssistantVersion(scope: DocumentScope, id: string, input: { sourceVersionId: string;
    expectedWorkingRevision: number;
    turnVersionId?: string; turnId?: string; filename: string; bytes: Buffer;
    fileType: string; edits: AssistantEdit[]; status: StoredAssistantEdit["status"];
    parts?: DocumentPartsChange }):
    Promise<CommitAssistantVersionResult>;
  restoreVersion(scope: DocumentScope, id: string, versionId: string,
    expectedCurrentVersionId: string, expectedCurrentWorkingRevision: number,
    comment?: string | null):
    Promise<RestoreVersionResult>;
  checkpointVersion(scope: DocumentScope, id: string, expectedCurrentVersionId: string,
    expectedCurrentWorkingRevision: number, comment?: string | null):
    Promise<CheckpointVersionResult>;
  compareVersions(scope: DocumentScope, id: string, baselineVersionId: string,
    versionId: string): Promise<CompareVersionResult>;
  renameVersion(scope: DocumentScope, id: string, versionId: string,
    filename: string, expectedWorkingRevision: number): Promise<DocumentVersion | null>;
  replaceVersion(scope: DocumentScope, id: string, versionId: string,
    expectedWorkingRevision: number, file: DocumentFile & { parts?: DocumentPartsChange }):
    Promise<ReplaceVersionResult>;
  deleteVersion(scope: DocumentScope, id: string, versionId: string,
    expected?: DocumentHeadExpectation): Promise<DeleteVersionResult>;
  resolveEdits(scope: DocumentScope, id: string, editIds: string[],
    mode: "accept" | "reject"): Promise<ResolveEditResult>;
};

export const createdDocumentRollback = (created: DocumentRecord): DocumentRollback => ({
  documentId: created.id, expected: { versionId: created.current_version_id,
    workingRevision: created.current_working_revision, projectId: created.project_id,
    folderId: created.folder_id },
});
export const createdVersionRollback = (
  documentId: string, version: CreatedDocumentVersion,
): DocumentRollback => ({ documentId, versionId: version.id, expected: {
  versionId: version.id, workingRevision: version.working_revision,
  projectId: version.project_id, folderId: version.folder_id,
} });
export async function rollbackDocuments(documents: DocumentStore, scope: DocumentScope,
  rollback: DocumentRollback[], error: unknown, message: string): Promise<never> {
  const failures: unknown[] = [];
  for (const item of [...rollback].reverse()) try {
    const removed = item.versionId
      ? (await documents.deleteVersion(scope, item.documentId,
        item.versionId, item.expected)).status === "deleted"
      : await documents.deleteDocument(scope, item.documentId, true, item.expected);
    if (!removed) throw new Error(`Created document could not be removed: ${item.documentId}`);
  } catch (cleanup) { failures.push(cleanup); }
  throw failures.length ? new AggregateError([error, ...failures], message) : error;
}
