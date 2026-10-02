// Style-of-cause fallback for A2AJ case resolution (experiment, not product code).
// Accepts a record only when its name equals the cited style of cause after
// period/whitespace-tolerant normalisation, in the cited court's A2AJ dataset and
// the cited year; abstains on zero or several candidates.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { structureNative } from "../../backend/src/lib/structureNative";
import { legalProviderDatabase } from "../../backend/src/lib/legalDataPath";

export const native = structureNative();

export type Case = {
  id: number; dataset: string; year: number | null; date: string | null;
  names: string[]; citations: string[];
};

export type Citation = {
  format: string; style?: { text: string }; court?: { id: string; text: string };
  fields?: { year?: string; yearNumber?: number }; span: { text: string };
  key?: string; parallelGroup?: number;
};

export function a2ajDbPath() {
  const configured = process.env.MIKE_A2AJ_BULK_DB?.trim();
  return configured ? path.resolve(configured) : legalProviderDatabase("a2aj", "a2aj.sqlite");
}

export function extract(text: string): { citations: Citation[]; authorities: number[][] } {
  const raw = native.citationEngineCall("extract",
    JSON.stringify({ text, offsetUnit: "utf16", options: { resolve: false } }));
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as never;
}

/** Case metadata from the local A2AJ bulk store, plus a v3 citation-key index built with the native engine. */
export function loadA2AJ() {
  const db = new DatabaseSync(a2ajDbPath(), { readOnly: true });
  const rows = db.prepare(`SELECT id, dataset, citation_en, citation_fr, citation2_en, citation2_fr,
      name_en, name_fr, document_date_en, document_date_fr FROM document WHERE doc_type = 'cases'`)
    .all() as Record<string, string | number | null>[];
  db.close();
  const cases = new Map<number, Case>();
  for (const row of rows) {
    const date = (row.document_date_en ?? row.document_date_fr ?? null) as string | null;
    const text = (field: string) => typeof row[field] === "string" && (row[field] as string).trim()
      ? (row[field] as string).trim() : null;
    cases.set(Number(row.id), {
      id: Number(row.id), dataset: String(row.dataset), date,
      year: date ? Number(date.slice(0, 4)) : null,
      names: [...new Set([text("name_en"), text("name_fr")].filter((v): v is string => !!v))],
      citations: [...new Set(["citation_en", "citation2_en", "citation_fr", "citation2_fr"]
        .map(text).filter((v): v is string => !!v))],
    });
  }
  const forms: string[] = [], owners: number[] = [];
  for (const item of cases.values()) for (const c of item.citations) { forms.push(c); owners.push(item.id); }
  const keyIndex = new Map<string, Set<number>>();
  for (let i = 0; i < forms.length; i += 5000) {
    const keys = native.citationLookupKeys(forms.slice(i, i + 5000));
    keys.forEach((key, j) => {
      if (!key) return;
      const set = keyIndex.get(key) ?? new Set<number>();
      set.add(owners[i + j]);
      keyIndex.set(key, set);
    });
  }
  return { cases, keyIndex, datasets: new Set([...cases.values()].map((c) => c.dataset)) };
}

// ---------------------------------------------------------------- normalisation
export type NameRule = { caseFold: boolean; crown: boolean; unordered: boolean };
export const RULES: Record<string, NameRule> = {
  exact: { caseFold: false, crown: false, unordered: false },
  casefold: { caseFold: true, crown: false, unordered: false },
  crown: { caseFold: true, crown: true, unordered: false },
  crownUnordered: { caseFold: true, crown: true, unordered: true },
};

const CROWN = new Set(["r", "the queen", "the king", "her majesty the queen", "his majesty the king",
  "her majesty", "his majesty", "regina", "rex", "the crown", "la reine", "le roi",
  "sa majesté la reine", "sa majesté le roi"]);

