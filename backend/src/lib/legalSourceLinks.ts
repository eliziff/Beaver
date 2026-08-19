import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "./legalSources/a2aj";
import {
  createTextSourceDoc,
  sourceDocBlockText,
  sourceDocPhraseSpans,
  sourceDocQuoteText,
  sourceDocQuoteWords,
  type SourceDoc,
  type SourceDocQuoteSpan,
} from "./sourceDoc";
import { normalizeWhitespace } from "./text";
import { buildCanliiCaseUrl } from "./canliiUrls";

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
const LONG_FRAGMENT_WORDS = 30;
const LONG_FRAGMENT_CHARS = 220;
const RANGE_BOUNDARY_WORDS = 5;
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
  const spans = sourceDocPhraseSpans(doc, sourceDocQuoteWords(quote)).map(
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
    sourceDocQuoteText(quote),
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

function textRangeTargets(block: SourceDoc, span: SourceDocQuoteSpan) {
  let firstWord = span.firstWord;
  const secondWord = block.tokens[firstWord + 1];
  if (
    secondWord &&
    /^(?:\[\s*)?\d{1,4}(?:\s*\])?[.)]?\s*$/u.test(
      block.text.slice(span.start, secondWord.start),
    )
  ) {
    firstWord += 1;
  }
  const words = block.tokens.slice(firstWord, span.lastWord + 1);
  if (words.length < RANGE_BOUNDARY_WORDS * 2) return null;
  const count = Math.min(
    RANGE_BOUNDARY_WORDS,
    Math.max(3, Math.floor(words.length / 3)),
  );
  const first = words.slice(0, count);
  const last = words.slice(-count);
  if (first.at(-1)!.end >= last[0].start) return null;
  return {
    start: normalizeWhitespace(
      block.text.slice(first[0].start, first.at(-1)!.end),
    ),
    end: normalizeWhitespace(
      block.text.slice(last[0].start, span.end),
    ),
  };
}

function rangeDirectiveMatchCount(
  document: SourceDoc,
  start: string,
  end: string,
) {
  const starts = sourceDocPhraseSpans(document, sourceDocQuoteWords(start), {
    sameLine: true,
    limit: 2,
  });
  const ends = sourceDocPhraseSpans(document, sourceDocQuoteWords(end), {
    sameLine: true,
  });
  let count = 0;
  for (const startSpan of starts) {
    if (
      ends.some(
        (endSpan) =>
          endSpan.start >= startSpan.end &&
          !document.text.slice(startSpan.end, endSpan.end).includes("\n"),
      )
    ) {
      count += 1;
      if (count === 2) break;
    }
  }
  return count;
}

function locatorAnchor(
  lookup: A2AJLocatorLookup,
  block: A2AJLookupBlock | null = lookup.block,
) {
  if (!lookup.url) return undefined;
  let url: URL;
  try {
    url = new URL(lookup.url);
  } catch {
    return undefined;
  }
  const label = block?.label || lookup.requested.label;
  const canlii = /(^|\.)canlii\.org$/iu.test(url.hostname);
  if (lookup.requested.kind === "paragraph") {
    const number = label.match(/^par(\d+)/iu)?.[1];
    return number &&
      ((canlii && url.pathname.includes("/doc/")) || isDecisiaDocument(url))
      ? `par${Number(number)}`
      : undefined;
  }
  if (lookup.requested.kind === "page") {
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

function preferredA2AJUrl(
  source: Pick<
    A2AJLocatorLookup | A2AJDocument,
    "dataset" | "citation" | "alternateCitation" | "language" | "url"
  >,
  hasQuotes: boolean,
  anchor?: string,
) {
  const canlii = buildCanliiCaseUrl({
    dataset: source.dataset,
    citations: [source.citation, source.alternateCitation],
    language: source.language,
  });
  if (!canlii) return source.url;

  // ALR keeps the ordinary citation link on CanLII, but SCC quote highlights
  // use the official decision when a native paragraph target is known. The
  // official source and the user-facing deep link are deliberately different
  // roles; sourceUrl() adds the required inline/mobile Decisia parameters.
  if (
    hasQuotes &&
    anchor?.startsWith("par") &&
    source.dataset.toUpperCase() === "SCC" &&
    source.url
  ) {
    try {
      if (isDecisiaDocument(new URL(source.url))) return source.url;
    } catch {
      // Fall through to the identity-locked CanLII URL.
    }
  }
  return canlii;
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
    // The default Decisia URL is an iframe shell with no document text, so
    // neither anchors nor text fragments can resolve against it. iframe=true
    // serves the document inline. site_preference=mobile is REQUIRED, not
    // cosmetic: in the desktop rendering a text-fragment jump locks the
    // viewport on the matched text and the page cannot be scrolled. Server
    // probes cannot see this — do not remove it based on HTML inspection.
    // The preference cookie it sets is harmless: users only reach these
    // URLs through Beaver's deep links, never with the iframe flag by hand.
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
  const selected = chooseSourceSpan(block, quote);
  if (!selected) return null;
  const leadingMarker = block.text
    .slice(selected.start, selected.end)
    .match(/^\s*(?:\[\s*\d{1,4}\s*\]|\d{1,4}\])\s*/u)?.[0];
  const markerEnd = selected.start + (leadingMarker?.length ?? 0);
  const firstWord = leadingMarker
    ? block.tokens.findIndex((token) => token.start >= markerEnd)
    : selected.firstWord;
  const span = leadingMarker && firstWord >= 0
    ? { ...selected, start: markerEnd, firstWord }
    : selected;
  const target = normalizeWhitespace(block.text.slice(span.start, span.end));
  const targetWords = sourceDocQuoteWords(target);
  if (!targetWords.length) return null;

  const targetCount = directiveMatchCount(document, target);
  if (
    targetCount === 1 &&
    (targetWords.length >= LONG_FRAGMENT_WORDS ||
      target.length >= LONG_FRAGMENT_CHARS)
  ) {
    const range = textRangeTargets(block, span);
    if (
      range &&
      rangeDirectiveMatchCount(document, range.start, range.end) === 1
    ) {
      return {
        directive: textRangeDirective(range.start, range.end),
        start: span.start,
      };
    }
  }
  const needsContext =
    targetWords.length <= 3 ||
    targetCount !== 1 ||
    (pageScoped && targetWords.length <= 8);
  if (!needsContext && targetCount === 1) {
    return { directive: textDirective(target), start: span.start };
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
          directive: textDirective(target, candidatePrefix, candidateSuffix),
          start: span.start,
        };
      }
    }
  }

  return targetCount === 1
    ? { directive: textDirective(target), start: span.start }
    : null;
}

