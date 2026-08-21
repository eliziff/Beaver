import { normalizeWhitespace } from "./text";
import { sha256 } from "./hash";

/**
 * One immutable, content-hashed artifact per fetched source (master plan
 * P1.1a). Providers compile into this; every consumer question - locator
 * lookup, quote verification, block slicing, pinpoint text fragments - is a
 * query over it rather than a fresh parse of a raw string.
 */

export type SourceDocProvider =
  | "a2aj"
  | "courtlistener"
  | "tna"
  | "govinfo"
  | "govuk-et"
  | "journal"
  | "local-pdf";

export type SourceDocLocatorKind =
  | "paragraph"
  | "page"
  | "section"
  | "footnote";

/** Where a block boundary came from, not how confident we are in its text. */
type SourceDocOrigin = "native" | "heuristic";

export type WordSpan = { word: string; start: number; end: number };

export type SourceDocBlock = {
  kind: SourceDocLocatorKind;
  label: string;
  start: number;
  end: number;
  origin: SourceDocOrigin;
  anchor?: string;
  aliases?: string[];
  parentLabel?: string;
};

/**
 * What the document can actually answer for one locator kind. Ranges replace
 * the bare counts the old summary carried: a count of 313 says nothing about
 * whether paragraph 12 exists, a range does.
 */
type SourceDocLocatorRange = {
  kind: SourceDocLocatorKind;
  count: number;
  first: string | null;
  last: string | null;
  missing: string[];
  missingTruncated: boolean;
};

export type SourceDoc = {
  /** null for a rendition whose provider compiler has not landed yet. */
  provider: SourceDocProvider | null;
  id: string;
  url: string | null;
  /** content sha256 of `text` - cache key and staleness key, computed on use */
  revision: string;
  docType: "cases" | "laws" | null;
  status: "usable" | "unavailable";
  text: string;
  /** tokenized exactly once, lazily (see createSourceDoc) */
  tokens: WordSpan[];
  blocks: SourceDocBlock[];
  /** normalized locator -> index into `blocks` */
  index: Map<string, number>;
  ranges: Record<SourceDocLocatorKind, SourceDocLocatorRange>;
};

export type SourceDocLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  requestedLabel: string;
  matches: string[];
  block: (SourceDocBlock & { text: string }) | null;
  before: Array<SourceDocBlock & { text: string }>;
  after: Array<SourceDocBlock & { text: string }>;
};

const LOCATOR_KINDS: SourceDocLocatorKind[] = [
  "paragraph",
  "page",
  "section",
  "footnote",
];
const MAX_REPORTED_MISSING = 64;

