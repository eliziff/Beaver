import { normalizeWhitespace } from "../../backend/src/lib/text.ts";

type NativeDocument = { text: string };
type NativeWordSpan = { text: string; start: number; end: number };
type NativeQuoteSpan = { start: number; end: number; firstWord: number; lastWord: number };
const documentTextNative = (document: NativeDocument) => document.text;
const tokenizeTextNative = (text: string): NativeWordSpan[] => [
  ...text.matchAll(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu),
].map((match) => ({ text: match[0].toLocaleLowerCase(), start: match.index, end: match.index + match[0].length }));
const quoteWordsNative = (text: string) => tokenizeTextNative(text).map((word) => word.text);
/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here is a query over a SourceDoc. Callers that already hold the
 * compiled artifact pass it; callers that only hold a rendition pass the text
 * and the artifact is compiled once for the call, never once per quote.
 */

export type QuoteSource = string | NativeDocument;

export type LegalSourceEvidence = {
  url: string;
  /** `undefined` permits experiment discovery; production supplies string or null. */
  verifiedPdf?: { url: string; pdfOnly: boolean } | null;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: QuoteSource;
  /** The corpus the fragment must be unique in; the block when absent. */
  documentText?: QuoteSource;
  pageScoped?: boolean;
};

type QuoteView = { text: string };
const asDoc = (source: QuoteSource): QuoteView => typeof source === "string"
  ? { text: source }
  : { text: documentTextNative(source) };
const tokenCache = new Map<string, NativeWordSpan[]>();
const tokenPositionCache = new Map<string, Map<string, number[]>>();
const textFragmentTokenKey = (value: string) => `\0${value
  .normalize("NFKD")
  .replace(/\p{M}/gu, "")
  .toLocaleLowerCase()}`;
const tokens = (source: QuoteView): NativeWordSpan[] => {
  const cached = tokenCache.get(source.text);
  if (cached) {
    tokenCache.delete(source.text);
    tokenCache.set(source.text, cached);
    return cached;
  }
  const built = tokenizeTextNative(source.text);
  tokenCache.set(source.text, built);
  if (tokenCache.size > 4) {
    const oldest = tokenCache.keys().next().value!;
    tokenCache.delete(oldest);
    tokenPositionCache.delete(oldest);
  }
  return built;
};
const tokenPositions = (source: QuoteView) => {
  let positions = tokenPositionCache.get(source.text);
  if (positions) return positions;
  positions = new Map();
  tokens(source).forEach(({ text }, index) => {
    for (const key of [text, textFragmentTokenKey(text)]) {
      const entries = positions!.get(key);
      if (entries) entries.push(index);
      else positions!.set(key, [index]);
    }
  });
  tokenPositionCache.set(source.text, positions);
  return positions;
};
const phraseSpans = (source: QuoteView, words: string[], options: {
  start?: number; end?: number; sameLine?: boolean; limit?: number;
} = {}): NativeQuoteSpan[] => {
  const sourceWords = tokens(source);
  const start = options.start ?? 0;
  const end = options.end ?? source.text.length;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  const wanted = words.map((word) => word.toLocaleLowerCase());
  if (!wanted.length) return [];
  const found: NativeQuoteSpan[] = [];
  const positions = tokenPositions(source);
  for (const first of positions.get(wanted[0]) ?? []) {
    if (first + wanted.length > sourceWords.length || found.length >= limit) break;
    const last = first + wanted.length - 1;
    if (sourceWords[first].start < start || sourceWords[last].end > end) continue;
    if (!wanted.every((word, offset) => sourceWords[first + offset].text === word)) continue;
    if (options.sameLine && /[\r\n]/u.test(source.text.slice(sourceWords[first].start, sourceWords[last].end))) continue;
    found.push({ start: sourceWords[first].start, end: sourceWords[last].end, firstWord: first, lastWord: last });
  }
  return found;
};

const CONTEXT_WINDOWS = [4, 2, 8, 12, 16, 24, 32];
// A whole-quote target longer than one tight prose run is more fragile than a
// start,end range: every extra word is another chance for publisher
// punctuation or inline markup to break the match, and a range's short
// boundaries each sit inside one block even when the passage spans several.
// The trigger scales with the evidence span itself (length, or a line break
// inside it), not with a provider name.
const RANGE_PREFERRED_WORDS = 20;
const RANGE_PREFERRED_CHARS = 150;
// Longest boundaries first: short heads risk matching publisher-side
// duplicates that never appear in the flattened source (wrong-start sweeps).
const RANGE_BOUNDARY_WORDS = [12, 8, 6];

/**
 * Reliability over completeness — drop tiny hard bits at edges, paint the
 * core, never paint extraneous content. Structural labels that publishers
 * render outside the prose run - margin paragraph numbers, provision
 * headings, list markers - plus the bracketed pinpoint ranges A2AJ appends
 * ("[99-135]") never appear on the page. A target that begins or ends with
 * one cannot match the rendered DOM, so edges are stripped before anything
 * else. Interior hard bits (nested subsections, Act names, s. refs) remain
 * interior and are handled via graded variants, not trimming.
 */
const LEADING_SPAN_LABELS = [
  /^\[\s*\d{1,4}\s*\]\s*/u,
  /^\d{1,4}\]\s*/u,
  // Provision furniture at the edge is not prose. Requiring at least one
  // parenthetical preserves a year or other substantive leading number.
  /^\d{1,4}(?:\.\d{1,4})*\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+(?:[.;:]\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)*)?/u,
  // List markers: "(a)", "(ii)", "(2)"
  /^\(\s*[A-Za-z0-9]{1,5}\s*\)\s*/u,
];
const TRAILING_PIN_ARTIFACT =
  /\s*[.,;:]?\[\s*\d{1,4}(?:\s*[-–—,;]\s*\d{1,4})+\s*\]\s*$/u;
