import {
  apiRequest,
  segment,
  multipartRequest,
  post,
  pagePath,
  patch,
  remove,
  apiBlobRequest,
  apiFetch,
  mutationInit,
  type PageQuery,
  type Page,
} from "@/app/lib/api/client";

export type DocumentReaderText = { revision: string;
  slices: Array<{ start: number; end: number; text: string; page: number }> };
export const getDocumentReaderText = (id: string, versionId: string, signal?: AbortSignal) =>
  apiRequest<DocumentReaderText>(pagePath(`/single-documents/${segment(id)}/reader-text`,
    { version_id: versionId }), { signal });

export interface Folder {
  id: string;
  name: string;
  parent_folder_id: string | null;
}
export interface LibraryFolder extends Folder {
  library_kind: "file" | "template";
}
export interface Document {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  library_kind?: "file" | "template";
  filename: string;
  owner_email?: string | null;
  owner_display_name?: string | null;
  file_type: string | null; // pdf | docx | doc | xlsx | xlsm | xls | pptx | ppt
  pdf_storage_path: string | null;
  size_bytes: number | null;
  page_count: number | null;
  parse_state?: {
    status: "queued" | "parsing" | "ready" | "degraded" | "failed" | "cancelled";
    phase?: "inspecting" | "extracting" | "ocr";
    pages?: number[];
    page_count?: number;
    error?: string;
  } | null;
  created_at: string | null;
  updated_at?: string | null;
  current_version_id?: string | null;
  current_working_revision?: number | null;
  source_sha256?: string | null;
  active_version_number?: number | null;
}
export interface EditAnnotation {
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
  diff: {
    kind: "equal" | "delete" | "insert";
    text: string;
  }[];
  status: "pending" | "accepted" | "rejected";
}
export type EditResolveStart = {
  editId: string;
  documentId: string;
  verb: "accept" | "reject";
};
export type EditResolved = {
  editId: string;
  documentId: string;
  status: "accepted" | "rejected";
  versionId: string | null;
};
export type EditResolveError = {
  editId: string;
  documentId: string;
  versionId: string | null;
  message: string;
};
export interface EditResolveHandlers {
  onResolveStart?: (args: EditResolveStart) => void;
  onResolved?: (args: EditResolved) => void;
  onError?: (args: EditResolveError) => void;
}
export const getProjectFolder = (projectId: string, folderId: string) =>
  apiRequest<Folder>(`/projects/${segment(projectId)}/folders/${segment(folderId)}`);
export const getLibraryFolder = (folderId: string) =>
  apiRequest<LibraryFolder>(`/library/files/folders/${segment(folderId)}`);
export type LibraryKind = "files" | "templates";
export type DirectoryEntry =
  | { kind: "document"; document: Document }
  | { kind: "folder"; folder: LibraryFolder | Folder };
export type DirectoryList = (
  options?: PageQuery & { parent_id?: string | null },
  signal?: AbortSignal,
) => Promise<Page<DirectoryEntry>>;
export type DirectoryScope =
  | { projectId: string }
  | { library: LibraryKind };
