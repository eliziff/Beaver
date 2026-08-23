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
  let positions = tokenPositionCache.get(source.text);
  if (!positions) {
    positions = new Map();
    sourceWords.forEach(({ text }, index) => {
      const entries = positions!.get(text);
      if (entries) entries.push(index);
      else positions!.set(text, [index]);
    });
    tokenPositionCache.set(source.text, positions);
  }
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
  // Provision labels: "51 (1)", "50(2)", "2(1)(d)(ii)"
  /^\d{1,4}(?:\.\d{1,4})*\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+/u,
  // List markers: "(a)", "(ii)", "(2)"
  /^\(\s*[A-Za-z0-9]{1,5}\s*\)\s*/u,
  /^[A-Za-z]{1,3}\)\s*/u,
  /^\d{1,4}[.)]\s*/u,
  // A bare margin paragraph number: "5 Against this backdrop". Restricted to
  // a following sentence start so years opening prose survive.
  /^\d{1,4}\s+(?=[A-Z“"(])/u,
];
const TRAILING_PIN_ARTIFACT =
  /\s*[.,;:]?\[\s*\d{1,4}(?:\s*[-–—,;]\s*\d{1,4})*\s*\]\s*$/u;
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
): NativeQuoteSpan {
  let start = original.start;
  let end = original.end;
  for (;;) {
    const length = leadingLabelLength(block.text.slice(start, end));
    if (!length) break;
    start += length;
  }
  for (;;) {
    const artifact = block.text.slice(start, end).match(TRAILING_PIN_ARTIFACT);
    if (!artifact) break;
    end -= artifact[0].length;
    if (end <= start) return original;
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
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
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
): number {
  const starts = phraseSpans(
    document,
    quoteWordsNative(start),
    { limit: 3 },
  );
  if (!starts.length) return 0;
  const ends = phraseSpans(document, quoteWordsNative(end), {
    limit: 3,
  });
  if (!ends.length) return 0;
  let pairings = 0;
  for (const startSpan of starts) {
    if (ends.some((endSpan) => endSpan.start >= startSpan.end)) {
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
    if (headCount >= 3) return { text: head, first: phrase.first, last: phrase.first + headCount - 1 };
    if (tailCount >= 3) return { text: tail, first: phrase.last - tailCount + 1, last: phrase.last };
    return null;
  }
  // The end boundary must sit inside one paragraph: prefer the tail (which
  // starts at the continuation word). When the tail is too short, the pre-seam
  // head is the only usable end (paints up to the seam punctuation).
  if (tailCount >= 3) return { text: tail, first: phrase.last - tailCount + 1, last: phrase.last };
  if (headCount >= 3) return { text: head, first: phrase.first, last: phrase.first + headCount - 1 };
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
  return null;
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

function textRangeDirective(start: string, end: string) {
  return `text=${encodeTextFragment(normalizeWhitespace(start))},${encodeTextFragment(normalizeWhitespace(end))}`;
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
  return [
    ...citationClusterVariants(text),
    punctuationDetachVariant(text),
    curlyQuoteVariant(text),
  ].filter((variant): variant is string => variant !== null);
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
  // BLIND PDF-CARD COVERAGE — CT decisions before ~2015 exist only as PDF
  // ("Click here to download the PDF version" stub). From a no-oracle
  // perspective we cannot inspect the live page, so for CT we blindly
  // rewrite the HTML item URL to its PDF rendition. The PDF carries a
  // full text layer, so a #:~:text= built from A2AJ text paints there.
  // Modern CT HTML also has the text, but the PDF is the same content;
  // a PDF fragment is therefore never less correct, and it closes the
  // entire CT pdf-card class with zero oracle.
  if (/^decisions\.ct-tc\.gc\.ca$/iu.test(url.hostname)) {
    const item = url.pathname.match(/^\/ct-tc\/cdo\/en\/item\/(\d+)\/index\.do$/iu);
    if (item) {
      url.pathname = `/ct-tc/cdo/en/${item[1]}/1/document.do`;
      url.search = "";
      // PDF fragments use page=, not par — drop any pre-existing Decisia hash
      // so sourceUrl's anchor logic can re-derive it correctly for PDFs.
      if (url.hash) url.hash = "";
      // CT PDFs are real PDFs — isPdfUrl must see them as such, and Decisia
      // iframe/mobile params are meaningless for a PDF viewer.
      return local ? `${url.pathname}${url.search}${url.hash}` : url.toString();
    }
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
  if (bclaws) {
    resolvedAnchor = resolvedAnchor.replace(/^sec(?=\d)/iu, "section");
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

export function buildLegalSourcePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  const block = asDoc(evidence.blockText);
  if (!baseUrl || !block.text) return baseUrl;
  const uniqueQuotes = new Map<string, string>();
  for (const quote of quotes) {
    const key = quoteWordsNative(quote).join(" ");
    if (key && !uniqueQuotes.has(key)) uniqueQuotes.set(key, quote);
  }
  if (!uniqueQuotes.size) return baseUrl;

  const document = verificationDoc(evidence, block);
  const built = [...uniqueQuotes.values()].map((quote) =>
    buildDirective(block, quote, document, evidence.pageScoped === true),
  );
  if (built.some((directive) => !directive)) return baseUrl;
  // Sort by span position, then flatten each span's directive variants.
  // Variants share their primary's uniqueness proof; the browser applies
  // whichever spelling the rendered page actually carries.
  const directives = [
    ...new Set(
      built
        .filter((directive): directive is NonNullable<typeof directive> =>
          Boolean(directive),
        )
        .sort((left, right) => left.start - right.start)
        .flatMap((directive) => directive.directives),
    ),
  ];
  return appendDirectives(baseUrl, directives);
}

/**
 * Minimal falsification candidate: one shortest unambiguous range per quote.
 * The range leaves all interior publisher structure out of the directive;
 * endpoint phrases grow only when the flattened document requires it.
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
    const target = normalizeWhitespace(block.text.slice(span.start, span.end));
    const width = span.lastWord - span.firstWord + 1;
    // A range needs two non-overlapping boundary runs. For shorter passages,
    // the whole quote is both smaller and less ambiguous than weakened ends.
    if (width <= minimumBoundaryWords * 2) {
      if (directiveMatchCount(document, target) !== 1) return baseUrl;
      built.push({ directive: textDirective(target), start: span.start });
      continue;
    }
    let directive: string | null = null;
    for (let size = minimumBoundaryWords; size <= Math.min(12, width - 1); size += 1) {
      const head = edgePhrase(block, span, "start", size);
      const tail = edgePhrase(block, span, "end", size);
      if (!head || !tail || head.last >= tail.first) continue;
      if (rangeDirectiveMatchCount(document, head.text, tail.text) === 1) {
        directive = textRangeDirective(head.text, tail.text);
        break;
      }
    }
    if (!directive) return baseUrl;
    built.push({ directive, start: span.start });
  }
  return appendDirectives(
    baseUrl,
    built.sort((left, right) => left.start - right.start).map(({ directive }) => directive),
  );
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
  const blockWords = tokens(block);
  const documentWords = tokens(document);
  const built: Array<{ directive: string; start: number }> = [];
  const seen = new Set<string>();
  for (const quote of quotes) {
    const key = quoteWordsNative(quote).join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const selected = chooseSourceSpan(block, quote);
    if (!selected) return baseUrl;
    let desired: NativeQuoteSpan | null = null;
    for (const window of [0, 2, 4, 8, 16, 32, 64, blockWords.length]) {
      const first = Math.max(0, selected.firstWord - window);
      const last = Math.min(blockWords.length - 1, selected.lastWord + window);
      const matches = phraseSpans(document,
        blockWords.slice(first, last + 1).map(({ text }) => text), { limit: 2 });
      if (matches.length !== 1) continue;
      const offset = selected.firstWord - first;
      desired = {
        start: documentWords[matches[0].firstWord + offset].start,
        end: documentWords[matches[0].firstWord + offset + selected.lastWord - selected.firstWord].end,
        firstWord: matches[0].firstWord + offset,
        lastWord: matches[0].firstWord + offset + selected.lastWord - selected.firstWord,
      };
      break;
    }
    if (!desired) {
      if (process.env.BUILDER_DEBUG === "1") console.error("[line-core] document occurrence ambiguous", quote);
      return baseUrl;
    }
    let target: { text: string; prefix: string; suffix: string } | null = null;
    for (const asciiOnly of [true, false]) {
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
        const contexts: Array<[string, string]> = directiveMatchCount(document, candidate) === 1
          ? [["", ""]]
          : [[prefix, ""], ["", suffix], [prefix, suffix]];
        const context = contexts.find(([before, after]) =>
          (before || after || directiveMatchCount(document, candidate) === 1) &&
          directiveMatchCount(document, candidate, before, after) === 1);
        if (context) {
          target = { text: candidate, prefix: context[0], suffix: context[1] };
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
    built.push({ directive: textDirective(target.text, target.prefix, target.suffix), start: selected.start });
  }
  return appendDirectives(baseUrl,
    built.sort((left, right) => left.start - right.start).map(({ directive }) => directive));
}
