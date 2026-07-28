/**
 * Beaver API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { isAnonymousMode } from "@/app/lib/authMode";
import type {
  AssistantEvent,
  Chat,
  ChatDetailOut,
  Citation,
  Document,
  Folder,
  LibraryFolder,
  Message,
  OpenSourceWorkflowContributorMode,
  OpenSourceWorkflowResponse,
  Project,
  Workflow,
  WorkflowContributor,
  TabularReview,
  TabularReviewDetailOut,
} from "@/app/components/shared/types";

interface ServerMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  citations?: Citation[] | null;
  created_at: string;
}
interface ServerChatDetailOut {
  chat: Chat;
  messages: ServerMessage[];
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

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

export async function getAuthHeader(): Promise<Record<string, string>> {
  if (isAnonymousMode) return {};
  const { supabase } = await import("@/app/lib/supabase");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { headers: initHeaders, ...restInit } = init ?? {};
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...(await getAuthHeader()),
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function apiBlobRequest(
  path: string,
  init?: RequestInit,
): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  const response = await apiFetch(path, init);

  if (!response.ok) {
    throw await toApiError(response);
  }

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
    const parsed = JSON.parse(text) as {
      detail?: unknown;
      code?: unknown;
    };
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

function jsonRequest<T>(path: string, method: string, body: unknown) {
  return apiRequest<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function multipartRequest<T>(
  path: string,
  file: File,
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

async function streamRequest(
  path: string,
  body: unknown,
  options?: { signal?: AbortSignal; accept?: string },
) {
  return apiFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: options?.accept ?? "application/json",
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(options?: {
  includeDocuments?: boolean;
}): Promise<Project[]> {
  const query = options?.includeDocuments ? "?include=documents" : "";
  return apiRequest<Project[]>(`/projects${query}`);
}

export async function createProject(
  name: string,
  cm_number?: string,
  practice?: string,
  shared_with?: string[],
): Promise<Project> {
  return jsonRequest<Project>("/projects", "POST", {
    name,
    cm_number,
    practice,
    shared_with,
  });
}

export async function deleteAccount(): Promise<void> {
  return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
  return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
  return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
  return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function exportAccountData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/export");
}

export async function exportChatData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/chats/export");
}

export async function exportTabularReviewsData(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return apiBlobRequest("/user/tabular-reviews/export");
}

export interface UserProfile {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: string;
  creditsRemaining: number;
  tier: string;
  titleModel: string;
  tabularModel: string;
  mfaOnLogin: boolean;
  legalResearchUs: boolean;
  apiKeyStatus: ApiKeyStatus;
}

export interface UserLookupResult {
  exists: boolean;
  email: string;
  display_name: string | null;
}

export async function launchTableOfAuthorities(): Promise<{
  ok: boolean;
  url: string;
  reused: boolean;
}> {
  return apiRequest("/table-of-authorities/launch", { method: "POST" });
}

interface CodexReasoningLevel {
  effort: string;
  description?: string;
}

export interface CodexModelDescriptor {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: CodexReasoningLevel[];
  visibility?: string;
  supportedInApi?: boolean;
}

export interface CodexModelCatalog {
  models: CodexModelDescriptor[];
  source: "live" | "bundled" | "unavailable";
  error?: string;
}

export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
  return apiRequest<CodexModelCatalog>("/codex/models");
}

export async function getUserProfile(): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile");
}

export async function lookupUserByEmail(
  email: string,
): Promise<UserLookupResult> {
  return apiRequest<UserLookupResult>(
    `/user/lookup?email=${encodeURIComponent(email)}`,
  );
}

export async function updateUserProfile(payload: {
  displayName?: string | null;
  organisation?: string | null;
  titleModel?: string;
  tabularModel?: string;
  legalResearchUs?: boolean;
}): Promise<UserProfile> {
  return jsonRequest<UserProfile>("/user/profile", "PATCH", payload);
}

export async function updateUserMfaOnLogin(
  enabled: boolean,
): Promise<UserProfile> {
  return jsonRequest<UserProfile>("/user/security/mfa-login", "PATCH", {
    enabled,
  });
}

export type ApiKeyProvider =
  | "claude"
  | "gemini"
  | "openai"
  | "deepseek"
  | "openrouter"
  | "courtlistener";
type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
  ApiKeyProvider,
  {
    configured: boolean;
    source: ApiKeySource;
  }
>;

type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function saveApiKey(
  provider: ApiKeyProvider,
  apiKey: string | null,
): Promise<ApiKeyStatus> {
  return jsonRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, "PUT", {
    api_key: apiKey,
  });
}

interface McpToolSummary {
  id: string;
  toolName: string;
  openaiToolName: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  lastSeenAt: string;
}

export interface McpConnectorSummary {
  id: string;
  name: string;
  transport: "streamable_http";
  serverUrl: string;
  authType: "none" | "bearer" | "oauth";
  enabled: boolean;
  hasAuthConfig: boolean;
  customHeaderKeys: string[];
  oauthConnected: boolean;
  toolPolicy: Record<string, unknown>;
  tools: McpToolSummary[];
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
  return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}`);
}

export async function createMcpConnector(payload: {
  name: string;
  serverUrl: string;
  bearerToken?: string | null;
  headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
  return jsonRequest<McpConnectorSummary>(
    "/user/mcp-connectors",
    "POST",
    payload,
  );
}

export async function updateMcpConnector(
  connectorId: string,
  payload: {
    name?: string;
    serverUrl?: string;
    enabled?: boolean;
    bearerToken?: string | null;
    headers?: Record<string, string>;
  },
): Promise<McpConnectorSummary> {
  return jsonRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}`,
    "PATCH",
    payload,
  );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
  return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
    method: "DELETE",
  });
}

export async function refreshMcpConnectorTools(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/refresh-tools`,
    { method: "POST" },
  );
}

export async function startMcpConnectorOAuth(
  connectorId: string,
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
  return apiRequest<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
  }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
  connectorId: string,
  toolId: string,
  enabled: boolean,
): Promise<McpConnectorSummary> {
  return jsonRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
    "PATCH",
    { enabled },
  );
}

export async function getProject(projectId: string): Promise<Project> {
  return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
  projectId: string,
  payload: {
    name?: string;
    cm_number?: string;
    practice?: string | null;
    shared_with?: string[];
  },
): Promise<Project> {
  return jsonRequest<Project>(`/projects/${projectId}`, "PATCH", payload);
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
  owner: {
    user_id: string;
    email: string | null;
    display_name: string | null;
  };
  members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
  projectId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
  projectId: string,
  name: string,
  parentFolderId?: string | null,
): Promise<Folder> {
  return jsonRequest<Folder>(`/projects/${projectId}/folders`, "POST", {
    name,
    parent_folder_id: parentFolderId ?? null,
  });
}

export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
): Promise<Folder> {
  return jsonRequest<Folder>(
    `/projects/${projectId}/folders/${folderId}`,
    "PATCH",
    { name },
  );
}

export async function deleteProjectFolder(
  projectId: string,
  folderId: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
    method: "DELETE",
  });
}

export async function moveSubfolderToFolder(
  projectId: string,
  folderId: string,
  parentFolderId: string | null,
): Promise<Folder> {
  return jsonRequest<Folder>(
    `/projects/${projectId}/folders/${folderId}`,
    "PATCH",
    { parent_folder_id: parentFolderId },
  );
}

export async function moveDocumentToFolder(
  projectId: string,
  documentId: string,
  folderId: string | null,
): Promise<Document> {
  return jsonRequest<Document>(
    `/projects/${projectId}/documents/${documentId}/folder`,
    "PATCH",
    { folder_id: folderId },
  );
}

export async function renameProjectDocument(
  projectId: string,
  documentId: string,
  filename: string,
): Promise<Document> {
  return jsonRequest<Document>(
    `/projects/${projectId}/documents/${documentId}`,
    "PATCH",
    { filename },
  );
}

export type LibraryKind = "files" | "templates";

interface LibraryCollection {
  documents: Document[];
  folders: LibraryFolder[];
}

export type LegalDocumentType = "cases" | "laws" | "articles";

interface LegalSourcePdfFallback {
  provider: "a2aj";
  identity: string;
  reference_id: string;
  status_url: string;
}

export interface LegalSourceReference {
  id: string;
  provider: "a2aj" | "journal";
  doc_type: LegalDocumentType;
  citation: string;
  language: "en" | "fr";
  dataset: string | null;
  source_id: string | null;
  pdf_fallback?: LegalSourcePdfFallback;
}

export interface LegalSourceSearchResult {
  provider: "a2aj" | "journal";
  doc_type: LegalDocumentType;
  source_id?: string | null;
  dataset: string;
  citation: string;
  alternateCitation: string | null;
  name: string | null;
  date: string | null;
  url: string | null;
  snippet: string | null;
}

export interface LegalSourceCoverage {
  dataset: string;
  description: string;
  descriptionFr: string | null;
  docType: "cases" | "laws";
  jurisdictionCode: string;
  jurisdiction: string;
  sourceKind: "court" | "tribunal" | "legislation" | "regulation";
  earliestDate: string | null;
  latestDate: string | null;
  documentCount: number;
}

export type LegalSourceInlineToken =
  | {
      kind: "text" | "em" | "strong" | "code" | "sup" | "sub";
      text: string;
    }
  | { kind: "link"; text: string; href: string };

export type LegalSourcePresentationBlock =
  | {
      kind: "heading";
      text: string;
      inline: LegalSourceInlineToken[];
      level: 2 | 3 | 4 | 5;
    }
  | {
      kind: "provision";
      text: string;
      inline: LegalSourceInlineToken[];
      label: string;
      depth: number;
    }
  | {
      kind: "list-item";
      text: string;
      inline: LegalSourceInlineToken[];
      marker: string;
      ordered: boolean;
      depth: number;
    }
  | {
      kind: "blockquote" | "paragraph";
      text: string;
      inline: LegalSourceInlineToken[];
      depth: number;
    };

export interface LegalSourceViewerPayload {
  schemaVersion: "mike.legal-source.v1";
  provider: "a2aj" | "journal";
  reference: {
    docType: LegalDocumentType;
    citation: string;
    sourceId?: string | null;
    language: "en" | "fr";
    dataset: string | null;
  };
  metadata: {
    title: string;
    citation: string;
    alternateCitation: string | null;
    date: string | null;
    dataset: string;
    url: string | null;
    language: "en" | "fr";
    upstreamLicense: string | null;
    pdfUrl?: string | null;
    authors?: string | null;
    journalName?: string | null;
  };
  text: string;
  structure: {
    status: "usable" | "unavailable";
    source: "native" | "hybrid" | "flat_text" | "section_map";
    blocks: {
      kind: "paragraph" | "page" | "section" | "footnote";
      label: string;
      start: number;
      end: number;
    }[];
    counts: Record<"paragraph" | "page" | "section" | "footnote", number>;
  };
  presentation?: {
    source: "a2aj_markdown";
    segments: {
      start: number;
      end: number;
      blocks: LegalSourcePresentationBlock[];
    }[];
  };
  truncated: boolean;
}

export async function getLibrary(
  kind: LibraryKind,
): Promise<LibraryCollection> {
  return apiRequest<LibraryCollection>(`/library/${kind}`);
}

export async function listLegalLibrary(): Promise<LegalSourceReference[]> {
  return (
    await apiRequest<{ references: LegalSourceReference[] }>("/library/legal")
  ).references;
}

export async function getLegalSourceCoverage(): Promise<
  LegalSourceCoverage[]
> {
  return (
    await apiRequest<{ coverage: LegalSourceCoverage[] }>(
      "/library/legal/coverage",
    )
  ).coverage;
}

export async function searchLegalSources(args: {
  query: string;
  docType: LegalDocumentType;
  language?: "en" | "fr";
  datasets?: string[];
  startDate?: string;
  endDate?: string;
  sortResults?: "default" | "newest_first" | "oldest_first";
}): Promise<LegalSourceSearchResult[]> {
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
}

export async function saveLegalSource(args: {
  citation: string;
  docType: LegalDocumentType;
  language?: "en" | "fr";
  dataset?: string | null;
  sourceId?: string | null;
}): Promise<LegalSourceReference> {
  return jsonRequest<LegalSourceReference>("/library/legal", "POST", {
    citation: args.citation,
    doc_type: args.docType,
    language: args.language ?? "en",
    dataset: args.dataset ?? undefined,
    source_id: args.sourceId ?? undefined,
  });
}

export async function deleteLegalSource(referenceId: string): Promise<void> {
  await apiRequest(`/library/legal/${encodeURIComponent(referenceId)}`, {
    method: "DELETE",
  });
  legalSourceDocumentRequests.delete(
    `/library/legal/${encodeURIComponent(referenceId)}/document`,
  );
}

const legalSourceDocumentRequests = new Map<
  string,
  Promise<LegalSourceViewerPayload>
>();

async function cachedLegalSourceDocument(path: string) {
  const cached = legalSourceDocumentRequests.get(path);
  if (cached) return cached;
  const request = (async () => {
    const response = await fetch(`${API_BASE}${path}`, {
      cache: "default",
      headers: {
        Accept: "application/json",
        ...(await getAuthHeader()),
      },
    });
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as LegalSourceViewerPayload;
  })();
  legalSourceDocumentRequests.set(path, request);
  request.catch(() => legalSourceDocumentRequests.delete(path));
  return request;
}

export function getLegalSourceDocument(referenceId: string) {
  return cachedLegalSourceDocument(
    `/library/legal/${encodeURIComponent(referenceId)}/document`,
  );
}

export function getDirectLegalSourceDocument(args: {
  provider: "a2aj" | "journal";
  citation: string;
  sourceId?: string | null;
  docType?: LegalDocumentType | "auto";
  language?: "en" | "fr";
  dataset?: string | null;
}) {
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
  project_id: string;
  kind: string;
  name: string;
  color: string;
  order: number;
  data: Record<string, unknown>;
}

export interface LegalResearchEdge {
  from_node_id: string;
  to_node_id: string;
  relation: string;
  order: number;
}

interface LegalSourceMark {
  source_id: string;
  project_id: string;
  label_ids: string[];
  note: string;
}

export interface LegalSourceMarking {
  nodes: LegalResearchNode[];
  edges: LegalResearchEdge[];
  mark: LegalSourceMark | null;
}

export async function listLegalResearchProjects() {
  return (
    await apiRequest<{ projects: LegalResearchProject[] }>(
      "/legal-knowledge/projects",
    )
  ).projects;
}

export async function createLegalResearchProject(name: string) {
  return jsonRequest<LegalResearchProject>(
    "/legal-knowledge/projects",
    "POST",
    { name },
  );
}

export async function getLegalSourceMarking(
  projectId: string,
  sourceId: string,
) {
  const query = new URLSearchParams({ source_id: sourceId });
  return apiRequest<LegalSourceMarking>(
    `/legal-knowledge/projects/${encodeURIComponent(projectId)}/marking?${query}`,
  );
}

export async function createLegalResearchLabel(
  projectId: string,
  label: { name: string; color: string; parentId: string | null },
) {
  return jsonRequest<LegalResearchNode>(
    `/legal-knowledge/projects/${encodeURIComponent(projectId)}/nodes`,
    "POST",
    {
      kind: "label",
      name: label.name,
      color: label.color,
      parent_id: label.parentId,
    },
  );
}

export async function saveLegalSourceMark(
  projectId: string,
  sourceId: string,
  mark: { labelIds: string[]; note: string },
) {
  return jsonRequest<LegalSourceMark | null>(
    `/legal-knowledge/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/mark`,
    "PUT",
    { label_ids: mark.labelIds, note: mark.note },
  );
}

export async function uploadLibraryDocument(
  kind: LibraryKind,
  file: File,
): Promise<Document> {
  return multipartRequest<Document>(`/library/${kind}/documents`, file);
}

export async function createLibraryFolder(
  kind: LibraryKind,
  name: string,
  parentFolderId?: string | null,
): Promise<LibraryFolder> {
  return jsonRequest<LibraryFolder>(`/library/${kind}/folders`, "POST", {
    name,
    parent_folder_id: parentFolderId ?? null,
  });
}

export async function renameLibraryFolder(
  kind: LibraryKind,
  folderId: string,
  name: string,
): Promise<LibraryFolder> {
  return jsonRequest<LibraryFolder>(
    `/library/${kind}/folders/${folderId}`,
    "PATCH",
    { name },
  );
}

export async function deleteLibraryFolder(
  kind: LibraryKind,
  folderId: string,
): Promise<void> {
  await apiRequest(`/library/${kind}/folders/${folderId}`, {
    method: "DELETE",
  });
}

export async function moveLibraryFolder(
  kind: LibraryKind,
  folderId: string,
  parentFolderId: string | null,
): Promise<LibraryFolder> {
  return jsonRequest<LibraryFolder>(
    `/library/${kind}/folders/${folderId}`,
    "PATCH",
    { parent_folder_id: parentFolderId },
  );
}

export async function moveLibraryDocument(
  kind: LibraryKind,
  documentId: string,
  folderId: string | null,
): Promise<Document> {
  return jsonRequest<Document>(
    `/library/${kind}/documents/${documentId}/folder`,
    "PATCH",
    { folder_id: folderId },
  );
}

export async function renameLibraryDocument(
  kind: LibraryKind,
  documentId: string,
  filename: string,
): Promise<Document> {
  return jsonRequest<Document>(
    `/library/${kind}/documents/${documentId}`,
    "PATCH",
    { filename },
  );
}

export type DeterministicDocxActionResult = {
  ok: boolean;
  changed?: boolean;
  document_id: string;
  version_id: string;
  filename: string;
  detected?: number;
  converted?: number;
  already_linked?: number;
  review_required?: number;
  linked_citations?: number;
  unresolved_citations?: number;
  strategy?: string | null;
};

export function inspectLibraryDocumentAutomation(documentId: string) {
  return apiRequest<{ supra_references: boolean }>(
    `/library/files/documents/${encodeURIComponent(documentId)}/automation`,
  );
}

export function fixLibraryDocxSupras(documentId: string) {
  return apiRequest<DeterministicDocxActionResult>(
    `/library/files/documents/${encodeURIComponent(documentId)}/actions/fix-supras`,
    { method: "POST" },
  );
}

export function linkLibraryDocxCitations(documentId: string) {
  return apiRequest<DeterministicDocxActionResult>(
    `/library/files/documents/${encodeURIComponent(documentId)}/actions/link-citations`,
    { method: "POST" },
  );
}

export type TableOfAuthoritiesJob = {
  id: string;
  state: string;
  operation: string;
  progress: number;
  message: string;
  error: string;
  has_review: boolean;
  split_fallback: "off" | "auto";
  files: { name: string; size: number; url: string }[];
  app_url: string;
};

export function submitLibraryDocumentToAuthorities(
  documentId: string,
  splitFallback: "off" | "auto" = "auto",
  projectId?: string | null,
) {
  return jsonRequest<TableOfAuthoritiesJob>("/table-of-authorities/jobs", "POST", {
    document_id: documentId,
    split_fallback: splitFallback,
    project_id: projectId || undefined,
  });
}

export async function addDocumentToProject(
  projectId: string,
  documentId: string,
): Promise<Document> {
  return apiRequest<Document>(
    `/projects/${projectId}/documents/${documentId}`,
    { method: "POST" },
  );
}

export async function removeProjectDocument(
  projectId: string,
  documentId: string,
): Promise<void> {
  if (!isAnonymousMode) {
    await deleteDocument(documentId);
    return;
  }
  await apiRequest(`/projects/${projectId}/documents/${documentId}`, {
    method: "DELETE",
  });
}

export interface DocumentVersion {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocumentVersion[];
}> {
  return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
  documentId: string,
  file: File,
  filename?: string,
): Promise<DocumentVersion> {
  return multipartRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions`,
    file,
    { filename },
  );
}

export async function replaceDocumentVersionFile(
  documentId: string,
  versionId: string,
  file: File,
  filename?: string,
): Promise<DocumentVersion> {
  return multipartRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}/file`,
    file,
    { method: "PUT", filename },
  );
}

export async function copyDocumentVersionFromDocument(
  documentId: string,
  sourceDocumentId: string,
  filename?: string,
): Promise<DocumentVersion> {
  return jsonRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions/from-document`,
    "POST",
    { source_document_id: sourceDocumentId, filename },
  );
}

export async function renameDocumentVersion(
  documentId: string,
  versionId: string,
  filename: string | null,
): Promise<DocumentVersion> {
  return jsonRequest<DocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}`,
    "PATCH",
    { filename },
  );
}

export async function deleteDocumentVersion(
  documentId: string,
  versionId: string,
): Promise<{
  deleted_version_id: string;
  current_version_id: string | null;
}> {
  return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
    method: "DELETE",
  });
}

export async function uploadProjectDocument(
  projectId: string,
  file: File,
): Promise<Document> {
  return multipartRequest<Document>(`/projects/${projectId}/documents`, file);
}

export async function uploadStandaloneDocument(file: File): Promise<Document> {
  return multipartRequest<Document>("/single-documents", file);
}

export async function deleteDocument(documentId: string): Promise<void> {
  await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
  documentId: string,
  versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
  documentIds: string[],
): Promise<Blob> {
  return (
    await apiBlobRequest("/single-documents/download-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: documentIds }),
    })
  ).blob;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
  project_id?: string;
}): Promise<{ id: string }> {
  return jsonRequest<{ id: string }>("/chat/create", "POST", payload ?? {});
}

export async function listChats(options?: { limit?: number }): Promise<Chat[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
  return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
  const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
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
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    return {
      id: m.id,
      role: "assistant",
      content:
        events
          ?.filter((e) => e.type === "content")
          .map((e) => (e as { type: "content"; text: string }).text)
          .join("") ?? "",
      citations: m.citations ?? undefined,
      events,
    };
  });
  return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await jsonRequest(`/chat/${chatId}`, "PATCH", { title });
}

export async function updateChatProject(
  chatId: string,
  projectId: string | null,
): Promise<{ id: string; title: string | null; project_id: string | null }> {
  return jsonRequest(`/chat/${chatId}`, "PATCH", { project_id: projectId });
}

export async function deleteChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function listDeletedChats(): Promise<Chat[]> {
  return apiRequest<Chat[]>("/chat/recycling-bin");
}

export async function restoreChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}/restore`, { method: "POST" });
}

export async function permanentlyDeleteChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}/permanent`, { method: "DELETE" });
}

export async function stopChat(chatId: string): Promise<{ stopped: boolean }> {
  return apiRequest<{ stopped: boolean }>(`/chat/${chatId}/stop`, {
    method: "POST",
  });
}

export async function generateChatTitle(
  chatId: string,
  message: string,
): Promise<{ title: string }> {
  return jsonRequest<{ title: string }>(
    `/chat/${chatId}/generate-title`,
    "POST",
    { message },
  );
}

export type CaseLawOpinion = {
  opinionId: number | null;
  apiUrl?: string | null;
  type: string | null;
  author: string | null;
  url: string | null;
  text?: string | null;
  html?: string | null;
};

export async function getCourtlistenerOpinions(
  clusterId: number,
): Promise<CaseLawOpinion[]> {
  const result = await jsonRequest<{ opinions: CaseLawOpinion[] }>(
    "/case-law/case-opinions",
    "POST",
    { clusterId },
  );
  return result.opinions;
}

type StreamCurrentTurn =
  | {
      kind: "message";
      turn_id?: string;
      content: string;
      files?: { filename: string; document_id?: string }[];
      workflow?: { id: string; title: string };
    }
  | {
      kind: "ask_inputs_response";
      content: string;
      files?: { filename: string; document_id?: string }[];
      responses: {
        id: string;
        kind: "choice" | "documents";
        question?: string;
        answer?: string;
        filenames?: string[];
        documents?: { document_id: string; filename: string }[];
        skipped?: boolean;
      }[];
    };

export async function streamChat(payload: {
  messages?: {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
  }[];
  current_turn?: StreamCurrentTurn;
  expected_version?: number;
  chat_id?: string;
  project_id?: string;
  model?: string;
  reasoning_effort?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: { filename: string; document_id: string }[];
  ask_inputs_response?: {
    responses: (
      | {
          id: string;
          kind: "choice";
          question: string;
          answer?: string;
          skipped?: boolean;
        }
      | {
          id: string;
          kind: "documents";
          filenames: string[];
          skipped?: boolean;
        }
    )[];
  };
  signal?: AbortSignal;
}): Promise<Response> {
  const { signal, ...body } = payload;
  return streamRequest("/chat", body, {
    signal,
    accept: "text/event-stream",
  });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
  projectId?: string,
): Promise<TabularReview[]> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
  title?: string;
  document_ids: string[];
  columns_config: { index: number; name: string; prompt: string }[];
  workflow_id?: string;
  project_id?: string;
}): Promise<TabularReview> {
  return jsonRequest<TabularReview>("/tabular-review", "POST", payload);
}

export async function getTabularReview(
  reviewId: string,
): Promise<TabularReviewDetailOut> {
  return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
  reviewId: string,
  payload: {
    title?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    document_ids?: string[];
    project_id?: string | null;
    shared_with?: string[];
  },
): Promise<TabularReview> {
  return jsonRequest<TabularReview>(
    `/tabular-review/${reviewId}`,
    "PATCH",
    payload,
  );
}

export async function getTabularReviewPeople(
  reviewId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
  return jsonRequest<{
    prompt: string;
    source: "preset" | "llm" | "fallback";
  }>("/tabular-review/prompt", "POST", {
    title,
    format: options?.format,
    documentName: options?.documentName,
    tags: options?.tags,
  });
}

export async function uploadReviewDocument(
  reviewId: string,
  file: File,
  options?: {
    projectId?: string;
    documentIds?: string[];
    columnsConfig?: { index: number; name: string; prompt: string }[];
  },
): Promise<Document> {
  const uploaded = options?.projectId
    ? await uploadProjectDocument(options.projectId, file)
    : await uploadStandaloneDocument(file);

  await updateTabularReview(reviewId, {
    columns_config: options?.columnsConfig,
    document_ids: [...(options?.documentIds ?? []), uploaded.id],
  });

  return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
  reviewId: string,
  options?: { model?: string; reasoningEffort?: string },
): Promise<Response> {
  return streamRequest(`/tabular-review/${reviewId}/generate`, {
    model: options?.model,
    reasoning_effort: options?.reasoningEffort,
  });
}

export async function streamTabularChat(
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
): Promise<Response> {
  return streamRequest(`/tabular-review/${reviewId}/chat`, {
    messages,
    chat_id: chat_id ?? undefined,
    review_title: context?.reviewTitle ?? undefined,
    project_name: context?.projectName ?? undefined,
    model: context?.model,
    reasoning_effort: context?.reasoningEffort,
  }, { signal });
}

export interface TRCitationAnnotation {
  type: "tabular_citation";
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
}

interface RawTRMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  annotations?: TRCitationAnnotation[] | null;
  created_at: string;
}

interface TRDisplayMessage {
  role: "user" | "assistant";
  content: string;
  events?: AssistantEvent[];
  annotations?: TRCitationAnnotation[];
}

export interface TRChat {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
  return raw.map((m) => {
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : "",
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    const content =
      events
        ?.filter((e) => e.type === "content")
        .map((e) => (e as { type: "content"; text: string }).text)
        .join("") ?? "";
    return {
      role: "assistant" as const,
      content,
      events,
      annotations: m.annotations ?? undefined,
    };
  });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
  return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
  reviewId: string,
  chatId: string,
): Promise<RawTRMessage[]> {
  return apiRequest<RawTRMessage[]>(
    `/tabular-review/${reviewId}/chats/${chatId}/messages`,
  );
}

export async function deleteTabularChat(
  reviewId: string,
  chatId: string,
): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
    method: "DELETE",
  });
}

export async function renameTabularChat(
  reviewId: string,
  chatId: string,
  title: string,
): Promise<void> {
  await jsonRequest(`/tabular-review/${reviewId}/chats/${chatId}`, "PATCH", {
    title,
  });
}

export async function regenerateTabularCell(
  reviewId: string,
  documentId: string,
  columnIndex: number,
  options?: { model?: string; reasoningEffort?: string },
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> {
  return jsonRequest(`/tabular-review/${reviewId}/regenerate-cell`, "POST", {
    document_id: documentId,
    column_index: columnIndex,
    model: options?.model,
    reasoning_effort: options?.reasoningEffort,
  });
}

export async function clearTabularCells(
  reviewId: string,
  documentIds: string[],
): Promise<void> {
  await jsonRequest(`/tabular-review/${reviewId}/clear-cells`, "POST", {
    document_ids: documentIds,
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["metadata"]["type"];

export async function listWorkflows(type: WorkflowType): Promise<Workflow[]> {
  return apiRequest<Workflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
  return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
  metadata: {
    title: string;
    type: "assistant" | "tabular";
    language?: string | null;
    practice?: string | null;
    jurisdictions?: string[] | null;
  };
  skill_md?: string;
  columns_config?: { index: number; name: string; prompt: string }[];
}): Promise<Workflow> {
  return jsonRequest<Workflow>("/workflows", "POST", payload);
}

export async function updateWorkflow(
  workflowId: string,
  payload: {
    metadata?: {
      title?: string;
      language?: string | null;
      practice?: string | null;
      jurisdictions?: string[] | null;
    };
    skill_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
  },
): Promise<Workflow> {
  return jsonRequest<Workflow>(`/workflows/${workflowId}`, "PATCH", payload);
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function openSourceWorkflow(
  workflowId: string,
  payload: {
    contributor_mode: OpenSourceWorkflowContributorMode;
    contributor?: WorkflowContributor | null;
  },
): Promise<OpenSourceWorkflowResponse> {
  return jsonRequest<OpenSourceWorkflowResponse>(
    `/workflows/${workflowId}/open-source`,
    "POST",
    payload,
  );
}

export async function listHiddenWorkflows(): Promise<string[]> {
  return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
  await jsonRequest("/workflows/hidden", "POST", {
    workflow_id: workflowId,
  });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
  await jsonRequest<void>(`/workflows/${workflowId}/share`, "POST", payload);
}

export async function listWorkflowShares(workflowId: string): Promise<
  {
    id: string;
    shared_with_email: string;
    allow_edit: boolean;
    created_at: string;
  }[]
> {
  return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
  workflowId: string,
  shareId: string,
): Promise<void> {
  await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
    method: "DELETE",
  });
}
