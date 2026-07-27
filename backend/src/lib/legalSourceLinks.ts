import {
  getA2AJLookupDocumentText,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "./a2aj";
import {
  getCourtlistenerOpinionDocumentText,
  getCourtlistenerOpinionStructure,
} from "./courtlistener";
import { normalizeWhitespace } from "./text";

type WordSpan = { word: string; start: number; end: number };
type SourceSpan = {
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
};

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
  blockText: string;
  documentText?: string;
  pageScoped?: boolean;
};

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
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
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

function wordSpans(text: string): WordSpan[] {
  return [...text.matchAll(WORD_RE)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function quoteWords(text: string) {
  return wordSpans(quoteText(text)).map(({ word }) => word);
}

function phraseSpans(source: string, words: string[]): SourceSpan[] {
  if (!source || !words.length) return [];
  const sourceWords = wordSpans(source);
  const spans: SourceSpan[] = [];
  for (let index = 0; index <= sourceWords.length - words.length; index += 1) {
    if (
      words.every(
        (word, offset) =>
          sourceWords[index + offset].word === word.toLowerCase(),
      )
    ) {
      spans.push({
        start: sourceWords[index].start,
        end: sourceWords[index + words.length - 1].end,
        firstWord: index,
        lastWord: index + words.length - 1,
      });
    }
  }
  return spans;
}

function extendTerminalPunctuation(source: string, end: number, quote: string) {
  const comma = quote.trim().endsWith(",") ? "," : "";
  const match = source
    .slice(end)
    .match(new RegExp(`^[${comma}.!?;:…'’”»\\)\\]]+`, "u"));
  return end + (match?.[0].length ?? 0);
}

function chooseSourceSpan(source: string, quote: string): SourceSpan | null {
  const words = quoteWords(quote);
  const spans = phraseSpans(source, words).map((span) => ({
    ...span,
    end: extendTerminalPunctuation(source, span.end, quote),
  }));
  if (spans.length === 1) return spans[0];
  if (!spans.length) return null;

  const normalizedQuote = normalizeWhitespace(
    quote.trim().replace(/^["'“”]+|["'“”]+$/gu, ""),
  );
  const exact = spans.filter(
    (span) =>
      normalizeWhitespace(source.slice(span.start, span.end)) ===
      normalizedQuote,
  );
  if (exact.length === 1) return exact[0];
  const folded = spans.filter(
    (span) =>
      normalizeWhitespace(source.slice(span.start, span.end)).toLowerCase() ===
      normalizedQuote.toLowerCase(),
  );
  return folded.length === 1 ? folded[0] : null;
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
    // serves the document inline. site_preference=mobile is deliberately NOT
    // set: it is unnecessary and pins a persistent layout cookie.
    url.searchParams.delete("iframe");
    url.searchParams.delete("site_preference");
    url.searchParams.set("iframe", "true");
  }

  const resolvedAnchor =
    anchor !== undefined ? anchor : convertedCanliiPdf ? "" : existingAnchor;
  url.hash = resolvedAnchor ? `#${resolvedAnchor}` : "";
  return local ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

function wordsEqual(
  sourceWords: WordSpan[],
  start: number,
  expected: string[],
) {
  return expected.every(
    (word, offset) => sourceWords[start + offset]?.word === word,
  );
}

function directiveMatchCount(
  documentText: string,
  target: string,
  prefix = "",
  suffix = "",
) {
  const targetWords = quoteWords(target);
  const prefixWords = quoteWords(prefix);
  const suffixWords = quoteWords(suffix);
  let count = 0;
  for (const line of documentText.split(/\r?\n/gu)) {
    const words = wordSpans(line);
    for (
      let index = 0;
      index <= words.length - targetWords.length;
      index += 1
    ) {
      if (!wordsEqual(words, index, targetWords)) continue;
      if (
        prefixWords.length &&
        (index < prefixWords.length ||
          !wordsEqual(words, index - prefixWords.length, prefixWords))
      ) {
        continue;
      }
      const suffixStart = index + targetWords.length;
      if (suffixWords.length && !wordsEqual(words, suffixStart, suffixWords)) {
        continue;
      }
      count += 1;
      if (count > 1) return count;
    }
  }
  return count;
}

function contextFor(
  source: string,
  span: SourceSpan,
  window: number,
): { prefix: string; suffix: string } {
  const words = wordSpans(source);
  const firstPrefixWord = Math.max(0, span.firstWord - window);
  const lastSuffixWord = Math.min(words.length - 1, span.lastWord + window);
  let prefix =
    span.firstWord > firstPrefixWord
      ? normalizeWhitespace(
          source.slice(words[firstPrefixWord].start, span.start),
        )
      : "";
  const suffix =
    lastSuffixWord > span.lastWord
      ? normalizeWhitespace(source.slice(span.end, words[lastSuffixWord].end))
      : "";
  prefix = prefix.replace(
    /^(?:\[\d+\]|\([A-Za-z0-9ivxlcdm]+\)|\d+[.)])\s*/iu,
    "",
  );
  return { prefix, suffix };
}

function buildDirective(
  blockText: string,
  quote: string,
  documentText: string,
  pageScoped: boolean,
) {
  const span = chooseSourceSpan(blockText, quote);
  if (!span) return null;
  const target = normalizeWhitespace(blockText.slice(span.start, span.end));
  const targetWords = quoteWords(target);
  if (!targetWords.length) return null;

  const targetCount = directiveMatchCount(documentText, target);
  const needsContext =
    targetWords.length <= 3 ||
    targetCount !== 1 ||
    (pageScoped && targetWords.length <= 8);
  if (!needsContext && targetCount === 1) {
    return { directive: textDirective(target), start: span.start };
  }

  for (const window of CONTEXT_WINDOWS) {
    const { prefix, suffix } = contextFor(blockText, span, window);
    const options: Array<[string, string]> = [
      [prefix, ""],
      ["", suffix],
      [prefix, suffix],
    ];
    for (const [candidatePrefix, candidateSuffix] of options) {
      if (!candidatePrefix && !candidateSuffix) continue;
      if (
        directiveMatchCount(
          documentText,
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
  documentText = getA2AJLookupDocumentText(lookup),
  block: A2AJLookupBlock | null = lookup.block,
) {
  if (!lookup.url) return null;
  const baseUrl = sourceUrl(lookup.url, locatorAnchor(lookup, block));
  if (!baseUrl) return null;
  return buildLegalSourcePinpointUrl(
    {
      url: baseUrl,
      blockText: lookup.status === "found" && block ? block.text : "",
      documentText,
      pageScoped: lookup.requested.kind === "page",
    },
    quotes,
  );
}

export function buildLegalSourcePinpointUrl(
  evidence: LegalSourceEvidence,
  quotes: string[],
) {
  const baseUrl = sourceUrl(evidence.url, evidence.anchor);
  if (!baseUrl || !evidence.blockText) return baseUrl;
  const uniqueQuotes = new Map<string, string>();
  for (const quote of quotes) {
    const key = quoteWords(quote).join(" ");
    if (key && !uniqueQuotes.has(key)) uniqueQuotes.set(key, quote);
  }
  if (!uniqueQuotes.size) return baseUrl;

  const verificationText = evidence.documentText?.trim()
    ? evidence.documentText
    : evidence.blockText;
  const built = [...uniqueQuotes.values()].map((quote) =>
    buildDirective(
      evidence.blockText,
      quote,
      verificationText,
      evidence.pageScoped === true,
    ),
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
    blockText: string;
    documentText?: string;
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
    const verificationText = passage.documentText?.trim()
      ? passage.documentText
      : passage.blockText;
    const quotes = [
      ...new Map(
        passage.quotes.map((quote) => [quoteWords(quote).join(" "), quote]),
      ).values(),
    ].filter((quote) => quoteWords(quote).length > 0);
    if (!quotes.length) return null;
    const built = quotes
      .map((quote) =>
        buildDirective(
          passage.blockText,
          quote,
          verificationText,
          passage.pageScoped === true,
        ),
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

function blockMatchesQuote(quote: string, block: A2AJLookupBlock) {
  return blockTextMatchesQuote(quote, block.text);
}

function blockTextMatchesQuote(quote: string, blockText: string) {
  return Boolean(chooseSourceSpan(blockText, quote));
}

function blockMatchingQuotes(lookup: A2AJLocatorLookup, quotes: string[]) {
  const matches = lookupBlocks(lookup).filter((block) =>
    quotes.every((quote) => blockMatchesQuote(quote, block)),
  );
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

  const fetched = documents.filter(
    (document) =>
      document.url &&
      identityMatches(citation, document) &&
      citation.quotes.every(({ quote }) => containsQuote(document.text, quote)),
  );
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
  documentText: string;
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
        documentText: getCourtlistenerOpinionDocumentText(value) || compactText,
        source: value,
      },
    ];
  });
}

function containsQuote(source: string, quote: string) {
  return phraseSpans(source, quoteWords(quote)).length > 0;
}

function courtlistenerNativeAnchor(
  opinion: CourtlistenerOpinionEvidence,
  quote: string,
) {
  const structure = getCourtlistenerOpinionStructure(opinion.source);
  if (!structure) return null;
  const matches = structure.blocks
    .filter(({ anchor, origin }) => Boolean(anchor) && origin === "native")
    .filter((block) =>
      containsQuote(structure.text.slice(block.start, block.end), quote),
    )
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
    const matching = candidates.filter(({ documentText }) =>
      containsQuote(documentText, citationQuote.quote),
    );
    if (matching.length !== 1) return sourceUrl(fallbackUrl);
    resolved.push(matching[0]);
  }
  if (!resolved.length) return sourceUrl(fallbackUrl);

  const selected = new Set(resolved);
  const blockText = opinions
    .filter((opinion) => selected.has(opinion))
    .map(({ documentText }) => documentText)
    .join("\n");
  const documentText = opinions
    .map(({ documentText: text }) => text)
    .join("\n");
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
    const key = quoteWords(cleaned).join(" ");
    if (quoteWords(cleaned).length >= 2 && !unique.has(key)) {
      unique.set(key, cleaned);
    }
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
  const uniqueSources = [
    ...new Map(sources.map((source) => [source.key, source])).values(),
  ];
  const assigned = new Map<
    string,
    { source: AutomaticLegalSourceLink; quotes: string[] }
  >();
  for (const quote of answerQuoteCandidates(answer)) {
    const matches = uniqueSources.filter(({ evidence }) =>
      blockTextMatchesQuote(quote, evidence.blockText),
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
  const locator =
    lookup.requested.kind === "paragraph"
      ? `para. ${label.replace(/^par/iu, "")}`
      : lookup.requested.kind === "section"
        ? `s. ${label.replace(/^sec/iu, "")}`
        : `p. ${label.replace(/^page=?/iu, "")}`;
  return `${citation}, ${locator}`.replace(/[[\]]/gu, "\\$&");
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
    { lookup: A2AJLocatorLookup; block: A2AJLookupBlock }
  >();
  for (const lookup of uniqueLookups) {
    for (const block of lookupBlocks(lookup)) {
      blockSelections.set(lookupBlockKey(lookup, block), { lookup, block });
    }
  }
  const assigned = new Map<
    string,
    { lookup: A2AJLocatorLookup; block: A2AJLookupBlock; quotes: string[] }
  >();
  for (const quote of candidates) {
    const matches = [...blockSelections.entries()].filter(([, { block }]) =>
      blockMatchesQuote(quote, block),
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
