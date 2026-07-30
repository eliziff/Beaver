import { isAnonymousMode } from "@/app/lib/authMode";
import type {
  AssistantEvent,
  Chat,
  Citation,
  ColumnConfig,
  Document,
  Folder,
  LibraryFolder,
  Message,
  Project,
  TabularCell,
  Workflow,
  TabularReview,
} from "@/app/components/shared/types";
interface ServerMessage {
  id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  citations?: Citation[] | null;
}
function assistantContent(content: ServerMessage["content"]) {
  const events = Array.isArray(content) ? content : undefined;
  const text = events?.reduce(
    (result, event) => result + (event.type === "content" ? event.text : ""), "");
  return { content: text ?? "", events };
}
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
export class BeaverApiError extends Error {
  status: number;
  code: string | null;
  constructor(args: { message: string; status: number; code?: string | null }) {
    super(args.message);
    this.name = "BeaverApiError";
    this.status = args.status;
    this.code = args.code ?? null;
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
  if (isAnonymousMode) return {};
  const { supabase } = await import("@/app/lib/supabase");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function apiFetch(path: string, init: RequestInit = {}) {
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
    const parsed = JSON.parse(text) as { detail?: unknown; code?: unknown };
    return new BeaverApiError({
      status: response.status,
      code: typeof parsed.code === "string" ? parsed.code : null,
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
  options?: { signal?: AbortSignal; accept?: string },
) {
  return apiFetch(path, {
    ...mutationInit("POST", body),
    headers: {
      ...JSON_HEADERS,
      Accept: options?.accept ?? "application/json",
    },
    signal: options?.signal,
  });
}
export const listProjects = (options?: { includeDocuments?: boolean }) =>
  apiRequest<Project[]>(`/projects${options?.includeDocuments ? "?include=documents" : ""}`);
export const createProject = (
  name: string, cm_number?: string, practice?: string, shared_with?: string[],
  metadata?: Project["metadata"], notes?: string | null,
) => post<Project>("/projects", {
  name, cm_number, practice, shared_with, metadata, notes,
});
export const deleteAccount = () => remove<void>("/user/account");
export const deleteAllChats = () => remove<void>("/user/chats");
export const deleteAllProjects = () => remove<void>("/user/projects");
export const deleteAllTabularReviews = () => remove<void>("/user/tabular-reviews");
export const exportAccountData = () => apiBlobRequest("/user/export");
export const exportChatData = () => apiBlobRequest("/user/chats/export");
export const exportTabularReviewsData = () => apiBlobRequest("/user/tabular-reviews/export");
export interface UserProfile {
  displayName: string | null; organisation: string | null;
  messageCreditsUsed: number; creditsResetDate: string; creditsRemaining: number;
  tier: string; titleModel: string; tabularModel: string;
  mfaOnLogin: boolean; legalResearchUs: boolean;
  apiKeyStatus: ApiKeyStatus;
}
export interface UserLookupResult {
  exists: boolean; email: string; display_name: string | null;
}
export const launchTableOfAuthorities = () =>
  post<{ ok: boolean; url: string; reused: boolean }>("/table-of-authorities/launch");
export interface ModelCatalog {
  models: {
    slug: string; displayName: string; description?: string; defaultReasoningLevel?: string;
    supportedReasoningLevels: { effort: string; description?: string }[];
    visibility?: string; supportedInApi?: boolean;
  }[];
  source: "live" | "bundled" | "unavailable"; error?: string;
  ollama?: {
    source: "live" | "unavailable";
    models: {
      name: string; displayName: string; supportsThinking?: boolean;
    }[];
    error?: string;
  };
}
export const getModelCatalog = () => apiRequest<ModelCatalog>("/models");
export const getUserProfile = () => apiRequest<UserProfile>("/user/profile");
export const lookupUserByEmail = (email: string) =>
  apiRequest<UserLookupResult>(`/user/lookup?email=${encodeURIComponent(email)}`);
export const updateUserProfile = (
  payload: Partial<Pick<UserProfile,
    "displayName" | "organisation" | "titleModel" | "tabularModel" | "legalResearchUs">>,
) => patch<UserProfile>("/user/profile", payload);
export const updateUserMfaOnLogin = (enabled: boolean) =>
  patch<UserProfile>("/user/security/mfa-login", { enabled });
export type ApiKeyProvider =
  "claude" | "gemini" | "openai" | "deepseek" | "openrouter" | "courtlistener";
type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<ApiKeyProvider, {
  configured: boolean; source: ApiKeySource;
}>;
type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};
export const saveApiKey = (provider: ApiKeyProvider, apiKey: string | null) =>
  put<ApiKeyStatus>(`/user/api-keys/${provider}`, { api_key: apiKey });
interface McpToolSummary {
  id: string; toolName: string; openaiToolName: string;
  title: string | null; description: string | null;
  enabled: boolean; readOnly: boolean; destructive: boolean; requiresConfirmation: boolean;
  lastSeenAt: string;
}
export interface McpConnectorSummary {
  id: string; name: string; transport: "streamable_http"; serverUrl: string;
  authType: "none" | "bearer" | "oauth"; enabled: boolean; hasAuthConfig: boolean;
  customHeaderKeys: string[]; oauthConnected: boolean; toolPolicy: Record<string, unknown>;
  tools: McpToolSummary[]; toolCount: number; createdAt: string; updatedAt: string;
}
type McpConnectorInput = {
  name: string; serverUrl: string; bearerToken?: string | null; headers?: Record<string, string>;
};
export const listMcpConnectors = () =>
  apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
export const getMcpConnector = (connectorId: string) =>
  apiRequest<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}`);
export const createMcpConnector = (payload: McpConnectorInput) =>
  post<McpConnectorSummary>("/user/mcp-connectors", payload);
export const updateMcpConnector = (
  connectorId: string, payload: Partial<McpConnectorInput> & { enabled?: boolean },
) => patch<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}`, payload);
export const deleteMcpConnector = (connectorId: string) =>
  remove<void>(`/user/mcp-connectors/${connectorId}`);
export const refreshMcpConnectorTools = (connectorId: string) =>
  post<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}/refresh-tools`);
export const startMcpConnectorOAuth = (connectorId: string) =>
  post<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
  }>(`/user/mcp-connectors/${connectorId}/oauth/start`);
export const setMcpToolEnabled = (
  connectorId: string,
  toolId: string,
  enabled: boolean,
) => patch<McpConnectorSummary>(
  `/user/mcp-connectors/${connectorId}/tools/${toolId}`, { enabled },
);
export const getProject = (projectId: string) => apiRequest<Project>(`/projects/${projectId}`);
export const updateProject = (
  projectId: string,
  payload: Partial<Pick<
    Project,
    "name" | "cm_number" | "practice" | "shared_with" | "metadata" | "notes"
  >>,
) => patch<Project>(`/projects/${projectId}`, payload);
export const deleteProject = (projectId: string) =>
  remove<void>(`/projects/${projectId}`);
export interface ProjectPeople {
  owner: { user_id: string; email: string | null; display_name: string | null };
  members: { email: string; display_name: string | null }[];
}
export const getProjectPeople = (projectId: string) =>
  apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
export const createProjectFolder = (
  projectId: string, name: string, parentFolderId?: string | null,
) => post<Folder>(`/projects/${projectId}/folders`, {
  name, parent_folder_id: parentFolderId ?? null,
});
export const renameProjectFolder = (
  projectId: string, folderId: string, name: string,
) => patch<Folder>(`/projects/${projectId}/folders/${folderId}`, { name });
export const deleteProjectFolder = (projectId: string, folderId: string) =>
  remove<void>(`/projects/${projectId}/folders/${folderId}`);
export const moveSubfolderToFolder = (
  projectId: string, folderId: string, parentFolderId: string | null,
) => patch<Folder>(`/projects/${projectId}/folders/${folderId}`, {
  parent_folder_id: parentFolderId,
});
export const moveDocumentToFolder = (
  projectId: string, documentId: string, folderId: string | null,
) => patch<Document>(`/projects/${projectId}/documents/${documentId}/folder`, {
  folder_id: folderId,
});
export const renameProjectDocument = (
  projectId: string, documentId: string, filename: string,
) => patch<Document>(`/projects/${projectId}/documents/${documentId}`, { filename });
export type LibraryKind = "files" | "templates";
interface LibraryCollection { documents: Document[]; folders: LibraryFolder[] }
export type LegalDocumentType = "cases" | "laws" | "articles";
export interface LegalSourceReference {
  id: string;
  provider: "a2aj" | "journal";
  doc_type: LegalDocumentType;
  citation: string;
  language: "en" | "fr";
  dataset: string | null;
}
export interface LegalSourceSearchResult {
  provider: "a2aj" | "journal";
  doc_type: LegalDocumentType;
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
    dataset: string;
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
export const getLibrary = (kind: LibraryKind) =>
  apiRequest<LibraryCollection>(`/library/${kind}`);
export const retryLibraryPdfParse = (kind: LibraryKind, documentId: string) =>
  post<{ status: string }>(
    `/library/${kind}/documents/${encodeURIComponent(documentId)}/actions/retry-pdf-parse`,
    {},
  );
export const listLegalLibrary = async () =>
  (await apiRequest<{ references: LegalSourceReference[] }>("/library/legal")).references;
export const getLegalSourceCoverage = async () =>
  (await apiRequest<{ coverage: LegalSourceCoverage[] }>("/library/legal/coverage")).coverage;
export const searchLegalSources = async (args: {
  query: string;
  docType: LegalDocumentType;
  language?: "en" | "fr";
  datasets?: string[];
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}): Promise<LegalSourceSearchResult[]> => {
  const query = new URLSearchParams({
    query: args.query,
    doc_type: args.docType,
    language: args.language ?? "en",
  });
  if (args.datasets?.length) query.set("dataset", args.datasets.join(","));
  if (args.startDate) query.set("start_date", args.startDate);
  if (args.endDate) query.set("end_date", args.endDate);
  if (args.sortResults && args.sortResults !== "default") {
    query.set("sort_results", args.sortResults);
  }
  return (
    await apiRequest<{ results: LegalSourceSearchResult[] }>(
      `/library/legal/search?${query}`,
    )
  ).results;
};
export const saveLegalSource = (args: {
  citation: string;
  docType: LegalDocumentType;
  language?: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}) => post<LegalSourceReference>("/library/legal", {
  citation: args.citation,
  doc_type: args.docType,
  language: args.language ?? "en",
  dataset: args.dataset ?? undefined,
  source_id: args.sourceId ?? undefined,
});
export const deleteLegalSource = async (referenceId: string): Promise<void> => {
  const path = `/library/legal/${encodeURIComponent(referenceId)}`;
  await remove(path);
  legalSourceDocumentRequests.delete(`${path}/document`);
};
const legalSourceDocumentRequests = new Map<
  string,
  Promise<LegalSourceViewerPayload>
>();
async function cachedLegalSourceDocument(path: string) {
  const cached = legalSourceDocumentRequests.get(path);
  if (cached) return cached;
  const request = apiRequest<LegalSourceViewerPayload>(path, {
    cache: "default",
  });
  legalSourceDocumentRequests.set(path, request);
  request.catch(() => legalSourceDocumentRequests.delete(path));
  return request;
}
export const getLegalSourceDocument = (referenceId: string) =>
  cachedLegalSourceDocument(`/library/legal/${encodeURIComponent(referenceId)}/document`);
export const getDirectLegalSourceDocument = (args: {
  provider: "a2aj" | "journal";
  citation: string;
  sourceId?: string | null;
  docType?: LegalDocumentType | "auto";
  language?: "en" | "fr";
  dataset?: string | null;
}) => {
  const query = new URLSearchParams({
    citation: args.citation,
    provider: args.provider,
    doc_type: args.docType ?? "auto",
    language: args.language ?? "en",
  });
  if (args.dataset) query.set("dataset", args.dataset);
  if (args.sourceId) query.set("source_id", args.sourceId);
  return cachedLegalSourceDocument(`/library/legal/document?${query}`);
}
export interface LegalResearchProject {
  id: string;
  name: string;
  order: number;
}
export interface LegalResearchNode {
  id: string;
  kind: string;
  name: string;
  color: string;
}
interface LegalSourceMark {
  label_ids: string[];
  note: string;
}
export interface LegalSourceMarking {
  nodes: LegalResearchNode[];
  edges: { from_node_id: string; to_node_id: string; relation: string }[];
  mark: LegalSourceMark | null;
}
export const listLegalResearchProjects = async () =>
  (await apiRequest<{ projects: LegalResearchProject[] }>("/legal-knowledge/projects")).projects;
export const createLegalResearchProject = (name: string) =>
  post<LegalResearchProject>("/legal-knowledge/projects", { name });
export const getLegalSourceMarking = (
  projectId: string,
  sourceId: string,
) => {
  const query = new URLSearchParams({ source_id: sourceId });
  return apiRequest<LegalSourceMarking>(
    `/legal-knowledge/projects/${encodeURIComponent(projectId)}/marking?${query}`,
  );
};
export const createLegalResearchLabel = (
  projectId: string,
  label: { name: string; color: string; parentId: string | null },
) => post<LegalResearchNode>(
  `/legal-knowledge/projects/${encodeURIComponent(projectId)}/nodes`,
  { kind: "label", name: label.name, color: label.color, parent_id: label.parentId },
);
export const saveLegalSourceMark = (
  projectId: string,
  sourceId: string,
  mark: { labelIds: string[]; note: string },
) => put<LegalSourceMark | null>(
  `/legal-knowledge/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/mark`,
  { label_ids: mark.labelIds, note: mark.note },
);
export const uploadLibraryDocument = (kind: LibraryKind, file: File) =>
  multipartRequest<Document>(`/library/${kind}/documents`, file);
export const createLibraryFolder = (
  kind: LibraryKind,
  name: string,
  parentFolderId?: string | null,
) => post<LibraryFolder>(`/library/${kind}/folders`, {
  name, parent_folder_id: parentFolderId ?? null,
});
export const renameLibraryFolder = (
  kind: LibraryKind,
  folderId: string,
  name: string,
) => patch<LibraryFolder>(`/library/${kind}/folders/${folderId}`, { name });
export const deleteLibraryFolder = (kind: LibraryKind, folderId: string) =>
  remove<void>(`/library/${kind}/folders/${folderId}`);
export const moveLibraryFolder = (
  kind: LibraryKind,
  folderId: string,
  parentFolderId: string | null,
) => patch<LibraryFolder>(`/library/${kind}/folders/${folderId}`, {
  parent_folder_id: parentFolderId,
});
export const moveLibraryDocument = (
  kind: LibraryKind,
  documentId: string,
  folderId: string | null,
) => patch<Document>(`/library/${kind}/documents/${documentId}/folder`, {
  folder_id: folderId,
});
export const renameLibraryDocument = (
  kind: LibraryKind,
  documentId: string,
  filename: string,
) => patch<Document>(`/library/${kind}/documents/${documentId}`, { filename });
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
    `/library/files/documents/${encodeURIComponent(documentId)}/automation`,
  );
export const fixLibraryDocxSupras = (documentId: string) =>
  post<DeterministicDocxActionResult>(
    `/library/files/documents/${encodeURIComponent(documentId)}/actions/fix-supras`,
  );
export const linkLibraryDocxCitations = (documentId: string) =>
  post<DeterministicDocxActionResult>(
    `/library/files/documents/${encodeURIComponent(documentId)}/actions/link-citations`,
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
) => post<Document>(`/projects/${projectId}/documents/${documentId}`);
export const removeProjectDocument = async (
  projectId: string,
  documentId: string,
): Promise<void> => {
  if (!isAnonymousMode) {
    await deleteDocument(documentId);
    return;
  }
  await remove(`/projects/${projectId}/documents/${documentId}`);
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
}> => apiRequest(`/single-documents/${documentId}/versions`);
export const uploadDocumentVersion = (
  documentId: string,
  file: File,
  filename?: string,
) => multipartRequest<DocumentVersion>(
  `/single-documents/${documentId}/versions`, file, { filename },
);
export const replaceDocumentVersionFile = (
  documentId: string,
  versionId: string,
  file: File,
  filename?: string,
) => multipartRequest<DocumentVersion>(
  `/single-documents/${documentId}/versions/${versionId}/file`,
  file,
  { method: "PUT", filename },
);
export const renameDocumentVersion = (
  documentId: string,
  versionId: string,
  filename: string | null,
) => patch<DocumentVersion>(
  `/single-documents/${documentId}/versions/${versionId}`, { filename },
);
export const deleteDocumentVersion = (
  documentId: string,
  versionId: string,
): Promise<{
  deleted_version_id: string;
  current_version_id: string | null;
}> => remove(`/single-documents/${documentId}/versions/${versionId}`);
export const uploadProjectDocument = (projectId: string, file: File) =>
  multipartRequest<Document>(`/projects/${projectId}/documents`, file);
export const uploadStandaloneDocument = (file: File) =>
  multipartRequest<Document>("/single-documents", file);
export const deleteDocument = (documentId: string) =>
  remove<void>(`/single-documents/${documentId}`);
export const getDocumentUrl = (
  documentId: string,
  versionId?: string | null,
) => apiRequest<{ url: string; filename: string; version_id: string | null }>(
  `/single-documents/${documentId}/url${
    versionId ? `?version_id=${encodeURIComponent(versionId)}` : ""
  }`,
);
export const downloadDocumentsZip = async (documentIds: string[]): Promise<Blob> =>
  (await apiBlobRequest(
    "/single-documents/download-zip",
    mutationInit("POST", { document_ids: documentIds }),
  )).blob;
export const createChat = (payload?: {
  project_id?: string;
}) => post<{ id: string }>("/chat/create", payload ?? {});
export const listChats = (options?: { limit?: number }) =>
  apiRequest<Chat[]>(`/chat${options?.limit ? `?limit=${options.limit}` : ""}`);
export const listProjectChats = (projectId: string) =>
  apiRequest<Chat[]>(`/projects/${projectId}/chats`);
export const getChat = async (chatId: string) => {
  const raw = await apiRequest<{ chat: Chat; messages: ServerMessage[] }>(`/chat/${chatId}`);
  const messages: Message[] = raw.messages.map((m) => {
    if (m.role === "user") {
      return {
        id: m.id,
        role: "user",
        content: typeof m.content === "string" ? m.content : "",
        files: m.files ?? undefined,
        workflow: m.workflow ?? undefined,
      };
    }
    return {
      id: m.id,
      role: "assistant",
      citations: m.citations ?? undefined,
      ...assistantContent(m.content),
    };
  });
  return { chat: raw.chat, messages };
};
export const renameChat = (chatId: string, title: string) =>
  patch<void>(`/chat/${chatId}`, { title });
export const updateChatProject = (
  chatId: string,
  projectId: string | null,
) => patch<{ id: string; title: string | null; project_id: string | null }>(
  `/chat/${chatId}`, { project_id: projectId },
);
export const deleteChat = (chatId: string) => remove<void>(`/chat/${chatId}`);
export const listDeletedChats = () => apiRequest<Chat[]>("/chat/recycling-bin");
export const restoreChat = (chatId: string) => post<void>(`/chat/${chatId}/restore`);
export const permanentlyDeleteChat = (chatId: string) =>
  remove<void>(`/chat/${chatId}/permanent`);
export const stopChat = (chatId: string) =>
  post<{ stopped: boolean }>(`/chat/${chatId}/stop`);
export const generateChatTitle = (chatId: string, message: string) =>
  post<{ title: string }>(`/chat/${chatId}/generate-title`, { message });
export type CaseLawOpinion =
  Extract<AssistantEvent, { type: "case_opinions" }>["case"]["opinions"][number];
export const getCourtlistenerOpinions = async (clusterId: number) =>
  (await post<{ opinions: CaseLawOpinion[] }>(
    "/case-law/case-opinions", { clusterId },
  )).opinions;
type StreamCurrentTurn =
  | (Pick<Message, "content" | "files" | "workflow"> & {
      kind: "message"; turn_id?: string;
    })
  | (Pick<Message, "content" | "files"> & {
      kind: "ask_inputs_response";
      responses: Extract<
        AssistantEvent,
        { type: "ask_inputs_response" }
      >["responses"];
    });
export const streamChat = (payload: {
  messages?: Pick<Message, "role" | "content" | "files" | "workflow">[];
  current_turn?: StreamCurrentTurn;
  expected_version?: number;
  chat_id?: string;
  project_id?: string;
  model?: string;
  reasoning_effort?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: { filename: string; document_id: string }[];
  ask_inputs_response?: Extract<
    AssistantEvent,
    { type: "ask_inputs_response" }
  >;
  signal?: AbortSignal;
}) => {
  const { signal, ...body } = payload;
  return streamRequest("/chat", body, { signal, accept: "text/event-stream" });
};
export const listTabularReviews = (projectId?: string) =>
  apiRequest<TabularReview[]>(
    `/tabular-review${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
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
    `/tabular-review/${reviewId}`,
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
) => patch<TabularReview>(`/tabular-review/${reviewId}`, payload);
export const getTabularReviewPeople = (reviewId: string) =>
  apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
