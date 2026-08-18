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
import {
    bufferRemoteResponse,
    guardedRemoteFetch,
    normalizeRemoteHttpsUrl,
    validateRemoteHttpsUrl,
} from "../remoteUrlSafety";
import {
    authConfigPatch,
    connectorCredentialRevision,
    connectorCredentialsMatch,
    decryptAuthConfig,
    decryptString,
    encryptString,
    loadConnector,
    validateRemoteMcpUrl,
} from "./client";
import {
    MCP_CREDENTIAL_EPOCH_KEY,
    OAUTH_STATE_TTL_MS,
    type ConnectorRow,
    type Db,
    type OAuthTokenRow,
} from "./types";

const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_HTTP_TIMEOUT_MS = 15_000;
const OAUTH_ERROR_CODES = new Set(
    "invalid_request invalid_client invalid_grant unauthorized_client unsupported_grant_type invalid_scope invalid_client_metadata invalid_redirect_uri server_error temporarily_unavailable".split(
        " ",
    ),
);

type OAuthBinding = {
    authorizationServer: string; authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string | null;
};

type StoredOAuthState = {
    userId: string; connectorId: string;
    serverUrl: string; redirectUri: string;
    credentialRevision: string; codeVerifier: string;
    discoveryState: OAuthDiscoveryState;
};

type OAuthStateRow = {
    user_id: string; connector_id: string;
    encrypted_state_config: string; state_config_iv: string;
    state_config_tag: string;
};

type McpAuthModule = typeof import("@modelcontextprotocol/sdk/client/auth.js");

async function runOAuth(
    provider: OAuthClientProvider,
    options: Parameters<McpAuthModule["auth"]>[1],
) {
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    try {
        return await auth(provider, options);
    } catch (error) {
        if (error instanceof McpOAuthRequiredError) throw error;
        throw new Error("OAuth provider request failed.");
    }
}

export class McpOAuthRequiredError extends Error {
    code = "oauth_required";
    constructor() {
        super("OAuth authorization is required for this MCP server.");
        this.name = "McpOAuthRequiredError";
    }
}

export async function guardedOAuthFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
) {
    const response = await guardedRemoteFetch(input, init, {
        label: "OAuth endpoint",
        timeoutMs: OAUTH_HTTP_TIMEOUT_MS,
    });
    const bounded = await bufferRemoteResponse(response, {
        label: "OAuth response",
        maxBytes: MAX_OAUTH_RESPONSE_BYTES,
        contentTypes: ["application/json", "application/*+json"],
    });
    if (bounded.ok) return bounded;

    const mediaType =
        bounded.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ??
        "";
    let code = "server_error";
    if (mediaType === "application/json" || mediaType.endsWith("+json")) {
        const body = (await bounded.json().catch(() => null)) as {
            error?: unknown;
        } | null;
        if (typeof body?.error === "string" && OAUTH_ERROR_CODES.has(body.error)) {
            code = body.error;
        }
    }
    return new Response(JSON.stringify({ error: code }), {
        status: bounded.status,
        headers: { "content-type": "application/json" },
    });
}

function oauthRedirectUri() {
    const base = (
        process.env.API_PUBLIC_URL ||
        process.env.BACKEND_URL ||
        `http://localhost:${process.env.PORT ?? "3001"}`
    ).replace(/\/+$/, "");
    const url = new URL(`${base}/user/mcp-connectors/oauth/callback`);
    const local =
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
        (!local && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error("The MCP OAuth callback URL is not a safe exact URL.");
    }
    return url.toString();
}

