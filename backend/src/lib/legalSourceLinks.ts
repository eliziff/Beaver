import {
  getA2AJDocumentSourceDoc,
  getA2AJLookupDocument,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "./a2aj";
import { getCourtlistenerOpinionStructure } from "./courtlistener";
import {
  createTextSourceDoc,
  sourceDocBlockText,
  sourceDocContainsQuote,
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

export type A2AJCitationIdentity = {
  citation: string | null;
  name: string | null;
  dataset: string | null;
  url: string | null;
  quotes: { quote: string }[];
};

type A2AJInlineCitation = {
  type: "citation_data";
  kind: "a2aj";
  ref: number;
  citation: string | null;
  name: string | null;
  dataset: string | null;
  url: string;
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

/**
 * Compile each distinct rendition in one operation exactly once.
 *
 * A DOCX resolve hydrates up to 256 evidence handles off one source version,
 * and an answer can carry a dozen blocks of one decision. Without this each of
 * them tokenizes the same document again; with it the whole operation pays for
 * one token index. Scoped to the operation - it is hoisting, not a cache.
 */
export function sharedSourceDocs() {
  const docs = new Map<string, SourceDoc>();
  return (source: QuoteSource) => {
    if (typeof source !== "string") return source;
    const existing = docs.get(source);
    if (existing) return existing;
    const doc = createTextSourceDoc(source);
    docs.set(source, doc);
    return doc;
  };
}

export type AutomaticLegalSourceLink = {
  key: string;
  label: string;
  evidence: LegalSourceEvidence;
};

export function formatLegalLocator(
  kind: "paragraph" | "section" | "page" | "footnote",
  label: string,
) {
  const value = label
    .trim()
    .replace(
      kind === "paragraph"
        ? /^(?:para?[\s._-]*)/iu
        : kind === "section"
          ? /^(?:s(?:ec(?:tion)?)?[\s._-]*)/iu
          : kind === "page"
            ? /^(?:p(?:age)?[\s=_-]*)/iu
            : /^(?:fn|footnote|note)[\s._-]*/iu,
      "",
    );
  return `${kind === "paragraph" ? "para." : kind === "section" ? "s." : kind === "page" ? "p." : "n."} ${value || label.trim()}`;
}

export type CourtlistenerCitationIdentity = {
  quotes: { opinionId: number | null; quote: string }[];
};

export type CourtlistenerCaseEvidence = {
  url: string | null;
  opinions?: unknown[];
};

type A2AJLookupBlock = NonNullable<A2AJLocatorLookup["block"]>;

const CONTEXT_WINDOWS = [4, 2, 8, 12, 16, 24, 32];
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
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (local && url.origin !== "http://mike.local")
  ) {
    return null;
  }

  const existingAnchor = url.hash.slice(1).split(":~:", 1)[0];
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

  const resolvedAnchor =
    anchor !== undefined ? anchor : convertedCanliiPdf ? "" : existingAnchor;
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
  const span = chooseSourceSpan(block, quote);
  if (!span) return null;
  const target = normalizeWhitespace(block.text.slice(span.start, span.end));
  const targetWords = sourceDocQuoteWords(target);
  if (!targetWords.length) return null;

  const targetCount = directiveMatchCount(document, target);
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
  document: SourceDoc | null = getA2AJLookupDocument(lookup),
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

export function buildLegalSourceMultiPassageUrl(
  url: string,
  passages: {
    key: string;
    blockText: QuoteSource;
    documentText?: QuoteSource;
    pageScoped?: boolean;
    quotes: string[];
  }[],
) {
  const baseUrl = sourceUrl(url);
  if (!baseUrl || !passages.length) return null;

  const uniquePassages = [
    ...new Map(passages.map((passage) => [passage.key, passage])).values(),
  ];
  const directives: string[] = [];
  for (const passage of uniquePassages) {
    const block = asDoc(passage.blockText);
    const document = verificationDoc(passage, block);
    const quotes = [
      ...new Map(
        passage.quotes.map((quote) => [
          sourceDocQuoteWords(quote).join(" "),
          quote,
        ]),
      ).values(),
    ].filter((quote) => sourceDocQuoteWords(quote).length > 0);
    if (!quotes.length) return null;
    const built = quotes
      .map((quote) =>
        buildDirective(block, quote, document, passage.pageScoped === true),
      )
      .sort((left, right) => (left?.start ?? 0) - (right?.start ?? 0));
    if (built.some((directive) => !directive)) return null;
    directives.push(
      ...built
        .filter((directive): directive is NonNullable<typeof directive> =>
          Boolean(directive),
        )
        .map(({ directive }) => directive),
    );
  }
  return appendDirectives(baseUrl, [...new Set(directives)]);
}

function quoteCandidates(blockText: string) {
  const text = normalizeWhitespace(blockText);
  const candidates: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/u)) {
    const words = sentence.split(/\s+/u);
    if (words.length >= 5 && words.length <= 32) candidates.push(sentence);
  }
  const words = text.split(/\s+/u);
  for (const length of [12, 8, 16, 24, 32]) {
    if (words.length < length) continue;
    for (let start = 0; start <= words.length - length; start += 4) {
      candidates.push(words.slice(start, start + length).join(" "));
      if (candidates.length >= 80) break;
    }
    if (candidates.length >= 80) break;
  }
  if (!candidates.length && words.length >= 2) candidates.push(text);
  return [...new Set(candidates)];
}

