import { readFileSync } from "node:fs";
import path from "node:path";

export type GrammarEntry = { id: string; pattern: string; flags: string };
export type GrammarTable = {
  defs: Record<string, string>;
  entries: GrammarEntry[];
};

const TABLES = (
  JSON.parse(
    readFileSync(
      path.join(
        __dirname,
        "../../../packages/legal-grammar-tables/grammar-corpus.json",
      ),
      "utf8",
    ),
  ) as { tables: Record<string, GrammarTable> }
).tables;

export function grammarTable(name: string): GrammarTable {
  const table = TABLES[name];
  if (!table) throw new Error(`Missing legal grammar table: ${name}`);
  return table;
}

export function grammarSource(tableName: string, id: string): string {
  const table = grammarTable(tableName);
  const entry = table.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing legal grammar entry: ${id}`);
  let source = entry.pattern;
  for (let pass = 0; pass <= 10; pass += 1) {
    const expanded = source.replace(
      /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
      (_, name: string) => {
        const value = table.defs[name];
        if (value === undefined) {
          throw new Error(`Missing legal grammar fragment: ${name}`);
        }
        return value;
      },
    );
    if (expanded === source) return source;
    source = expanded;
  }
  throw new Error(`Legal grammar fragment cycle: ${id}`);
}

export function grammarRegExp(
  tableName: string,
  id: string,
  extraFlags = "u",
): RegExp {
  const entry = grammarTable(tableName).entries.find(
    (candidate) => candidate.id === id,
  );
  if (!entry) throw new Error(`Missing legal grammar entry: ${id}`);
  return new RegExp(grammarSource(tableName, id), `${entry.flags}${extraFlags}`);
}