// Identical to legalSourceLinks' WORD_RE so quote matching cannot diverge
// between the link builder and the SourceDoc index.
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function tokenizeSourceText(text: string): WordSpan[] {
  const tokens: WordSpan[] = [];
  for (const match of text.matchAll(WORD_RE)) {
    tokens.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

/**
 * A quote as the document would have written it: outer quotation marks gone,
 * editorial alterations resolved ("[T]he" -> "The", "[emphasis added]" ->
 * "emphasis added") and elisions turned into a gap.
 */
export function sourceDocQuoteText(text: string) {
  return normalizeWhitespace(
    text
      .trim()
      .replace(/^["'“”]+|["'“”]+$/gu, "")
      .replace(/\[([A-Za-z])\](?=[A-Za-z])/gu, "$1")
      .replace(/\[([^\]]+)\]/gu, "$1")
      .replace(/\.{3}|…/gu, " "),
  );
}

export function sourceDocQuoteWords(quote: string) {
  return tokenizeSourceText(sourceDocQuoteText(quote)).map(({ word }) => word);
}

function labelNumber(kind: SourceDocLocatorKind, label: string) {
  const match = label.match(kind === "section" ? /^sec(\d{1,8})(?:$|[.\-(])/iu
    : /^(?:par|page=?|fn)(\d{1,6})$/iu);
  return match ? Number(match[1]) : null;
}

function locatorRange(
  kind: SourceDocLocatorKind,
  blocks: SourceDocBlock[],
): SourceDocLocatorRange {
  const empty = {
    kind,
    count: 0,
    first: null,
    last: null,
    missing: [],
    missingTruncated: false,
  };
  if (!blocks.length) return empty;
  const physicalLabels = new Set(
    blocks.map((block) => block.label.toLowerCase()),
  );
  const aliasOnly = new Set(
    blocks.flatMap((block) =>
      (block.aliases ?? [])
        .map((label) => label.toLowerCase())
        .filter((label) => !physicalLabels.has(label)),
    ),
  );
  const count = blocks.length + aliasOnly.size;
  // Sections nest, so only top-level provisions define the advertised range;
  // paragraphs, pages and footnotes are flat.
  const spine =
    kind === "section"
      ? blocks.filter((block) => !block.label.includes("("))
      : blocks;
  if (!spine.length) {
    return { ...empty, count };
  }
  const numbered = [
    ...new Set(
      spine.flatMap((block) => [block.label, ...(block.aliases ?? [])]),
    ),
  ].map((label) => ({
    label,
    value: labelNumber(kind, label),
  }));
  const present = numbered.filter(
    (entry): entry is { label: string; value: number } => entry.value !== null,
  );
  if (present.length !== numbered.length) {
    // A non-numeric spine (e.g. "A.01.001") has an order but no gap notion.
    return {
      kind,
      count,
      first: spine[0].label,
      last: spine.at(-1)!.label,
      missing: [],
      missingTruncated: false,
    };
  }
  const values = new Set(present.map((entry) => entry.value));
  const lowest = present.reduce((best, entry) =>
    entry.value < best.value ? entry : best,
  );
  const highest = present.reduce((best, entry) =>
    entry.value > best.value ? entry : best,
  );
  const missing: string[] = [];
  let missingTruncated = false;
  for (let value = lowest.value + 1; value < highest.value; value += 1) {
    if (values.has(value)) continue;
    if (missing.length >= MAX_REPORTED_MISSING) {
      missingTruncated = true;
      break;
    }
    missing.push(
      kind === "section"
        ? `sec${value}`
        : kind === "paragraph"
          ? `par${value}`
          : kind === "page"
            ? `page${value}`
            : `fn${value}`,
    );
  }
  return {
    kind,
    count,
    first: lowest.label,
    last: highest.label,
    missing,
    missingTruncated,
  };
}

export function createSourceDoc(args: {
  provider: SourceDocProvider | null;
  id: string;
  url?: string | null;
  docType?: "cases" | "laws" | null;
  text: string;
  blocks: SourceDocBlock[];
}): SourceDoc {
  const blocks = args.blocks;
  const index = new Map<string, number>();
  const duplicates = new Set<string>();
  const byKind: Record<SourceDocLocatorKind, SourceDocBlock[]> = {
    paragraph: [], page: [], section: [], footnote: [],
  };
  blocks.forEach((block, position) => {
    byKind[block.kind].push(block);
    for (const label of new Set(
      [block.label, ...(block.aliases ?? []), block.anchor].filter(
        (value): value is string => Boolean(value),
      ),
    )) {
      const key = label.toLowerCase();
      if (index.has(key)) duplicates.add(key);
      else index.set(key, position);
    }
  });
  for (const key of duplicates) index.delete(key);
  const ranges = Object.fromEntries(
    LOCATOR_KINDS.map((kind) => [
      kind,
      locatorRange(kind, byKind[kind]),
    ]),
  ) as Record<SourceDocLocatorKind, SourceDocLocatorRange>;

  const doc: SourceDoc = {
    provider: args.provider,
    id: args.id,
    url: args.url ?? null,
    revision: "",
    docType: args.docType ?? null,
    status: blocks.length ? "usable" : "unavailable",
    text: args.text,
    tokens: [],
    blocks,
    index,
    ranges,
  };
  // Tokenizing (or hashing) a 2.3 MB statute costs far more than compiling it,
  // and most documents are never quote-checked. Do each once, on first use,
  // and never again; the properties are non-enumerable so a stray
  // JSON.stringify of a SourceDoc cannot force (or serialize) them.
  let tokens: WordSpan[] | null = null;
  Object.defineProperty(doc, "tokens", {
    enumerable: false,
    configurable: false,
    get() {
      return (tokens ??= tokenizeSourceText(doc.text));
    },
  });
  let revision: string | null = null;
  Object.defineProperty(doc, "revision", {
    enumerable: true,
    configurable: false,
    get() {
      return (revision ??= sha256(doc.text));
    },
  });
  return doc;
}

/**
 * A SourceDoc view of a text-only artifact whose upstream representation has
 * no structural blocks. It carries the text and token index used by quote and
 * fragment queries; provider compilers should pass their real SourceDoc
 * instead of converting it through this helper.
 */
export function createTextSourceDoc(text: string): SourceDoc {
  return createSourceDoc({ provider: null, id: "", text, blocks: [] });
}

/**
 * "[para. 12]", "para 12", "12" -> "par12". One grammar for every provider;
 * unrecognized input returns "" rather than a guess.
 */
export function normalizeSourceDocLocator(
  kind: SourceDocLocatorKind,
  locator: string,
) {
  const value = locator.trim();
  if (kind === "footnote") {
    const match = value.match(/^(?:fn|footnotes?|notes?)?[\s#.]*(\d{1,5})$/iu);
    return match ? `fn${Number(match[1])}` : "";
  }
  if (kind === "paragraph") {
    const match = value.match(
      /^(?:\[\s*)?(?:paras?\.?|paragraphs?)?\s*(\d{1,4})(?:\s*\])?$/iu,
    );
    return match ? `par${Number(match[1])}` : "";
  }
  if (kind === "page") {
    const match = value.match(/^(?:pages?|pp?\.)?\s*(\d{1,4})$/iu);
    return match ? `page${Number(match[1])}` : "";
  }
  const compact = value
    .replace(/^(?:ss?\.?|sections?)\s*/iu, "")
    .replace(/\s+/gu, "");
  // Federal regulations number sections alphanumerically ("A.01.001"); every
  // other corpus numbers them decimally ("83.01(1)(b)(ii)").
  return /^\d{1,8}[A-Za-z]{0,3}(?:[.-]\d{1,8}[A-Za-z]{0,3}){0,3}(?:\([^)]+\))*$/u.test(compact) ||
    /^[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3}(?:\([^)]+\))*$/u.test(compact)
    ? `sec${compact}`
    : "";
}

export function sourceDocBlockText(doc: SourceDoc, block: SourceDocBlock) {
  return doc.text.slice(block.start, block.end).trim();
}

function materialize(doc: SourceDoc, block: SourceDocBlock) {
  return { ...block, text: sourceDocBlockText(doc, block) };
}

function sourceDocBlocksOfKind(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
) {
  return doc.blocks.filter((block) => block.kind === kind);
}

export function lookupSourceDoc(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
): SourceDocLookup {
  return lookupSourceDocLabel(
    doc,
    kind,
    normalizeSourceDocLocator(kind, locator),
    contextBlocks,
  );
}

/**
 * The lookup engine behind lookupSourceDoc, for callers whose locator grammar
 * is wider than the shared one (provider-native labels, titles): they resolve
 * `requestedLabel` themselves and share everything after normalization.
 */
export function lookupSourceDocLabel(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  requestedLabel: string,
  contextBlocks = 0,
): SourceDocLookup {
  const available = sourceDocBlocksOfKind(doc, kind);
  if (!requestedLabel || !available.length) {
    return {
      status: "unavailable",
      requestedLabel,
      matches: [],
      block: null,
      before: [],
      after: [],
    };
  }
  const key = requestedLabel.toLowerCase();
  const position = doc.index.get(key);
  const selected =
    position !== undefined && doc.blocks[position].kind === kind
      ? doc.blocks[position]
      : null;
  if (!selected) {
    const matches = available.filter((block) =>
      [block.label, ...(block.aliases ?? [])].some(
        (label) => label.toLowerCase() === key,
      ),
    );
    return {
      status: matches.length ? "ambiguous" : "not_found",
      requestedLabel,
      matches: matches.map((block) => block.label),
      block: null,
      before: [],
      after: [],
    };
  }
  const order = available.indexOf(selected);
  const context = Math.min(Math.max(Math.trunc(contextBlocks), 0), 2);
  return {
    status: "found",
    requestedLabel,
    matches: [selected.label],
    block: materialize(doc, selected),
    before: available
      .slice(Math.max(0, order - context), order)
      .map((block) => materialize(doc, block)),
    after: available
      .slice(order + 1, order + 1 + context)
      .map((block) => materialize(doc, block)),
  };
}

/**
 * Block-range slicing: every block of `kind` from `from` through `to`
 * inclusive, in document order. Fails closed (empty) when either endpoint is
 * unknown rather than guessing a range.
 */
export function sliceSourceDocBlocks(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  from: string,
  to: string = from,
) {
  const available = sourceDocBlocksOfKind(doc, kind);
  const find = (locator: string) => {
    const label = normalizeSourceDocLocator(kind, locator).toLowerCase();
    return label
      ? available.findIndex((block) =>
          [block.label, ...(block.aliases ?? [])].some(
            (candidate) => candidate.toLowerCase() === label,
          ),
        )
      : -1;
  };
  const first = find(from);
  const last = find(to);
  if (first < 0 || last < 0) return [];
  const [lowest, highest] = first <= last ? [first, last] : [last, first];
  return available.slice(lowest, highest + 1);
}

export function readSourceDocRange(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  from: string,
  to: string,
  contextBlocks = 0,
) {
  const selected = sliceSourceDocBlocks(doc, kind, from, to);
  if (!selected.length) return null;
  const available = sourceDocBlocksOfKind(doc, kind);
  const first = available.indexOf(selected[0]);
  const last = available.indexOf(selected.at(-1)!);
  if (first < 0 || last < first) return null;
  const context = Math.min(Math.max(Math.trunc(contextBlocks), 0), 2);
  return {
    selected: selected.map((block) => materialize(doc, block)),
    before: available
      .slice(Math.max(0, first - context), first)
      .map((block) => materialize(doc, block)),
    after: available
      .slice(last + 1, last + 1 + context)
      .map((block) => materialize(doc, block)),
  };
}

function tokenIndexAtOrAfter(tokens: WordSpan[], offset: number) {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle].start < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export type SourceDocQuoteSpan = {
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
};

/**
 * Search state for one artifact: word postings and line-break offsets.
 *
 * Postings turn "where does this phrase occur" from a scan of the document
 * into a walk of one word's occurrence list - the difference between 2.6 s
 * and 20 ms per quote on the Criminal Code. Building them costs about as much
 * as one scan, so they are built on the artifact's *second* query: a document
 * asked one question stays linear, a document asked twenty (every pinpoint
 * link is at least twenty) pays once. Keyed by the SourceDoc so it dies with
 * it - the artifact's own lazy state, not a cache of artifacts.
 */
type SourceDocSearchState = {
  queries: number;
  postings: Map<string, number[]> | null;
  lineBreaks: number[] | null;
};

const searchStates = new WeakMap<SourceDoc, SourceDocSearchState>();

function searchState(doc: SourceDoc): SourceDocSearchState {
  const existing = searchStates.get(doc);
  if (existing) return existing;
  const created = { queries: 0, postings: null, lineBreaks: null };
  searchStates.set(doc, created);
  return created;
}

function postingsFor(doc: SourceDoc, state: SourceDocSearchState) {
  if (state.postings) return state.postings;
  const postings = new Map<string, number[]>();
  doc.tokens.forEach((token, position) => {
    const bucket = postings.get(token.word);
    if (bucket) bucket.push(position);
    else postings.set(token.word, [position]);
  });
  state.postings = postings;
  return postings;
}

function lineBreaksFor(doc: SourceDoc, state: SourceDocSearchState) {
  if (state.lineBreaks) return state.lineBreaks;
  const lineBreaks: number[] = [];
  for (
    let at = doc.text.indexOf("\n");
    at >= 0;
    at = doc.text.indexOf("\n", at + 1)
  ) {
    lineBreaks.push(at);
  }
  state.lineBreaks = lineBreaks;
  return lineBreaks;
}

function crossesLineBreak(lineBreaks: number[], start: number, end: number) {
  let low = 0;
  let high = lineBreaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lineBreaks[middle] < start) low = middle + 1;
    else high = middle;
  }
  return low < lineBreaks.length && lineBreaks[low] < end;
}

/**
 * First-query path: walk the text with the tokenizer over a ring buffer of the
 * last N words, stopping as soon as `limit` matches are found. A document
 * asked exactly one question - the common single-quote link - never pays to be
 * fully tokenized or indexed, and an abundant phrase stops early instead of
 * scanning to the end.
 */
function scanPhraseSpans(
  doc: SourceDoc,
  words: string[],
  options: SourceDocPhraseOptions,
): SourceDocQuoteSpan[] {
  const spans: SourceDocQuoteSpan[] = [];
  const size = words.length;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const ring: WordSpan[] = Array.from({ length: size }, () => ({
    word: "",
    start: 0,
    end: 0,
  }));
  let seen = 0;
  for (const match of doc.text.matchAll(WORD_RE)) {
    const slot = ring[seen % size];
    slot.word = match[0].toLowerCase();
    slot.start = match.index;
    slot.end = match.index + match[0].length;
    seen += 1;
    if (seen < size) continue;
    let matched = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (ring[(seen - size + offset) % size].word !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = ring[(seen - size) % size];
    const last = ring[(seen - 1) % size];
    // Match the indexed path: only breaks strictly inside [start, end) count,
    // so a phrase ending at end-of-line still sits on one line.
    if (
      options.sameLine &&
      doc.text.lastIndexOf("\n", last.end - 1) >= first.start
    ) {
      continue;
    }
    spans.push({
      start: first.start,
      end: last.end,
      firstWord: seen - size,
      lastWord: seen - 1,
    });
    if (spans.length >= limit) break;
  }
  return spans;
}

export type SourceDocPhraseOptions = {
  /** Only match inside this block. */
  block?: SourceDocBlock;
  /** Reject matches split across a line break (a text fragment cannot span one). */
  sameLine?: boolean;
  /** Stop once this many matches are found. */
  limit?: number;
};

/**
 * Every occurrence of an exact word sequence, in document order. Matching is
 * lowercased word equality over WORD_RE tokens, so a quote that verifies here
 * verifies everywhere.
 */
export function sourceDocPhraseSpans(
  doc: SourceDoc,
  words: string[],
  options: SourceDocPhraseOptions = {},
): SourceDocQuoteSpan[] {
  const spans: SourceDocQuoteSpan[] = [];
  if (!words.length) return spans;
  const state = searchState(doc);
  state.queries += 1;
  if (!state.postings && !options.block && state.queries === 1) {
    return scanPhraseSpans(doc, words, options);
  }
  const tokens = doc.tokens;
  const postings = state.postings ?? postingsFor(doc, state);
  const lineBreaks = options.sameLine ? lineBreaksFor(doc, state) : [];
  const from = options.block
    ? tokenIndexAtOrAfter(tokens, options.block.start)
    : 0;
  const until = options.block
    ? tokenIndexAtOrAfter(tokens, options.block.end)
    : tokens.length;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  // Anchor on the rarest word: "the court held" costs the occurrences of
  // "held", not the occurrences of "the".
  let anchor = 0;
  let rarest = Number.POSITIVE_INFINITY;
  for (const [offset, word] of words.entries()) {
    const size = postings.get(word)?.length ?? 0;
    if (!size) return spans;
    if (size < rarest) {
      rarest = size;
      anchor = offset;
    }
  }

  for (const position of postings.get(words[anchor])!) {
    const start = position - anchor;
    if (start < from) continue;
    if (start + words.length > until) break;
    let matched = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (tokens[start + offset].word !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = tokens[start];
    const last = tokens[start + words.length - 1];
    if (
      options.sameLine &&
      crossesLineBreak(lineBreaks, first.start, last.end)
    ) {
      continue;
    }
    spans.push({
      start: first.start,
      end: last.end,
      firstWord: start,
      lastWord: start + words.length - 1,
    });
    if (spans.length >= limit) break;
  }
  return spans;
}

export function sourceDocContainsQuote(
  doc: SourceDoc,
  quote: string,
  block?: SourceDocBlock,
) {
  return sourceDocPhraseSpans(
    doc, sourceDocQuoteWords(quote), { block }).length > 0;
}
