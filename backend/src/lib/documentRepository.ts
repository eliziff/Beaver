import type { DocumentParseState, DocumentProvenance, DocumentScope,
  StoredAssistantEdit } from "./documentStore";
import type { LibraryKind } from "./normalize";

export type StoredDocumentVersion = {
  id: string; documentId: string; versionNumber: number; source: string; createdAt: string;
  filename: string; fileType: string; sizeBytes: number; pageCount: number | null;
  sourceSha256: string; blobKey: string; pdfBlobKey: string | null; cleanupKeys: string[];
  provenance?: DocumentProvenance;
};
export type StoredDocument = {
  id: string; userId: string; projectId: string | null; libraryKind: LibraryKind;
  folderId: string | null; status: string; currentVersionId: string;
  createdAt: string; updatedAt: string; metadata?: unknown; notes?: string | null;
  parseState?: DocumentParseState | null;
};
export type DocumentAggregate = {
  document: StoredDocument; versions: StoredDocumentVersion[];
  edits: Array<StoredAssistantEdit & { versionId: string }>; isOwner: boolean;
};
export type CreateDocumentMetadata = { document: StoredDocument; version: StoredDocumentVersion };
export type UpdateVersionMetadata = Partial<Pick<StoredDocumentVersion,
  "filename" | "fileType" | "sizeBytes" | "pageCount" | "sourceSha256" | "blobKey" |
  "pdfBlobKey" | "cleanupKeys" | "createdAt">> & { provenance?: DocumentProvenance | null };
type Write = "missing" | "conflict";

export type DocumentRepository = {
  authorizeCreate(scope: DocumentScope, input: { projectId: string | null;
    libraryKind: LibraryKind; folderId: string | null }):
    Promise<"ok" | "project-missing" | "folder-missing" | "folder-unavailable">;
  create(scope: DocumentScope, input: CreateDocumentMetadata): Promise<void>;
  get(scope: DocumentScope, id: string, owner?: boolean): Promise<DocumentAggregate | null>;
  getMany(scope: DocumentScope, ids: string[]): Promise<DocumentAggregate[]>;
  deletionIds(scope: DocumentScope, projectIds: string[], includeOwned: boolean): Promise<string[]>;
  insertVersion(scope: DocumentScope, id: string, input: { expectedCurrentVersionId: string;
    version: StoredDocumentVersion; edits?: StoredAssistantEdit[] }): Promise<"created" | Write>;
  updateVersion(scope: DocumentScope, id: string, input: { versionId: string;
    expectedBlobKey: string; update: UpdateVersionMetadata; edits?: StoredAssistantEdit[];
    resolveEdit?: { id: string; status: StoredAssistantEdit["status"] } }):
    Promise<"updated" | Write>;
  renameVersion(scope: DocumentScope, id: string, versionId: string,
    filename: string): Promise<boolean>;
  deleteVersion(scope: DocumentScope, id: string, input: { versionId: string;
    expectedCurrentVersionId: string; nextCurrentVersionId: string;
    expectedBlobKey: string; expectedPdfBlobKey: string | null;
    expectedCleanupKeys: string[] }): Promise<boolean>;
  deleteDocument(scope: DocumentScope, id: string): Promise<boolean>;
  relocate(scope: DocumentScope, id: string, input: { expectedProjectId: string | null;
    projectId: string | null; folderId: string | null; owner: boolean }):
    Promise<"moved" | Write>;
  updateMetadata(scope: DocumentScope, id: string,
    input: { metadata?: unknown; notes?: string | null }): Promise<boolean>;
  clearCleanup(scope: DocumentScope, id: string, versionId: string, keys: string[]): Promise<void>;
  recordOrphan(scope: DocumentScope, key: string): Promise<void>;
  clearOrphan(scope: "system", key: string): Promise<void>;
  pendingOrphans(scope: "system", limit?: number): Promise<string[]>;
  pendingCleanup(scope: "system", limit?: number): Promise<Array<{ scope: DocumentScope; documentId: string;
    versionId: string; keys: string[] }>>;
};
