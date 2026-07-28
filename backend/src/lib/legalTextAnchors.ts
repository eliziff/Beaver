/**
 * Deterministic typed-anchor extraction and two-way coverage for legal text.
 *
 * Legal drafting concentrates its load-bearing specifics in a few
 * machine-recognizable forms: money, percentages, ratio multiples, dates,
 * durations, and statutory citations. This module extracts those anchors and
 * canonicalizes each to a value-based key, so "$2.25 million" and
 * "$2,250,000" collide, as do "March 15, 2027" and "3/15/2027". Coverage
 * then diffs a draft against its sources in both directions:
 *
 *  - source-only anchors are omission candidates: facts the draft never
 *    states in any form;
 *  - draft-only anchors are grounding candidates: figures no source
 *    contains — computed, mistranscribed, or invented.
 *
 * It also audits the words-and-numerals redundancy convention ("thirty (30)
 * days"): a pair whose words and numerals disagree is a drafting defect.
 *
 * Deliberate scope limits: month-year mentions ("March 2027") are NOT date
 * anchors — a full date in the sources stays unmatched until the draft
 * states the actual date, which is the behavior a completeness check needs.
 * Presence arithmetic never involves a model; relevance triage of the
 * reported rows is the caller's job.
 */

export type AnchorClass =
  | "money"
  | "percent"
  | "ratio"
  | "date"
  | "duration"
  | "statute"
  | "cite";

export interface AnchorHit {
  cls: AnchorClass;
  /** text as matched */
  raw: string;
  /** canonical value key; equal keys mean the same fact */
  norm: string;
  /** char offset into the searched text */
  index: number;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const MONTH_ALTERNATION = Object.keys(MONTHS)
  .map((name) => name[0].toUpperCase() + name.slice(1))
  .join("|");

const MULTIPLIERS: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  mm: 1e6,
  billion: 1e9,
  b: 1e9,
  bn: 1e9,
};

const numeric = (digits: string) => Number(digits.replace(/,/gu, ""));

/** Round to cents so 1.523 * 1e6 cannot leave float dust in a key. */
const cents = (value: number) => Math.round(value * 100) / 100;

const isoDate = (year: number, month: number, day: number) => {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
};

// Attached suffixes ("$20.0M", "$2.25MM", "$500K", "$3B") are standard
// finance shorthand; the suffix must touch the number so prose like "$5
// Million Dollar Baby" cannot double-count.
const MONEY_RE = new RegExp(
  String.raw`([$€£])\s?(\d[\d,]*(?:\.\d+)?)(?:(MM?|BN?|[KkMmBb])(?![A-Za-z])|\s?(thousand|million|billion|mm|bn)\b)?|\b(\d[\d,]*(?:\.\d+)?)\s?(thousand|million|billion)?\s?(dollars|euros?|pounds sterling)\b`,
  "giu",
);
// "$" stays jurisdiction-neutral: a bare dollar sign is CAD in Canadian
// documents and USD in SEC filings, and a draft restating a source's "$5
// million" means the source's dollars either way.
const CURRENCIES: Record<string, string> = {
  $: "dlr",
  "€": "eur",
  "£": "gbp",
  dollars: "dlr",
  euro: "eur",
  euros: "eur",
  "pounds sterling": "gbp",
};
const PERCENT_RE = /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/giu;
const RATIO_X_RE = /(?<![\w$.])(\d+(?:\.\d+)?)\s?x\b/giu;
const RATIO_TO_ONE_RE =
  /(?<![\w$.])(\d+(?:\.\d+)?)\s?(?::|to)\s?1(?:\.0{1,2})?\b(?!\.\d)/giu;
const DATE_TEXTUAL_RE = new RegExp(
  String.raw`\b(${MONTH_ALTERNATION})\s+(\d{1,2}),?\s+(\d{4})\b`,
  "giu",
);
const DATE_DAY_FIRST_RE = new RegExp(
  String.raw`\b(\d{1,2})\s+(${MONTH_ALTERNATION})\s+(\d{4})\b`,
  "giu",
);
const DATE_NUMERIC_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/gu;
const DURATION_RE =
  /\b(\d{1,4})\s(business\s+days?|calendar\s+days?|trading\s+days?|days?|weeks?|months?|years?|fiscal\s+quarters?|quarters?)\b/giu;
