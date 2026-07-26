import {
  buildA2AJStructure,
  lookupA2AJStructure,
  normalizeA2AJLocator,
  type A2AJLocatorKind,
  type A2AJStructureBlock,
} from "./a2ajStructure";

export type LegalSourceProvider =
  | "a2aj"
  | "canlii"
  | "courtlistener"
  | "govinfo"
  | "govuk-et"
  | "scc"
  | "tna";

export type LegalStructureBlock = A2AJStructureBlock & {
  anchor?: string;
  aliases?: string[];
  origin: "native" | "heuristic";
  parentLabel?: string;
};

export type LegalSourceStructure = {
  status: "usable" | "unavailable";
  source: "native" | "hybrid" | "flat_text" | "section_map";
  text: string;
  blocks: LegalStructureBlock[];
  counts: Record<A2AJLocatorKind, number>;
};

export type LegalStructureLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  requestedLabel: string;
  matches: string[];
  block: (LegalStructureBlock & { text: string }) | null;
  before: Array<LegalStructureBlock & { text: string }>;
  after: Array<LegalStructureBlock & { text: string }>;
};

type PendingBlock = {
  tag: string;
  kind: A2AJLocatorKind;
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

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
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
  provider: LegalSourceProvider,
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
  if (
    paragraph &&
    (provider === "tna" ||
      provider === "scc" ||
      provider === "canlii" ||
      provider === "courtlistener")
  ) {
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

function nativeMarkupStructure(provider: LegalSourceProvider, markup: string) {
  const parts: string[] = [];
  const blocks: LegalStructureBlock[] = [];
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

function countBlocks(blocks: LegalStructureBlock[]) {
  return {
    paragraph: blocks.filter(({ kind }) => kind === "paragraph").length,
    page: blocks.filter(({ kind }) => kind === "page").length,
    section: blocks.filter(({ kind }) => kind === "section").length,
  };
}

export function buildLegalSourceStructure(args: {
  provider: LegalSourceProvider;
  text: string;
  markup?: string | null;
  docType?: "cases" | "laws";
  citation?: string | null;
  alternateCitation?: string | null;
  dataset?: string | null;
  name?: string | null;
  sectionMap?: Record<string, string> | null;
}): LegalSourceStructure {
  const native = args.markup?.trim()
    ? nativeMarkupStructure(args.provider, args.markup)
    : { text: "", blocks: [] as LegalStructureBlock[] };
  const mappedLawStructure =
    !native.text && args.docType === "laws" && args.sectionMap
      ? buildA2AJStructure({
          text: args.text,
          docType: "laws",
          name: args.name,
          sectionMap: args.sectionMap,
        })
      : null;
  const text =
    native.text ||
    (mappedLawStructure?.source === "section_map"
      ? mappedLawStructure.text
      : args.text);
  const caseStructure = buildA2AJStructure({
    text,
    docType: "cases",
    citation: args.citation,
    alternateCitation: args.alternateCitation,
    dataset: args.dataset,
    name: args.name,
  });
  const lawStructure =
    mappedLawStructure?.source === "section_map"
      ? mappedLawStructure
      : buildA2AJStructure({
          text,
          docType: "laws",
          name: args.name,
        });
  const nativeKinds = new Set(native.blocks.map(({ kind }) => kind));
  const heuristicSource =
    args.docType === "laws" && lawStructure.source === "section_map"
      ? "section_map"
      : "flat_text";
  const heuristicBlocks =
    args.docType === "laws" ? lawStructure.blocks : caseStructure.blocks;
  const heuristic = heuristicBlocks
    .filter(({ kind }) => !nativeKinds.has(kind))
    .map((block) => ({ ...block, origin: "heuristic" as const }));
  const blocks = [...native.blocks, ...heuristic].sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label),
  );
  return {
    status: blocks.length ? "usable" : "unavailable",
    source: native.blocks.length
      ? heuristic.length
        ? "hybrid"
        : "native"
      : heuristicSource,
    text,
    blocks,
    counts: countBlocks(blocks),
  };
}

function materialize(
  structure: LegalSourceStructure,
  block: LegalStructureBlock,
) {
  return {
    ...block,
    text: structure.text.slice(block.start, block.end).trim(),
  };
}

export function lookupLegalSourceStructure(
  structure: LegalSourceStructure,
  kind: A2AJLocatorKind,
  locator: string,
  contextBlocks = 0,
): LegalStructureLookup {
  const requestedLabel = normalizeA2AJLocator(kind, locator);
  const available = structure.blocks.filter((block) => block.kind === kind);
  if (!requestedLabel || !available.length) {
    return {
      status: "unavailable",
      requestedLabel,
      matches: [],
      block: null,
      before: [],
      after: [],
    };
  }
  const matches = available.filter((block) =>
    [block.label, ...(block.aliases ?? [])].some(
      (label) => label.toLowerCase() === requestedLabel.toLowerCase(),
    ),
  );
  if (matches.length !== 1) {
    return {
      status: matches.length ? "ambiguous" : "not_found",
      requestedLabel,
      matches: matches.map(({ label }) => label),
      block: null,
      before: [],
      after: [],
    };
  }
  const selected = matches[0];
  const index = available.indexOf(selected);
  const context = Math.min(Math.max(Math.trunc(contextBlocks), 0), 2);
  return {
    status: "found",
    requestedLabel,
    matches: [selected.label],
    block: materialize(structure, selected),
    before: available
      .slice(Math.max(0, index - context), index)
      .map((block) => materialize(structure, block)),
    after: available
      .slice(index + 1, index + 1 + context)
      .map((block) => materialize(structure, block)),
  };
}

export function buildTnaStructure(xml: string) {
  return buildLegalSourceStructure({
    provider: "tna",
    text: "",
    markup: xml,
    docType: "cases",
  });
}
