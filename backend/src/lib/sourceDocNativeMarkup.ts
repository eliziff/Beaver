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
import {
  a2ajCaseBlocks,
  courtlistenerCaseBlocks,
  type CaseBlockExcludedRange,
} from "./sourceDocA2AJ";

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
  aliases?: string[];
  parentLabel?: string;
  /** Inline marker (CAP star pagination): starts a page without a break. */
  inline?: boolean;
  pageLabel?: string;
  citationIndex?: number;
  pageScheme?: string;
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

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
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
    .replace(/^(?:section|sec|article|part|chapter|subsection|level|lvl)[_-]*/iu, "")
    .replace(/__(?:subsection|paragraph|subparagraph)[_-]*/giu, "(")
    .replace(/[_-](\d+|[A-Za-z]|[ivxlcdm]+)(?=$|[_-])/giu, "($1)")
    .replace(/\(+/gu, "(");
  const open = (value.match(/\(/gu) ?? []).length;
  const close = (value.match(/\)/gu) ?? []).length;
  return `${value}${")".repeat(Math.max(0, open - close))}`;
}

type NativeIdentity = Pick<
  PendingBlock,
  | "kind"
  | "label"
  | "anchor"
  | "inline"
  | "pageLabel"
  | "citationIndex"
  | "pageScheme"
  | "aliases"
>;

function pageValue(raw: string) {
  return raw
    .replace(/^\*+\s*/u, "")
    .replace(/^(?:page|p\.)\s+/iu, "")
    .trim();
}

function pageIdentity(
  raw: string,
  attrs: string,
  anchor?: string,
  inline?: boolean,
): NativeIdentity | null {
  const pageLabel = pageValue(raw);
  if (!/\d/u.test(pageLabel)) return null;
  return {
    kind: "page",
    label: /^\d{1,5}$/u.test(pageLabel)
      ? `page${Number(pageLabel)}`
      : `page${pageLabel.replace(/\s+/gu, "")}`,
    anchor,
    inline,
    pageLabel,
    citationIndex:
      Number(
        attribute(attrs, "citation-index") ||
          attribute(attrs, "data-citation-index"),
      ) || undefined,
    pageScheme: attribute(attrs, "pagescheme") || undefined,
  };
}