async function validateDiscovery(
    state: OAuthDiscoveryState,
    connectorUrl: string,
): Promise<OAuthBinding> {
    const resource = state.resourceMetadata;
    const metadata = state.authorizationServerMetadata;
    if (!resource || !metadata) {
        throw new Error("OAuth discovery metadata is incomplete.");
    }
    if (!metadata.code_challenge_methods_supported?.includes("S256")) {
        throw new Error("OAuth authorization server does not advertise PKCE S256.");
    }

    const authorizationServer = await validateRemoteHttpsUrl(
        state.authorizationServerUrl,
        { label: "OAuth authorization server" },
    );
    const advertised = resource.authorization_servers?.some((candidate) => {
        try {
            return (
                normalizeRemoteHttpsUrl(candidate, {
                    label: "OAuth authorization server",
                }).url.toString() === authorizationServer
            );
        } catch {
            return false;
        }
    });
    if (!advertised) {
        throw new Error("OAuth authorization server was not advertised by the resource.");
    }

    const issuer = await validateRemoteHttpsUrl(metadata.issuer, {
        label: "OAuth issuer",
    });
    if (issuer !== authorizationServer) {
        throw new Error("OAuth issuer does not match the authorization server.");
    }
    const [authorizationEndpoint, tokenEndpoint, registrationEndpoint] =
        await Promise.all([
            validateRemoteHttpsUrl(metadata.authorization_endpoint, {
                label: "OAuth authorization endpoint",
            }),
            validateRemoteHttpsUrl(metadata.token_endpoint, {
                label: "OAuth token endpoint",
            }),
            metadata.registration_endpoint
                ? validateRemoteHttpsUrl(metadata.registration_endpoint, {
                      label: "OAuth registration endpoint",
                  })
                : Promise.resolve(null),
        ]);

    await validateRemoteMcpUrl(connectorUrl);
    await validateRemoteMcpUrl(resource.resource);
    return {
        authorizationServer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
    };
}

function sameBinding(left: OAuthBinding, right: OAuthBinding) {
    return JSON.stringify(left) === JSON.stringify(right);
}

const scope = () => process.env.MCP_OAUTH_DEFAULT_SCOPE?.trim() || undefined;
const configuredClientId = () => process.env.MCP_OAUTH_CLIENT_ID?.trim();

function confidentialOrigins() {
    const origins = new Set<string>();
    for (const entry of (process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS ?? "").split(
        ",",
    )) {
        if (!entry.trim()) continue;
        const url = new URL(entry.trim());
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                "MCP_OAUTH_CONFIDENTIAL_ORIGINS must contain HTTPS origins.",
            );
        }
        origins.add(url.origin);
    }
    return origins;
}

function configuredClient(serverUrl: string, binding?: OAuthBinding) {
    const clientId = configuredClientId();
    if (!clientId || !binding) return undefined;
    const allowed = confidentialOrigins();
    const urls = [serverUrl, ...Object.values(binding)].filter(
        (value): value is string => !!value,
    );
    if (!urls.every((value) => allowed.has(new URL(value).origin))) {
        return undefined;
    }
    const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();
    return {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
    } satisfies OAuthClientInformationMixed;
}

export async function loadOAuthToken(connectorId: string, db: Db) {
    return (await loadOAuthTokens([connectorId], db)).get(connectorId) ?? null;
}

export async function loadOAuthTokens(connectorIds: string[], db: Db) {
    const { data, error } = await db
        .from("user_mcp_oauth_tokens")
        .select("*")
        .in("connector_id", connectorIds);
    if (error) throw error;
    return new Map(
        ((data ?? []) as OAuthTokenRow[]).map((token) => [token.connector_id, token]),
    );
}

export async function deleteOAuthToken(
    connectorId: string,
    resource: string,
    db: Db,
) {
    const { error } = await db
        .from("user_mcp_oauth_tokens")
        .delete()
        .eq("connector_id", connectorId)
        .eq("resource", resource);
    if (error) throw error;
}

function secretPatch(prefix: string, value?: string | null) {
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
    binding?: OAuthBinding,
) {
    if (token.resource !== serverUrl) return false;
    return !binding || (
        token.authorization_server === binding.authorizationServer &&
        token.token_endpoint === binding.tokenEndpoint
    );
}

async function consumeOAuthState(state: string, db: Db) {
    const { data, error } = await db
        .from("user_mcp_oauth_states")
        .delete()
        .eq("state_hash", sha256(state))
        .gt("expires_at", new Date().toISOString())
        .select("*")
        .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("OAuth state is invalid or expired.");
    return data as OAuthStateRow;
}

