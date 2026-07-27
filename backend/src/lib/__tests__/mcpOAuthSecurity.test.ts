import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guardedFetch: vi.fn(),
  loadConnector: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mocks.auth,
}));

vi.mock("../mcp/client", () => ({
  authConfigPatch: () => ({}),
  base64Url: (value: Buffer) => value.toString("base64url"),
  decryptAuthConfig: () => ({}),
  decryptString: (value: string | null) => value,
  encryptString: (value: string) => ({
    encrypted: value,
    iv: "iv",
    tag: "tag",
  }),
  guardedFetch: mocks.guardedFetch,
  loadConnector: mocks.loadConnector,
  oauthTokenMatchesConnectorCredentials: (
    token: { updated_at?: string } | null,
    connector: { tool_policy?: Record<string, unknown> | null },
  ) => {
    const epoch = connector.tool_policy?.__mike_credential_epoch;
    return (
      typeof epoch !== "string" ||
      (!!token?.updated_at &&
        Date.parse(token.updated_at) === Date.parse(epoch))
    );
  },
  stateHash: (value: string) => `hash:${value}`,
  validateRemoteMcpUrl: async (value: string) => new URL(value).toString(),
}));

vi.mock("../supabase", () => ({
  createServerSupabase: vi.fn(),
}));

import {
  completeMcpConnectorOAuthAuthorization,
  DbMcpOAuthProvider,
  guardedOAuthFetch,
} from "../mcp/oauth";
import type {
  ConnectorRow,
  Db,
  OAuthEndpointBinding,
  OAuthTokenRow,
} from "../mcp/types";

function connector(serverUrl = "https://mcp.example/api"): ConnectorRow {
  return {
    id: "connector-1",
    user_id: "user-1",
    name: "Test MCP",
    transport: "streamable_http",
    server_url: serverUrl,
    auth_type: "oauth",
    enabled: true,
    tool_policy: {},
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
  };
}

function discovery(
  tokenEndpoint = "https://auth.example/token",
): OAuthDiscoveryState {
  return {
    authorizationServerUrl: "https://auth.example/",
    authorizationServerMetadata: {
      issuer: "https://auth.example/",
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: tokenEndpoint,
      registration_endpoint: "https://auth.example/register",
      response_types_supported: ["code"],
    },
  };
}

function binding(
  tokenEndpoint = "https://auth.example/token",
): OAuthEndpointBinding {
  return {
    authorizationServerUrl: "https://auth.example/",
    issuer: "https://auth.example/",
    authorizationEndpoint: "https://auth.example/authorize",
    tokenEndpoint,
    registrationEndpoint: "https://auth.example/register",
  };
}

