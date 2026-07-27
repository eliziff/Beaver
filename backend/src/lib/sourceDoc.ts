import crypto from "node:crypto";
import { normalizeA2AJLocator } from "./a2ajStructure";
import { normalizeWhitespace } from "./text";

/**
 * One immutable, content-hashed artifact per fetched source (master plan
 * P1.1a). Providers compile into this; every consumer question - locator
 * lookup, quote verification, block slicing - is a query over it rather than
 * a fresh parse of a raw string.
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
export type SourceDocOrigin = "native" | "heuristic";

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
export type SourceDocLocatorRange = {
  kind: SourceDocLocatorKind;
  count: number;
  first: string | null;
  last: string | null;
  missing: string[];
  missingTruncated: boolean;
};

export type SourceDoc = {
  provider: SourceDocProvider;
  id: string;
  url: string | null;
  /** content sha256 of `text` - cache key and staleness key */
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

/** Quote cleanup copied from legalSourceLinks.quoteText, deliberately. */
function quoteText(text: string) {
  return normalizeWhitespace(
    text
      .trim()
      .replace(/^["'“”]+|["'“”]+$/gu, "")
      .replace(/\[([A-Za-z])\](?=[A-Za-z])/gu, "$1")
      .replace(/\[([^\]]+)\]/gu, "$1")
      .replace(/\.{3}|…/gu, " "),
  );
}

function quoteWords(quote: string) {
  return tokenizeSourceText(quoteText(quote)).map(({ word }) => word);
}

export function sourceDocRevision(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function labelNumber(label: string) {
  const match = label.match(/^(?:par|page=?|fn)(\d{1,6})$/iu);
  return match ? Number(match[1]) : null;
}

function sectionRoot(label: string) {
  const match = label.match(/^sec(\d{1,8})(?:$|[.\-(])/iu);
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
  // Sections nest, so only top-level provisions define the advertised range;
  // paragraphs, pages and footnotes are flat.
  const spine =
    kind === "section"
      ? blocks.filter((block) => !block.label.includes("("))
      : blocks;
  if (!spine.length) {
    return { ...empty, count: blocks.length };
  }
  const numbered = spine.map((block) => ({
    label: block.label,
    value: kind === "section" ? sectionRoot(block.label) : labelNumber(block.label),
  }));
  const present = numbered.filter(
    (entry): entry is { label: string; value: number } => entry.value !== null,
  );
  if (present.length !== numbered.length) {
    // A non-numeric spine (e.g. "A.01.001") has an order but no gap notion.
    return {
      kind,
      count: blocks.length,
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
    count: blocks.length,
    first: lowest.label,
    last: highest.label,
    missing,
    missingTruncated,
  };
}

export function createSourceDoc(args: {
  provider: SourceDocProvider;
  id: string;
  url?: string | null;
  docType?: "cases" | "laws" | null;
  text: string;
  blocks: SourceDocBlock[];
}): SourceDoc {
  const blocks = args.blocks;
  const index = new Map<string, number>();
  const duplicates = new Set<string>();
  blocks.forEach((block, position) => {
    for (const label of [block.label, ...(block.aliases ?? [])]) {
      const key = label.toLowerCase();
      if (index.has(key)) duplicates.add(key);
      else index.set(key, position);
    }
  });
  for (const key of duplicates) index.delete(key);
  const ranges = Object.fromEntries(
    LOCATOR_KINDS.map((kind) => [
      kind,
      locatorRange(
        kind,
        blocks.filter((block) => block.kind === kind),
      ),
    ]),
  ) as Record<SourceDocLocatorKind, SourceDocLocatorRange>;

  const doc: SourceDoc = {
    provider: args.provider,
    id: args.id,
    url: args.url ?? null,
    revision: sourceDocRevision(args.text),
    docType: args.docType ?? null,
    status: blocks.length ? "usable" : "unavailable",
    text: args.text,
    tokens: [],
    blocks,
    index,
    ranges,
  };
  // Tokenizing a 2.3 MB statute costs far more than compiling it, and most
  // documents are never quote-checked. Tokenize once, on first use, and never
  // again; the property is non-enumerable so a stray JSON.stringify of a
  // SourceDoc cannot force (or serialize) it.
  let tokens: WordSpan[] | null = null;
  Object.defineProperty(doc, "tokens", {
    enumerable: false,
    configurable: false,
    get() {
      return (tokens ??= tokenizeSourceText(doc.text));
    },
  });
  return doc;
}

export function normalizeSourceDocLocator(
  kind: SourceDocLocatorKind,
  locator: string,
) {
  if (kind === "footnote") {
    const match = locator
      .trim()
      .match(/^(?:fn|footnotes?|notes?)?[\s#.]*(\d{1,5})$/iu);
    return match ? `fn${Number(match[1])}` : "";
  }
  const standard = normalizeA2AJLocator(kind, locator);
  if (standard || kind !== "section") return standard;
  // Federal regulations number sections alphanumerically ("A.01.001"), which
  // the A2AJ locator grammar never admitted.
  const compact = locator
    .trim()
    .replace(/^(?:ss?\.?|sections?)\s*/iu, "")
    .replace(/\s+/gu, "");
  return /^[A-Za-z]{1,3}(?:[.-][0-9A-Za-z]{1,8}){1,3}(?:\([^)]+\))*$/u.test(
    compact,
  )
    ? `sec${compact}`
    : "";
}

export function sourceDocBlockText(doc: SourceDoc, block: SourceDocBlock) {
  return doc.text.slice(block.start, block.end).trim();
}

function materialize(doc: SourceDoc, block: SourceDocBlock) {
  return { ...block, text: sourceDocBlockText(doc, block) };
}

export function sourceDocBlocksOfKind(
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
  const requestedLabel = normalizeSourceDocLocator(kind, locator);
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
      ? available.findIndex((block) => block.label.toLowerCase() === label)
      : -1;
  };
  const first = find(from);
  const last = find(to);
  if (first < 0 || last < 0) return [];
  const [lowest, highest] = first <= last ? [first, last] : [last, first];
  return available.slice(lowest, highest + 1);
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
 * Quote spans over the prebuilt token array. Matching semantics are the same
 * as legalSourceLinks.phraseSpans - lowercased word equality over WORD_RE
 * tokens - so a quote that verifies here verifies there.
 */
export function sourceDocQuoteSpans(
  doc: SourceDoc,
  quote: string,
  block?: SourceDocBlock,
): SourceDocQuoteSpan[] {
  const words = quoteWords(quote);
  if (!words.length) return [];
  const tokens = doc.tokens;
  const from = block ? tokenIndexAtOrAfter(tokens, block.start) : 0;
  const limit = block ? tokenIndexAtOrAfter(tokens, block.end) : tokens.length;
  const spans: SourceDocQuoteSpan[] = [];
  for (let index = from; index <= limit - words.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (tokens[index + offset].word !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    spans.push({
      start: tokens[index].start,
      end: tokens[index + words.length - 1].end,
      firstWord: index,
      lastWord: index + words.length - 1,
    });
  }
  return spans;
}

export function sourceDocContainsQuote(
  doc: SourceDoc,
  quote: string,
  block?: SourceDocBlock,
) {
  return sourceDocQuoteSpans(doc, quote, block).length > 0;
}
