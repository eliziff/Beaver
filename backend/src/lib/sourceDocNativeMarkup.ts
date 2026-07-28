import {
  createSourceDoc,
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
  type SourceDocLookup,
  type SourceDocProvider,
} from "./sourceDoc";
import { a2ajCaseBlocks } from "./sourceDocA2AJ";

/**
 * Native provider markup (Akoma Ntoso eIds, CourtListener paragraph ids and
 * page-number elements) compiled to one SourceDoc: the markup is rendered to
 * text exactly once, natively-labelled blocks keep their provider anchors, and
 * the A2AJ prose case spine fills in whatever the markup does not label.
 *
 * Parity with the legalSourceStructure engine this replaced is frozen in
 * fixtures/nativemarkup/legacy-structure.json: the rendered text, every block
 * boundary and every lookup payload hash must match that recording
 * byte-for-byte, because TNA evidence receipts persist sha256 hashes over
 * both the block text and the lookup payload.
 */

type PendingBlock = {
  tag: string;
  kind: SourceDocLocatorKind;
  label: string;
  start: number;
  anchor?: string;
  parentLabel?: string;
};

const BREAK_TAGS = new Set([
  "article",
  "blockquote",
  "br",
  "chapter",
  "conclusion",
  "content",
  "decision",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "heading",
  "item",
  "level",
  "li",
  "opinion",
  "p",
  "paragraph",
  "part",
  "preface",
  "section",
  "subsection",
  "tr",
]);

/**
 * This decoder's output is sha256'd into TNA evidence receipts (via the
 * rendered text), and it deliberately DISAGREES with
 * legalSourcePresentation's decodeHtmlEntities on `&#160;` (space here, NBSP
 * there). Do not merge the two or change either's output.
 */
function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (match, code) => {
      const value = Number.parseInt(code, 10);
      // Out-of-range code points would throw; keep the raw entity instead.
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&#x([0-9a-f]+);/giu, (match, code) => {
      const value = Number.parseInt(code, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    });
}

