export type A2AJLocatorKind = "paragraph" | "page" | "section";

export type A2AJStructureBlock = {
  kind: A2AJLocatorKind;
  label: string;
  start: number;
  end: number;
};

export type A2AJStructure = {
  status: "usable" | "unavailable";
  source: "flat_text" | "section_map";
  text: string;
  blocks: A2AJStructureBlock[];
  counts: Record<A2AJLocatorKind, number>;
};

export type A2AJStructureLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  requestedLabel: string;
  matches: string[];
  block: (A2AJStructureBlock & { text: string }) | null;
  before: Array<A2AJStructureBlock & { text: string }>;
  after: Array<A2AJStructureBlock & { text: string }>;
};

type NumberedMarker = { number: number; start: number; contentStart?: number };
type ParagraphMarker = NumberedMarker & { style: "bracket" | "dot" | "bare" };
type SectionMarker = {
  label: string;
  start: number;
  style: "integer" | "dot" | "hyphen" | "mixed";
};

const PARAGRAPH_MARK_RE =
  /^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})\.(?=\s)|(\d{1,4})(?=\s))/gmu;
const PAGE_MARK_RE =
  /\[[ \t]*pages?[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[.:,;]?[ \t]*[\]\[)}]?[ \t]*[.,;:]?|^[ \t]*\[?[ \t]*page[ \t]*[.:,;]?[ \t]*(\d{1,4})[ \t]*[\])}]?[ \t]*[.,;:]?[ \t]*$/gimu;
