import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { LocalDatabase } from "../../relationalDatabase";
import type { ConnectorRow } from "../../mcp/types";

export function mcpDatabase() {
  const native = new DatabaseSync(":memory:");
  const schema = readFileSync(path.resolve(process.cwd(), "schema.sql"), "utf8");
  const core = /-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(schema)?.[1];
  if (!core) throw new Error("Missing Beaver core schema");
  native.exec(`PRAGMA foreign_keys=ON;${core}`);
  return { db: new LocalDatabase(native), native };
}

export function seedMcpConnector(native: DatabaseSync, row: ConnectorRow) {
  native.prepare(`INSERT INTO user_mcp_connectors(id,user_id,name,transport,server_url,
    auth_type,enabled,tool_policy,encrypted_auth_config,auth_config_iv,auth_config_tag,
    created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.user_id, row.name, row.transport, row.server_url, row.auth_type,
    Number(row.enabled), JSON.stringify(row.tool_policy), row.encrypted_auth_config,
    row.auth_config_iv, row.auth_config_tag, row.created_at, row.updated_at,
  );
}
