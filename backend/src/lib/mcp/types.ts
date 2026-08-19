import { createServerSupabase } from "../supabase";

export type Db = ReturnType<typeof createServerSupabase>;
export type McpAuthConfig = {
  bearerToken?: string;
  headers?: Record<string, string>;
};

export type ConnectorRow = {
  id: string;
  user_id: string;
  name: string;
  transport: "streamable_http";
  server_url: string;
  auth_type: "none" | "bearer" | "oauth";
  enabled: boolean;
  tool_policy: Record<string, unknown> | null;
  encrypted_auth_config: string | null;
  auth_config_iv: string | null;
  auth_config_tag: string | null;
  created_at: string;
  updated_at: string;
};

export type OAuthTokenRow = {
  id: string;
  connector_id: string;
  encrypted_access_token: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  encrypted_refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  authorization_server: string | null;
  token_endpoint: string | null;
  client_id: string | null;
  encrypted_client_secret: string | null;
  client_secret_iv: string | null;
  client_secret_tag: string | null;
  resource: string | null;
  updated_at: string;
};

export type ToolRow = {
  id: string;
  connector_id: string;
  tool_name: string;
  openai_tool_name: string;
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  enabled: boolean;
  requires_confirmation: boolean;
  last_seen_at: string;
};

export type McpToolSummary = {
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
};

export type McpConnectorSummary = {
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
};

export type McpToolEvent = {
  type: "mcp_tool_call";
  connector_id: string;
  connector_name: string;
  tool_name: string;
  openai_tool_name: string;
  status: "ok" | "error";
  error?: string;
};

export const CLIENT_INFO = { name: "beaver", version: "1.0.0" };
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
export const MAX_MCP_SSE_EVENT_BYTES = 256 * 1024;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
