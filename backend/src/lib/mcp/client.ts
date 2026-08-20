import { sha256 } from "../hash";
import {
  boundRemoteResponse,
  guardedRemoteFetch,
  validateRemoteHttpsUrl,
} from "../remoteUrlSafety";
import { decryptSecret, encryptionSecret, encryptSecret } from "../secretEncryption";
import {
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_SSE_EVENT_BYTES,
  MAX_MCP_SSE_RESPONSE_BYTES,
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
const BLOCKED_HEADERS = new Set(
  "connection content-length forwarded host keep-alive te trailer transfer-encoding upgrade x-forwarded-for x-forwarded-host x-forwarded-proto x-real-ip".split(" "),
);

const encryptionKey = () => encryptionSecret("MCP_CONNECTORS_ENCRYPTION_SECRET");
const authContext = (row: Pick<ConnectorRow, "user_id" | "server_url">) =>
  `${row.user_id}\0${row.server_url}\0auth`;

export function seal(value: unknown, context?: string) {
  return encryptSecret(JSON.stringify(value), encryptionKey(), SALT, context);
}

export function open<T>(encrypted?: string | null, iv?: string | null, tag?: string | null,
  context?: string): T | null {
  if (!encrypted || !iv || !tag) return null;
  try {
    return JSON.parse(decryptSecret({ encrypted, iv, tag }, encryptionKey(), SALT, context)) as T;
  } catch {
    return null;
  }
}

export function readAuth(row: ConnectorRow): McpAuthConfig {
  const value = open<unknown>(row.encrypted_auth_config, row.auth_config_iv,
    row.auth_config_tag, authContext(row));
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as McpAuthConfig : {};
}

export function authPatch(config: McpAuthConfig,
  row: Pick<ConnectorRow, "user_id" | "server_url">) {
  const value = {
    ...(config.bearerToken?.trim() ? { bearerToken: config.bearerToken.trim() } : {}),
    ...(Object.keys(config.headers ?? {}).length ? { headers: config.headers } : {}),
  };
  if (!Object.keys(value).length) return {
    encrypted_auth_config: null, auth_config_iv: null, auth_config_tag: null,
  };
  const encrypted = seal(value, authContext(row));
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
    const normalized = key.toLowerCase();
    if (!HEADER.test(key) || BLOCKED_HEADERS.has(normalized) ||
        normalized.startsWith("proxy-") || normalized.startsWith("sec-")) {
      throw new Error(`Invalid custom header name: ${rawKey}`);
    }
    if (typeof rawValue !== "string" || rawValue.length > 4096 || /[\0\r\n]/u.test(rawValue)) {
      throw new Error(`Custom header ${rawKey} must be a valid value of 4096 characters or fewer.`);
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
  let bytes = 0, total = 0, content = false, cr = false;
  const line = () => { if (!content) bytes = 0; content = false; };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_MCP_SSE_RESPONSE_BYTES)
        throw new Error("MCP SSE response exceeds the size limit.");
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
  return annotations?.readOnlyHint !== true || annotations.destructiveHint === true;
}
