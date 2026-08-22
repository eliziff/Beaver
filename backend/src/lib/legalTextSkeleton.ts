/**
 * Projects the shared Rust instrument graph into SourceDoc and augments it
 * with native tables, lineation competition, a TOC outline, defined terms,
 * and cross-references. Rust owns section, container, schedule, and enumerator
 * detection; this module must not duplicate that grammar.
 */

import {
  collectDefinedTerms,
  isExternalReference,
} from "./docxStructuralLint";
import { sha256 } from "./hash";

import {
  createSourceDoc,
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLookup,
} from "./sourceDoc";
import {
  findProvisionReferences,
} from "./legalReferenceGrammar";
import { deriveInstrumentSourceStructure } from "./sourceStructureEngine";
import {
  instrumentLineationHypothesesNative,
  type InstrumentContentsReading,
} from "./structureNative";
import { documentScalarOffsets, type StructureGraphV2 } from "./structureWire";

export type SkeletonNodeKind =
  | "article"
  | "part"
  | "division"
  | "section"
  | "subsection"
  | "schedule"
  | "table"
  | "row"
  | "cell";

export interface SkeletonNode {
  kind: SkeletonNodeKind;
  /** SourceDoc block label, e.g. "sec8.01(a)", "art8", "sched7.01" */
  label: string;
  /** human form, e.g. "Section 8.01(a)", "ARTICLE VIII" */
  display: string;
  heading: string;
  depth: number;
  start: number;
  end: number;
  parentLabel?: string;
}

/** Native table coordinates already projected onto this text's offset plane. */
export interface TableCellSpan {
  table: number;
  /** Native table/sheet name when the source format has one. */
  tableName?: string;
  row: number;
  column: number;
  /** Native address such as A1 when the source format defines one. */
  address?: string;
  columnSpan?: number;
  rowSpan?: number;
  start: number;
  end: number;
}

export interface DefinedTermEntry {
  term: string;
  /** label of the section containing the (first) definition, if any */
  sectionLabel: string | null;
  definitions: number;
}

export interface CrossReferenceSummary {
  internal: number;
  external: number;
  /** distinct internal targets that resolve to no block */
  unresolved: string[];
}

export interface AgreementSkeleton {
  nodes: SkeletonNode[];
  doc: SourceDoc;
  definedTerms: DefinedTermEntry[];
  schedules: string[];
  crossReferences: CrossReferenceSummary;
  ladder: LadderDiagnostics;
  /** The document's advertised outline; never merged into provision nodes. */
  outline: InstrumentContentsReading["outline"];
  /** Why no reliable outline was available. */
  outlineRefusal: InstrumentContentsReading["refusal"];
}

// ---------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  start: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const raw of text.split("\n")) {
    lines.push({ text: raw.replace(/\r$/u, ""), start });
    start += raw.length + 1;
  }
  return lines;
}