// A requested Manitoba definition can stop inside an appended French
// translation. Flattened A2AJ text cannot distinguish translations that stay
// adjacent live from otherwise identical translations reordered into another
// column; both outcomes occur in this corpus. The preceding English prose is
// therefore the maximal core that a no-oracle builder can guarantee.
const TRAILING_BILINGUAL_TRANSLATION = /\s*\(\s*(?:«|Â«)\s*[^)]*$/u;
const LEADING_ATTACHED_ORDER_FURNITURE = /^\[\s*\d{1,4}\s*\]AND\s+(?=CONSIDERING\b)/u;
const LEADING_NUMBERED_ITEM_FURNITURE = /^\d{1,4}\s+[–—]\s+(?=\p{Lu})/u;
const LEADING_AMENDMENT_LABEL_FURNITURE =
  /^by\s+[\p{L}]{1,8}\d{1,6}\/\d{1,4};\s*\([a-z]{1,3}\)\s*(?=[“"][^”"]+[”"]\s+means\b)/iu;
const LEADING_BILINGUAL_TAIL_FURNITURE =
  /^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3}\s*(?:(?:»|Â»)\s*)?\)\s*(?=[“"][^”"\r\n]{1,80}[”"]\s+means\b)/iu;
const TRAILING_COMPLETE_BILINGUAL_LABEL =
  /\s*;\s*(?:«|Â«)\s*[^»\r\n]{1,80}(?:»|Â»)\s*$/u;
const TRAILING_FRENCH_ACT_LABEL = /\s*;\s*\(\s*(?:loi|règlement)\s*$/iu;
// Decisia/Norma deployments (SCC, FCA, FC, TCC, ONCA, NSCA, tribunals, and
// decisia.lexum.com tenants). Their default document URL is an iframe shell
// with no text and no anchors; `?iframe=true` serves the document inline
// with `name="parN"` paragraph anchors. Live-verified across 14 hosts on
// 2026-07-27. Detection is by host+path because A2AJ supplies markdown, not
// the source HTML — per-document anchor presence cannot be known here, and
// some older documents (e.g. pre-2013 SCC items) carry no anchors at all.
const DECISIA_HOSTS =
  /^(decisions?\.[\w-]+\.(?:gc\.)?ca|decisia\.lexum\.com|coadecisions\.ontariocourts\.ca)$/iu;

function isDecisiaDocument(url: URL) {
  return (
    DECISIA_HOSTS.test(url.hostname) &&
    /\/item\/\d+\/index\.do$/iu.test(url.pathname)
  );
}

function extendTerminalPunctuation(source: string, end: number, quote: string) {
  const comma = quote.trim().endsWith(",") ? "," : "";
  const match = source
    .slice(end)
    .match(new RegExp(`^[${comma}.!?;:…'’”»\\)\\]]+`, "u"));
  return end + (match?.[0].length ?? 0);
}

function extendLeadingPunctuation(source: string, start: number, quote: string) {
  const leading = quote.trimStart().match(/^[\[(\{"'\u2018\u201c\u00ab]*/u)?.[0] ?? "";
  return leading && source.slice(Math.max(0, start - leading.length), start) === leading
    ? start - leading.length : start;
}

function leadingLabelLength(text: string): number {
  for (const label of LEADING_SPAN_LABELS) {
    const match = text.match(label)?.[0];
    // Never consume the entire remainder; a target keeps at least one word.
    if (match && match.length < text.trimEnd().length) return match.length;
  }
  return 0;
}

function stripLeadingLabels(text: string): string {
  let stripped = text;
  for (;;) {
    const length = leadingLabelLength(stripped);
    if (!length) return stripped.trim();
    stripped = stripped.slice(length);
  }
}

function wordAtOrAfter(block: QuoteView, offset: number, from: number): number {
  const words = tokens(block);
  for (let index = from; index < words.length; index += 1) {
    if (words[index].end > offset) return index;
  }
  return -1;
}

function wordAtOrBefore(
  block: QuoteView,
  offset: number,
  from: number,
): number {
  const words = tokens(block);
  for (let index = Math.min(from, words.length - 1); index >= 0; index -= 1) {
    if (words[index].start < offset) return index;
  }
  return -1;
}

/**
 * Move the span edges off structural labels and A2AJ artifacts so directive
 * targets are pure prose runs. The evidence quote keeps its original wording;
 * only what the fragment must match is trimmed.
 */
function adjustSpanEdges(
  block: QuoteView,
  original: NativeQuoteSpan,
  trimLeading = true,
): NativeQuoteSpan {
  let start = original.start;
  let end = original.end;
  if (trimLeading) {
    const edge = [
      LEADING_ATTACHED_ORDER_FURNITURE,
      LEADING_NUMBERED_ITEM_FURNITURE,
      LEADING_AMENDMENT_LABEL_FURNITURE,
      LEADING_BILINGUAL_TAIL_FURNITURE,
    ].map((pattern) => block.text.slice(start, end).match(pattern))
      .find((matched) => matched);
    if (edge) start += edge[0].length;
    for (;;) {
      const length = leadingLabelLength(block.text.slice(start, end));
      if (!length) break;
      start += length;
    }
  }
  for (;;) {
    const artifact = block.text.slice(start, end).match(TRAILING_PIN_ARTIFACT);
    if (!artifact) break;
    end -= artifact[0].length;
    if (end <= start) return original;
  }
  const bilingual = block.text.slice(start, end).match(TRAILING_BILINGUAL_TRANSLATION);
  if (bilingual?.index !== undefined && bilingual.index > 0) {
    end = start + bilingual.index;
  }
  for (const pattern of [
    TRAILING_COMPLETE_BILINGUAL_LABEL,
    TRAILING_FRENCH_ACT_LABEL,
  ]) {
    const edge = block.text.slice(start, end).match(pattern);
    if (edge?.index !== undefined && edge.index > 0) {
      end = start + edge.index;
    }
  }
  if (start === original.start && end === original.end) return original;
  const firstWord = wordAtOrAfter(block, start, original.firstWord);
  const lastWord = wordAtOrBefore(block, end, original.lastWord);
  if (firstWord < 0 || lastWord < 0 || lastWord < firstWord) return original;
  return { start, end, firstWord, lastWord };
}

/**
 * A short prose run of up to `size` tokens hugging one edge of the span.
 * Runs stop before a line break - each boundary phrase has to match inside a
 * single publisher block - and lose any structural label of their own, so an
 * end run like "5.5 Summary" anchors on "Summary".
 */
function edgePhrase(
  block: QuoteView,
  span: NativeQuoteSpan,
  edge: "start" | "end",
  size: number,
): { text: string; first: number; last: number } | null {
  const words = tokens(block);
  const forward = edge === "start";
  const indexes: number[] = [];
  const step = forward ? 1 : -1;
  for (
    let index = forward ? span.firstWord : span.lastWord;
    indexes.length < size &&
    (forward ? index <= span.lastWord : index >= span.firstWord);
    index += step
  ) {
    const token = words[index];
    if (!token) break;
    if (indexes.length) {
      const previous = words[indexes.at(-1)!];
      const between = block.text.slice(
        Math.min(previous.end, token.start),
        Math.max(previous.end, token.start),
      );
      // Each boundary phrase has to match inside one publisher block.
      if (between.includes("\n")) break;
    }
    indexes.push(index);
  }
  if (!indexes.length) return null;
  let first = Math.min(...indexes);
  let last = Math.max(...indexes);
  // A2AJ tokenization splits tight legal clusters such as `249.1` and
  // `(2)(a)`. Chromium will not start a term midway through the cluster.
  while (first > span.firstWord &&
    !/[\s\r\n]/u.test(block.text.slice(words[first - 1].end, words[first].start))) {
    first -= 1;
  }
  while (last < span.lastWord &&
    !/[\s\r\n]/u.test(block.text.slice(words[last].end, words[last + 1].start))) {
    last += 1;
  }
  const raw = normalizeWhitespace(
    block.text.slice(words[first].start, words[last].end),
  );
  // An end run like "5.5 Summary" anchors on its prose: "Summary".
  const text = stripLeadingLabels(raw);
  return quoteWordsNative(text).length
    ? { text, first, last }
    : null;
}

/**
 * How many ways the browser could interpret a `start,end` range in this
 * document: it highlights from the first occurrence of `start` to the next
 * occurrence of `end`. Two reachable pairings mean two different possible
 * highlights, so anything above one rejects the candidate.
 */
function rangeDirectiveMatchCount(
  document: QuoteView,
  start: string,
  end: string,
  prefix = "",
  suffix = "",
): number {
  const starts = phraseSpans(
    document,
    [...quoteWordsNative(prefix), ...quoteWordsNative(start)],
    { limit: 64 },
  );
  if (!starts.length) return 0;
  const ends = phraseSpans(document, [...quoteWordsNative(end), ...quoteWordsNative(suffix)], {
    limit: 64,
  });
  if (!ends.length) return 0;
  let pairings = 0;
  for (const startSpan of starts) {
    for (const endSpan of ends) {
      if (endSpan.start < startSpan.end) continue;
      pairings += 1;
      if (pairings === 2) return 2;
    }
  }
  return pairings;
}

/**
 * A2AJ merges numbered lead-ins and list/quote continuations into one flat
 * block, but publishers keep them in separate paragraphs ("...that:</p><p>The
 * Chambers..."). A range boundary phrase that crosses such a seam cannot
 * match, because separator runs do not collapse across element boundaries.
 * This splits boundary phrases at likely seams: the start edge ends at the
 * punctuation, the end edge starts at the continuation word, so each range
 * endpoint lives inside one publisher paragraph. The seam guess is gated by
 * the same uniqueness verification as every other candidate.
 * Reliability over completeness: seamSplit drops the seam-adjacent pinpoint
 * at edges and paints the core on each side (pinpoint-drop).
 */
const SEAM = /[:;]\s+\S|\.\s+[A-Z]/u;

function seamSplit(
  phrase: { text: string; first: number; last: number },
  edge: "start" | "end",
): { text: string; first: number; last: number } | null {
  const match = phrase.text.match(SEAM);
  if (!match || match.index === undefined) return null;
  const lastWhitespace = match[0].search(/\s+\S+$/u);
  if (lastWhitespace < 0) return null;
  const restStart = match.index + lastWhitespace + 1;
  // Head keeps the seam punctuation; tail starts at the continuation word.
  const head = phrase.text.slice(0, match.index + 1).trim();
  const tail = phrase.text.slice(restStart).trim();
  const headCount = quoteWordsNative(head).length;
  const tailCount = quoteWordsNative(tail).length;
  if (edge === "start") {
    // The start boundary must sit inside one paragraph: prefer the head (which
    // ends at the seam punctuation). When the head is too short to be unique,
    // the continuation after the seam is the only usable start.
    if (headCount) return { text: head, first: phrase.first, last: phrase.first + headCount - 1 };
    if (tailCount) return { text: tail, first: phrase.last - tailCount + 1, last: phrase.last };
    return null;
  }
  // The end boundary must sit inside one paragraph: prefer the tail (which
  // starts at the continuation word). When the tail is too short, the pre-seam
  // head is the only usable end (paints up to the seam punctuation).
  if (tailCount) return { text: tail, first: phrase.last - tailCount + 1, last: phrase.last };
  if (headCount) return { text: head, first: phrase.first, last: phrase.first + headCount - 1 };
  return null;
}

function boundaryVariants(text: string): string[] {
  return [
    ...citationClusterVariants(text),
    punctuationDetachVariant(text),
    curlyQuoteVariant(text),
    curlySpacedVariant(text),
    legislationNestedVariant(text),
    markdownVariant(text),
    actAbbreviationVariant(text),
  ].filter((variant): variant is string => variant !== null);
}

function buildRangeDirective(
  block: QuoteView,
  span: NativeQuoteSpan,
  document: QuoteView,
) {
  // Emit EVERY boundary size plus its seam-split as sibling directives. Each
  // family is retained until browser-marker replay proves it redundant.
  const combos = new Set<string>();
  for (const size of RANGE_BOUNDARY_WORDS) {
    const head = edgePhrase(block, span, "start", size);
    const tail = edgePhrase(block, span, "end", size);
    if (!head || !tail) continue;
    const seamHead = seamSplit(head, "start");
    const seamTail = seamSplit(tail, "end");
    const pairs = [
      { head, tail },
      ...(seamHead || seamTail ? [{ head: seamHead ?? head, tail: seamTail ?? tail }] : []),
    ];
    for (const { head: candidateHead, tail: candidateTail } of pairs) {
      if (candidateHead.last >= candidateTail.first) continue;
      if (rangeDirectiveMatchCount(document, candidateHead.text, candidateTail.text) !== 1) continue;
      combos.add(textRangeDirective(candidateHead.text, candidateTail.text));
      const headVariants = boundaryVariants(candidateHead.text);
      const tailVariants = boundaryVariants(candidateTail.text);
      for (
        let grade = 0;
        grade < Math.max(headVariants.length, tailVariants.length) && combos.size < 12;
        grade += 1
      ) {
        combos.add(textRangeDirective(
          headVariants[grade] ?? candidateHead.text,
          tailVariants[grade] ?? candidateTail.text,
        ));
      }
      if (combos.size >= 12) break;
    }
    if (combos.size >= 12) break;
  }
  return combos.size ? { directives: [...combos], start: span.start } : null;
}

/**
 * Where in `doc` a quote sits. When it sits in more than one place, the tie is
 * broken by comparing the rendered text - first as written, then with editorial
 * alterations resolved ("[T]he" is the document's "The"), then case-folded.
 * Without the second comparison an altered quote that appears twice loses its
 * link entirely, which is exactly what a court quotation looks like.
 */
function chooseSourceSpan(
  doc: QuoteView,
  quote: string,
): NativeQuoteSpan | null {
  const extend = (span: NativeQuoteSpan) => ({
    ...span,
    start: extendLeadingPunctuation(doc.text, span.start, quote),
    end: extendTerminalPunctuation(doc.text, span.end, quote),
  });
  let spans = phraseSpans(doc, quoteWordsNative(quote)).map(extend);
  if (!spans.length) {
    // Editorial bracket insertions ("[t]he") tokenize as split words in the
    // document ("t", "he") but merge under quote-word normalisation; retry
    // with bracket characters treated as separators.
    spans = phraseSpans(
      doc,
      quoteWordsNative(quote.replace(/[\[\]"]/gu, " ")),
    ).map(extend);
  }
  if (spans.length === 1) return spans[0];
  if (!spans.length) return null;

  const rendered = spans.map((span) =>
    normalizeWhitespace(doc.text.slice(span.start, span.end)),
  );
  const wanted = [
    normalizeWhitespace(quote.trim().replace(/^["'“”]+|["'“”]+$/gu, "")),
    normalizeWhitespace(
      quote.trim()
        .replace(/^["'“”]+|["'“”]+$/gu, "")
        .replace(/\[([A-Za-z])\]([A-Za-z])/gu, "$1$2")
        .replace(/\[([^\]]+)\]/gu, "$1")
        .replace(/\.{3}|…/gu, " "),
    ),
    // Publisher typography: straight quotes in the flattened source render
    // as curly in the published document.
    normalizeWhitespace(
      quote
        .replace(/(\S)"(\S)/gu, "$1\u201C$2")
        .replace(/"(\S)/gu, "\u201C$1")
        .replace(/(\S)"/gu, "$1\u201D"),
    ),
  ];
  for (const candidate of wanted) {
    for (const fold of [
      (value: string) => value,
      (value: string) => value.toLowerCase(),
    ]) {
      const matched = spans.filter(
        (_span, index) => fold(rendered[index]) === fold(candidate),
      );
      if (matched.length === 1) return matched[0];
    }
  }
  // Text-fragment matching itself resolves otherwise indistinguishable
  // duplicate passages in document order. Retain that deterministic contract
  // when block wording and typography provide no stronger discriminator.
  return spans[0] ?? null;
}

function encodeTextFragment(text: string) {
  return encodeURIComponent(text).replace(/[!'()*-]/gu, (character) => {
    return `%${character.codePointAt(0)!.toString(16).toUpperCase()}`;
  });
}

function textDirective(target: string, prefix = "", suffix = "") {
  const encodedTarget = encodeTextFragment(normalizeWhitespace(target));
  const encodedPrefix = prefix
    ? `${encodeTextFragment(normalizeWhitespace(prefix))}-,`
    : "";
  const encodedSuffix = suffix
    ? `,-${encodeTextFragment(normalizeWhitespace(suffix))}`
    : "";
  return `text=${encodedPrefix}${encodedTarget}${encodedSuffix}`;
}

function textRangeDirective(
  start: string,
  end: string,
  prefix = "",
  suffix = "",
) {
  const context = prefix ? `${encodeTextFragment(normalizeWhitespace(prefix))}-,` : "";
  const after = suffix ? `,-${encodeTextFragment(normalizeWhitespace(suffix))}` : "";
  return `text=${context}${encodeTextFragment(normalizeWhitespace(start))},${encodeTextFragment(normalizeWhitespace(end))}${after}`;
}

/**
 * Graded Decisia projection variants for a directive phrase, most
 * conservative first. Chromium matches fragment whitespace positionally -
 * NBSP folds onto one space, but separator runs never collapse across element
 * boundaries - so a directive that continues past such a run must carry the
 * padded spelling. Two independent mechanisms are proven on SCC decisions:
 *
 * - orphan-guarded pinpoints read "s.<NBSP>17" and "para.<NBSP>68" everywhere,
 *   linked or not: the site refuses to line-break between an abbreviation and
 *   its number. This grade is safe to apply unconditionally;
 * - reflex2 links end with an icon glyph that leaves an NBSP inside the
 *   anchor, so prose crossing the link end reads "Divorce Act<NBSP> is" and
 *   "Section 17<NBSP> of". That pad only exists where a link actually sits,
 *   so it is emitted as a second, more aggressive grade on top of the first.
 *
 * Spacing inside a link's own label stays ASCII ("Divorce Act"). A browser
 * ignores any directive that matches nothing, so emitting every grade is safe
 * everywhere; once a provider's projection is proven we can collapse to its
 * single form.
 */
function citationClusterVariants(target: string): string[] {
  const guarded = target.replace(
    /\b([A-Za-z]{1,5}\.)(\s)(\d)/gu,
    "$1\u00A0$3",
  );
  const variants: string[] = [];
  if (guarded !== target) variants.push(guarded);
  const projected = guarded
    // The icon glyph leaves an NBSP *before* the prose's own space.
    .replace(/\b([A-Za-z]{1,5}\.\u00A0\d+[A-Za-z0-9.]*)\s/gu, "$1\u00A0 ")
    .replace(
      /\b(Sections?\s+\d+(?:\.\d+)*(?:\(\w+\)\w*){0,2})(?=\s+[a-z])/gu,
      "$1\u00A0",
    )
    .replace(
      /\b((?:[A-Z][\w'’()&.-]*\s+){0,2}?(?:Acts?|Codes?|Regulations?|Rules))(?=\s+[a-z])/gu,
      "$1\u00A0",
    );
  if (projected !== guarded) variants.push(projected);
  return [...new Set(variants)];
}

/**
 * Publisher templates detach punctuation from its neighbours: CITT renders
 * "60. (1)" and "8 ." where the flattened source has "60.(1)" and "8.".
 * Detached spellings cannot be derived from source text, so they ship as
 * sibling variants. (No space-before-colon rule: BC courts' apparent
 * "Freedoms : s. 1" turned out to be a colon followed by a paragraph break,
 * not detached punctuation.) Reliability over completeness: interior hard
 * punctuation stays variant-covered; tiny detached bits at edges would be
 * trimmed by adjustSpanEdges, not variant-expanded.
 */
function punctuationDetachVariant(target: string): string | null {
  const detached = target
    // "8." at a token start -> "8 ." (space before a trailing period). Runs
    // first so its output cannot be re-matched by the period-paren rule.
    .replace(/((?:^|[\s(])(?:\d+(?:\.\d+)*)?)(\d)(\.)(?=\s)/gu, (_m, head, digit, dot) => `${head}${digit} ${dot}`)
    // "60.(1)" -> "60. (1)" (space after a period between digit and paren)
    .replace(/(\d)(\.)(\()/gu, "$1$2 $3");
  return detached === target ? null : detached;
}

/**
 * Legal prose set by publishers uses typographic quotes; flattened corpus
 * text usually carries ASCII ones. Emit the curly spelling beside the
 * straight one. An apostrophe between word characters (possessives,
 * contractions: "applicant's", "don't") is a RIGHT single quotation mark
 * (U+2019); U+2018 is the LEFT mark used for opening quotes.
 */
function curlyQuoteVariant(target: string): string | null {
  if (!/["']/u.test(target)) return null;
  const curly = target
    .replace(/(\S)"(\S)/gu, "$1\u201C$2")
    .replace(/(\S)'(\S)/gu, "$1\u2019$2")
    .replace(/"(\S)/gu, "\u201C$1")
    .replace(/(\S)"/gu, "$1\u201D")
    .replace(/'(\S)/gu, "\u2018$1")
    .replace(/(\S)'/gu, "$1\u2019");
  return curly === target ? null : curly;
}

function curlySpacedVariant(target: string): string | null {
  if (!/"/u.test(target)) return null;
  // BCCourts renders straight "X" as “ X" with a thin/NBSP after the opener
  // (seen on “ PBS legislation” vs "PBS). Emit that spaced form as a sibling.
  const spaced = target.replace(/"(\S)/gu, "\u201C\u00A0$1");
  return spaced === target ? null : spaced;
}

function legislationNestedVariant(target: string): string | null {
  // Handles tight nested subsections: "1(1)(a)(ii)" <-> "1 (1) (a) (ii)" and "1(1)(a)(ii)" <-> "1(1) (a) (ii)" etc.
  // Also handles s. 242(2.1) vs s.242(2.1) spacing.
  // Insert space before each '(' that follows a digit/letter without space
  let v = target.replace(/(\d)(\()/gu, "$1 $2");
  // Detached period before paren: "60.(1)" -> "60. (1)" (publisher templates)
  v = v.replace(/(\d)(\.)(\()/gu, "$1$2 $3");
  // Insert space after each ')' that is followed by '(' or digit without space
  v = v.replace(/\)(\()/gu, ") $1");
  v = v.replace(/\)(\d)/gu, ") $1");
  // Normalize "s.242" -> "s. 242"
  v = v.replace(/\bs\.\s*(\d)/gu, "s. $1");
  if (v !== target) return v;
  return null;
}

/**
 * A2AJ text is markdown; publishers render `*emphasis*`/`**bold**`/`_italic_`
 * with no markers ("*acknowledgement*" -> "acknowledgement"). Emit the
 * marker-stripped spelling as a sibling so the browser uses whichever the
 * rendered page carries.
 */
function markdownVariant(target: string): string | null {
  if (!/[*_`]/u.test(target)) return null;
  const stripped = target.replace(/[*_`]/gu, "");
  return stripped === target ? null : stripped;
}

function actAbbreviationVariant(target: string): string | null {
  // BCCourts: A2AJ has "COE" for "COEA" (Court Order Enforcement Act) and similar
  // truncations. Try the expanded form as a sibling; the browser will use whichever
  // the page carries and ignore the other.
  if (!/\bCOE\b/u.test(target)) return null;
  const expanded = target.replace(/\bCOE\b/gu, "COEA");
  return expanded === target ? null : expanded;
}

/**
 * When an exact target itself crosses a publisher paragraph seam ("...that:
 * The Chambers..."), no single-run spelling can match. Emit a verified
 * split-range sibling: start ends at the seam punctuation, end begins at the
 * continuation word; Chromium highlights the whole span between them.
 */
function seamRangeSibling(target: string, document: QuoteView): string[] {
  const match = target.match(SEAM);
  if (!match || match.index === undefined) return [];
  const lastWhitespace = match[0].search(/\s+\S+$/u);
  if (lastWhitespace < 0) return [];
  const headText = target.slice(0, match.index + 1).trim();
  let tailText = target.slice(match.index + lastWhitespace + 1).trim();
  // Continuation paragraphs often open with a pinpoint ("s. 1", "para. 33")
  // that the publisher pads with a wide NBSP run; the seam tail must start
  // after it to stay inside one publisher paragraph.
  tailText = tailText.replace(
    /^(?:(?:s|ss|para|paras|art|arts|p|pp)\.?\s+\d[\w.)-]*|Sections?\s+\d[\w.)-]*|Subsections?\s+\d[\w.)-]*)\s+/iu,
    "",
  ).trim();
  const headWords = quoteWordsNative(headText).length;
  const tailWords = quoteWordsNative(tailText).length;
  if (headWords < 2) return [];
  if (tailWords < 2) {
    // The continuation after the seam is too short to anchor a range (e.g.
    // "...here: The"): the seam-adjacent word can't carry an end boundary, so
    // drop it and emit the pre-seam head as a single-run instead — it sits
    // entirely inside one paragraph and paints the core. Reliability over
    // completeness (pinpoint-drop).
    if (directiveMatchCount(document, headText) === 1) {
      return exactDirectives(headText);
    }
    return [];
  }
  if (rangeDirectiveMatchCount(document, headText, tailText) !== 1) return [];
  // The seam punctuation itself can be detached ("Freedoms : s. 1"), so the
  // split endpoints get the same projection variants as everything else.
  const heads = [...new Set([headText, punctuationDetachVariant(headText)].filter(Boolean))];
  const tails = [...new Set([tailText, punctuationDetachVariant(tailText)].filter(Boolean))];
  const combos = new Set<string>();
  combos.add(textRangeDirective(headText, tailText));
  if (heads[1]) combos.add(textRangeDirective(heads[1], tailText));
  if (tails[1]) combos.add(textRangeDirective(headText, tails[1]));
  if (heads[1] && tails[1]) combos.add(textRangeDirective(heads[1], tails[1]));
  return [...combos].slice(0, 4);
}

function exactDirectives(
  target: string,
  prefix = "",
  suffix = "",
  seamSiblings: string[] = [],
  extraSpellings: string[] = [],
): string[] {
  const variants = [
    ...citationClusterVariants(target),
    punctuationDetachVariant(target),
    curlyQuoteVariant(target),
    legislationNestedVariant(target),
    markdownVariant(target),
  ].filter((variant): variant is string => variant !== null);
  const directives = [textDirective(target, prefix, suffix)];
  for (const variant of [...new Set([...variants, ...extraSpellings])].slice(0, 5)) {
    directives.push(textDirective(variant, prefix, suffix));
  }
  directives.push(...seamSiblings);
  return directives;
}

function spellingsOf(text: string): string[] {
  return boundaryVariants(text);
}

/**
 * A target that is unique in the flattened source can still cross a publisher
 * paragraph seam (the source has no line breaks). Ship progressively shorter
 * prefixes (down to 3 words) as siblings so Chromium uses the longest one that
 * sits inside a single rendered paragraph — reliability over completeness.
 */
function shorterUniquePrefixes(target: string, document: QuoteView): string[] {
  const words = (target ?? "").split(/\s+/u).filter(Boolean);
  const out: string[] = [];
  for (let n = words.length - 1; n >= 3; n -= 1) {
    const prefix = words.slice(0, n).join(" ");
    if (directiveMatchCount(document, prefix) === 1) out.push(prefix);
    if (out.length >= 4) break;
  }
  return out;
}

export function sourceUrl(rawUrl: string, anchor?: string): string | null {
  const local =
    rawUrl.startsWith("/") &&
    !rawUrl.startsWith("//") &&
    !rawUrl.includes("\\");
  let url: URL;
  try {
    url = local ? new URL(rawUrl, "http://mike.local") : new URL(rawUrl);
  } catch {
    return null;
  }
  if (/(^|\.)getcaselaw\.com$/iu.test(url.hostname)) return null;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (local && url.origin !== "http://mike.local")
  ) {
    return null;
  }

  const existingAnchor = url.hash.slice(1).split(":~:", 1)[0];
  const bclaws = /(^|\.)bclaws\.gov\.bc\.ca$/iu.test(url.hostname);
  if (bclaws && url.pathname.endsWith("/xml")) {
    url.pathname = url.pathname.slice(0, -4);
  }
  let justiceLawsHtml = false;
  if (/^laws-lois\.justice\.gc\.ca$/iu.test(url.hostname)) {
    const justiceXml = url.pathname.match(/^\/(eng|fra)\/XML\/([^/]+)\.xml$/iu);
    if (justiceXml) {
      const language = justiceXml[1].toLocaleLowerCase();
      const identifier = justiceXml[2];
      let decodedIdentifier = identifier;
      try {
        decodedIdentifier = decodeURIComponent(identifier);
      } catch {
        // Keep the literal path segment; URL parsing already validated it.
      }
      const regulation = /^(?:SOR|SI|C\.?R\.?C\.?|DORS|TR)\b/iu.test(
        decodedIdentifier,
      );
      const collection = language === "fra"
        ? regulation ? "reglements" : "lois"
        : regulation ? "regulations" : "acts";
      url.pathname = `/${language}/${collection}/${identifier}/FullText.html`;
      justiceLawsHtml = true;
    }
  }
  if (/^(?:www\.)?ontario\.ca$/iu.test(url.hostname)) {
    const elaws = url.pathname.match(
      /^\/laws\/api\/v2\/legislation\/en\/doc-search\/(statute|regulation)\/([^/]+)$/iu,
    );
    if (elaws) {
      url.hostname = "www.ontario.ca";
      url.pathname = `/laws/${elaws[1].toLocaleLowerCase()}/${elaws[2]}`;
    }
  }
  const canliiPdf =
    /(^|\.)canlii\.org$/iu.test(url.hostname) &&
    url.pathname.toLowerCase().endsWith(".pdf");
  const requestedAnchor = anchor ?? existingAnchor;
  const convertedCanliiPdf = canliiPdf && !requestedAnchor.startsWith("page=");
  if (convertedCanliiPdf) {
    url.pathname = url.pathname.replace(/\.pdf$/iu, ".html");
  }
  if (isDecisiaDocument(url)) {
    // INTENTIONAL, LOAD-BEARING FEATURE - text fragments cannot work on
    // Decisia without both parameters. This is not a flaw, lint, or
    // cosmetic preference; do not remove or "normalize" either one.
    //
    // iframe=true: the default Decisia document URL is an iframe shell with
    // no document text at all, so neither paragraph anchors nor
    // #:~:text= directives can resolve against it. iframe=true serves the
    // document inline.
    //
    // site_preference=mobile: in the desktop rendering, a successful
    // text-fragment jump locks the viewport onto the matched text and the
    // page cannot be scrolled afterwards. Only the mobile rendering scrolls
    // normally after a fragment jump. Both behaviors were verified in live
    // Chrome; server-side probes and static HTML inspection cannot see
    // them, so an apparent absence of justification here is not evidence
    // the parameters are removable.
    //
    // Side effect, deliberately accepted: Decisia remembers site_preference
    // in a cookie. That only affects visitors who arrive via Beaver's deep
    // links. A regular user browsing the publisher normally clicks plain
    // desktop URLs and sees the identical desktop site - their experience
    // is completely unchanged.
    url.searchParams.delete("iframe");
    url.searchParams.delete("site_preference");
    url.searchParams.set("iframe", "true");
    url.searchParams.set("site_preference", "mobile");
  }

  let resolvedAnchor =
    anchor !== undefined ? anchor : convertedCanliiPdf ? "" : existingAnchor;
  if (/\/document\.do$/iu.test(url.pathname) || url.pathname.toLowerCase().endsWith(".pdf")) {
    resolvedAnchor = /^page=\d+$/iu.test(resolvedAnchor) ? resolvedAnchor : "";
  }
  if (bclaws) {
    resolvedAnchor = resolvedAnchor.replace(
      /^sec(\d+(?:\.\d+)*)(?:\(.*\))?$/iu,
      "section$1",
    );
  }
  if (justiceLawsHtml) {
    resolvedAnchor = /^h-\d+$/iu.test(existingAnchor) ? existingAnchor : "";
  }
  url.hash = resolvedAnchor ? `#${resolvedAnchor}` : "";
  return local ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/**
 * How many places in the document a `prefix-,target,-suffix` directive would
 * select. A browser matches a text fragment within one block, so the whole
 * run must sit on one line; counting stops at two because "not unique" is all
 * the caller needs.
 */
function directiveMatchCount(
  document: QuoteView,
  target: string,
  prefix = "",
  suffix = "",
) {
  return phraseSpans(
    document,
    [
      ...quoteWordsNative(prefix),
      ...quoteWordsNative(target),
      ...quoteWordsNative(suffix),
    ],
    { limit: 2 },
  ).length;
}

const textFragmentCollator = new Intl.Collator("en", {
  usage: "search",
  sensitivity: "base",
});

function lowerBound(values: number[], wanted: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < wanted) low = middle + 1;
    else high = middle;
  }
  return low;
}

function browserTermAt(
  document: QuoteView,
  wanted: string[],
  firstWord: number,
  allowAcrossLines = false,
): NativeQuoteSpan | null {
  if (!wanted.length) return null;
  const source = tokens(document);
  if (firstWord < 0 || firstWord + wanted.length > source.length) return null;
  if (!wanted.every((expected, offset) =>
    textFragmentCollator.compare(source[firstWord + offset].text, expected) === 0)) {
    return null;
  }
  const lastWord = firstWord + wanted.length - 1;
  if (!allowAcrossLines &&
      /\r|\n/u.test(document.text.slice(source[firstWord].start, source[lastWord].end))) {
    return null;
  }
  return {
    start: source[firstWord].start,
    end: source[lastWord].end,
    firstWord,
    lastWord,
  };
}

/** Replay Chromium's first, word-bounded, single-term search. */
function firstBrowserTermSpan(
  document: QuoteView,
  wanted: string[],
  fromWord = 0,
  allowAcrossLines = false,
): NativeQuoteSpan | null {
  if (!wanted.length) return null;
  const candidates = tokenPositions(document).get(textFragmentTokenKey(wanted[0])) ?? [];
  for (let index = lowerBound(candidates, fromWord); index < candidates.length; index += 1) {
    const firstWord = candidates[index];
    const match = browserTermAt(document, wanted, firstWord, allowAcrossLines);
    if (match) return match;
  }
  return null;
}

type BrowserSpelledTerm = {
  text: string;
  words: string[];
  leadingPunctuation: boolean;
  trailingPunctuation: boolean;
};

function browserSpelledTerm(value: string): BrowserSpelledTerm | null {
  const text = fragmentSpelling(value);
  const spans = tokenizeTextNative(text);
  if (!spans.length) return null;
  return {
    text,
    words: spans.map(({ text: word }) => word),
    leadingPunctuation: spans[0].start > 0,
    trailingPunctuation: spans.at(-1)!.end < text.length,
  };
}

function browserSpelledTermAt(
  document: QuoteView,
  term: BrowserSpelledTerm,
  firstWord: number,
  allowAcrossLines = false,
): NativeQuoteSpan | null {
  const matched = browserTermAt(document, term.words, firstWord, allowAcrossLines);
  if (!matched) return null;
  const source = tokens(document);
  const wordStart = source[firstWord].start;
  const wordEnd = source[matched.lastWord].end;
  const firstStart = term.leadingPunctuation
    ? source[firstWord - 1]?.end ?? 0
    : wordStart;
  const lastEnd = term.trailingPunctuation
    ? source[matched.lastWord + 1]?.start ?? document.text.length
    : wordEnd;
  // A punctuation-bearing target starts/ends somewhere inside the adjacent
  // source gap, not at the neighbouring token. Try only those small boundary
  // gaps; consuming the entire gap would falsely attach prior punctuation.
  for (let start = wordStart; start >= firstStart; start -= 1) {
    if (!term.leadingPunctuation && start !== wordStart) break;
    for (let end = wordEnd; end <= lastEnd; end += 1) {
      if (!term.trailingPunctuation && end !== wordEnd) break;
      const rendered = fragmentSpelling(document.text.slice(start, end));
      if (textFragmentCollator.compare(rendered, term.text) === 0) return matched;
    }
  }
  return null;
}

function firstBrowserSpelledTermSpan(
  document: QuoteView,
  term: BrowserSpelledTerm,
  fromWord = 0,
  allowAcrossLines = false,
) {
  for (;;) {
    const candidate = firstBrowserTermSpan(
      document, term.words, fromWord, allowAcrossLines,
    );
    if (!candidate) return null;
    const matched = browserSpelledTermAt(
      document, term, candidate.firstWord, allowAcrossLines,
    );
    if (matched) return matched;
    fromWord = candidate.firstWord + 1;
  }
}

type ExactDirectiveReplay = {
  first: NativeQuoteSpan | null;
  count: 0 | 1 | 2;
};

/** Indexed, punctuation-faithful replay of one exact text directive. */
function replayExactDirective(
  document: QuoteView,
  target: string,
  prefix = "",
  suffix = "",
  allowAcrossLines = false,
): ExactDirectiveReplay {
  const prefixTerm = prefix ? browserSpelledTerm(prefix) : null;
  const targetTerm = browserSpelledTerm(target);
  const suffixTerm = suffix ? browserSpelledTerm(suffix) : null;
  if (!targetTerm || prefix && !prefixTerm || suffix && !suffixTerm) {
    return { first: null, count: 0 };
  }
  const firstTerm = prefixTerm ?? targetTerm;
  const candidates = tokenPositions(document).get(
    textFragmentTokenKey(firstTerm.words[0]),
  ) ?? [];
  let first: NativeQuoteSpan | null = null;
  let count: 0 | 1 | 2 = 0;
  for (const firstWord of candidates) {
    const prefixMatch = prefixTerm
      ? browserSpelledTermAt(document, prefixTerm, firstWord, allowAcrossLines)
      : null;
    if (prefixTerm && !prefixMatch) continue;
    const targetFirst = prefixMatch ? prefixMatch.lastWord + 1 : firstWord;
    const targetMatch = browserSpelledTermAt(
      document, targetTerm, targetFirst, allowAcrossLines,
    );
    if (!targetMatch) continue;
    const suffixMatch = suffixTerm
      ? browserSpelledTermAt(document, suffixTerm, targetMatch.lastWord + 1, allowAcrossLines)
      : targetMatch;
    if (!suffixMatch) continue;
    first ??= targetMatch;
    count = count === 0 ? 1 : 2;
    if (count === 2) break;
  }
  return { first, count };
}

function browserDirectiveMatchCount(
  document: QuoteView,
  target: string,
  prefix = "",
  suffix = "",
) {
  return replayExactDirective(document, target, prefix, suffix).count;
}

/**
 * Return the first range Chrome can resolve, not every theoretical start/end
 * pairing. For each start in document order Chrome searches for the first
 * compatible end after it; only a start with no following end is skipped.
 */
function firstRangeDirectiveSpan(
  document: QuoteView,
  start: string,
  end: string,
  prefix = "",
  suffix = "",
  allowAcrossLines = false,
): NativeQuoteSpan | null {
  const prefixTerm = prefix ? browserSpelledTerm(prefix) : null;
  const startTerm = browserSpelledTerm(start);
  const endTerm = browserSpelledTerm(end);
  const suffixTerm = suffix ? browserSpelledTerm(suffix) : null;
  if (!startTerm || !endTerm || prefix && !prefixTerm || suffix && !suffixTerm) return null;
  const words = tokens(document);
  for (let startFrom = 0; startFrom < words.length;) {
    const contextMatch = firstBrowserSpelledTermSpan(
      document,
      prefixTerm ?? startTerm,
      startFrom,
      allowAcrossLines,
    );
    if (!contextMatch) return null;
    const first = prefixTerm
      ? browserSpelledTermAt(
          document, startTerm, contextMatch.lastWord + 1, allowAcrossLines,
        )
      : contextMatch;
    startFrom = contextMatch.firstWord + 1;
    if (!first) continue;

    // Chromium resolves the first compatible end after this start. If none
    // exists, it advances to the next start rather than treating the two
    // endpoint terms as independently unique queries.
    for (let endFrom = first.lastWord + 1; endFrom < words.length;) {
      const last = firstBrowserSpelledTermSpan(
        document, endTerm, endFrom, allowAcrossLines,
      );
      if (!last) break;
      endFrom = last.firstWord + 1;
      const suffixMatch = suffixTerm
        ? browserSpelledTermAt(
            document, suffixTerm, last.lastWord + 1, allowAcrossLines,
          )
        : last;
      if (!suffixMatch) continue;
      return {
        start: words[first.firstWord].start,
        end: words[last.lastWord].end,
        firstWord: first.firstWord,
        lastWord: last.lastWord,
      };
    }
  }
  return null;
}

function contextFor(
  block: QuoteView,
  span: NativeQuoteSpan,
  window: number,
): { prefix: string; suffix: string } {
  const words = tokens(block);
  const firstPrefixWord = Math.max(0, span.firstWord - window);
  const lastSuffixWord = Math.min(words.length - 1, span.lastWord + window);
  let prefix =
    span.firstWord > firstPrefixWord
      ? normalizeWhitespace(
          block.text.slice(words[firstPrefixWord].start, span.start),
        )
      : "";
  const suffix =
    lastSuffixWord > span.lastWord
      ? normalizeWhitespace(
          block.text.slice(span.end, words[lastSuffixWord].end),
        )
      : "";
  prefix = prefix.replace(
    /^(?:\[\d+\]|\([A-Za-z0-9ivxlcdm]+\)|\d+(?:[.)]|\]))\s*/iu,
    "",
  );
  return { prefix, suffix };
}

function buildDirective(
  block: QuoteView,
  quote: string,
  document: QuoteView,
  pageScoped: boolean,
) {
  if (process.env.BUILDER_DEBUG === "1") {
    console.error("[builder-debug] entry", JSON.stringify({ quote: quote.slice(0, 70) }));
  }
  const selected = chooseSourceSpan(block, quote);
  if (!selected) {
    if (process.env.BUILDER_DEBUG === "1") console.error("[builder-debug] chooseSourceSpan null");
    return null;
  }
  const span = adjustSpanEdges(block, selected);
  const target = normalizeWhitespace(block.text.slice(span.start, span.end));
  const targetWords = quoteWordsNative(target);
  if (!targetWords.length) return null;

  let effectiveTarget = target;
  let targetCount = directiveMatchCount(document, target);
  // Flattened corpus text carries ASCII quotes while publishers set curly
  // ones, and editorial bracket insertions ("[t]he") tokenize differently in
  // the document index; when the ASCII target does not resolve, these
  // respellings can, and they inherit the same uniqueness proof.
  if (targetCount !== 1) {
    for (const respelling of [
      curlyQuoteVariant(target),
      target.replace(/[\[\]"]/gu, " "),
      curlyQuoteVariant(target.replace(/[\[\]"]/gu, " ")),
    ]) {
      if (respelling && respelling !== target && directiveMatchCount(document, respelling) === 1) {
        effectiveTarget = respelling;
        targetCount = 1;
        break;
      }
    }
  }
  // A passage that crosses a source line break cannot sit in one publisher
  // block either, so an exact single-run target is impossible: a range is the
  // only honest fragment. Long passages get first claim on a range too — each
  // short boundary survives markup that a whole-sentence run would not.
  const rangeRequired = target.includes("\n");
  const rangePreferred =
    targetWords.length >= RANGE_PREFERRED_WORDS ||
    target.length >= RANGE_PREFERRED_CHARS;
  if (rangeRequired || rangePreferred) {
    const range = buildRangeDirective(block, span, document);
    if (range) return range;
    if (rangeRequired && targetCount !== 1) return null;
  }

  const needsContext =
    targetWords.length <= 3 ||
    targetCount !== 1 ||
    (pageScoped && targetWords.length <= 8);
  if (process.env.BUILDER_DEBUG === "1") {
    console.error("[builder-debug]", JSON.stringify({
      quote: quote.slice(0, 70),
      targetWords: targetWords.length,
      targetCount,
      rangeRequired,
      rangePreferred,
      needsContext,
    }));
  }
  const extraSpellings = [
    ...(effectiveTarget === target ? [] : [target, ...spellingsOf(target)]),
    ...shorterUniquePrefixes(effectiveTarget, document),
  ];
  if (!needsContext && targetCount === 1) {
    return {
      directives: exactDirectives(effectiveTarget, "", "", seamRangeSibling(effectiveTarget, document), extraSpellings),
      start: span.start,
    };
  }

  for (const window of CONTEXT_WINDOWS) {
    const { prefix, suffix } = contextFor(block, span, window);
    const options: Array<[string, string]> = [
      [prefix, ""],
      ["", suffix],
      [prefix, suffix],
    ];
    for (const [candidatePrefix, candidateSuffix] of options) {
      if (!candidatePrefix && !candidateSuffix) continue;
      if (
        directiveMatchCount(
          document,
          effectiveTarget,
          candidatePrefix,
          candidateSuffix,
        ) === 1
      ) {
        return {
          directives: exactDirectives(
            effectiveTarget,
            candidatePrefix,
            candidateSuffix,
            seamRangeSibling(effectiveTarget, document),
            extraSpellings,
          ),
          start: span.start,
        };
      }
    }
  }

  return targetCount === 1
    ? {
        directives: exactDirectives(effectiveTarget, "", "", seamRangeSibling(effectiveTarget, document), extraSpellings),
        start: span.start,
      }
    : null;
}

function appendDirectives(url: string, directives: string[]) {
  if (!directives.length) return url;
  return url.includes("#")
    ? `${url}:~:${directives.join("&")}`
    : `${url}#:~:${directives.join("&")}`;
}

function verificationDoc(
  passage: { documentText?: QuoteSource },
  block: QuoteView,
) {
  const document = passage.documentText;
  if (document === undefined) return block;
  return typeof document === "string"
    ? document.trim()
      ? asDoc(document)
      : block
    : asDoc(document);
}

function isPdfSourceUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLocaleLowerCase();
    const href = url.href.toLocaleLowerCase();
    return path.endsWith(".pdf") || path.endsWith("/document.do") ||
      href.includes("laws.yukon.ca/cms/images/legislation/") ||
      href.includes("justice.gov.nt.ca/en/files/legislation/") ||
      href.includes("princeedwardisland.ca/sites/default/files/legislation/") ||
      /publications\.saskatchewan\.ca\/api\/v1\/products\/[^/]+\/formats\//u.test(href);
  } catch {
    const base = rawUrl.toLocaleLowerCase().split(/[?#]/u, 1)[0];
    return base.endsWith(".pdf") || base.endsWith("/document.do");
  }
}

export function buildLegalSourcePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  return buildMaximalPinpointPlan(evidence, quotes).target;
}

export type MaximalPinpointPlan = {
  target: string | null;
  paintQuotes: string[];
  /** Canonical full-document word intervals selected by the directives. */
  sourceWordIntervals: Array<{
    quoteIndex: number;
    start: number;
    end: number;
    firstWord: number;
    lastWord: number;
  }>;
  sourceSafeComplete: boolean;
  paintedWords: number;
};

/** Compatibility view of the exact source-derived intervals selected by the planner. */
export function maximalCoreQuotes(
  evidence: { blockText: QuoteSource; documentText?: QuoteSource; url?: string },
  quotes: string[],
) {
  return buildMaximalPinpointPlan({
    ...evidence,
    url: evidence.url ?? "https://source.invalid/",
  }, quotes).paintQuotes;
}

/**
 * One maximal-core range per quote. Each endpoint is independently unique in
 * the full flattened document (using adjacent context when necessary), so a
 * browser cannot pair an earlier repeated start with the intended end.
 */
export function buildCoreRangePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
  minimumBoundaryWords = 1,
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  const block = asDoc(evidence.blockText);
  if (!baseUrl || !block.text) return baseUrl;
  const document = verificationDoc(evidence, block);
  const built: Array<{ directive: string; start: number }> = [];
  const seen = new Set<string>();
  for (const quote of quotes) {
    const key = quoteWordsNative(quote).join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const selected = chooseSourceSpan(block, quote);
    if (!selected) return baseUrl;
    const span = adjustSpanEdges(block, selected);
    const desired = locateDocumentQuote(block, document, span);
    if (!desired) return baseUrl;
    const documentWords = tokens(document);
    const target = fragmentSpelling(document.text.slice(
      documentWords[desired.firstWord].start,
      documentWords[desired.lastWord].end,
    ));
    const width = desired.lastWord - desired.firstWord + 1;
    if (width < 2) {
      if (browserDirectiveMatchCount(document, target) !== 1) return baseUrl;
      built.push({ directive: textDirective(target), start: span.start });
      continue;
    }
    const contextForBoundary = (
      boundary: { text: string; first: number; last: number },
      edge: "start" | "end",
    ) => {
      const first = boundary.first;
      const last = boundary.last;
      const available = edge === "start" ? first : documentWords.length - last - 1;
      for (let size = 0; size <= available; size += 1) {
        const prefixRaw = edge === "start" && size
          ? document.text.slice(documentWords[first - size].start, documentWords[first].start)
          : "";
        const suffixRaw = edge === "end" && size
          ? document.text.slice(documentWords[last].end, documentWords[last + size].end)
          : "";
        // Native proof: a context term that crosses an A2AJ source line can
        // cross the publisher's uninterrupted-block boundary and never match.
        if (/[\r\n]/u.test(prefixRaw + suffixRaw)) break;
        const prefix = fragmentSpelling(prefixRaw);
        const suffix = fragmentSpelling(suffixRaw);
        if (browserDirectiveMatchCount(document, boundary.text, prefix, suffix) === 1) {
          return { prefix, suffix };
        }
      }
      return null;
    };

    const smallest = Math.min(Math.max(1, minimumBoundaryWords), Math.floor(width / 2));
    const heads = [];
    const tails = [];
    const headKeys = new Set<string>();
    const tailKeys = new Set<string>();
    const addBoundary = (
      raw: { text: string; first: number; last: number },
      edge: "start" | "end",
      output: Array<{ text: string; first: number; last: number; prefix: string; suffix: string; seamSafe: boolean }>,
      keys: Set<string>,
    ) => {
      const split = seamSplit(raw, edge);
      const options = split
        ? (edge === "start" ? split.first === desired.firstWord : split.last === desired.lastWord)
          ? [{ ...split, seamSafe: true }]
          : []
        : [{ ...raw, seamSafe: true }];
      for (const option of options) {
        option.text = fragmentSpelling(option.text);
        const key = `${option.first}:${option.last}:${option.text}`;
        if (keys.has(key)) continue;
        keys.add(key);
        const context = contextForBoundary(option, edge);
        if (context) output.push({ ...option, ...context });
      }
    };
    for (let size = smallest; size < width; size += 1) {
      const head = edgePhrase(document, desired, "start", size);
      if (head) addBoundary(head, "start", heads, headKeys);
      const tail = edgePhrase(document, desired, "end", size);
      if (tail) addBoundary(tail, "end", tails, tailKeys);
    }
    const candidates = heads.flatMap((head) => tails
      .filter((tail) => head.last < tail.first)
      .map((tail) => ({
        directive: textRangeDirective(head.text, tail.text, head.prefix, tail.suffix),
        external: Boolean(head.prefix || tail.suffix),
        seamSafe: head.seamSafe && tail.seamSafe,
        head,
        tail,
      })));
    if (!candidates.length) {
      // A short, unique one-block core can be safer and shorter as one exact
      // term than as two overlapping endpoints (Manitoba definitions).
      if (!/[\r\n]/u.test(document.text.slice(desired.start, desired.end)) &&
          !SEAM.test(target) &&
          browserDirectiveMatchCount(document, target) === 1) {
        built.push({ directive: textDirective(target), start: span.start });
        continue;
      }
      return baseUrl;
    }
    candidates.sort((left, right) => Number(!left.seamSafe) - Number(!right.seamSafe) ||
      Number(left.external) - Number(right.external) ||
      left.directive.length - right.directive.length);
    const selectedCandidate = candidates[0];
    // Native isolation proved that combining otherwise harmless spelling
    // siblings can make Chromium paint an extraneous range. Emit the one
    // source-derived canonical directive whose pairing was proved above.
    built.push({ directive: selectedCandidate.directive, start: span.start });
  }
  return appendDirectives(
    baseUrl,
    built.sort((left, right) => left.start - right.start).map(({ directive }) => directive),
  );
}

function locateDocumentQuote(block: QuoteView, document: QuoteView, selected: NativeQuoteSpan) {
  const blockWords = tokens(block);
  const documentWords = tokens(document);
  for (const window of [0, 2, 4, 8, 16, 32, 64, blockWords.length]) {
    const first = Math.max(0, selected.firstWord - window);
    const last = Math.min(blockWords.length - 1, selected.lastWord + window);
    const matches = phraseSpans(document,
      blockWords.slice(first, last + 1).map(({ text }) => text), { limit: 2 });
    if (matches.length !== 1) continue;
    const offset = selected.firstWord - first;
    const firstWord = matches[0].firstWord + offset;
    const lastWord = firstWord + selected.lastWord - selected.firstWord;
    const leading = block.text.slice(selected.start, blockWords[selected.firstWord].start);
    const trailing = block.text.slice(blockWords[selected.lastWord].end, selected.end);
    let start = documentWords[firstWord].start;
    let end = documentWords[lastWord].end;
    if (leading && document.text.slice(Math.max(0, start - leading.length), start) === leading) {
      start -= leading.length;
    }
    if (trailing && document.text.slice(end, end + trailing.length) === trailing) {
      end += trailing.length;
    }
    return {
      start,
      end,
      firstWord,
      lastWord,
    };
  }
  return null;
}

type MaximalCorePiece = NativeQuoteSpan & {
  contextFirstWord: number;
  contextLastWord: number;
};

function opensMarkdown(gap: string) {
  // A2AJ emphasis marks terms/headings that publishers commonly render once
  // as a heading and again in the definition body. Only the opening marker is
  // a hard boundary; the closing marker remains adjacent to following prose.
  const marker = /(?:\*{1,3}|_{1,3}|`+)\s*$/u.exec(gap);
  return Boolean(marker && (marker.index > 0 || !/\s$/u.test(marker[0])));
}

function isTocPageNumber(document: QuoteView, word: number) {
  const source = tokens(document);
  if (word <= 0 || word + 1 >= source.length || !/^\d{1,4}$/u.test(source[word].text) ||
      !/^[ivxlcdm]{1,7}$/iu.test(source[word + 1].text)) return false;
  const between = document.text.slice(source[word].end, source[word + 1].start);
  if (!/^[ \t]*\r?\n[ \t]*$/u.test(between)) return false;
  const afterRoman = document.text.slice(
    source[word + 1].end,
    source[word + 2]?.start ?? Math.min(document.text.length, source[word + 1].end + 4),
  );
  return /^\s*\.\s*/u.test(afterRoman);
}

function endsLegalReference(document: QuoteView, word: number) {
  const source = tokens(document);
  if (word < 1 || word >= source.length) return false;
  if (word + 1 < source.length) {
    const continuationGap = document.text.slice(source[word].end, source[word + 1].start);
    // A2AJ tokenizes `5.1.1` and `919.1(2)(a)` into several words. A dot or
    // opening parenthesis continues the same locator; it cannot be treated as
    // the publisher-annotation seam that follows the completed locator.
    if (/^\s*(?:\.|\)\s*\()?\s*\(?\s*$/u.test(continuationGap) &&
        /^(?:\d+|[a-z]{1,5})$/iu.test(source[word + 1].text) &&
        /[.(]/u.test(continuationGap)) return false;
  }
  const throughGap = document.text.slice(
    Math.max(0, source[word].end - 96),
    source[word + 1]?.start ?? document.text.length,
  );
  return /(?:\b(?:sections?|subsections?|paragraphs?|subparagraphs?|rules?)|\bs{1,2}\.)\s+\d+(?:\.\d+)*(?:\s*\(\s*[\p{L}\p{N}.-]{1,12}\s*\))*[.,;:]?\s*$/iu.test(throughGap);
}

function hardSeamAfter(document: QuoteView, word: number, pdf: boolean) {
  const source = tokens(document);
  if (word < 0 || word + 1 >= source.length) return false;
  const gap = document.text.slice(source[word].end, source[word + 1].start);
  if (/[\r\n]/u.test(gap) || opensMarkdown(gap) || endsLegalReference(document, word)) {
    return true;
  }
  if (!pdf) return false;
  const nextRaw = document.text.slice(source[word + 1].start, source[word + 1].end);
  return /[.!?:;]\s*$/u.test(gap) && /^\p{Lu}/u.test(nextRaw);
}

function pdfOpeningQuoteAfter(document: QuoteView, word: number, requestedFirstWord: number) {
  if (word - requestedFirstWord >= 3) return false;
  const words = tokens(document);
  if (word < requestedFirstWord || word + 1 >= words.length) return false;
  return /["'\u2018\u201c\u00ab]/u.test(
    document.text.slice(words[word].end, words[word + 1].start),
  );
}

/** The sole comma-sensitive exception: source list prose whose publisher may
 * inject `(a)`, `(b)`, `(c)` labels between the Oxford-series role items. */
function oxfordRoleSeriesSeams(document: QuoteView, desired: NativeQuoteSpan) {
  const words = tokens(document);
  const seams = new Set<number>();
  const commaAfter = (word: number) => word < desired.lastWord &&
    /,/u.test(document.text.slice(words[word].end, words[word + 1].start));
  for (let cue = desired.firstWord; cue + 6 <= desired.lastWord; cue += 1) {
    if (words[cue].text !== "as" || words[cue + 1].text !== "the") continue;
    let firstComma = cue + 2;
    while (firstComma < desired.lastWord && !commaAfter(firstComma)) firstComma += 1;
    if (firstComma >= desired.lastWord || words[firstComma + 1].text !== "the") continue;
    let secondComma = firstComma + 2;
    while (secondComma < desired.lastWord && !commaAfter(secondComma)) secondComma += 1;
    const conjunction = secondComma + 1;
    const article = conjunction + 1;
    if (secondComma >= desired.lastWord || words[conjunction]?.text !== "or" ||
        !/^(?:a|an|the)$/u.test(words[article]?.text ?? "") || article >= desired.lastWord) {
      continue;
    }
    if (/[\r\n]/u.test(document.text.slice(words[cue].start, words[article].end))) continue;
    // The final publisher list label is inserted after `or`, so keep `or`
    // with the preceding role and start the final substantive role after it.
    seams.add(cue);
    seams.add(firstComma);
    seams.add(conjunction);
    cue = article;
  }
  return seams;
}

function lineStartFurnitureLastWord(
  document: QuoteView,
  pieceFirstWord: number,
  pieceLastWord: number,
) {
  const words = tokens(document);
  const tokenStart = words[pieceFirstWord].start;
  const lineStart = Math.max(
    document.text.lastIndexOf("\n", tokenStart - 1),
    document.text.lastIndexOf("\r", tokenStart - 1),
  ) + 1;
  const line = document.text.slice(lineStart, words[pieceLastWord].end);
  const indent = line.match(/^[ \t]*/u)?.[0].length ?? 0;
  const markerLength = leadingLabelLength(line.slice(indent));
  if (!markerLength) return null;
  const firstTargetWord = wordAtOrAfter(
    document,
    lineStart + indent + markerLength,
    pieceFirstWord,
  );
  return firstTargetWord > pieceFirstWord && firstTargetWord <= pieceLastWord
    ? firstTargetWord - 1
    : null;
}

function splitMaximalCore(
  document: QuoteView,
  desired: NativeQuoteSpan,
  pdf: boolean,
  clampLeadingContext: boolean,
  clampTrailingContext: boolean,
) {
  const words = tokens(document);
  const excluded = new Set<number>();
  const extraSeams = oxfordRoleSeriesSeams(document, desired);
  for (let word = desired.firstWord; word <= desired.lastWord; word += 1) {
    if (isTocPageNumber(document, word)) excluded.add(word);
    if (pdf && word < desired.lastWord &&
        pdfOpeningQuoteAfter(document, word, desired.firstWord)) extraSeams.add(word);
  }
  const isSeamAfter = (word: number) => extraSeams.has(word) ||
    hardSeamAfter(document, word, pdf);

  const pieces: MaximalCorePiece[] = [];
  let first = desired.firstWord;
  const add = (pieceFirst: number, pieceLast: number) => {
    if (pieceFirst > pieceLast) return;
    const sourcePieceFirst = pieceFirst;
    const sourceStart = pieceFirst === desired.firstWord
      ? desired.start
      : words[pieceFirst].start;
    const sourceEnd = pieceLast === desired.lastWord
      ? desired.end
      : words[pieceLast].end;
    const furnitureLast = lineStartFurnitureLastWord(document, pieceFirst, pieceLast);
    if (furnitureLast !== null) pieceFirst = furnitureLast + 1;
    let contextFirst = sourcePieceFirst;
    while (contextFirst > 0 && !excluded.has(contextFirst - 1) &&
           !isSeamAfter(contextFirst - 1)) contextFirst -= 1;
    let contextLast = pieceLast;
    while (contextLast + 1 < words.length && !excluded.has(contextLast + 1) &&
           !isSeamAfter(contextLast)) contextLast += 1;
    if (clampLeadingContext && sourcePieceFirst === desired.firstWord) {
      contextFirst = sourcePieceFirst;
    }
    if (clampTrailingContext && pieceLast === desired.lastWord) contextLast = pieceLast;
    pieces.push({
      start: pieceFirst === sourcePieceFirst ? sourceStart : words[pieceFirst].start,
      end: sourceEnd,
      firstWord: pieceFirst,
      lastWord: pieceLast,
      contextFirstWord: contextFirst,
      contextLastWord: contextLast,
    });
  };
  for (let word = desired.firstWord; word <= desired.lastWord; word += 1) {
    if (excluded.has(word)) {
      add(first, word - 1);
      first = word + 1;
      continue;
    }
    if (word < desired.lastWord && isSeamAfter(word)) {
      add(first, word);
      first = word + 1;
    }
  }
  add(first, desired.lastWord);
  return pieces;
}

export function requiresLineCore(evidence: LegalSourceEvidence, quotes: string[]) {
  const block = asDoc(evidence.blockText);
  const document = verificationDoc(evidence, block);
  return quotes.some((quote) => {
    const selected = chooseSourceSpan(block, quote);
    const desired = selected && locateDocumentQuote(block, document, selected);
    return desired ? /[\r\n]/u.test(document.text.slice(desired.start, desired.end)) : false;
  });
}

/**
 * Minimal no-oracle strategy: locate the requested block in the flattened
 * full document, then paint the longest short, unique prose run inside the
 * requested quote that does not cross a source line or punctuation seam.
 */
export function buildLineCorePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  const block = asDoc(evidence.blockText);
  if (!baseUrl || !block.text) return baseUrl;
  const document = verificationDoc(evidence, block);
  const documentWords = tokens(document);
  const built: Array<{ directive: string; start: number }> = [];
  const seen = new Set<string>();
  for (const quote of quotes) {
    const key = quoteWordsNative(quote).join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const selected = chooseSourceSpan(block, quote);
    if (!selected) return baseUrl;
    const desired = locateDocumentQuote(block, document, selected);
    if (!desired) {
      if (process.env.BUILDER_DEBUG === "1") console.error("[line-core] document occurrence ambiguous", quote);
      return baseUrl;
    }
    let target: { directive: string } | null = null;
    for (let seam = desired.firstWord; seam < desired.lastWord && !target; seam += 1) {
      const gap = document.text.slice(documentWords[seam].end, documentWords[seam + 1].start);
      if (!/[^\x00-\x7F]/u.test(gap)) continue;
      if (/[\u2018\u201C«]/u.test(gap)) continue;
      for (const size of [4, 3, 2, 1, 6]) {
        const headFirst = Math.max(desired.firstWord, seam - size + 1);
        const tailLast = Math.min(desired.lastWord, seam + size);
        const headRaw = document.text.slice(documentWords[headFirst].start, documentWords[seam].end);
        const tailRaw = document.text.slice(documentWords[seam + 1].start, documentWords[tailLast].end);
        if (/[\r\n]|[^\x20-\x7E]/u.test(headRaw + tailRaw)) continue;
        const head = normalizeWhitespace(headRaw);
        const tail = normalizeWhitespace(tailRaw);
        const starts = phraseSpans(document, quoteWordsNative(head), { limit: 64 });
        const ends = phraseSpans(document, quoteWordsNative(tail), { limit: 64 });
        const resolved = starts.flatMap((start) => {
          const end = ends.find((candidate) => candidate.start >= start.end);
          return end ? [{ start, end }] : [];
        })[0];
        if (resolved && resolved.start.firstWord >= desired.firstWord &&
            resolved.end.lastWord <= desired.lastWord) {
          const prefixFirst = Math.max(0, headFirst - 2);
          const prefix = normalizeWhitespace(document.text.slice(
            documentWords[prefixFirst].start, documentWords[headFirst].start));
          const rangeUnique = rangeDirectiveMatchCount(document, head, tail) === 1;
          target = {
            directive: rangeUnique
              ? textRangeDirective(head, tail)
              : directiveMatchCount(document, head, "", tail) === 1
                ? textDirective(head, "", tail)
                : textRangeDirective(head, tail, prefix),
          };
          break;
        }
      }
    }
    for (const { asciiOnly, allowContext } of [
      { asciiOnly: true, allowContext: false },
      { asciiOnly: false, allowContext: false },
      { asciiOnly: true, allowContext: true },
      { asciiOnly: false, allowContext: true },
    ]) {
      for (let length = Math.min(12, desired.lastWord - desired.firstWord + 1);
        length >= 2 && !target; length -= 1) {
      const starts = Array.from(
        { length: desired.lastWord - desired.firstWord - length + 2 },
        (_, index) => desired.firstWord + index,
      ).sort((left, right) =>
        Math.abs(left + (length - 1) / 2 - (desired.firstWord + desired.lastWord) / 2) -
        Math.abs(right + (length - 1) / 2 - (desired.firstWord + desired.lastWord) / 2));
        for (const first of starts) {
        const last = first + length - 1;
        const raw = document.text.slice(documentWords[first].start, documentWords[last].end);
        if (/[\r\n]/u.test(raw) || asciiOnly && /[^\x20-\x7E]/u.test(raw)) continue;
        const candidate = normalizeWhitespace(raw);
        const prefixFirst = Math.max(0, first - 4);
        const prefixRaw = document.text.slice(documentWords[prefixFirst].start, documentWords[first].start);
        const prefix = normalizeWhitespace(prefixRaw);
        const suffixLast = Math.min(documentWords.length - 1, last + 4);
        const suffixGap = document.text.slice(documentWords[last].end, documentWords[last + 1]?.start);
        const suffixRaw = document.text.slice(documentWords[last].end, documentWords[suffixLast].end);
        const suffix = suffixLast === last || /[^\s]/u.test(suffixGap)
          ? "" : normalizeWhitespace(suffixRaw);
        const bareUnique = directiveMatchCount(document, candidate) === 1;
        const contexts: Array<[string, string]> = bareUnique
          ? [["", ""]]
          : allowContext ? [[prefix, ""], ["", suffix], [prefix, suffix]] : [];
        const context = contexts.find(([before, after]) =>
          (before || after || directiveMatchCount(document, candidate) === 1) &&
          directiveMatchCount(document, candidate, before, after) === 1);
        if (context) {
          target = { directive: textDirective(candidate, context[0], context[1]) };
          break;
        }
        }
      }
      if (target) break;
    }
    if (!target) {
      if (process.env.BUILDER_DEBUG === "1") console.error("[line-core] no unique line core", quote,
        JSON.stringify(document.text.slice(desired.start, desired.end)));
      return baseUrl;
    }
    built.push({ directive: target.directive, start: selected.start });
  }
  return appendDirectives(baseUrl,
    built.sort((left, right) => left.start - right.start).map(({ directive }) => directive));
}

function fragmentSpelling(value: string) {
  return normalizeWhitespace(value)
    .replace(/[*_`]/gu, "")
    .replace(/([\u2018\u201c])\s+/gu, "$1")
    .replace(/([\[(])\s+/gu, "$1")
    .replace(/\s+([\u2019\u201d\]\),.;:!?])/gu, "$1");
}

function decisiaPdfFallbackUrl(rawUrl: string, anchor?: string) {
  try {
    const url = new URL(rawUrl);
    if (!isDecisiaDocument(url)) return null;
    const item = url.pathname.match(/^(.*)\/item\/(\d+)\/index\.do$/iu);
    if (!item) return null;
    url.pathname = `${item[1]}/${item[2]}/1/document.do`;
    url.search = "";
    url.hash = "";
    return sourceUrl(url.toString(), anchor);
  } catch {
    return null;
  }
}

/** Paint every source-safe requested word, splitting only at proven seams. */
export function buildMaximalPinpointPlan(
  evidence: LegalSourceEvidence,
  quotes: string[],
): MaximalPinpointPlan {
  const initialUrl = evidence.verifiedPdf?.pdfOnly
    ? evidence.verifiedPdf.url
    : evidence.url;
  const baseUrl = sourceUrl(initialUrl, evidence.anchor);
  const block = asDoc(evidence.blockText);
  if (!baseUrl || !block.text) return {
    target: baseUrl,
    paintQuotes: [],
    sourceWordIntervals: [],
    sourceSafeComplete: false,
    paintedWords: 0,
  };
  const document = verificationDoc(evidence, block);
  const words = tokens(document);
  type BuiltPiece = {
    directive: string;
    quoteIndex: number;
    start: number;
    end: number;
    firstWord: number;
    lastWord: number;
  };
  const phrase = (span: Pick<NativeQuoteSpan, "firstWord" | "lastWord">) =>
    fragmentSpelling(document.text.slice(
      words[span.firstWord].start,
      words[span.lastWord].end,
    ));
  const selects = (piece: NativeQuoteSpan, selected: NativeQuoteSpan | null) =>
    selected?.firstWord === piece.firstWord && selected.lastWord === piece.lastWord;

  const attempt = (targetUrl: string, pdf: boolean): MaximalPinpointPlan => {
    const publisherMayAnnotateLegalReference = (() => {
      try { return new URL(targetUrl).hostname === "www.bclaws.gov.bc.ca"; }
      catch { return false; }
    })();
    const built: BuiltPiece[] = [];
    const seen = new Set<string>();
    let complete = true;
    let paintedWords = 0;
    type LexicalTerm = {
      text: string;
      start: number;
      end: number;
      firstWord: number;
      lastWord: number;
      form: "word" | "atom" | "run";
    };
    const atomCache = new Map<number, LexicalTerm>();
    const atomicOptionsCache = new Map<number, LexicalTerm[]>();
    const directiveCache = new Map<string, string | null>();
    const encodedTermCache = new Map<string, string>();

    const encodedTerm = (value: string) => {
      const normalized = normalizeWhitespace(value);
      const cached = encodedTermCache.get(normalized);
      if (cached !== undefined) return cached;
      const encoded = encodeTextFragment(normalized);
      encodedTermCache.set(normalized, encoded);
      return encoded;
    };

    const cachedTextDirective = (
      target: string,
      prefix?: string,
      suffix?: string,
    ) => `text=${prefix ? `${encodedTerm(prefix)}-,` : ""}${encodedTerm(target)}${
      suffix ? `,-${encodedTerm(suffix)}` : ""}`;

    const hasLineBreak = (leftWord: number, rightWord: number) =>
      /[\r\n]/u.test(document.text.slice(words[leftWord].end, words[rightWord].start));

    const hasStructuralSeam = (leftWord: number, rightWord: number) => {
      const gap = document.text.slice(words[leftWord].end, words[rightWord].start);
      if (/[\r\n]/u.test(gap)) return true;
      // A closing French alias followed by the opening quote of the next
      // bilingual definition is a publisher-record boundary, not disposable
      // text. Split there so a requested first word of the next definition
      // remains mandatory and receives its own contextual exact directive.
      if (pdf && /(?:»|Â»)\s*[“"]/u.test(gap)) return true;
      if (!opensMarkdown(gap)) return false;
      // `(**Loi**)` is an inline bilingual alias inside the current
      // definition. A following `**next term**` starts a new record and may
      // render once as a <dt> and again in its <dd> body.
      return !/\(\s*(?:\*{1,3}|_{1,3}|`+)\s*$/u.test(gap);
    };

    const lineFirstWord = (word: number) => {
      let first = word;
      while (first > 0 && !hasLineBreak(first - 1, first)) first -= 1;
      return first;
    };

    const lineLastWord = (word: number) => {
      let last = word;
      while (last + 1 < words.length && !hasLineBreak(last, last + 1)) last += 1;
      return last;
    };

    const atomAt = (word: number): LexicalTerm => {
      const cached = atomCache.get(word);
      if (cached) return cached;
      let firstWord = word;
      let lastWord = word;
      while (firstWord > 0 && !/\s/u.test(document.text.slice(
        words[firstWord - 1].end, words[firstWord].start,
      ))) firstWord -= 1;
      while (lastWord + 1 < words.length && !/\s/u.test(document.text.slice(
        words[lastWord].end, words[lastWord + 1].start,
      ))) lastWord += 1;
      let start = words[firstWord].start;
      let end = words[lastWord].end;
      while (start > 0 && !/\s/u.test(document.text[start - 1])) start -= 1;
      while (end < document.text.length && !/\s/u.test(document.text[end])) end += 1;
      const built = {
        text: fragmentSpelling(document.text.slice(start, end)),
        start,
        end,
        firstWord,
        lastWord,
        form: "atom" as const,
      };
      for (let index = firstWord; index <= lastWord; index += 1) {
        atomCache.set(index, built);
      }
      return built;
    };

    const atomicOptionsAt = (word: number) => {
      const cached = atomicOptionsCache.get(word);
      if (cached) return cached;
      const bare: LexicalTerm = {
        text: fragmentSpelling(document.text.slice(words[word].start, words[word].end)),
        start: words[word].start,
        end: words[word].end,
        firstWord: word,
        lastWord: word,
        form: "word",
      };
      const atom = atomAt(word);
      const options = atom.text && (atom.text !== bare.text ||
          atom.start !== bare.start || atom.end !== bare.end ||
          atom.firstWord !== bare.firstWord || atom.lastWord !== bare.lastWord)
        ? [bare, atom]
        : [bare];
      atomicOptionsCache.set(word, options);
      return options;
    };

    const safeLexicalGap = (left: LexicalTerm, right: LexicalTerm) => {
      const gap = document.text.slice(left.end, right.start);
      // Raw text on one A2AJ line is evidence, not an inferred layout seam.
      // Preserve its punctuation verbatim and let exact first-match replay
      // prove whether the resulting browser term selects the intended span.
      // Only source newlines and actual Markdown block/emphasis openings are
      // hard term boundaries.
      return !/[\r\n]/u.test(gap) && !opensMarkdown(gap);
    };

    const exactTargetFor = (piece: MaximalCorePiece): LexicalTerm | null => {
      for (let word = piece.firstWord; word < piece.lastWord; word += 1) {
        if (hasStructuralSeam(word, word + 1)) return null;
      }
      const firstAtom = atomAt(piece.firstWord);
      const lastAtom = atomAt(piece.lastWord);
      // A tight multi-word source atom such as `(a)information` or `141(1)`
      // is indivisible. Ordinary one-word endpoints remain word-bounded, so
      // adjacent publisher punctuation cannot hide an earlier Chromium match.
      const start = firstAtom.firstWord === piece.firstWord &&
          firstAtom.lastWord > piece.firstWord && firstAtom.lastWord <= piece.lastWord
        ? firstAtom.start
        : words[piece.firstWord].start;
      const end = lastAtom.lastWord === piece.lastWord &&
          lastAtom.firstWord < piece.lastWord && lastAtom.firstWord >= piece.firstWord
        ? lastAtom.end
        : words[piece.lastWord].end;
      return {
        text: fragmentSpelling(document.text.slice(start, end)),
        start,
        end,
        firstWord: piece.firstWord,
        lastWord: piece.lastWord,
        form: piece.firstWord === piece.lastWord ? "word" : "run",
      };
    };

    const endpointTermsFromStart = (piece: MaximalCorePiece) => {
      const firstAtom = atomAt(piece.firstWord);
      if (firstAtom.firstWord !== piece.firstWord || firstAtom.lastWord > piece.lastWord) {
        return [];
      }
      const terms: LexicalTerm[] = atomicOptionsAt(piece.firstWord).length > 1
        ? [firstAtom]
        : [atomicOptionsAt(piece.firstWord)[0]];
      let last = firstAtom;
      while (last.lastWord < piece.lastWord) {
        const next = atomAt(last.lastWord + 1);
        if (next.lastWord > piece.lastWord || !safeLexicalGap(last, next)) break;
        last = next;
        terms.push({
          text: fragmentSpelling(document.text.slice(firstAtom.start, last.end)),
          start: firstAtom.start,
          end: last.end,
          firstWord: piece.firstWord,
          lastWord: last.lastWord,
          form: "run",
        });
      }
      return terms;
    };

    const endpointTermsFromEnd = (piece: MaximalCorePiece) => {
      const lastAtom = atomAt(piece.lastWord);
      if (lastAtom.lastWord !== piece.lastWord || lastAtom.firstWord < piece.firstWord) {
        return [];
      }
      const terms: LexicalTerm[] = atomicOptionsAt(piece.lastWord).length > 1
        ? [lastAtom]
        : [atomicOptionsAt(piece.lastWord)[0]];
      let first = lastAtom;
      while (first.firstWord > piece.firstWord) {
        const previous = atomAt(first.firstWord - 1);
        if (previous.firstWord < piece.firstWord || !safeLexicalGap(previous, first)) break;
        first = previous;
        terms.push({
          text: fragmentSpelling(document.text.slice(first.start, lastAtom.end)),
          start: first.start,
          end: lastAtom.end,
          firstWord: first.firstWord,
          lastWord: piece.lastWord,
          form: "run",
        });
      }
      return terms;
    };

    const trimLeadingFurniture = (span: NativeQuoteSpan) => {
      const markerLength = leadingLabelLength(document.text.slice(span.start, span.end));
      if (!markerLength) return span;
      const firstWord = wordAtOrAfter(document, span.start + markerLength, span.firstWord);
      if (firstWord < span.firstWord || firstWord > span.lastWord) return null;
      // Never strand substantive text inside the marker's no-whitespace atom:
      // `[5]AND` and `(a)information` must be kept/painted atomically.
      if (atomAt(firstWord).firstWord < firstWord) return span;
      return {
        ...span,
        start: words[firstWord].start,
        firstWord,
      };
    };

    const corePiece = (
      span: NativeQuoteSpan,
      clampLeadingContext: boolean,
      clampTrailingContext: boolean,
    ): MaximalCorePiece => {
      const sameLineFirst = lineFirstWord(span.firstWord);
      const sameLineLast = lineLastWord(span.lastWord);
      // Prefix/start and end/suffix are independent parameters. A context
      // parameter may therefore occupy the immediately adjacent block while
      // each individual term remains line-local.
      const adjacentFirst = sameLineFirst > 0
        ? lineFirstWord(sameLineFirst - 1)
        : sameLineFirst;
      const adjacentLast = sameLineLast + 1 < words.length
        ? lineLastWord(sameLineLast + 1)
        : sameLineLast;
      return {
        ...span,
        contextFirstWord: clampLeadingContext
          ? span.firstWord
          : adjacentFirst,
        contextLastWord: clampTrailingContext
          ? span.lastWord
          : adjacentLast,
      };
    };

    const sourcePieces = (
      desired: NativeQuoteSpan,
      clampLeadingContext: boolean,
      clampTrailingContext: boolean,
    ) => {
      const sourceOnlySeams = oxfordRoleSeriesSeams(document, desired);
      const pieces: MaximalCorePiece[] = [];
      let firstWord = desired.firstWord;
      const add = (lastWord: number) => {
        if (firstWord > lastWord) return;
        const precedingGap = firstWord > desired.firstWord
          ? document.text.slice(words[firstWord - 1].end, words[firstWord].start)
          : "";
        const lineMarker = Math.max(
          precedingGap.lastIndexOf("\n"),
          precedingGap.lastIndexOf("\r"),
        );
        const raw: NativeQuoteSpan = {
          start: firstWord === desired.firstWord
            ? desired.start
            : lineMarker >= 0
              ? words[firstWord - 1].end + lineMarker + 1
              : words[firstWord].start,
          end: lastWord === desired.lastWord
            ? desired.end
            : words[lastWord].end,
          firstWord,
          lastWord,
        };
        const trimmed = trimLeadingFurniture(raw);
        if (trimmed) pieces.push(corePiece(
          trimmed,
          clampLeadingContext && firstWord === desired.firstWord ||
            trimmed.firstWord !== raw.firstWord,
          clampTrailingContext && lastWord === desired.lastWord,
        ));
      };
      for (let word = desired.firstWord; word < desired.lastWord; word += 1) {
        if (!hasStructuralSeam(word, word + 1) &&
            !(publisherMayAnnotateLegalReference && endsLegalReference(document, word)) &&
            !sourceOnlySeams.has(word)) continue;
        add(word);
        firstWord = word + 1;
      }
      add(desired.lastWord);
      return pieces;
    };

    type FurnitureKind = "label" | "metadata" | null;
    const furnitureCache = new Map<number, FurnitureKind>();
    const labelFurnitureCache = new WeakMap<LexicalTerm, boolean>();
    const sourceFurniture = (word: number): FurnitureKind => {
      if (furnitureCache.has(word)) return furnitureCache.get(word)!;
      const first = lineFirstWord(word);
      const last = lineLastWord(word);
      const markerLast = lineStartFurnitureLastWord(document, first, last);
      const line = document.text.slice(words[first].start, words[last].end).trim();
      // These short, labelled court-header rows are locators, not stable prose
      // context. Longer sentences beginning with the same words remain usable.
      const metadata = last - first < 12 &&
        /^(?:citation|court files?|dockets?|registry|date|coram|heard|hearing|style of cause)\b\s*:?/iu.test(line);
      for (let index = first; index <= last; index += 1) {
        furnitureCache.set(index, metadata
          ? "metadata"
          : markerLast !== null && index <= markerLast ? "label" : null);
      }
      return furnitureCache.get(word)!;
    };

    const containsLabelFurniture = (term: LexicalTerm) => {
      const cached = labelFurnitureCache.get(term);
      if (cached !== undefined) return cached;
      let found = false;
      for (let word = term.firstWord; word <= term.lastWord; word += 1) {
        if (sourceFurniture(word) === "label") {
          found = true;
          break;
        }
      }
      labelFurnitureCache.set(term, found);
      return found;
    };

    const atomicDirectiveFor = (
      piece: MaximalCorePiece,
      quoteIndex: number,
      requestedFirst: number,
      requestedLast: number,
      contextAllowed: (term: LexicalTerm) => boolean,
    ) => {
      const key = [
        quoteIndex,
        piece.firstWord,
        piece.lastWord,
        piece.contextFirstWord,
        piece.contextLastWord,
      ].join(":");
      if (directiveCache.has(key)) return directiveCache.get(key)!;

      const shortestSufficientContext = (terms: LexicalTerm[]) => {
        const allowed: LexicalTerm[] = [];
        for (const term of terms) {
          if (!contextAllowed(term)) continue;
          allowed.push(term);
          if (replayExactDirective(document, term.text).count === 1) break;
        }
        return allowed;
      };
      const contextClass = (before?: LexicalTerm, after?: LexicalTerm) => {
        if (!before && !after) return 0;
        if ([before, after].some((term) => term && containsLabelFurniture(term))) return 2;
        const crossesStructuralSeam = Boolean(
          before && hasStructuralSeam(before.lastWord, piece.firstWord) ||
          after && hasStructuralSeam(piece.lastWord, after.firstWord),
        );
        if (crossesStructuralSeam) return 4;
        return [before, after].some((term) => term &&
          (term.firstWord < requestedFirst || term.lastWord > requestedLast)) ? 3 : 1;
      };

      const exactTarget = exactTargetFor(piece);
      const exactTargets = exactTarget ? [exactTarget] : [];
      type ContextPair = readonly [LexicalTerm | undefined, LexicalTerm | undefined];
      const shortestFor = (contexts: ContextPair[]) => {
        let shortest: string | null = null;
        const consider = (directive: string) => {
          if (!shortest || directive.length < shortest.length) shortest = directive;
        };
        for (const target of exactTargets) {
          for (const [before, after] of contexts) {
            // A PDF text layer has no publisher prose outside the cached
            // document. Its sole full-document occurrence is therefore enough
            // to prove an isolated one-word line; HTML still requires local
            // context because publisher chrome can add an earlier match.
            if (target.form === "word" && !before && !after &&
                !(pdf && replayExactDirective(document, target.text).count === 1)) continue;
            const selected = replayExactDirective(
              document,
              target.text,
              before?.text,
              after?.text,
            ).first;
            if (!selects(piece, selected)) continue;
            consider(cachedTextDirective(target.text, before?.text, after?.text));
          }
        }
        return shortest;
      };

      // Context class is the primary ordering contract. Resolve the common
      // context-free class before constructing or multiplying any contextual
      // candidates, then stop at the first class with a valid directive.
      let directive = shortestFor([[undefined, undefined]]);
      if (!directive) {
        const prefix = piece.firstWord > piece.contextFirstWord
          ? shortestSufficientContext(endpointTermsFromEnd({
              start: words[piece.contextFirstWord].start,
              end: words[piece.firstWord - 1].end,
              firstWord: piece.contextFirstWord,
              lastWord: piece.firstWord - 1,
              contextFirstWord: piece.contextFirstWord,
              contextLastWord: piece.firstWord - 1,
            }))
          : [];
        const suffix = piece.lastWord < piece.contextLastWord
          ? shortestSufficientContext(endpointTermsFromStart({
              start: words[piece.lastWord + 1].start,
              end: words[piece.contextLastWord].end,
              firstWord: piece.lastWord + 1,
              lastWord: piece.contextLastWord,
              contextFirstWord: piece.lastWord + 1,
              contextLastWord: piece.contextLastWord,
            }))
          : [];
        const contextsByClass: ContextPair[][] = [[], [], [], [], []];
        const addContext = (before?: LexicalTerm, after?: LexicalTerm) => {
          contextsByClass[contextClass(before, after)].push([before, after]);
        };
        for (const term of prefix) addContext(term);
        for (const term of suffix) addContext(undefined, term);
        for (const before of prefix) {
          for (const after of suffix) addContext(before, after);
        }
        for (let candidateClass = 1; candidateClass < contextsByClass.length; candidateClass += 1) {
          directive = shortestFor(contextsByClass[candidateClass]);
          if (directive) break;
        }
      }
      directiveCache.set(key, directive);
      return directive;
    };

    type Candidate = BuiltPiece & { encodedLength: number };

    const candidateFor = (
      piece: MaximalCorePiece,
      quoteIndex: number,
      directive: string,
    ): Candidate => ({
      directive,
      quoteIndex,
      start: words[piece.firstWord].start,
      end: words[piece.lastWord].end,
      firstWord: piece.firstWord,
      lastWord: piece.lastWord,
      encodedLength: directive.length,
    });

    const directivesFor = (
      piece: MaximalCorePiece,
      quoteIndex: number,
      requestedFirst: number,
      requestedLast: number,
      contextAllowed: (term: LexicalTerm) => boolean,
    ) => {
      const directive = atomicDirectiveFor(
        piece,
        quoteIndex,
        requestedFirst,
        requestedLast,
        contextAllowed,
      );
      return directive ? [candidateFor(piece, quoteIndex, directive)] : [];
    };

    const betterCover = (
      left: Candidate[] | undefined,
      right: Candidate[],
    ) => {
      if (!left) return right;
      if (right.length !== left.length) return right.length < left.length ? right : left;
      const leftLength = left.reduce((sum, item) => sum + item.encodedLength, 0);
      const rightLength = right.reduce((sum, item) => sum + item.encodedLength, 0);
      return rightLength < leftLength ? right : left;
    };

    /** Minimum-cardinality cover for a contiguous requested-word run. */
    const coverRun = (
      firstWord: number,
      lastWord: number,
      candidates: Candidate[],
    ) => {
      const best = new Map<number, Candidate[]>();
      best.set(firstWord, []);
      for (let nextWord = firstWord; nextWord <= lastWord; nextWord += 1) {
        const prefix = best.get(nextWord);
        if (!prefix) continue;
        for (const candidate of candidates) {
          if (candidate.firstWord > nextWord || candidate.lastWord < nextWord ||
              candidate.firstWord < firstWord || candidate.lastWord > lastWord) continue;
          const after = candidate.lastWord + 1;
          best.set(after, betterCover(best.get(after), [...prefix, candidate]));
        }
      }
      return best.get(lastWord + 1) ?? null;
    };

    // A duplicated signed-at/date/judge line immediately before a formal
    // CITATION heading is court-document furniture, not quoted legal prose.
    // This is deliberately lexical and source-proven rather than provider- or
    // seed-specific; every ordinary word remains required.
    const duplicateSignatureMetadata = (desired: NativeQuoteSpan) => {
      let citation = desired.firstWord;
      while (citation <= desired.lastWord && words[citation].text !== "citation") {
        citation += 1;
      }
      if (citation === desired.firstWord || citation > desired.lastWord) return new Set<number>();
      const signatureWords = words
        .slice(desired.firstWord, citation)
        .map(({ text }) => text);
      const signature = signatureWords.join(" ");
      if (!/^at\b.+\bthis\s+\d+(?:st|nd|rd|th)\s+day\s+of\s+.+\s+\d{4}\b.+\bj$/iu.test(signature) ||
          phraseSpans(document, signatureWords, { limit: 2 }).length < 2) {
        return new Set<number>();
      }
      const formalCitation = words
        .slice(citation + 1, Math.min(desired.lastWord + 1, citation + 4))
        .map(({ text }) => text)
        .join(" ");
      const throughHeading = /^\d{4}\s+[a-z]{2,8}\s+\d+$/iu.test(formalCitation)
        ? citation + 1
        : citation;
      return new Set(Array.from(
        { length: throughHeading - desired.firstWord },
        (_, index) => desired.firstWord + index,
      ));
    };

    for (const [quoteIndex, quote] of quotes.entries()) {
      const key = quoteWordsNative(quote).join(" ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const selected = chooseSourceSpan(block, quote);
      if (!selected) {
        complete = false;
        continue;
      }
      // Only established edge furniture/artifacts are outside the guaranteed
      // source interval. HTML stays one range; PDF splits solely on A2AJ lines.
      const adjusted = adjustSpanEdges(block, selected);
      const desired = locateDocumentQuote(block, document, adjusted);
      if (!desired) {
        complete = false;
        continue;
      }
      const clampLeading = adjusted.start > selected.start;
      const clampTrailing = adjusted.end < selected.end;
      const linePieces = sourcePieces(
        desired,
        clampLeading,
        clampTrailing,
      );

      // Words removed from the start of a PDF source line are established
      // provision/list furniture. The only other accepted omission is the
      // independently proved duplicate signature metadata above.
      const required = new Set<number>();
      for (const piece of linePieces) {
        for (let word = piece.firstWord; word <= piece.lastWord; word += 1) {
          required.add(word);
        }
      }
      for (const word of duplicateSignatureMetadata(desired)) required.delete(word);

      const contextAllowed = (term: LexicalTerm) => {
        for (let word = term.firstWord; word <= term.lastWord; word += 1) {
          const furniture = sourceFurniture(word);
          if (word >= desired.firstWord && word <= desired.lastWord) {
            if (!required.has(word) && (furniture !== "label" || pdf)) return false;
          } else if (furniture === "metadata" || furniture === "label" && pdf) {
            return false;
          }
        }
        return true;
      };

      const requiredRuns: Array<readonly [number, number]> = [];
      let runFirst = -1;
      for (let word = desired.firstWord; word <= desired.lastWord + 1; word += 1) {
        if (word <= desired.lastWord && required.has(word)) {
          if (runFirst < 0) runFirst = word;
          continue;
        }
        if (runFirst >= 0) requiredRuns.push([runFirst, word - 1]);
        runFirst = -1;
      }

      for (const [firstWord, lastWord] of requiredRuns) {
        const whole = corePiece({
          start: words[firstWord].start,
          end: words[lastWord].end,
          firstWord,
          lastWord,
        }, clampLeading && firstWord === desired.firstWord,
        clampTrailing && lastWord === desired.lastWord);
        // Prefer the whole requested core when one literal exact term stays
        // inside a source-proven structural run. It paints exactly the quote,
        // never an inferred start/end interval.
        const wholeStaysInStructuralPiece = linePieces.some((piece) =>
          piece.firstWord <= firstWord && piece.lastWord >= lastWord);
        const wholeDirective = wholeStaysInStructuralPiece
          ? atomicDirectiveFor(
              whole,
              quoteIndex,
              firstWord,
              lastWord,
              contextAllowed,
            )
          : null;
        if (wholeDirective) {
          built.push(candidateFor(whole, quoteIndex, wholeDirective));
          continue;
        }

        const candidates: Candidate[] = [];
        const candidateKeys = new Set<string>();
        const addCandidates = (items: Candidate[]) => {
          for (const item of items) {
            const candidateKey = `${item.firstWord}:${item.lastWord}:${item.directive}`;
            if (!candidateKeys.has(candidateKey)) {
              candidateKeys.add(candidateKey);
              candidates.push(item);
            }
          }
        };

        // Otherwise cover the requested union with one exact directive per
        // source-proven structural piece. Do not invent punctuation seams or
        // fall back to a range that can bridge publisher-inserted text.
        for (const line of linePieces) {
          const pieceFirst = Math.max(firstWord, line.firstWord);
          const pieceLast = Math.min(lastWord, line.lastWord);
          if (pieceFirst > pieceLast) continue;
          const piece = corePiece({
            start: words[pieceFirst].start,
            end: words[pieceLast].end,
            firstWord: pieceFirst,
            lastWord: pieceLast,
          }, clampLeading && pieceFirst === desired.firstWord,
          clampTrailing && pieceLast === desired.lastWord);
          addCandidates(directivesFor(
            piece,
            quoteIndex,
            firstWord,
            lastWord,
            contextAllowed,
          ));
        }

        const cover = coverRun(firstWord, lastWord, candidates);
        if (cover) {
          built.push(...cover);
          continue;
        }

        // Never discard the rest of a quote because one substantive word is
        // impossible. Emit the maximal proved components and report incomplete.
        complete = false;
        const coverable = new Set<number>();
        for (const candidate of candidates) {
          for (let word = candidate.firstWord; word <= candidate.lastWord; word += 1) {
            coverable.add(word);
          }
        }
        let componentFirst = -1;
        for (let word = firstWord; word <= lastWord + 1; word += 1) {
          if (word <= lastWord && coverable.has(word)) {
            if (componentFirst < 0) componentFirst = word;
            continue;
          }
          if (componentFirst >= 0) {
            const partial = coverRun(componentFirst, word - 1, candidates);
            if (partial) built.push(...partial);
          }
          componentFirst = -1;
        }
      }
    }
    const ordered = built.sort((left, right) => left.start - right.start);
    const paintedWordSet = new Set<number>();
    for (const piece of ordered) {
      for (let word = piece.firstWord; word <= piece.lastWord; word += 1) {
        paintedWordSet.add(word);
      }
    }
    paintedWords = paintedWordSet.size;
    return {
      target: appendDirectives(targetUrl, ordered.map(({ directive }) => directive)),
      paintQuotes: ordered.map((piece) => phrase(piece)),
      sourceWordIntervals: ordered.map(({
        quoteIndex, start, end, firstWord, lastWord,
      }) => ({ quoteIndex, start, end, firstWord, lastWord })),
      sourceSafeComplete: complete,
      paintedWords,
    };
  };

  const initial = attempt(baseUrl, isPdfSourceUrl(baseUrl));
  if (isPdfSourceUrl(baseUrl) || initial.sourceSafeComplete) return initial;
  const fallbackUrl = evidence.verifiedPdf === undefined
    ? decisiaPdfFallbackUrl(evidence.url, evidence.anchor)
    : evidence.verifiedPdf && !evidence.verifiedPdf.pdfOnly
      ? sourceUrl(evidence.verifiedPdf.url, evidence.anchor)
      : null;
  if (!fallbackUrl) return initial;
  const fallback = attempt(fallbackUrl, true);
  return fallback.sourceSafeComplete || fallback.paintedWords > initial.paintedWords
    ? fallback
    : initial;
}

export function buildMaximalPinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  return buildMaximalPinpointPlan(evidence, quotes).target;
}
