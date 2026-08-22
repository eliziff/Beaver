import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
  type A2AJLocatorKind,
  type A2AJLocatorLookup,
} from "../../backend/src/lib/legalSources/a2aj";
import {
  createTextSourceDoc,
  sourceDocBlockText,
  sourceDocPhraseSpans,
  sourceDocQuoteText,
  sourceDocQuoteWords,
  type SourceDoc,
  type SourceDocQuoteSpan,
} from "../../backend/src/lib/sourceDoc";
import { normalizeWhitespace } from "../../backend/src/lib/text";
import { buildCanliiCaseUrl } from "../../backend/src/lib/canliiUrls";

/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here is a query over a SourceDoc. Callers that already hold the
 * compiled artifact pass it; callers that only hold a rendition pass the text
 * and the artifact is compiled once for the call, never once per quote.
 */

export type QuoteSource = string | SourceDoc;

type A2AJCitationIdentity = {
  citation: string | null;
  name: string | null;
  dataset: string | null;
  url: string | null;
  quotes: { quote: string }[];
};

export type LegalSourceEvidence = {
  url: string;
  anchor?: string;
  /** The passage the quote must appear in. */
  blockText: QuoteSource;
  /** The corpus the fragment must be unique in; the block when absent. */
  documentText?: QuoteSource;
  pageScoped?: boolean;
};

function asDoc(source: QuoteSource): SourceDoc {
  return typeof source === "string" ? createTextSourceDoc(source) : source;
}

type A2AJLookupBlock = NonNullable<A2AJLocatorLookup["block"]>;

const CONTEXT_WINDOWS = [4, 2, 8, 12, 16, 24, 32];
// A whole-quote target longer than one tight prose run is more fragile than a
// start,end range: every extra word is another chance for publisher
// punctuation or inline markup to break the match, and a range's short
// boundaries each sit inside one block even when the passage spans several.
// The trigger scales with the evidence span itself (length, or a line break
// inside it), not with a provider name.
const RANGE_PREFERRED_WORDS = 20;
const RANGE_PREFERRED_CHARS = 150;
const RANGE_BOUNDARY_WORDS = [6, 4, 8, 12];

/**
 * Structural labels that publishers render outside the prose run - margin
 * paragraph numbers, provision headings, list markers - plus the bracketed
 * pinpoint ranges A2AJ appends ("[99-135]") that never appear on the page.
 * A target that begins or ends with one cannot match the rendered DOM, so
 * edges are stripped before anything else happens.
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

function wordAtOrAfter(block: SourceDoc, offset: number, from: number): number {
  for (let index = from; index < block.tokens.length; index += 1) {
    if (block.tokens[index].end > offset) return index;
  }
  return -1;
}

function wordAtOrBefore(
  block: SourceDoc,
  offset: number,
  from: number,
): number {
  for (let index = Math.min(from, block.tokens.length - 1); index >= 0; index -= 1) {
    if (block.tokens[index].start < offset) return index;
  }
  return -1;
}

/**
 * Move the span edges off structural labels and A2AJ artifacts so directive
 * targets are pure prose runs. The evidence quote keeps its original wording;
 * only what the fragment must match is trimmed.
 */
