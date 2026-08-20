import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authPatch,
  connectorSummary,
  credentialFingerprint,
  readAuth,
  requiresConfirmation,
  validateHeaders,
} from "../mcp/client";
import type { ConnectorRow, OAuthTokenRow } from "../mcp/types";

const remote = vi.hoisted(() => ({ withRemoteMcp: vi.fn() }));
vi.mock("../mcp/oauth", () => ({
  McpOAuthRequiredError: class McpOAuthRequiredError extends Error {},
  completeMcpConnectorOAuthAuthorization: vi.fn(),
  deleteOAuthToken: vi.fn(),
  loadOAuthToken: vi.fn(),
  loadOAuthTokens: vi.fn(),
  startUserMcpConnectorOAuth: vi.fn(),
  withRemoteMcp: remote.withRemoteMcp,
}));

import { buildUserMcpTools, executeMcpToolCall } from "../mcp/servers";
import { mcpDatabase, seedMcpConnector } from "./support/mcpDatabase";

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

const databases: ReturnType<typeof mcpDatabase>[] = [];
function fixture() {
  const value = mcpDatabase();
  databases.push(value);
  seedMcpConnector(value.native, connector());
  return value;
}
function seedTool(
  native: ReturnType<typeof mcpDatabase>["native"],
  name: string,
  inputSchema: Record<string, unknown>,
) {
  native.prepare(`INSERT INTO user_mcp_connector_tools(id,connector_id,tool_name,
    openai_tool_name,description,input_schema,annotations,enabled,requires_confirmation,
    last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `tool-${name}`, "connector-1", name, `mcp_research_${name}_connector1`,
    name === "find" ? "Find cases" : "Invalid", JSON.stringify(inputSchema), "{}", 1, 0,
    "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
  );
}

afterEach(async () => {
  delete process.env.MCP_CONNECTORS_ENCRYPTION_SECRET;
  vi.clearAllMocks();
  await Promise.all(databases.splice(0).map(({ db }) => db.close()));
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
    const { db, native } = fixture();
    seedTool(native, "find", { type: "object", properties: { query: { type: "string" } } });
    seedTool(native, "invalid", { type: "string" });
    const tools = await buildUserMcpTools("user-1", db);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "mcp_research_find_connector1" });
    expect(tools[0].description).toContain("untrusted data");
  });

  it("never exposes provider error details to the model or audit log", async () => {
    const { db, native } = fixture();
    seedTool(native, "find", { type: "object", properties: {} });
    remote.withRemoteMcp.mockRejectedValue(new Error("secret upstream token"));
    const result = await executeMcpToolCall(
      "user-1", "mcp_research_find_connector1", {}, undefined, db,
    );
    expect(result.content).toContain("External MCP tool call failed");
    const auditRows = native.prepare("SELECT * FROM user_mcp_tool_audit_logs").all();
    expect(JSON.stringify({ result, auditRows })).not.toContain("secret upstream token");
    remote.withRemoteMcp.mockResolvedValue({ content: "x".repeat(1024 * 1024) });
    const oversized = await executeMcpToolCall(
      "user-1", "mcp_research_find_connector1", {}, undefined, db,
    );
    expect(oversized.content).toContain("External MCP tool call failed");
    expect(oversized.content).not.toContain("xxx");
  });
});