/**
 * The shortest quote out of `evidence.blockText` that pins to exactly one
 * place in the document, for callers that must produce a verified pinpoint
 * without a model-supplied quote (multi-passage DOCX citations).
 */
export function automaticPinpointQuote(evidence: LegalSourceEvidence) {
  // Up to eighty candidates are tried against the same two artifacts; compile
  // them once, or the whole document is tokenized eighty times over.
  const block = asDoc(evidence.blockText);
  const prepared: LegalSourceEvidence = {
    ...evidence,
    blockText: block,
    documentText: verificationDoc(evidence, block),
  };
  for (const quote of quoteCandidates(block.text)) {
    const url = buildLegalSourcePinpointUrl(prepared, [quote]);
    if (url?.includes(":~:text=")) return quote;
  }
  return null;
}

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function lookupKey(lookup: A2AJLocatorLookup) {
  return [
    normalizedIdentity(lookup.url),
    lookup.requested.kind,
    lookup.block?.label || lookup.requested.label,
  ].join("|");
}

function lookupBlockKey(lookup: A2AJLocatorLookup, block: A2AJLookupBlock) {
  return [
    normalizedIdentity(lookup.url),
    block.kind,
    normalizedIdentity(block.label),
  ].join("|");
}

function lookupBlocks(lookup: A2AJLocatorLookup): A2AJLookupBlock[] {
  const blocks = [
    ...(lookup.block ? [lookup.block] : []),
    ...lookup.before,
    ...lookup.after,
  ];
  return [
    ...new Map(
      blocks.map((block) => [lookupBlockKey(lookup, block), block]),
    ).values(),
  ];
}

/** A quote is "in" a passage when it selects exactly one span of it. */
function quoteMatchesBlock(block: SourceDoc, quote: string) {
  return Boolean(chooseSourceSpan(block, quote));
}

