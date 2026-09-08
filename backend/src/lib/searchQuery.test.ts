import { expect, it } from "vitest";
import { LocalDatabase, sql } from "./relationalDatabase";
import { hasSearchOperators, searchFilter, searchFts5, searchMatcher } from "./searchQuery";
import { DatabaseSync } from "node:sqlite";

const values = ["permit hunting", "permit fishing", "city municipality", "custody child"];
async function matching(query: string) {
  const db = new LocalDatabase(new DatabaseSync(":memory:"));
  await db.query(sql`CREATE TABLE items(value TEXT)`);
  for (const value of values) await db.query(sql`INSERT INTO items(value) VALUES(${value})`);
  const filter = searchFilter(sql`lower(value)`, query);
  const result = await db.query<{ value: string }>(sql`SELECT value FROM items WHERE ${filter}`);
  await db.close(); return result.rows.map(({ value }) => value);
}

it("applies CanLII Boolean search safely", async () => {
    expect(await matching("permit hunting")).toEqual(["permit hunting"]);
    expect(await matching("permit AND (hunting OR fishing)")).toEqual(["permit hunting", "permit fishing"]);
    expect(await matching("permit NOT fishing")).toEqual(["permit hunting"]);
    expect(await matching('"city municipality"')).toEqual(["city municipality"]);
    expect(await matching("permit AND hunting OR fishing")).toEqual(["permit hunting", "permit fishing"]);
    expect(await matching("permit ET (hunting OU fishing)")).toEqual(["permit hunting", "permit fishing"]);
    expect(await matching("custody -child")).toEqual([]);
    expect(await matching("permit not fishing")).toEqual(["permit hunting"]);
    expect(await matching("permit AND NOT fishing")).toEqual(["permit hunting"]);
    expect(await matching("permit ET NON fishing")).toEqual(["permit hunting"]);
    expect(await matching("%' OR 1=1 --")).toEqual([]);
});

it("evaluates the same Boolean syntax in memory and refuses malformed expressions", () => {
  const kept = (query: string) => values.filter((value) => searchMatcher(query)!.test(value));
  expect(kept("permit hunting")).toEqual(["permit hunting"]);
  expect(kept("permit and (hunting or fishing)")).toEqual(["permit hunting", "permit fishing"]);
  expect(kept("permit & (hunting | fishing)")).toEqual(["permit hunting", "permit fishing"]);
  expect(kept("PERMIT NOT fishing")).toEqual(["permit hunting"]);
  expect(kept("permit and not (fishing OR child)")).toEqual(["permit hunting"]);
  expect(kept("custody -child")).toEqual([]);
  expect(kept('"city municipality"')).toEqual(["city municipality"]);
  expect(searchMatcher("permit and (hunting")).toBeNull();
  expect(searchMatcher('permit "city')).toBeNull();
  expect(searchMatcher("permit or")).toBeNull();
  expect(searchMatcher("  ")).toBeNull();
  expect(searchMatcher("permit and (hunting or fishing)")!.terms).toEqual(["permit", "hunting", "fishing"]);
  expect([hasSearchOperators("governing law"), hasSearchOperators("law OR equity"),
    hasSearchOperators('"governing law"')]).toEqual([false, true, true]);
});

it("preserves CanLII priority when compiling FTS5", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE items USING fts5(value)");
  const insert = db.prepare("INSERT INTO items(value) VALUES(?)");
  for (const value of values) insert.run(value);
  const found = db.prepare("SELECT value FROM items WHERE items MATCH ? ORDER BY rowid")
    .all(searchFts5("permit AND hunting OR fishing")) as Array<{ value: string }>;
  expect(found.map(({ value }) => value)).toEqual(["permit hunting", "permit fishing"]);
  expect(db.prepare("SELECT value FROM items WHERE items MATCH ?").all(searchFts5("permit AND NOT fishing")))
    .toEqual([{ value: "permit hunting" }]);
  expect(searchFts5('city OR "permit fishing"')).toContain('"permit fishing"');
  db.close();
});