const DURATION_PAREN_RE =
  /\((\d{1,4})\)\s(business\s+days?|calendar\s+days?|trading\s+days?|days?|weeks?|months?|years?|fiscal\s+quarters?|quarters?)\b/giu;
const STATUTE_REPORTER_RE =
  /\b(\d{1,3})\s+((?:[A-Z][A-Za-z.]{0,10}\s+){1,4})§{1,2}\s?(\d[\w.\-]*(?:\([^)\s]{1,6}\)){0,4})/gu;
const STATUTE_NAMED_ACT_RE =
  /\b[Ss]ection\s+(\d[\w.]*(?:\([^)\s]{1,6}\)){0,3})\s+of\s+the\s+([A-Z][\w'’ .\-]{2,60}?\s+(?:Act|Code))\b/gu;
// Canadian statute citations: "R.S.C. 1985, c. C-46, s. 231", "S.O. 2002,
// c. 24, Sched. B", "C.C.S.M. c. F158". Series list covers the federal and
// common provincial forms; extend it as the Canadian anchor-forms inventory
// surfaces gaps. Case-sensitive so lowercase "ss. 3" cannot read as a series.
const CA_STATUTE_SERIES = [
  "RSNWT", "SNWT", "RSPEI", "SPEI", "CCSM",
  "RSNB", "SNB", "RSNS", "SNS", "RSNL", "SNL",
  "RSBC", "SBC", "RSC", "RSO", "RSA", "RSS", "RSM", "RSY",
  "SC", "SO", "SA", "SS", "SM", "SY",
];
const CA_SERIES_PATTERN = CA_STATUTE_SERIES.map(
  (series) => `${series.split("").join("\\.?")}\\.?`,
).join("|");
const STATUTE_CANADIAN_RE = new RegExp(
  String.raw`\b(${CA_SERIES_PATTERN})\s+(?:(\d{4}),?\s+)?c\.\s?([A-Za-z0-9.\-]+)` +
    String.raw`(?:,\s*Sched(?:ule)?\.?\s*([A-Za-z0-9]+))?` +
    String.raw`(?:,\s*ss?\.\s*(\d[\w().]*))?`,
  "gu",
);
// Neutral Canadian case citations ("2015 SCC 5") and the common US reporter
// forms ("372 U.S. 335", "550 F. Supp. 2d 191"): dropped citations are a
// real omission class in legal drafting, and both grammars are regex-clean.
const CITE_NEUTRAL_RE =
  /\b((?:19|20)\d{2})\s+(SCC|FCA|FC|TCC|ONCA|ONSC|ONCJ|BCCA|BCSC|ABCA|ABQB|ABKB|SKCA|SKQB|SKKB|MBCA|MBQB|MBKB|NSCA|NSSC|NBCA|NBQB|NBKB|QCCA|QCCS|QCCQ|PECA|PESC|NLCA|NLSC|YKCA|YKSC|NWTCA|NWTSC|NUCA|NUCJ)\s+(\d{1,5})\b/gu;
const CITE_US_REPORTER_RE =
  /\b(\d{1,4})\s+(U\.?S\.?|S\.\s?Ct\.|F\.\s?(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?(?:2d|3d))?|L\.\s?Ed\.(?:\s?2d)?)\s+(\d{1,5})\b/gu;

const durationUnit = (unit: string) =>
  unit.toLowerCase().replace(/\s+/gu, "_").replace(/s$/u, "");

function pushMoneyMatches(text: string, hits: AnchorHit[]) {
  type Pending = {
    raw: string;
    index: number;
    value: number;
    currency: string;
    hasMultiplier: boolean;
  };
  const pending: Pending[] = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const digits = match[2] ?? match[5];
    const word = (match[3] ?? match[4] ?? match[6])?.toLowerCase();
    const currency = CURRENCIES[(match[1] ?? match[7] ?? "$").toLowerCase()];
    if (!digits || !currency) continue;
    pending.push({
      raw: match[0],
      index: match.index ?? 0,
      value: numeric(digits) * (word ? MULTIPLIERS[word] : 1),
      currency,
      hasMultiplier: Boolean(word),
    });
  }
  // Range inheritance: in "$40–$50 million" the "$40" leg means forty
  // million. A bare amount separated from a multiplied amount only by a
  // range word borrows that multiplier.
  for (let i = 0; i < pending.length; i += 1) {
    const current = pending[i];
    const next = pending[i + 1];
    if (current.hasMultiplier || !next?.hasMultiplier) continue;
    // Only short forms borrow a multiplier: "$40–$50 million" means forty
    // million, but in "$500,000–$2 million" the first leg is already
    // fully written out.
    if (current.raw.includes(",") || current.value >= 10_000) continue;
    const gap = text.slice(current.index + current.raw.length, next.index);
    if (/^\s?(?:–|—|-|to|through)\s?$/iu.test(gap)) {
      const bare = pending[i];
      const multiplied = next.value / numeric(next.raw.match(/\d[\d,]*(?:\.\d+)?/u)![0]);
      bare.value *= multiplied;
    }
  }
  for (const entry of pending) {
    hits.push({
      cls: "money",
      raw: entry.raw,
      norm: `money:${entry.currency}:${cents(entry.value)}`,
      index: entry.index,
    });
  }
}

export function extractAnchors(text: string): AnchorHit[] {
  const hits: AnchorHit[] = [];
  pushMoneyMatches(text, hits);
  for (const match of text.matchAll(PERCENT_RE)) {
    hits.push({
      cls: "percent",
      raw: match[0],
      norm: `pct:${numeric(match[1])}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(RATIO_X_RE)) {
    hits.push({
      cls: "ratio",
      raw: match[0],
      norm: `ratio:${Number(match[1])}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(RATIO_TO_ONE_RE)) {
    hits.push({
      cls: "ratio",
      raw: match[0],
      norm: `ratio:${Number(match[1])}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(DATE_TEXTUAL_RE)) {
    const iso = isoDate(
      Number(match[3]),
      MONTHS[match[1].toLowerCase()],
      Number(match[2]),
    );
    if (iso) {
      hits.push({ cls: "date", raw: match[0], norm: `date:${iso}`, index: match.index });
    }
  }
  for (const match of text.matchAll(DATE_DAY_FIRST_RE)) {
    const iso = isoDate(
      Number(match[3]),
      MONTHS[match[2].toLowerCase()],
      Number(match[1]),
    );
    if (iso) {
      hits.push({ cls: "date", raw: match[0], norm: `date:${iso}`, index: match.index });
    }
  }
  for (const match of text.matchAll(DATE_NUMERIC_RE)) {
    let month = Number(match[1]);
    let day = Number(match[2]);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    const yearRaw = Number(match[3]);
    const year = match[3].length === 2 ? 2000 + yearRaw : yearRaw;
    const iso = isoDate(year, month, day);
    if (iso) {
      hits.push({ cls: "date", raw: match[0], norm: `date:${iso}`, index: match.index });
    }
  }
  for (const re of [DURATION_RE, DURATION_PAREN_RE]) {
    for (const match of text.matchAll(re)) {
      hits.push({
        cls: "duration",
        raw: match[0],
        norm: `dur:${Number(match[1])}:${durationUnit(match[2])}`,
        index: match.index ?? 0,
      });
    }
  }
  for (const match of text.matchAll(STATUTE_REPORTER_RE)) {
    const reporter = match[2].toLowerCase().replace(/[.\s]/gu, "");
    const section = match[3].toLowerCase().replace(/\.+$/u, "");
    hits.push({
      cls: "statute",
      raw: match[0].trim(),
      norm: `stat:${match[1]}${reporter}:${section}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(STATUTE_NAMED_ACT_RE)) {
    const act = match[2].toLowerCase().replace(/[^a-z0-9]/gu, "");
    hits.push({
      cls: "statute",
      raw: match[0].trim(),
      norm: `stat:${act}:s${match[1].toLowerCase()}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(STATUTE_CANADIAN_RE)) {
    const series = match[1].replace(/\./gu, "").toLowerCase();
    const parts = [`stat:${series}${match[2] ?? ""}`, `c${match[3].toLowerCase()}`];
    if (match[4]) parts.push(`sched${match[4].toLowerCase()}`);
    if (match[5]) parts.push(`s${match[5].toLowerCase()}`);
    hits.push({
      cls: "statute",
      raw: match[0].trim(),
      norm: parts.join(":"),
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(CITE_NEUTRAL_RE)) {
    hits.push({
      cls: "cite",
      raw: match[0],
      norm: `cite:${match[1]}${match[2].toLowerCase()}${match[3]}`,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(CITE_US_REPORTER_RE)) {
    const reporter = match[2].toLowerCase().replace(/[.\s]/gu, "");
    hits.push({
      cls: "cite",
      raw: match[0],
      norm: `cite:${match[1]}${reporter}${match[3]}`,
      index: match.index ?? 0,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Words-and-numerals redundancy: "thirty (30) days"
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

/** "one hundred twenty", "forty-five" -> number; null when any token is not a number word. */
export function wordPhraseToNumber(phrase: string): number | null {
  const tokens = phrase
    .toLowerCase()
    .split(/[\s\-]+/u)
    .filter((token) => token && token !== "and");
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  let sawWord = false;
  for (const token of tokens) {
    if (token in NUMBER_WORDS) {
      current += NUMBER_WORDS[token];
      sawWord = true;
    } else if (token === "hundred") {
      current = (current || 1) * NUMBER_SCALES.hundred;
      sawWord = true;
    } else if (token in NUMBER_SCALES) {
      total += (current || 1) * NUMBER_SCALES[token];
      current = 0;
      sawWord = true;
    } else {
      return null;
    }
  }
  return sawWord ? total + current : null;
}

export interface NumeralWordPairResult {
  /** pairs where a number-word phrase directly precedes "(N)" */
  checked: number;
  mismatches: Array<{
    phrase: string;
    wordsValue: number;
    numeral: number;
    index: number;
    excerpt: string;
  }>;
}

const PAREN_NUMERAL_RE = /\((\d[\d,]{0,14})\)/gu;
const TRAILING_WORDS_RE = /([A-Za-z]+(?:[\s\-][A-Za-z]+){0,6})\s*$/u;

/**
 * "shall be three" -> "three"; "one hundred twenty" -> itself. The longest
 * trailing run of number words is the phrase the numeral restates.
 */
function numberWordSuffix(phrase: string): string | null {
  const tokens = phrase.split(/[\s\-]+/u).filter(Boolean);
  let start = tokens.length;
  while (start > 0) {
    const token = tokens[start - 1].toLowerCase();
    if (token in NUMBER_WORDS || token in NUMBER_SCALES || token === "and") {
      start -= 1;
    } else {
      break;
    }
  }
  const suffix = tokens.slice(start);
  // A bare trailing "and" ("...terms and (3)...") is not a number phrase.
  while (suffix.length && suffix[0].toLowerCase() === "and") suffix.shift();
  return suffix.length ? suffix.join(" ") : null;
}

export function numeralWordPairs(text: string): NumeralWordPairResult {
  const result: NumeralWordPairResult = { checked: 0, mismatches: [] };
  for (const match of text.matchAll(PAREN_NUMERAL_RE)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - 60), at);
    const phraseMatch = before.match(TRAILING_WORDS_RE);
    if (!phraseMatch) continue;
    const numberPhrase = numberWordSuffix(phraseMatch[1]);
    if (!numberPhrase) continue;
    const wordsValue = wordPhraseToNumber(numberPhrase);
    if (wordsValue === null) continue;
    result.checked += 1;
    const numeral = numeric(match[1]);
    if (numeral !== wordsValue) {
      result.mismatches.push({
        phrase: phraseMatch[1],
        wordsValue,
        numeral,
        index: at,
        excerpt: excerpt(text, at, match[0].length),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Two-way coverage
// ---------------------------------------------------------------------------

export interface AnchorDocument {
  name: string;
  text: string;
}

export interface AnchorRow {
  norm: string;
  /** representative surface form */
  display: string;
  /** total occurrences across the side's documents */
  count: number;
  documents: string[];
  excerpt: string;
}

export interface AnchorClassCoverage {
  source_distinct: number;
  draft_distinct: number;
  matched: number;
  source_only: AnchorRow[];
  draft_only: AnchorRow[];
  source_only_truncated: boolean;
  draft_only_truncated: boolean;
}

export interface AnchorCoverageReport {
  classes: Record<AnchorClass, AnchorClassCoverage>;
  numeral_word_pairs: {
    checked: number;
    mismatches: Array<
      NumeralWordPairResult["mismatches"][number] & { document: string }
    >;
  };
  source_documents: string[];
  draft_documents: string[];
}

const ANCHOR_CLASSES: AnchorClass[] = [
  "date",
  "duration",
  "money",
  "ratio",
  "percent",
  "statute",
  "cite",
];

function excerpt(text: string, index: number, rawLength: number) {
  return text
    .slice(Math.max(0, index - 45), index + rawLength + 55)
    .replace(/\s+/gu, " ")
    .trim();
}

type SideEntry = {
  cls: AnchorClass;
  display: string;
  count: number;
  documents: Set<string>;
  excerpt: string;
};

function collectSide(documents: AnchorDocument[]) {
  const entries = new Map<string, SideEntry>();
  for (const document of documents) {
    for (const hit of extractAnchors(document.text)) {
      const existing = entries.get(hit.norm);
      if (existing) {
        existing.count += 1;
        existing.documents.add(document.name);
        if (hit.raw.length < existing.display.length) existing.display = hit.raw;
      } else {
        entries.set(hit.norm, {
          cls: hit.cls,
          display: hit.raw,
          count: 1,
          documents: new Set([document.name]),
          excerpt: excerpt(document.text, hit.index, hit.raw.length),
        });
      }
    }
  }
  return entries;
}

function rows(
  entries: Map<string, SideEntry>,
  cls: AnchorClass,
  exclude: Map<string, SideEntry>,
  maxRows: number,
): { rows: AnchorRow[]; truncated: boolean; distinct: number; matched: number } {
  const only: AnchorRow[] = [];
  let distinct = 0;
  let matched = 0;
  for (const [norm, entry] of entries) {
    if (entry.cls !== cls) continue;
    distinct += 1;
    if (exclude.has(norm)) {
      matched += 1;
      continue;
    }
    only.push({
      norm,
      display: entry.display,
      count: entry.count,
      documents: [...entry.documents],
      excerpt: entry.excerpt,
    });
  }
  only.sort((a, b) => b.count - a.count || a.norm.localeCompare(b.norm));
  return {
    rows: only.slice(0, maxRows),
    truncated: only.length > maxRows,
    distinct,
    matched,
  };
}

export function anchorCoverage(
  sources: AnchorDocument[],
  drafts: AnchorDocument[],
  options?: { maxRowsPerClass?: number },
): AnchorCoverageReport {
  const maxRows = Math.max(1, options?.maxRowsPerClass ?? 40);
  const sourceEntries = collectSide(sources);
  const draftEntries = collectSide(drafts);

  const classes = Object.fromEntries(
    ANCHOR_CLASSES.map((cls) => {
      const source = rows(sourceEntries, cls, draftEntries, maxRows);
      const draft = rows(draftEntries, cls, sourceEntries, maxRows);
      const coverage: AnchorClassCoverage = {
        source_distinct: source.distinct,
        draft_distinct: draft.distinct,
        matched: source.matched,
        source_only: source.rows,
        draft_only: draft.rows,
        source_only_truncated: source.truncated,
        draft_only_truncated: draft.truncated,
      };
      return [cls, coverage];
    }),
  ) as Record<AnchorClass, AnchorClassCoverage>;

  const mismatches: AnchorCoverageReport["numeral_word_pairs"]["mismatches"] =
    [];
  let checked = 0;
  for (const document of [...sources, ...drafts]) {
    const pairs = numeralWordPairs(document.text);
    checked += pairs.checked;
    for (const mismatch of pairs.mismatches) {
      mismatches.push({ ...mismatch, document: document.name });
    }
  }

  return {
    classes,
    numeral_word_pairs: { checked, mismatches },
    source_documents: sources.map((document) => document.name),
    draft_documents: drafts.map((document) => document.name),
  };
}
