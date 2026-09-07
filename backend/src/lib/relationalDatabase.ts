import path from "node:path";
import { createSqliteWorker } from "./sqliteWorker";
import type { DatabaseSync } from "node:sqlite";
import { openLocalDatabase } from "./localDatabase";
export { LocalDatabase } from "./localDatabase";
import postgres, { type Sql as PostgresClient } from "postgres";
import { mikeLocalDataHome } from "./legalDataPath";
import { isLocalRuntime } from "./localMode";
import { createJobNotifications, createJobNotificationSender,
  type JobNotifications } from "./jobNotifications";
import { committedNotifications, type RelationalDatabase, type SqlStatement } from "./relational";
export { sql, type QueryResult, type RelationalDatabase, type SqlStatement,
  type SqlValue, decodeJson, encodeJson } from "./relational";

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
  __beaverLocalDatabase?: { native?: DatabaseSync; relational?: RelationalDatabase };
};
const localState = processState.__beaverLocalDatabase ??= {};

export function localDatabaseSync() {
  if (!isLocalRuntime()) throw new Error("The native database is available only in local mode");
  return localState.native ??= openLocalDatabase(path.join(mikeLocalDataHome(), "application.sqlite"));
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
    ? (localState.relational ??= createSqliteWorker(path.join(mikeLocalDataHome(), "application.sqlite"))) : remoteDatabase());

export async function closeRelationalDatabase() {
  const current = active;
  active = undefined;
  if (current) await (await current).close();
  localState.native?.close();
  localState.native = undefined;
  localState.relational = undefined;
}