function adjustSpanEdges(
  block: SourceDoc,
  original: SourceDocQuoteSpan,
): SourceDocQuoteSpan {
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
  block: SourceDoc,
  span: SourceDocQuoteSpan,
  edge: "start" | "end",
  size: number,
): { text: string; first: number; last: number } | null {
  const forward = edge === "start";
  const indexes: number[] = [];
  const step = forward ? 1 : -1;
  for (
    let index = forward ? span.firstWord : span.lastWord;
    indexes.length < size &&
    (forward ? index <= span.lastWord : index >= span.firstWord);
    index += step
  ) {
    const token = block.tokens[index];
    if (!token) break;
    if (indexes.length) {
      const previous = block.tokens[indexes.at(-1)!];
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
    block.text.slice(block.tokens[first].start, block.tokens[last].end),
  );
  // An end run like "5.5 Summary" anchors on its prose: "Summary".
  const text = stripLeadingLabels(raw);
  return sourceDocQuoteWords(text).length
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
  document: SourceDoc,
  start: string,
  end: string,
): number {
  const starts = sourceDocPhraseSpans(
    document,
    sourceDocQuoteWords(start),
    { limit: 3 },
  );
  if (!starts.length) return 0;
  const ends = sourceDocPhraseSpans(document, sourceDocQuoteWords(end), {
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
 */
const SEAM = /[:;]\s+\S|\.\s+[A-Z]/u;

function seamSplit(
  phrase: { text: string; first: number; last: number },
  edge: "start" | "end",
): { text: string; first: number; last: number } | null {
  const match = phrase.text.match(SEAM);
  if (!match || match.index === undefined) return null;
  if (edge === "start") {
    const cut = match.index + 1; // keep the colon/period
    const text = phrase.text.slice(0, cut).trim();
    const count = sourceDocQuoteWords(text).length;
    if (count < 3) return null;
    return { text, first: phrase.first, last: phrase.first + count - 1 };
  }
  const lastWhitespace = match[0].search(/\s+\S+$/u);
  if (lastWhitespace < 0) return null;
  const restStart = match.index + lastWhitespace + 1;
  const text = phrase.text.slice(restStart).trim();
  const count = sourceDocQuoteWords(text).length;
  if (count < 3) return null;
  return { text, first: phrase.last - count + 1, last: phrase.last };
}

function boundaryVariants(text: string): string[] {
  return [
    ...citationClusterVariants(text),
    punctuationDetachVariant(text),
    curlyQuoteVariant(text),
  ].filter((variant): variant is string => variant !== null);
}

function buildRangeDirective(
  block: SourceDoc,
  span: SourceDocQuoteSpan,
  document: SourceDoc,
) {
  for (const size of RANGE_BOUNDARY_WORDS) {
    const head = edgePhrase(block, span, "start", size);
    const tail = edgePhrase(block, span, "end", size);
    if (!head || !tail) continue;
    const pairs = [
      { head, tail },
      { head: seamSplit(head, "start") ?? head, tail: seamSplit(tail, "end") ?? tail },
    ];
    for (const { head: candidateHead, tail: candidateTail } of pairs) {
      if (candidateHead.last >= candidateTail.first) continue;
      if (rangeDirectiveMatchCount(document, candidateHead.text, candidateTail.text) !== 1) continue;
      const headVariants = boundaryVariants(candidateHead.text);
      const tailVariants = boundaryVariants(candidateTail.text);
      const combos = new Set<string>();
      combos.add(textRangeDirective(candidateHead.text, candidateTail.text));
      for (
        let grade = 0;
        grade < Math.max(headVariants.length, tailVariants.length) && combos.size < 4;
        grade += 1
      ) {
        combos.add(
          textRangeDirective(
            headVariants[grade] ?? candidateHead.text,
            tailVariants[grade] ?? candidateTail.text,
          ),
        );
      }
      return { directives: [...combos], start: span.start };
    }
  }
  return null;
}

/**
 * Where in `doc` a quote sits. When it sits in more than one place, the tie is
 * broken by comparing the rendered text - first as written, then with editorial
 * alterations resolved ("[T]he" is the document's "The"), then case-folded.
 * Without the second comparison an altered quote that appears twice loses its
 * link entirely, which is exactly what a court quotation looks like.
 */
function chooseSourceSpan(
  doc: SourceDoc,
  quote: string,
): SourceDocQuoteSpan | null {
  const extend = (span: SourceDocQuoteSpan) => ({
    ...span,
    end: extendTerminalPunctuation(doc.text, span.end, quote),
  });
  let spans = sourceDocPhraseSpans(doc, sourceDocQuoteWords(quote)).map(extend);
  if (!spans.length) {
    // Editorial bracket insertions ("[t]he") tokenize as split words in the
    // document ("t", "he") but merge under quote-word normalisation; retry
    // with bracket characters treated as separators.
    spans = sourceDocPhraseSpans(
      doc,
      sourceDocQuoteWords(quote.replace(/[\[\]"]/gu, " ")),
    ).map(extend);
  }
  if (spans.length === 1) return spans[0];
  if (!spans.length) return null;

  const rendered = spans.map((span) =>
    normalizeWhitespace(doc.text.slice(span.start, span.end)),
  );
  const wanted = [
    normalizeWhitespace(quote.trim().replace(/^["'“”]+|["'“”]+$/gu, "")),
    sourceDocQuoteText(quote),
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
 * Publisher templates detach punctuation from its neighbours: BC courts put
 * a space before colons that follow italics ("Freedoms : s. 1"), CITT puts
 * spaces around abbreviation periods ("60. (1)", "8 ."). Detached spellings
 * cannot be derived from source text, so they ship as sibling variants.
 */
function punctuationDetachVariant(target: string): string | null {
  const detached = target
    // "Freedoms:" -> "Freedoms :" (space before a colon that follows a letter)
    .replace(/([A-Za-z])(:)/gu, "$1 $2")
    // "60.(1)" -> "60. (1)" (space after a period between digit and paren)
    .replace(/(\d)(\.)(\()/gu, "$1$2 $3")
    // "8." at a token start -> "8 ." (space before a trailing period)
    .replace(/((?:^|[\s(])(?:\d+(?:\.\d+)*)?)(\d)(\.)(?=\s)/gu, (_m, head, digit, dot) => `${head}${digit} ${dot}`);
  return detached === target ? null : detached;
}

/**
 * Legal prose set by publishers uses typographic quotes; flattened corpus
 * text usually carries ASCII ones. Emit the curly spelling beside the
 * straight one.
 */
function curlyQuoteVariant(target: string): string | null {
  if (!/["']/u.test(target)) return null;
  const curly = target
    .replace(/(\S)"(\S)/gu, "$1\u201C$2")
    .replace(/(\S)'(\S)/gu, "$1\u2018$2")
    .replace(/"(\S)/gu, "\u201C$1")
    .replace(/(\S)"/gu, "$1\u201D");
  return curly === target ? null : curly;
}

/**
 * When an exact target itself crosses a publisher paragraph seam ("...that:
 * The Chambers..."), no single-run spelling can match. Emit a verified
 * split-range sibling: start ends at the seam punctuation, end begins at the
 * continuation word; Chromium highlights the whole span between them.
 */
function seamRangeSibling(target: string, document: SourceDoc): string[] {
  const match = target.match(SEAM);
  if (!match || match.index === undefined) return [];
  const lastWhitespace = match[0].search(/\s+\S+$/u);
  if (lastWhitespace < 0) return [];
  const headText = target.slice(0, match.index + 1).trim();
  const tailText = target.slice(match.index + lastWhitespace + 1).trim();
  if (
    sourceDocQuoteWords(headText).length < 2 ||
    sourceDocQuoteWords(tailText).length < 2
  ) {
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

function a2ajLocatorAnchor(
  rawUrl: string | null,
  kind: A2AJLocatorKind,
  label: string,
) {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const canlii = /(^|\.)canlii\.org$/iu.test(url.hostname);
  if (kind === "paragraph") {
    const number = label.match(/^par(\d+)/iu)?.[1];
    return number &&
      ((canlii && url.pathname.includes("/doc/")) || isDecisiaDocument(url))
      ? `par${Number(number)}`
      : undefined;
  }
  if (kind === "page") {
    const number = label.match(/^page=?(\d+)/iu)?.[1];
    return number && url.pathname.toLowerCase().endsWith(".pdf")
      ? `page=${Number(number)}`
      : undefined;
  }
  const topLevelSection = label.match(
    /^sec(\d+(?:[.-]\d+){0,3}[A-Za-z]?)/iu,
  )?.[1];
  return topLevelSection && canlii && url.pathname.includes("/laws/")
    ? `sec${topLevelSection}`
    : undefined;
}

function sourceUrl(rawUrl: string, anchor?: string): string | null {
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
  document: SourceDoc,
  target: string,
  prefix = "",
  suffix = "",
) {
  return sourceDocPhraseSpans(
    document,
    [
      ...sourceDocQuoteWords(prefix),
      ...sourceDocQuoteWords(target),
      ...sourceDocQuoteWords(suffix),
    ],
    { sameLine: true, limit: 2 },
  ).length;
}

function contextFor(
  block: SourceDoc,
  span: SourceDocQuoteSpan,
  window: number,
): { prefix: string; suffix: string } {
  const words = block.tokens;
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
  block: SourceDoc,
  quote: string,
  document: SourceDoc,
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
  const targetWords = sourceDocQuoteWords(target);
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
  // only honest fragment. Long passages get first claim on a range too - each
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
  if (!needsContext && targetCount === 1) {
    return {
      directives: exactDirectives(effectiveTarget, "", "", seamRangeSibling(effectiveTarget, document), effectiveTarget === target ? [] : [target, ...spellingsOf(target)]),
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
            effectiveTarget === target ? [] : [target, ...spellingsOf(target)],
          ),
          start: span.start,
        };
      }
    }
  }

  return targetCount === 1
    ? {
        directives: exactDirectives(effectiveTarget, "", "", seamRangeSibling(effectiveTarget, document), effectiveTarget === target ? [] : [target, ...spellingsOf(target)]),
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

function buildA2AJSourcePinpointUrl(
  source: Pick<
    A2AJLocatorLookup | A2AJDocument,
    "dataset" | "citation" | "alternateCitation" | "language" | "url"
  >,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: QuoteSource,
  quotes: string[],
  document: SourceDoc | null,
) {
  if (!source.url) return null;
  const anchor = a2ajLocatorAnchor(source.url, locator.kind, locator.label);
  const baseUrl = sourceUrl(source.url, anchor);
  return baseUrl
    ? buildLegalSourcePinpointUrl({
        url: baseUrl,
        blockText,
        ...(document && { documentText: document }),
        pageScoped: locator.kind === "page",
      }, quotes)
    : null;
}

export function buildA2AJPinpointUrl(
  lookup: A2AJLocatorLookup,
  quotes: string[],
  document: SourceDoc | null = a2ajLegalSourceProvider.source(lookup),
  block: A2AJLookupBlock | null = lookup.block,
) {
  const label = block?.label || lookup.requested.label;
  return buildA2AJSourcePinpointUrl(
    lookup,
    { kind: lookup.requested.kind, label },
    lookup.status === "found" && block ? block.text : "",
    quotes,
    document,
  );
}

function verificationDoc(
  passage: { documentText?: QuoteSource },
  block: SourceDoc,
) {
  const document = passage.documentText;
  if (document === undefined) return block;
  return typeof document === "string"
    ? document.trim()
      ? createTextSourceDoc(document)
      : block
    : document;
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
    const key = sourceDocQuoteWords(quote).join(" ");
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

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function identityMatches(
  citation: A2AJCitationIdentity,
  source: Pick<
    A2AJLocatorLookup | A2AJDocument,
    "citation" | "alternateCitation" | "dataset"
  >,
) {
  if (citation.citation) {
    const wanted = normalizedIdentity(citation.citation);
    if (
      ![source.citation, source.alternateCitation]
        .map(normalizedIdentity)
        .includes(wanted)
    ) {
      return false;
    }
  }
  if (
    citation.dataset &&
    normalizedIdentity(citation.dataset) !== normalizedIdentity(source.dataset)
  ) {
    return false;
  }
  return true;
}

function isCanadianDecisionUrl(url: URL) {
  return (
    isDecisiaDocument(url) ||
    ((url.hostname === "canlii.org" || url.hostname === "www.canlii.org") &&
      url.pathname.includes("/doc/")) ||
    ((url.hostname === "bccourts.ca" ||
      url.hostname === "www.bccourts.ca") &&
      url.pathname.toLowerCase().includes("/jdb-txt/")) ||
    ((url.hostname === "scc-csc.ca" ||
      url.hostname === "www.scc-csc.ca") &&
      url.pathname.toLowerCase().includes("/case-dossier/"))
  );
}

/** Rebuild the same A2AJ link after a prior-turn receipt has been rehydrated. */
export function buildA2AJDocumentPinpointUrl(
  document: A2AJDocument,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: QuoteSource,
  quotes: string[],
  source: SourceDoc | null = a2ajLegalSourceProvider.source(document),
) {
  return buildA2AJSourcePinpointUrl(
    document,
    locator,
    blockText,
    quotes,
    source,
  );
}

const ANSWER_CASE_CITATION =
  /\b(((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9-]{1,15})\s+(\d+))\b/giu;

function answerCaseCitations(answer: string) {
  return [...answer.matchAll(ANSWER_CASE_CITATION)].flatMap((match) => {
    const citation = match[1].replace(/\s+/gu, " ");
    const dataset = match[3].toUpperCase();
    const url = buildCanliiCaseUrl({
      dataset,
      citations: [citation],
      language: "en",
    });
    return url
      ? [
          {
            start: match.index,
            end: match.index + match[0].length,
            label: match[0],
            citation,
            dataset,
            url,
          },
        ]
      : [];
  });
}

function rewriteModelCanadianDecisionUrls(answer: string) {
  let found = false;
  const strip = (rawUrl: string) => {
    try {
      if (!isCanadianDecisionUrl(new URL(rawUrl))) return rawUrl;
      found = true;
      return "";
    } catch {
      return rawUrl;
    }
  };
  const text = answer
    .replace(
      /\[([^\]\r\n]+)\]\(([^)\r\n]*)\)/gu,
      (full, label: string) =>
        answerCaseCitations(label).length ? label : full,
    )
    .replace(
      /\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
      (full, label: string, url: string) => (strip(url) ? full : label),
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/gu, (url) => {
      const suffix = url.match(/[.,;:!?]+$/u)?.[0] ?? "";
      const target = suffix ? url.slice(0, -suffix.length) : url;
      return strip(target) ? url : suffix;
    })
    .replace(/^[\t ]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
  return { found, text };
}

export function hasCanadianDecisionLink(answer: string) {
  return rewriteModelCanadianDecisionUrls(answer).found;
}

function uniqueParagraphEdge(
  text: string,
  document: SourceDoc,
  edge: "start" | "end",
) {
  const line = text.split(/\r?\n/u, 1)[0];
  const block = createTextSourceDoc(
    line.replace(/^\s*(?:\[\d+\]|\d+[.)])\s*/u, ""),
  );
  for (const length of [12, 16, 8, 24, 32, 6, 4, 2]) {
    if (block.tokens.length < length) continue;
    const words =
      edge === "start"
        ? block.tokens.slice(0, length)
        : block.tokens.slice(-length);
    const target = normalizeWhitespace(
      block.text.slice(words[0].start, words.at(-1)!.end),
    );
    if (directiveMatchCount(document, target) === 1) return target;
  }
  return null;
}

export function buildA2AJParagraphRangeUrl(
  citation: string,
  start: string,
  end: string,
  lookups: A2AJLocatorLookup[],
  documents: A2AJDocument[],
) {
  const sources = new Map<
    string,
    {
      source: SourceDoc;
      metadata: A2AJLocatorLookup | A2AJDocument;
    }
  >();
  for (const lookup of lookups) {
    if (
      lookup.status !== "found" ||
      !identityMatches(
        { citation, name: null, dataset: null, url: null, quotes: [] },
        lookup,
      )
    ) {
      continue;
    }
    const source = a2ajLegalSourceProvider.source(lookup);
    if (source) sources.set(source.id, { source, metadata: lookup });
  }
  for (const document of documents) {
    if (
      document.url &&
      identityMatches(
        { citation, name: null, dataset: null, url: null, quotes: [] },
        document,
      )
    ) {
      const source = a2ajLegalSourceProvider.source(document);
      if (!source) continue;
      const current = sources.get(source.id);
      if (!current || source.blocks.length > current.source.blocks.length) {
        sources.set(source.id, { source, metadata: document });
      }
    }
  }
  const candidates = [...sources.values()].flatMap(({ source, metadata }) => {
    const startBlock = source.blocks.find(
      (block) =>
        block.kind === "paragraph" &&
        normalizedIdentity(block.label) === `par${Number(start)}`,
    );
    const endBlock = source.blocks.find(
      (block) =>
        block.kind === "paragraph" &&
        normalizedIdentity(block.label) === `par${Number(end)}`,
    );
    return startBlock && endBlock && startBlock.start <= endBlock.start
      ? [{ source, metadata, startBlock, endBlock }]
      : [];
  });
  const structured = candidates.length === 1 ? candidates[0] : null;
  const rangeLookup = lookups.filter(
    (lookup) =>
      lookup.status === "found" &&
      lookup.block &&
      lookup.requested.kind === "paragraph" &&
      lookup.requested.locator === `${Number(start)}-${Number(end)}` &&
      identityMatches(
        { citation, name: null, dataset: null, url: null, quotes: [] },
        lookup,
      ),
  );
  if (!structured && rangeLookup.length !== 1) return null;
  const metadata = structured?.metadata ?? rangeLookup[0];
  const source =
    structured?.source ??
    a2ajLegalSourceProvider.source(rangeLookup[0]) ??
    createTextSourceDoc(rangeLookup[0].block!.text);
  const lines = structured
    ? []
    : rangeLookup[0].block!.text.split(/\r?\n/u).filter((line) => line.trim());
  const startSource = structured
    ? sourceDocBlockText(source, structured.startBlock)
    : (lines[0] ?? "");
  const endSource = structured
    ? sourceDocBlockText(source, structured.endBlock)
    : (lines.at(-1) ?? "");
  const startTarget = uniqueParagraphEdge(startSource, source, "start");
  const endTarget = uniqueParagraphEdge(endSource, source, "end");
  if (!startTarget || !endTarget) return null;
  const anchor = `par${Number(start)}`;
  const baseUrl = metadata.url ? sourceUrl(metadata.url, anchor) : null;
  return baseUrl
    ? appendDirectives(baseUrl, [
        textRangeDirective(startTarget, endTarget),
      ])
    : null;
}
