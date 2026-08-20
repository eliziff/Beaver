import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authPatch,
  connectorSummary,
  credentialFingerprint,
  readAuth,
  requiresConfirmation,
  validateHeaders,
} from "../mcp/client";
import type { ConnectorRow, Db, OAuthTokenRow } from "../mcp/types";

const remote = vi.hoisted(() => ({ withRemoteMcp: vi.fn() }));
vi.mock("../mcp/oauth", () => ({
  completeMcpConnectorOAuthAuthorization: vi.fn(),
  deleteOAuthToken: vi.fn(),
  loadOAuthToken: vi.fn(),
  loadOAuthTokens: vi.fn(),
  startUserMcpConnectorOAuth: vi.fn(),
  withRemoteMcp: remote.withRemoteMcp,
}));

import { buildUserMcpTools, executeMcpToolCall } from "../mcp/servers";

const connector = (patch: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id: "connector-1",
  user_id: "user-1",
  name: "Research",
  transport: "streamable_http",
  server_url: "https://mcp.example/api",
  auth_type: "oauth",
  enabled: true,
  tool_policy: {},
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

afterEach(() => {
  delete process.env.MCP_CONNECTORS_ENCRYPTION_SECRET;
  vi.clearAllMocks();
});

describe("MCP connector security boundary", () => {
  it("fails closed unless an external server explicitly marks a tool read-only", () => {
    expect(requiresConfirmation()).toBe(true);
    expect(requiresConfirmation({ readOnlyHint: false })).toBe(true);
    expect(requiresConfirmation({ readOnlyHint: true })).toBe(false);
    expect(requiresConfirmation({ readOnlyHint: true, destructiveHint: true })).toBe(true);
  });

  it("encrypts connector credentials and never binds them to display metadata", () => {
    process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = "test-secret-with-enough-entropy-32";
    const encrypted = authPatch({
      bearerToken: "secret-token",
      headers: { "X-Tenant": "tenant-a" },
    }, connector());
    const row = connector(encrypted);
    expect(JSON.stringify(encrypted)).not.toContain("secret-token");
    expect(readAuth(row)).toEqual({
      bearerToken: "secret-token",
      headers: { "X-Tenant": "tenant-a" },
    });
    expect(readAuth({ ...row, user_id: "user-2" })).toEqual({});
    expect(readAuth({ ...row, server_url: "https://evil.example/api" })).toEqual({});
    expect(credentialFingerprint({ ...row, name: "Renamed", enabled: false }))
      .toBe(credentialFingerprint(row));
    expect(credentialFingerprint({ ...row, server_url: "https://mcp.example/v2" }))
      .not.toBe(credentialFingerprint(row));
  });

  it("rejects host injection and unbounded custom headers", () => {
    expect(() => validateHeaders({ Host: "internal" })).toThrow("Invalid custom header");
    expect(() => validateHeaders({ "Transfer-Encoding": "chunked" })).toThrow("Invalid custom header");
    expect(() => validateHeaders({ "X-Forwarded-For": "127.0.0.1" })).toThrow("Invalid custom header");
    expect(() => validateHeaders({ "Bad Header": "value" })).toThrow("Invalid custom header");
    expect(() => validateHeaders({ "X-Test": "ok\r\nHost: internal" })).toThrow("valid value");
    expect(() => validateHeaders({ "X-Large": "x".repeat(4097) })).toThrow("4096");
    expect(() => validateHeaders(Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`X-${index}`, "x"]),
    ))).toThrow("20 entries");
  });

  it("reports OAuth only for a token bound to the exact resource", () => {
    const token = {
      connector_id: "connector-1",
      encrypted_access_token: "ciphertext",
      resource: "https://mcp.example/other",
    } as OAuthTokenRow;
    expect(connectorSummary(connector(), [], token).oauthConnected).toBe(false);
    expect(connectorSummary(connector(), [], {
      ...token, resource: "https://mcp.example/api",
    }).oauthConnected).toBe(true);
  });

  it("uses the SDK tool schema as the only model-visible schema gate", async () => {
    const rows = [
      {
        openai_tool_name: "mcp_research_find_connector1",
        tool_name: "find",
        description: "Find cases",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
        user_mcp_connectors: { name: "Research" },
      },
      {
        openai_tool_name: "mcp_invalid_connector1",
        tool_name: "invalid",
        description: "Invalid",
        input_schema: { type: "string" },
        user_mcp_connectors: { name: "Research" },
      },
    ];
    const query: Record<string, unknown> = {
      select: () => query, eq: () => query,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    const tools = await buildUserMcpTools("user-1", { from: () => query } as unknown as Db);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "mcp_research_find_connector1" });
    expect(tools[0].description).toContain("untrusted data");
  });

  it("never exposes provider error details to the model or audit log", async () => {
    const resolved = {
      id: "tool-1",
      connector_id: "connector-1",
      tool_name: "find",
      openai_tool_name: "mcp_research_find_connector1",
      user_mcp_connectors: connector(),
    };
    const auditRows: Record<string, unknown>[] = [];
    const db = {
      from(table: string) {
        if (table === "user_mcp_tool_audit_logs") return {
          insert: async (row: Record<string, unknown>) => {
            auditRows.push(row); return { error: null };
          },
        };
        const query: Record<string, unknown> = {
          select: () => query, eq: () => query,
          maybeSingle: async () => ({ data: resolved, error: null }),
        };
        return query;
      },
    } as unknown as Db;
    remote.withRemoteMcp.mockRejectedValue(new Error("secret upstream token"));
    const result = await executeMcpToolCall(
      "user-1", "mcp_research_find_connector1", {}, db,
    );
    expect(result.content).toContain("External MCP tool call failed");
    expect(JSON.stringify({ result, auditRows })).not.toContain("secret upstream token");
    remote.withRemoteMcp.mockResolvedValue({ content: "x".repeat(1024 * 1024) });
    const oversized = await executeMcpToolCall(
      "user-1", "mcp_research_find_connector1", {}, db,
    );
    expect(oversized.content).toContain("External MCP tool call failed");
    expect(oversized.content).not.toContain("xxx");
  });
});
