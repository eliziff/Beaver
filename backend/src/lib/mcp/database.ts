import { decodeJson as decode, type RelationalDatabase, type SqlStatement } from "../relational";
export { encodeJson as json } from "../relational";
import type { ConnectorRow, ToolRow } from "./types";

type Row = Record<string, unknown>;
export const rows = async <T extends Row>(statement: SqlStatement, db: RelationalDatabase) =>
  (await db.query<T>(statement)).rows;
export const one = async <T extends Row>(statement: SqlStatement, db: RelationalDatabase) =>
  (await rows<T>(statement, db))[0] ?? null;
export const connectorRow = (row: Row): ConnectorRow => ({ ...row,
  enabled: Boolean(row.enabled), tool_policy: decode(row.tool_policy, {}),
} as ConnectorRow);
export const toolRow = (row: Row): ToolRow => ({ ...row,
  input_schema: decode(row.input_schema, {}),
  output_schema: decode(row.output_schema, null), annotations: decode(row.annotations, {}),
  enabled: Boolean(row.enabled), requires_confirmation: Boolean(row.requires_confirmation),
} as ToolRow);
