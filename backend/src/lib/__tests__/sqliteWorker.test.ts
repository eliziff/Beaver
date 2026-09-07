import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelationalDatabase } from "../relational";
import { sql } from "../relational";
import { createSqliteWorker } from "../sqliteWorker";

let directory: string, database: RelationalDatabase;
const workers: Worker[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-sqlite-worker-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  database = createSqliteWorker(path.join(directory, "application.sqlite"));
  await database.query(sql`CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB)`);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  await database.close();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("leaves the main event loop free while the worker waits on another SQLite writer", async () => {
  const contender = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); });
  `, { eval: true, workerData: path.join(directory, "application.sqlite") });
  workers.push(contender);
  await once(contender, "message");
  let committed = false;
  const write = database.query(sql`INSERT INTO probe VALUES(1,'after release',NULL)`)
    .then(() => { committed = true; });
  await delay(30); // The competing transaction remains open until this thread releases it.
  expect(committed).toBe(false);
  contender.postMessage("release");
  await write;
  expect((await database.query(sql`SELECT value FROM probe`)).rows).toEqual([{ value: "after release" }]);
});

it("reserves the connection across async/nested transactions and publishes only committed hints", async () => {
  const notices: string[] = [];
  const off = database.notifications!.subscribe(["events:probe"], () => notices.push("committed"));
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let escaped!: RelationalDatabase;
  const transaction = database.transaction(async tx => {
    escaped = tx;
    await tx.query(sql`INSERT INTO probe VALUES(1,'first',NULL)`);
    await tx.transaction(async nested => {
      await nested.query(sql`INSERT INTO probe VALUES(2,'second',NULL)`);
      nested.notifications!.publish("events:probe");
    });
    entered(); await held;
  });
  await ready;
  let readDone = false;
  const read = database.query(sql`SELECT value FROM probe ORDER BY id`).then(result => { readDone = true; return result; });
  await delay(10);
  expect(readDone).toBe(false); expect(notices).toEqual([]);
  release(); await transaction;
  expect((await read).rows).toEqual([{ value: "first" }, { value: "second" }]);
  expect(notices).toEqual(["committed"]);
  expect(() => escaped.query(sql`SELECT 1`)).toThrow("transaction has ended");
  await expect(database.transaction(async tx => {
    tx.notifications!.publish("events:probe");
    await tx.query(sql`DELETE FROM probe`);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(notices).toEqual(["committed"]);
  expect((await database.query(sql`SELECT count(*) total FROM probe`)).rows).toEqual([{ total: 2 }]);
  off();
});

it("captures queued mutable parameters, returns typed bytes, and preserves SQL errors", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const query = sql`INSERT INTO probe VALUES(1,${"value"},${bytes}) RETURNING value, bytes`;
  const result = database.query(query);
  bytes[0] = 99; query.params[0] = "changed";
  expect((await result).rows).toEqual([{ value: "value", bytes: new Uint8Array([1, 2, 3]) }]);
  await expect(database.query(sql`INSERT INTO probe VALUES(1,NULL,NULL)`)).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
  expect((await database.query(sql`SELECT value FROM probe`)).rows).toEqual([{ value: "value" }]);
});

it("rejects pending and future work after worker death without replaying writes", async () => {
  let actual: Worker | undefined;
  const original = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    actual = this;
    return original.apply(this, args);
  });
  const pending = database.query(sql`WITH RECURSIVE numbers(n) AS (
    VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n<1000000)
    SELECT sum(n) total FROM numbers`);
  void pending.catch(() => undefined);
  await delay(15);
  expect(actual).toBeDefined();
  await actual!.terminate();
  await expect(pending).rejects.toThrow("SQLite worker exited");
  await expect(database.query(sql`SELECT 1`)).rejects.toThrow("SQLite worker exited");
});

it("drains accepted writes on close and rejects later work", async () => {
  const write = database.query(sql`INSERT INTO probe VALUES(1,'accepted',NULL)`);
  const closed = database.close();
  await expect(database.query(sql`SELECT 1`)).rejects.toThrow("connection is closing");
  await write; await closed; await database.close();
  database = createSqliteWorker(path.join(directory, "application.sqlite"));
  expect((await database.query(sql`SELECT value FROM probe`)).rows).toEqual([{ value: "accepted" }]);
});
