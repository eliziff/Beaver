import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guardedRemoteFetch: vi.fn(),
  loadConnector: vi.fn(),
  validateRemoteHttpsUrl: vi.fn(),
  validateMcpUrl: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: mocks.auth }));

vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: mocks.guardedRemoteFetch,
  validateRemoteHttpsUrl: mocks.validateRemoteHttpsUrl,
}));

vi.mock("../mcp/client", () => ({
  authHeaders: () => ({}),
  authPatch: () => ({}),
  boundMcpResponse: (response: Response) => response,
  credentialFingerprint: (value: {
    server_url: string;
    encrypted_auth_config: string | null;
    auth_config_iv: string | null;
    auth_config_tag: string | null;
  }) => JSON.stringify([
    value.server_url, value.encrypted_auth_config, value.auth_config_iv,
    value.auth_config_tag,
  ]),
  guardedMcpFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => mocks.guardedRemoteFetch(input, init, {
    label: "MCP server URL", timeoutMs: 30_000,
  }),
  loadConnector: mocks.loadConnector,
  open: (value: string | null) => value ? JSON.parse(value) : null,
  readAuth: () => ({}),
  seal: (value: unknown) => ({ encrypted: JSON.stringify(value), iv: "iv", tag: "tag" }),
  validateMcpUrl: mocks.validateMcpUrl,
}));

vi.mock("../supabase", () => ({ createServerSupabase: vi.fn() }));

import {
  completeMcpConnectorOAuthAuthorization,
  DbMcpOAuthProvider,
  guardedOAuthFetch,
  startUserMcpConnectorOAuth,
} from "../mcp/oauth";
import type { ConnectorRow, OAuthTokenRow } from "../mcp/types";
import { mcpDatabase, seedMcpConnector } from "./support/mcpDatabase";

const initialRevision = "2026-07-27T00:00:00.000Z";

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
    created_at: initialRevision,
    updated_at: initialRevision,
  };
}

