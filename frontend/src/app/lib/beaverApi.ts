import type {
  Chat,
  ColumnConfig,
  Document,
  Folder,
  LibraryFolder,
  Project,
  TabularCell,
  Workflow,
  TabularReview,
} from "@/app/components/shared/types";
import type { AssistantTranscriptMessage } from "@/app/lib/assistantSession";
import type {
  WorkProduct,
  WorkProductBuildReceipt,
  WorkProductCreate,
  WorkProductKind,
  WorkProductMetadata,
  WorkProductPatch,
  WorkProductResolution,
} from "@/app/lib/workProducts";
import type {
  AuthoritiesAction,
  AuthoritiesBuildSettings,
  AuthoritiesBuildReceipt,
  AuthoritiesDiscrepancy,
  AuthoritiesDiscrepancyAction,
  AuthoritiesOutputMode,
  AuthoritiesProduct,
  AuthoritiesProfileId,
  AuthoritySourceLanguage,
} from "@/app/authorities/types";
import type {
  ResearchAction,
  ResearchActionResult,
  ResearchFile,
  ResearchPageItem,
  ResearchQueryInput,
  ResearchQueryResult,
} from "@/app/lib/researchFiles";
import { newResearchState, researchMarkdown } from "@/app/lib/researchFiles";
import { apiBlobRequest, apiFetch, apiRequest, responseError } from "./apiTransport";
const segment = (value: string | number) => encodeURIComponent(String(value));
const JSON_HEADERS = { "Content-Type": "application/json" };
function mutationInit(method: RequestInit["method"], body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
const post = <T>(path: string, body?: unknown) => apiRequest<T>(path, mutationInit("POST", body));
const patch = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PATCH", body));
const put = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PUT", body));
const remove = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, mutationInit("DELETE", body));
function multipartRequest<T>(
  path: string, file: File,
  options?: { method?: string; filename?: string; fields?: Record<string, string> },
) {
  const form = new FormData();
  form.append("file", file);
  if (options?.filename) form.append("filename", options.filename);
  for (const [name, value] of Object.entries(options?.fields ?? {})) {
    form.append(name, value);
  }
  return apiRequest<T>(path, {
    method: options?.method ?? "POST",
    body: form,
  });
}
function streamRequest(
  path: string, body: unknown,
  options?: {
    signal?: AbortSignal; accept?: string; allowStatuses?: number[];
  },
) {
  return apiFetch(path, {
    ...mutationInit("POST", body),
    headers: {
      ...JSON_HEADERS,
      Accept: options?.accept ?? "application/json",
    },
    signal: options?.signal,
  }).then(async (response) => {
    if (!response.ok && !options?.allowStatuses?.includes(response.status)) {
      throw await responseError(response);
    }
    return response;
  });
}
export type Page<T> = { items: T[]; next_cursor: string | null };
type PageQuery = { q?: string; cursor?: string | null; limit?: number };
function pagePath(path: string, query: object = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}
export const listProjects = (options: PageQuery & {
  scope?: "all" | "mine" | "shared-with-me";
} = {}, signal?: AbortSignal) => apiRequest<Page<Project>>(
  pagePath("/projects", options), { signal },
);
export const createProject = (
  name: string, cm_number?: string, practice?: string, shared_with?: string[],
) => post<Project>("/projects", {
  name, cm_number, practice, shared_with,
});
export const deleteAccount = () => remove<void>("/user/account");
export const deleteAllChats = () => remove<void>("/user/chats");
export const deleteAllProjects = () => remove<void>("/user/projects");
export const deleteAllTabularReviews = () => remove<void>("/user/tabular-reviews");
export const exportAccountData = () => apiBlobRequest("/user/export");
export const exportChatData = () => apiBlobRequest("/user/chats/export");
export const exportTabularReviewsData = () => apiBlobRequest("/user/tabular-reviews/export");
export interface AuditEvent {
  id: string;
  created_at: string;
  action: string;
  status: "completed" | "cancelled" | "failed";
  title: string | null;
  surface: string | null;
}
export interface AuditHistoryQuery {
  q?: string;
  action?: string;
  status?: string;
  page?: number;
}
export const getAuditHistory = (query: AuditHistoryQuery, signal?: AbortSignal) =>
  apiRequest<{ events: AuditEvent[]; total: number; page: number; pageSize: number }>(
    pagePath("/audit", query),
    { signal },
  );