function blockMatchingQuotes(lookup: A2AJLocatorLookup, quotes: string[]) {
  const matches = lookupBlocks(lookup).filter((block) => {
    const compiled = createTextSourceDoc(block.text);
    return quotes.every((quote) => quoteMatchesBlock(compiled, quote));
  });
  return matches.length === 1 ? matches[0] : null;
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

export function buildA2AJCitationPinpointUrl(
  citation: A2AJCitationIdentity,
  lookups: A2AJLocatorLookup[],
  documents: A2AJDocument[] = [],
) {
  const candidates = lookups.filter(
    (lookup) =>
      lookup.status === "found" &&
      lookup.block &&
      lookup.url &&
      identityMatches(citation, lookup),
  );
  const quotes = citation.quotes.map(({ quote }) => quote);
  const resolved = candidates.flatMap((lookup) => {
    const block = quotes.length
      ? blockMatchingQuotes(lookup, quotes)
      : lookup.block;
    return block ? [{ lookup, block }] : [];
  });
  const unique = new Map(
    resolved.map((candidate) => [
      lookupBlockKey(candidate.lookup, candidate.block),
      candidate,
    ]),
  );
  if (unique.size === 1) {
    const { lookup, block } = unique.values().next().value as {
      lookup: A2AJLocatorLookup;
      block: A2AJLookupBlock;
    };
    return buildA2AJPinpointUrl(lookup, quotes, undefined, block);
  }

  const fetched = documents.flatMap((document) => {
    if (!document.url || !identityMatches(citation, document)) return [];
    const source = getA2AJDocumentSourceDoc(document);
    const spans = citation.quotes.map(({ quote }) =>
      chooseSourceSpan(source, quote),
    );
    return spans.every((span) => span !== null)
      ? [{ document, source, spans }]
      : [];
  });
  const uniqueDocuments = new Map(
    fetched.map((candidate) => [
      [
        normalizedIdentity(candidate.document.url),
        normalizedIdentity(candidate.document.citation),
        normalizedIdentity(candidate.document.dataset),
      ].join("|"),
      candidate,
    ]),
  );
  if (uniqueDocuments.size !== 1) return null;
  const { document, source, spans } = uniqueDocuments.values().next().value as {
    document: A2AJDocument;
    source: SourceDoc;
    spans: Array<SourceDocQuoteSpan | null>;
  };
  const paragraphMatches = source.blocks.filter(
    (block) =>
      block.kind === "paragraph" &&
      spans.every(
        (span) =>
          span && block.start <= span.start && block.end >= span.end,
      ),
  );
  const paragraph =
    paragraphMatches.length === 1 ? paragraphMatches[0] : undefined;
  const anchor = paragraph?.label.match(/^par\d+$/iu)?.[0];
  const preferredUrl = preferredA2AJUrl(
    document,
    citation.quotes.length > 0,
    anchor,
  );
  if (!preferredUrl) return null;
  return buildLegalSourcePinpointUrl(
    {
      url: preferredUrl,
      anchor,
      blockText: paragraph
        ? sourceDocBlockText(source, paragraph)
        : source,
      documentText: source,
    },
    citation.quotes.map(({ quote }) => quote),
  );
}

type CourtlistenerOpinionEvidence = {
  opinionId: number | null;
  url: string | null;
  document: SourceDoc;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function courtlistenerOpinions(
  caseRecord: CourtlistenerCaseEvidence,
): CourtlistenerOpinionEvidence[] {
  return (caseRecord.opinions ?? []).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const document = getCourtlistenerOpinionStructure(value);
    if (!document) return [];
    const rawId = value.opinionId ?? value.opinion_id ?? value.id;
    const opinionId =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? Math.floor(rawId)
        : null;
    return [
      {
        opinionId,
        url: textField(value, "url"),
        document,
      },
    ];
  });
}

function courtlistenerNativeAnchor(
  opinion: CourtlistenerOpinionEvidence,
  quote: string,
) {
  const structure = opinion.document;
  const matches = structure.blocks
    .filter(({ anchor, origin }) => Boolean(anchor) && origin === "native")
    .filter((block) => sourceDocContainsQuote(structure, quote, block))
    .sort((left, right) => left.end - left.start - (right.end - right.start));
  if (!matches.length) return null;
  const smallest = matches[0].end - matches[0].start;
  const anchors = new Set(
    matches
      .filter((block) => block.end - block.start === smallest)
      .map(({ anchor }) => anchor!),
  );
  return anchors.size === 1 ? anchors.values().next().value! : null;
}

