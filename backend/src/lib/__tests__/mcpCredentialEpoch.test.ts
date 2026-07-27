import { describe, expect, it } from "vitest";
import {
  oauthTokenMatchesConnectorCredentials,
  toConnectorSummary,
} from "../mcp/client";
import type { ConnectorRow, OAuthTokenRow } from "../mcp/types";

const credentialEpoch = "2026-07-27T12:00:00.000Z";

function connector(): ConnectorRow {
  return {
    id: "connector-1",
    user_id: "user-1",
    name: "Renamed",
    transport: "streamable_http",
    server_url: "https://mcp.example/api",
    auth_type: "oauth",
    enabled: true,
    tool_policy: { __mike_credential_epoch: credentialEpoch },
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T13:00:00.000Z",
  };
}

function token(): OAuthTokenRow {
  return {
    id: "token-1",
    connector_id: "connector-1",
    encrypted_access_token: "encrypted",
    access_token_iv: "iv",
    access_token_tag: "tag",
    encrypted_refresh_token: null,
    refresh_token_iv: null,
    refresh_token_tag: null,
    token_type: "Bearer",
    scope: null,
    expires_at: null,
    authorization_server: "https://auth.example/",
    token_endpoint: "https://auth.example/token",
    client_id: "client",
    encrypted_client_secret: null,
    client_secret_iv: null,
    client_secret_tag: null,
    resource: "https://mcp.example/api",
    created_at: "2026-07-27T12:00:00.000Z",
    updated_at: "2026-07-27T12:00:00.000+00:00",
  };
}

describe("MCP credential epoch", () => {
  it("keeps OAuth valid across later name and enabled metadata changes", () => {
    const currentConnector = connector();
    const currentToken = token();

    expect(
      oauthTokenMatchesConnectorCredentials(currentToken, currentConnector),
    ).toBe(true);
    expect(
      toConnectorSummary(currentConnector, [], currentToken).oauthConnected,
    ).toBe(true);
  });

  it("rejects a stale epoch and does not report OAuth on a non-OAuth connector", () => {
    const staleToken = {
      ...token(),
      updated_at: "2026-07-27T11:59:59.000Z",
    };
    expect(oauthTokenMatchesConnectorCredentials(staleToken, connector())).toBe(
      false,
    );
    expect(
      toConnectorSummary({ ...connector(), auth_type: "none" }, [], token())
        .oauthConnected,
    ).toBe(false);
  });
});
