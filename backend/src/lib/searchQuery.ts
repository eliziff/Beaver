import { sql } from "./relational";
import { structureNative } from "./structureNative";
import type { SearchNode } from "mike/shared/engine-types/SearchNode";

type SqlFragment = ReturnType<typeof sql>;

/** The engine's reading of a query in CanLII's Boolean syntax, with its FTS5 and Lucene forms. */
const parsed = (query: string, columns?: readonly string[]) => structureNative().searchQuery(query, columns);
const escapeLike = (value: string) => value.replace(/!/gu, "!!").replace(/%/gu, "!%").replace(/_/gu, "!_");

export const hasSearchOperators = (query: string) => parsed(query).operators;
export const searchFts5 = (query: string, columns?: readonly string[]) => parsed(query, columns).fts5;
export const searchLucene = (query: string) => parsed(query).lucene;

/** The query evaluated over text in memory. Null refuses a malformed expression. */
export function searchMatcher(query: string) {
  const source = parsed(query);
  if (!source.valid) return null;
  const test = (haystack: string) => {
    const value = haystack.toLowerCase();
    const run = (node: SearchNode): boolean => node.kind === "term" ? value.includes(node.value.toLowerCase())
      : node.kind === "or" ? run(node.left) || run(node.right)
      : node.kind === "not" ? run(node.left) && !run(node.right) : run(node.left) && run(node.right);
    return run(source.node);
  };
  return { test, terms: source.terms };
}

/** A parameterized, portable substring filter for relational fields. */
export function searchFilter(haystack: SqlFragment, query: string): SqlFragment {
  const compile = (node: SearchNode): SqlFragment => {
    if (node.kind === "term") return sql`${haystack} LIKE ${`%${escapeLike(node.value.toLocaleLowerCase())}%`} ESCAPE '!'`;
    const left = compile(node.left), right = compile(node.right);
    return node.kind === "or" ? sql`(${left} OR ${right})`
      : node.kind === "not" ? sql`(${left} AND NOT (${right}))` : sql`(${left} AND ${right})`;
  };
  return query.trim() ? compile(parsed(query).node) : sql.raw("1=1");
}

/** The words a query asks for, for showing where a result holds them. */
