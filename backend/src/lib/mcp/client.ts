import { sha256 } from "../hash";
import {
  boundRemoteResponse,
  guardedRemoteFetch,
  validateRemoteHttpsUrl,
} from "../remoteUrlSafety";
import { decryptSecret, encryptSecret } from "../secretEncryption";
import {
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_SSE_EVENT_BYTES,
  MCP_REQUEST_TIMEOUT_MS,
  type ConnectorRow,
  type Db,
  type McpAuthConfig,
  type McpConnectorSummary,
  type OAuthTokenRow,
  type ToolRow,
} from "./types";

const SALT = "beaver-mcp";
const HEADER = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

function encryptionKey() {
  const key = process.env.MCP_CONNECTORS_ENCRYPTION_SECRET?.trim();
  if (!key) throw new Error("MCP_CONNECTORS_ENCRYPTION_SECRET is not configured");
  return key;
}

export function seal(value: unknown) {
  return encryptSecret(JSON.stringify(value), encryptionKey(), SALT);
}

export function open<T>(encrypted?: string | null, iv?: string | null, tag?: string | null): T | null {
  if (!encrypted || !iv || !tag) return null;
  try {
    return JSON.parse(decryptSecret({ encrypted, iv, tag }, encryptionKey(), SALT)) as T;
  } catch {
    return null;
  }
}

export function readAuth(row: ConnectorRow): McpAuthConfig {
  const value = open<unknown>(row.encrypted_auth_config, row.auth_config_iv, row.auth_config_tag);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as McpAuthConfig : {};
}

export function authPatch(config: McpAuthConfig) {
  const value = {
    ...(config.bearerToken?.trim() ? { bearerToken: config.bearerToken.trim() } : {}),
    ...(Object.keys(config.headers ?? {}).length ? { headers: config.headers } : {}),
  };
  if (!Object.keys(value).length) return {
    encrypted_auth_config: null, auth_config_iv: null, auth_config_tag: null,
  };
  const encrypted = seal(value);
  return {
    encrypted_auth_config: encrypted.encrypted,
    auth_config_iv: encrypted.iv,
    auth_config_tag: encrypted.tag,
  };
}

export function credentialFingerprint(row: ConnectorRow) {
  return sha256(JSON.stringify([
    row.server_url, row.encrypted_auth_config, row.auth_config_iv, row.auth_config_tag,
  ]));
}

export function validateHeaders(value?: Record<string, unknown>) {
  if (!value) return {};
  const entries = Object.entries(value);
  if (entries.length > 20) throw new Error("Custom headers may not exceed 20 entries.");
  return Object.fromEntries(entries.map(([rawKey, rawValue]) => {
    const key = rawKey.trim();
    if (!HEADER.test(key) || key.toLowerCase() === "host") {
      throw new Error(`Invalid custom header name: ${rawKey}`);
    }
    if (typeof rawValue !== "string" || rawValue.length > 4096) {
      throw new Error(`Custom header ${rawKey} must be a string of 4096 characters or fewer.`);
    }
    return [key, rawValue];
  }));
}

export const validateMcpUrl = (url: string) =>
  validateRemoteHttpsUrl(url, { label: "MCP server URL", maxUrlLength: 2048 });

export function authHeaders(config: McpAuthConfig) {
  return {
    ...config.headers,
    ...(config.bearerToken?.trim()
      ? { Authorization: `Bearer ${config.bearerToken.trim()}` } : {}),
  };
}

function limitedSse(body: ReadableStream<Uint8Array>) {
  let bytes = 0, content = false, cr = false;
  const line = () => { if (!content) bytes = 0; content = false; };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (cr) {
          if (byte === 10) { if (++bytes > MAX_MCP_SSE_EVENT_BYTES) throw new Error("MCP SSE event exceeds the size limit."); line(); cr = false; continue; }
          line(); cr = false;
        }
        if (++bytes > MAX_MCP_SSE_EVENT_BYTES) throw new Error("MCP SSE event exceeds the size limit.");
        if (byte === 13) cr = true;
        else if (byte === 10) line();
        else content = true;
      }
      controller.enqueue(chunk);
    },
  }));
}

export async function boundMcpResponse(response: Response) {
  const sse = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    === "text/event-stream";
  if (!sse) return boundRemoteResponse(response, {
    label: "MCP response", maxBytes: MAX_MCP_RESPONSE_BYTES,
  });
  if (!response.body) return response;
  return new Response(limitedSse(response.body), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export const guardedMcpFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  guardedRemoteFetch(input, init, {
    label: "MCP server URL", timeoutMs: MCP_REQUEST_TIMEOUT_MS,
  });

export async function loadConnector(userId: string, connectorId: string, db: Db) {
  const { data, error } = await db.from("user_mcp_connectors").select("*")
    .eq("user_id", userId).eq("id", connectorId).single();
  if (error) throw error;
  return data as ConnectorRow;
}

const hint = (annotations: Record<string, unknown> | null, name: string) =>
  annotations?.[name] === true;

export function connectorSummary(
  row: ConnectorRow,
  tools: ToolRow[] = [],
  token?: OAuthTokenRow | null,
  toolCount = tools.length,
): McpConnectorSummary {
  const auth = readAuth(row);
  return {
    id: row.id, name: row.name, transport: row.transport, serverUrl: row.server_url,
    authType: row.auth_type, enabled: row.enabled,
    hasAuthConfig: Boolean(row.encrypted_auth_config),
    customHeaderKeys: Object.keys(auth.headers ?? {}),
    oauthConnected: row.auth_type === "oauth" && token?.resource === row.server_url
      && Boolean(token.encrypted_access_token),
    toolPolicy: row.tool_policy ?? {},
    tools: tools.map((tool) => ({
      id: tool.id, toolName: tool.tool_name, openaiToolName: tool.openai_tool_name,
      title: tool.title, description: tool.description, enabled: tool.enabled,
      readOnly: hint(tool.annotations, "readOnlyHint"),
      destructive: hint(tool.annotations, "destructiveHint"),
      requiresConfirmation: tool.requires_confirmation, lastSeenAt: tool.last_seen_at,
    })),
    toolCount, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function modelToolName(connector: ConnectorRow, toolName: string) {
  const slug = (value: string, fallback: string, length: number) =>
    (value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback)
      .replace(/_+/g, "_").slice(0, length);
  return `mcp_${slug(connector.name, "connector", 18)}_${slug(toolName, "tool", 30)}_${connector.id.replace(/-/g, "").slice(0, 8)}`;
}

export function requiresConfirmation(annotations?: Record<string, unknown> | null) {
  return annotations?.destructiveHint === true || annotations?.readOnlyHint === false;
}
