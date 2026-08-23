import { normalizeWhitespace } from "./text";
export type LegalInlineToken =
  | { kind: "text" | "em" | "strong" | "code" | "sup" | "sub"; text: string }
  | { kind: "link"; text: string; href: string };

type PresentedText = {
  text: string;
  inline: LegalInlineToken[];
};

export type LegalMarkdownBlock =
  | (PresentedText & { kind: "heading"; level: 2 | 3 | 4 | 5 })
  | {
      kind: "list-item";
      text: string;
      inline: LegalInlineToken[];
      marker: string;
      ordered: boolean;
      depth: number;
    }
  | (PresentedText & { kind: "blockquote"; depth: number })
  | (PresentedText & { kind: "paragraph"; depth: number });

type UpstreamPdfLink = {
  url: string;
  label?: string | null;
  mediaType?: string | null;
  rel?: string | null;
};

export type OriginalPdfCandidateInput = {
  canonicalUrl: string;
  upstreamLinks?: readonly UpstreamPdfLink[];
  markup?: string | null;
};

export type OriginalPdfCandidate = {
  url: string;
  label: string | null;
  source: "decisia" | "canonical" | "metadata" | "markup";
  score: number;
  reasons: string[];
};

const MARKDOWN_HEADING_RE =
  /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const ORDERED_LIST_RE = /^([ \t]*)(\d+[.)])[ \t]+(.+)$/u;
const UNORDERED_LIST_RE = /^([ \t]*)([-+*])[ \t]+(.+)$/u;
const BLOCKQUOTE_RE = /^([ \t]*)(>+)[ \t]?(.*)$/u;
function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (match, code: string) => {
      const value = Number.parseInt(code, 10);
      return value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    })
    .replace(/&#x([0-9a-f]+);/giu, (match, code: string) => {
      const value = Number.parseInt(code, 16);
      return value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    });
}

