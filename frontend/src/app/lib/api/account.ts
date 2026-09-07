import type { UserPreferences } from "../../../../../shared/user-preferences.mjs";
export type { DraftingDocumentType, CitationPlacement as DraftingCitationPlacement,
  DraftingStyleSettings, FilingContact, WorkflowFileTarget,
  WorkflowFileTargets } from "../../../../../shared/user-preferences.mjs";

import {
  remove,
  apiBlobRequest,
  apiRequest,
  pagePath,
  segment,
  patch,
  put,
  post,
} from "@/app/lib/api/client";

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
export interface UserProfile extends UserPreferences {
  titleModel: string;
  tabularModel: string;
  mfaOnLogin: boolean;
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
  payload: Partial<Pick<UserProfile, keyof UserPreferences>>,
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
