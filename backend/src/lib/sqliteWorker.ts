import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { committedNotifications, type QueryResult, type RelationalDatabase, type SqlStatement } from "./relational";
import { localJobNotifications } from "./jobNotifications";

type Failure = { name: string; message: string; code?: string; errcode?: number; errstr?: string };
type Boundary = "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK";
type Reply = { id: number; result?: QueryResult<Record<string, unknown>>; error?: Failure };

// The production worker loads compiled JS; source-mode tests/dev use the existing
// tsx dependency. Nothing is compiled or evaluated from a request or SQL value.
export function createSqliteWorker(filename: string): RelationalDatabase {
  const source = __filename.endsWith(".ts");
  const worker = source
    ? new Worker(`require(${JSON.stringify(require.resolve("tsx/cjs"))}); require(${JSON.stringify(__filename)});`,
      { eval: true, workerData: { kind: "beaver-sqlite", filename } })
    : new Worker(__filename, { workerData: { kind: "beaver-sqlite", filename } });
  const notifications = localJobNotifications();
  let queue = Promise.resolve(), sequence = 0, failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const requests = new Map<number, { resolve(value: QueryResult<Record<string, unknown>>): void;
    reject(error: Error): void }>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of requests.values()) request.reject(failure);
    requests.clear(); worker.unref();
  };
  worker.on("error", fail);
  worker.on("messageerror", fail);
  worker.on("exit", code => fail(new Error(`SQLite worker exited (${code})`)));
  worker.on("message", (reply: Reply) => {
    const request = requests.get(reply.id);
    if (!request) return;
    requests.delete(reply.id);
    if (!requests.size) worker.unref();
    if (reply.error) request.reject(Object.assign(new Error(reply.error.message), reply.error));
    else request.resolve(reply.result!);
  });
  worker.unref();
  function request<T extends Record<string, unknown>>(statement?: SqlStatement, boundary?: Boundary): Promise<QueryResult<T>> {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve: value => resolve(value as QueryResult<T>), reject });
      worker.ref();
      try { worker.postMessage({ id, statement, boundary }); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  const locked = <T>(run: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error("SQLite connection is closing"));
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const exec = (boundary: Boundary) => request(undefined, boundary);
  const database: RelationalDatabase = {
    engine: "sqlite", notifications,
    query<T extends Record<string, unknown>>(statement: SqlStatement) {
      // Capture parameters before acquiring the connection, including mutable blobs.
      const captured = structuredClone({ text: statement.text, params: statement.params });
      return locked(() => request<T>(captured));
    },
    transaction<T>(run: (transaction: RelationalDatabase) => Promise<T>) {
      return locked(async () => {
        await exec("BEGIN IMMEDIATE");
        const hints = committedNotifications(notifications);
        let active = true;
        const check = () => { if (!active) throw new Error("SQLite transaction has ended"); };
        const transaction: RelationalDatabase = {
          engine: "sqlite",
          query(statement) { check(); return request(statement); },
          async transaction(nested) { check(); return nested(transaction); },
          notifications: { subscribe: notifications.subscribe,
            publish(topic) { check(); hints.notifications.publish(topic); } },
          close: async () => undefined,
        };
        let result: T;
        try {
          result = await run(transaction);
          active = false;
          await exec("COMMIT");
        } catch (error) {
          active = false;
          // No automatic retry: a worker death can leave the commit outcome unknown.
          if (!failure) await exec("ROLLBACK");
          throw error;
        }
        hints.flush();
        return result;
      });
    },
    close() {
      return closing ??= queue.then(async () => {
        try { if (!failure) await request(); }
        finally { notifications.close(); await worker.terminate(); }
      });
    },
  };
  return database;
}

if (!isMainThread && workerData?.kind === "beaver-sqlite") {
  // Reuse the existing schema setup, statement cache and SQL error semantics.
  const { LocalDatabase, openLocalDatabase } = require("./localDatabase") as typeof import("./localDatabase");
  const database = new LocalDatabase(openLocalDatabase(workerData.filename));
  parentPort!.on("message", async ({ id, statement, boundary }: { id: number; statement?: SqlStatement; boundary?: Boundary }) => {
    try {
      const result = boundary ? await database.boundary(boundary) : statement ? await database.query(statement) : (await database.close(), { rows: [], changes: 0 });
      parentPort!.postMessage({ id, result } satisfies Reply);
      if (!statement && !boundary) parentPort!.close();
    } catch (cause) {
      const error = cause as Failure;
      parentPort!.postMessage({ id, error: { name: error.name, message: error.message,
        code: error.code, errcode: error.errcode, errstr: error.errstr } } satisfies Reply);
    }
  });
}
