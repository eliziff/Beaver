import type { LibraryKind } from "./normalize";
import type { EditDiffSegment } from "./docxTrackedChanges";

export type DocumentScope = {
  userId: string;
  userEmail?: string;
};

export type DocumentRecord = Record<string, unknown> & {
  id: string;
  filename?: string | null;
  current_version_id?: string | null;
  active_version_number?: number | null;
  file_type?: string | null;
};

export type CreatedDocumentRecord = DocumentRecord & {
  filename: string;
  current_version_id: string;
  active_version_number: number;
  file_type: string;
  source_sha256?: string | null;
};

export class DocumentStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type DocumentVersion = Record<string, unknown> & {
  id: string;
  version_number: number | null;
  source: string | null;
  created_at: string | null;
  filename: string | null;
  storage_path?: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  source_sha256?: string | null;
};

export type DocumentContent = {
  bytes: Buffer;
  localPath?: string;
  version: DocumentVersion;
  filename: string;
  fileType: string;
  hasPdfRendition: boolean;
};

export type DocumentLink = Omit<DocumentContent, "bytes"> & {
  /** Omitted for the authenticated Beaver file route; null means unavailable. */
  url?: string | null;
};

export type AssistantEdit = {
  changeId: string;
  delWId?: string;
  insWId?: string;
  deletedText: string;
  insertedText: string;
  contextBefore: string;
  contextAfter: string;
  reason?: string;
  diff: EditDiffSegment[];
};

export type StoredAssistantEdit = AssistantEdit & {
  id: string;
  status: "pending" | "accepted" | "rejected";
};

export type DocumentProvenance = {
  schemaVersion: 1;
  actor: "assistant";
  action: "created" | "revised";
  parentVersionId?: string;
  changeCount?: number;
  trackedEdits?: StoredAssistantEdit[];
  generation?: {
    rendererVersion: "beaver.docx-markdown.v2";
    markdownSha256: string;
    fieldValuesSha256: string;
    sourceRegistrySha256: string;
    evidenceBindings: {
      id: string;
      evidenceIds: string[];
      sourceSha256s: string[];
      locators: string[];
      mainUrls: string[];
      pinpointUrls: string[];
    }[];
  };
};

export type CommitAssistantVersionResult =
  | {
      status: "committed";
      version: DocumentVersion;
      edits: StoredAssistantEdit[];
    }
  | { status: "conflict" | "missing" };

export type CopyVersionResult =
  | { status: "created"; version: DocumentVersion }
  | { status: "target-missing" }
  | { status: "source-missing" }
  | { status: "forbidden" };

export type ReplaceVersionResult =
  | { status: "replaced"; version: DocumentVersion }
  | { status: "missing" }
  | { status: "type-mismatch" };

export type DeleteVersionResult =
  | { status: "deleted"; currentVersionId: string | null }
  | { status: "missing" }
  | { status: "only" };

export type ResolveEditResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "conflict"; editStatus: string }
  | {
      status: "resolved" | "unchanged";
      editStatus: string;
      versionId: string | null;
      versionNumber: number | null;
      downloadUrl: string | null;
    };

export type DocumentStore = {
  create(scope: DocumentScope, input: {
    filename: string;
    fileType: string;
    bytes: Buffer;
    projectId?: string | null;
    libraryKind?: LibraryKind;
    folderId?: string | null;
    provenance?: DocumentProvenance;
  }): Promise<CreatedDocumentRecord>;
  deleteDocument(scope: DocumentScope, documentId: string): Promise<boolean>;
  files(scope: DocumentScope, documentIds: string[]): Promise<DocumentContent[]>;
  read(
    scope: DocumentScope,
    documentId: string,
    versionId: string | null,
    preferPdf: boolean,
  ): Promise<DocumentContent | null>;
  link(
    scope: DocumentScope,
    documentId: string,
    versionId: string | null,
  ): Promise<DocumentLink | null>;
  versions(scope: DocumentScope, documentId: string): Promise<{
    current_version_id: string | null;
    versions: DocumentVersion[];
  } | null>;
  addVersion(scope: DocumentScope, documentId: string, file: {
    filename: string;
    fileType: string;
    bytes: Buffer;
  }): Promise<DocumentVersion | null>;
  commitAssistantVersion(scope: DocumentScope, documentId: string, input: {
    sourceVersionId: string;
    turnVersionId?: string;
    parentVersionId: string;
    filename: string;
    bytes: Buffer;
    edits: AssistantEdit[];
    status: StoredAssistantEdit["status"];
  }): Promise<CommitAssistantVersionResult>;
  copyVersion(scope: DocumentScope, targetId: string, sourceId: string,
    filename?: string): Promise<CopyVersionResult>;
  renameVersion(scope: DocumentScope, documentId: string, versionId: string,
    filename: string): Promise<DocumentVersion | null>;
  replaceVersion(scope: DocumentScope, documentId: string, versionId: string,
    file: { filename: string; fileType: string; bytes: Buffer },
  ): Promise<ReplaceVersionResult>;
  deleteVersion(scope: DocumentScope, documentId: string,
    versionId: string): Promise<DeleteVersionResult>;
  resolveEdit(scope: DocumentScope, documentId: string, editId: string,
    mode: "accept" | "reject"): Promise<ResolveEditResult>;
};
