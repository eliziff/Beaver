import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("database security boundary", () => {
  const schema = readFileSync(path.resolve(__dirname, "../../schema.sql"), "utf8");

  it("enables deny-all RLS on every application table", () => {
    const tables = [...schema.matchAll(/^create table if not exists (\w+)/gmu)]
      .map((match) => match[1]).sort();
    const protectedTables = [...schema.matchAll(
      /^alter table (\w+) enable row level security;/gmu,
    )].map((match) => match[1]).sort();

    expect(protectedTables).toEqual(tables);
    expect(schema).not.toMatch(/^create policy/gmu);
    expect(schema.match(/alter default privileges[^;]+;/gsu)).toHaveLength(3);
  });
});