const REPORT_PAGE_RE = /\b(?:S\.?C\.?R\.?|R\.?C\.?S\.?)\s+(\d{1,4})\b/iu;
const SECTION_MARK_RE =
  /^[ \t]*(\d{1,8}(?:[.-]\d{1,8}){0,3})(?=[ \t]+(?:\(?\d|\p{L})|[ \t]*\()/gmu;
const CHILD_MARK_RE =
  /^[ \t]*\((\d+(?:\.\d+)?|[A-Za-z](?:\.\d+)?|[ivxlcdmIVXLCDM]+)\)(?=\s)/gmu;

function wordCount(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function compareKeys(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

function monotoneScopes(markers: NumberedMarker[], maxGap = 8) {
  const scopes: NumberedMarker[][] = [];
  const byLast = new Map<number, number[]>();
  for (const marker of markers) {
    const candidates: number[] = [];
    for (
      let prior = marker.number - maxGap;
      prior < marker.number;
      prior += 1
    ) {
      candidates.push(...(byLast.get(prior) ?? []));
    }
    const index = candidates.length
      ? candidates.reduce((best, current) =>
          scopes[current][0].number < scopes[best][0].number ? current : best,
        )
      : scopes.length;
    if (index === scopes.length) {
      scopes.push([marker]);
    } else {
      const previous = scopes[index].at(-1)!.number;
      const entries = (byLast.get(previous) ?? []).filter(
        (value) => value !== index,
      );
      if (entries.length) byLast.set(previous, entries);
      else byLast.delete(previous);
      scopes[index].push(marker);
    }
    byLast.set(marker.number, [...(byLast.get(marker.number) ?? []), index]);
  }
  return scopes;
}

function paragraphBlocks(text: string, minRun = 5): A2AJStructureBlock[] {
  if (!text) return [];
  const markers: ParagraphMarker[] = [];
  for (const match of text.matchAll(PARAGRAPH_MARK_RE)) {
    const [bracket, dot, bare] = match.slice(1);
    markers.push({
      start: match.index,
      number: Number(bracket ?? dot ?? bare),
      style: bracket ? "bracket" : dot ? "dot" : "bare",
    });
  }
  const hypotheses: Array<{
    style: ParagraphMarker["style"];
    markers: NumberedMarker[];
  }> = [];
  for (const style of ["bracket", "dot", "bare"] as const) {
    for (const scope of monotoneScopes(
      markers.filter((marker) => marker.style === style),
    )) {
      if (scope.length >= minRun) hypotheses.push({ style, markers: scope });
    }
  }
  if (!hypotheses.length) return [];
  const rank = { bracket: 2, dot: 1, bare: 0 };
  const primary = hypotheses.filter((item) => item.markers[0].number <= 5);
  const ordered = [...(primary.length ? primary : hypotheses)].sort(
    (left, right) =>
      right.markers.length - left.markers.length ||
      rank[right.style] - rank[left.style] ||
      left.markers[0].number - right.markers[0].number,
  );
  for (const hypothesis of ordered) {
    const allOffsets = markers
      .filter((marker) => marker.style === hypothesis.style)
      .map((marker) => marker.start);
    const nextOffset = new Map(
      allOffsets.map((offset, index) => [
        offset,
        allOffsets[index + 1] ?? text.length,
      ]),
    );
    const blocks = hypothesis.markers.map((marker) => ({
      kind: "paragraph" as const,
      label: `par${marker.number}`,
      start: marker.start,
      end: nextOffset.get(marker.start) ?? text.length,
    }));
    const markerSpan =
      (blocks.at(-1)!.start - blocks[0].start) / Math.max(text.length, 1);
    const startRatio = blocks[0].start / Math.max(text.length, 1);
    const bounded = blocks.length > 1 ? blocks.slice(0, -1) : blocks;
    const medianWords = median(
      bounded.map((block) => wordCount(text.slice(block.start, block.end))),
    );
    const substantive =
      blocks.filter(
        (block) => wordCount(text.slice(block.start, block.end)) >= 12,
      ).length / blocks.length;
    if (medianWords < 12 || markerSpan < 0.05) continue;
    if (hypothesis.style !== "bracket" && substantive < 0.7) continue;
    if (
      hypothesis.style === "bare" &&
      (medianWords < 20 || markerSpan < 0.15 || startRatio > 0.7)
    ) {
      continue;
    }
    return blocks;
  }
  return [];
}

function reporterStartPage(...citations: Array<string | null | undefined>) {
  for (const citation of citations) {
    const match = REPORT_PAGE_RE.exec(citation ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

function pageMarkers(text: string, reportStart: number | null) {
  if (!/\bpage\b/iu.test(text)) return [];
  const markers: NumberedMarker[] = [];
  let priorEnd = -1;
  for (const match of text.matchAll(PAGE_MARK_RE)) {
    const number = Number(match[1] ?? match[2]);
    if (
      match.index < priorEnd ||
      (reportStart !== null && number < reportStart)
    ) {
      continue;
    }
    markers.push({
      number,
      start: match.index,
      contentStart: match.index + match[0].length,
    });
    priorEnd = match.index + match[0].length;
  }
  return markers;
}

function pageBlocks(
  text: string,
  reportStart: number | null,
  requireReportStart: boolean,
): A2AJStructureBlock[] {
  if (requireReportStart && reportStart === null) return [];
  const markers = pageMarkers(text, reportStart);
  const scopes: NumberedMarker[][] = [];
  const byLast = new Map<number, number[]>();
  for (const marker of markers) {
    const candidates = byLast.get(marker.number - 1) ?? [];
    const index = candidates.length
      ? candidates.reduce((best, current) =>
          scopes[current].at(-1)!.start > scopes[best].at(-1)!.start
            ? current
            : best,
        )
      : scopes.length;
    if (index === scopes.length) {
      scopes.push([marker]);
    } else {
      const previous = scopes[index].at(-1)!.number;
      const entries = (byLast.get(previous) ?? []).filter(
        (value) => value !== index,
      );
      if (entries.length) byLast.set(previous, entries);
      else byLast.delete(previous);
      scopes[index].push(marker);
    }
    byLast.set(marker.number, [...(byLast.get(marker.number) ?? []), index]);
  }
  const ranked = scopes
    .filter((scope) => scope.length >= 3)
    .sort((left, right) => right.length - left.length);
  if (
    !ranked.length ||
    (ranked.length > 1 && ranked[0].length === ranked[1].length)
  ) {
    return [];
  }
  const best = ranked[0];
  const blocks = best.slice(0, -1).map((marker, index) => ({
    kind: "page" as const,
    label: `page${marker.number}`,
    start: marker.contentStart!,
    end: best[index + 1].start,
  }));
  if (reportStart !== null && best[0].number === reportStart + 1) {
    blocks.unshift({
      kind: "page",
      label: `page${reportStart}`,
      start: 0,
      end: best[0].start,
    });
  }
  return blocks;
}

function sectionKey(label: string) {
  return label.split(/[.-]/u).map(Number);
}

function sectionMarkers(text: string) {
  const markers: SectionMarker[] = [];
  for (const match of text.matchAll(SECTION_MARK_RE)) {
    const label = match[1];
    markers.push({
      label,
      start: match.index,
      style:
        label.includes(".") && label.includes("-")
          ? "mixed"
          : label.includes("-")
            ? "hyphen"
            : label.includes(".")
              ? "dot"
              : "integer",
    });
  }
  return markers;
}

function sectionSpine(text: string, allowHyphen: boolean) {
  const markers = sectionMarkers(text);
  if (markers.length < 3) return [];
  const scopesFor = (
    styles: Set<SectionMarker["style"]>,
    requireRoot = false,
  ) => {
    const scopes: SectionMarker[][] = [];
    for (const marker of markers) {
      if (!styles.has(marker.style)) continue;
      const value = sectionKey(marker.label);
      const candidates = scopes
        .map((scope, index) => ({
          index,
          key: sectionKey(scope.at(-1)!.label),
        }))
        .filter(
          (item) =>
            item.key.length === value.length &&
            compareKeys(value, item.key) > 0,
        );
      if (candidates.length) {
        const selected = candidates.reduce((best, current) =>
          compareKeys(current.key, best.key) > 0 ? current : best,
        );
        scopes[selected.index].push(marker);
      } else {
        scopes.push([marker]);
      }
      if (scopes.length > 8) {
        const shortest = scopes.reduce(
          (best, scope, index) =>
            scope.length < scopes[best].length ? index : best,
          0,
        );
        scopes.splice(shortest, 1);
      }
    }
    return scopes.filter(
      (scope) =>
        scope.length >= 3 &&
        (!requireRoot ||
          sectionKey(scope[0].label).every((part) => part === 1)),
    );
  };
  const hypotheses = scopesFor(new Set(["integer", "dot"]));
  if (allowHyphen) {
    hypotheses.push(...scopesFor(new Set(["hyphen"]), true));
    hypotheses.push(...scopesFor(new Set(["mixed"]), true));
  }
  if (!hypotheses.length) return [];
  let best = hypotheses.reduce((winner, item) =>
    item.length > winner.length ? item : winner,
  );
  if (sectionKey(best[0].label).length === 1) {
    const expanded: SectionMarker[] = [];
    best.forEach((parent, index) => {
      const end = best[index + 1]?.start ?? text.length;
      const parentNumber = sectionKey(parent.label)[0];
      const descendants = markers.filter(
        (marker) =>
          marker.style === "dot" &&
          marker.start > parent.start &&
          marker.start < end &&
          sectionKey(marker.label)[0] === parentNumber,
      );
      const duplicates = new Set(
        descendants
          .filter(
            (candidate) =>
              descendants.filter((item) => item.label === candidate.label)
                .length > 1,
          )
          .map((item) => item.label),
      );
      expanded.push(parent);
      expanded.push(
        ...descendants.filter((item) => !duplicates.has(item.label)),
      );
    });
    best = expanded;
  }
  const span = (text.length - best[0].start) / Math.max(text.length, 1);
  return span >= 0.1 && best[0].start / Math.max(text.length, 1) <= 0.7
    ? best
    : [];
}

function romanValue(token: string) {
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  let total = 0;
  let prior = 0;
  for (const character of [...token.toLowerCase()].reverse()) {
    const value = values[character];
    if (!value) return null;
    total += value < prior ? -value : value;
    prior = Math.max(prior, value);
  }
  return total || null;
}

function singleSectionBlocks(
  text: string,
  section: string,
  start = 0,
): A2AJStructureBlock[] {
  const blocks: A2AJStructureBlock[] = [
    {
      kind: "section",
      label: `sec${section}`,
      start,
      end: start + text.length,
    },
  ];
  const children = [...text.matchAll(CHILD_MARK_RE)];
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const leading = new RegExp(
    `^[ \\t]*${escaped}[ \\t]*\\((\\d+(?:\\.\\d+)?|[A-Za-z](?:\\.\\d+)?|[ivxlcdmIVXLCDM]+)\\)(?=\\s)`,
    "u",
  ).exec(text);
  if (leading) children.unshift(leading);
  const labels = new Map<number, string>();
  const counters = new Map<number, number[]>();
  children.forEach((match, index) => {
    const token = match[1];
    let level: number;
    let value: number[] | null;
    if (/^\d/u.test(token)) {
      level = 1;
      value = token.split(".").map(Number);
    } else if (
      /^[ivxlcdm]+$/iu.test(token) &&
      (token.length > 1 ||
        (labels.has(2) &&
          (counters.has(3) ||
            (token.toLowerCase() === "i" &&
              (String(counters.get(2)) !== "8" ||
                children[index + 1]?.[1].toLowerCase() === "ii")))))
    ) {
      const roman = romanValue(token);
      level = 3;
      value = roman === null ? null : [roman];
    } else if (token === token.toUpperCase()) {
      const [letter, ...suffix] = token.split(".");
      level = 4;
      value = [letter.charCodeAt(0) - 64, ...suffix.map(Number)];
    } else {
      const [letter, ...suffix] = token.toLowerCase().split(".");
      level = 2;
      value = [letter.charCodeAt(0) - 96, ...suffix.map(Number)];
    }
    const prior = counters.get(level);
    if (!value || (prior && compareKeys(value, prior) <= 0)) return;
    counters.set(level, value);
    labels.set(level, `(${token})`);
    for (let deeper = level + 1; deeper <= 4; deeper += 1) {
      counters.delete(deeper);
      labels.delete(deeper);
    }
    blocks.push({
      kind: "section",
      label:
        `sec${section}` +
        [...labels.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, label]) => label)
          .join(""),
      start: start + match.index,
      end: start + (children[index + 1]?.index ?? text.length),
    });
  });
  return blocks;
}

function flatSectionBlocks(text: string, name: string | null | undefined) {
  const spine = sectionSpine(text, /\brules?\b/iu.test(name ?? ""));
  const blocks: A2AJStructureBlock[] = [];
  spine.forEach((marker, index) => {
    const end = spine[index + 1]?.start ?? text.length;
    blocks.push(
      ...singleSectionBlocks(
        text.slice(marker.start, end),
        marker.label,
        marker.start,
      ),
    );
  });
  return blocks;
}

function mappedSectionStructure(sectionMap: Record<string, string>) {
  const pieces: string[] = [];
  const blocks: A2AJStructureBlock[] = [];
  let position = 0;
  for (const [rawLabel, rawText] of Object.entries(sectionMap)) {
    const label = rawLabel.trim();
    const sectionText = rawText.trim();
    if (!sectionText) continue;
    if (pieces.length) {
      pieces.push("\n");
      position += 1;
    }
    pieces.push(sectionText);
    if (/^\d{1,8}(?:[.-]\d{1,8}){0,3}$/u.test(label)) {
      blocks.push(...singleSectionBlocks(sectionText, label, position));
    }
    position += sectionText.length;
  }
  return { text: pieces.join(""), blocks };
}

function counts(blocks: A2AJStructureBlock[]) {
  return {
    paragraph: blocks.filter((block) => block.kind === "paragraph").length,
    page: blocks.filter((block) => block.kind === "page").length,
    section: blocks.filter((block) => block.kind === "section").length,
  };
}

export function buildA2AJStructure(args: {
  text: string;
  docType: "cases" | "laws";
  citation?: string | null;
  alternateCitation?: string | null;
  dataset?: string | null;
  name?: string | null;
  sectionMap?: Record<string, string> | null;
}): A2AJStructure {
  if (args.docType === "laws") {
    if (args.sectionMap) {
      const mapped = mappedSectionStructure(args.sectionMap);
      if (mapped.blocks.length) {
        return {
          status: "usable",
          source: "section_map",
          text: mapped.text,
          blocks: mapped.blocks,
          counts: counts(mapped.blocks),
        };
      }
    }
    const blocks = flatSectionBlocks(args.text, args.name);
    return {
      status: blocks.length ? "usable" : "unavailable",
      source: "flat_text",
      text: args.text,
      blocks,
      counts: counts(blocks),
    };
  }

  const paragraphs = paragraphBlocks(args.text);
  const reportStart = reporterStartPage(args.citation, args.alternateCitation);
  const pages = pageBlocks(
    args.text,
    reportStart,
    (args.dataset ?? "").toUpperCase() === "SCC",
  );
  const blocks = [...paragraphs, ...pages];
  return {
    status: blocks.length ? "usable" : "unavailable",
    source: "flat_text",
    text: args.text,
    blocks,
    counts: counts(blocks),
  };
}

export function normalizeA2AJLocator(kind: A2AJLocatorKind, locator: string) {
  const value = locator.trim();
  if (kind === "paragraph") {
    const match = value.match(
      /^(?:\[\s*)?(?:paras?\.?|paragraphs?)?\s*(\d{1,4})(?:\s*\])?$/iu,
    );
    return match ? `par${Number(match[1])}` : "";
  }
  if (kind === "page") {
    const match = value.match(/^(?:pages?|pp?\.)?\s*(\d{1,4})$/iu);
    return match ? `page${Number(match[1])}` : "";
  }
  const compact = value
    .replace(/^(?:ss?\.?|sections?)\s*/iu, "")
    .replace(/\s+/gu, "");
  return /^\d{1,8}(?:[.-]\d{1,8}){0,3}(?:\([^)]+\))*$/u.test(compact)
    ? `sec${compact}`
    : "";
}

function materialize(structure: A2AJStructure, block: A2AJStructureBlock) {
  return {
    ...block,
    text: structure.text.slice(block.start, block.end).trim(),
  };
}

export function lookupA2AJStructure(
  structure: A2AJStructure,
  kind: A2AJLocatorKind,
  locator: string,
  contextBlocks = 0,
): A2AJStructureLookup {
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
  const matches = available.filter(
    (block) => block.label.toLowerCase() === requestedLabel.toLowerCase(),
  );
  if (matches.length !== 1) {
    return {
      status: matches.length ? "ambiguous" : "not_found",
      requestedLabel,
      matches: matches.map((block) => block.label),
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
