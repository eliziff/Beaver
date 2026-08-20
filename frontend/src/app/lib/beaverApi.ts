import { isLocalMode } from "@/app/lib/authMode";
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
const API_BASE = "/api";
const segment = (value: string | number) => encodeURIComponent(String(value));
export class BeaverApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;
  constructor(args: { message: string; status: number; code?: string | null;
    details?: Record<string, unknown> | null }) {
    super(args.message);
    this.name = "BeaverApiError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.details = args.details ?? null;
  }
}
export function isMfaRequiredError(error: unknown) {
  return (
    error instanceof BeaverApiError &&
    error.status === 403 &&
    error.code === "mfa_verification_required"
  );
}
async function getAuthHeader(): Promise<Record<string, string>> {
  if (isLocalMode) return {};
  const { getSupabase } = await import("@/app/lib/supabase");
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers({
    Accept: "application/json",
    ...(await getAuthHeader()),
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers,
  });
}
async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204 || response.headers.get("content-length") === "0")
    return undefined as T;
  return (await response.json()) as T;
}
export async function apiBlobRequest(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await toApiError(response);
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] ?? null,
  };
}
async function toApiError(response: Response) {
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    const parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
    return new BeaverApiError({
      status: response.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
      details: parsed,
      message:
        typeof parsed.detail === "string" && parsed.detail
          ? parsed.detail
          : `API error: ${response.status}`,
    });
  } catch {
    return new BeaverApiError({
      status: response.status,
      message: text || `API error: ${response.status}`,
    });
  }
}
const JSON_HEADERS = { "Content-Type": "application/json" };
function mutationInit(method: RequestInit["method"], body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
const post = <T>(path: string, body?: unknown) => apiRequest<T>(path, mutationInit("POST", body));
const patch = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PATCH", body));
const put = <T>(path: string, body: unknown) => apiRequest<T>(path, mutationInit("PUT", body));
const remove = <T>(path: string) => apiRequest<T>(path, mutationInit("DELETE"));
function multipartRequest<T>(
  path: string, file: File,
  options?: { method?: string; filename?: string },
) {
  const form = new FormData();
  form.append("file", file);
  if (options?.filename) form.append("filename", options.filename);
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
      throw await toApiError(response);
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
export async function getApiAuthorization() {
  return (await getAuthHeader()).Authorization ?? "";
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
  tier: string; titleModel: string; tabularModel: string;
  mfaOnLogin: boolean; legalResearchUs: boolean;
  draftingStyle: DraftingStyleSettings;
  apiKeyStatus: ApiKeyStatus;
}
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
    "displayName" | "organisation" | "titleModel" | "tabularModel" | "legalResearchUs" | "draftingStyle">>,
) => patch<UserProfile>("/user/profile", payload);
export const updateUserMfaOnLogin = (enabled: boolean) =>
  patch<UserProfile>("/user/security/mfa-login", { enabled });
export type ApiKeyProvider =
  | "claude" | "gemini" | "openai" | "deepseek" | "openrouter" | "meta"
  | "courtlistener";
type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<ApiKeyProvider, {
  configured: boolean; source: ApiKeySource;
}>;
type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
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
export type DirectoryScope =
  | { projectId: string }
  | { library: LibraryKind };
export function directoryResource(scope: DirectoryScope) {
  const root = "projectId" in scope
    ? `/projects/${segment(scope.projectId)}`
    : `/library/${scope.library}`;
  const folders = `${root}/folders`;
  const documents = `${root}/documents`;
  return {
    list: (options: PageQuery & { parent_id?: string | null } = {}, signal?: AbortSignal) =>
      apiRequest<Page<DirectoryEntry>>(pagePath(`${root}${"projectId" in scope ? "/directory" : ""}`, options), { signal }),
    uploadDocument: (file: File) => multipartRequest<Document>(documents, file),
    createFolder: (name: string, parentFolderId?: string | null) =>
      post<Folder | LibraryFolder>(folders, { name, parent_folder_id: parentFolderId ?? null }),
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
export interface LegalSourceReference {
  id: string;
  provider: "a2aj" | "journal";
  doc_type: LegalDocumentType;
  citation: string;
  dataset: string | null;
}
export interface LegalSourceSearchResult {
  provider: "a2aj" | "journal" | "hansard";
  doc_type: LegalSearchDocumentType;
  source_id?: string | null;
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
export type LegalSourceInlineToken =
  | { kind: "text" | "em" | "strong" | "code" | "sup" | "sub"; text: string }
  | { kind: "link"; text: string; href: string };
type LegalSourceTextBlock = { text: string; inline: LegalSourceInlineToken[] };
export type LegalSourcePresentationBlock =
  | (LegalSourceTextBlock & { kind: "heading"; level: 2 | 3 | 4 | 5 })
  | (LegalSourceTextBlock & { kind: "provision"; label: string; depth: number })
  | (LegalSourceTextBlock & {
      kind: "list-item"; marker: string; ordered: boolean; depth: number;
    })
  | (LegalSourceTextBlock & { kind: "blockquote" | "paragraph"; depth: number });
export interface LegalSourceViewerPayload {
  reference: {
    docType: LegalDocumentType;
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
  text: string;
  structure: {
    blocks: {
      kind: "paragraph" | "page" | "section" | "footnote";
      label: string;
      start: number;
    }[];
  };
  presentation?: {
    segments: {
      start: number;
      end: number;
      blocks: LegalSourcePresentationBlock[];
    }[];
  };
  truncated: boolean;
}
export const retryLibraryPdfParse = (kind: LibraryKind, documentId: string) =>
  post<{ status: string }>(
    `/library/${kind}/documents/${segment(documentId)}/actions/retry-pdf-parse`,
    {},
  );
export const listLegalLibrary = async () =>
  (await apiRequest<{ references: LegalSourceReference[] }>("/sources")).references;
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
export const saveLegalSource = (args: {
  citation: string;
  docType: LegalDocumentType;
  language?: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}) => post<LegalSourceReference>("/sources", {
  citation: args.citation,
  doc_type: args.docType,
  language: args.language ?? "en",
  dataset: args.dataset ?? undefined,
  source_id: args.sourceId ?? undefined,
});
export const deleteLegalSource = async (referenceId: string): Promise<void> => {
  const path = `/sources/${segment(referenceId)}`;
  await remove(path);
  legalSourceDocumentRequests.delete(`${path}/document`);
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
export const inspectLibraryDocumentAutomation = (documentId: string) =>
  apiRequest<{ supra_references: boolean }>(
    `/library/files/documents/${segment(documentId)}/automation`,
  );
export const fixLibraryDocxSupras = (documentId: string) =>
  post<DeterministicDocxActionResult>(
    `/library/files/documents/${segment(documentId)}/actions/fix-supras`,
  );
export type TableOfAuthoritiesJob = {
  id: string;
  state: string;
  operation: string;
  progress: number;
  message: string;
  error: string;
  files: { name: string; url: string }[];
  app_url: string;
};
export const submitLibraryDocumentToAuthorities = (
  documentId: string,
  splitFallback: "off" | "auto" = "auto",
  projectId?: string | null,
) => post<TableOfAuthoritiesJob>("/table-of-authorities/jobs", {
  document_id: documentId,
  split_fallback: splitFallback,
  project_id: projectId || undefined,
});
export const addDocumentToProject = (
  projectId: string,
  documentId: string,
) => post<Document>(`/projects/${segment(projectId)}/documents/${segment(documentId)}`);
export const removeProjectDocument = async (
  projectId: string,
  documentId: string,
): Promise<void> => {
  if (!isLocalMode) {
    await deleteDocument(documentId);
    return;
  }
  await remove(`/projects/${segment(projectId)}/documents/${segment(documentId)}`);
};
export interface DocumentVersion {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  size_bytes?: number | null;
  deleted_at?: string | null;
}
export const listDocumentVersions = (documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocumentVersion[];
}> => apiRequest(`/single-documents/${segment(documentId)}/versions`);
export const uploadDocumentVersion = (
  documentId: string,
  file: File,
  filename?: string,
) => multipartRequest<DocumentVersion>(
  `/single-documents/${segment(documentId)}/versions`, file, { filename },
);
export const replaceDocumentVersionFile = (
  documentId: string,
  versionId: string,
  file: File,
  filename?: string,
) => multipartRequest<DocumentVersion>(
  `/single-documents/${segment(documentId)}/versions/${segment(versionId)}/file`,
  file,
  { method: "PUT", filename },
);
export const renameDocumentVersion = (
  documentId: string,
  versionId: string,
  filename: string | null,
) => patch<DocumentVersion>(
  `/single-documents/${segment(documentId)}/versions/${segment(versionId)}`, { filename },
);
export const deleteDocumentVersion = (
  documentId: string,
  versionId: string,
): Promise<{
  deleted_version_id: string;
  current_version_id: string | null;
}> => remove(`/single-documents/${segment(documentId)}/versions/${segment(versionId)}`);
export const uploadStandaloneDocument = (file: File) =>
  multipartRequest<Document>("/single-documents", file);
export const deleteDocument = (documentId: string) =>
  remove<void>(`/single-documents/${segment(documentId)}`);
export const downloadDocument = (
  documentId: string,
  versionId?: string | null,
) => apiBlobRequest(
  pagePath(`/single-documents/${segment(documentId)}/file`, { version_id: versionId }),
);
type DocumentEditResolution = {
  status?: "accepted" | "rejected";
  version_id: string | null;
  download_url: string | null;
};
export const resolveDocumentEdit = (
  documentId: string, editId: string, verb: "accept" | "reject",
) => post<DocumentEditResolution>(
  `/single-documents/${segment(documentId)}/edits/${segment(editId)}/${verb}`,
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
export const getChat = (chatId: string) =>
  apiRequest<{ chat: Chat; messages: AssistantTranscriptMessage[] }>(`/chat/${segment(chatId)}`);
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
export const streamTabularGeneration = (
  reviewId: string,
  options?: { model?: string; reasoningEffort?: string },
) => streamRequest(`/tabular-review/${segment(reviewId)}/generate`, {
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const regenerateTabularCell = (
  reviewId: string,
  documentId: string,
  columnIndex: number,
  options?: { model?: string; reasoningEffort?: string },
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> => post(`/tabular-review/${segment(reviewId)}/regenerate-cell`, {
  document_id: documentId,
  column_index: columnIndex,
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const clearTabularCells = (reviewId: string, documentIds: string[]) =>
  post<void>(`/tabular-review/${segment(reviewId)}/clear-cells`, {
    document_ids: documentIds,
  });
export const listSystemWorkflows = (type?: Workflow["metadata"]["type"]) =>
  apiRequest<Workflow[]>(pagePath("/workflows/system", { type }));
export const listWorkflows = (options: PageQuery & {
  type?: Workflow["metadata"]["type"];
} = {}, signal?: AbortSignal) => apiRequest<Page<Workflow>>(
  pagePath("/workflows", options), { signal },
);
export const getWorkflow = (workflowId: string) =>
  apiRequest<Workflow>(`/workflows/${segment(workflowId)}`);
export const createWorkflow = (payload: {
  metadata: {
    title: string;
    type: "assistant" | "tabular";
    language?: string | null;
    practice?: string | null;
    jurisdictions?: string[] | null;
  };
  skill_md?: string;
  columns_config?: ColumnConfig[];
}) => post<Workflow>("/workflows", payload);
export const updateWorkflow = (
  workflowId: string,
  payload: {
    metadata?: Partial<Pick<
      Workflow["metadata"],
      "title" | "practice" | "jurisdictions"
    >> & { language?: string | null };
    skill_md?: string;
    columns_config?: ColumnConfig[];
  },
) => patch<Workflow>(`/workflows/${segment(workflowId)}`, payload);
export const deleteWorkflow = (workflowId: string) =>
  remove<void>(`/workflows/${segment(workflowId)}`);
export const listHiddenWorkflows = () => apiRequest<string[]>("/workflows/hidden");
export const hideWorkflow = (workflowId: string) =>
  post<void>("/workflows/hidden", { workflow_id: workflowId });
export const unhideWorkflow = (workflowId: string) =>
  remove<void>(`/workflows/hidden/${segment(workflowId)}`);
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