export async function listDirectoryDocuments(
  list: DirectoryList,
  rootFolderId: string | null = null,
) {
  const documents = new Map<string, Document>();
  const seenFolders = new Set(rootFolderId ? [rootFolderId] : []);
  const pending: Array<string | null> = [rootFolderId];
  while (pending.length) {
    const parent_id = pending.pop()!;
    let cursor: string | null = null;
    do {
      const page = await list({ parent_id, cursor, limit: 100 });
      cursor = page.next_cursor;
      for (const entry of page.items) {
        if (entry.kind === "document") documents.set(entry.document.id, entry.document);
        else if (!seenFolders.has(entry.folder.id)) {
          seenFolders.add(entry.folder.id);
          pending.push(entry.folder.id);
        }
      }
    } while (cursor);
  }
  return [...documents.values()];
}
export async function uploadDocumentsSettled(
  files: File[], upload: (file: File) => Promise<Document>,
) {
  const results = new Array<PromiseSettledResult<Document>>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await upload(files[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}
export async function uploadDocuments(files: File[], upload: (file: File) => Promise<Document>) {
  return (await uploadDocumentsSettled(files, upload)).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
export function directoryResource(scope: DirectoryScope) {
  const root = "projectId" in scope
    ? `/projects/${segment(scope.projectId)}`
    : `/library/${scope.library}`;
  const folders = `${root}/folders`;
  const documents = `${root}/documents`;
  const uploadDocument = (file: File, folderId?: string | null) =>
    multipartRequest<Document>(documents, file, {
      ...(folderId ? { fields: { folder_id: folderId } } : {}),
    });
  const createFolder = (name: string, parentFolderId?: string | null) =>
    post<Folder | LibraryFolder>(folders, {
      name,
      parent_folder_id: parentFolderId ?? null,
    });
  const folderIds = new Map<string, string>();
  let uploadedDirectoryFiles = new WeakSet<File>();
  let retryParentFolderId: string | null | undefined;
  const uploadDirectory = async (
    files: File[],
    parentFolderId: string | null = null,
    onProgress?: (completed: number, total: number) => void,
  ) => {
    if (retryParentFolderId !== parentFolderId) {
      folderIds.clear();
      uploadedDirectoryFiles = new WeakSet<File>();
      retryParentFolderId = parentFolderId;
    }
    files = files.filter((file) => !uploadedDirectoryFiles.has(file));
    const paths = files.map((file) => {
      const parts = (file.webkitRelativePath || file.name)
        .split(/[\\/]+/u)
        .filter(Boolean);
      if (parts.some((part) => part === "." || part === ".." || part.length > 200) ||
          parts.length > 21) {
        throw new Error(`Invalid folder path for ${file.name}.`);
      }
      return parts.slice(0, -1);
    });
    const wanted = new Set(paths.flatMap((parts) =>
      parts.map((_part, index) => parts.slice(0, index + 1).join("/"))));
    const pendingFolders = [...wanted].filter((path) => !folderIds.has(path));
    let completed = 0;
    for (const path of pendingFolders.sort((left, right) =>
      left.split("/").length - right.split("/").length || left.localeCompare(right))) {
      const parts = path.split("/");
      const name = parts.pop()!;
      const parentPath = parts.join("/");
      const folder = await createFolder(
        name,
        parentPath ? folderIds.get(parentPath) : parentFolderId,
      );
      folderIds.set(path, folder.id);
      onProgress?.(++completed, pendingFolders.length + files.length);
    }
    const pathByFile = new Map(files.map((file, index) => [file, paths[index]]));
    const documents = await uploadDocuments(files, async (file) => {
      const folderId = folderIds.get(pathByFile.get(file)?.join("/") ?? "") ??
        parentFolderId;
      const document = await uploadDocument(file, folderId);
      uploadedDirectoryFiles.add(file);
      onProgress?.(++completed, pendingFolders.length + files.length);
      return document;
    });
    folderIds.clear();
    uploadedDirectoryFiles = new WeakSet<File>();
    retryParentFolderId = undefined;
    return documents;
  };
  return {
    list: (options: PageQuery & { parent_id?: string | null } = {}, signal?: AbortSignal) =>
      apiRequest<Page<DirectoryEntry>>(pagePath(`${root}${"projectId" in scope ? "/directory" : ""}`, options), { signal }),
    uploadDocument,
    uploadDocuments: (files: File[]) => uploadDocuments(files, uploadDocument),
    createFolder,
    uploadDirectory,
    renameFolder: (folderId: string, name: string) =>
      patch<Folder | LibraryFolder>(`${folders}/${segment(folderId)}`, { name }),
    deleteFolder: (folderId: string) =>
      remove<void>(`${folders}/${segment(folderId)}`),
    moveFolder: (folderId: string, parentFolderId: string | null) =>
      patch<Folder | LibraryFolder>(`${folders}/${segment(folderId)}`, { parent_folder_id: parentFolderId }),
    moveDocument: (documentId: string, folderId: string | null) =>
      patch<Document>(`${documents}/${segment(documentId)}/folder`, { folder_id: folderId }),
    renameDocument: (documentId: string, filename: string) =>
      patch<Document>(`${documents}/${segment(documentId)}`, { filename }),
  };
}
export const retryLibraryPdfParse = (
  kind: LibraryKind,
  documentId: string,
  options: { ocr_provider?: "kraken-lite" | "tesseract"; version_id?: string } = {},
) =>
  post<{ status: string }>(
    `/library/${kind}/documents/${segment(documentId)}/actions/retry-pdf-parse`,
    options,
  );
export const addDocumentToProject = (
  projectId: string,
  documentId: string,
) => post<Document>(`/projects/${segment(projectId)}/documents/${segment(documentId)}`);
export const removeProjectDocument = (projectId: string, documentId: string) =>
  remove<void>(`/projects/${segment(projectId)}/documents/${segment(documentId)}`);
export interface DocumentVersion {
  id: string;
  version_number: number;
  working_revision: number;
  created_by: string | null;
  author_email?: string;
  comment: string | null;
  parent_version_id: string | null;
  source: string;
  source_sha256: string;
  created_at: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  page_count: number | null;
  provenance?: { actor?: string; action?: string; change_count?: number; receipt?: {
    workProduct?: { kind?: string };
  } } | null;
}
export const listDocumentVersions = (documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocumentVersion[];
}> => apiRequest(`/single-documents/${segment(documentId)}/versions`);
export const uploadDocumentVersion = (
  documentId: string,
  file: File,
  expectedCurrentVersionId: string,
  expectedWorkingRevision: number,
) => multipartRequest<DocumentVersion>(
  `/single-documents/${segment(documentId)}/versions`, file, {
    fields: { expected_current_version_id: expectedCurrentVersionId,
      expected_working_revision: String(expectedWorkingRevision) } },
);
export const restoreDocumentVersion = (
  documentId: string,
  versionId: string,
  expectedCurrentVersionId: string,
  expectedWorkingRevision: number,
) => post<DocumentVersion>(
  `/single-documents/${segment(documentId)}/versions/${segment(versionId)}/restore`,
  { expected_current_version_id: expectedCurrentVersionId,
    expected_working_revision: expectedWorkingRevision },
);
export const checkpointDocumentVersion = (documentId: string,
  expectedCurrentVersionId: string, expectedWorkingRevision: number, comment?: string) =>
  post<DocumentVersion>(`/single-documents/${segment(documentId)}/versions/checkpoint`, {
    expected_current_version_id: expectedCurrentVersionId,
    expected_working_revision: expectedWorkingRevision, comment,
  });
export const compareDocumentVersions = (
  documentId: string,
  baselineVersionId: string,
  versionId: string,
) => apiBlobRequest(pagePath(
  `/single-documents/${segment(documentId)}/versions/${segment(versionId)}/compare`,
  { baseline_version_id: baselineVersionId },
));
export const uploadStandaloneDocument = (file: File) =>
  multipartRequest<Document>("/single-documents", file);
/** Every library file, folders flattened, so one list answers "which of my files is this?". */
export const listLibraryDocuments = (options: PageQuery = {}, signal?: AbortSignal) =>
  apiRequest<Page<Document>>(pagePath("/single-documents", options), { signal });
export const getDocument = (documentId: string) =>
  apiRequest<Document>(`/single-documents/${segment(documentId)}`);
export const getDocumentParseStates = async (documentIds: string[]) => {
  const ids = [...new Set(documentIds)], states = [];
  for (let index = 0; index < ids.length; index += 100) {
    states.push(...await post<Array<Pick<Document, "id" | "parse_state" | "page_count">>>(
      "/single-documents/parse-states", { document_ids: ids.slice(index, index + 100) }));
  }
  return states;
};
export const deleteDocument = (document: Document) =>
  remove<void>(`/single-documents/${segment(document.id)}`, {
    expected_current_version_id: document.current_version_id,
    expected_working_revision: document.current_working_revision,
    expected_project_id: document.project_id,
    expected_folder_id: document.folder_id ?? null,
  });
const documentFilePath = (documentId: string, versionId?: string | null, rendition?: "pdf") =>
  pagePath(`/single-documents/${segment(documentId)}/file`, { rendition, version_id: versionId });
export const readDocumentFile = (documentId: string, versionId?: string | null, original = false, signal?: AbortSignal) =>
  apiFetch(documentFilePath(documentId, versionId, original ? undefined : "pdf"), {
    cache: "default", headers: { Accept: "*/*" }, signal,
  });
export const downloadDocument = (documentId: string, versionId?: string | null) =>
  apiBlobRequest(documentFilePath(documentId, versionId));
export const downloadDocumentPdf = (documentId: string, versionId?: string | null) =>
  apiBlobRequest(documentFilePath(documentId, versionId, "pdf"));
type DocumentEditResolution = {
  status?: "accepted" | "rejected";
  version_id: string | null;
  download_url: string | null;
};
export const resolveDocumentEdits = (
  documentId: string, editIds: string[], verb: "accept" | "reject",
) => post<DocumentEditResolution>(
  `/single-documents/${segment(documentId)}/edits/${verb}`, { edit_ids: editIds },
);
export type SpreadsheetProjection = {
  version_id: string;
  sheets: Array<{
    name: string;
    cells: Array<{
      address: string;
      value: string;
      row: number;
      column: number;
      rowSpan?: number;
      columnSpan?: number;
    }>;
  }>;
};
export const getSpreadsheetProjection = (
  documentId: string,
  versionId?: string | null,
) => apiRequest<SpreadsheetProjection>(
  pagePath(`/single-documents/${segment(documentId)}/spreadsheet`, {
    version_id: versionId,
  }),
);
export const downloadDocumentsZip = async (documentIds: string[]): Promise<Blob> =>
  (await apiBlobRequest(
    "/single-documents/download-zip",
    mutationInit("POST", { document_ids: documentIds }),
  )).blob;