function fakeDb(
  options: {
    token?: Partial<OAuthTokenRow> | null;
    state?: Record<string, unknown> | null;
    connectorUpdateMatches?: boolean;
    connectorUpdatedAt?: string;
    firstTokenUpdateGate?: {
      reached: () => void;
      wait: Promise<void>;
    };
  } = {},
) {
  const writes: Array<{ table: string; value: unknown }> = [];
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  let connectorUpdatedAt = options.connectorUpdatedAt;
  let tokenRow = options.token
    ? {
        updated_at: "2026-07-27T00:00:00.000Z",
        ...options.token,
      }
    : null;
  let tokenUpdateGated = false;
  const db = {
    from(table: string) {
      let action: "select" | "update" | "delete" = "select";
      let updateValue: Record<string, unknown> | undefined;
      const queryFilters = new Map<string, unknown>();
      const query: Record<string, any> = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push({ table, column, value });
          queryFilters.set(column, value);
          return query;
        },
        lte: (column: string, value: unknown) => {
          filters.push({ table, column, value });
          queryFilters.set(column, value);
          return query;
        },
        gt: () => query,
        delete: () => {
          action = "delete";
          return query;
        },
        update: (value: unknown) => {
          action = "update";
          writes.push({ table, value });
          updateValue = value as Record<string, unknown>;
          return query;
        },
        insert: async (value: unknown) => {
          writes.push({ table, value });
          if (table === "user_mcp_oauth_tokens") {
            if (tokenRow) {
              return { error: { code: "23505", message: "duplicate" } };
            }
            tokenRow = value as Partial<OAuthTokenRow>;
          }
          return { error: null };
        },
        upsert: async (value: unknown) => {
          writes.push({ table, value });
          if (table === "user_mcp_oauth_tokens") {
            tokenRow = value as Partial<OAuthTokenRow>;
          }
          return { error: null };
        },
        maybeSingle: async () => {
          if (table === "user_mcp_connectors") {
            const matches =
              options.connectorUpdateMatches !== false &&
              (connectorUpdatedAt === undefined ||
                queryFilters.get("updated_at") === connectorUpdatedAt);
            if (matches && typeof updateValue?.updated_at === "string") {
              connectorUpdatedAt = updateValue.updated_at;
            }
            return {
              data: matches ? { id: "connector-1" } : null,
              error: null,
            };
          }
          if (table === "user_mcp_oauth_tokens" && action === "update") {
            if (options.firstTokenUpdateGate && !tokenUpdateGated) {
              tokenUpdateGated = true;
              options.firstTokenUpdateGate.reached();
              await options.firstTokenUpdateGate.wait;
            }
            const threshold = Date.parse(
              String(queryFilters.get("updated_at")),
            );
            const stored = Date.parse(String(tokenRow?.updated_at));
            if (
              tokenRow &&
              Number.isFinite(threshold) &&
              Number.isFinite(stored) &&
              stored <= threshold
            ) {
              tokenRow = { ...tokenRow, ...updateValue };
              return {
                data: { id: "token-1" },
                error: null,
              };
            }
            return { data: null, error: null };
          }
          return {
            data:
              table === "user_mcp_oauth_tokens"
                ? tokenRow
                : (options.state ?? null),
            error: null,
          };
        },
        then: (
          resolve: (value: { error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve({ error: null }).then(resolve, reject),
      };
      return query;
    },
  } as unknown as Db;
  return {
    db,
    writes,
    filters,
    connectorUpdatedAt: () => connectorUpdatedAt,
    token: () => tokenRow,
  };
}

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.guardedFetch.mockReset();
  mocks.loadConnector.mockReset();
  process.env.MCP_OAUTH_CLIENT_ID = "shared-client";
  process.env.MCP_OAUTH_CLIENT_SECRET = "shared-secret";
  delete process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS;
  delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_MCP_OAUTH_CLIENT_SECRET;
});

afterEach(() => {
  delete process.env.MCP_OAUTH_CLIENT_ID;
  delete process.env.MCP_OAUTH_CLIENT_SECRET;
  delete process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS;
  delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_MCP_OAUTH_CLIENT_SECRET;
});

