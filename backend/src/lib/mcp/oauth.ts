import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServerSupabase } from "../supabase";
import { sha256 } from "../hash";
import { publicOrigin } from "../publicOrigin";
import {
  bufferRemoteResponse,
  normalizeRemoteHttpsUrl,
  validateRemoteHttpsUrl,
} from "../remoteUrlSafety";
import {
  authHeaders,
  authPatch,
  boundMcpResponse,
  credentialFingerprint,
  guardedMcpFetch,
  loadConnector,
  open,
  readAuth,
  seal,
  validateMcpUrl,
} from "./client";
import {
  CLIENT_INFO,
  MCP_REQUEST_TIMEOUT_MS,
  OAUTH_STATE_TTL_MS,
  type ConnectorRow,
  type Db,
  type OAuthTokenRow,
} from "./types";

const OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_ERRORS = new Set(
  "invalid_request invalid_client invalid_grant unauthorized_client unsupported_grant_type invalid_scope invalid_client_metadata invalid_redirect_uri server_error temporarily_unavailable".split(" "),
);

type Binding = {
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
};

type StoredState = {
  userId: string;
  connectorId: string;
  serverUrl: string;
  redirectUri: string;
  credentialFingerprint: string;
  codeVerifier: string;
  discovery: OAuthDiscoveryState;
};

type StateRow = {
  user_id: string;
  connector_id: string;
  encrypted_state_config: string;
  state_config_iv: string;
  state_config_tag: string;
};

export class McpOAuthRequiredError extends Error {
  constructor() {
    super("OAuth authorization is required for this MCP server.");
    this.name = "McpOAuthRequiredError";
  }
}

const redirectUri = () => `${publicOrigin()}/api/user/mcp-connectors/oauth/callback`;
const scope = () => process.env.MCP_OAUTH_DEFAULT_SCOPE?.trim() || undefined;

async function oauthResponse(response: Response) {
  const bounded = await bufferRemoteResponse(response, {
    label: "OAuth response",
    maxBytes: OAUTH_RESPONSE_BYTES,
    contentTypes: ["application/json", "application/*+json"],
  });
  if (bounded.ok) return bounded;
  const type = bounded.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const body = type === "application/json" || type.endsWith("+json")
    ? await bounded.json().catch(() => null) as { error?: unknown } | null : null;
  const error = typeof body?.error === "string" && OAUTH_ERRORS.has(body.error)
    ? body.error : "server_error";
  return new Response(JSON.stringify({ error }), {
    status: bounded.status, headers: { "content-type": "application/json" },
  });
}

export async function guardedOAuthFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  return oauthResponse(await guardedMcpFetch(input, init));
}

async function validateDiscovery(state: OAuthDiscoveryState, serverUrl: string): Promise<Binding> {
  const resource = state.resourceMetadata;
  const metadata = state.authorizationServerMetadata;
  if (!resource || !metadata) throw new Error("OAuth discovery metadata is incomplete.");
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("OAuth authorization server does not advertise PKCE S256.");
  }
  const authorizationServer = await validateRemoteHttpsUrl(state.authorizationServerUrl, {
    label: "OAuth authorization server",
  });
  const advertised = resource.authorization_servers?.some((candidate) => {
    try {
      return normalizeRemoteHttpsUrl(candidate, { label: "OAuth authorization server" })
        .url.toString() === authorizationServer;
    } catch { return false; }
  });
  if (!advertised) throw new Error("OAuth authorization server was not advertised by the resource.");
  if (await validateRemoteHttpsUrl(metadata.issuer, { label: "OAuth issuer" }) !== authorizationServer) {
    throw new Error("OAuth issuer does not match the authorization server.");
  }
  const [authorizationEndpoint, tokenEndpoint, registrationEndpoint] = await Promise.all([
    validateRemoteHttpsUrl(metadata.authorization_endpoint, { label: "OAuth authorization endpoint" }),
    validateRemoteHttpsUrl(metadata.token_endpoint, { label: "OAuth token endpoint" }),
    metadata.registration_endpoint
      ? validateRemoteHttpsUrl(metadata.registration_endpoint, { label: "OAuth registration endpoint" })
      : null,
  ]);
  await Promise.all([validateMcpUrl(serverUrl), validateMcpUrl(resource.resource)]);
  return { authorizationServer, authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

function configuredClient(serverUrl: string, binding?: Binding) {
  const clientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
  if (!clientId || !binding) return undefined;
  const allowed = new Set((process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS ?? "")
    .split(",").filter(Boolean).map((entry) => {
      const url = new URL(entry.trim());
      if (url.protocol !== "https:" || url.username || url.password ||
          url.pathname !== "/" || url.search || url.hash) {
        throw new Error("MCP_OAUTH_CONFIDENTIAL_ORIGINS must contain HTTPS origins.");
      }
      return url.origin;
    }));
  const destinations = [serverUrl, binding.authorizationServer, binding.authorizationEndpoint,
    binding.tokenEndpoint, binding.registrationEndpoint].filter((value): value is string => Boolean(value));
  if (!destinations.every((value) => allowed.has(new URL(value).origin))) return undefined;
  const secret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret } : {}),
  } satisfies OAuthClientInformationMixed;
}

