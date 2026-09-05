import type { DocumentHeadExpectation, DocumentParseState, DocumentProvenance, DocumentScope,
  PdfProfileSelection, StoredAssistantEdit } from "./documentStore";
import type { LibraryKind } from "./normalize";

export type StoredDocumentVersion = {
  id: string; documentId: string; parentVersionId: string | null;
  versionNumber: number; workingRevision: number; source: string; createdAt: string;
  createdBy: string | null; authorEmail?: string; comment: string | null;
  filename: string; fileType: string; sizeBytes: number; pageCount: number | null;
  sourceSha256: string; blobKey: string; pdfBlobKey: string | null;
  pdfProfile?: PdfProfileSelection;
  provenance?: DocumentProvenance;
};
export type StoredDocumentPart = {
  documentId: string; versionId: string; name: string; sizeBytes: number;
  sha256: string; blobKey: string;
};
export type StoredPartChanges = { put: StoredDocumentPart[]; remove: string[] };
export type StoredDocument = {
  id: string; userId: string; projectId: string | null; libraryKind: LibraryKind;
  folderId: string | null; status: string; currentVersionId: string;
  createdAt: string; updatedAt: string; metadata?: unknown; notes?: string | null;
  parseState?: DocumentParseState | null;
};
export type DocumentAggregate = {
  document: StoredDocument; versions: StoredDocumentVersion[];
  edits: Array<StoredAssistantEdit & { versionId: string }>;
};
export type DocumentHead = Pick<DocumentAggregate, "document"> & {
  versions: [StoredDocumentVersion];
};
export type CreateDocumentMetadata = { document: StoredDocument; version: StoredDocumentVersion;
  parts?: StoredDocumentPart[] };
export type UpdateVersionMetadata = Partial<Pick<StoredDocumentVersion,
  "filename" | "fileType" | "sizeBytes" | "pageCount" | "sourceSha256" | "blobKey" |
  "pdfBlobKey" | "createdAt">> & { provenance?: DocumentProvenance | null };
type Write = "missing" | "conflict";

export type DocumentRepository = {
  authorizeCreate(scope: DocumentScope, input: { projectId: string | null;
    libraryKind: LibraryKind; folderId: string | null }):
    Promise<"ok" | "project-missing" | "folder-missing">;
  create(scope: DocumentScope, input: CreateDocumentMetadata): Promise<boolean>;
  head(scope: DocumentScope, id: string, owner?: boolean): Promise<DocumentHead | null>;
  get(scope: DocumentScope, id: string, owner?: boolean): Promise<DocumentAggregate | null>;
  version(scope: DocumentScope, id: string, versionId: string | null):
    Promise<StoredDocumentVersion | null>;
  currentVersions(scope: DocumentScope, ids: string[]): Promise<StoredDocumentVersion[]>;
  parts(scope: DocumentScope, id: string, versionId: string | null, names: string[]):
    Promise<StoredDocumentPart[] | null>;
  hasPendingEdits(scope: DocumentScope, id: string, versionIds: string[]): Promise<boolean>;
  history(scope: DocumentScope, id: string, includeParts?: boolean): Promise<{
    currentVersionId: string; versions: StoredDocumentVersion[]; parts?: StoredDocumentPart[] } | null>;
  parseStates(scope: DocumentScope, ids: string[]): Promise<Array<{
    id: string; parseState: DocumentParseState | null;
  }>>;
  deleteDocuments(scope: DocumentScope, projectIds: string[], includeOwned: boolean): Promise<number>;
  insertVersion(scope: DocumentScope, id: string, input: { expectedCurrentVersionId: string;
    expectedCurrentWorkingRevision: number;
    expectedProjectId?: string | null; expectedFolderId?: string | null;
    version: StoredDocumentVersion; edits?: StoredAssistantEdit[];
    clonePartsFromVersionId?: string; parts?: StoredPartChanges }): Promise<"created" | Write>;
  updateVersion(scope: DocumentScope, id: string, input: { versionId: string;
    expectedBlobKey: string; expectedPdfBlobKey?: string | null;
    expectedWorkingRevision: number; expectedCurrentVersionId?: string;
    bumpWorkingRevision?: boolean;
    update: UpdateVersionMetadata; edits?: StoredAssistantEdit[];
    parts?: StoredPartChanges;
    resolveEdits?: { ids: string[]; status: StoredAssistantEdit["status"] } }):
    Promise<"updated" | Write>;
  recordPdfPreparation(scope: DocumentScope, id: string, input: { versionId: string;
    sourceSha256: string; pageCount: number; pdfProfile: PdfProfileSelection }): Promise<boolean>;
  deleteVersion(scope: DocumentScope, id: string, input: { versionId: string;
    expectedCurrentVersionId: string; nextCurrentVersionId: string;
    expectedBlobKey: string; expectedPdfBlobKey: string | null;
    expectedWorkingRevision: number; expectedProjectId: string | null;
    expectedFolderId: string | null }): Promise<boolean>;
  deleteDocument(scope: DocumentScope, id: string, owner?: boolean,
    expected?: DocumentHeadExpectation): Promise<boolean>;
  relocate(scope: DocumentScope, id: string, input: { expectedProjectId: string | null;
    expectedFolderId: string | null;
    projectId: string | null; folderId: string | null; owner: boolean;
    versions: Array<{ versionId: string; expectedBlobKey: string; blobKey: string;
      expectedPdfBlobKey: string | null; pdfBlobKey: string | null }>;
    parts: Array<{ versionId: string; name: string; expectedBlobKey: string; blobKey: string }> }):
    Promise<DocumentHead | Write>;
  updateMetadata(scope: DocumentScope, id: string,
    input: { metadata?: unknown; notes?: string | null }): Promise<boolean>;
  recordOrphans(keys: string[]): Promise<"staged" | "busy">;
  removeOrphan(key: string, claimId: string, remove: () => Promise<void>): Promise<boolean>;
  pendingOrphans(limit?: number):
    Promise<Array<{ key: string; claimId: string }>>;
};
