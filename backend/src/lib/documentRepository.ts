import type {
  DocumentProvenance,
  DocumentScope,
  StoredAssistantEdit,
} from "./documentStore";
import type { LibraryKind } from "./normalize";

export type StoredDocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  source: string;
  createdAt: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  pageCount: number | null;
  sourceSha256: string;
  blobKey: string;
  pdfBlobKey: string | null;
  cleanupKeys: string[];
  provenance?: DocumentProvenance;
};

export type StoredDocument = {
  id: string;
  userId: string;
  projectId: string | null;
  libraryKind: LibraryKind;
  folderId: string | null;
  status: string;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: unknown;
  notes?: string | null;
};

export type DocumentAggregate = {
  document: StoredDocument;
  versions: StoredDocumentVersion[];
  edits: Array<StoredAssistantEdit & { versionId: string }>;
  isOwner: boolean;
};

export type CreateDocumentMetadata = {
  document: StoredDocument;
  version: StoredDocumentVersion;
};

export type UpdateVersionMetadata = {
  filename?: string;
  fileType?: string;
  sizeBytes?: number;
  pageCount?: number | null;
  sourceSha256?: string;
  blobKey?: string;
  pdfBlobKey?: string | null;
  cleanupKeys?: string[];
  provenance?: DocumentProvenance | null;
  createdAt?: string;
};

export type DocumentRepository = {
  authorizeCreate(scope: DocumentScope, input: {
    projectId: string | null;
    libraryKind: LibraryKind;
    folderId: string | null;
  }): Promise<"ok" | "project-missing" | "folder-missing" | "folder-unavailable">;
  create(scope: DocumentScope, input: CreateDocumentMetadata): Promise<void>;
  get(scope: DocumentScope, documentId: string, owner?: boolean): Promise<DocumentAggregate | null>;
  getMany(scope: DocumentScope, documentIds: string[]): Promise<DocumentAggregate[]>;
  insertVersion(scope: DocumentScope, documentId: string, input: {
    expectedCurrentVersionId: string;
    version: StoredDocumentVersion;
    edits?: StoredAssistantEdit[];
  }): Promise<"created" | "missing" | "conflict">;
  updateVersion(scope: DocumentScope, documentId: string, input: {
    versionId: string;
    expectedBlobKey: string;
    update: UpdateVersionMetadata;
    edits?: StoredAssistantEdit[];
    resolveEdit?: { id: string; status: StoredAssistantEdit["status"] };
  }): Promise<"updated" | "missing" | "conflict">;
  renameVersion(scope: DocumentScope, documentId: string, versionId: string,
    filename: string): Promise<boolean>;
  deleteVersion(scope: DocumentScope, documentId: string, versionId: string,
    currentVersionId: string): Promise<boolean>;
  deleteDocument(scope: DocumentScope, documentId: string): Promise<boolean>;
  clearCleanup(scope: DocumentScope, documentId: string, versionId: string,
    keys: string[]): Promise<void>;
  recordOrphan(scope: DocumentScope, key: string): Promise<void>;
  clearOrphan(key: string): Promise<void>;
  pendingOrphans(limit?: number): Promise<string[]>;
  pendingCleanup(limit?: number): Promise<Array<{
    scope: DocumentScope;
    documentId: string;
    versionId: string;
    keys: string[];
  }>>;
};
