import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import postgres, { type Sql as PostgresClient } from "postgres";
import { mikeLocalDataHome } from "./legalDataPath";
import { isLocalRuntime } from "./localMode";
import { type QueryResult, type RelationalDatabase, type SqlStatement,
  type SqlValue } from "./relational";
export { sql, type QueryResult, type RelationalDatabase, type SqlStatement,
  type SqlValue, decodeJson, encodeJson } from "./relational";

const bind = (params: SqlValue[]) => Object.fromEntries(
  params.map((value, index) => [String(index + 1), value]),
);

export class LocalDatabase implements RelationalDatabase {
  readonly engine = "sqlite" as const;
  private queue = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  private locked<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private execute<T extends Record<string, unknown>>(
    statement: SqlStatement,
  ): QueryResult<T> {
    const prepared = this.database.prepare(statement.text);
    const params = bind(statement.params);
    if (prepared.columns().length) {
      const rows = prepared.all(params) as T[];
      return { rows, changes: rows.length };
    }
    const result = prepared.run(params) as StatementResultingChanges;
    return { rows: [], changes: Number(result.changes) };
  }

  query<T extends Record<string, unknown>>(statement: SqlStatement) {
    return this.locked(() => this.execute<T>(statement));
  }

  transaction<T>(run: (database: RelationalDatabase) => Promise<T>) {
    return this.locked(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      const transaction: RelationalDatabase = {
        engine: "sqlite",
        query: async <R extends Record<string, unknown>>(statement: SqlStatement) =>
          this.execute<R>(statement),
        transaction: async <R>(nested: (database: RelationalDatabase) => Promise<R>) =>
          nested(transaction),
        close: async () => undefined,
      };
      try {
        const result = await run(transaction);
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close() {
    await this.locked(() => this.database.close());
  }
}

const cloudDatabase = (client: PostgresClient): RelationalDatabase => ({
  engine: "postgres",
  async query<T extends Record<string, unknown>>(statement: SqlStatement) {
    const result = await client.unsafe<T[]>(statement.text, statement.params);
    return { rows: [...result], changes: result.count };
  },
  async transaction<T>(run: (database: RelationalDatabase) => Promise<T>) {
    return await client.begin((transaction) =>
      run(cloudDatabase(transaction as unknown as PostgresClient))) as T;
  },
  close: () => client.end({ timeout: 5 }),
});

const processState = globalThis as typeof globalThis & {
  __beaverLocalDatabase?: { native?: DatabaseSync; relational?: LocalDatabase };
};
const localState = processState.__beaverLocalDatabase ??= {};

function openLocalDatabase() {
  const filename = path.join(mikeLocalDataHome(), "application.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  if (process.platform !== "win32") chmodSync(filename, 0o600);
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const version = Number((database.prepare("PRAGMA user_version").get() as
      { user_version: number }).user_version);
    if (version !== 0 && version !== 1) throw new Error(
      `Unsupported local database schema ${version}; use a fresh local data directory`,
    );
    const schema = readFileSync(path.resolve(__dirname, "../../schema.sql"), "utf8");
    const core = /-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(schema)?.[1];
    if (!core) throw new Error("backend/schema.sql is missing the Beaver core schema");
    database.exec(core);
    database.exec("PRAGMA user_version=1");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function localDatabaseSync() {
  if (!isLocalRuntime()) throw new Error("The native database is available only in local mode");
  return localState.native ??= openLocalDatabase();
}

function remoteDatabase() {
  const connection = process.env.DATABASE_URL?.trim();
  if (!connection) throw new Error("DATABASE_URL is required in cloud mode");
  const url = new URL(connection);
  if (!/^postgres(?:ql)?:$/u.test(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol");
  }
  const insecure = url.searchParams.get("sslmode") === "disable";
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (insecure && !loopback) {
    throw new Error("PostgreSQL TLS can be disabled only for a loopback database");
  }
  return cloudDatabase(postgres(connection, {
    connection: {
      idle_in_transaction_session_timeout: 30_000,
      statement_timeout: 60_000,
    },
    max: Math.max(1, Math.min(Number(process.env.DATABASE_POOL_SIZE) || 10, 20)),
    prepare: false,
    ssl: insecure ? false : "verify-full",
  }));
}

let active: Promise<RelationalDatabase> | undefined;
export const relationalDatabase = () => active ??=
  Promise.resolve(isLocalRuntime()
    ? (localState.relational ??= new LocalDatabase(localDatabaseSync())) : remoteDatabase());

export async function closeRelationalDatabase() {
  const current = active;
  active = undefined;
  if (current) await (await current).close();
  else localState.native?.close();
  localState.native = undefined;
  localState.relational = undefined;
}