export const generateTabularColumnPrompt = (
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
) => post<{ prompt: string; source: "preset" | "llm" | "fallback" }>(
  "/tabular-review/prompt",
  {
    title,
    format: options?.format,
    documentName: options?.documentName,
    tags: options?.tags,
  },
);
export const deleteTabularReview = (reviewId: string) =>
  remove<void>(`/tabular-review/${reviewId}`);
export const streamTabularGeneration = (
  reviewId: string,
  options?: { model?: string; reasoningEffort?: string },
) => streamRequest(`/tabular-review/${reviewId}/generate`, {
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const streamTabularChat = (
  reviewId: string,
  messages: { role: string; content: string }[],
  chat_id?: string | null,
  signal?: AbortSignal,
  context?: {
    reviewTitle?: string | null;
    projectName?: string | null;
    model?: string;
    reasoningEffort?: string;
  },
) => streamRequest(`/tabular-review/${reviewId}/chat`, {
  messages,
  chat_id: chat_id ?? undefined,
  review_title: context?.reviewTitle ?? undefined,
  project_name: context?.projectName ?? undefined,
  model: context?.model,
  reasoning_effort: context?.reasoningEffort,
}, { signal });
export interface TRCitationAnnotation {
  type: "tabular_citation";
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
}
interface RawTRMessage extends Pick<ServerMessage, "role" | "content"> {
  annotations?: TRCitationAnnotation[] | null;
}
export interface TRChat {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}
export const mapTRMessages = (raw: RawTRMessage[]) =>
  raw.map((m) => {
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : "",
      };
    }
    return {
      role: "assistant" as const,
      annotations: m.annotations ?? undefined,
      ...assistantContent(m.content),
    };
  });