export async function loadOAuthTokens(connectorIds: string[], db: Db) {
  if (!connectorIds.length) return new Map<string, OAuthTokenRow>();
  const { data, error } = await db.from("user_mcp_oauth_tokens").select("*")
    .in("connector_id", connectorIds);
  if (error) throw error;
  return new Map(((data ?? []) as OAuthTokenRow[]).map((row) => [row.connector_id, row]));
}

export const loadOAuthToken = async (connectorId: string, db: Db) =>
  (await loadOAuthTokens([connectorId], db)).get(connectorId) ?? null;

export async function deleteOAuthToken(connectorId: string, db: Db) {
  const { error } = await db.from("user_mcp_oauth_tokens").delete()
    .eq("connector_id", connectorId);
  if (error) throw error;
}

const secretContext = (connector: ConnectorRow, name: string) =>
  `${connector.user_id}\0${connector.id}\0${name}`;

function secretPatch(connector: ConnectorRow, name: string, value?: string | null) {
  if (!value) return {
    [`encrypted_${name}`]: null, [`${name}_iv`]: null, [`${name}_tag`]: null,
  };
  const encrypted = seal(value, secretContext(connector, name));
  return {
    [`encrypted_${name}`]: encrypted.encrypted,
    [`${name}_iv`]: encrypted.iv,
    [`${name}_tag`]: encrypted.tag,
  };
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private discovery?: OAuthDiscoveryState;
  private binding?: Binding;
  private tokenRevision?: string;
  private readonly stateToken: string;

  constructor(
    private readonly db: Db,
    private readonly connector: ConnectorRow,
    private readonly mode: "authorize" | "connect" | "complete",
    private readonly resumed?: StoredState,
    private readonly lockedBinding?: Binding,
    state: string = globalThis.crypto.randomUUID(),
  ) {
    this.stateToken = state;
    this.discovery = resumed?.discovery;
    this.binding = lockedBinding;
  }

  get redirectUrl() { return redirectUri(); }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Beaver",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope() ? { scope: scope() } : {}),
    };
  }

  state() { return this.stateToken; }
  discoveryState() { return this.discovery; }

  async saveDiscoveryState(state: OAuthDiscoveryState) {
    const binding = await validateDiscovery(state, this.connector.server_url);
    if (this.lockedBinding &&
        JSON.stringify(this.lockedBinding) !== JSON.stringify(binding)) {
      throw new Error("OAuth discovery endpoints changed.");
    }
    this.discovery = state;
    this.binding = binding;
  }

  isOAuthRequest(input: Parameters<typeof fetch>[0]) {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw); url.hash = "";
    return url.pathname.includes("/.well-known/") || Boolean(this.binding && [
      this.binding.tokenEndpoint, this.binding.registrationEndpoint,
    ].includes(url.toString()));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const configured = configuredClient(this.connector.server_url, this.binding);
    if (configured) return configured;
    if (!this.binding) return undefined;
    const row = await loadOAuthToken(this.connector.id, this.db);
    if (!row?.client_id || row.resource !== this.connector.server_url ||
        row.authorization_server !== this.binding.authorizationServer ||
        row.token_endpoint !== this.binding.tokenEndpoint) return undefined;
    this.tokenRevision = row.updated_at;
    const clientSecret = open<string>(row.encrypted_client_secret, row.client_secret_iv,
      row.client_secret_tag, secretContext(this.connector, "client_secret"));
    return { client_id: row.client_id, ...(clientSecret ? { client_secret: clientSecret } : {}) };
  }

  async saveClientInformation(info: OAuthClientInformationMixed) {
    if (!this.binding) throw new Error("OAuth discovery is incomplete.");
    const clientSecret = "client_secret" in info && typeof info.client_secret === "string"
      ? info.client_secret : undefined;
    await this.writeToken({
      connector_id: this.connector.id,
      client_id: info.client_id,
      ...secretPatch(this.connector, "client_secret", clientSecret),
      ...secretPatch(this.connector, "access_token"),
      ...secretPatch(this.connector, "refresh_token"),
      token_type: null, scope: null, expires_at: null,
      authorization_server: this.binding.authorizationServer,
      token_endpoint: this.binding.tokenEndpoint,
      resource: this.connector.server_url,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.mode === "connect" && this.connector.auth_type !== "oauth") return undefined;
    const row = await loadOAuthToken(this.connector.id, this.db);
    if (!row?.encrypted_access_token || row.resource !== this.connector.server_url ||
        (this.binding && (row.authorization_server !== this.binding.authorizationServer ||
          row.token_endpoint !== this.binding.tokenEndpoint))) return undefined;
    const access = open<string>(row.encrypted_access_token, row.access_token_iv,
      row.access_token_tag, secretContext(this.connector, "access_token"));
    if (!access) return undefined;
    const refresh = open<string>(row.encrypted_refresh_token, row.refresh_token_iv,
      row.refresh_token_tag, secretContext(this.connector, "refresh_token"));
    const expiry = row.expires_at ? Date.parse(row.expires_at) : NaN;
    this.tokenRevision = row.updated_at;
    return {
      access_token: access,
      token_type: row.token_type ?? "Bearer",
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(row.scope ? { scope: row.scope } : {}),
      ...(Number.isFinite(expiry) ? { expires_in: Math.max(0, Math.floor((expiry - Date.now()) / 1000)) } : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens) {
    if (!this.binding) throw new Error("OAuth discovery is incomplete.");
    const client = await this.clientInformation();
    const configured = configuredClient(this.connector.server_url, this.binding);
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : null;
    const config = readAuth(this.connector);
    if (this.connector.auth_type !== "oauth" || config.bearerToken) {
      const updatedAt = new Date().toISOString();
      const { data, error } = await this.db.from("user_mcp_connectors").update({
        auth_type: "oauth", ...authPatch({ headers: config.headers }, this.connector),
        updated_at: updatedAt,
      }).eq("id", this.connector.id).eq("user_id", this.connector.user_id)
        .eq("server_url", this.connector.server_url).eq("updated_at", this.connector.updated_at)
        .select("*").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("MCP connector changed during OAuth.");
      Object.assign(this.connector, data);
    }
    await this.writeToken({
      connector_id: this.connector.id,
      ...secretPatch(this.connector, "access_token", tokens.access_token),
      ...(tokens.refresh_token === undefined ? {}
        : secretPatch(this.connector, "refresh_token", tokens.refresh_token)),
      token_type: tokens.token_type ?? "Bearer",
      scope: tokens.scope ?? scope() ?? null,
      expires_at: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
      client_id: client?.client_id ?? null,
      ...secretPatch(this.connector, "client_secret", configured ? undefined
        : "client_secret" in (client ?? {}) && typeof client?.client_secret === "string"
          ? client.client_secret : undefined),
      authorization_server: this.binding.authorizationServer,
      token_endpoint: this.binding.tokenEndpoint,
      resource: this.connector.server_url,
    });
  }

  async redirectToAuthorization(url: URL) {
    if (this.mode !== "authorize") throw new McpOAuthRequiredError();
    if (!this.binding) throw new Error("OAuth discovery is incomplete.");
    const expected = new URL(this.binding.authorizationEndpoint);
    const received = new URL(url);
    if (received.origin !== expected.origin || received.pathname !== expected.pathname ||
        ![...expected.searchParams].every(([key, value]) => received.searchParams.getAll(key).includes(value)) ||
        received.searchParams.get("state") !== this.stateToken ||
        received.searchParams.get("redirect_uri") !== this.redirectUrl ||
        received.searchParams.get("code_challenge_method") !== "S256") {
      throw new Error("OAuth authorization redirect changed.");
    }
    this.authorizationUrl = received;
  }

  async saveCodeVerifier(codeVerifier: string) {
    if (this.mode !== "authorize") return;
    if (!this.discovery || !this.binding) throw new Error("OAuth discovery is incomplete.");
    const state: StoredState = {
      userId: this.connector.user_id,
      connectorId: this.connector.id,
      serverUrl: this.connector.server_url,
      redirectUri: this.redirectUrl,
      credentialFingerprint: credentialFingerprint(this.connector),
      codeVerifier,
      discovery: this.discovery,
    };
    const encrypted = seal(state, `oauth-state\0${sha256(this.stateToken)}`);
    const { error } = await this.db.from("user_mcp_oauth_states").insert({
      user_id: state.userId, connector_id: state.connectorId,
      state_hash: sha256(this.stateToken),
      encrypted_state_config: encrypted.encrypted,
      state_config_iv: encrypted.iv, state_config_tag: encrypted.tag,
      expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
    });
    if (error) throw error;
  }

  codeVerifier() {
    if (!this.resumed?.codeVerifier) throw new Error("OAuth state is invalid or expired.");
    return this.resumed.codeVerifier;
  }

  async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if ((kind === "discovery" || kind === "all") && !this.lockedBinding) {
      this.discovery = undefined; this.binding = undefined;
    }
    if (!["all", "client", "tokens"].includes(kind)) return;
    await deleteOAuthToken(this.connector.id, this.db);
    this.tokenRevision = undefined;
  }

  private async writeToken(patch: Record<string, unknown>) {
    const current = await loadOAuthToken(this.connector.id, this.db);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(current?.updated_at ?? "") + 1 || 0)).toISOString();
    if (current) {
      const expected = this.tokenRevision ?? current.updated_at;
      const { data, error } = await this.db.from("user_mcp_oauth_tokens")
        .update({ ...patch, updated_at: updatedAt }).eq("id", current.id)
        .eq("updated_at", expected).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("OAuth credentials changed concurrently.");
    } else {
      const { error } = await this.db.from("user_mcp_oauth_tokens")
        .insert({ ...patch, updated_at: updatedAt });
      if (error) throw new Error("OAuth credentials changed concurrently.");
    }
    this.tokenRevision = updatedAt;
  }
}