export function buildCourtlistenerCitationPinpointUrl(
  citation: CourtlistenerCitationIdentity,
  caseRecord?: CourtlistenerCaseEvidence,
) {
  if (!caseRecord) return null;
  const opinions = courtlistenerOpinions(caseRecord);
  const fallbackUrl =
    caseRecord.url ?? opinions.find(({ url }) => Boolean(url))?.url ?? null;
  if (!fallbackUrl) return null;

  const resolved: CourtlistenerOpinionEvidence[] = [];
  for (const citationQuote of citation.quotes) {
    const candidates =
      citationQuote.opinionId === null
        ? opinions
        : opinions.filter(
            ({ opinionId }) => opinionId === citationQuote.opinionId,
          );
    const matching = candidates.filter(({ document }) =>
      sourceDocContainsQuote(document, citationQuote.quote),
    );
    if (matching.length !== 1) return sourceUrl(fallbackUrl);
    resolved.push(matching[0]);
  }
  if (!resolved.length) return sourceUrl(fallbackUrl);

  const passages = new Map<CourtlistenerOpinionEvidence, string[]>();
  resolved.forEach((opinion, index) =>
    passages.set(opinion, [
      ...(passages.get(opinion) ?? []),
      citation.quotes[index].quote,
    ]),
  );
  if (passages.size === 1) {
    const [opinion, quotes] = passages.entries().next().value as [
      CourtlistenerOpinionEvidence,
      string[],
    ];
    const anchors = quotes.map((quote) =>
      courtlistenerNativeAnchor(opinion, quote),
    );
    const anchor =
      anchors.every((candidate) => candidate && candidate === anchors[0])
        ? anchors[0]!
        : undefined;
    return buildLegalSourcePinpointUrl(
      {
        url: fallbackUrl,
        anchor,
        blockText: opinion.document,
        documentText: opinion.document,
      },
      quotes,
    );
  }
  return (
    buildLegalSourceMultiPassageUrl(
      fallbackUrl,
      [...passages].map(([opinion, quotes], index) => ({
        key: `${opinion.opinionId ?? "opinion"}:${index}`,
        blockText: opinion.document,
        documentText: opinion.document,
        quotes,
      })),
    ) ?? sourceUrl(fallbackUrl)
  );
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

const ANSWER_CASE_PARAGRAPH =
  /\b(((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9-]{1,15})\s+(\d+))\b\s*,?\s*(?:at\s+)?para(?:graph)?s?\.?\s*((\d{1,5})(?:\s*[-\u2013\u2014]\s*\d{1,5})?)\b/giu;

function answerCaseParagraphs(answer: string) {
  const found: Array<{
    citation: string;
    dataset: string;
    locator: string;
    endLocator: string;
    url: string;
    start: number;
    end: number;
    at: number;
  }> = [];
  for (const match of answer.matchAll(ANSWER_CASE_PARAGRAPH)) {
    const citation = match[1].replace(/\s+/gu, " ");
    const dataset = match[3].toUpperCase();
    const locator = String(Number(match[6]));
    const endLocator = String(
      Number(match[5].match(/\d+/gu)?.at(-1) ?? locator),
    );
    const url = buildCanliiCaseUrl({
      dataset,
      citations: [citation],
      language: "en",
    });
    if (!url) continue;
    found.push({
      citation,
      dataset,
      locator,
      endLocator,
      url: `${url}#par${locator}`,
      start: match.index,
      end: match.index + match[0].length,
      at: match.index + match[0].length,
    });
  }
  return found;
}

function paragraphLookupKey(
  citation: string | null | undefined,
  locator: string,
) {
  return `${normalizedIdentity(citation)}|${Number(locator.match(/\d+/u)?.[0])}`;
}

function stripModelCanadianDecisionUrls(answer: string) {
  const strip = (rawUrl: string) => {
    try {
      return isCanadianDecisionUrl(new URL(rawUrl)) ? "" : rawUrl;
    } catch {
      return rawUrl;
    }
  };
  return answer
    .replace(
      /\[([^\]\r\n]+)\]\(([^)\r\n]*)\)/gu,
      (full, label: string, url: string) =>
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
}

function uniqueTextEnd(answer: string, text: string) {
  const start = answer.indexOf(text);
  if (start < 0 || answer.indexOf(text, start + 1) >= 0) return null;
  let end = start + text.length;
  if (answer[end] === '"' || answer[end] === "”") end += 1;
  return end;
}

function uniqueTextRange(answer: string, text: string) {
  const start = answer.indexOf(text);
  if (start < 0 || answer.indexOf(text, start + 1) >= 0) return null;
  return { start, end: start + text.length };
}