export const getTabularChats = (reviewId: string) =>
  apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
export const getTabularChatMessages = (
  reviewId: string,
  chatId: string,
) => apiRequest<RawTRMessage[]>(`/tabular-review/${reviewId}/chats/${chatId}/messages`);
export const regenerateTabularCell = (
  reviewId: string,
  documentId: string,
  columnIndex: number,
  options?: { model?: string; reasoningEffort?: string },
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> => post(`/tabular-review/${reviewId}/regenerate-cell`, {
  document_id: documentId,
  column_index: columnIndex,
  model: options?.model,
  reasoning_effort: options?.reasoningEffort,
});
export const clearTabularCells = (reviewId: string, documentIds: string[]) =>
  post<void>(`/tabular-review/${reviewId}/clear-cells`, {
    document_ids: documentIds,
  });
export const listWorkflows = (type?: Workflow["metadata"]["type"]) =>
  apiRequest<Workflow[]>(type ? `/workflows?type=${type}` : "/workflows");
export const getWorkflow = (workflowId: string) =>
  apiRequest<Workflow>(`/workflows/${workflowId}`);
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
) => patch<Workflow>(`/workflows/${workflowId}`, payload);
export const deleteWorkflow = (workflowId: string) =>
  remove<void>(`/workflows/${workflowId}`);
export const listHiddenWorkflows = () => apiRequest<string[]>("/workflows/hidden");
export const hideWorkflow = (workflowId: string) =>
  post<void>("/workflows/hidden", { workflow_id: workflowId });
export const unhideWorkflow = (workflowId: string) =>
  remove<void>(`/workflows/hidden/${workflowId}`);
export const shareWorkflow = (
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
) => post<void>(`/workflows/${workflowId}/share`, payload);
export const listWorkflowShares = (workflowId: string) =>
  apiRequest<{
    id: string; shared_with_email: string; allow_edit: boolean; created_at: string;
  }[]>(`/workflows/${workflowId}/shares`);
export const deleteWorkflowShare = (workflowId: string, shareId: string) =>
  remove<void>(`/workflows/${workflowId}/shares/${shareId}`);