export interface LadderDiagnostics {
  increments: number;
  levelOpens: number;
  midcounterOpens: number;
  forwardJumps: number;
  restarts: number;
  violations: number;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface DiscoveredNodes {
  nodes: SkeletonNode[];
  schedules: string[];
  ladder: LadderDiagnostics;
}

/** Keep offsets and line breaks exact while removing native cells from heuristics. */
function maskTableCells(text: string, cells: readonly TableCellSpan[]): string {
  if (!cells.length) return text;
  const ordered = [...cells].sort((a, b) => a.start - b.start);
  let at = 0;
  let masked = "";
  for (const cell of ordered) {
    const start = Math.max(at, cell.start);
    const end = Math.max(start, Math.min(text.length, cell.end));
    masked += text.slice(at, start);
    masked += text.slice(start, end).replace(/[^\n]/gu, " ");
    at = end;
  }
  return masked + text.slice(at);
}


/**
 * Line breaks lost by the extraction that produced this text.
 *
 * A typeset page has short lines; a text dump whose "lines" run to hundreds
 * of characters is one where the extractor joined them, leaving the break as
 * a run of spaces. Every structural grammar in this module keys on a line
 * START, so in such a document the headings are invisible — measured on
 * LegalBench-RAG-mini, the seven merger agreements whose mean line exceeds
 * 220 characters detect 13-33 sections where their well-lineated siblings
 * detect 78-111, and all seven are refused by the cross-reference integrity
 * gate.
 *
 * Lineation reconstruction is OFFSET-EXACT by construction: the first space of an internal
 * run is replaced by a newline and the rest of the run is kept, so the
 * recovered text is the same length as the original, character for
 * character, and differs from it only in whitespace. Every offset a node
 * discovered over it carries is therefore a valid offset in the original,
 * and the SourceDoc, defined terms and quote verification below are all
 * built from the ORIGINAL text regardless of which lineation won.
 */
/**
 * The other extraction dialect joins lines with a SINGLE space, leaving no
 * run to split on — At Home Group is 316k characters in 1,030 lines with
 * zero internal space runs, one 5,035-character "line" per page.
 *
 * Offering a line start at every internal space a head grammar could begin
 * at is UNSOUND, and the corpus said so loudly enough to be worth recording:
 * a merger agreement's definitions index is a list of "'Balance Sheet Date'
 * has the meaning set forth in Section 6.16(a)", so every entry becomes a
 * head that real references elsewhere resolve onto. CAI International
 * compiled 272 heads against roughly 100 real ones and its endorsement score
 * ROSE, because the invented heads were exactly the labels the document
 * cites. Endorsement cannot police a hypothesis that mints the provisions
 * being looked for.
 *
 * What separates a lost line break from an ordinary space is what precedes
 * it. A heading follows the END of the previous line, so in a single-space
 * join the character before the lost newline is a sentence terminator;
 * "set forth in Section 6.16" is preceded by "in". Requiring the terminator
 * costs nothing real and collapses the pathology exactly: CAI stays at 26
 * heads instead of 272, while At Home goes 33 -> 96 with integrity 0.39 ->
 * 0.90 and BioTelemetry 0.75 -> 0.93.
 */
/**
 * A terminator is whatever ends a printed line before a heading. Kept wide
 * on purpose — a full stop, a semicolon or colon in older drafting, and any
 * closing quote or bracket after one — because the point of the guard is the
 * ANTECEDENT, not the punctuation dialect.
 */

/**
 * Segmentation hypotheses, in precedence order — the text as extracted
 * first, so a tie always keeps what the extractor produced. Each is the same
 * length as the original and differs only in whitespace.
 */
function lineationHypotheses(text: string): string[] {
  return instrumentLineationHypothesesNative(text);
}

/**
 * How many of the document's OWN provision references land on a provision
 * this reading of the structure compiled. The document is the only authority
 * available question-blind: a merger agreement that writes "Section 9.01"
 * forty times is telling us what its numbering scheme is, and a reading that
 * cannot address those pointers has misread it.
 *
 * Deliberately a plainer resolver than `legalCrossReference`'s — exact index
 * hits only, no descendant-prefix union and no context-relative sub-only
 * resolution. It is a SELECTOR between whole hypotheses, not the graph, and
 * a selector wants the least machinery that ranks correctly.
 *
 * A reference may not endorse a provision minted out of ITSELF. Offering a
 * line start before "... See also Section 9.99 for notices." lets that prose
 * become a section head, whereupon the reference "resolves" and the reading
 * that invented it scores higher — the selector would reward a detector for
 * hallucinating exactly the provision the document is missing. Skipping
 * targets that begin inside the reference span closes that loop; it costs
 * nothing real, because a genuine heading is somewhere else in the document.
 */
/**
 * The alternate lineations above can only ADD line starts, so they can only add
 * candidate heads — but a spine competition is not monotone in its candidate
 * set, and on a well-lineated document the added noise beats the real spine
 * (measured: CIT Group 105 sections -> 3, Bryn Mawr 78 -> 12). So the
 * lineations COMPETE, on the same principle the shared spine uses one level
 * down: the document decides. Ties go to the text as extracted.
 */
export interface CompileSkeletonOptions {
  /**
   * Whether this text may have lost its line breaks to an extractor, and so
   * whether the lineation competition may run at all.
   *
   * Default true, because the Library lane compiles PDF- and DOCX-derived
   * agreements and that is what lineation reconstruction exists for. Pass false for
   * text from an authoritative structured source, where the line breaks are
   * the publisher's and there is no lineation to reconstruct — the A2AJ lane passes
   * it so that legislation and case law cannot reach the competition BY
   * CONSTRUCTION rather than by a corpus diff showing they happened not to.
   *
   * The construction is not ceremony. Re-measured over the whole A2AJ English
   * statute corpus on 2026-07-31, the flag is NOT inert: 45 of 23,531
   * statutes compile a different node inventory with reconstruction on than
   * with it off (2,923,700 nodes on, 2,924,267 off, 837 nodes of absolute
   * difference; the largest single move is the Criminal Code, 10,861 nodes
   * against 10,979). An earlier note here recorded that differential as
   * byte-identical; that is no longer true, and the scoping is load-bearing
   * for every consumer that can be handed publisher-lineated text.
   *
   * "Authoritative" means the FEED, not the subject matter: an Act uploaded
   * as a PDF is extraction output like any other, and passing false for it
   * would throw away the line breaks its extractor lost.
   */
  reconstructLineation?: boolean;
  /** Exact native cells; plain text alone cannot reconstruct table boundaries. */
  tableCells?: readonly TableCellSpan[];
}

/**
 * Compiling a skeleton is the most-repeated expensive thing in the tool
 * layer, and until now it was repeated every single time: 20+ call sites in
 * backend/src, none memoized, with search paths compiling the same document
 * more than once per call and Grep compiling one per matching document. The
 * extracted text beside it has been cached for ages
 * (DocumentProjectionService), so the string was free and the structure was
 * not.
 *
 * The key is not the text alone. `id` becomes `doc.id`, and
 * `reconstructLineation` genuinely changes the node inventory — 45 of 23,531
 * A2AJ statutes compile differently with it on than off — so a key that
 * ignored either would serve one caller another caller's document.
 *
 * Sharing the returned object is safe: nothing in backend/src, backend/scripts
 * or the tests mutates a returned skeleton or its nodes. Every consumer that
 * sorts copies first, and `readSection` materializes a copy of the block.
 *
 * The real cost of sharing is MEMORY, not correctness. A shared `SourceDoc`
 * keeps its lazily-built `tokens` array (~14 bytes per character of source
 * text) and any postings index built by a phrase query alive for as long as
 * the entry lives — so the cap stays small deliberately.
 */
const SKELETON_CACHE_LIMIT = 8;
const skeletonCache = new Map<string, Promise<AgreementSkeleton>>();

function skeletonCacheKey(
  text: string,
  id: string,
  options: CompileSkeletonOptions,
): string {
  return [
    sha256(text),
    id,
    options.reconstructLineation === false ? "source-lineation" : "lineation-competition",
    options.tableCells?.length
      ? sha256(JSON.stringify(options.tableCells))
      : "nocells",
  ].join("\u0000");
}

export async function compileAgreementSkeleton(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): Promise<AgreementSkeleton> {
  const cacheKey = skeletonCacheKey(text, id, options);
  const cached = skeletonCache.get(cacheKey);
  if (cached) {
    // Refresh recency: the tool layer reads one document repeatedly within a
    // turn, then moves on.
    skeletonCache.delete(cacheKey);
    skeletonCache.set(cacheKey, cached);
    return cached;
  }
  const compiled = compileAgreementSkeletonUncached(text, id, options).catch((error) => {
    skeletonCache.delete(cacheKey);
    throw error;
  });
  skeletonCache.set(cacheKey, compiled);
  if (skeletonCache.size > SKELETON_CACHE_LIMIT) {
    skeletonCache.delete(skeletonCache.keys().next().value!);
  }
  return compiled;
}

/** Escape hatch for anything that must not share (tests, differentials). */
export function clearSkeletonCache(): void {
  skeletonCache.clear();
}

function graphSkeleton(text: string, graph: StructureGraphV2): DiscoveredNodes {
  const offsets = documentScalarOffsets(text);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const depth = (id: string): number => byId.get(id)?.parent_id
    ? depth(byId.get(id)!.parent_id!) + 1
    : 0;
  const schedules: string[] = [];
  const nodes = graph.nodes.flatMap((node): SkeletonNode[] => {
    if (node.kind !== "section" || !node.label) return [];
    if (node.content_start === undefined) throw new Error(`Shared structure node ${node.label} omitted content_start`);
    const kind: SkeletonNodeKind = node.label.startsWith("art")
      ? "article"
      : node.label.startsWith("part")
        ? "part"
        : node.label.startsWith("div")
          ? "division"
          : /^(?:sched|exh|annex|app)/u.test(node.label)
            ? "schedule"
            : node.label.includes("(")
              ? "subsection"
              : "section";
    const contentStart = offsets.scalarToUtf16(node.content_start);
    const start = offsets.scalarToUtf16(node.range.start);
    const rawHeading = text.slice(contentStart).split("\n", 1)[0];
    const rawHead = text.slice(start, contentStart).trim();
    const head = rawHead.replace(/[—–\-.:]+\s*$/u, "").trim();
    const scheduleHead = kind === "schedule"
      ? rawHead.match(
        /^(SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix)\s+([A-Z0-9][\w.\-]*)/u,
      )
      : null;
    const scheduleName = scheduleHead ? `${scheduleHead[1]} ${scheduleHead[2]}` : head;
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    const inlineSubsection = kind === "subsection" && parent !== undefined &&
      !text.slice(
        offsets.scalarToUtf16(parent.range.start),
        offsets.scalarToUtf16(node.range.start),
      ).includes("\n");
    const display = kind === "section" || kind === "subsection"
      ? node.label.replace(/^sec/u, "Section ")
      : (kind === "schedule" ? scheduleName : head)
        .replace(/^\S+/u, (word) => word.toUpperCase());
    if (kind === "schedule") schedules.push(scheduleName);
    return [{
      kind,
      label: node.label,
      display,
      heading: (inlineSubsection ? rawHeading.replace(/\r$/u, "") : rawHeading.trim())
        .slice(0, kind === "subsection" ? 80 : 120),
      depth: depth(node.id),
      start,
      end: offsets.scalarToUtf16(node.range.end),
      ...(parent?.label ? { parentLabel: parent.label } : {}),
    }];
  });
  const count = (code: string) => graph.diagnostics.filter((row) => row.code === code).length;
  return {
    nodes,
    schedules,
    ladder: {
      increments: count("instrument_ladder_increment"),
      levelOpens: count("instrument_ladder_level_open"),
      midcounterOpens: count("instrument_ladder_midcounter_open"),
      forwardJumps: count("instrument_ladder_forward_jump"),
      restarts: count("instrument_ladder_restart"),
      violations: count("instrument_ladder_violation"),
    },
  };
}

async function compileAgreementSkeletonUncached(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): Promise<AgreementSkeleton> {
  const lines = splitLines(text);
  const hypotheses =
    options.reconstructLineation === false ? [text] : lineationHypotheses(text);
  const inputs = hypotheses.map((hypothesis, index) => ({
    provider: null,
    id: `${id || "legal-text"}#lineation-${index}`,
    text: maskTableCells(hypothesis, options.tableCells ?? []),
    providerRevision: "legal-text-skeleton-v5",
    scope: { kind: "complete" as const },
    profile: "instrument" as const,
    allowHyphenatedSections: false,
    order: "legislation" as const,
  }));
  const references = hypotheses.length > 1
    ? findProvisionReferences(text).flatMap((reference) => {
        if (reference.external) return [];
        const key = reference.shape === "roman" ? reference.aliasKey : reference.locator;
        return key ? [{ key, start: reference.start, end: reference.end }] : [];
      })
    : [];
  const chosen = deriveInstrumentSourceStructure(inputs, text, references);
  const best = graphSkeleton(chosen.materialized.evidence.text, chosen.graph);
  const { schedules, ladder } = best;
  const nodes = addTableNodes(text, best.nodes, options.tableCells ?? []);

  const doc = createSourceDoc({
    provider: null,
    id,
    text,
    blocks: nodes
      .filter(
        (node) =>
          node.kind !== "table" && node.kind !== "row" && node.kind !== "cell",
      )
      .map(toBlock),
  });

  const lineTexts = lines.map((line) => line.text);
  const definedTerms = buildDefinedTerms(lineTexts, lines, nodes);
  const crossReferences = buildCrossReferences(text, doc);
  const { outline, refusal } = chosen.contents;

  return {
    nodes,
    doc,
    definedTerms,
    schedules,
    crossReferences,
    ladder,
    outline,
    outlineRefusal: refusal,
  };
}

function addTableNodes(
  text: string,
  provisions: SkeletonNode[],
  cells: readonly TableCellSpan[],
): SkeletonNode[] {
  if (!cells.length) return provisions;
  const seen = new Set<string>();
  const occupied = new Set<string>();
  const grouped = new Map<number, TableCellSpan[]>();
  for (const cell of cells) {
    const columnSpan = cell.columnSpan ?? 1;
    const rowSpan = cell.rowSpan ?? 1;
    if (
      !Number.isSafeInteger(cell.table) || cell.table < 1 ||
      !Number.isSafeInteger(cell.row) || cell.row < 1 ||
      !Number.isSafeInteger(cell.column) || cell.column < 1 ||
      !Number.isSafeInteger(columnSpan) || columnSpan < 1 ||
      !Number.isSafeInteger(rowSpan) || rowSpan < 1 ||
      !Number.isSafeInteger(cell.column + columnSpan - 1) ||
      !Number.isSafeInteger(cell.row + rowSpan - 1) ||
      !Number.isSafeInteger(cell.start) || cell.start < 0 ||
      !Number.isSafeInteger(cell.end) || cell.end < cell.start ||
      cell.end > text.length
    ) {
      throw new Error("Invalid table-cell coordinates or text bounds");
    }
    const label = `table:${cell.table}/row:${cell.row}/col:${cell.column}`;
    if (seen.has(label)) throw new Error(`Duplicate table-cell address: ${label}`);
    seen.add(label);
    for (let row = cell.row; row < cell.row + rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + columnSpan; column += 1) {
        const coordinate = `${cell.table}:${row}:${column}`;
        if (occupied.has(coordinate)) {
          throw new Error(`Overlapping table-cell address: ${label}`);
        }
        occupied.add(coordinate);
      }
    }
    const bucket = grouped.get(cell.table) ?? [];
    bucket.push({ ...cell, columnSpan, rowSpan });
    grouped.set(cell.table, bucket);
  }

