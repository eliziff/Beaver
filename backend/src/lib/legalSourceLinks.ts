import {
  type A2AJCompiledDocument,
  type A2AJDocument,
  type A2AJLocatorKind,
} from "./legalSources/a2aj";
import {
  documentPhraseSpansNative,
  documentTextNative,
  documentTokensNative,
  lookupDocumentNative,
  quoteTextNative,
  quoteWordsNative,
  textPhraseSpansNative,
  tokenizeTextNative,
  type NativeDocument,
  type NativeQuoteSpan,
  type NativeWordSpan,
} from "./structureNative";
import { normalizeWhitespace } from "./text";
import { buildCanliiCaseUrl } from "./canliiUrls";

/**
 * Deterministic pinpoint URLs: a provider anchor where one exists, plus text
 * fragments verified to select exactly one place in the document.
 *
 * Everything here queries either the canonical native document or, for
 * isolated strings, the same Rust text primitives.
 */

export type QuoteSource = string | NativeDocument;

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

type QuoteView = { text: string; native: NativeDocument | null };
const asDoc = (source: QuoteSource): QuoteView => typeof source === "string"
  ? { text: source, native: null }
  : { text: documentTextNative(source), native: source };
const tokens = (source: QuoteView): NativeWordSpan[] => source.native
  ? documentTokensNative(source.native) : tokenizeTextNative(source.text);
const phraseSpans = (source: QuoteView, words: string[], options: {
  start?: number; end?: number; sameLine?: boolean; limit?: number;
} = {}): NativeQuoteSpan[] => source.native
  ? documentPhraseSpansNative(source.native, words, options.start, options.end,
      options.sameLine, options.limit)
  : textPhraseSpansNative(source.text, words, options.start, options.end,
      options.sameLine, options.limit);

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

