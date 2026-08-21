import {
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
  type SourceDocLookup,
  type SourceDocProvider,
} from "./sourceDoc";

export type NativeMarkupSourceInput = {
  provider: SourceDocProvider;
  id: string;
  url?: string | null;
  text: string;
  markup?: string | null;
  citation?: string | null;
  pageCitations?: string[];
  scope?: { kind: "complete" | "excerpt"; excerptOf?: string };
};

export type LegalSourceStructureSummary = {
  status: SourceDoc["status"];
  source: "native" | "hybrid" | "flat_text";
  counts: Record<SourceDocLocatorKind, number>;
};

export function summarizeLegalSourceDoc(doc: SourceDoc): LegalSourceStructureSummary {
  const native = doc.blocks.some(({ origin }) => origin === "native");
  const heuristic = doc.blocks.some(({ origin }) => origin === "heuristic");
  return {
    status: doc.status,
    source: native ? (heuristic ? "hybrid" : "native") : "flat_text",
    counts: {
      paragraph: doc.ranges.paragraph.count,
      page: doc.ranges.page.count,
      section: doc.ranges.section.count,
      footnote: doc.ranges.footnote.count,
    },
  };
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (match, code) => {
      const point = Number.parseInt(code, 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&#x([0-9a-f]+);/giu, (match, code) => {
      const point = Number.parseInt(code, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

function attribute(attributes: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = attributes.match(new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "iu",
  ));
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

export type NativeMarkupRef = {
  citation: string;
  canonical: string | null;
  type: string | null;
};

export function nativeMarkupCitedRefs(markup: string): NativeMarkupRef[] {
  const refs = new Map<string, NativeMarkupRef>();
  for (const match of markup.matchAll(
    /<(?:\w+:)?ref\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?ref\s*>/giu,
  )) {
    const attributes = match[1] ?? "";
    const citation = decodeEntities(match[2].replace(/<[^>]+>/gu, ""))
      .replace(/\s+/gu, " ")
      .trim();
    const canonical = attribute(attributes, "uk:canonical") || null;
    const type = attribute(attributes, "uk:type") || null;
    const key = (canonical ?? citation).toLowerCase();
    if (key && !refs.has(key)) {
      refs.set(key, { citation: citation || canonical || "", canonical, type });
    }
  }
  return [...refs.values()];
}

function normalizeLegalLocator(kind: SourceDocLocatorKind, locator: string) {
  const standard = normalizeSourceDocLocator(kind, locator);
  if (standard || kind !== "section") return standard;
  const compact = locator
    .trim()
    .replace(/^(?:ss?\.?|sections?)\s*/iu, "")
    .replace(/[.\s]+$/gu, "");
  if (/^(?:[IVXLCDM]+|[A-Z])$/u.test(compact)) return `sec${compact}`;
  const title = compact
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return title ? `sectitle:${title}` : "";
}

export function lookupLegalSourceDoc(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
): SourceDocLookup {
  const exact = locator.trim();
  const matchesBlock = (labels: (block: SourceDocBlock) => string[]) =>
    doc.blocks.some((block) =>
      block.kind === kind &&
      labels(block).some((label) => label.toLowerCase() === exact.toLowerCase()),
    );
  const requestedLabel = matchesBlock((block) => [block.label])
    ? exact
    : normalizeLegalLocator(kind, locator) ||
      (matchesBlock((block) => [block.anchor ?? "", ...(block.aliases ?? [])])
        ? exact
        : "");
  return lookupSourceDocLabel(doc, kind, requestedLabel, contextBlocks);
}
