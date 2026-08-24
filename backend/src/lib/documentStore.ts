import type { LibraryKind } from "./normalize";
import type { EditDiffSegment } from "./docxTrackedChanges";
import type { ApplicationScope } from "./applicationError";

export type DocumentScope = ApplicationScope;
export type DocumentParseState = {
  status: "queued" | "parsing" | "ready" | "degraded" | "failed" | "cancelled";
  phase?: "inspecting" | "extracting" | "ocr";
  pages?: number[];
  page_count?: number;
  error?: string;
};
export type DocumentRecord = Record<string, unknown> & { id: string; filename?: string | null;
  current_version_id?: string | null; active_version_number?: number | null;
  file_type?: string | null; parse_state?: DocumentParseState | null };
export type CreatedDocumentRecord = DocumentRecord & { filename: string;
  current_version_id: string; active_version_number: number; file_type: string;
  source_sha256: string };
export type DocumentVersion = Record<string, unknown> & { id: string; version_number: number;
  source: string; created_at: string; filename: string; storage_path?: string | null;
  file_type: string; size_bytes: number; page_count?: number | null;
  deleted_at?: string | null; source_sha256: string };
export type DocumentContent = { bytes: Buffer; version: DocumentVersion; filename: string;
  fileType: string; hasPdfRendition: boolean };
export type DocumentDownload = { kind: "bytes"; content: DocumentContent }
  | { kind: "redirect"; url: string };
export type AssistantEdit = { changeId: string; delWId?: string; insWId?: string;
  deletedText: string; insertedText: string; contextBefore: string; contextAfter: string;
  reason?: string; diff: EditDiffSegment[] };
export type StoredAssistantEdit = AssistantEdit & { id: string;
  status: "pending" | "accepted" | "rejected" };
export type DocumentProvenance = { schemaVersion: 1; actor: "assistant";
  action: "created" | "revised"; parentVersionId?: string; changeCount?: number;
  trackedEdits?: StoredAssistantEdit[]; generation?: {
    rendererVersion: "beaver.docx-markdown.v2"; markdownSha256: string;
    fieldValuesSha256: string; sourceRegistrySha256: string; evidenceBindings: Array<{
      id: string; evidenceIds: string[]; sourceSha256s: string[]; locators: string[];
      mainUrls: string[]; pinpointUrls: string[] }> } };
export type CommitAssistantVersionResult = { status: "committed"; version: DocumentVersion;
  edits: StoredAssistantEdit[] } | { status: "conflict" | "missing" };
export type CopyVersionResult = { status: "created"; version: DocumentVersion }
  | { status: "target-missing" | "source-missing" | "forbidden" };
export type ReplaceVersionResult = { status: "replaced"; version: DocumentVersion }
  | { status: "missing" | "type-mismatch" };
export type DeleteVersionResult = { status: "deleted"; currentVersionId: string | null }
  | { status: "missing" | "only" };
export type RelocateDocumentResult = { status: "moved"; document: DocumentRecord }
  | { status: "missing" | "conflict" };
export type ResolveEditResult = { status: "missing" | "invalid" }
  | { status: "conflict"; editStatus: string }
  | { status: "resolved" | "unchanged"; editStatus: string; versionId: string | null;
      versionNumber: number | null; downloadUrl: string | null };
export type DocumentFile = { filename: string; fileType: string } & (
  { bytes: Buffer } | { path: string; sizeBytes: number }
);

export type DocumentStore = {
  resumeCleanup(): Promise<void>;
  metadata(scope: DocumentScope, id: string, owner?: boolean): Promise<DocumentRecord | null>;
  parseStates(scope: DocumentScope, ids: string[]): Promise<Array<{
    id: string; parse_state: DocumentParseState | null; page_count: number | null;
  }>>;
  create(scope: DocumentScope, input: DocumentFile & { projectId?: string | null;
    libraryKind?: LibraryKind; folderId?: string | null; provenance?: DocumentProvenance }):
    Promise<CreatedDocumentRecord>;
  deleteDocument(scope: DocumentScope, id: string): Promise<boolean>;
  deleteUserDocuments(scope: DocumentScope, input: { projectIds: string[];
    includeOwned: boolean; purgeObjects: boolean }): Promise<number>;
  relocate(scope: DocumentScope, id: string, input: { expectedProjectId: string | null;
    projectId: string | null; folderId: string | null; owner: boolean }):
    Promise<RelocateDocumentResult>;
  updateMetadata(scope: DocumentScope, id: string,
    input: { metadata?: unknown; notes?: string | null }): Promise<DocumentRecord | null>;
  files(scope: DocumentScope, ids: string[], maxBytes?: number): Promise<DocumentContent[]>;
  read(scope: DocumentScope, id: string, versionId: string | null,
    preferPdf: boolean): Promise<DocumentContent | null>;
  download(scope: DocumentScope, id: string, versionId: string | null, preferPdf: boolean,
    disposition: "inline" | "attachment"): Promise<DocumentDownload | null>;
  versions(scope: DocumentScope, id: string): Promise<{ current_version_id: string | null;
    versions: DocumentVersion[] } | null>;
  addVersion(scope: DocumentScope, id: string, file: DocumentFile): Promise<DocumentVersion | null>;
  commitAssistantVersion(scope: DocumentScope, id: string, input: { sourceVersionId: string;
    turnVersionId?: string; parentVersionId: string; filename: string; bytes: Buffer;
    edits: AssistantEdit[]; status: StoredAssistantEdit["status"] }):
    Promise<CommitAssistantVersionResult>;
  copyVersion(scope: DocumentScope, targetId: string, sourceId: string,
    filename?: string): Promise<CopyVersionResult>;
  renameVersion(scope: DocumentScope, id: string, versionId: string,
    filename: string): Promise<DocumentVersion | null>;
  replaceVersion(scope: DocumentScope, id: string, versionId: string,
    file: DocumentFile): Promise<ReplaceVersionResult>;
  deleteVersion(scope: DocumentScope, id: string, versionId: string): Promise<DeleteVersionResult>;
  resolveEdit(scope: DocumentScope, id: string, editId: string,
    mode: "accept" | "reject"): Promise<ResolveEditResult>;
};
