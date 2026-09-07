import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDatabase, sql } from "../relationalDatabase";

const opened: LocalDatabase[] = [];
function fixture() {
  const native = new DatabaseSync(":memory:");
  native.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, owner TEXT, value BLOB)");
  const database = new LocalDatabase(native);
  opened.push(database);
  const prepare = vi.spyOn(native, "prepare");
  return { database, prepare };
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map(database => database.close()));
  vi.restoreAllMocks();
});

it("reuses compiled SQL, not data or parameter values, including omitted/null/blob bindings", async () => {
  const { database, prepare } = fixture();
  await database.query(sql`INSERT INTO records VALUES(${1},${"alice"},${new Uint8Array([1, 2])})`);
  await database.query(sql`INSERT INTO records VALUES(${2},${"bob"},${null})`);
  const read = (owner: string) => database.query(sql`SELECT id,value FROM records WHERE owner=${owner}`);
  expect((await read("alice")).rows).toEqual([{ id: 1, value: new Uint8Array([1, 2]) }]);
  expect((await read("bob")).rows).toEqual([{ id: 2, value: null }]);
  expect((await read("nobody")).rows).toEqual([]);
  expect(prepare.mock.calls.filter(([text]) => text.startsWith("SELECT id"))).toHaveLength(1);
  await database.query(sql`UPDATE records SET value=${"fresh"} WHERE id=${2}`);
  expect((await read("bob")).rows).toEqual([{ id: 2, value: "fresh" }]);
  await database.query({ text: "SELECT $1 a, $2 b", params: ["first", "secret"] });
  expect((await database.query({ text: "SELECT $1 a, $2 b", params: ["second"] })).rows)
    .toEqual([{ a: "second", b: null }]);
});

it("preserves RETURNING, changes and rollback, and recovers after a constraint/binding error", async () => {
  const { database } = fixture();
  const insert = (id: number) => database.query(sql`INSERT INTO records(id) VALUES(${id}) RETURNING id`);
  expect(await insert(1)).toEqual({ rows: [{ id: 1 }], changes: 1 });
  await expect(insert(1)).rejects.toThrow();
  expect(await insert(2)).toEqual({ rows: [{ id: 2 }], changes: 1 });
  const text = "SELECT $1 value";
  await expect(database.query({ text, params: ["valid", "unknown"] })).rejects.toThrow();
  expect((await database.query({ text, params: ["valid"] })).rows).toEqual([{ value: "valid" }]);
  await expect(database.transaction(async tx => {
    await tx.query(sql`UPDATE records SET owner=${"uncommitted"} WHERE id=${1}`);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await database.query(sql`SELECT owner FROM records WHERE id=${1}`)).rows).toEqual([{ owner: null }]);
  expect(await database.query(sql`DELETE FROM records WHERE id=${2}`)).toEqual({ rows: [], changes: 1 });
});

it("does not reuse stale column metadata after DDL or a rolled-back schema change", async () => {
  const { database } = fixture();
  await database.query(sql`INSERT INTO records(id) VALUES(${1})`);
  const all = () => database.query(sql`SELECT * FROM records`);
  await all();
  await database.query(sql.raw("ALTER TABLE records ADD COLUMN extra TEXT DEFAULT 'new'"));
  expect((await all()).rows).toEqual([{ id: 1, owner: null, value: null, extra: "new" }]);
  await expect(database.transaction(async tx => {
    await tx.query(sql.raw("ALTER TABLE records ADD COLUMN temporary TEXT"));
    await tx.query(sql`SELECT * FROM records`);
    throw new Error("rollback DDL");
  })).rejects.toThrow("rollback DDL");
  expect((await all()).rows).toEqual([{ id: 1, owner: null, value: null, extra: "new" }]);
});

it("bounds the working set, evicts least recently used SQL and avoids retaining oversized binds", async () => {
  const { database, prepare } = fixture();
  const read = (id: number) => database.query({ text: `SELECT $1 AS value /* ${id} */`, params: [id] });
  for (let id = 0; id < 128; id++) await read(id);
  prepare.mockClear();
  await read(0); await read(128); await read(0); await read(1);
  expect(prepare.mock.calls.map(([text]) => text)).toEqual([
    "SELECT $1 AS value /* 128 */", "SELECT $1 AS value /* 1 */",
  ]);
  const bind = (value: string | Uint8Array) => database.query(sql`SELECT ${value} AS payload`);
  await bind("small");
  prepare.mockClear();
  await bind(new Uint8Array(70_000)); // Reuse once, but evict the large native binding.
  await bind("small"); await bind("small again");
  expect(prepare).toHaveBeenCalledTimes(1);
  const largeSql = { text: `SELECT 1 /* ${"x".repeat(8_193)} */`, params: [] };
  prepare.mockClear(); await database.query(largeSql); await database.query(largeSql);
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("does not share compiled statements across connections and rejects queries after close", async () => {
  const a = fixture(), b = fixture();
  await a.database.query(sql`INSERT INTO records(id) VALUES(${1})`);
  expect((await b.database.query(sql`SELECT * FROM records`)).rows).toEqual([]);
  expect((await a.database.query(sql`SELECT * FROM records`)).rows).toHaveLength(1);
  await a.database.close(); opened.splice(opened.indexOf(a.database), 1);
  await expect(a.database.query(sql`SELECT * FROM records`)).rejects.toThrow();
});
