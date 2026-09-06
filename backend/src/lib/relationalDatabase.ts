import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges, type StatementSync } from "node:sqlite";
import postgres, { type Sql as PostgresClient } from "postgres";
import { mikeLocalDataHome } from "./legalDataPath";
import { isLocalRuntime } from "./localMode";
import { createJobNotifications, createJobNotificationSender, localJobNotifications,
  type JobNotifications } from "./jobNotifications";
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

  async close() {
    this.notifications.close();
    await this.locked(() => { this.statements.clear(); this.database.close(); });
  }
}

// A publish inside any nested transaction becomes visible only after the outer
// commit succeeds. Transport failures never turn a committed mutation into an error.
function committedNotifications(target: JobNotifications) {
  const topics = new Set<string>();
  return {
    notifications: { subscribe: target.subscribe, publish: (topic: string) => { topics.add(topic); } },
    flush: () => topics.forEach((topic) => target.publish(topic)),
  };
}

function postgresNotifications(client: PostgresClient, listener: PostgresClient) {
  let listening = false, closed = false, warned = false;
  let retry: NodeJS.Timeout | undefined;
  const unavailable = () => {
    if (!warned && !closed) console.warn("[jobs] notification connection unavailable; using durable fallback reads");
    warned = true;
  };
  const outgoing = createJobNotificationSender((message, done) => {
    void client.notify("beaver_jobs", JSON.stringify(message)).then(() => done(), () => {
      unavailable(); done();
    });
  });
  const bus = createJobNotifications(outgoing.send);
  const listen = () => {
    if (listening || closed) return;
    listening = true;
    void listener.listen("beaver_jobs", (payload) => {
      if (payload.length > 8_000) return;
      try { bus.receiveMessage(JSON.parse(payload)); } catch { /* Ignore malformed hints. */ }
    }, () => { warned = false; bus.receive(null); }).catch(() => {
      listening = false;
      if (closed) return;
      unavailable();
      retry = setTimeout(listen, 5_000); retry.unref();
    });
  };
  return {
    publish: bus.publish,
    subscribe(topics: readonly string[], wake: () => void) {
      const unsubscribe = bus.subscribe(topics, wake);
      listen(); // onlisten also wakes on reconnection, closing the initial LISTEN race.
      return unsubscribe;
    },
    async close() {
      closed = true; if (retry) clearTimeout(retry); outgoing.close();
      if (listener !== client) await listener.end({ timeout: 1 });
    },
  };
}

const cloudDatabase = (client: PostgresClient, notifications: JobNotifications,
  closeNotifications: () => Promise<void>): RelationalDatabase => ({
  engine: "postgres", notifications,
  async query<T extends Record<string, unknown>>(statement: SqlStatement) {
    const result = await client.unsafe<T[]>(statement.text, statement.params);
    return { rows: [...result], changes: result.count };
  },
  async transaction<T>(run: (database: RelationalDatabase) => Promise<T>) {
    const hints = committedNotifications(notifications);
    const result = await client.begin((transaction) => {
      const tx = cloudDatabase(transaction as unknown as PostgresClient,
        hints.notifications, async () => undefined);
      // Match SQLite's nested-transaction contract: join the outer transaction.
      tx.transaction = async (nested) => nested(tx);
      return run(tx);
    }) as T;
    hints.flush();
    return result;
  },
  close: async () => { await closeNotifications(); await client.end({ timeout: 5 }); },
});

const processState = globalThis as typeof globalThis & {
  __beaverLocalDatabase?: { native?: DatabaseSync; relational?: LocalDatabase };
};
const localState = processState.__beaverLocalDatabase ??= {};
const LOCAL_SCHEMA_VERSION = 16;

function openLocalDatabase() {
  const filename = path.join(mikeLocalDataHome(), "application.sqlite");
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
    database.exec(core);
    database.exec(`PRAGMA user_version=${LOCAL_SCHEMA_VERSION}`);
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

function postgresClient(connection: string) {
  const url = new URL(connection);
  if (!/^postgres(?:ql)?:$/u.test(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol");
  }
  const insecure = url.searchParams.get("sslmode") === "disable";
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (insecure && !loopback) {
    throw new Error("PostgreSQL TLS can be disabled only for a loopback database");
  }
  return postgres(connection, {
    connection: {
      idle_in_transaction_session_timeout: 30_000,
      statement_timeout: 60_000,
    },
    max: Math.max(1, Math.min(Number(process.env.DATABASE_POOL_SIZE) || 10, 20)),
    prepare: false,
    ssl: insecure ? false : "verify-full",
  });
}

function remoteDatabase() {
  const connection = process.env.DATABASE_URL?.trim();
  if (!connection) throw new Error("DATABASE_URL is required in cloud mode");
  // LISTEN needs a direct/session connection, not a transaction-pool endpoint.
  // Publishers still use the ordinary database pool; both URLs must name the same database.
  const listenConnection = process.env.DATABASE_LISTEN_URL?.trim();
  const client = postgresClient(connection);
  const listener = listenConnection ? postgresClient(listenConnection) : client;
  const notifications = postgresNotifications(client, listener);
  return cloudDatabase(client, notifications, notifications.close);
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