function discovery(
  overrides: {
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    resource?: string;
  } = {},
): OAuthDiscoveryState {
  return {
    authorizationServerUrl: "https://auth.example/",
    resourceMetadata: {
      resource: overrides.resource ?? "https://mcp.example/api",
      authorization_servers: ["https://auth.example/"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example/",
      authorization_endpoint:
        overrides.authorizationEndpoint ?? "https://auth.example/authorize",
      token_endpoint:
        overrides.tokenEndpoint ?? "https://auth.example/token",
      registration_endpoint: "https://auth.example/register",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
  };
}

type StateRow = {
  id: string;
  user_id: string;
  connector_id: string;
  state_hash: string;
  encrypted_state_config: string;
  state_config_iv: string;
  state_config_tag: string;
  expires_at: string;
};

const databases: ReturnType<typeof mcpDatabase>[] = [];
function fakeDb(options: { token?: Partial<OAuthTokenRow> | null } = {}) {
  const fixture = mcpDatabase();
  databases.push(fixture);
  seedMcpConnector(fixture.native, connector());
  if (options.token) {
    const value = { id: "token-1", connector_id: "connector-1",
      created_at: initialRevision, updated_at: initialRevision, ...options.token };
    const columns = Object.keys(value);
    fixture.native.prepare(`INSERT INTO user_mcp_oauth_tokens(${columns.join(",")}) VALUES(${
      columns.map(() => "?").join(",")})`).run(...Object.values(value).map((item) => item ?? null));
  }
  return {
    ...fixture,
    state: () => fixture.native.prepare("SELECT * FROM user_mcp_oauth_states").get() as StateRow | undefined,
    token: () => fixture.native.prepare("SELECT * FROM user_mcp_oauth_tokens").get() as OAuthTokenRow | undefined,
    expireState: () => fixture.native.prepare(
      "UPDATE user_mcp_oauth_states SET expires_at='2000-01-01T00:00:00.000Z'",
    ).run(),
    changeStateOwner: () => fixture.native.prepare(
      "UPDATE user_mcp_oauth_states SET user_id='user-2'",
    ).run(),
  };
}

async function persistState(fixture: ReturnType<typeof fakeDb>, value = connector()) {
  const provider = new DbMcpOAuthProvider(fixture.db, value, "authorize");
  await provider.saveDiscoveryState(
    discovery({ resource: value.server_url }),
  );
  await provider.saveClientInformation({ client_id: "dynamic-client" });
  await provider.saveCodeVerifier("verifier");
  return provider.state();
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_ORIGIN = "https://app.example";
  delete process.env.MCP_OAUTH_CLIENT_ID;
  delete process.env.MCP_OAUTH_CLIENT_SECRET;
  delete process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS;
  mocks.validateRemoteHttpsUrl.mockImplementation(async (value: string) =>
    new URL(value).toString(),
  );
  mocks.validateMcpUrl.mockImplementation(async (value: string) =>
    new URL(value).toString(),
  );
  mocks.guardedRemoteFetch.mockResolvedValue(new Response(JSON.stringify({
    access_token: "access-token",
    token_type: "Bearer",
  }), { headers: { "content-type": "application/json" } }));
});

afterEach(async () => {
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.MCP_OAUTH_CLIENT_ID;
  delete process.env.MCP_OAUTH_CLIENT_SECRET;
  delete process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS;
  await Promise.all(databases.splice(0).map(({ db }) => db.close()));
});

describe("MCP OAuth security boundary", () => {
  it("uses distinct cryptographically random state values", () => {
    const fixture = fakeDb();
    const first = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    const second = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    expect(first.state()).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    expect(second.state()).not.toBe(first.state());
  });

  it("consumes callback state exactly once", async () => {
    const fixture = fakeDb();
    const state = await persistState(fixture);
    mocks.loadConnector.mockResolvedValue(connector());
    mocks.auth.mockResolvedValue("AUTHORIZED");

    await expect(
      completeMcpConnectorOAuthAuthorization(state, "code", fixture.db),
    ).resolves.toEqual({ userId: "user-1", connectorId: "connector-1" });
    await expect(
      completeMcpConnectorOAuthAuthorization(state, "code", fixture.db),
    ).rejects.toThrow("invalid or expired");
  });

  it("rejects expired state before loading a connector", async () => {
    const fixture = fakeDb();
    const state = await persistState(fixture);
    fixture.expireState();

    await expect(
      completeMcpConnectorOAuthAuthorization(state, "code", fixture.db),
    ).rejects.toThrow("invalid or expired");
    expect(mocks.loadConnector).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("makes cross-owner state indistinguishable from missing state", async () => {
    const fixture = fakeDb();
    const state = await persistState(fixture);
    fixture.changeStateOwner();

    const crossOwner = completeMcpConnectorOAuthAuthorization(
      state,
      "code",
      fixture.db,
    ).catch((error: Error) => error.message);
    const missing = completeMcpConnectorOAuthAuthorization(
      "missing",
      "code",
      fakeDb().db,
    ).catch((error: Error) => error.message);
    await expect(crossOwner).resolves.toBe("OAuth state is invalid or expired.");
    await expect(missing).resolves.toBe("OAuth state is invalid or expired.");
  });

  it("binds state to actor, connector, callback, and credential revision", async () => {
    const fixture = fakeDb();
    const state = await persistState(fixture);
    const stored = JSON.parse(
      fixture.state()!.encrypted_state_config,
    ) as Record<string, string>;
    expect(stored).toMatchObject({
      userId: "user-1",
      connectorId: "connector-1",
      serverUrl: "https://mcp.example/api",
      redirectUri:
        "https://app.example/api/user/mcp-connectors/oauth/callback",
      credentialFingerprint: JSON.stringify([
        "https://mcp.example/api", null, null, null,
      ]),
    });

    mocks.loadConnector.mockResolvedValue({
      ...connector(),
      encrypted_auth_config: "changed",
      auth_config_iv: "iv",
      auth_config_tag: "tag",
    });
    await expect(
      completeMcpConnectorOAuthAuthorization(state, "code", fixture.db),
    ).rejects.toThrow("credentials changed");
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("fails closed when the exact callback URL changes", async () => {
    const fixture = fakeDb();
    const state = await persistState(fixture);
    process.env.PUBLIC_ORIGIN = "https://other.example";

    await expect(
      completeMcpConnectorOAuthAuthorization(state, "code", fixture.db),
    ).rejects.toThrow("invalid or expired");
    expect(mocks.loadConnector).not.toHaveBeenCalled();
  });

  it("allows only one concurrent refresh to rotate stored credentials", async () => {
    const currentToken = {
      connector_id: "connector-1",
      id: "token-1",
      encrypted_access_token: JSON.stringify("old-access"),
      access_token_iv: "iv",
      access_token_tag: "tag",
      encrypted_refresh_token: JSON.stringify("old-refresh"),
      refresh_token_iv: "iv",
      refresh_token_tag: "tag",
      token_type: "Bearer",
      client_id: "client",
      resource: "https://mcp.example/api",
      authorization_server: "https://auth.example/",
      token_endpoint: "https://auth.example/token",
      updated_at: initialRevision,
    };
    const fixture = fakeDb({ token: currentToken });
    const first = new DbMcpOAuthProvider(fixture.db, connector(), "connect");
    const second = new DbMcpOAuthProvider(fixture.db, connector(), "connect");
    await first.saveDiscoveryState(discovery());
    await second.saveDiscoveryState(discovery());
    await Promise.all([first.tokens(), second.tokens()]);

    const results = await Promise.allSettled([
      first.saveTokens({
        access_token: "first-access",
        refresh_token: "first-refresh",
        token_type: "Bearer",
      }),
      second.saveTokens({
        access_token: "second-access",
        refresh_token: "second-refresh",
        token_type: "Bearer",
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect([JSON.stringify("first-access"), JSON.stringify("second-access")]).toContain(
      fixture.token()?.encrypted_access_token,
    );
  });

  it("keeps confidential client credentials behind an exact origin allowlist", async () => {
    process.env.MCP_OAUTH_CLIENT_ID = "static-client";
    process.env.MCP_OAUTH_CLIENT_SECRET = "static-secret";
    const fixture = fakeDb();
    const provider = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    await provider.saveDiscoveryState(discovery());
    await expect(provider.clientInformation()).resolves.toBeUndefined();

    process.env.MCP_OAUTH_CONFIDENTIAL_ORIGINS =
      "https://mcp.example,https://auth.example";
    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: "static-client",
      client_secret: "static-secret",
    });
  });

  it("rejects missing S256 support and SSRF destinations from discovery", async () => {
    const fixture = fakeDb();
    const provider = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    const missingPkce = discovery();
    missingPkce.authorizationServerMetadata!.code_challenge_methods_supported = [];
    await expect(provider.saveDiscoveryState(missingPkce)).rejects.toThrow(
      "PKCE S256",
    );

    mocks.validateRemoteHttpsUrl.mockImplementation(async (value: string) => {
      if (new URL(value).hostname === "127.0.0.1") {
        throw new Error("blocked network address");
      }
      return new URL(value).toString();
    });
    await expect(
      provider.saveDiscoveryState(
        discovery({ tokenEndpoint: "https://127.0.0.1/token" }),
      ),
    ).rejects.toThrow("blocked network address");
  });

  it("never reuses dynamic client registration across OAuth endpoints", async () => {
    const fixture = fakeDb({ token: {
      id: "token-1",
      connector_id: "connector-1",
      client_id: "dynamic-client",
      resource: "https://mcp.example/api",
      authorization_server: "https://auth.example/",
      token_endpoint: "https://auth.example/token",
      updated_at: initialRevision,
    } });
    const provider = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    await provider.saveDiscoveryState(discovery({
      tokenEndpoint: "https://auth.example/other-token",
    }));
    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });

  it("accepts only the exact discovered authorization redirect", async () => {
    const fixture = fakeDb();
    const provider = new DbMcpOAuthProvider(fixture.db, connector(), "authorize");
    await provider.saveDiscoveryState(
      discovery({
        authorizationEndpoint:
          "https://auth.example/authorize?tenant=beaver",
      }),
    );
    const valid = new URL(
      "https://auth.example/authorize?tenant=beaver&code_challenge=x&code_challenge_method=S256",
    );
    valid.searchParams.set("state", provider.state());
    valid.searchParams.set("redirect_uri", provider.redirectUrl);
    await expect(provider.redirectToAuthorization(valid)).resolves.toBeUndefined();

    const malicious = new URL(valid);
    malicious.pathname = "/redirect";
    await expect(provider.redirectToAuthorization(malicious)).rejects.toThrow(
      "redirect changed",
    );
  });

  it("does not follow OAuth redirects", async () => {
    mocks.guardedRemoteFetch.mockResolvedValue(
      new Response("redirect body", {
        status: 302,
        headers: {
          location: "https://127.0.0.1/metadata",
          "content-type": "text/html",
        },
      }),
    );
    const response = await guardedOAuthFetch("https://auth.example/metadata");
    expect(response.status).toBe(302);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(mocks.guardedRemoteFetch).toHaveBeenCalledOnce();
  });

  it("caps OAuth response bodies and keeps abort/timeouts at the guard", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    mocks.guardedRemoteFetch.mockResolvedValueOnce(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    await expect(
      guardedOAuthFetch("https://auth.example/token"),
    ).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);

    const controller = new AbortController();
    mocks.guardedRemoteFetch.mockImplementationOnce(
      async (_input, init, policy) => {
        expect(init?.signal).toBe(controller.signal);
        expect(policy).toMatchObject({ timeoutMs: 30_000 });
        throw new DOMException("aborted", "AbortError");
      },
    );
    controller.abort();
    await expect(
      guardedOAuthFetch("https://auth.example/token", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes provider bodies and descriptions from OAuth errors", async () => {
    const secret = "authorization-code-and-token-secret";
    mocks.guardedRemoteFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: secret,
          refresh_token: secret,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await guardedOAuthFetch("https://auth.example/token");
    const text = await response.text();
    expect(text).toBe('{"error":"invalid_grant"}');
    expect(text).not.toContain(secret);
  });

  it("rejects successful OAuth responses with a non-JSON content type", async () => {
    mocks.guardedRemoteFetch.mockResolvedValue(
      new Response("<html>not OAuth JSON</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(
      guardedOAuthFetch("https://auth.example/token"),
    ).rejects.toThrow("unsupported content type");
  });

  it("loads connectors through the actor-bound start path", async () => {
    mocks.loadConnector.mockRejectedValue(new Error("Connector not found."));
    await expect(
      startUserMcpConnectorOAuth("user-2", "connector-1", fakeDb().db),
    ).rejects.toThrow("Connector not found");
    expect(mocks.loadConnector).toHaveBeenCalledWith(
      "user-2",
      "connector-1",
      expect.anything(),
    );
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