function quoteEvidence(
  quote: string,
  lookups: A2AJLocatorLookup[],
  documents: A2AJDocument[],
) {
  const matchingLookups = new Map(
    lookups.flatMap((lookup) =>
      lookup.status === "found"
        ? lookupBlocks(lookup).flatMap((block) =>
            quoteMatchesBlock(createTextSourceDoc(block.text), quote)
              ? [[lookupBlockKey(lookup, block), { lookup, block }] as const]
              : [],
          )
        : [],
    ),
  );
  if (matchingLookups.size === 1) {
    const { lookup, block } = matchingLookups.values().next().value as {
      lookup: A2AJLocatorLookup;
      block: A2AJLookupBlock;
    };
    return {
      key: lookupBlockKey(lookup, block),
      citation: lookup.citation,
      dataset: lookup.dataset,
      locator:
        block.kind === "paragraph"
          ? block.label.match(/\d+/u)?.[0] ?? null
          : null,
    };
  }

  const matchingDocuments = new Map(
    documents.flatMap((document) => {
      if (!document.url) return [];
      const source = getA2AJDocumentSourceDoc(document);
      const span = chooseSourceSpan(source, quote);
      if (!span) return [];
      const paragraphs = source.blocks.filter(
        (block) =>
          block.kind === "paragraph" &&
          block.start <= span.start &&
          block.end >= span.end,
      );
      if (paragraphs.length !== 1) return [];
      const paragraph = paragraphs[0];
      const key = [
        normalizedIdentity(document.url),
        normalizedIdentity(document.citation),
        paragraph.label,
      ].join("|");
      return [
        [
          key,
          {
            key,
            citation: document.citation,
            dataset: document.dataset,
            locator: paragraph.label.match(/\d+/u)?.[0] ?? null,
          },
        ] as const,
      ];
    }),
  );
  return matchingDocuments.size === 1
    ? matchingDocuments.values().next().value
    : null;
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
    const source = getA2AJLookupDocument(lookup);
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
      const source = getA2AJDocumentSourceDoc(document);
      sources.set(source.id, { source, metadata: document });
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
  if (candidates.length !== 1) return null;
  const { source, metadata, startBlock, endBlock } = candidates[0];
  const startTarget = uniqueParagraphEdge(
    sourceDocBlockText(source, startBlock),
    source,
    "start",
  );
  const endTarget = uniqueParagraphEdge(
    sourceDocBlockText(source, endBlock),
    source,
    "end",
  );
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

export function hasLegalSourceQuoteCandidates(answer: string) {
  return answerQuoteCandidates(answer).length > 0;
}

export function appendLegalSourcePinpointLinks(
  answer: string,
  sources: AutomaticLegalSourceLink[],
  existingUrls: string[] = [],
) {
  // Blocks of one document share that document's artifact, so its token index
  // is built once for the whole answer rather than once per source.
  const compiled = sharedSourceDocs();
  const uniqueSources = [
    ...new Map(sources.map((source) => [source.key, source])).values(),
  ].map((source) => {
    const block = compiled(source.evidence.blockText);
    return {
      ...source,
      block,
      evidence: {
        ...source.evidence,
        blockText: block,
        documentText: source.evidence.documentText
          ? compiled(source.evidence.documentText)
          : undefined,
      },
    };
  });
  const assigned = new Map<
    string,
    { source: AutomaticLegalSourceLink; quotes: string[] }
  >();
  for (const quote of answerQuoteCandidates(answer)) {
    const matches = uniqueSources.filter(({ block }) =>
      quoteMatchesBlock(block, quote),
    );
    if (matches.length !== 1) continue;
    const source = matches[0];
    assigned.set(source.key, {
      source,
      quotes: [...(assigned.get(source.key)?.quotes ?? []), quote],
    });
  }

  const links = [...assigned.values()].flatMap(({ source, quotes }) => {
    const url = buildLegalSourcePinpointUrl(source.evidence, quotes);
    const markdownUrl = url?.replace(/\)/gu, "%29");
    if (
      !url ||
      !markdownUrl ||
      answer.includes(url) ||
      answer.includes(markdownUrl) ||
      existingUrls.includes(url)
    ) {
      return [];
    }
    return [`[${source.label.replace(/[[\]]/gu, "\\$&")}](${markdownUrl})`];
  });
  if (!links.length) return answer;
  return `${answer}${answer ? "\n\n" : ""}Source${links.length === 1 ? "" : "s"}: ${links.join("; ")}`;
}