function cleanTokenText(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script\s*>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style\s*>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  ).replace(/\\([\\`*_[\]{}()#+.!>~-])/gu, "$1");
}

function safeInlineHref(value: string) {
  const href = decodeHtmlEntities(value.trim());
  if (/^#[^\s]*$/u.test(href)) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? href
      : null;
  } catch {
    return null;
  }
}

type InlineMatch = {
  start: number;
  end: number;
  kind: Exclude<LegalInlineToken["kind"], "text">;
  text: string;
  href?: string;
  priority: number;
};

function nextInlineMatch(value: string, offset: number): InlineMatch | null {
  const patterns: Array<{
    kind: InlineMatch["kind"];
    expression: RegExp;
    content: number;
    href?: number;
  }> = [
    {
      kind: "link",
      expression:
        /<a\b(?=[^>]*\bhref\s*=\s*(["'])(.*?)\1)[^>]*>([\s\S]*?)<\/a\s*>/giu,
      content: 3,
      href: 2,
    },
    {
      kind: "strong",
      expression: /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/giu,
      content: 1,
    },
    {
      kind: "em",
      expression: /<(?:em|i|cite)\b[^>]*>([\s\S]*?)<\/(?:em|i|cite)\s*>/giu,
      content: 1,
    },
    {
      kind: "code",
      expression: /<code\b[^>]*>([\s\S]*?)<\/code\s*>/giu,
      content: 1,
    },
    {
      kind: "strong",
      expression: /\*\*([^*\r\n]+)\*\*/gu,
      content: 1,
    },
    { kind: "strong", expression: /__([^_\r\n]+)__/gu, content: 1 },
    {
      kind: "code",
      expression: /(`{1,3})([^`\r\n]+)\1/gu,
      content: 2,
    },
    {
      kind: "link",
      expression:
        /\[([^\]\r\n]+)\]\(([^)\s\r\n]+)(?:\s+["'][^"']*["'])?\)/gu,
      content: 1,
      href: 2,
    },
    {
      kind: "sup",
      expression: /<sup\b[^>]*>([\s\S]*?)<\/sup\s*>/giu,
      content: 1,
    },
    {
      kind: "sub",
      expression: /<sub\b[^>]*>([\s\S]*?)<\/sub\s*>/giu,
      content: 1,
    },
    { kind: "em", expression: /\*([^*\r\n]+)\*/gu, content: 1 },
    {
      kind: "em",
      expression: /(?<![\p{L}\p{N}])_([^_\r\n]+)_(?![\p{L}\p{N}])/gu,
      content: 1,
    },
  ];
  let best: InlineMatch | null = null;
  for (const [priority, pattern] of patterns.entries()) {
    pattern.expression.lastIndex = offset;
    const match = pattern.expression.exec(value);
    if (!match || match.index < offset) continue;
    const candidate: InlineMatch = {
      start: match.index,
      end: match.index + match[0].length,
      kind: pattern.kind,
      text: cleanTokenText(match[pattern.content]),
      href: pattern.href === undefined ? undefined : match[pattern.href],
      priority,
    };
    if (
      !best ||
      candidate.start < best.start ||
      (candidate.start === best.start && candidate.priority < best.priority)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Tokenize A2AJ's inline Markdown subset without producing executable markup.
 */
export function tokenizeLegalInline(markdown: string): LegalInlineToken[] {
  const tokens: LegalInlineToken[] = [];
  const pushText = (rawText: string) => {
    const text = cleanTokenText(rawText);
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous?.kind === "text") previous.text += text;
    else tokens.push({ kind: "text", text });
  };

  let offset = 0;
  while (offset < markdown.length) {
    const match = nextInlineMatch(markdown, offset);
    if (!match) {
      pushText(markdown.slice(offset));
      break;
    }
    pushText(markdown.slice(offset, match.start));
    const text = cleanTokenText(match.text);
    if (text) {
      if (match.kind === "link") {
        const href = safeInlineHref(match.href ?? "");
        if (href) tokens.push({ kind: "link", text, href });
        else pushText(text);
      } else {
        tokens.push({ kind: match.kind, text });
      }
    }
    offset = match.end;
  }
  return tokens;
}

function presentedText(value: string): PresentedText {
  const inline = tokenizeLegalInline(value);
  return {
    text: normalizeWhitespace(inline.map(({ text }) => text).join("")),
    inline,
  };
}

function plainInlineText(value: string) {
  return presentedText(value).text;
}

function indentationDepth(value: string) {
  let columns = 0;
  for (const character of value) {
    columns += character === "\t" ? 4 : 1;
  }
  return Math.floor(columns / 2);
}

/**
 * Classify the small, deterministic Markdown/legal hierarchy emitted by A2AJ.
 *
 * This is intentionally not a general Markdown parser. It strips supported
 * inline syntax so renderers receive text, never markup to execute or reparse.
 */
export function classifyLegalMarkdown(markdown: string): LegalMarkdownBlock[] {
  const clean = (markdown ?? "")
    .replace(/\u00a0/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\r\n?/gu, "\n");
  const result: LegalMarkdownBlock[] = [];
  let headingDepth = 0;
  let paragraphLines: string[] = [];
  let quote: { text: string[]; depth: number } | null = null;

  const flushParagraph = () => {
    const presented = presentedText(paragraphLines.join(" "));
    if (presented.text) {
      result.push({ kind: "paragraph", ...presented, depth: headingDepth });
    }
    paragraphLines = [];
  };
  const flushQuote = () => {
    if (!quote) return;
    const presented = presentedText(quote.text.join(" "));
    if (presented.text) {
      result.push({ kind: "blockquote", ...presented, depth: quote.depth });
    }
    quote = null;
  };
  const flushText = () => {
    flushParagraph();
    flushQuote();
  };

  for (const line of clean.split("\n")) {
    if (!line.trim()) {
      flushText();
      continue;
    }

    const markdownHeading = line.match(MARKDOWN_HEADING_RE);
    if (markdownHeading) {
      flushText();
      const level = Math.min(5, Math.max(2, markdownHeading[1].length)) as 2 | 3 | 4 | 5;
      const presented = presentedText(markdownHeading[2]);
      if (presented.text) {
        headingDepth = level - 2;
        result.push({ kind: "heading", ...presented, level });
      }
      continue;
    }

    const blockquote = line.match(BLOCKQUOTE_RE);
    if (blockquote) {
      flushParagraph();
      const depth =
        headingDepth +
        indentationDepth(blockquote[1]) +
        blockquote[2].length -
        1;
      if (quote && quote.depth !== depth) flushQuote();
      quote ??= { text: [], depth };
      quote.text.push(blockquote[3]);
      continue;
    }
    flushQuote();

    const compact = normalizeWhitespace(line);
    if (/^-+\s*(?:and|et)\s*-+$/iu.test(compact)) {
      flushParagraph();
      const presented = presentedText(compact);
      result.push({ kind: "paragraph", ...presented, depth: headingDepth });
      continue;
    }

    const ordered = line.match(ORDERED_LIST_RE);
    if (ordered) {
      flushParagraph();
      const presented = presentedText(ordered[3]);
      if (presented.text) {
        result.push({
          kind: "list-item",
          ...presented,
          marker: ordered[2],
          ordered: true,
          depth: headingDepth + indentationDepth(ordered[1]),
        });
      }
      continue;
    }

    const unordered = line.match(UNORDERED_LIST_RE);
    if (unordered) {
      flushParagraph();
      const presented = presentedText(unordered[3]);
      if (presented.text) {
        result.push({
          kind: "list-item",
          ...presented,
          marker: unordered[2],
          ordered: false,
          depth: headingDepth + indentationDepth(unordered[1]),
        });
      }
      continue;
    }

    paragraphLines.push(line);
  }
  flushText();
  return result;
}

type CandidateSource = OriginalPdfCandidate["source"];
type RankedCandidate = OriginalPdfCandidate & {
  position: number;
};

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  decisia: 4,
  canonical: 3,
  metadata: 2,
  markup: 1,
};

function httpUrl(rawUrl: string, baseUrl?: URL) {
  try {
    const url = new URL(decodeHtmlEntities(rawUrl.trim()), baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function decisiaPdfUrl(source: URL) {
  const match = source.pathname.match(/\/item\/(\d+)\/index\.do$/iu);
  if (!match || match.index === undefined) return null;
  const result = new URL(source);
  result.pathname =
    source.pathname.slice(0, match.index) + `/${match[1]}/1/document.do`;
  result.search = "";
  result.hash = "";
  return result;
}

function pdfScore(
  url: URL,
  baseUrl: URL,
  label: string,
  mediaType = "",
) {
  const path = url.pathname.toLowerCase();
  const clue = `${label} ${url.pathname} ${url.search}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (path.endsWith(".pdf")) {
    score += 50;
    reasons.push("pdf-extension");
  }
  if (path.includes("/document.do")) {
    score += 90;
    reasons.push("document-endpoint");
  }
  if (
    ["download pdf", "view pdf", "full text pdf", "full-text pdf"].some(
      (phrase) => clue.includes(phrase),
    )
  ) {
    score += 80;
    reasons.push("explicit-pdf-label");
  } else if (
    ["download", "viewcontent", "article/view", "galley"].some((phrase) =>
      clue.includes(phrase),
    )
  ) {
    score += 35;
    reasons.push("download-endpoint");
  } else if (label.trim().toLowerCase() === "pdf") {
    score += 60;
    reasons.push("pdf-label");
  }
  if (mediaType.toLowerCase().split(";", 1)[0].trim() === "application/pdf") {
    score += 100;
    reasons.push("pdf-media-type");
  }
  if (url.host.toLowerCase() === baseUrl.host.toLowerCase()) {
    score += 15;
    reasons.push("same-origin");
  }
  return { score, reasons };
}

function markupLinks(markup: string): UpstreamPdfLink[] {
  const links: UpstreamPdfLink[] = [];
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    const href = match[1].match(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
    );
    const url = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!url) continue;
    links.push({
      url,
      label: plainInlineText(match[2]),
    });
  }
  return links;
}

/**
 * Derive and rank plausible original PDFs without performing network I/O.
 *
 * Upstream provider adapters normalize their URL metadata into `upstreamLinks`.
 * Raw landing-page markup is inspected only for anchor destinations.
 */
export function deriveOriginalPdfCandidates(
  input: OriginalPdfCandidateInput,
): OriginalPdfCandidate[] {
  const canonical = httpUrl(input.canonicalUrl);
  if (!canonical) return [];
  const candidates = new Map<string, RankedCandidate>();
  let position = 0;

  const add = (
    rawUrl: string | URL,
    source: CandidateSource,
    label = "",
    mediaType = "",
  ) => {
    const url =
      rawUrl instanceof URL ? new URL(rawUrl) : httpUrl(rawUrl, canonical);
    if (!url) return;
    const normalizedLabel = plainInlineText(label);
    const { score, reasons } = pdfScore(
      url,
      canonical,
      normalizedLabel,
      mediaType,
    );
    if (score < 50) return;
    const key = url.toString();
    const candidate: RankedCandidate = {
      url: key,
      label: normalizedLabel || null,
      source,
      score,
      reasons,
      position: position++,
    };
    const existing = candidates.get(key);
    if (!existing) {
      candidates.set(key, candidate);
      return;
    }
    const preferredSource =
      SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
        ? candidate
        : existing;
    candidates.set(key, {
      ...preferredSource,
      label: preferredSource.label ?? existing.label ?? candidate.label,
      score: Math.max(existing.score, candidate.score),
      reasons: [...new Set([...existing.reasons, ...candidate.reasons])],
      position: Math.min(existing.position, candidate.position),
    });
  };

  const decisia = decisiaPdfUrl(canonical);
  if (decisia) add(decisia, "decisia");
  add(canonical, "canonical");
  for (const link of input.upstreamLinks ?? []) {
    add(link.url, "metadata", link.label ?? link.rel ?? "", link.mediaType ?? "");
  }
  for (const link of markupLinks(input.markup ?? "")) {
    add(link.url, "markup", link.label ?? "");
  }

  return [...candidates.values()]
    .sort(
      (left, right) =>
        SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source] ||
        right.score - left.score ||
        left.position - right.position ||
        left.url.localeCompare(right.url),
    )
    .map(({ position: _position, ...candidate }) => candidate);
}
