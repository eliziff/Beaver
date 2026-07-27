import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authConfigPatch: vi.fn(),
  decryptAuthConfig: vi.fn(),
  loadConnector: vi.fn(),
  validateCustomHeaders: vi.fn(),
  validateRemoteMcpUrl: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));
vi.mock("../mcp/oauth", () => ({
  completeMcpConnectorOAuthAuthorization: vi.fn(),
  DbMcpOAuthProvider: class {},
  discoverOAuthMetadata: vi.fn(),
  guardedOAuthFetch: vi.fn(),
  loadOAuthToken: vi.fn(),
  McpOAuthRequiredError: class extends Error {},
  startUserMcpConnectorOAuth: vi.fn(),
}));
vi.mock("../mcp/client", () => ({
  authConfigPatch: mocks.authConfigPatch,
  boundMcpResponse: vi.fn(),
  decryptAuthConfig: mocks.decryptAuthConfig,
  guardedFetch: vi.fn(),
  headersForAuth: vi.fn(() => ({})),
  loadConnector: mocks.loadConnector,
  mcpOAuthCallbackUrl: vi.fn(() => "https://app.example/oauth/callback"),
  normalizeJsonSchema: vi.fn(),
  openaiToolName: vi.fn(),
  toConnectorSummary: (connector: Record<string, unknown>) => ({
    id: connector.id,
    serverUrl: connector.server_url,
  }),
  toolRequiresConfirmation: vi.fn(),
  validateCustomHeaders: mocks.validateCustomHeaders,
  validateRemoteMcpUrl: mocks.validateRemoteMcpUrl,
}));
vi.mock("../supabase", () => ({
  createServerSupabase: vi.fn(),
}));

import { buildUserMcpTools, updateUserMcpConnector } from "../mcp/servers";
import type { ConnectorRow, Db } from "../mcp/types";

type Operation = {
  table: string;
  action: "update" | "delete";
  value?: Record<string, unknown>;
};

function connector(serverUrl = "https://mcp.example/old"): ConnectorRow {
  return {
    id: "connector-1",
    user_id: "user-1",
    name: "MCP",
    transport: "streamable_http",
    server_url: serverUrl,
    auth_type: "oauth",
    enabled: true,
    tool_policy: { existing: "keep" },
    encrypted_auth_config: "old-encrypted-auth",
    auth_config_iv: "old-iv",
    auth_config_tag: "old-tag",
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
  };
}