  const added: SkeletonNode[] = [];
  for (const [tableNumber, rawCells] of [...grouped].sort((a, b) => a[0] - b[0])) {
    const tableCells = [...rawCells].sort(
      (a, b) => a.start - b.start || a.row - b.row || a.column - b.column,
    );
    const start = Math.min(...tableCells.map((cell) => cell.start));
    const end = Math.max(...tableCells.map((cell) => cell.end));
    const owner = provisions
      .filter((node) => node.start <= start && end <= node.end)
      .sort((a, b) => b.depth - a.depth)[0];
    const tableLabel = `table:${tableNumber}`;
    const tableName = tableCells.find((cell) => cell.tableName)?.tableName;
    const tableDisplay = tableName ? `Sheet ${tableName}` : `Table ${tableNumber}`;
    const tableNode: SkeletonNode = {
      kind: "table",
      label: tableLabel,
      display: tableDisplay,
      heading: "",
      depth: (owner?.depth ?? -1) + 1,
      start,
      end,
      parentLabel: owner?.label,
    };
    added.push(tableNode);
    const rows = new Map<number, TableCellSpan[]>();
    for (const cell of tableCells) {
      const row = rows.get(cell.row) ?? [];
      row.push(cell);
      rows.set(cell.row, row);
    }
    for (const [rowNumber, rawRowCells] of [...rows].sort(
      (a, b) => a[0] - b[0],
    )) {
      const rowCells = [...rawRowCells].sort(
        (a, b) => a.start - b.start || a.column - b.column,
      );
      const rowLabel = `${tableLabel}/row:${rowNumber}`;
      const rowNode: SkeletonNode = {
        kind: "row",
        label: rowLabel,
        display: `${tableDisplay}, row ${rowNumber}`,
        heading: "",
        depth: tableNode.depth + 1,
        start: Math.min(...rowCells.map((cell) => cell.start)),
        end: Math.max(...rowCells.map((cell) => cell.end)),
        parentLabel: tableLabel,
      };
      added.push(rowNode);
      for (const cell of rowCells) {
        const columnSpan = cell.columnSpan ?? 1;
        added.push({
          kind: "cell",
          label: `${rowLabel}/col:${cell.column}`,
          display:
            `${tableDisplay}, row ${cell.row}, column ${cell.column}` +
            (columnSpan > 1 ? `-${cell.column + columnSpan - 1}` : ""),
          heading: text
            .slice(cell.start, cell.end)
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 80),
          depth: rowNode.depth + 1,
          start: cell.start,
          end: cell.end,
          parentLabel: rowLabel,
        });
      }
    }
  }
  return [...provisions, ...added].sort(
    (a, b) => a.start - b.start || a.depth - b.depth,
  );
}

