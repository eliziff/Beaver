import crypto from "crypto";
import {
    auth as runMcpOAuth,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServerSupabase } from "../supabase";
import {
    authConfigPatch,
    base64Url,
    decryptAuthConfig,
    decryptString,
    encryptString,
    guardedFetch,
    loadConnector,
    oauthTokenMatchesConnectorCredentials,
    stateHash,
    validateRemoteMcpUrl,
} from "./client";
import {
    CLIENT_INFO,
    MCP_CREDENTIAL_EPOCH_KEY,
    OAUTH_STATE_TTL_MS,
    type ConnectorRow,
    type Db,
    type OAuthEndpointBinding,
    type OAuthMetadata,
    type OAuthStateConfig,
    type OAuthTokenRow,
} from "./types";

const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_HTTP_TIMEOUT_MS = 15_000;

export class McpOAuthRequiredError extends Error {
    code = "oauth_required";
    constructor(
        message = "OAuth authorization is required for this MCP server.",
    ) {
        super(message);
        this.name = "McpOAuthRequiredError";
    }
}

async function cancelResponse(response: Response) {
    try {
        await response.body?.cancel();
    } catch {
        // The useful OAuth error is reported by the caller.
    }
}

function requestSignal(
    input: Parameters<typeof fetch>[0],
    signal?: AbortSignal | null,
) {
    const requestSignal =
        typeof Request !== "undefined" && input instanceof Request
            ? input.signal
            : null;
    const signals = [signal, requestSignal].filter(
        (candidate): candidate is AbortSignal => !!candidate,
    );
    signals.push(AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS));
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function boundedOAuthResponse(response: Response) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
        await cancelResponse(response);
        throw new Error("OAuth response exceeds the size limit.");
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_OAUTH_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error("OAuth response exceeds the size limit.");
            }
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }

    const bytes = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size,
    );
    const body =
        bytes.length > 0 && ![101, 204, 205, 304].includes(response.status)
            ? bytes
            : null;
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

export async function guardedOAuthFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
) {
    const response = await guardedFetch(input, {
        ...init,
        signal: requestSignal(input, init?.signal),
    });
    return boundedOAuthResponse(response);
}

function parseWwwAuthenticate(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i);
    return match?.[1] ?? match?.[2] ?? null;
}

async function fetchJson(url: string, init?: RequestInit) {
    const response = await guardedOAuthFetch(url, init);
    if (!response.ok) {
        await cancelResponse(response);
        throw new Error(`Failed to fetch OAuth metadata (${response.status}).`);
    }
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("OAuth metadata response was not an object.");
    }
    return parsed as Record<string, unknown>;
}

