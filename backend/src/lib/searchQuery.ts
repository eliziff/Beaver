import { sql } from "./relational";

type SqlFragment = ReturnType<typeof sql>;
type SearchNode = { kind: "term"; value: string; prefix: boolean }
  | { kind: "and" | "or" | "not"; left: SearchNode; right: SearchNode };
const NEVER = "__beaver_no_search_match__";
const escapeLike = (value: string) => value.replace(/!/gu, "!!")
  .replace(/%/gu, "!%").replace(/_/gu, "!_");
const isAnd = (value = "") => /^(?:AND|ET)$/iu.test(value);
const isOr = (value = "") => /^(?:OR|OU)$/iu.test(value);
const isNot = (value = "") => value === "NOT" || value === "NON";

/** Parses CanLII's Boolean priority: OR, NOT, then explicit or implicit AND. */
function parseSearch(query: string): SearchNode {
  const input = query.match(/"[^"]*"|\(|\)|[^\s()]+/gu)?.slice(0, 32) ?? [];
  let at = 0;
  const term = (raw = NEVER): SearchNode => {
    const quoted = raw.startsWith('"') && raw.endsWith('"');
    const value = quoted ? raw.slice(1, -1) : raw;
    const prefix = !quoted && value.endsWith("*") && value.length > 1;
    return { kind: "term", value: prefix ? value.slice(0, -1) : value || NEVER, prefix };
  };
  const atom = (): SearchNode => {
    const token = input[at++];
    if (!token || token === ")") { if (token) at--; return term(); }
    if (token === "(") {
      const value = and(); if (input[at] === ")") at++; return value;
    }
    return term(token);
  };
  const or = (): SearchNode => { let left = atom(); while (isOr(input[at])) {
    at++; left = { kind: "or", left, right: atom() };
  } return left; };
  const not = (): SearchNode => { let left = or(); while (isNot(input[at]) ||
    (input[at]?.startsWith("-") && input[at]!.length > 1)) {
    const raw = input[at++]!;
    left = { kind: "not", left, right: raw.startsWith("-") ? term(raw.slice(1)) : or() };
  } return left; };
  const and = (): SearchNode => { let left = not(); while (at < input.length && input[at] !== ")") {
    if (isAnd(input[at])) at++;
    left = { kind: "and", left, right: not() };
  } return left; };
  return input.length ? and() : term();
}

/** Builds a parameterized, portable substring filter for relational fields. */
export function searchFilter(haystack: SqlFragment, query: string): SqlFragment {
  const compile = (node: SearchNode): SqlFragment => {
    if (node.kind === "term") return sql`${haystack} LIKE ${`%${escapeLike(node.value.toLocaleLowerCase())}%`} ESCAPE '!'`;
    const left = compile(node.left); const right = compile(node.right);
    return node.kind === "or" ? sql`(${left} OR ${right})`
      : node.kind === "not" ? sql`(${left} AND NOT (${right}))`
      : sql`(${left} AND ${right})`;
  };
  return query.trim() ? compile(parseSearch(query)) : sql.raw("1=1");
}

/** Converts the shared syntax to explicit FTS5 grouping without changing priority. */
export function searchFts5(query: string) {
  const compile = (node: SearchNode): string => {
    if (node.kind === "term") {
      const value = `"${node.value.replace(/"/gu, '""')}"`;
      return node.prefix ? `${value}*` : value;
    }
    return `(${compile(node.left)} ${node.kind.toUpperCase()} ${compile(node.right)})`;
  };
  return query.trim() ? compile(parseSearch(query)) : "";
}