function toBlock(node: SkeletonNode): SourceDocBlock {
  // createSourceDoc treats a repeated index key as ambiguous and drops it,
  // so aliases must be deduped and never equal the label.
  const aliases = new Set<string>([node.display.toLowerCase()]);
  if (node.kind === "article" || node.kind === "part") {
    const value = node.label.replace(/^\D+/u, "");
    aliases.add(`${node.kind} ${toRoman(Number(value)).toLowerCase()}`);
  }
  aliases.delete(node.label.toLowerCase());
  return {
    kind: "section",
    label: node.label,
    start: node.start,
    end: node.end,
    origin: "heuristic",
    aliases: [...aliases],
    parentLabel: node.parentLabel,
  };
}

function toRoman(value: number): string {
  const table: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"],
    [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"],
    [5, "V"], [4, "IV"], [1, "I"],
  ];
  let rest = value;
  let out = "";
  for (const [amount, numeral] of table) {
    while (rest >= amount) {
      out += numeral;
      rest -= amount;
    }
  }
  return out || "I";
}

function buildDefinedTerms(
  lineTexts: string[],
  lines: Line[],
  nodes: SkeletonNode[],
): DefinedTermEntry[] {
  const terms = collectDefinedTerms(lineTexts);
  const entries: DefinedTermEntry[] = [];
  for (const [term, definedIn] of terms) {
    const offset = lines[definedIn[0]]?.start ?? 0;
    const owner = nodes
      .filter(
        (node) =>
          node.kind !== "article" &&
          node.kind !== "part" &&
          node.kind !== "table" &&
          node.kind !== "row" &&
          node.kind !== "cell" &&
          node.start <= offset &&
          offset < node.end,
      )
      .sort((a, b) => b.depth - a.depth)[0];
    entries.push({
      term,
      sectionLabel: owner?.label ?? null,
      definitions: definedIn.length,
    });
  }
  return entries.sort((a, b) => a.term.localeCompare(b.term));
}