async function discoverProtectedResourceMetadataUrl(serverUrl: string) {
    const attempts: Array<() => Promise<Response>> = [
        () => guardedOAuthFetch(serverUrl, { method: "GET" }),
        () =>
            guardedOAuthFetch(serverUrl, {
                method: "POST",
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: "oauth-discovery",
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: CLIENT_INFO,
                    },
                }),
            }),
    ];
    for (const attempt of attempts) {
        const response = await attempt();
        try {
            if (response.status === 401) {
                const metadataUrl = parseWwwAuthenticate(
                    response.headers.get("www-authenticate"),
                );
                if (metadataUrl) {
                    return new URL(metadataUrl, serverUrl).toString();
                }
            }
        } finally {
            await cancelResponse(response);
        }
    }

    const url = new URL(serverUrl);
    const candidates = [
        `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
        `${url.origin}/.well-known/oauth-protected-resource`,
    ];
    for (const candidate of candidates) {
        try {
            await fetchJson(candidate);
            return candidate;
        } catch {
            // Try the next well-known form.
        }
    }
    throw new McpOAuthRequiredError();
}

async function fetchAuthorizationServerMetadata(
    authorizationServer: string,
): Promise<Record<string, unknown>> {
    const trimmed = authorizationServer.replace(/\/+$/, "");
    const candidates = authorizationServer.includes("/.well-known/")
        ? [authorizationServer]
        : [
              `${trimmed}/.well-known/oauth-authorization-server`,
              `${trimmed}/.well-known/openid-configuration`,
              authorizationServer,
          ];
    let lastError: unknown = null;
    for (const candidate of candidates) {
        try {
            return await fetchJson(candidate);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Failed to discover OAuth authorization server metadata.");
}

export async function discoverOAuthMetadata(
    serverUrl: string,
): Promise<OAuthMetadata> {
    const metadataUrl = await discoverProtectedResourceMetadataUrl(serverUrl);
    const resourceMetadata = await fetchJson(metadataUrl);
    const authServers = resourceMetadata.authorization_servers;
    const authorizationServer =
        Array.isArray(authServers) && typeof authServers[0] === "string"
            ? authServers[0]
            : null;
    if (!authorizationServer) {
        throw new Error(
            "MCP server did not advertise an OAuth authorization server.",
        );
    }
    const authMetadata =
        await fetchAuthorizationServerMetadata(authorizationServer);
    const authorizationEndpoint = authMetadata.authorization_endpoint;
    const tokenEndpoint = authMetadata.token_endpoint;
    if (
        typeof authorizationEndpoint !== "string" ||
        typeof tokenEndpoint !== "string"
    ) {
        throw new Error(
            "OAuth authorization server metadata is missing endpoints.",
        );
    }
    return {
        authorizationServer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint:
            typeof authMetadata.registration_endpoint === "string"
                ? authMetadata.registration_endpoint
                : undefined,
        scopesSupported: Array.isArray(authMetadata.scopes_supported)
            ? authMetadata.scopes_supported.filter(
                  (scope): scope is string => typeof scope === "string",
              )
            : undefined,
    };
}

function exactHttpsUrl(rawUrl: string, label: string) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error(`${label} must be an HTTPS URL without credentials.`);
    }
    url.hash = "";
    return url.toString();
}

function configuredConfidentialOrigins() {
    const configured = process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS?.trim() ?? "";
    if (!configured) return new Set<string>();
    const origins = new Set<string>();
    for (const entry of configured.split(",")) {
        const value = entry.trim();
        if (!value) continue;
        const url = new URL(value);
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                "MCP_OAUTH_CONFIDENTIAL_ORIGINS must contain only comma-separated HTTPS origins.",
            );
        }
        origins.add(url.origin);
    }
    return origins;
}

function endpointBinding(state: OAuthDiscoveryState): OAuthEndpointBinding {
    const authorizationServerUrl = exactHttpsUrl(
        state.authorizationServerUrl,
        "OAuth authorization server",
    );
    const metadata = state.authorizationServerMetadata;
    const issuer = exactHttpsUrl(
        metadata?.issuer || authorizationServerUrl,
        "OAuth issuer",
    );
    if (metadata?.issuer && issuer !== authorizationServerUrl) {
        throw new Error(
            "OAuth issuer does not match the advertised authorization server.",
        );
    }
    return {
        authorizationServerUrl,
        issuer,
        authorizationEndpoint: exactHttpsUrl(
            metadata?.authorization_endpoint ||
                new URL("/authorize", authorizationServerUrl).toString(),
            "OAuth authorization endpoint",
        ),
        tokenEndpoint: exactHttpsUrl(
            metadata?.token_endpoint ||
                new URL("/token", authorizationServerUrl).toString(),
            "OAuth token endpoint",
        ),
        registrationEndpoint: metadata?.registration_endpoint
            ? exactHttpsUrl(
                  metadata.registration_endpoint,
                  "OAuth registration endpoint",
              )
            : null,
    };
}

function sameBinding(left: OAuthEndpointBinding, right: OAuthEndpointBinding) {
    return (
        left.authorizationServerUrl === right.authorizationServerUrl &&
        left.issuer === right.issuer &&
        left.authorizationEndpoint === right.authorizationEndpoint &&
        left.tokenEndpoint === right.tokenEndpoint &&
        left.registrationEndpoint === right.registrationEndpoint
    );
}

function oauthEnvPrefix(serverUrl: string) {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return hostname === "googleapis.com" || hostname.endsWith(".googleapis.com")
        ? "GOOGLE_MCP_OAUTH"
        : "MCP_OAUTH";
}

function oauthScopeFor(serverUrl: string) {
    const prefix = oauthEnvPrefix(serverUrl);
    return (
        process.env[`${prefix}_SCOPE`] || process.env.MCP_OAUTH_DEFAULT_SCOPE
    );
}

function configuredStaticClientIds(serverUrl: string) {
    const prefix = oauthEnvPrefix(serverUrl);
    return new Set(
        [
            process.env[`${prefix}_CLIENT_ID`],
            process.env.MCP_OAUTH_CLIENT_ID,
        ].filter((value): value is string => !!value),
    );
}

function configuredStaticClientId(serverUrl: string) {
    return configuredStaticClientIds(serverUrl).values().next().value;
}

function oauthClientEnvFor(
    serverUrl: string,
    binding: OAuthEndpointBinding | undefined,
) {
    const prefix = oauthEnvPrefix(serverUrl);
    const scope = oauthScopeFor(serverUrl);
    if (!binding) return { scope };
    const allowed = configuredConfidentialOrigins();
    const requiredOrigins = [
        new URL(serverUrl).origin,
        new URL(binding.authorizationServerUrl).origin,
        new URL(binding.issuer).origin,
        new URL(binding.authorizationEndpoint).origin,
        new URL(binding.tokenEndpoint).origin,
    ];
    if (!requiredOrigins.every((origin) => allowed.has(origin))) {
        return { scope };
    }
    const clientId = configuredStaticClientId(serverUrl);
    if (!clientId) return { scope };
    return {
        clientId,
        clientSecret:
            process.env[`${prefix}_CLIENT_SECRET`] ||
            process.env.MCP_OAUTH_CLIENT_SECRET,
        scope,
    };
}

export async function loadOAuthToken(connectorId: string, db: Db) {
    const { data, error } = await db
        .from("user_mcp_oauth_tokens")
        .select("*")
        .eq("connector_id", connectorId)
        .maybeSingle();
    if (error) throw error;
    return (data as OAuthTokenRow | null) ?? null;
}

function tokenSecretPatch(prefix: string, value?: string | null) {
    if (!value) {
        return {
            [`encrypted_${prefix}`]: null,
            [`${prefix}_iv`]: null,
            [`${prefix}_tag`]: null,
        };
    }
    const encrypted = encryptString(value);
    return {
        [`encrypted_${prefix}`]: encrypted.encrypted,
        [`${prefix}_iv`]: encrypted.iv,
        [`${prefix}_tag`]: encrypted.tag,
    };
}

function tokenMatchesBinding(
    token: OAuthTokenRow,
    serverUrl: string,
    binding: OAuthEndpointBinding | undefined,
) {
    if (
        !binding ||
        !token.resource ||
        !token.authorization_server ||
        !token.token_endpoint
    ) {
        return false;
    }
    try {
        return (
            exactHttpsUrl(token.resource, "OAuth resource") === serverUrl &&
            exactHttpsUrl(
                token.authorization_server,
                "OAuth authorization server",
            ) === binding.authorizationServerUrl &&
            exactHttpsUrl(token.token_endpoint, "OAuth token endpoint") ===
                binding.tokenEndpoint
        );
    } catch {
        return false;
    }
}

function validatePersistedState(
    config: OAuthStateConfig,
    connectorServerUrl: string,
    connectorUpdatedAt: string,
) {
    const serverUrl = exactHttpsUrl(connectorServerUrl, "MCP server");
    const persistedRevision = Date.parse(config.connectorUpdatedAt);
    const currentRevision = Date.parse(connectorUpdatedAt);
    if (
        !Number.isFinite(persistedRevision) ||
        !Number.isFinite(currentRevision) ||
        persistedRevision !== currentRevision ||
        config.serverUrl !== serverUrl ||
        config.serverOrigin !== new URL(serverUrl).origin ||
        !config.discoveryState ||
        !config.endpointBinding
    ) {
        throw new Error(
            "OAuth connector or discovery state changed. Start authorization again.",
        );
    }
    const discovered = endpointBinding(config.discoveryState);
    if (!sameBinding(discovered, config.endpointBinding)) {
        throw new Error(
            "OAuth discovery endpoints changed. Start authorization again.",
        );
    }
    return {
        serverUrl,
        discoveryState: config.discoveryState,
        endpointBinding: discovered,
    };
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
    public lastAuthorizeUrl: URL | null = null;
    private savedDiscoveryState: OAuthDiscoveryState | undefined;
    private savedEndpointBinding: OAuthEndpointBinding | undefined;
    private readonly lockedEndpointBinding: OAuthEndpointBinding | undefined;
    private connectorUpdatedAt: string;
    private connectorToolPolicy: Record<string, unknown>;
    private loadedTokenUpdatedAt: string | undefined;

    constructor(
        private readonly db: Db,
        private readonly connector: ConnectorRow,
        private readonly userId: string,
        private readonly mode: "initiate" | "use",
        private readonly redirectUri: string,
        private readonly stateToken = base64Url(crypto.randomBytes(32)),
        initialState?: {
            discoveryState: OAuthDiscoveryState;
            endpointBinding: OAuthEndpointBinding;
        },
    ) {
        this.connectorUpdatedAt = connector.updated_at;
        this.connectorToolPolicy = { ...(connector.tool_policy ?? {}) };
        if (initialState) {
            const discovered = endpointBinding(initialState.discoveryState);
            if (!sameBinding(discovered, initialState.endpointBinding)) {
                throw new Error("OAuth discovery state binding is invalid.");
            }
            this.savedDiscoveryState = initialState.discoveryState;
            this.savedEndpointBinding = discovered;
            this.lockedEndpointBinding = discovered;
        }
    }

    private async consumeConnectorRevision(
        update: Record<string, unknown> = {},
    ) {
        const previousUpdate = Date.parse(this.connectorUpdatedAt);
        const updatedAt = new Date(
            Number.isFinite(previousUpdate)
                ? Math.max(Date.now(), previousUpdate + 1)
                : Date.now(),
        ).toISOString();
        const serverUrl = exactHttpsUrl(
            this.connector.server_url,
            "MCP server",
        );
        const toolPolicy = {
            ...this.connectorToolPolicy,
            [MCP_CREDENTIAL_EPOCH_KEY]: updatedAt,
        };
        const { data, error } = await this.db
            .from("user_mcp_connectors")
            .update({
                ...update,
                tool_policy: toolPolicy,
                updated_at: updatedAt,
            })
            .eq("id", this.connector.id)
            .eq("user_id", this.userId)
            .eq("server_url", serverUrl)
            .eq("updated_at", this.connectorUpdatedAt)
            .select("id")
            .maybeSingle();
        if (error) throw error;
        if (!data) {
            throw new Error(
                "MCP connector changed during OAuth authorization.",
            );
        }
        this.connectorUpdatedAt = updatedAt;
        this.connectorToolPolicy = toolPolicy;
        return updatedAt;
    }

    private tokenMatchesCurrentRevision(token: OAuthTokenRow | null) {
        return oauthTokenMatchesConnectorCredentials(token, {
            tool_policy: this.connectorToolPolicy,
        });
    }

    private async storeTokenRow(
        row: Record<string, unknown>,
        updatedAt: string,
    ) {
        const payload = { ...row, updated_at: updatedAt };
        const updateExisting = async () => {
            const { data, error } = await this.db
                .from("user_mcp_oauth_tokens")
                .update(payload)
                .eq("connector_id", this.connector.id)
                .lte("updated_at", updatedAt)
                .select("id")
                .maybeSingle();
            if (error) throw error;
            return !!data;
        };
        if (await updateExisting()) return;

        const { error: insertError } = await this.db
            .from("user_mcp_oauth_tokens")
            .insert(payload);
        if (!insertError) return;
        if (insertError.code !== "23505") throw insertError;
        if (await updateExisting()) return;
        throw new Error("Newer OAuth credentials are already stored.");
    }

    get redirectUrl() {
        return this.redirectUri;
    }

    get clientMetadata(): OAuthClientMetadata {
        const env = oauthClientEnvFor(
            this.connector.server_url,
            this.savedEndpointBinding,
        );
        return {
            client_name: "Mike",
            redirect_uris: [this.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: env.clientSecret
                ? "client_secret_post"
                : "none",
            ...(env.scope ? { scope: env.scope } : {}),
        };
    }

    state() {
        return this.stateToken;
    }

    saveDiscoveryState(state: OAuthDiscoveryState) {
        const discovered = endpointBinding(state);
        const expected =
            this.lockedEndpointBinding ?? this.savedEndpointBinding;
        if (expected && !sameBinding(expected, discovered)) {
            throw new Error(
                "OAuth discovery endpoints changed during authorization.",
            );
        }
        this.savedDiscoveryState = state;
        this.savedEndpointBinding = discovered;
    }

    discoveryState() {
        return this.savedDiscoveryState;
    }

    isOAuthRequest(input: Parameters<typeof fetch>[0]) {
        const rawUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        const url = new URL(rawUrl);
        if (url.pathname.includes("/.well-known/")) return true;
        const binding = this.savedEndpointBinding;
        if (!binding) return false;
        const candidates = [
            binding.authorizationServerUrl,
            binding.tokenEndpoint,
            binding.registrationEndpoint,
            new URL("/register", binding.authorizationServerUrl).toString(),
        ].filter((candidate): candidate is string => !!candidate);
        url.hash = "";
        return candidates.includes(url.toString());
    }

    async clientInformation(): Promise<
        OAuthClientInformationMixed | undefined
    > {
        const serverUrl = exactHttpsUrl(
            this.connector.server_url,
            "MCP server",
        );
        const env = oauthClientEnvFor(
            this.connector.server_url,
            this.savedEndpointBinding,
        );
        if (env.clientId) {
            return {
                client_id: env.clientId,
                ...(env.clientSecret
                    ? { client_secret: env.clientSecret }
                    : {}),
            };
        }
        const token = await loadOAuthToken(this.connector.id, this.db);
        const blockedStaticClient =
            !env.clientId &&
            !!token?.client_id &&
            configuredStaticClientIds(this.connector.server_url).has(
                token.client_id,
            );
        if (
            token?.client_id &&
            !blockedStaticClient &&
            this.tokenMatchesCurrentRevision(token) &&
            tokenMatchesBinding(token, serverUrl, this.savedEndpointBinding)
        ) {
            const clientSecret = decryptString(
                token.encrypted_client_secret,
                token.client_secret_iv,
                token.client_secret_tag,
            );
            this.loadedTokenUpdatedAt = token.updated_at;
            return {
                client_id: token.client_id,
                ...(clientSecret ? { client_secret: clientSecret } : {}),
            };
        }
        return undefined;
    }

    async saveClientInformation(info: OAuthClientInformationMixed) {
        const binding = this.savedEndpointBinding;
        if (!binding) {
            throw new Error(
                "OAuth client information cannot be saved before discovery.",
            );
        }
        const clientSecret =
            "client_secret" in info && typeof info.client_secret === "string"
                ? info.client_secret
                : undefined;
        const row = {
            connector_id: this.connector.id,
            client_id: info.client_id,
            ...tokenSecretPatch("client_secret", clientSecret),
            ...tokenSecretPatch("access_token"),
            ...tokenSecretPatch("refresh_token"),
            token_type: null,
            scope: null,
            expires_at: null,
            authorization_server: binding.authorizationServerUrl,
            token_endpoint: binding.tokenEndpoint,
            resource: exactHttpsUrl(this.connector.server_url, "MCP server"),
        };
        const updatedAt = await this.consumeConnectorRevision();
        await this.storeTokenRow(row, updatedAt);
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const row = await loadOAuthToken(this.connector.id, this.db);
        const serverUrl = exactHttpsUrl(
            this.connector.server_url,
            "MCP server",
        );
        const resourceMatches = (() => {
            try {
                return (
                    !!row?.resource &&
                    exactHttpsUrl(row.resource, "OAuth resource") === serverUrl
                );
            } catch {
                return false;
            }
        })();
        if (
            !row?.encrypted_access_token ||
            !resourceMatches ||
            !this.tokenMatchesCurrentRevision(row) ||
            (this.savedEndpointBinding &&
                !tokenMatchesBinding(row, serverUrl, this.savedEndpointBinding))
        ) {
            return undefined;
        }
        const accessToken = decryptString(
            row.encrypted_access_token,
            row.access_token_iv,
            row.access_token_tag,
        );
        if (!accessToken) return undefined;
        const refreshToken = decryptString(
            row.encrypted_refresh_token,
            row.refresh_token_iv,
            row.refresh_token_tag,
        );
        const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
        const expiresIn = expiresAt
            ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
            : undefined;
        this.loadedTokenUpdatedAt = row.updated_at;
        return {
            access_token: accessToken,
            token_type: row.token_type ?? "Bearer",
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
            ...(row.scope ? { scope: row.scope } : {}),
            ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
        };
    }

    async saveTokens(tokens: OAuthTokens) {
        const binding = this.savedEndpointBinding;
        if (!binding) {
            throw new Error("OAuth tokens cannot be saved before discovery.");
        }
        const serverUrl = exactHttpsUrl(
            this.connector.server_url,
            "MCP server",
        );
        const existing = await loadOAuthToken(this.connector.id, this.db);
        const existingRefresh =
            existing &&
            this.tokenMatchesCurrentRevision(existing) &&
            tokenMatchesBinding(existing, serverUrl, binding)
                ? decryptString(
                      existing.encrypted_refresh_token,
                      existing.refresh_token_iv,
                      existing.refresh_token_tag,
                  )
                : null;
        const env = oauthClientEnvFor(this.connector.server_url, binding);
        const clientInfo = await this.clientInformation();
        const staticClient = !!(
            env.clientId && clientInfo?.client_id === env.clientId
        );
        const expiresIn =
            typeof tokens.expires_in === "number" ? tokens.expires_in : null;
        const now = Date.now();
        const row = {
            connector_id: this.connector.id,
            ...tokenSecretPatch("access_token", tokens.access_token),
            ...tokenSecretPatch(
                "refresh_token",
                tokens.refresh_token ?? existingRefresh,
            ),
            token_type: tokens.token_type ?? "Bearer",
            scope:
                tokens.scope ??
                oauthScopeFor(this.connector.server_url) ??
                null,
            expires_at: expiresIn
                ? new Date(now + expiresIn * 1000).toISOString()
                : null,
            client_id: clientInfo?.client_id ?? null,
            ...tokenSecretPatch(
                "client_secret",
                !staticClient &&
                    "client_secret" in (clientInfo ?? {}) &&
                    typeof clientInfo?.client_secret === "string"
                    ? clientInfo.client_secret
                    : undefined,
            ),
            authorization_server: binding.authorizationServerUrl,
            token_endpoint: binding.tokenEndpoint,
            resource: serverUrl,
        };
        const authConfig = decryptAuthConfig(this.connector);
        const updatedAt = await this.consumeConnectorRevision({
            auth_type: "oauth",
            ...authConfigPatch({ headers: authConfig.headers }),
        });
        await this.storeTokenRow(row, updatedAt);
        this.loadedTokenUpdatedAt = updatedAt;
    }

    async redirectToAuthorization(authorizationUrl: URL) {
        if (this.mode === "initiate") {
            const expected = this.savedEndpointBinding;
            const expectedUrl = expected
                ? new URL(expected.authorizationEndpoint)
                : null;
            if (
                !expectedUrl ||
                authorizationUrl.origin !== expectedUrl.origin ||
                authorizationUrl.pathname !== expectedUrl.pathname ||
                [...expectedUrl.searchParams].some(
                    ([key, value]) =>
                        !authorizationUrl.searchParams
                            .getAll(key)
                            .includes(value),
                )
            ) {
                throw new Error(
                    "OAuth authorization endpoint changed during authorization.",
                );
            }
            this.lastAuthorizeUrl = authorizationUrl;
            return;
        }
        throw new McpOAuthRequiredError();
    }

    async saveCodeVerifier(codeVerifier: string) {
        if (!this.savedDiscoveryState || !this.savedEndpointBinding) {
            throw new Error(
                "OAuth discovery must complete before authorization state is saved.",
            );
        }
        const serverUrl = exactHttpsUrl(
            this.connector.server_url,
            "MCP server",
        );
        const encrypted = encryptString(
            JSON.stringify({
                codeVerifier,
                redirectUri: this.redirectUri,
                connectorUpdatedAt: this.connectorUpdatedAt,
                serverUrl,
                serverOrigin: new URL(serverUrl).origin,
                discoveryState: this.savedDiscoveryState,
                endpointBinding: this.savedEndpointBinding,
            } satisfies OAuthStateConfig),
        );
        await this.db
            .from("user_mcp_oauth_states")
            .delete()
            .eq("state_hash", stateHash(this.stateToken));
        const { error } = await this.db.from("user_mcp_oauth_states").insert({
            user_id: this.userId,
            connector_id: this.connector.id,
            state_hash: stateHash(this.stateToken),
            encrypted_state_config: encrypted.encrypted,
            state_config_iv: encrypted.iv,
            state_config_tag: encrypted.tag,
            expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
        });
        if (error) throw error;
    }

    async codeVerifier() {
        const { data, error } = await this.db
            .from("user_mcp_oauth_states")
            .select("encrypted_state_config, state_config_iv, state_config_tag")
            .eq("state_hash", stateHash(this.stateToken))
            .gt("expires_at", new Date().toISOString())
            .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("OAuth state is invalid or expired.");
        const decrypted = decryptString(
            String(data.encrypted_state_config),
            String(data.state_config_iv),
            String(data.state_config_tag),
        );
        if (!decrypted) throw new Error("OAuth state could not be decrypted.");
        const parsed = JSON.parse(decrypted) as OAuthStateConfig;
        validatePersistedState(
            parsed,
            this.connector.server_url,
            this.connectorUpdatedAt,
        );
        return parsed.codeVerifier;
    }

    async validateResourceURL(serverUrl: string | URL, resource?: string) {
        const expected = exactHttpsUrl(this.connector.server_url, "MCP server");
        const requested = await validateRemoteMcpUrl(String(serverUrl));
        if (exactHttpsUrl(requested, "MCP server") !== expected) {
            throw new Error(
                "OAuth resource server does not match the connector.",
            );
        }
        if (!resource) return undefined;
        const validated = await validateRemoteMcpUrl(resource);
        if (new URL(validated).origin !== new URL(expected).origin) {
            throw new Error(
                "OAuth resource does not match the connector origin.",
            );
        }
        return new URL(validated);
    }

    async invalidateCredentials(
        scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ) {
        const binding = this.savedEndpointBinding;
        if (
            (scope === "discovery" || scope === "all") &&
            !this.lockedEndpointBinding
        ) {
            this.savedDiscoveryState = undefined;
            this.savedEndpointBinding = undefined;
        }
        if (scope === "verifier") {
            const { error } = await this.db
                .from("user_mcp_oauth_states")
                .delete()
                .eq("state_hash", stateHash(this.stateToken));
            if (error) throw error;
            return;
        }
        if (scope === "tokens" || scope === "all") {
            if (!this.loadedTokenUpdatedAt) return;
            let deletion = this.db
                .from("user_mcp_oauth_tokens")
                .delete()
                .eq("connector_id", this.connector.id)
                .eq(
                    "resource",
                    exactHttpsUrl(this.connector.server_url, "MCP server"),
                )
                .eq("updated_at", this.loadedTokenUpdatedAt);
            if (binding) {
                deletion = deletion
                    .eq("authorization_server", binding.authorizationServerUrl)
                    .eq("token_endpoint", binding.tokenEndpoint);
            }
            const { error } = await deletion;
            if (error) throw error;
            this.loadedTokenUpdatedAt = undefined;
        }
    }
}

export async function startUserMcpConnectorOAuth(
    userId: string,
    connectorId: string,
    redirectUri: string,
    db: Db = createServerSupabase(),
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
    const connector = await loadConnector(userId, connectorId, db);
    const provider = new DbMcpOAuthProvider(
        db,
        connector,
        userId,
        "initiate",
        redirectUri,
    );
    const scope = oauthScopeFor(connector.server_url);
    const result = await runMcpOAuth(provider, {
        serverUrl: connector.server_url,
        ...(scope ? { scope } : {}),
        fetchFn: guardedOAuthFetch,
    });
    if (result === "AUTHORIZED") {
        return { authorizationUrl: null, alreadyAuthorized: true };
    }
    if (!provider.lastAuthorizeUrl) {
        throw new Error(
            "OAuth authorization URL was not returned by the MCP SDK.",
        );
    }
    return {
        authorizationUrl: provider.lastAuthorizeUrl.toString(),
        alreadyAuthorized: false,
    };
}

export async function completeMcpConnectorOAuthAuthorization(
    state: string,
    code: string,
    db: Db = createServerSupabase(),
): Promise<{ userId: string; connectorId: string }> {
    const { data, error } = await db
        .from("user_mcp_oauth_states")
        .select("*")
        .eq("state_hash", stateHash(state))
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("OAuth state is invalid or expired.");
    const row = data as {
        id: string;
        user_id: string;
        connector_id: string;
        encrypted_state_config: string;
        state_config_iv: string;
        state_config_tag: string;
    };
    const decrypted = decryptString(
        row.encrypted_state_config,
        row.state_config_iv,
        row.state_config_tag,
    );
    if (!decrypted) throw new Error("OAuth state could not be decrypted.");
    const config = JSON.parse(decrypted) as OAuthStateConfig;
    const connector = await loadConnector(row.user_id, row.connector_id, db);
    const persisted = validatePersistedState(
        config,
        connector.server_url,
        connector.updated_at,
    );
    const provider = new DbMcpOAuthProvider(
        db,
        connector,
        row.user_id,
        "initiate",
        config.redirectUri,
        state,
        {
            discoveryState: persisted.discoveryState,
            endpointBinding: persisted.endpointBinding,
        },
    );
    const result = await runMcpOAuth(provider, {
        serverUrl: persisted.serverUrl,
        authorizationCode: code,
        fetchFn: guardedOAuthFetch,
    });
    if (result !== "AUTHORIZED") {
        throw new Error("OAuth authorization did not complete.");
    }
    await db.from("user_mcp_oauth_states").delete().eq("id", row.id);
    return { userId: row.user_id, connectorId: row.connector_id };
}
