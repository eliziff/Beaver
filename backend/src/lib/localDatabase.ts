import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges, type StatementSync } from "node:sqlite";
import { localJobNotifications } from "./jobNotifications";
import { committedNotifications, type QueryResult, type RelationalDatabase,
  type SqlStatement, type SqlValue } from "./relational";

const bind = (params: SqlValue[]) => Object.fromEntries(
  params.map((value, index) => [String(index + 1), value]),
);

export class LocalDatabase implements RelationalDatabase {
  readonly engine = "sqlite" as const;
  private queue = Promise.resolve();
  private readonly statements = new Map<string, StatementSync>();
  readonly notifications = localJobNotifications();

  constructor(private readonly database: DatabaseSync) {}

  private locked<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private execute<T extends Record<string, unknown>>(
    statement: SqlStatement,
  ): QueryResult<T> {
    // The deployed Node 22 floor has no SQLTagStore. Cache compiled statements,
    // never query results. DDL/PRAGMA can change prepared metadata or semantics.
    const ordinary = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu.test(statement.text);
    if (!ordinary) this.statements.clear();
    const prepared = this.statements.get(statement.text) ?? this.database.prepare(statement.text);
    // Reinsert only after successful execution. Failed/oversized binds must not
    // leave a poisoned statement or a large native parameter buffer in the LRU.
    this.statements.delete(statement.text);
    const params = bind(statement.params);
    let result: QueryResult<T>;
    if (prepared.columns().length) {
      const rows = prepared.all(params) as T[];
      result = { rows, changes: rows.length };
    } else {
      const changed = prepared.run(params) as StatementResultingChanges;
      result = { rows: [], changes: Number(changed.changes) };
    }
    if (ordinary && statement.text.length <= 8_192 && statement.params.reduce<number>((bytes, value) =>
      bytes + (typeof value === "string" ? Buffer.byteLength(value)
        : value instanceof Uint8Array ? value.byteLength : 8), 0) <= 65_536) {
      this.statements.set(statement.text, prepared);
      if (this.statements.size > 128) this.statements.delete(this.statements.keys().next().value!);
    }
    return result;
  }

  query<T extends Record<string, unknown>>(statement: SqlStatement) {
    return this.locked(() => this.execute<T>(statement));
  }

  transaction<T>(run: (database: RelationalDatabase) => Promise<T>) {
    return this.locked(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      const hints = committedNotifications(this.notifications);
      const transaction: RelationalDatabase = {
        notifications: hints.notifications,
        engine: "sqlite",
        query: async <R extends Record<string, unknown>>(statement: SqlStatement) =>
          this.execute<R>(statement),
        transaction: async <R>(nested: (database: RelationalDatabase) => Promise<R>) =>
          nested(transaction),
        close: async () => undefined,
      };
      let result: T;
      try {
        result = await run(transaction);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.statements.clear();
        throw error;
      }
      hints.flush();
      return result;
    });
  }

  boundary(operation: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK") {
    return this.locked(() => {
      this.database.exec(operation);
      if (operation === "ROLLBACK") this.statements.clear();
      return { rows: [], changes: 0 };
    });
  }

  async close() {
    this.notifications.close();
    await this.locked(() => { this.statements.clear(); this.database.close(); });
  }
}

const LOCAL_SCHEMA_VERSION = 17;

// SQLite ignores new columns in `create table if not exists`, so nullable columns added to
// an existing table are reconciled before the schema runs (its indexes may reference them).
const ADDED_COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
  ["chats", "work_product_id", "text"],
];

function addMissingColumns(database: DatabaseSync) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.length || columns.some((row) => row.name === column)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openLocalDatabase(filename: string) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  if (process.platform !== "win32") chmodSync(filename, 0o600);
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = Number((database.prepare("PRAGMA user_version").get() as
      { user_version: number }).user_version);
    if (version !== 0 && version !== LOCAL_SCHEMA_VERSION) throw new Error(
      `Unsupported local database schema ${version}; use a fresh local data directory`,
    );
    const schema = readFileSync(path.resolve(__dirname, "../../schema.sql"), "utf8");
    const core = /-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(schema)?.[1];
    if (!core) throw new Error("backend/schema.sql is missing the Beaver core schema");
    addMissingColumns(database);
    database.exec(core);
    database.exec(`PRAGMA user_version=${LOCAL_SCHEMA_VERSION}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