const CROSS_REF_RE = /\b(?:Section|Sections|Clause)\s+(\d{1,3}(?:\.\d{1,3})*(?:\([a-zA-Z0-9]+\))*)/gu;

function buildCrossReferences(
  text: string,
  doc: SourceDoc,
): CrossReferenceSummary {
  let internal = 0;
  let external = 0;
  const unresolved = new Set<string>();
  for (const match of text.matchAll(CROSS_REF_RE)) {
    const following = text.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 40,
    );
    if (isExternalReference(following)) {
      external += 1;
      continue;
    }
    internal += 1;
    const label = `sec${match[1]}`;
    if (!doc.index.has(label.toLowerCase())) unresolved.add(match[1]);
  }
  return {
    internal,
    external,
    unresolved: [...unresolved].sort().slice(0, 64),
  };
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/**
 * Resolve a user-facing locator ("Section 8.01(a)", "8.01", "s. 2.05",
 * "Article VIII", "Schedule 7.01") against the skeleton.
 */
export function readSection(
  skeleton: AgreementSkeleton,
  locator: string,
  contextBlocks = 0,
): SourceDocLookup {
  const tableLocator = locator.trim().toLowerCase();
  if (tableLocator.startsWith("table:")) {
    const available = skeleton.nodes.filter(
      (node) =>
        node.kind === "table" || node.kind === "row" || node.kind === "cell",
    );
    if (!available.length) {
      return {
        status: "unavailable",
        requestedLabel: tableLocator,
        matches: [],
        block: null,
        before: [],
        after: [],
      };
    }
    const selected = available.find(
      (node) => node.label.toLowerCase() === tableLocator,
    );
    if (!selected) {
      return {
        status: "not_found",
        requestedLabel: tableLocator,
        matches: [],
        block: null,
        before: [],
        after: [],
      };
    }
    const materialize = (node: SkeletonNode) => ({
      kind: "section" as const,
      label: node.label,
      start: node.start,
      end: node.end,
      origin: "native" as const,
      parentLabel: node.parentLabel,
      text: skeleton.doc.text.slice(node.start, node.end).trim(),
    });
    const order = available.indexOf(selected);
    const context = Math.min(Math.max(Math.trunc(contextBlocks), 0), 2);
    return {
      status: "found",
      requestedLabel: tableLocator,
      matches: [selected.label],
      block: materialize(selected),
      before: available
        .slice(Math.max(0, order - context), order)
        .map(materialize),
      after: available
        .slice(order + 1, order + 1 + context)
        .map(materialize),
    };
  }
  const normalized = normalizeSourceDocLocator("section", locator);
  if (normalized) {
    const found = lookupSourceDocLabel(
      skeleton.doc,
      "section",
      normalized,
      contextBlocks,
    );
    // Preserve an ambiguity discovered by normalization. Retrying the raw
    // spelling (for example 8.03 after sec8.03 matched a TOC and body) turns
    // a useful fail-closed result into the false claim "not found".
    if (found.status !== "not_found") return found;
  }
  return lookupSourceDocLabel(
    skeleton.doc,
    "section",
    locator.trim().toLowerCase(),
    contextBlocks,
  );
}