function buildRangeDirective(
  block: QuoteView,
  span: NativeQuoteSpan,
  document: QuoteView,
) {
  for (const size of RANGE_BOUNDARY_WORDS) {
    const head = edgePhrase(block, span, "start", size);
    const tail = edgePhrase(block, span, "end", size);
    if (!head || !tail || head.last >= tail.first) continue;
    if (rangeDirectiveMatchCount(document, head.text, tail.text) === 1) {
      const paddedHead = citationClusterVariant(head.text);
      const paddedTail = citationClusterVariant(tail.text);
      return {
        directives: [
          textRangeDirective(head.text, tail.text),
          ...((paddedHead || paddedTail)
            ? [
                textRangeDirective(
                  paddedHead ?? head.text,
                  paddedTail ?? tail.text,
                ),
              ]
            : []),
        ],
        start: span.start,
      };
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
  doc: QuoteView,
  quote: string,
): NativeQuoteSpan | null {
  const spans = phraseSpans(doc, quoteWordsNative(quote)).map(
    (span) => ({
      ...span,
      end: extendTerminalPunctuation(doc.text, span.end, quote),
    }),
  );
  if (spans.length === 1) return spans[0];
  if (!spans.length) return null;

  const rendered = spans.map((span) =>
    normalizeWhitespace(doc.text.slice(span.start, span.end)),
  );
  const wanted = [
    normalizeWhitespace(quote.trim().replace(/^["'“”]+|["'“”]+$/gu, "")),
    quoteTextNative(quote),
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
 * Decisia linkifies abbreviation citations ("s. 17") and pads them with
 * non-breaking separators: the rendered run reads "s.<NBSP>17<NBSP> of".
 * Chromium matches fragment whitespace positionally - NBSP folds onto one
 * space, but separator runs never collapse across element boundaries - so a
 * target that continues past such a cluster must carry the padded spelling.
 * A browser ignores any directive that matches nothing, so emitting both
 * spellings is safe everywhere; once a provider's projection is proven we
 * can collapse to its single form.
 */
function citationClusterVariant(target: string): string | null {
  if (!/[A-Za-z]{1,3}\.\s\d/u.test(target)) return null;
  const padded = target
    .replace(/\b([A-Za-z]{1,3}\.)(\s)(\d)/gu, "$1\u00A0$3")
    // The icon glyph leaves an NBSP *before* the prose's own space.
    .replace(/\b([A-Za-z]{1,3}\.\u00A0\d+[A-Za-z0-9.]*)\s/gu, "$1\u00A0 ");
  return padded === target ? null : padded;
}

function exactDirectives(
  target: string,
  prefix = "",
  suffix = "",
): string[] {
  const directives = [textDirective(target, prefix, suffix)];
  const variant = citationClusterVariant(target);
  if (variant) directives.push(textDirective(variant, prefix, suffix));
  return directives;
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
    { sameLine: true, limit: 2 },
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
  const selected = chooseSourceSpan(block, quote);
  if (!selected) return null;
  const span = adjustSpanEdges(block, selected);
  const target = normalizeWhitespace(block.text.slice(span.start, span.end));
  const targetWords = quoteWordsNative(target);
  if (!targetWords.length) return null;

  const targetCount = directiveMatchCount(document, target);
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
  if (!needsContext && targetCount === 1) {
    return { directives: exactDirectives(target), start: span.start };
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
          target,
          candidatePrefix,
          candidateSuffix,
        ) === 1
      ) {
        return {
          directives: exactDirectives(
            target,
            candidatePrefix,
            candidateSuffix,
          ),
          start: span.start,
        };
      }
    }
  }

  return targetCount === 1
    ? { directives: exactDirectives(target), start: span.start }
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
    A2AJDocument,
    "dataset" | "citation" | "alternateCitation" | "language" | "url"
  >,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: QuoteSource,
  quotes: string[],
  document: NativeDocument | null,
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

function verificationDoc(
  passage: { documentText?: QuoteSource },
  block: QuoteView,
) {
  const document = passage.documentText;
  if (document === undefined) return block;
  return typeof document === "string"
    ? document.trim() ? { text: document, native: null } : block
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

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function identityMatches(
  citation: A2AJCitationIdentity,
  source: Pick<
    A2AJDocument,
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
  document: A2AJDocument | A2AJCompiledDocument,
  locator: { kind: A2AJLocatorKind; label: string },
  blockText: QuoteSource,
  quotes: string[],
  source: NativeDocument | null = "native" in document ? document.native : null,
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
  document: QuoteView,
  edge: "start" | "end",
) {
  const line = text.split(/\r?\n/u, 1)[0];
  const block: QuoteView = {
    text: line.replace(/^\s*(?:\[\d+\]|\d+[.)])\s*/u, ""),
    native: null,
  };
  const words = tokens(block);
  for (const length of [12, 16, 8, 24, 32, 6, 4, 2]) {
    if (words.length < length) continue;
    const edgeWords =
      edge === "start"
        ? words.slice(0, length)
        : words.slice(-length);
    const target = normalizeWhitespace(
      block.text.slice(edgeWords[0].start, edgeWords.at(-1)!.end),
    );
    if (directiveMatchCount(document, target) === 1) return target;
  }
  return null;
}

export function buildA2AJParagraphRangeUrl(
  citation: string,
  start: string,
  end: string,
  documents: Array<A2AJDocument | A2AJCompiledDocument>,
) {
  const sources = new Map<
    NativeDocument,
    {
      source: NativeDocument;
      metadata: A2AJDocument | A2AJCompiledDocument;
    }
  >();
  for (const document of documents) {
    if (
      document.url &&
      identityMatches(
        { citation, name: null, dataset: null, url: null, quotes: [] },
        document,
      )
    ) {
      const source = "native" in document ? document.native : null;
      if (!source) continue;
      sources.set(source, { source, metadata: document });
    }
  }
  const candidates = [...sources.values()].flatMap(({ source, metadata }) => {
    const startBlock = lookupDocumentNative(source, "paragraph", start).block;
    const endBlock = lookupDocumentNative(source, "paragraph", end).block;
    return startBlock && endBlock && startBlock.start <= endBlock.start
      ? [{ source, metadata, startBlock, endBlock }]
      : [];
  });
  const structured = candidates.length === 1 ? candidates[0] : null;
  if (!structured) return null;
  const { metadata, source } = structured;
  const sourceView = asDoc(source);
  const startSource = structured.startBlock.text;
  const endSource = structured.endBlock.text;
  const startTarget = uniqueParagraphEdge(startSource, sourceView, "start");
  const endTarget = uniqueParagraphEdge(endSource, sourceView, "end");
  if (!startTarget || !endTarget) return null;
  const anchor = `par${Number(start)}`;
  const baseUrl = metadata.url ? sourceUrl(metadata.url, anchor) : null;
  return baseUrl
    ? appendDirectives(baseUrl, [
        textRangeDirective(startTarget, endTarget),
      ])
    : null;
}