function footnoteIdentity(
  raw: string,
  id: string,
  anchor?: string,
): NativeIdentity | null {
  const marker = raw.trim();
  const numbered = marker.match(
    /^(?:\[(\d{1,5})\]|\((\d{1,5})\)|(\d{1,5}))$/u,
  );
  const idNumber =
    id.match(/^(?:fn|footnote)[_-]?(\d{1,5})(?:[-_]+\d+)*$/iu)?.[1] ||
    id.match(/^fn_(?:fn|fnote|refnote)(\d{1,5})(?:_\d+)*$/iu)?.[1] ||
    id.match(/^ftn(\d{1,5})$/iu)?.[1];
  const number = numbered?.slice(1).find(Boolean) || idNumber;
  if (number) {
    const label = `fn${Number(number)}`;
    return {
      kind: "footnote",
      label,
      anchor,
      aliases: marker && marker !== number ? [marker, `footnote ${marker}`] : undefined,
    };
  }
  const compactId = id.replace(/\s+/gu, "");
  const symbol = marker || (/^fn(?:[-*†]|\[)/iu.test(compactId) ? compactId : "");
  if (!symbol) return null;
  return {
    kind: "footnote",
    label: /^fn/iu.test(symbol) ? symbol : `fn${symbol}`,
    anchor,
    aliases: marker ? [marker, `footnote ${marker}`] : undefined,
  };
}

function courtlistenerFootnoteBody(
  provider: SourceDocProvider,
  tag: string,
  attrs: string,
) {
  if (provider !== "courtlistener") return false;
  const classes = attribute(attrs, "class");
  const id = attribute(attrs, "id");
  return (
    tag === "footnote" ||
    tag === "footnote_body" ||
    (["aside", "div", "li", "section"].includes(tag) &&
      (/\bfootnote\b/iu.test(classes) ||
        /^(?:(?:fn|footnote)[_-]|fn\d|ftn\d)/iu.test(id)))
  );
}

function nativeIdentity(
  provider: SourceDocProvider,
  tag: string,
  attrs: string,
): NativeIdentity | null {
  const id =
    attribute(attrs, "eId") ||
    attribute(attrs, "id") ||
    attribute(attrs, "name");
  const anchor = id || undefined;

  // CAP casebody HTML (xml_harvard): star pagination arrives as
  // <a id="p336" data-label="336" class="page-label">*336</a> INSIDE
  // running text, and footnotes as <aside data-label="1" class="footnote">
  // containers. Star pages are inline — they must not introduce breaks,
  // or the rendered text (frozen by the legacy recording) would change.
  if (tag === "a" && provider === "courtlistener") {
    const cls = attribute(attrs, "class");
    if (/\bpage-label\b/u.test(cls)) {
      const label =
        attribute(attrs, "data-label") || id.match(/^p(\d{1,5})$/iu)?.[1] || "";
      return pageIdentity(label, attrs, anchor, true);
    }
    // Citation links and footnotemarks are references, never containers.
    return null;
  }
  if (provider === "courtlistener") {
    const classes = attribute(attrs, "class");
    if (tag === "span" && /\bstar-pagination\b/u.test(classes)) {
      const raw =
        attribute(attrs, "label") ||
        attribute(attrs, "data-label");
      return pageIdentity(raw, attrs, anchor, true);
    }
    if (courtlistenerFootnoteBody(provider, tag, attrs)) {
      const raw =
        attribute(attrs, "data-label") ||
        attribute(attrs, "label") ||
        attribute(attrs, "n");
      return footnoteIdentity(raw, id, anchor);
    }
  }

  if (tag === "page-number") {
    const label =
      attribute(attrs, "label") ||
      attribute(attrs, "page") ||
      id.match(/(?:page|p)[_-]?(\d{1,5})$/iu)?.[1] ||
      "";
    return pageIdentity(label, attrs, anchor);
  }

  const paragraph =
    id.match(/^(?:para(?:graph)?)[_-]?(\d{1,5})$/iu)?.[1] ??
    (provider === "courtlistener" &&
    tag === "div" &&
    /\bnum\b/u.test(attribute(attrs, "class"))
      ? id.match(/^p(\d{1,5})$/iu)?.[1]
      : undefined);
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

function courtlistenerFootnoteContainer(
  provider: SourceDocProvider,
  tag: string,
  attrs: string,
) {
  if (provider !== "courtlistener") return false;
  return (
    courtlistenerFootnoteBody(provider, tag, attrs) ||
    /\bfootnotes\b/iu.test(attribute(attrs, "class")) ||
    /^(?:fn|footnote)[_-]/iu.test(attribute(attrs, "id"))
  );
}

function pageAliases(
  label: string,
  citationIndex: number | undefined,
  pageCitations: readonly string[],
  pageScheme?: string,
) {
  const citation = citationIndex ? pageCitations[citationIndex - 1] : undefined;
  return [
    ...(/^\d{1,5}$/u.test(label) ? [] : [label]),
    ...(citation ? [citation.replace(/\S+\s*$/u, label)] : []),
    ...(pageScheme ? [`${pageScheme}, at *${label}`] : []),
  ];
}

function nativeMarkupBlocks(
  provider: SourceDocProvider,
  markup: string,
  pageCitations: readonly string[],
) {
  const parts: string[] = [];
  const blocks: SourceDocBlock[] = [];
  const open: PendingBlock[] = [];
  const tagStack: string[] = [];
  const openExcluded: Array<{ tag: string; depth: number; start: number }> = [];
  const unlabelledFootnotes: Array<{
    tag: string;
    depth: number;
    start: number;
  }> = [];
  const excludedRanges: CaseBlockExcludedRange[] = [];
  let textPage: {
    start: number;
    anchor?: string;
    citationIndex?: number;
    pageScheme?: string;
  } | null = null;
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
    aliases?: string[];
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
      const rendered = decodeEntities(raw).replace(/\s+/gu, " ").trim();
      const pendingFootnote = unlabelledFootnotes.at(-1);
      if (pendingFootnote && rendered) {
        unlabelledFootnotes.pop();
        const marker = rendered.match(
          /^(?:\[\d{1,5}\]|\(\d{1,5}\)|\d{1,5}|[*†]+)(?=\s|$)/u,
        )?.[0];
        const identity = marker ? footnoteIdentity(marker, "") : null;
        if (identity) {
          open.push({
            tag: pendingFootnote.tag,
            ...identity,
            start: pendingFootnote.start,
          });
        }
      }
      const label = pageValue(rendered);
      if (textPage && /\d/u.test(label)) {
        pageStarts.push({
          label: /^\d{1,5}$/u.test(label)
            ? `page${Number(label)}`
            : `page${label.replace(/\s+/gu, "")}`,
          start: textPage.start,
          anchor: textPage.anchor,
          aliases: pageAliases(
            label,
            textPage.citationIndex,
            pageCitations,
            textPage.pageScheme,
          ),
        });
        textPage = null;
      }
      appendText(rendered);
      continue;
    }

    const closing = raw.match(/^<\s*\/\s*([\w:-]+)/u);
    if (closing) {
      const tag = closing[1].split(":").at(-1)!.toLowerCase();
      const depth = tagStack.lastIndexOf(tag);
      if (depth >= 0) {
        let excluded = -1;
        for (let index = openExcluded.length - 1; index >= 0; index -= 1) {
          const entry = openExcluded[index];
          if (entry.tag === tag && entry.depth === depth) {
            excluded = index;
            break;
          }
        }
        if (excluded >= 0) {
          const pending = openExcluded.splice(excluded, 1)[0];
          if (position > pending.start) {
            excludedRanges.push({ start: pending.start, end: position });
          }
        }
        for (let index = unlabelledFootnotes.length - 1; index >= 0; index -= 1) {
          const entry = unlabelledFootnotes[index];
          if (entry.tag === tag && entry.depth === depth) {
            unlabelledFootnotes.splice(index, 1);
            break;
          }
        }
        tagStack.length = depth;
      }
      if (tag === "span") textPage = null;
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
            aliases: pending.aliases,
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
    const selfClosing = /\/\s*>$/u.test(raw) || VOID_TAGS.has(tag);
    const depth = tagStack.length;
    const identity = nativeIdentity(provider, tag, attrs);
    if (!selfClosing) {
      tagStack.push(tag);
      if (courtlistenerFootnoteContainer(provider, tag, attrs)) {
        openExcluded.push({ tag, depth, start: position });
      }
      if (courtlistenerFootnoteBody(provider, tag, attrs) && !identity) {
        unlabelledFootnotes.push({ tag, depth, start: position });
      }
    }
    const inFootnote =
      openExcluded.length > 0 || open.some(({ kind }) => kind === "footnote");
    if (
      provider === "courtlistener" &&
      !selfClosing &&
      tag === "span" &&
      /\bstar-pagination\b/u.test(attribute(attrs, "class")) &&
      identity?.kind !== "page" &&
      !inFootnote
    ) {
      textPage = {
        start: position,
        anchor: attribute(attrs, "id") || undefined,
        citationIndex:
          Number(
            attribute(attrs, "citation-index") ||
              attribute(attrs, "data-citation-index"),
          ) || undefined,
        pageScheme: attribute(attrs, "pagescheme") || undefined,
      };
    }
    if (identity?.kind === "page" && !inFootnote) {
      if (!identity.inline) appendBreak();
      pageStarts.push({
        label: identity.label,
        start: position,
        anchor: identity.anchor,
        aliases: identity.pageLabel
          ? pageAliases(
              identity.pageLabel,
              identity.citationIndex,
              pageCitations,
              identity.pageScheme,
            )
          : undefined,
      });
    } else if (identity?.kind !== "page" && identity) {
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
  for (const pending of openExcluded) {
    if (text.length > pending.start) {
      excludedRanges.push({ start: pending.start, end: text.length });
    }
  }
  for (const pending of open) {
    if (text.length > pending.start) {
      blocks.push({
        kind: pending.kind,
        label: pending.label,
        start: pending.start,
        end: text.length,
        anchor: pending.anchor,
        aliases: pending.aliases,
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
        aliases: page.aliases,
        origin: "native",
      });
    }
  });
  return { text, blocks, excludedRanges };
}

function hasGappedParagraphSpine(blocks: readonly SourceDocBlock[]) {
  const labels = blocks
    .filter(({ kind, label }) => kind === "paragraph" && /^par\d+$/u.test(label))
    .sort((left, right) => left.start - right.start)
    .map(({ label }) => Number(label.slice(3)));
  return labels.some((label, index) => index > 0 && label !== labels[index - 1] + 1);
}

function clipParagraphsAtExcludedRanges(
  blocks: readonly SourceDocBlock[],
  ranges: readonly CaseBlockExcludedRange[],
) {
  const ordered = ranges
    .filter(({ end, start }) => end > start)
    .slice()
    .sort((left, right) => left.start - right.start);
  return blocks.flatMap((block) => {
    if (block.kind !== "paragraph") return [block];
    let end = block.end;
    for (const range of ordered) {
      if (range.start >= end) break;
      if (range.end <= block.start) continue;
      if (range.start <= block.start) return [];
      end = range.start;
    }
    return end > block.start ? [{ ...block, end }] : [];
  });
}

export function compileNativeMarkupSourceDoc(args: {
  provider: SourceDocProvider;
  id: string;
  url?: string | null;
  text: string;
  markup?: string | null;
  citation?: string | null;
  pageCitations?: string[];
}): SourceDoc {
  const native = args.markup?.trim()
    ? nativeMarkupBlocks(args.provider, args.markup, args.pageCitations ?? [])
    : {
        text: "",
        blocks: [] as SourceDocBlock[],
        excludedRanges: [] as CaseBlockExcludedRange[],
      };
  const text = native.text || args.text;
  const nativeLocators = new Set(
    native.blocks.flatMap((block) =>
      [block.label, ...(block.aliases ?? [])].map(
        (label) => `${block.kind}:${label.toLowerCase()}`,
      ),
    ),
  );
  // Harvard CAP casebody HTML has a frozen, receipt-bearing structure
  // contract. Its own page/footnote markup already supplies that structure;
  // keep its established fallback byte-for-byte while hardening the ordinary
  // CourtListener opinion HTML that has no native paragraph labels.
  const harvardCasebody = /<(?:\w+:)?(?:section|article)\b[^>]*\bcasebody\b/iu.test(
    args.markup ?? "",
  );
  const legacyBlocks = a2ajCaseBlocks({ text, citation: args.citation });
  const clippedLegacyBlocks =
    args.provider === "courtlistener"
      ? clipParagraphsAtExcludedRanges(legacyBlocks, native.excludedRanges)
      : legacyBlocks;
  const candidateLegacyBlocks =
    args.provider === "courtlistener"
      ? clippedLegacyBlocks.filter(
          (block) =>
            block.kind !== "paragraph" ||
            /\p{L}/u.test(text.slice(block.start, block.end)),
        )
      : clippedLegacyBlocks;
  // Leave an already-safe generic spine alone. The CourtListener profile is
  // a ratchet: source-marked footnotes and numeric-only tables are removed
  // deterministically; the stricter selector runs only for an absent or
  // gapped remaining spine.
  const needsCourtlistenerProfile =
    args.provider === "courtlistener" &&
    (!candidateLegacyBlocks.some(({ kind }) => kind === "paragraph") ||
      hasGappedParagraphSpine(candidateLegacyBlocks));
  const heuristicBlocks =
    args.provider === "courtlistener" &&
    !harvardCasebody &&
    needsCourtlistenerProfile
      ? courtlistenerCaseBlocks(
          { text, citation: args.citation },
          native.excludedRanges,
        )
      : candidateLegacyBlocks;
  const heuristic = heuristicBlocks.filter(
    ({ kind, label }) =>
      !nativeLocators.has(`${kind}:${label.toLowerCase()}`),
  );
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

export type NativeMarkupRef = {
  /** the citation as the judgment's text writes it */
  citation: string;
  /** provider's canonical form (TNA uk:canonical), when stated */
  canonical: string | null;
  /** provider's type tag (case, legislation), when stated */
  type: string | null;
};

/**
 * Cited authorities the markup states as data: TNA Akoma Ntoso wraps
 * every recognized citation in <ref uk:canonical uk:type>. Deduplicated
 * on canonical form (falling back to surface text); order of first
 * appearance. Providers without <ref> markup simply yield [].
 */
export function nativeMarkupCitedRefs(markup: string): NativeMarkupRef[] {
  const refs = new Map<string, NativeMarkupRef>();
  for (const match of markup.matchAll(
    /<(?:\w+:)?ref\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?ref\s*>/giu,
  )) {
    const attrs = match[1] ?? "";
    const citation = decodeEntities(match[2].replace(/<[^>]+>/gu, ""))
      .replace(/\s+/gu, " ")
      .trim();
    const canonical = attribute(attrs, "uk:canonical") || null;
    const type = attribute(attrs, "uk:type") || null;
    const key = (canonical ?? citation).toLowerCase();
    if (!key || refs.has(key)) continue;
    refs.set(key, { citation: citation || canonical || "", canonical, type });
  }
  return [...refs.values()];
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
  const matchesBlock = (labels: (block: SourceDocBlock) => string[]) =>
    doc.blocks.some(
      (block) =>
        block.kind === kind &&
        labels(block).some(
          (label) => label.toLowerCase() === exact.toLowerCase(),
        ),
    );
  const requestedLabel = matchesBlock((block) => [block.label])
    ? exact
    : normalizeLegalLocator(kind, locator) ||
      // Provider-native aliases outside every locator grammar (journal page
      // labels like "PDF 1"): pass the locator through only when no grammar
      // recognized it, so normalized labels keep their receipt bytes.
      (matchesBlock((block) => [block.anchor ?? "", ...(block.aliases ?? [])])
        ? exact
        : "");
  return lookupSourceDocLabel(doc, kind, requestedLabel, contextBlocks);
}