export function addA2AJInlineCitations(
  answer: string,
  lookups: A2AJLocatorLookup[],
  existingCitations: unknown[] = [],
) {
  const cleanAnswer = stripModelCanadianDecisionUrls(answer);
  const answerParagraphs = answerCaseParagraphs(cleanAnswer);
  const answerParagraphByKey = new Map(
    answerParagraphs.map((source) => [
      paragraphLookupKey(source.citation, source.locator),
      source,
    ]),
  );
  const uniqueLookups = [
    ...new Map(
      lookups
        .filter((lookup) => lookup.status === "found" && lookup.block)
        .map((lookup) => [lookupKey(lookup), lookup]),
    ).values(),
  ];
  const candidates = answerQuoteCandidates(cleanAnswer);
  const blockSelections = new Map<
    string,
    {
      lookup: A2AJLocatorLookup;
      block: A2AJLookupBlock;
      compiled: SourceDoc;
    }
  >();
  for (const lookup of uniqueLookups) {
    for (const block of lookupBlocks(lookup)) {
      blockSelections.set(lookupBlockKey(lookup, block), {
        lookup,
        block,
        compiled: createTextSourceDoc(block.text),
      });
    }
  }
  const assigned = new Map<
    string,
    { lookup: A2AJLocatorLookup; block: A2AJLookupBlock; quotes: string[] }
  >();
  for (const quote of candidates) {
    const matches = [...blockSelections.entries()].filter(([, { compiled }]) =>
      quoteMatchesBlock(compiled, quote),
    );
    if (matches.length === 1) {
      const [key, selection] = matches[0];
      assigned.set(key, {
        ...selection,
        quotes: [...(assigned.get(key)?.quotes ?? []), quote],
      });
    }
  }

  const assignedLookups = new Set(
    [...assigned.values()].map(({ lookup }) => lookupKey(lookup)),
  );
  const selections = [
    ...assigned.values(),
    ...uniqueLookups.flatMap((lookup) =>
      assignedLookups.has(lookupKey(lookup)) || !lookup.block
        ? []
        : [{ lookup, block: lookup.block, quotes: [] }],
    ),
  ];
  const builtLinks = selections.flatMap(({ lookup, block, quotes }) => {
    const url = buildA2AJPinpointUrl(lookup, quotes, undefined, block);
    return url ? [{ lookup, url, quotes }] : [];
  });
  const existingByUrl = new Map(
    existingCitations.flatMap((citation) => {
      const row = citation as { ref?: unknown; url?: unknown } | null;
      return typeof row?.ref === "number" && typeof row.url === "string"
        ? [[row.url, row.ref] as const]
        : [];
    }),
  );
  const existingByRef = new Map(
    existingCitations.flatMap((citation) => {
      const row = citation as { ref?: unknown } | null;
      return typeof row?.ref === "number"
        ? [[row.ref, citation] as const]
        : [];
    }),
  );
  let nextRef =
    Math.max(
      0,
      ...existingCitations.flatMap((citation) => {
        const ref = (citation as { ref?: unknown } | null)?.ref;
        return typeof ref === "number" ? [ref] : [];
      }),
    ) + 1;
  const claimedRefs = new Set(
    existingCitations.flatMap((citation) => {
      const ref = (citation as { ref?: unknown } | null)?.ref;
      return typeof ref === "number" ? [ref] : [];
    }),
  );
  const modelMarkerRefs = new Set(
    [...cleanAnswer.matchAll(/\[(\d+)\]/gu)].map((match) =>
      Number(match[1]),
    ),
  );
  const claimFreshRef = () => {
    while (claimedRefs.has(nextRef) || modelMarkerRefs.has(nextRef)) {
      nextRef += 1;
    }
    const ref = nextRef++;
    claimedRefs.add(ref);
    return ref;
  };
  const citationCounts = new Map<string, number>();
  for (const { lookup } of builtLinks) {
    const key = normalizedIdentity(lookup.citation);
    citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1);
  }

  const insertions: Array<{ at: number; marker: string }> = [];
  const citations: A2AJInlineCitation[] = [];
  const supersededRefs = new Set<number>();
  const occupied = new Set<number>();
  const representedParagraphs = new Set(
    builtLinks.flatMap(({ lookup }) =>
      lookup.requested.kind === "paragraph"
        ? [
            paragraphLookupKey(lookup.citation, lookup.requested.locator),
            paragraphLookupKey(
              lookup.alternateCitation,
              lookup.requested.locator,
            ),
          ]
        : [],
    ),
  );
  for (const { lookup, url, quotes } of builtLinks) {
    const paragraphMention =
      lookup.requested.kind === "paragraph"
        ? answerParagraphByKey.get(
            paragraphLookupKey(lookup.citation, lookup.requested.locator),
          )
        : undefined;
    const at =
      (quotes[0] ? uniqueTextEnd(cleanAnswer, quotes[0]) : null) ??
      paragraphMention?.at ??
      ((citationCounts.get(normalizedIdentity(lookup.citation)) ?? 0) === 1
        ? uniqueTextEnd(cleanAnswer, lookup.citation)
        : null);
    if (at === null || occupied.has(at)) continue;

    const existingRef = existingByUrl.get(url);
    const adjacentMarker = cleanAnswer
      .slice(at)
      .match(/^\s*\[(\d+)\]/u);
    const adjacentRef = adjacentMarker
      ? Number(adjacentMarker[1])
      : undefined;
    const adjacentCitation = existingByRef.get(adjacentRef!);
    const adjacentRow = adjacentCitation as {
      kind?: unknown;
      citation?: unknown;
    } | null;
    const replaceableAdjacentRef =
      existingRef === undefined &&
      Number.isSafeInteger(adjacentRef) &&
      adjacentRow?.kind === "a2aj" &&
      typeof adjacentRow.citation === "string" &&
      [lookup.citation, lookup.alternateCitation].some(
        (citation) =>
          citation &&
          normalizedIdentity(citation) ===
            normalizedIdentity(adjacentRow.citation as string),
      )
        ? adjacentRef
        : undefined;
    const reusableAdjacentRef =
      existingRef === undefined &&
      Number.isSafeInteger(adjacentRef) &&
      (!claimedRefs.has(adjacentRef!) ||
        replaceableAdjacentRef !== undefined)
        ? adjacentRef
        : undefined;
    const ref = existingRef ?? reusableAdjacentRef ?? claimFreshRef();
    const markerAlreadyAtTarget = adjacentRef === ref;
    if (!markerAlreadyAtTarget) {
      insertions.push({ at, marker: `[${ref}]` });
    }
    occupied.add(at);
    if (existingRef === undefined) {
      if (replaceableAdjacentRef !== undefined) {
        supersededRefs.add(replaceableAdjacentRef);
      }
      claimedRefs.add(ref);
      citations.push({
        type: "citation_data",
        kind: "a2aj",
        ref,
        citation: lookup.citation,
        name: lookup.name,
        dataset: lookup.dataset,
        url,
        quotes: quotes.map((quote) => ({ quote })),
      });
    }
  }
  for (const source of answerParagraphs) {
    if (
      representedParagraphs.has(
        paragraphLookupKey(source.citation, source.locator),
      ) ||
      occupied.has(source.at)
    ) {
      continue;
    }
    const existingRef = existingByUrl.get(source.url);
    const ref = existingRef ?? nextRef++;
    if (cleanAnswer.includes(`[${ref}]`)) continue;
    occupied.add(source.at);
    insertions.push({ at: source.at, marker: `[${ref}]` });
    if (existingRef === undefined) {
      citations.push({
        type: "citation_data",
        kind: "a2aj",
        ref,
        citation: source.citation,
        name: null,
        dataset: source.dataset,
        url: source.url,
        quotes: [],
      });
    }
  }

  const text = insertions
    .sort((left, right) => right.at - left.at)
    .reduce(
      (current, { at, marker }) =>
        `${current.slice(0, at)}${marker}${current.slice(at)}`,
      cleanAnswer,
    );
  return {
    text,
    citations: [
      ...existingCitations.filter((citation) => {
        const ref = (citation as { ref?: unknown } | null)?.ref;
        return typeof ref !== "number" || !supersededRefs.has(ref);
      }),
      ...citations,
    ],
  };
}