export const exportAuditHistory = (query: AuditHistoryQuery) =>
  apiBlobRequest(pagePath("/audit/export", query));
export type DraftingDocumentType = "memo" | "factum" | "letter" | "other";
export type DraftingCitationPlacement =
  | "footnotes"
  | "inline"
  | "after-paragraph"
  | "none";
export interface DraftingStyleSettings {
  version: 1;
  documents: Record<DraftingDocumentType, {
    citationPlacement: DraftingCitationPlacement;
    citationHyperlinks: boolean;
    numberHeadings: boolean | "auto";
  }>;
  memoHeader: { to: string; from: string };
}
export interface UserProfile {
  displayName: string | null; organisation: string | null;
  practiceSetting: string | null; professionalTitle: string | null;
  practiceAreas: string[];
  jurisdictionPreference: {
    mode: "ask" | "presume"; jurisdictions: string[];
  };
  onboardingCompleted: boolean;
  titleModel: string; tabularModel: string;
  lastSelectedChatModel: string | null;
  lastSelectedReasoningEffort: string | null;
  mfaOnLogin: boolean; legalResearchUs: boolean;
  features: { authorities: boolean };
  workflowFileTargets: WorkflowFileTargets;
  filingContact: FilingContact;
  draftingStyle: DraftingStyleSettings;
  apiKeyStatus: ApiKeyStatus;
}
export type FilingContact = {
  name: string; address: string; phone: string; fax: string; email: string;
};
export type WorkflowFileTarget =
  | { kind: "library"; folderId: string }
  | { kind: "project"; projectId: string; folderId: string };
export type WorkflowFileTargets = {
  "court-records": WorkflowFileTarget | null;
  authorities: WorkflowFileTarget | null;
};
export interface UserLookupResult {
  exists: boolean; email: string; display_name: string | null;
}
export interface ModelCatalog {
  models: {
    slug: string; displayName: string; defaultReasoningLevel?: string;
    supportedReasoningLevels: { effort: string }[];
  }[];
  ollama?: {
    source: "live" | "unavailable";
    models: {
      name: string; displayName: string; supportsThinking?: boolean;
    }[];
  };
  openCodeGo?: {
    source: "live" | "unavailable";
    models: { id: string; displayName: string }[];
  };
  readSubagents?: {
    serverEnabled: boolean;
  };
}
export const getModelCatalog = () => apiRequest<ModelCatalog>("/models");
export const getUserProfile = () => apiRequest<UserProfile>("/user/profile");
export const lookupUserByEmail = (email: string) =>
  apiRequest<UserLookupResult>(`/user/lookup?email=${segment(email)}`);
export const updateUserProfile = (
  payload: Partial<Pick<UserProfile,
    "displayName" | "organisation" | "practiceSetting" | "professionalTitle" |
    "practiceAreas" | "jurisdictionPreference" | "onboardingCompleted" |
    "titleModel" | "tabularModel" | "lastSelectedChatModel" |
    "lastSelectedReasoningEffort" | "legalResearchUs" | "features" |
    "workflowFileTargets" | "filingContact" | "draftingStyle">>,
) => patch<UserProfile>("/user/profile", payload);
export const updateUserMfaOnLogin = (enabled: boolean) =>
  patch<UserProfile>("/user/security/mfa-login", { enabled });
export type ApiKeyProvider =
  | "claude" | "gemini" | "openai" | "deepseek" | "openrouter" | "opencode-go" | "meta"
  | "courtlistener";
type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<ApiKeyProvider, {
  configured: boolean; source: ApiKeySource;
}>;
type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources: Record<ApiKeyProvider, ApiKeySource>;
};
export const saveApiKey = (provider: ApiKeyProvider, apiKey: string | null) =>
  put<ApiKeyStatus>(`/user/api-keys/${segment(provider)}`, { api_key: apiKey });
