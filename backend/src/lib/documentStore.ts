export type DocumentScope = {
  userId: string;
  userEmail?: string;
};

export type DocumentVersion = Record<string, unknown> & {
  id: string;
  version_number: number | null;
  source: string | null;
  created_at: string | null;
  filename: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  source_sha256?: string | null;
};

export type DocumentContent = {
  bytes: Buffer;
  version: DocumentVersion;
  filename: string;
  fileType: string;
  hasPdfRendition: boolean;
};

export type DocumentLink = Omit<DocumentContent, "bytes"> & {
  /** Omitted for the authenticated Beaver file route; null means unavailable. */
  url?: string | null;
};

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