/** Typography-only normalisation: periods deleted, whitespace collapsed, quote/dash glyphs unified. */
export function normaliseName(value: string, rule: NameRule) {
  let text = value.normalize("NFKC")
    .replace(/[‘’ʼ`´]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[‐-―−]/gu, "-").replace(/\./gu, "").replace(/\s+/gu, " ").trim();
  if (rule.caseFold) text = text.toLocaleLowerCase("en");
  if (!rule.crown && !rule.unordered) return text;
  let parties = text.split(/ (?:v|vs|c) /iu);
  if (rule.crown) parties = parties.map((p) => CROWN.has(p.toLocaleLowerCase("en")) ? "r" : p);
  if (rule.unordered && parties.length === 2) parties = [...parties].sort();
  return parties.join(" v ");
}

// ---------------------------------------------------------------- year rules
export type YearKind = "decision" | "report-bracket" | "report-paren" | "unknown";
export function yearKind(c: Citation): YearKind {
  if (c.format === "can_lii" || c.format === "neutral") return "decision";
  if (c.format !== "reporter") return "unknown";
  const head = c.span.text.trimStart()[0];
  return head === "[" ? "report-bracket" : head === "(" ? "report-paren" : "unknown";
}

export type YearRule = { name: string; window: (kind: YearKind, year: number) => number[] };
export const YEAR_RULES: Record<string, YearRule> = {
  strict: { name: "decision year = cited year (all formats)", window: (_k, y) => [y] },
  // A bracketed (volume-)year names the reporter volume; the decision is that year or earlier.
  aware: { name: "CanLII/neutral/(year): = cited year; [year] reporter: cited year or one before",
    window: (k, y) => k === "report-bracket" ? [y, y - 1] : [y] },
  aware2: { name: "as aware, but [year] reporter window = cited year .. two before",
    window: (k, y) => k === "report-bracket" ? [y, y - 1, y - 2] : [y] },
};

// ---------------------------------------------------------------- court rule
/**
 * The A2AJ dataset for a citation's court id (from a CanLII parenthetical, a neutral series, or a
 * court-implying reporter such as SCR). The id names the dataset, or - measured by measure.ts on
 * A2AJ's own citations - A2AJ files every record of that court in one other dataset (e.g. nssf -> NSSC).
 */
export function courtResolver(datasets: Set<string>, observed: Record<string, number>) {
  const map = new Map<string, string>();
  for (const pair of Object.keys(observed)) {
    const [id, dataset] = pair.split("->");
    if (!datasets.has(id.toUpperCase())) map.set(id, map.has(id) && map.get(id) !== dataset ? "" : dataset);
  }
  const resolve = (courtId?: string) => !courtId ? null
    : datasets.has(courtId.toUpperCase()) ? courtId.toUpperCase() : map.get(courtId) || null;
  return Object.assign(resolve, { map });
}

// ---------------------------------------------------------------- matcher
export type NameIndex = Map<string, number[]>;
const indexKey = (dataset: string, year: number, name: string) => `${dataset}|${year}|${name}`;

export function buildNameIndex(cases: Iterable<Case>, rule: NameRule): NameIndex {
  const index: NameIndex = new Map();
  for (const item of cases) {
    if (item.year === null) continue;
    for (const name of new Set(item.names.map((n) => normaliseName(n, rule)))) {
      const key = indexKey(item.dataset, item.year, name);
      const list = index.get(key);
      if (!list) index.set(key, [item.id]);
      else if (!list.includes(item.id)) list.push(item.id);
    }
  }
  return index;
}

export type Query = { style: string; dataset: string; years: number[] };
export type Outcome = { status: "match" | "zero" | "multi"; ids: number[] };

/** The proposed fallback: one record named exactly so, in that dataset and year window, or abstain. */
export function matchStyle(index: NameIndex, rule: NameRule, query: Query): Outcome {
  const name = normaliseName(query.style, rule);
  const ids = new Set<number>();
  for (const year of query.years) for (const id of index.get(indexKey(query.dataset, year, name)) ?? []) ids.add(id);
  const list = [...ids];
  return { status: list.length === 1 ? "match" : list.length ? "multi" : "zero", ids: list };
}

// ---------------------------------------------------------------- ambiguity guards (measured extensions)
/**
 * Proceeding guard: abstain when the same normalised name also names another record of the same
 * dataset in the year just outside the window (an active multi-ruling proceeding, where a missing
 * or differently named sibling ruling would be silently replaced by this one).
 */
export function proceedingGuard(index: NameIndex, rule: NameRule, query: Query, outcome: Outcome): Outcome {
  if (outcome.status !== "match") return outcome;
  const name = normaliseName(query.style, rule);
  for (const year of [Math.min(...query.years) - 1, Math.max(...query.years) + 1])
    if ((index.get(indexKey(query.dataset, year, name)) ?? []).some((id) => id !== outcome.ids[0]))
      return { status: "multi", ids: outcome.ids };
  return outcome;
}

const STOP = new Set(["v", "vs", "c", "r", "the", "queen", "king", "la", "le", "les", "reine", "roi", "her", "his",
  "majesty", "regina", "rex", "sa", "majeste", "and", "et", "al", "of", "de", "du", "des", "d", "l", "in", "re",
  "inc", "ltd", "ltee", "limited", "corp", "corporation", "company", "co", "llp"]);
export const nameTokens = (value: string) => new Set(value.normalize("NFKD").replace(/[̀-ͯ]/gu, "")
  .toLocaleLowerCase("en").replace(/\./gu, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t)));

export type TokenIndex = { tokens: Map<number, Set<string>>; byKey: Map<string, number[]> };
/** dataset|year|token -> record ids, for the near-name guard. */
export function buildTokenIndex(cases: Iterable<Case>): TokenIndex {
  const tokens = new Map<number, Set<string>>(), byKey = new Map<string, number[]>();
  for (const item of cases) {
    if (item.year === null) continue;
    const set = new Set(item.names.flatMap((n) => [...nameTokens(n)]));
    tokens.set(item.id, set);
    for (const t of set) {
      const key = indexKey(item.dataset, item.year, t);
      const list = byKey.get(key);
      if (list) list.push(item.id); else byKey.set(key, [item.id]);
    }
  }
  return { tokens, byKey };
}

/**
 * Near-name guard: abstain when another record of the same dataset and year window has a name whose
 * distinctive tokens overlap the cited style's by Jaccard >= 0.5 (a sibling ruling under a variant name).
 */
export function nearNameGuard(tokenIndex: TokenIndex, query: Query, outcome: Outcome): Outcome {
  if (outcome.status !== "match") return outcome;
  const mine = nameTokens(query.style);
  if (!mine.size) return outcome;
  for (const year of query.years) {
    // candidates share one of the query's two rarest tokens in that dataset-year
    const lists = [...mine].map((t) => tokenIndex.byKey.get(indexKey(query.dataset, year, t)) ?? []);
    const rarest = new Set(lists.filter((l) => l.length).sort((a, b) => a.length - b.length).slice(0, 2).flat());
    for (const id of rarest) {
      if (id === outcome.ids[0]) continue;
      const other = tokenIndex.tokens.get(id)!;
      let shared = 0;
      for (const t of mine) if (other.has(t)) shared++;
      if (shared / (mine.size + other.size - shared) >= 0.5) return { status: "multi", ids: [outcome.ids[0], id] };
    }
  }
  return outcome;
}