function connectorFetch(connector: ConnectorRow, provider: DbMcpOAuthProvider) {
  const endpoint = new URL(connector.server_url); endpoint.hash = "";
  const configured = authHeaders(readAuth(connector));
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requested.hash = "";
    const headers = new Headers(requested.toString() === endpoint.toString() ? configured : undefined);
    if (typeof Request !== "undefined" && input instanceof Request) {
      input.headers.forEach((value, key) => headers.set(key, value));
    }
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const options = { ...init, headers, redirect: "manual" as const };
    if (provider.isOAuthRequest(input)) return guardedOAuthFetch(input, options);
    const response = await boundMcpResponse(await guardedMcpFetch(input, options));
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function sdk() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  return { Client, StreamableHTTPClientTransport };
}

export async function withRemoteMcp<T>(
  connector: ConnectorRow,
  run: (client: Client) => Promise<T>,
  db: Db = createServerSupabase(),
) {
  await validateMcpUrl(connector.server_url);
  const provider = new DbMcpOAuthProvider(db, connector, "connect");
  const { Client, StreamableHTTPClientTransport } = await sdk();
  const transport = new StreamableHTTPClientTransport(new URL(connector.server_url), {
    authProvider: provider, fetch: connectorFetch(connector, provider),
    requestInit: { redirect: "manual" },
  });
  const client = new Client(CLIENT_INFO, { capabilities: {}, enforceStrictCapabilities: true });
  try {
    await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function startUserMcpConnectorOAuth(
  userId: string,
  connectorId: string,
  db: Db = createServerSupabase(),
) {
  const connector = await loadConnector(userId, connectorId, db);
  await validateMcpUrl(connector.server_url);
  const provider = new DbMcpOAuthProvider(db, connector, "authorize");
  const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const result = await auth(provider, {
    serverUrl: connector.server_url, ...(scope() ? { scope: scope() } : {}),
    fetchFn: guardedOAuthFetch,
  });
  if (result === "AUTHORIZED") return { authorizationUrl: null, alreadyAuthorized: true };
  if (!provider.authorizationUrl) throw new Error("OAuth authorization did not produce a safe redirect.");
  return { authorizationUrl: provider.authorizationUrl.toString(), alreadyAuthorized: false };
}

async function consumeState(state: string, db: Db) {
  const { data, error } = await db.from("user_mcp_oauth_states").delete()
    .eq("state_hash", sha256(state)).gt("expires_at", new Date().toISOString())
    .select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("OAuth state is invalid or expired.");
  return data as StateRow;
}

export async function completeMcpConnectorOAuthAuthorization(
  state: string,
  code: string,
  db: Db = createServerSupabase(),
) {
  const row = await consumeState(state, db);
  const config = open<StoredState>(row.encrypted_state_config, row.state_config_iv,
    row.state_config_tag, `oauth-state\0${sha256(state)}`);
  if (!config || config.userId !== row.user_id || config.connectorId !== row.connector_id ||
      config.redirectUri !== redirectUri()) throw new Error("OAuth state is invalid or expired.");
  const connector = await loadConnector(config.userId, config.connectorId, db);
  if (connector.server_url !== config.serverUrl ||
      credentialFingerprint(connector) !== config.credentialFingerprint) {
    throw new Error("MCP connector credentials changed during OAuth.");
  }
  const binding = await validateDiscovery(config.discovery, connector.server_url);
  const provider = new DbMcpOAuthProvider(
    db, connector, "complete", config, binding,
    state as ReturnType<typeof globalThis.crypto.randomUUID>,
  );
  const { StreamableHTTPClientTransport } = await sdk();
  const transport = new StreamableHTTPClientTransport(new URL(connector.server_url), {
    authProvider: provider, fetch: connectorFetch(connector, provider),
    requestInit: { redirect: "manual" },
  });
  await transport.finishAuth(code);
  return { userId: config.userId, connectorId: config.connectorId };
}