export class DbMcpOAuthProvider implements OAuthClientProvider {
    authorizationUrl: URL | null = null;
    private discovery?: OAuthDiscoveryState;
    private binding?: OAuthBinding;
    private readonly lockedBinding?: OAuthBinding;
    private readonly stateToken: string;
    private connectorUpdatedAt: string;
    private toolPolicy: Record<string, unknown>;
    private tokenUpdatedAt?: string;

    constructor(
        private readonly db: Db,
        private readonly connector: ConnectorRow,
        private readonly mode: "authorize" | "connect",
        resume?: {
            state: string;
            config: StoredOAuthState;
            binding: OAuthBinding;
        },
    ) {
        this.stateToken = resume?.state ?? globalThis.crypto.randomUUID();
        this.discovery = resume?.config.discoveryState;
        this.binding = resume?.binding;
        this.lockedBinding = resume?.binding;
        this.connectorUpdatedAt = connector.updated_at;
        this.toolPolicy = { ...(connector.tool_policy ?? {}) };
        this.resumedState = resume?.config;
    }

    private readonly resumedState?: StoredOAuthState;

    get redirectUrl() { return oauthRedirectUri(); }

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
        if (this.lockedBinding && !sameBinding(this.lockedBinding, binding)) {
            throw new Error("OAuth discovery endpoints changed.");
        }
        this.discovery = state;
        this.binding = binding;
    }

    isOAuthRequest(input: Parameters<typeof fetch>[0]) {
        const raw = typeof input === "string"
            ? input
            : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw);
        url.hash = "";
        if (url.pathname.includes("/.well-known/")) return true;
        if (!this.binding) return false;
        return [this.binding.tokenEndpoint, this.binding.registrationEndpoint]
            .includes(url.toString());
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        const configured = configuredClient(this.connector.server_url, this.binding);
        if (configured) return configured;
        if (!this.binding) return undefined;

        const row = await loadOAuthToken(this.connector.id, this.db);
        if (
            !row?.client_id ||
            row.client_id === configuredClientId() ||
            !connectorCredentialsMatch(row.updated_at, this.connector) ||
            !tokenMatchesBinding(row, this.connector.server_url, this.binding)
        ) {
            return undefined;
        }
        const clientSecret = decryptString(
            row.encrypted_client_secret,
            row.client_secret_iv,
            row.client_secret_tag,
        );
        this.tokenUpdatedAt = row.updated_at;
        return {
            client_id: row.client_id,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
        };
    }

    async saveClientInformation(info: OAuthClientInformationMixed) {
        if (!this.binding) throw new Error("OAuth discovery is incomplete.");
        const clientSecret =
            "client_secret" in info && typeof info.client_secret === "string"
                ? info.client_secret
                : undefined;
        const updatedAt = await this.advanceCredentialRevision();
        await this.storeTokenRow(
            {
                connector_id: this.connector.id,
                client_id: info.client_id,
                ...secretPatch("client_secret", clientSecret),
                ...secretPatch("access_token"),
                ...secretPatch("refresh_token"),
                token_type: null,
                scope: null,
                expires_at: null,
                authorization_server: this.binding.authorizationServer,
                token_endpoint: this.binding.tokenEndpoint,
                resource: this.connector.server_url,
            },
            updatedAt,
        );
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        if (this.mode === "connect" && this.connector.auth_type !== "oauth") {
            return undefined;
        }
        const row = await loadOAuthToken(this.connector.id, this.db);
        if (
            !row?.encrypted_access_token ||
            !connectorCredentialsMatch(row.updated_at, this.connector) ||
            !tokenMatchesBinding(row, this.connector.server_url, this.binding)
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
        const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
        this.tokenUpdatedAt = row.updated_at;
        return {
            access_token: accessToken,
            token_type: row.token_type ?? "Bearer",
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
            ...(row.scope ? { scope: row.scope } : {}),
            ...(Number.isFinite(expiresAt)
                ? {
                      expires_in: Math.max(
                          0,
                          Math.floor((expiresAt - Date.now()) / 1000),
                      ),
                  }
                : {}),
        };
    }

    async saveTokens(tokens: OAuthTokens) {
        if (!this.binding) throw new Error("OAuth discovery is incomplete.");
        const client = await this.clientInformation();
        const configured = configuredClient(this.connector.server_url, this.binding);
        const expiresIn =
            typeof tokens.expires_in === "number" ? tokens.expires_in : null;
        const updatedAt = await this.advanceCredentialRevision({
            auth_type: "oauth",
            ...authConfigPatch({
                headers: decryptAuthConfig(this.connector).headers,
            }),
        });
        await this.storeTokenRow(
            {
                connector_id: this.connector.id,
                ...secretPatch("access_token", tokens.access_token),
                ...secretPatch("refresh_token", tokens.refresh_token),
                token_type: tokens.token_type ?? "Bearer",
                scope: tokens.scope ?? scope() ?? null,
                expires_at:
                    expiresIn === null
                        ? null
                        : new Date(Date.now() + expiresIn * 1000).toISOString(),
                client_id: client?.client_id ?? null,
                ...secretPatch(
                    "client_secret",
                    configured
                        ? undefined
                        : "client_secret" in (client ?? {}) &&
                            typeof client?.client_secret === "string"
                          ? client.client_secret
                          : undefined,
                ),
                authorization_server: this.binding.authorizationServer,
                token_endpoint: this.binding.tokenEndpoint,
                resource: this.connector.server_url,
            },
            updatedAt,
        );
        this.tokenUpdatedAt = updatedAt;
    }

    async redirectToAuthorization(url: URL) {
        if (this.mode !== "authorize") throw new McpOAuthRequiredError();
        if (!this.binding) throw new Error("OAuth discovery is incomplete.");
        const expected = new URL(this.binding.authorizationEndpoint);
        const received = new URL(url);
        const endpointMatches =
            received.origin === expected.origin &&
            received.pathname === expected.pathname &&
            [...expected.searchParams].every(([key, value]) =>
                received.searchParams.getAll(key).includes(value),
            );
        if (
            !endpointMatches ||
            received.searchParams.get("state") !== this.stateToken ||
            received.searchParams.get("redirect_uri") !== this.redirectUrl ||
            received.searchParams.get("code_challenge_method") !== "S256"
        ) {
            throw new Error("OAuth authorization redirect changed.");
        }
        this.authorizationUrl = received;
    }

    async saveCodeVerifier(codeVerifier: string) {
        if (this.mode !== "authorize") return;
        if (!this.discovery || !this.binding) {
            throw new Error("OAuth discovery is incomplete.");
        }
        const config: StoredOAuthState = {
            userId: this.connector.user_id,
            connectorId: this.connector.id,
            serverUrl: this.connector.server_url,
            redirectUri: this.redirectUrl,
            credentialRevision: connectorCredentialRevision({
                ...this.connector,
                updated_at: this.connectorUpdatedAt,
                tool_policy: this.toolPolicy,
            }),
            codeVerifier,
            discoveryState: this.discovery,
        };
        const encrypted = encryptString(JSON.stringify(config));
        const { error } = await this.db.from("user_mcp_oauth_states").insert({
            user_id: config.userId,
            connector_id: config.connectorId,
            state_hash: sha256(this.stateToken),
            encrypted_state_config: encrypted.encrypted,
            state_config_iv: encrypted.iv,
            state_config_tag: encrypted.tag,
            expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
        });
        if (error) throw error;
    }

    codeVerifier() {
        if (!this.resumedState?.codeVerifier) {
            throw new Error("OAuth state is invalid or expired.");
        }
        return this.resumedState.codeVerifier;
    }

    async invalidateCredentials(
        kind: "all" | "client" | "tokens" | "verifier" | "discovery",
    ) {
        if ((kind === "discovery" || kind === "all") && !this.lockedBinding) {
            this.discovery = undefined;
            this.binding = undefined;
        }
        if (!["all", "client", "tokens"].includes(kind) || !this.tokenUpdatedAt) {
            return;
        }
        const { error } = await this.db
            .from("user_mcp_oauth_tokens")
            .delete()
            .eq("connector_id", this.connector.id)
            .eq("resource", this.connector.server_url)
            .eq("updated_at", this.tokenUpdatedAt);
        if (error) throw error;
        this.tokenUpdatedAt = undefined;
    }

    private async advanceCredentialRevision(
        update: Record<string, unknown> = {},
    ) {
        const previous = Date.parse(this.connectorUpdatedAt);
        const updatedAt = new Date(
            Number.isFinite(previous)
                ? Math.max(Date.now(), previous + 1)
                : Date.now(),
        ).toISOString();
        const toolPolicy = {
            ...this.toolPolicy,
            [MCP_CREDENTIAL_EPOCH_KEY]: updatedAt,
        };
        const { data, error } = await this.db
            .from("user_mcp_connectors")
            .update({ ...update, tool_policy: toolPolicy, updated_at: updatedAt })
            .eq("id", this.connector.id)
            .eq("user_id", this.connector.user_id)
            .eq("server_url", this.connector.server_url)
            .eq("updated_at", this.connectorUpdatedAt)
            .select("id")
            .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("MCP connector changed during OAuth.");
        this.connectorUpdatedAt = updatedAt;
        this.toolPolicy = toolPolicy;
        return updatedAt;
    }

    private async storeTokenRow(row: Record<string, unknown>, updatedAt: string) {
        const value = { ...row, updated_at: updatedAt };
        const update = async () => {
            const { data, error } = await this.db
                .from("user_mcp_oauth_tokens")
                .update(value)
                .eq("connector_id", this.connector.id)
                .lte("updated_at", updatedAt)
                .select("id")
                .maybeSingle();
            if (error) throw error;
            return !!data;
        };
        if (await update()) return;
        const { error } = await this.db.from("user_mcp_oauth_tokens").insert(value);
        if (!error) return;
        if (error.code !== "23505" || !(await update())) {
            throw new Error("Newer OAuth credentials are already stored.");
        }
    }
}

