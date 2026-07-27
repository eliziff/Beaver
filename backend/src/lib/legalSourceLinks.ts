import {
  getA2AJLookupDocument,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "./a2aj";
import {
  getCourtlistenerOpinionDocumentText,
  getCourtlistenerOpinionStructure,
} from "./courtlistener";
import {
  createTextSourceDoc,
  sourceDocContainsQuote,
  sourceDocPhraseSpans,
  sourceDocQuoteText,
  sourceDocQuoteWords,
  type SourceDoc,
  type SourceDocQuoteSpan,
} from "./sourceDoc";
import { normalizeWhitespace } from "./text";

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
    /^(?:\[\d+\]|\([A-Za-z0-9ivxlcdm]+\)|\d+[.)])\s*/iu,
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
  if (!lookup.url) return null;
  const baseUrl = sourceUrl(lookup.url, locatorAnchor(lookup, block));
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

  const fetched = documents.filter((document) => {
    if (!document.url || !identityMatches(citation, document)) return false;
    const compiled = createTextSourceDoc(document.text);
    return citation.quotes.every(({ quote }) =>
      sourceDocContainsQuote(compiled, quote),
    );
  });
  const uniqueDocuments = new Map(
    fetched.map((document) => [
      [
        normalizedIdentity(document.url),
        normalizedIdentity(document.citation),
        normalizedIdentity(document.dataset),
      ].join("|"),
      document,
    ]),
  );
  if (uniqueDocuments.size !== 1) return null;
  const document = uniqueDocuments.values().next().value as A2AJDocument;
  return buildLegalSourcePinpointUrl(
    {
      url: document.url!,
      blockText: document.text,
      documentText: document.text,
    },
    citation.quotes.map(({ quote }) => quote),
  );
}

type CourtlistenerOpinionEvidence = {
  opinionId: number | null;
  url: string | null;
  text: string;
  /** The full opinion rendition, compiled once per opinion. */
  document: SourceDoc;
  source: object;
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

function opinionText(value: Record<string, unknown>) {
  // Opinions arrive here already compacted (compactOpinion sets `text` from
  // plain_text ?? stripped html), so the raw html/plain_text branches that
  // used to live here were unreachable.
  return textField(value, "text") ?? "";
}

function courtlistenerOpinions(
  caseRecord: CourtlistenerCaseEvidence,
): CourtlistenerOpinionEvidence[] {
  return (caseRecord.opinions ?? []).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const compactText = opinionText(value);
    if (!compactText) return [];
    const rawId = value.opinionId ?? value.opinion_id ?? value.id;
    const opinionId =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? Math.floor(rawId)
        : null;
    return [
      {
        opinionId,
        url: textField(value, "url"),
        text: compactText,
        document: createTextSourceDoc(
          getCourtlistenerOpinionDocumentText(value) || compactText,
        ),
        source: value,
      },
    ];
  });
}

function courtlistenerNativeAnchor(
  opinion: CourtlistenerOpinionEvidence,
  quote: string,
) {
  const structure = getCourtlistenerOpinionStructure(opinion.source);
  if (!structure) return null;
  const compiled = createTextSourceDoc(structure.text);
  const matches = structure.blocks
    .filter(({ anchor, origin }) => Boolean(anchor) && origin === "native")
    .filter((block) => sourceDocContainsQuote(compiled, quote, block))
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

  const selected = new Set(resolved);
  const blockText = opinions
    .filter((opinion) => selected.has(opinion))
    .map(({ document }) => document.text)
    .join("\n");
  const documentText = opinions.map(({ document }) => document.text).join("\n");
  const anchors = citation.quotes.map((citationQuote, index) =>
    courtlistenerNativeAnchor(resolved[index], citationQuote.quote),
  );
  const anchor =
    anchors.length > 0 &&
    anchors.every((candidate) => candidate && candidate === anchors[0])
      ? anchors[0]!
      : undefined;
  return buildLegalSourcePinpointUrl(
    {
      url: fallbackUrl,
      anchor,
      blockText,
      documentText,
    },
    citation.quotes.map(({ quote }) => quote),
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
  const shared = new Map<string, SourceDoc>();
  const compiled = (source: QuoteSource) => {
    if (typeof source !== "string") return source;
    const existing = shared.get(source);
    if (existing) return existing;
    const doc = createTextSourceDoc(source);
    shared.set(source, doc);
    return doc;
  };
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

function sourceLabel(
  lookup: A2AJLocatorLookup,
  block: A2AJLookupBlock | null = lookup.block,
) {
  const citation = lookup.citation || lookup.name || "A2AJ source";
  const label = block?.label || lookup.requested.label;
  return `${citation}, ${formatLegalLocator(lookup.requested.kind, label)}`.replace(
    /[[\]]/gu,
    "\\$&",
  );
}

export function appendA2AJPinpointLinks(
  answer: string,
  lookups: A2AJLocatorLookup[],
) {
  const uniqueLookups = [
    ...new Map(
      lookups
        .filter((lookup) => lookup.status === "found" && lookup.block)
        .map((lookup) => [lookupKey(lookup), lookup]),
    ).values(),
  ];
  const candidates = answerQuoteCandidates(answer);
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
  const links = selections.flatMap(({ lookup, block, quotes }) => {
    const url = buildA2AJPinpointUrl(lookup, quotes, undefined, block);
    if (!url || answer.includes(url)) return [];
    return [`[${sourceLabel(lookup, block)}](${url.replace(/\)/gu, "%29")})`];
  });
  if (!links.length) return answer;
  return `${answer}${answer ? "\n\n" : ""}Source${links.length === 1 ? "" : "s"}: ${links.join("; ")}`;
}