interface McpToolSummary {
  id: string; toolName: string; title: string | null;
  enabled: boolean; requiresConfirmation: boolean;
}
export interface McpConnectorSummary {
  id: string; name: string; serverUrl: string;
  enabled: boolean; hasAuthConfig: boolean;
  tools: McpToolSummary[]; toolCount: number;
}
type McpConnectorInput = {
  name: string; serverUrl: string; bearerToken?: string | null; headers?: Record<string, string>;
};
export const listMcpConnectors = () =>
  apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
export const getMcpConnector = (connectorId: string) =>
  apiRequest<McpConnectorSummary>(`/user/mcp-connectors/${segment(connectorId)}`);
export const createMcpConnector = (payload: McpConnectorInput) =>
  post<McpConnectorSummary>("/user/mcp-connectors", payload);
export const updateMcpConnector = (
  connectorId: string, payload: Partial<McpConnectorInput> & { enabled?: boolean },
) => patch<McpConnectorSummary>(`/user/mcp-connectors/${segment(connectorId)}`, payload);
export const deleteMcpConnector = (connectorId: string) =>
  remove<void>(`/user/mcp-connectors/${segment(connectorId)}`);
export const refreshMcpConnectorTools = (connectorId: string) =>
  post<McpConnectorSummary>(`/user/mcp-connectors/${segment(connectorId)}/refresh-tools`);
export const startMcpConnectorOAuth = (connectorId: string) =>
  post<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
  }>(`/user/mcp-connectors/${segment(connectorId)}/oauth/start`);
export const setMcpToolEnabled = (
  connectorId: string,
  toolId: string,
  enabled: boolean,
) => patch<McpConnectorSummary>(
  `/user/mcp-connectors/${segment(connectorId)}/tools/${segment(toolId)}`, { enabled },
);
export const getProject = (projectId: string) => apiRequest<Project>(`/projects/${segment(projectId)}`);
export const getProjectFolder = (projectId: string, folderId: string) =>
  apiRequest<Folder>(`/projects/${segment(projectId)}/folders/${segment(folderId)}`);
export const getLibraryFolder = (folderId: string) =>
  apiRequest<LibraryFolder>(`/library/files/folders/${segment(folderId)}`);
export const updateProject = (
  projectId: string,
  payload: Partial<Pick<
    Project,
    "name" | "cm_number" | "practice" | "shared_with"
  >>,
) => patch<Project>(`/projects/${segment(projectId)}`, payload);
export const deleteProject = (projectId: string) =>
  remove<void>(`/projects/${segment(projectId)}`);