export async function startUserMcpConnectorOAuth(
    userId: string,
    connectorId: string,
    db: Db = createServerSupabase(),
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
    const connector = await loadConnector(userId, connectorId, db);
    await validateRemoteMcpUrl(connector.server_url);
    const provider = new DbMcpOAuthProvider(db, connector, "authorize");
    const result = await runOAuth(provider, {
        serverUrl: connector.server_url,
        ...(scope() ? { scope: scope() } : {}),
        fetchFn: guardedOAuthFetch,
    });
    if (result === "AUTHORIZED") {
        return { authorizationUrl: null, alreadyAuthorized: true };
    }
    if (!provider.authorizationUrl) {
        throw new Error("OAuth authorization did not produce a safe redirect.");
    }
    return {
        authorizationUrl: provider.authorizationUrl.toString(),
        alreadyAuthorized: false,
    };
}

export async function completeMcpConnectorOAuthAuthorization(
    state: string,
    code: string,
    db: Db = createServerSupabase(),
): Promise<{ userId: string; connectorId: string }> {
    const row = await consumeOAuthState(state, db);
    const decrypted = decryptString(
        row.encrypted_state_config,
        row.state_config_iv,
        row.state_config_tag,
    );
    if (!decrypted) throw new Error("OAuth state is invalid or expired.");
    let config: StoredOAuthState;
    try {
        config = JSON.parse(decrypted) as StoredOAuthState;
    } catch {
        throw new Error("OAuth state is invalid or expired.");
    }
    if (
        config.userId !== row.user_id ||
        config.connectorId !== row.connector_id ||
        config.redirectUri !== oauthRedirectUri()
    ) {
        throw new Error("OAuth state is invalid or expired.");
    }
    const connector = await loadConnector(config.userId, config.connectorId, db);
    if (
        connector.server_url !== config.serverUrl ||
        !connectorCredentialsMatch(config.credentialRevision, connector)
    ) {
        throw new Error("MCP connector credentials changed during OAuth.");
    }
    const binding = await validateDiscovery(
        config.discoveryState,
        connector.server_url,
    );
    const provider = new DbMcpOAuthProvider(db, connector, "authorize", {
        state,
        config,
        binding,
    });
    const result = await runOAuth(provider, {
        serverUrl: connector.server_url,
        authorizationCode: code,
        fetchFn: guardedOAuthFetch,
    });
    if (result !== "AUTHORIZED") {
        throw new Error("OAuth authorization did not complete.");
    }
    return { userId: config.userId, connectorId: config.connectorId };
}