describe("MCP OAuth security boundaries", () => {
  it("withholds global client credentials unless every bound origin is allowlisted", async () => {
    const { db } = fakeDb();
    const blocked = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    blocked.saveDiscoveryState(discovery());
    await expect(blocked.clientInformation()).resolves.toBeUndefined();
    expect(blocked.clientMetadata.token_endpoint_auth_method).toBe("none");

    process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS =
      "https://mcp.example,https://auth.example";
    const allowed = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    allowed.saveDiscoveryState(discovery());
    await expect(allowed.clientInformation()).resolves.toEqual({
      client_id: "shared-client",
      client_secret: "shared-secret",
    });

    const redirected = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    redirected.saveDiscoveryState(discovery("https://evil.example/token"));
    await expect(redirected.clientInformation()).resolves.toBeUndefined();
  });

  it("does not treat a googleapis lookalike as a Google connector", async () => {
    process.env.GOOGLE_MCP_OAUTH_CLIENT_ID = "google-client";
    process.env.GOOGLE_MCP_OAUTH_CLIENT_SECRET = "google-secret";
    process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS =
      "https://evilgoogleapis.com,https://auth.example";
    const { db } = fakeDb();
    const provider = new DbMcpOAuthProvider(
      db,
      connector("https://evilgoogleapis.com/mcp"),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: "shared-client",
      client_secret: "shared-secret",
    });
  });

  it("does not reuse a stored client at different discovered endpoints", async () => {
    delete process.env.MCP_OAUTH_CLIENT_ID;
    delete process.env.MCP_OAUTH_CLIENT_SECRET;
    const { db } = fakeDb({
      token: {
        connector_id: "connector-1",
        client_id: "stored-client",
        encrypted_client_secret: "stored-secret",
        client_secret_iv: "iv",
        client_secret_tag: "tag",
        resource: "https://mcp.example/api",
        authorization_server: "https://old-auth.example/",
        token_endpoint: "https://old-auth.example/token",
      },
    });
    const provider = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "use",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });

  it("does not let a legacy stored static client bypass the origin allowlist", async () => {
    const { db } = fakeDb({
      token: {
        connector_id: "connector-1",
        client_id: "shared-client",
        encrypted_client_secret: "shared-secret",
        client_secret_iv: "iv",
        client_secret_tag: "tag",
        resource: "https://mcp.example/api",
        authorization_server: "https://auth.example/",
        token_endpoint: "https://auth.example/token",
      },
    });
    const provider = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "use",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(provider.clientInformation()).resolves.toBeUndefined();

    process.env.GOOGLE_MCP_OAUTH_CLIENT_ID = "google-client";
    const { db: googleDb } = fakeDb({
      token: {
        connector_id: "connector-1",
        client_id: "shared-client",
        encrypted_client_secret: "shared-secret",
        client_secret_iv: "iv",
        client_secret_tag: "tag",
        resource: "https://calendar.googleapis.com/mcp",
        authorization_server: "https://auth.example/",
        token_endpoint: "https://auth.example/token",
      },
    });
    const googleProvider = new DbMcpOAuthProvider(
      googleDb,
      connector("https://calendar.googleapis.com/mcp"),
      "user-1",
      "use",
      "https://app.example/oauth/callback",
    );
    googleProvider.saveDiscoveryState(discovery());
    await expect(googleProvider.clientInformation()).resolves.toBeUndefined();
  });

  it("rejects a stale OAuth completion after the connector revision changes", async () => {
    const snapshot = connector();
    const { db, filters, writes } = fakeDb({
      connectorUpdateMatches: false,
    });
    const provider = new DbMcpOAuthProvider(
      db,
      snapshot,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(
      provider.saveTokens({
        access_token: "new-access",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("connector changed");
    expect(filters).toEqual(
      expect.arrayContaining([
        {
          table: "user_mcp_connectors",
          column: "server_url",
          value: snapshot.server_url,
        },
        {
          table: "user_mcp_connectors",
          column: "updated_at",
          value: snapshot.updated_at,
        },
      ]),
    );
    expect(
      writes.filter(({ table }) => table === "user_mcp_oauth_tokens"),
    ).toEqual([]);
  });

  it("lets only one callback consume a connector revision", async () => {
    const snapshot = connector();
    const { db, writes } = fakeDb({
      connectorUpdatedAt: snapshot.updated_at,
    });
    const first = new DbMcpOAuthProvider(
      db,
      snapshot,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    const second = new DbMcpOAuthProvider(
      db,
      snapshot,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    first.saveDiscoveryState(discovery());
    second.saveDiscoveryState(discovery());

    await first.saveTokens({
      access_token: "first-access",
      token_type: "Bearer",
    });
    await expect(
      second.saveTokens({
        access_token: "second-access",
        token_type: "Bearer",
      }),
    ).rejects.toThrow("connector changed");

    const tokenWrites = writes.filter(
      ({ table }) => table === "user_mcp_oauth_tokens",
    );
    expect(tokenWrites.length).toBeGreaterThan(0);
    expect(tokenWrites.at(-1)?.value).toMatchObject({
      encrypted_access_token: "first-access",
    });
    expect(JSON.stringify(tokenWrites)).not.toContain("second-access");
  });

  it("does not let a delayed same-endpoint flow overwrite a newer token", async () => {
    let markReached!: () => void;
    let releaseFirst!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstSnapshot = connector();
    const fixture = fakeDb({
      connectorUpdatedAt: firstSnapshot.updated_at,
      firstTokenUpdateGate: { reached: markReached, wait: release },
    });
    const first = new DbMcpOAuthProvider(
      fixture.db,
      firstSnapshot,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    first.saveDiscoveryState(discovery());

    const delayed = first.saveTokens({
      access_token: "first-access",
      token_type: "Bearer",
    });
    await reached;

    const secondSnapshot = {
      ...firstSnapshot,
      updated_at: fixture.connectorUpdatedAt()!,
      tool_policy: {
        ...firstSnapshot.tool_policy,
        __mike_credential_epoch: fixture.connectorUpdatedAt()!,
      },
    };
    const second = new DbMcpOAuthProvider(
      fixture.db,
      secondSnapshot,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    second.saveDiscoveryState(discovery());
    await second.saveTokens({
      access_token: "second-access",
      token_type: "Bearer",
    });
    releaseFirst();

    await expect(delayed).rejects.toThrow("Newer OAuth credentials");
    expect(fixture.token()).toMatchObject({
      encrypted_access_token: "second-access",
      updated_at: fixture.connectorUpdatedAt(),
    });
  });

  it("cannot invalidate tokens belonging to a different endpoint binding", async () => {
    const tokenUpdatedAt = "2026-07-27T00:00:00.000Z";
    const { db, filters } = fakeDb({
      token: {
        connector_id: "connector-1",
        encrypted_access_token: "old-access",
        access_token_iv: "iv",
        access_token_tag: "tag",
        token_type: "Bearer",
        resource: "https://old.example/mcp",
        authorization_server: "https://auth.example/",
        token_endpoint: "https://auth.example/token",
        updated_at: tokenUpdatedAt,
      },
    });
    const provider = new DbMcpOAuthProvider(
      db,
      connector("https://old.example/mcp"),
      "user-1",
      "use",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "old-access",
    });
    await provider.invalidateCredentials("tokens");

    expect(filters).toEqual(
      expect.arrayContaining([
        {
          table: "user_mcp_oauth_tokens",
          column: "resource",
          value: "https://old.example/mcp",
        },
        {
          table: "user_mcp_oauth_tokens",
          column: "authorization_server",
          value: "https://auth.example/",
        },
        {
          table: "user_mcp_oauth_tokens",
          column: "token_endpoint",
          value: "https://auth.example/token",
        },
        {
          table: "user_mcp_oauth_tokens",
          column: "updated_at",
          value: tokenUpdatedAt,
        },
      ]),
    );
  });

  it("clears tokens when dynamic client registration is rebound", async () => {
    const { db, writes } = fakeDb({
      token: {
        connector_id: "connector-1",
        encrypted_access_token: "old-access",
        encrypted_refresh_token: "old-refresh",
        authorization_server: "https://old-auth.example/",
        token_endpoint: "https://old-auth.example/token",
        resource: "https://mcp.example/api",
      },
    });
    const provider = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());
    await provider.saveClientInformation({
      client_id: "new-client",
      client_secret: "new-secret",
    });

    expect(
      writes.find(({ table }) => table === "user_mcp_oauth_tokens")?.value,
    ).toMatchObject({
      client_id: "new-client",
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      token_type: null,
      scope: null,
      expires_at: null,
      authorization_server: "https://auth.example/",
      token_endpoint: "https://auth.example/token",
    });
  });

  it("does not let stale dynamic registration clear newer tokens", async () => {
    const { db, writes } = fakeDb({
      connectorUpdateMatches: false,
      token: {
        connector_id: "connector-1",
        encrypted_access_token: "newer-access",
        resource: "https://mcp.example/api",
        authorization_server: "https://auth.example/",
        token_endpoint: "https://auth.example/token",
      },
    });
    const provider = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    provider.saveDiscoveryState(discovery());

    await expect(
      provider.saveClientInformation({
        client_id: "stale-client",
        client_secret: "stale-secret",
      }),
    ).rejects.toThrow("connector changed");
    expect(
      writes.filter(({ table }) => table === "user_mcp_oauth_tokens"),
    ).toEqual([]);
  });

  it("keeps the authorization redirect on the exact discovered endpoint", async () => {
    const { db } = fakeDb();
    const provider = new DbMcpOAuthProvider(
      db,
      connector(),
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
    );
    const state = discovery();
    state.authorizationServerMetadata!.authorization_endpoint =
      "https://auth.example/authorize?tenant=beaver";
    provider.saveDiscoveryState(state);

    await expect(
      provider.redirectToAuthorization(
        new URL("https://auth.example/authorize?tenant=beaver&client_id=test"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      provider.redirectToAuthorization(
        new URL("https://auth.example/authorize?client_id=test"),
      ),
    ).rejects.toThrow("endpoint changed");
    await expect(
      provider.redirectToAuthorization(
        new URL("https://auth.example/elsewhere?tenant=beaver&client_id=test"),
      ),
    ).rejects.toThrow("endpoint changed");
  });

  it("rejects callback state after the connector URL changes", async () => {
    const config = {
      codeVerifier: "verifier",
      redirectUri: "https://app.example/oauth/callback",
      connectorUpdatedAt: "2026-07-27T00:00:00.000Z",
      serverUrl: "https://mcp.example/api",
      serverOrigin: "https://mcp.example",
      discoveryState: discovery(),
      endpointBinding: binding(),
    };
    const { db } = fakeDb({
      state: {
        id: "state-1",
        user_id: "user-1",
        connector_id: "connector-1",
        encrypted_state_config: JSON.stringify(config),
        state_config_iv: "iv",
        state_config_tag: "tag",
      },
    });
    mocks.loadConnector.mockResolvedValue(
      connector("https://changed.example/api"),
    );

    await expect(
      completeMcpConnectorOAuthAuthorization("state", "code", db),
    ).rejects.toThrow("connector or discovery state changed");
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("rejects a delayed callback after same-URL credentials change", async () => {
    const initial = connector();
    const initiated = fakeDb({
      connectorUpdatedAt: initial.updated_at,
    });
    const provider = new DbMcpOAuthProvider(
      initiated.db,
      initial,
      "user-1",
      "initiate",
      "https://app.example/oauth/callback",
      "state",
    );
    provider.saveDiscoveryState(discovery());
    await provider.saveClientInformation({
      client_id: "dynamic-client",
      client_secret: "dynamic-secret",
    });
    await provider.saveCodeVerifier("verifier");

    const stateWrite = initiated.writes.find(
      ({ table }) => table === "user_mcp_oauth_states",
    )?.value as Record<string, string>;
    const persisted = JSON.parse(stateWrite.encrypted_state_config) as Record<
      string,
      string
    >;
    expect(persisted.connectorUpdatedAt).toBe(initiated.connectorUpdatedAt());

    const changedRevision = new Date(
      Date.parse(persisted.connectorUpdatedAt) + 1,
    ).toISOString();
    const callback = fakeDb({
      state: {
        id: "state-1",
        user_id: "user-1",
        connector_id: "connector-1",
        encrypted_state_config: stateWrite.encrypted_state_config,
        state_config_iv: stateWrite.state_config_iv,
        state_config_tag: stateWrite.state_config_tag,
      },
    });
    mocks.loadConnector.mockResolvedValue({
      ...initial,
      auth_type: "bearer",
      updated_at: changedRevision,
    });

    await expect(
      completeMcpConnectorOAuthAuthorization("state", "code", callback.db),
    ).rejects.toThrow("connector or discovery state changed");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(
      callback.writes.filter(({ table }) => table === "user_mcp_oauth_tokens"),
    ).toEqual([]);
  });

  it("reuses the encrypted discovery snapshot and rejects endpoint drift", async () => {
    const config = {
      codeVerifier: "verifier",
      redirectUri: "https://app.example/oauth/callback",
      connectorUpdatedAt: "2026-07-27T00:00:00.000Z",
      serverUrl: "https://mcp.example/api",
      serverOrigin: "https://mcp.example",
      discoveryState: discovery(),
      endpointBinding: binding(),
    };
    const { db } = fakeDb({
      state: {
        id: "state-1",
        user_id: "user-1",
        connector_id: "connector-1",
        encrypted_state_config: JSON.stringify(config),
        state_config_iv: "iv",
        state_config_tag: "tag",
      },
    });
    mocks.loadConnector.mockResolvedValue(connector());
    mocks.auth.mockImplementationOnce(async (provider, options) => {
      expect(options.serverUrl).toBe("https://mcp.example/api");
      expect(provider.discoveryState()).toEqual(config.discoveryState);
      expect(() =>
        provider.saveDiscoveryState(discovery("https://evil.example/token")),
      ).toThrow("endpoints changed");
      return "AUTHORIZED";
    });

    await expect(
      completeMcpConnectorOAuthAuthorization("state", "code", db),
    ).resolves.toEqual({
      userId: "user-1",
      connectorId: "connector-1",
    });
  });

  it("caps OAuth bodies and supplies a transport timeout signal", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.guardedFetch.mockImplementationOnce(
      async (_input, init: RequestInit) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(
      guardedOAuthFetch("https://auth.example/token"),
    ).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });
});