export interface ProjectPeople {
  owner: { email: string | null; display_name: string | null };
  members: { email: string; display_name: string | null }[];
}
export const getProjectPeople = (projectId: string) =>
  apiRequest<ProjectPeople>(`/projects/${segment(projectId)}/people`);
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
export type LegalDocumentType = "cases" | "laws" | "articles";
export type LegalSearchDocumentType = LegalDocumentType | "hansard";
export interface LegalSourceSearchResult {
  provider: "a2aj" | "journal" | "hansard";
  doc_type: LegalSearchDocumentType;
  source_id?: string | null;
  language: "en" | "fr";
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
  url: string | null;
  snippet: string | null;
}
export interface LegalSourceCoverage {
  dataset: string;
  description: string;
  docType: "cases" | "laws";
  jurisdictionCode: string;
  jurisdiction: string;
  sourceKind: "court" | "tribunal" | "legislation" | "regulation";
}
export interface LegalSourceViewerPayload {
  reference: {
    docType: LegalDocumentType;
    provider: string;
    id: string;
    kind: "case" | "legislation" | "journal" | "hansard";
    citation: string;
    language: "en" | "fr";
    dataset: string | null;
    sourceSha256: string;
  };
  metadata: {
    title: string;
    citation: string;
    alternateCitation: string | null;
    date: string | null;
    url: string | null;
    language: "en" | "fr";
    pdfUrl?: string | null;
  };
  slices: {
    start: number;
    end: number;
    text: string;
    depth: number;
    anchors: LegalSourceViewerAnchor[];
    primary: LegalSourceViewerAnchor | null;
  }[];
  truncated: boolean;
}
interface LegalSourceViewerAnchor {
  kind: "paragraph" | "page" | "section" | "footnote";
  label: string;
  start: number;
  end: number;
  parentLabel?: string;
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
export const getLegalSourceCoverage = async () =>
  (await apiRequest<{ coverage: LegalSourceCoverage[] }>("/sources/coverage")).coverage;
export const searchLegalSources = async (args: {
  query: string;
  docType: LegalSearchDocumentType;
  language?: "en" | "fr";
  datasets?: string[];
  author?: string;
  journal?: string;
  speaker?: string;
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}): Promise<LegalSourceSearchResult[]> => {
  return (
    await apiRequest<{ results: LegalSourceSearchResult[] }>(
      pagePath("/sources/search", {
        query: args.query,
        doc_type: args.docType,
        language: args.language ?? "en",
        dataset: args.datasets?.join(","),
        author: args.author,
        journal: args.journal,
        speaker: args.speaker,
        start_date: args.startDate,
        end_date: args.endDate,
        sort_results:
          args.sortResults === "default" ? undefined : args.sortResults,
      }),
    )
  ).results;
};
const legalSourceDocumentRequests = new Map<
  string,
  Promise<LegalSourceViewerPayload>
>();
export const clearApiCaches = () => legalSourceDocumentRequests.clear();
async function cachedLegalSourceDocument(path: string) {
  const cached = legalSourceDocumentRequests.get(path);
  if (cached) return cached;
  const request = apiRequest<LegalSourceViewerPayload>(path, {
    cache: "default",
  });
  legalSourceDocumentRequests.set(path, request);
  void request.finally(() => {
    if (legalSourceDocumentRequests.get(path) === request)
      legalSourceDocumentRequests.delete(path);
  }).catch(() => undefined);
  return request;
}
export const getLegalSourceDocument = (referenceId: string) =>
  cachedLegalSourceDocument(`/sources/${segment(referenceId)}/document`);
export const getDirectLegalSourceDocument = (args: {
  provider: "a2aj" | "journal";
  citation: string;
  sourceId?: string | null;
  docType?: LegalDocumentType | "auto";
  language?: "en" | "fr";
  dataset?: string | null;
}) => {
  return cachedLegalSourceDocument(pagePath("/sources/document", {
    citation: args.citation,
    provider: args.provider,
    doc_type: args.docType ?? "auto",
    language: args.language ?? "en",
    dataset: args.dataset,
    source_id: args.sourceId,
  }));
}
export type DeterministicDocxActionResult = {
  ok: boolean;
  document_id: string;
  version_id: string;
  filename: string;
  detected?: number;
  converted?: number;
  already_linked?: number;
  review_required?: number;
  linked_citations?: number;
  unresolved_citations?: number;
};
export const inspectDocxWorkflowCapabilities = (documentId: string) =>
  apiRequest<{ supra_references: boolean }>(
    `/library/files/documents/${segment(documentId)}/workflow-capabilities`,
  );
export const fixLibraryDocxSupras = (documentId: string) =>
  post<DeterministicDocxActionResult>(
    `/library/files/documents/${segment(documentId)}/actions/fix-supras`,
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
export const uploadCourtRecordDocument = (file: File, workProductId?: string) =>
  multipartRequest<Document>("/court-records/documents", file,
    workProductId ? { fields: { work_product_id: workProductId } } : undefined);
export const saveCourtRecordBuild = <State>(artifacts: Array<{
  file: File; receipt: WorkProductBuildReceipt;
}>) => {
  const body = new FormData();
  for (const { file, receipt } of artifacts) {
    body.append("files", file);
    body.append("receipts", JSON.stringify(receipt));
  }
  return apiRequest<WorkProduct<State>>("/court-records/builds", { method: "POST", body });
};
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
export const downloadDocument = (
  documentId: string,
  versionId?: string | null,
) => apiBlobRequest(
  pagePath(`/single-documents/${segment(documentId)}/file`, { version_id: versionId }),
);
export const downloadDocumentPdf = (documentId: string, versionId?: string | null) =>
  apiBlobRequest(pagePath(`/single-documents/${segment(documentId)}/file`, {
    version_id: versionId,
    rendition: "pdf",
  }));
export type CourtRecordPreparation = {
  document_id: string;
  version_id: string;
  source_sha256: string;
  page_count: number;
  parser_status: "ready" | "degraded";
  pages: Array<{ page_number: number; text: string }>;
};
export const getCourtRecordPreparation = (
  documentId: string,
  versionId?: string | null,
) => apiRequest<CourtRecordPreparation>(
  pagePath(`/court-records/documents/${segment(documentId)}/preparation`, {
    version_id: versionId,
  }),
);
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
export const createChat = (payload?: {
  project_id?: string;
  tabular_review_id?: string;
}) => post<{ id: string }>("/chat/create", payload ?? {});
export const listChats = (options?: {
  limit?: number;
  tabular_review_id?: string;
}) => apiRequest<Chat[]>(pagePath("/chat", options ?? {}));
export const listProjectChats = (projectId: string) =>
  apiRequest<Chat[]>(`/projects/${segment(projectId)}/chats`);
type ChatDetail = { chat: Chat; messages: AssistantTranscriptMessage[] };
export function getChat(chatId: string): Promise<ChatDetail>;
export function getChat(chatId: string, afterVersion: number): Promise<ChatDetail | undefined>;
export function getChat(chatId: string, afterVersion?: number) {
  return apiRequest<ChatDetail | undefined>(
    pagePath(`/chat/${segment(chatId)}`, { after_version: afterVersion }));
}
export const renameChat = (chatId: string, title: string) =>
  patch<void>(`/chat/${segment(chatId)}`, { title });
export const updateChatProject = (
  chatId: string,
  projectId: string | null,
) => patch<{ id: string; title: string | null; project_id: string | null }>(
  `/chat/${segment(chatId)}`, { project_id: projectId },
);
export const deleteChat = (chatId: string) => remove<void>(`/chat/${segment(chatId)}`);
export const listDeletedChats = () => apiRequest<Chat[]>("/chat/recycling-bin");
export const restoreChat = (chatId: string) => post<void>(`/chat/${segment(chatId)}/restore`);
export const permanentlyDeleteChat = (chatId: string) =>
  remove<void>(`/chat/${segment(chatId)}/permanent`);
export const stopChat = (chatId: string) =>
  post<{ stopped: boolean }>(`/chat/${segment(chatId)}/stop`);
export const stopChatJob = (jobId: string) =>
  post<{ stopped: boolean }>(`/chat/jobs/${segment(jobId)}/stop`);
export const submitChatClientToolResult = (
  jobId: string,
  callId: string,
  result: unknown,
) => post<void>(`/chat/jobs/${segment(jobId)}/tool-result`, { callId, result });
export const streamActiveChat = (chatId: string, signal: AbortSignal) =>
  apiFetch(`/chat/${segment(chatId)}/stream`, {
    headers: { Accept: "text/event-stream" }, signal,
  });
export const streamChatJob = (jobId: string, signal: AbortSignal) =>
  apiFetch(`/chat/jobs/${segment(jobId)}/stream`, {
    headers: { Accept: "text/event-stream" }, signal,
  });
export const steerChat = (chatId: string, id: string, text: string) =>
  post<{ steered: true }>(`/chat/${segment(chatId)}/steer`, { id, text });
export const compactChat = (chatId: string, model: string) =>
  post<{ compacted: true; transcriptVersion?: number }>(
    `/chat/${segment(chatId)}/compact`,
    { model },
  );
export const generateChatTitle = (chatId: string, message: string) =>
  post<{ title: string }>(`/chat/${segment(chatId)}/generate-title`, { message });
type StreamCurrentTurn =
  | {
      kind: "message";
      turn_id?: string;
      content: string;
      files?: { document_id: string }[];
      workflow?: { id: string };
    }
  | {
      kind: "ask_inputs_response";
      responses: (
        | { id: string; kind: "choice"; answer?: string }
        | { id: string; kind: "documents"; documents: { document_id: string }[] }
      )[];
    };
export const streamChat = (payload: {
  current_turn: StreamCurrentTurn;
  expected_version: number;
  chat_id?: string;
  project_id?: string;
  tabular_review_id?: string;
  model?: string;
  reasoning_effort?: string;
  edit_mode?: "manual" | "auto";
  jurisdiction_preference?: {
    mode: "ask" | "presume";
    jurisdictions: string[];
  };
  subagent_mode?: "none" | "beaver" | "native";
  subagent_model?: string;
  subagent_effort?: string;
  activity_detail?: "auto" | "standard" | "tools" | "trace";
  time_zone?: string;
  displayed_doc?: { document_id: string };
  word_context?: { document_name: string };
  work_product?: { kind: WorkProductKind; id: string; revision: number;
    focus?: { item_id: string; selection?: { start: number; end: number } } };
  signal?: AbortSignal;
}) => {
  const { signal, ...body } = payload;
  return streamRequest("/chat", body, {
    signal, accept: "text/event-stream", allowStatuses: [409],
  });
};
export const listTabularReviews = (options: PageQuery & {
  project_id?: string | null;
  scope?: "all" | "in-project" | "standalone";
} = {}, signal?: AbortSignal) => apiRequest<Page<TabularReview>>(
  pagePath("/tabular-review", options), { signal },
);
export const createTabularReview = (payload: {
  title?: string;
  document_ids: string[];
  columns_config: ColumnConfig[];
  workflow_id?: string;
  project_id?: string;
}) => post<TabularReview>("/tabular-review", payload);
export const getTabularReview = (reviewId: string) =>
  apiRequest<{ review: TabularReview; cells: TabularCell[]; documents: Document[] }>(
    `/tabular-review/${segment(reviewId)}`,
  );
export const updateTabularReview = (
  reviewId: string,
  payload: {
    title?: string;
    columns_config?: ColumnConfig[];
    document_ids?: string[];
    workflow_id?: string | null;
    project_id?: string | null;
    shared_with?: string[];
  },
) => patch<TabularReview>(`/tabular-review/${segment(reviewId)}`, payload);
export const getTabularReviewPeople = (reviewId: string) =>
  apiRequest<ProjectPeople>(`/tabular-review/${segment(reviewId)}/people`);
export const generateTabularColumnPrompt = (
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
) => post<{ prompt: string }>(
  "/tabular-review/prompt",
  {
    title,
    format: options?.format,
    documentName: options?.documentName,
    tags: options?.tags,
  },
);
export const deleteTabularReview = (reviewId: string) =>
  remove<void>(`/tabular-review/${segment(reviewId)}`);
export const exportTabularReview = (reviewId: string) =>
  apiBlobRequest(`/tabular-review/${segment(reviewId)}/export`);
export const startTabularGeneration = (
  reviewId: string,
  options?: { model?: string; reasoningEffort?: string },
) => post<{ job_ids: string[]; queued: number }>(
  `/tabular-review/${segment(reviewId)}/generate`, {
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const stopTabularGeneration = (reviewId: string) =>
  post<{ stopped: boolean }>(`/tabular-review/${segment(reviewId)}/stop`);
export const regenerateTabularCell = (
  reviewId: string,
  documentId: string,
  columnIndex: number,
  options?: { model?: string; reasoningEffort?: string },
): Promise<{ job_id: string; queued: true }> => post(
  `/tabular-review/${segment(reviewId)}/regenerate-cell`, {
  document_id: documentId,
  column_index: columnIndex,
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const clearTabularCells = (reviewId: string, documentIds: string[]) =>
  post<void>(`/tabular-review/${segment(reviewId)}/clear-cells`, {
    document_ids: documentIds,
  });
const workflowLists = new Map<string, Promise<Workflow[]>>();
export const listWorkflows = (options: {
  audience?: "general" | "solicitor" | "litigator" | "all";
  q?: string;
} = {}, signal?: AbortSignal) => {
  const path = pagePath("/workflows", options);
  if (signal) return apiRequest<Workflow[]>(path, { signal });
  const pending = workflowLists.get(path);
  if (pending) return pending;
  const request = apiRequest<Workflow[]>(path).catch((error) => {
    workflowLists.delete(path);
    throw error;
  });
  workflowLists.set(path, request);
  return request;
};
const refreshWorkflowLists = <T>(request: Promise<T>) => request.then((result) => {
  workflowLists.clear();
  return result;
});
export const getWorkflow = (workflowId: string) =>
  apiRequest<Workflow>(`/workflows/${segment(workflowId)}`);
export const createWorkflow = (payload: {
  metadata: {
    title: string;
    category: string;
    audiences: Workflow["metadata"]["audiences"];
    language?: string | null;
    jurisdictions?: string[] | null;
  };
  launcher: {
    kind: "instructions";
    variants: Array<{
      label: string;
      result?: string | null;
      execution: "assistant" | "tabular";
      skill_md?: string | null;
      columns_config?: ColumnConfig[] | null;
    }>;
  };
}) => refreshWorkflowLists(post<Workflow>("/workflows", payload));
export const updateWorkflow = (
  workflowId: string,
  payload: {
    metadata?: Partial<Pick<
      Workflow["metadata"],
      "title" | "category" | "audiences" | "jurisdictions"
    >> & { language?: string | null };
    launcher?: Parameters<typeof createWorkflow>[0]["launcher"];
  },
) => refreshWorkflowLists(patch<Workflow>(`/workflows/${segment(workflowId)}`, payload));
export const deleteWorkflow = (workflowId: string) =>
  refreshWorkflowLists(remove<void>(`/workflows/${segment(workflowId)}`));
export const shareWorkflow = (
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
) => post<void>(`/workflows/${segment(workflowId)}/share`, payload);
export const listWorkflowShares = (workflowId: string) =>
  apiRequest<{
    id: string; shared_with_email: string;
  }[]>(`/workflows/${segment(workflowId)}/shares`);
export const deleteWorkflowShare = (workflowId: string, shareId: string) =>
  remove<void>(`/workflows/${segment(workflowId)}/shares/${segment(shareId)}`);

export const listWorkProducts = <State>(kind: WorkProductKind, projectId?: string) =>
  apiRequest<WorkProduct<State>[]>(pagePath("/work-products", {
    kind,
    project_id: projectId,
    limit: 100,
  }));
export const listWorkProductMetadata = (kind: WorkProductKind, projectId?: string) =>
  apiRequest<WorkProductMetadata[]>(pagePath("/work-products", {
    kind, project_id: projectId, metadata: true,
  }));
export const getWorkProduct = <State>(id: string) =>
  apiRequest<WorkProduct<State>>(`/work-products/${segment(id)}`);
export const getWorkProductResolution = <State>(id: string) =>
  apiRequest<WorkProductResolution<State>>(`/work-products/${segment(id)}/resolution`);
export const createWorkProduct = <State>(input: WorkProductCreate<State>) =>
  post<WorkProduct<State>>("/work-products", {
    kind: input.kind,
    title: input.title,
    project_id: input.projectId,
    state: input.state,
  });
export const updateWorkProduct = <State>(id: string, input: WorkProductPatch<State>) =>
  patch<WorkProduct<State>>(`/work-products/${segment(id)}`, {
    ...input,
    project_id: input.projectId,
    projectId: undefined,
  });
export const duplicateWorkProduct = <State>(id: string,
  input: { title?: string; projectId?: string | null } = {}) =>
  post<WorkProduct<State>>(`/work-products/${segment(id)}/duplicate`, {
    title: input.title, project_id: input.projectId,
  });
export const deleteWorkProduct = (id: string) =>
  remove<void>(`/work-products/${segment(id)}`);

export async function createResearchFile(input: { title: string; projectId?: string | null; folderId?: string | null }) {
  const title = input.title.trim().replace(/\.research\.md$/iu, "") || "Research";
  const document = await directoryResource(input.projectId
    ? { projectId: input.projectId } : { library: "files" }).uploadDocument(
      new File([researchMarkdown(title)], `${title}.research.md`, { type: "text/markdown" }), input.folderId);
  return { document, versionId: document.current_version_id!, workingRevision: 0,
    state: newResearchState() };
}
export const getResearchFile = (id: string) =>
  apiRequest<ResearchFile>(`/single-documents/${segment(id)}/research`);
export const actOnResearchFile = (id: string, versionId: string,
  workingRevision: number, action: ResearchAction) =>
  post<ResearchActionResult>(`/single-documents/${segment(id)}/research/actions`, {
    version_id: versionId, working_revision: workingRevision, action,
  });
export const getResearchItems = (id: string, input: { kind: "passages" | "queries";
  sourceId?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal) =>
  apiRequest<Page<ResearchPageItem> & { total: number }>(pagePath(
    `/single-documents/${segment(id)}/research/items`, {
      kind: input.kind, source_id: input.sourceId, cursor: input.cursor, limit: input.limit,
    }), { signal });
export const runResearchFileQuery = (id: string,
  input: ResearchQueryInput & { versionId: string; workingRevision: number }) =>
  post<ResearchQueryResult>(`/single-documents/${segment(id)}/research/query`, {
    ...input, version_id: input.versionId, working_revision: input.workingRevision,
    versionId: undefined, workingRevision: undefined,
  });
export const promoteChatResearch = ({ chatId, researchFileId, versionId,
  workingRevision, includeQueries }: {
  chatId: string; researchFileId: string; versionId: string; workingRevision: number;
  includeQueries: boolean;
}) => post<{ document_id: string; version_id: string }>(
  `/chat/${segment(chatId)}/research-files/${segment(researchFileId)}/promote`, {
    version_id: versionId, working_revision: workingRevision, includeQueries,
  });

export const createAuthorities = (input: {
  source: { kind: "manual" } | { kind: "document"; documentId: string;
    version: "latest" | { versionId: string; sha256: string } };
  title?: string;
  projectId?: string | null;
  settings?: Partial<AuthoritiesBuildSettings> & { profileId?: AuthoritiesProfileId;
    outputMode?: AuthoritiesOutputMode; insertIntoDocument?: boolean };
}) => post<AuthoritiesProduct>("/authorities", input);
export const uploadAuthoritiesDocument = (file: File, projectId?: string) =>
  multipartRequest<Document>("/authorities/documents", file,
    projectId ? { fields: { projectId } } : undefined);
export const actOnAuthorities = (id: string, revision: number, action: AuthoritiesAction) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/actions`, { revision, action });
export const refreshAuthorities = (id: string, revision: number) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/refresh`, { revision });
export const prepareAuthoritiesSources = (id: string, revision: number, signal?: AbortSignal) =>
  apiRequest<AuthoritiesProduct>(`/authorities/${segment(id)}/sources`,
    { ...mutationInit("POST", { revision }), signal });
export const refreshAuthoritiesInput = (id: string, role: string, revision: number) =>
  post<AuthoritiesProduct>(
    `/authorities/${segment(id)}/inputs/${segment(role)}/refresh`, { revision });
export const reviewAuthorities = (id: string, signal?: AbortSignal) =>
  apiRequest<AuthoritiesDiscrepancy[]>(
    `/authorities/${segment(id)}/discrepancies`, { ...mutationInit("POST", {}), signal });
export const resolveAuthoritiesDiscrepancy = (id: string, input: {
  id: string; action: AuthoritiesDiscrepancyAction; revision: number;
}) => post<AuthoritiesProduct>(`/authorities/${segment(id)}/discrepancies/actions`, input);
export const replaceAuthoritiesSource = (id: string, revision: number, file: File) =>
  multipartRequest<AuthoritiesProduct>(`/authorities/${segment(id)}/source`, file,
    { fields: { revision: String(revision) } });
export const attachAuthorityPdf = (
  id: string, authorityId: string, revision: number, file: File,
  language: AuthoritySourceLanguage,
) => multipartRequest<AuthoritiesProduct>(
  `/authorities/${segment(id)}/attachments/${segment(authorityId)}`, file,
  { fields: { revision: String(revision), language } },
);
export const attachAuthoritiesLibraryPdf = (id: string, revision: number,
  documentId: string, versionId: string, target:
    { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage } |
    { kind: "book"; slot: "cover" | "index" | "supplemental"; supplementId?: string }) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/library-pdfs`, {
    revision, documentId, versionId, target,
  });
export const attachAuthoritiesBookPdf = (id: string, revision: number,
  slot: "cover" | "index" | "supplemental", file: File, supplementId?: string) =>
  multipartRequest<AuthoritiesProduct>(
    `/authorities/${segment(id)}/book-parts/${slot}`, file,
    { fields: { revision: String(revision), ...(supplementId ? { supplement_id: supplementId } : {}) } },
  );
export const buildAuthorities = (id: string, revision: number, signal?: AbortSignal) =>
  apiRequest<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt }>(
    `/authorities/${segment(id)}/build`, { ...mutationInit("POST", { revision }), signal },
  );