function isA2AJInlineCitation(value: unknown): value is A2AJInlineCitation {
  const row = value as Partial<A2AJInlineCitation> | null;
  return (
    row?.kind === "a2aj" &&
    typeof row.ref === "number" &&
    typeof row.url === "string"
  );
}

function markdownLink(label: string, url: string) {
  const escapedLabel = label.replace(/[\\[\]]/gu, "\\$&");
  return `[${escapedLabel}](${url.replace(/\)/gu, "%29")})`;
}

/**
 * Default chat presentation. Keep quotations readable and put each verified
 * external pinpoint, including same-paragraph highlights, on its citation.
 * The footnote conversion above remains an opt-in feature.
 */
export function addA2AJInlineLinks(
  answer: string,
  lookups: A2AJLocatorLookup[],
  existingCitations: unknown[] = [],
  documents: A2AJDocument[] = [],
) {
  const oldA2AJCitations = existingCitations.filter(isA2AJInlineCitation);
  const backedRefs = new Set(
    existingCitations.flatMap((citation) => {
      const ref = (citation as { ref?: unknown } | null)?.ref;
      return typeof ref === "number" ? [ref] : [];
    }),
  );
  let text = oldA2AJCitations
    .reduce(
      (current, source) =>
        current.replace(new RegExp(`\\[${source.ref}\\]`, "gu"), ""),
      stripModelCanadianDecisionUrls(answer),
    );
  for (const paragraph of answerCaseParagraphs(text).reverse()) {
    const marker = text
      .slice(paragraph.end)
      .match(/^[ \t]+\[(\d+)\](?=[ \t]*[:;,.!?]|[ \t]*$)/u);
    if (marker && !backedRefs.has(Number(marker[1]))) {
      text =
        text.slice(0, paragraph.end) +
        text.slice(paragraph.end + marker[0].length);
    }
  }
  text = text
    .replace(/[ \t]+(?=[,.;:!?])/gu, "")
    .replace(/[ \t]+$/gmu, "");
  const ranges: Array<{
    start: number;
    end: number;
    label: string;
    url: string;
  }> = [];
  const overlaps = (start: number, end: number) =>
    ranges.some((range) => start < range.end && end > range.start);

  type QuoteGroup = {
    citation: string | null;
    dataset: string | null;
    locator: string | null;
    quotes: string[];
    start: number;
    end: number;
    url?: string;
  };
  const quoteGroups = new Map<string, QuoteGroup>();
  for (const quote of answerQuoteCandidates(text)) {
    const range = uniqueTextRange(text, quote);
    if (!range) continue;
    const evidence = quoteEvidence(quote, lookups, documents);
    if (!evidence) continue;
    const existing = quoteGroups.get(evidence.key);
    if (existing) {
      existing.quotes.push(quote);
      existing.start = Math.min(existing.start, range.start);
      existing.end = Math.max(existing.end, range.end);
    } else {
      quoteGroups.set(evidence.key, {
        citation: evidence.citation,
        dataset: evidence.dataset,
        locator: evidence.locator,
        quotes: [quote],
        ...range,
      });
    }
  }
  for (const group of quoteGroups.values()) {
    group.url =
      buildA2AJCitationPinpointUrl(
        {
          citation: group.citation,
          name: null,
          dataset: group.dataset,
          url: null,
          quotes: group.quotes.map((quote) => ({ quote })),
        },
        lookups,
        documents,
      ) ?? undefined;
  }
  const claimedQuoteGroups = new Set<string>();
  const nearestQuoteGroup = (
    citation: string,
    start: number,
    end: number,
    locator?: string,
  ) => {
    let nearest:
      | {
          key: string;
          group: QuoteGroup;
          distance: number;
        }
      | undefined;
    for (const [key, group] of quoteGroups) {
      if (
        claimedQuoteGroups.has(key) ||
        !group.url ||
        normalizedIdentity(group.citation) !== normalizedIdentity(citation) ||
        (locator !== undefined &&
          Number(group.locator) !== Number(locator))
      ) {
        continue;
      }
      const distance =
        group.end < start
          ? start - group.end
          : end < group.start
            ? group.start - end
            : 0;
      if (!nearest || distance < nearest.distance) {
        nearest = { key, group, distance };
      }
    }
    if (nearest) claimedQuoteGroups.add(nearest.key);
    return nearest?.group;
  };

  for (const paragraph of answerCaseParagraphs(text)) {
    if (overlaps(paragraph.start, paragraph.end)) continue;
    const rangeUrl =
      Number(paragraph.endLocator) > Number(paragraph.locator)
        ? buildA2AJParagraphRangeUrl(
            paragraph.citation,
            paragraph.locator,
            paragraph.endLocator,
            lookups,
            documents,
          )
        : null;
    const group = rangeUrl
      ? undefined
      : nearestQuoteGroup(
          paragraph.citation,
          paragraph.start,
          paragraph.end,
          paragraph.locator,
        );
    ranges.push({
      start: paragraph.start,
      end: paragraph.end,
      label: text.slice(paragraph.start, paragraph.end),
      url: rangeUrl ?? group?.url ?? paragraph.url,
    });
  }

  for (const citation of answerCaseCitations(text)) {
    if (overlaps(citation.start, citation.end)) continue;
    const group = nearestQuoteGroup(
      citation.citation,
      citation.start,
      citation.end,
    );
    ranges.push({
      ...citation,
      url: group?.url ?? citation.url,
    });
  }

  return {
    text: ranges
      .sort((left, right) => right.start - left.start)
      .reduce(
        (current, range) =>
          `${current.slice(0, range.start)}${markdownLink(
            range.label,
            range.url,
          )}${current.slice(range.end)}`,
        text,
      ),
    citations: existingCitations.filter(
      (citation) => !isA2AJInlineCitation(citation),
    ),
  };
}

export function a2ajInlineLinkSnapshot(
  answer: string,
  lookups: A2AJLocatorLookup[],
  documents: A2AJDocument[],
  previousInputSignature: string,
) {
  const inputSignature = [
    ...answerCaseCitations(answer).map(
      (citation) => `${citation.start}:${citation.label}`,
    ),
    ...answerQuoteCandidates(answer).map((quote) => `quote:${quote}`),
  ].join("\n");
  if (!inputSignature || inputSignature === previousInputSignature) return null;
  const linked = addA2AJInlineLinks(answer, lookups, [], documents).text;
  if (linked === answer) return null;
  return { text: linked, signature: inputSignature };
}
