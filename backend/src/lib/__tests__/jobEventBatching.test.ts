import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
let directory = "";
let closeFixture: (() => Promise<void>) | undefined;
const releases: Array<() => void> = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "beaver-event-batches-"));
  vi.stubEnv("AUTH_MODE", "local"); vi.stubEnv("MIKE_LOCAL_DATA_DIR", directory);
  const connection = process.env.BEAVER_TEST_POSTGRES_URL;
  if (connection) {
    const url = new URL(connection);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("The PostgreSQL fixture must use a disposable loopback server");
    const admin = postgres(connection, { ssl: false, max: 1 });
    const name = `beaver_events_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    closeFixture = async () => {
      try { await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally { await admin.end(); }
    };
    url.pathname = `/${name}`; url.searchParams.set("sslmode", "disable");
    const setup = postgres(url.href, { ssl: false, max: 1 });
    try {
      const schema = await readFile(path.resolve(__dirname, "../../../schema.sql"), "utf8");
      await setup.unsafe(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(schema)![1]);
    } finally { await setup.end(); }
    vi.stubEnv("AUTH_MODE", "cloud");
    vi.stubEnv("DATABASE_URL", url.href); vi.stubEnv("DATABASE_LISTEN_URL", url.href);
  }
});
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  vi.restoreAllMocks(); vi.useRealTimers();
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  await closeFixture?.(); closeFixture = undefined;
  vi.unstubAllEnvs(); vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
};
async function fixture() {
  const queue = await import("../jobQueue");
  const { relationalDatabase, sql } = await import("../relationalDatabase");
  const db = await relationalDatabase();
  const job = await queue.enqueueJob({ kind: "chat.turn", dedupeKey: "fixture", userId: owner, payload: {} });
  return { queue, db, sql, job, writer: await queue.createJobEventWriter(job.id) };
}
const isInsert = (text: string) => /INSERT INTO\s+application_job_events/u.test(text);

it("batches a burst without merging events, changing their sequence, or bypassing ownership", async () => {
  const { queue, db, job, writer } = await fixture(), query = vi.spyOn(db, "query");
  const events = Array.from({ length: 130 }, (_, index) => ({ type: index % 2 ? "reasoning" : "content", text: `${index}` }));
  for (const event of events) writer.append(event);
  writer.append({ type: "client_tool_call", callId: "tool", name: "word.read", input: {} });
  await writer.flush();
  const batches = query.mock.calls.filter(([statement]) => isInsert(statement.text));
  expect(batches.map(([statement]) => statement.params.length / 4)).toEqual([64, 64, 3]);
  const rows = await queue.readJobEvents(owner, job.id, 0);
  expect(rows.map(row => row.sequence)).toEqual(Array.from({ length: 131 }, (_, i) => i + 1));
  expect(rows.slice(0, 130).map(row => row.event)).toEqual(events);
  expect(rows[130].event).toMatchObject({ type: "client_tool_call" });
  expect(await queue.readJobEvents(other, job.id, 0)).toEqual([]);
  expect((await queue.readJobEvents(owner, job.id, 129)).map(row => row.sequence)).toEqual([130, 131]);
  const reopened = await queue.createJobEventWriter(job.id);
  reopened.append({ type: "content", text: "after reopen" }); await reopened.flush();
  expect((await queue.readJobEvents(owner, job.id, 131))[0].sequence).toBe(132);
});

it("automatically commits the first event without a flush or a later event", async () => {
  const { queue, db, job, writer } = await fixture();
  // Freeze all clocks for the shared writer's SQLite proof. PostgreSQL's actual
  // socket driver needs setImmediate/connect timers to perform the same writes.
  if (db.engine === "sqlite") vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] });
  const inserted = deferred(), query = db.query.bind(db);
  vi.spyOn(db, "query").mockImplementation(async statement => {
    const result = await query(statement);
    if (isInsert(statement.text)) inserted.resolve();
    return result;
  });
  writer.append({ type: "content", text: "first token" });
  // No flush, further event, or timer is needed to make the first event durable.
  await inserted.promise;
  expect((await queue.readJobEvents(owner, job.id, 0))[0].event).toEqual({ type: "content", text: "first token" });
  writer.append({ type: "error", message: "finished" });
  await writer.flush();
  expect((await queue.readJobEvents(owner, job.id, 1))[0].event).toEqual({ type: "error", message: "finished" });
});

it("does not let future appends extend an outstanding flush", async () => {
  const { db, queue, job, writer } = await fixture(), started = deferred(), release = deferred();
  const query = db.query.bind(db);
  let inserts = 0;
  vi.spyOn(db, "query").mockImplementation(async statement => {
    if (isInsert(statement.text) && ++inserts === 2) { started.resolve(); await release.promise; }
    return query(statement);
  });
  writer.append({ type: "content", text: "prefix" });
  const prefix = writer.flush();
  writer.append({ type: "content", text: "later" });
  const later = writer.flush();
  await prefix; await started.promise;
  expect((await queue.readJobEvents(owner, job.id, 0)).map(row => row.event)).toEqual([{ type: "content", text: "prefix" }]);
  release.resolve(); await later;
  expect(await queue.readJobEvents(owner, job.id, 0)).toHaveLength(2);
});

it("batches arrivals while a previous insert is slow and snapshots mutable inputs", async () => {
  const { db, queue, job, writer } = await fixture(), started = deferred(), release = deferred();
  const query = db.query.bind(db), sizes: number[] = [];
  vi.spyOn(db, "query").mockImplementation(async statement => {
    if (isInsert(statement.text)) {
      sizes.push(statement.params.length / 4);
      if (sizes.length === 1) { started.resolve(); await release.promise; }
    }
    return query(statement);
  });
  const event = { type: "content", text: "original" };
  writer.append(event); event.text = "mutated";
  await started.promise;
  for (let index = 0; index < 20; index++) {
    writer.append({ type: "content", text: `${index}` });
    await Promise.resolve();
  }
  const flushed = writer.flush(); release.resolve(); await flushed;
  expect(sizes).toEqual([1, 20]);
  expect((await queue.readJobEvents(owner, job.id, 0))[0].event).toEqual({ type: "content", text: "original" });
});

it("bounds multi-row payloads while permitting an existing valid large single event", async () => {
  const { db, writer } = await fixture(), query = vi.spyOn(db, "query");
  writer.append({ type: "content", text: "界".repeat(12_000) });
  writer.append({ type: "content", text: "a".repeat(35_000) });
  writer.append({ type: "content", text: "b".repeat(100_000) });
  writer.append({ type: "content", text: "last" });
  await writer.flush();
  const batches = query.mock.calls.filter(([statement]) => isInsert(statement.text));
  expect(batches).toHaveLength(4);
  for (const [statement] of batches) expect(statement.params).toHaveLength(4);
});

it("rejects an oversized event without consuming its sequence number", async () => {
  const { writer, queue, job } = await fixture();
  expect(() => writer.append({ type: "content", text: "x".repeat(512 * 1024) })).toThrow("Job event is too large");
  writer.append({ type: "content", text: "valid" }); await writer.flush();
  expect((await queue.readJobEvents(owner, job.id, 0)).map(row => row.sequence)).toEqual([1]);
});

it("rolls back a failing batch, leaves a durable prefix, and never reports failed writes as flushed", async () => {
  const { db, sql, writer, queue, job } = await fixture();
  writer.append({ type: "content", text: "committed" }); await writer.flush();
  if (db.engine === "sqlite") {
    await db.query(sql.raw(`CREATE TRIGGER fail_event BEFORE INSERT ON application_job_events
      WHEN NEW.sequence = 3 BEGIN SELECT RAISE(ABORT, 'fixture batch failure'); END`));
  } else {
    await db.query(sql.raw(`CREATE FUNCTION fail_event() RETURNS trigger AS $$ BEGIN
      IF NEW.sequence = 3 THEN RAISE EXCEPTION 'fixture batch failure'; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`));
    await db.query(sql.raw(`CREATE TRIGGER fail_event BEFORE INSERT ON application_job_events
      FOR EACH ROW EXECUTE FUNCTION fail_event()`));
  }
  const notified = vi.spyOn(db.notifications!, "publish");
  try {
    for (let index = 0; index < 80; index++) writer.append({ type: "content", text: `${index}` });
    await expect(writer.flush()).rejects.toThrow("fixture batch failure");
    await expect(writer.flush()).rejects.toThrow("fixture batch failure");
    writer.append({ type: "content", text: "cannot skip the failure" });
    await expect(writer.flush()).rejects.toThrow("fixture batch failure");
    expect(notified).not.toHaveBeenCalled();
    expect((await queue.readJobEvents(owner, job.id, 0)).map(row => row.event)).toEqual([{ type: "content", text: "committed" }]);
  } finally { notified.mockRestore(); }
});