function fakeDb(initial: ConnectorRow, failConnectorUpdate = false) {
  let current = { ...initial };
  let tools: Record<string, unknown>[] = [{ connector_id: initial.id }];
  let oauth: Record<string, unknown>[] = [{ connector_id: initial.id }];
  const operations: Operation[] = [];
  const filters: Array<{ table: string; column: string; value: unknown }> = [];

  const result = (
    table: string,
    action: "select" | "update" | "delete",
    value?: Record<string, unknown>,
  ) => {
    if (action === "update" && table === "user_mcp_connectors") {
      current = { ...current, ...value };
    } else if (action === "delete" && table === "user_mcp_connector_tools") {
      tools = [];
    } else if (action === "delete" && table === "user_mcp_oauth_tokens") {
      oauth = [];
    }
    const data =
      table === "user_mcp_connectors"
        ? [current]
        : table === "user_mcp_connector_tools"
          ? tools
          : oauth;
    return { data, error: null };
  };

  const db = {
    from(table: string) {
      let action: "select" | "update" | "delete" = "select";
      let value: Record<string, unknown> | undefined;
      const query: Record<string, any> = {
        select: () => query,
        eq: (column: string, filterValue: unknown) => {
          filters.push({ table, column, value: filterValue });
          return query;
        },
        in: () => query,
        order: () => query,
        update: (next: Record<string, unknown>) => {
          action = "update";
          value = next;
          operations.push({ table, action, value: next });
          return query;
        },
        delete: () => {
          action = "delete";
          operations.push({ table, action });
          return query;
        },
        single: async () => {
          if (
            failConnectorUpdate &&
            table === "user_mcp_connectors" &&
            action === "update"
          ) {
            return {
              data: null,
              error: new Error("connector update failed"),
            };
          }
          const queryResult = result(table, action, value);
          return {
            data: Array.isArray(queryResult.data)
              ? queryResult.data[0]
              : queryResult.data,
            error: queryResult.error,
          };
        },
        maybeSingle: async () => {
          if (
            failConnectorUpdate &&
            table === "user_mcp_connectors" &&
            action === "update"
          ) {
            return { data: null, error: null };
          }
          const queryResult = result(table, action, value);
          return {
            data: Array.isArray(queryResult.data)
              ? queryResult.data[0]
              : queryResult.data,
            error: queryResult.error,
          };
        },
        then: (
          resolve: (value: {
            data: Record<string, unknown>[];
            error: null;
          }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(result(table, action, value)).then(resolve, reject),
      };
      return query;
    },
  } as unknown as Db;
  return { db, operations, filters, current: () => current };
}

beforeEach(() => {
  mocks.authConfigPatch.mockReset();
  mocks.decryptAuthConfig.mockReset();
  mocks.loadConnector.mockReset();
  mocks.validateCustomHeaders.mockReset();
  mocks.validateRemoteMcpUrl.mockReset();
  mocks.authConfigPatch.mockImplementation(
    (config: { bearerToken?: string; headers?: Record<string, string> }) => {
      const populated =
        !!config.bearerToken || Object.keys(config.headers ?? {}).length > 0;
      return populated
        ? {
            encrypted_auth_config: JSON.stringify(config),
            auth_config_iv: "new-iv",
            auth_config_tag: "new-tag",
          }
        : {
            encrypted_auth_config: null,
            auth_config_iv: null,
            auth_config_tag: null,
          };
    },
  );
  mocks.decryptAuthConfig.mockReturnValue({
    bearerToken: "old-bearer",
    headers: { "X-Old": "old-secret" },
  });
  mocks.validateCustomHeaders.mockImplementation(
    (headers: Record<string, unknown> | undefined) => {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (typeof value !== "string") throw new Error("invalid custom header");
        result[key] = value;
      }
      return result;
    },
  );
  mocks.validateRemoteMcpUrl.mockImplementation(async (url: string) =>
    new URL(url).toString(),
  );
});

describe("MCP connector endpoint boundary", () => {
  it("clears tools, OAuth, and auth on a same-origin path change", async () => {
    const original = connector();
    const { db, operations, filters } = fakeDb(original);
    mocks.loadConnector.mockResolvedValue(original);

    await updateUserMcpConnector(
      "user-1",
      original.id,
      { serverUrl: "https://mcp.example/new" },
      db,
    );

    expect(operations.map(({ table, action }) => `${table}:${action}`)).toEqual(
      [
        "user_mcp_connector_tools:delete",
        "user_mcp_connectors:update",
        "user_mcp_oauth_tokens:delete",
      ],
    );
    expect(operations[1].value).toMatchObject({
      server_url: "https://mcp.example/new",
      auth_type: "none",
      encrypted_auth_config: null,
      tool_policy: {
        existing: "keep",
        __mike_endpoint_revision: expect.any(String),
        __mike_credential_epoch: expect.any(String),
      },
    });
    expect(JSON.stringify(operations)).not.toContain("old-secret");
    expect(JSON.stringify(operations)).not.toContain("old-bearer");
    expect(filters).toContainEqual({
      table: "user_mcp_oauth_tokens",
      column: "resource",
      value: original.server_url,
    });
  });

  it("applies only credentials explicitly supplied for the new endpoint", async () => {
    const original = connector();
    const { db, operations } = fakeDb(original);
    mocks.loadConnector.mockResolvedValue(original);

    await updateUserMcpConnector(
      "user-1",
      original.id,
      {
        serverUrl: "https://other.example/mcp",
        bearerToken: "new-bearer",
        headers: { "X-New": "new-secret" },
      },
      db,
    );

    expect(
      operations.find(
        ({ table, action }) =>
          table === "user_mcp_connectors" && action === "update",
      )?.value,
    ).toMatchObject({
      server_url: "https://other.example/mcp",
      auth_type: "bearer",
      encrypted_auth_config: JSON.stringify({
        bearerToken: "new-bearer",
        headers: { "X-New": "new-secret" },
      }),
    });
  });

  it("validates replacement credentials before mutating durable state", async () => {
    const original = connector();
    const { db, operations, current } = fakeDb(original);
    mocks.loadConnector.mockResolvedValue(original);

    await expect(
      updateUserMcpConnector(
        "user-1",
        original.id,
        {
          serverUrl: "https://other.example/mcp",
          headers: { "X-Bad": 42 },
        },
        db,
      ),
    ).rejects.toThrow("invalid custom header");

    expect(operations).toEqual([]);
    expect(current()).toEqual(original);
  });

  it("keeps old credentials and OAuth if the endpoint update fails", async () => {
    const original = connector();
    const { db, operations, filters, current } = fakeDb(original, true);
    mocks.loadConnector.mockResolvedValue(original);

    await expect(
      updateUserMcpConnector(
        "user-1",
        original.id,
        { serverUrl: "https://other.example/mcp" },
        db,
      ),
    ).rejects.toThrow("connector changed");

    expect(operations.map(({ table, action }) => `${table}:${action}`)).toEqual(
      ["user_mcp_connector_tools:delete", "user_mcp_connectors:update"],
    );
    expect(filters).toEqual(
      expect.arrayContaining([
        {
          table: "user_mcp_connectors",
          column: "server_url",
          value: original.server_url,
        },
        {
          table: "user_mcp_connectors",
          column: "updated_at",
          value: original.updated_at,
        },
      ]),
    );
    expect(current()).toEqual(original);
  });

  it("cannot attach stale credentials after a concurrent endpoint swap", async () => {
    const original = connector();
    const { db, operations, current } = fakeDb(original, true);
    mocks.loadConnector.mockResolvedValue(original);

    await expect(
      updateUserMcpConnector(
        "user-1",
        original.id,
        { headers: { "X-New": "replacement" } },
        db,
      ),
    ).rejects.toThrow("connector changed");

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      table: "user_mcp_connectors",
      action: "update",
    });
    expect(current()).toEqual(original);
  });

  it("does not clear state when the normalized endpoint is unchanged", async () => {
    const original = connector();
    const { db, operations } = fakeDb(original);
    mocks.loadConnector.mockResolvedValue(original);

    await updateUserMcpConnector(
      "user-1",
      original.id,
      {
        name: "Renamed",
        serverUrl: "https://mcp.example/old",
      },
      db,
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      table: "user_mcp_connectors",
      action: "update",
      value: {
        name: "Renamed",
        server_url: "https://mcp.example/old",
      },
    });
  });

  it("does not expose a tool cached by an older connector revision", async () => {
    const staleTool = {
      openai_tool_name: "mcp_stale",
      tool_name: "stale",
      title: "Stale",
      description: "Old endpoint schema",
      input_schema: { type: "object" },
      annotations: { __mike_endpoint_revision: "old-revision" },
      requires_confirmation: false,
      enabled: true,
      user_mcp_connectors: {
        id: "connector-1",
        user_id: "user-1",
        name: "MCP",
        enabled: true,
        tool_policy: { __mike_endpoint_revision: "new-revision" },
      },
    };
    const query: Record<string, any> = {
      select: () => query,
      eq: () => query,
      then: (
        resolve: (value: { data: unknown[]; error: null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({ data: [staleTool], error: null }).then(
          resolve,
          reject,
        ),
    };
    const db = { from: () => query } as unknown as Db;

    await expect(buildUserMcpTools("user-1", db)).resolves.toEqual([]);
  });
});