function appendDirectives(url: string, directives: string[]) {
  if (!directives.length) return url;
  return url.includes("#")
    ? `${url}:~:${directives.join("&")}`
    : `${url}#:~:${directives.join("&")}`;
}

export function buildA2AJPinpointUrl(
  lookup: A2AJLocatorLookup,
  quotes: string[],
  document: SourceDoc | null = a2ajLegalSourceProvider.source(lookup),
  block: A2AJLookupBlock | null = lookup.block,
) {
  const sourceAnchor = locatorAnchor(lookup, block);
  const preferredUrl =
    lookup.requested.kind === "paragraph"
      ? preferredA2AJUrl(lookup, quotes.length > 0, sourceAnchor)
      : lookup.url;
  if (!preferredUrl) return null;
  const anchor = locatorAnchor({ ...lookup, url: preferredUrl }, block);
  const baseUrl = sourceUrl(preferredUrl, anchor);
  if (!baseUrl) return null;
  return buildLegalSourcePinpointUrl(
    {
      url: baseUrl,
      blockText: lookup.status === "found" && block ? block.text : "",
      documentText: document ?? undefined,
      pageScoped: lookup.requested.kind === "page",
    },
    quotes,
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
  const directives = [
    ...new Map(
      built
        .filter((directive): directive is NonNullable<typeof directive> =>
          Boolean(directive),
        )
        .sort((left, right) => left.start - right.start)
        .map((directive) => [directive.directive, directive]),
    ).values(),
  ].map(({ directive }) => directive);
  return appendDirectives(baseUrl, directives);
}

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

/** A quote is "in" a passage when it selects exactly one span of it. */
function quoteMatchesBlock(block: SourceDoc, quote: string) {
  return Boolean(chooseSourceSpan(block, quote));
}

export function legalSourceQuoteMatchesBlock(
  block: QuoteSource,
  quote: string,
) {
  return quoteMatchesBlock(asDoc(block), quote);
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

function answerQuoteCandidates(answer: string) {
  const withoutCode = answer.replace(/```[\s\S]*?```/gu, " ");
  const candidates: string[] = [];
  for (const pattern of [/“([^”]{2,1000})”/gu, /"([^"\r\n]{2,1000})"/gu]) {
    for (const match of withoutCode.matchAll(pattern)) {
      candidates.push(match[1]);
    }
  }
  let blockquote = "";
  for (const line of withoutCode.split(/\r?\n/gu)) {
    const match = line.match(/^\s*>\s?(.*)$/u);
    if (match) {
      blockquote += `${blockquote ? " " : ""}${match[1]}`;
    } else if (blockquote) {
      candidates.push(blockquote);
      blockquote = "";
    }
  }
  if (blockquote) candidates.push(blockquote);

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/\s*\[\d+\]\s*$/u, "");
    const words = sourceDocQuoteWords(cleaned);
    const key = words.join(" ");
    if (words.length >= 2 && !unique.has(key)) unique.set(key, cleaned);
  }
  return [...unique.values()];
}

export { answerQuoteCandidates as legalSourceQuoteCandidates };

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
  const preferred = preferredA2AJUrl(metadata, true, anchor);
  const baseUrl = preferred ? sourceUrl(preferred, anchor) : null;
  return baseUrl
    ? appendDirectives(baseUrl, [
        textRangeDirective(startTarget, endTarget),
      ])
    : null;
}