function attribute(attrs: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = attrs.match(
    new RegExp(
      `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
      "iu",
    ),
  );
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function cleanSectionId(raw: string) {
  const value = raw
    .replace(/^(?:section|sec|article|part|chapter|subsection)[_-]*/iu, "")
    .replace(/__(?:subsection|paragraph|subparagraph)[_-]*/giu, "(")
    .replace(/[_-](\d+|[A-Za-z]|[ivxlcdm]+)(?=$|[_-])/giu, "($1)")
    .replace(/\(+/gu, "(");
  const open = (value.match(/\(/gu) ?? []).length;
  const close = (value.match(/\)/gu) ?? []).length;
  return `${value}${")".repeat(Math.max(0, open - close))}`;
}

function nativeIdentity(
  provider: SourceDocProvider,
  tag: string,
  attrs: string,
): Pick<PendingBlock, "kind" | "label" | "anchor"> | null {
  const id =
    attribute(attrs, "eId") ||
    attribute(attrs, "id") ||
    attribute(attrs, "name");
  const anchor = id || undefined;

  if (tag === "page-number") {
    const label =
      attribute(attrs, "label") ||
      attribute(attrs, "page") ||
      id.match(/(?:page|p)[_-]?(\d{1,5})$/iu)?.[1] ||
      "";
    return /^\d{1,5}$/u.test(label)
      ? { kind: "page", label: `page${Number(label)}`, anchor }
      : null;
  }

  const paragraph = id.match(/^(?:para(?:graph)?)[_-]?(\d{1,5})$/iu)?.[1];
  if (paragraph && (provider === "tna" || provider === "courtlistener")) {
    return {
      kind: "paragraph",
      label: `par${Number(paragraph)}`,
      anchor,
    };
  }

  if (
    ["article", "chapter", "level", "part", "section", "subsection"].includes(
      tag,
    ) &&
    id
  ) {
    const section = cleanSectionId(id);
    if (/^\d{1,8}(?:[.-]\d{1,8}){0,3}(?:\([^)]+\))*$/u.test(section)) {
      return { kind: "section", label: `sec${section}`, anchor };
    }
  }

  const canliiSection = id.match(
    /^sec(\d{1,8}(?:[.-]\d{1,8}){0,3}(?:\([^)]+\))*)$/iu,
  )?.[1];
  return canliiSection
    ? { kind: "section", label: `sec${canliiSection}`, anchor }
    : null;
}

function nativeMarkupBlocks(provider: SourceDocProvider, markup: string) {
  const parts: string[] = [];
  const blocks: SourceDocBlock[] = [];
  const open: PendingBlock[] = [];
  let position = 0;
  const appendText = (value: string) => {
    if (!value) return;
    const prior = parts.at(-1) ?? "";
    if (
      prior &&
      !/[\s([{/-]$/u.test(prior) &&
      !/^[\s.,;:!?)}\]/-]/u.test(value)
    ) {
      parts.push(" ");
      position += 1;
    }
    parts.push(value);
    position += value.length;
  };
  const appendBreak = () => {
    const prior = parts.at(-1) ?? "";
    if (!parts.length || prior.endsWith("\n")) return;
    parts.push("\n");
    position += 1;
  };
  const pageStarts: Array<{
    label: string;
    start: number;
    anchor?: string;
  }> = [];
  const tokenPattern =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]+>|[^<]+/gu;

  for (const token of markup.matchAll(tokenPattern)) {
    const raw = token[0];
    if (raw.startsWith("<!--")) continue;
    if (raw.startsWith("<![CDATA[")) {
      appendText(token[1] ?? "");
      continue;
    }
    if (!raw.startsWith("<")) {
      appendText(decodeEntities(raw).replace(/\s+/gu, " ").trim());
      continue;
    }

    const closing = raw.match(/^<\s*\/\s*([\w:-]+)/u);
    if (closing) {
      const tag = closing[1].split(":").at(-1)!.toLowerCase();
      for (let index = open.length - 1; index >= 0; index -= 1) {
        if (open[index].tag !== tag) continue;
        const pending = open.splice(index, 1)[0];
        const end = position;
        if (end > pending.start) {
          blocks.push({
            kind: pending.kind,
            label: pending.label,
            start: pending.start,
            end,
            anchor: pending.anchor,
            origin: "native",
            parentLabel: pending.parentLabel,
          });
        }
        break;
      }
      if (BREAK_TAGS.has(tag)) appendBreak();
      continue;
    }

    const opening = raw.match(/^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/u);
    if (!opening || raw.startsWith("<!")) continue;
    const tag = opening[1].split(":").at(-1)!.toLowerCase();
    const attrs = opening[2] ?? "";
    const identity = nativeIdentity(provider, tag, attrs);
    if (identity?.kind === "page") {
      appendBreak();
      pageStarts.push({
        label: identity.label,
        start: position,
        anchor: identity.anchor,
      });
    } else if (identity) {
      appendBreak();
      open.push({
        tag,
        ...identity,
        start: position,
        parentLabel: [...open]
          .reverse()
          .find(({ kind }) => kind === identity.kind)?.label,
      });
    }
    if (tag === "br") appendBreak();
  }

  const text = parts
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  for (const pending of open) {
    if (text.length > pending.start) {
      blocks.push({
        kind: pending.kind,
        label: pending.label,
        start: pending.start,
        end: text.length,
        anchor: pending.anchor,
        origin: "native",
        parentLabel: pending.parentLabel,
      });
    }
  }
  pageStarts.forEach((page, index) => {
    const end = pageStarts[index + 1]?.start ?? text.length;
    if (end > page.start) {
      blocks.push({
        kind: "page",
        label: page.label,
        start: page.start,
        end,
        anchor: page.anchor,
        origin: "native",
      });
    }
  });
  return { text, blocks };
}

export function compileNativeMarkupSourceDoc(args: {
  provider: SourceDocProvider;
  id: string;
  url?: string | null;
  text: string;
  markup?: string | null;
  citation?: string | null;
}): SourceDoc {
  const native = args.markup?.trim()
    ? nativeMarkupBlocks(args.provider, args.markup)
    : { text: "", blocks: [] as SourceDocBlock[] };
  const text = native.text || args.text;
  const nativeKinds = new Set(native.blocks.map(({ kind }) => kind));
  const heuristic = a2ajCaseBlocks({
    text,
    citation: args.citation,
  }).filter(({ kind }) => !nativeKinds.has(kind));
  const blocks = [...native.blocks, ...heuristic].sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label),
  );
  return createSourceDoc({
    provider: args.provider,
    id: args.id,
    url: args.url ?? null,
    docType: "cases",
    text,
    blocks,
  });
}

export type LegalSourceStructureSummary = {
  status: SourceDoc["status"];
  source: "native" | "hybrid" | "flat_text";
  counts: Record<SourceDocLocatorKind, number>;
};

/** The index as provider tools advertise it: whose labels back the blocks. */
export function summarizeLegalSourceDoc(
  doc: SourceDoc,
): LegalSourceStructureSummary {
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

function normalizeLegalLocator(kind: SourceDocLocatorKind, locator: string) {
  const standard = normalizeSourceDocLocator(kind, locator);
  if (standard || kind !== "section") return standard;
  // Native markup and journal articles also label provisions by roman
  // numeral, bare letter, or title ("Interpretation"), which no numeric
  // grammar admits.
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

/**
 * lookupSourceDoc with the wider provider-corpus grammar: a locator that IS a
 * block label passes through verbatim (persisted receipts replay the label
 * they stored), and section locators fall back to roman/letter labels and
 * `sectitle:` title aliases.
 */
export function lookupLegalSourceDoc(
  doc: SourceDoc,
  kind: SourceDocLocatorKind,
  locator: string,
  contextBlocks = 0,
): SourceDocLookup {
  const exact = locator.trim();
  const requestedLabel = doc.blocks.some(
    (block) =>
      block.kind === kind &&
      block.label.toLowerCase() === exact.toLowerCase(),
  )
    ? exact
    : normalizeLegalLocator(kind, locator);
  return lookupSourceDocLabel(doc, kind, requestedLabel, contextBlocks);
}
