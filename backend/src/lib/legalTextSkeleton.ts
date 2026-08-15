/**
 * Agreement/statute skeleton compiler: parses the native numbering hierarchy
 * of legal text (ARTICLE/PART containers, Section N.NN, "8. (1)" statute
 * sections, (a)/(i)/(A)/(1) enumeration ladders, Schedules/Exhibits) into
 * SourceDoc blocks, so local Library documents join legislation and case law
 * on the same structural plane: lookup, slicing, and quote verification all
 * come from sourceDoc.ts unchanged.
 *
 * Legal drafting is the one prose genre that ships its own AST — definitions
 * are a symbol table, "Section 8.01(f)" references are edges, schedules are
 * data segments. Parsing it is regex work over line starts, not model work.
 * Marker guards mirror docxStructuralLint's collectors (bare integers stay
 * small and need a terminator; decimal headings need a heading-like
 * continuation), and defined-term collection is the lint's own exported
 * collector, so reading-side navigation and authoring-side QA cannot drift
 * apart.
 *
 * Labels speak the shared locator dialect ("sec8.01(a)", like the A2AJ
 * compilers), so normalizeSourceDocLocator-accepted user input ("Section
 * 8.01(a)", "s. 8.01(a)", "8.01(a)") resolves directly; containers and
 * schedules resolve through aliases ("article viii", "schedule 7.01").
 */

import {
  collectDefinedTerms,
  isExternalReference,
  romanToInt,
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
  type ProvisionReference,
} from "./legalReferenceGrammar";
import { computeStatuteSpine } from "./statuteSpine";

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

/** Labels in the explicit parent chain rooted at `seedLabel`. */
export function skeletonSubtreeLabels(
  skeleton: Pick<AgreementSkeleton, "nodes">,
  seedLabel: string,
): Set<string> {
  const byLabel = new Map(skeleton.nodes.map((node) => [node.label, node]));
  const labels = new Set<string>();
  for (const node of skeleton.nodes) {
    let current: SkeletonNode | undefined = node;
    const seen = new Set<string>();
    while (current && !seen.has(current.label)) {
      seen.add(current.label);
      if (current.label === seedLabel) {
        labels.add(node.label);
        break;
      }
      current = current.parentLabel ? byLabel.get(current.parentLabel) : undefined;
    }
  }
  return labels;
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
  /**
   * The document's own table of contents, read as an OUTLINE — a separate
   * product from `nodes`, never merged into it. Null when no contents region
   * is identifiable, in which case `outlineRefusal` says why. See
   * `readContentsOutline`.
   */
  outline: ContentsOutline | null;
  outlineRefusal: ContentsRefusal | null;
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

/**
 * The head vocabularies live here as named constants because TWO things
 * consume them: the per-line matchers below, and the segmentation recovery
 * that has to know where a head COULD begin. A recovery carrying its own
 * copy of the vocabulary would silently stop following the detector the
 * first time a jurisdiction, era or house style added a word — the same
 * drift `legalReferenceGrammar` was extracted to end.
 */
const CONTAINER_WORDS = "ARTICLE|Article|PART|Part|DIVISION|Division";
const SCHEDULE_WORDS =
  "SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix";
const SECTION_WORDS = "Section|SECTION";
/** the numeric part of a decimal head, shared with SECTION_DECIMAL_RE */
const DECIMAL_LABEL = String.raw`\d{1,3}\.\d{1,3}(?:\.\d{1,3})*`;

const CONTAINER_RE = new RegExp(
  String.raw`^(${CONTAINER_WORDS})\s+([IVXLCDM]+|\d{1,3})\b\s*[—–\-.:]?\s*(.*)$`,
  "u",
);
const SECTION_WORD_RE = new RegExp(
  String.raw`^(?:${SECTION_WORDS})\s+(\d{1,3}(?:\.\d{1,3})*[A-Za-z]?)[.)]?\s*[—–\-:]?\s*(.*)$`,
  "u",
);
const SECTION_DECIMAL_RE = new RegExp(
  String.raw`^(${DECIMAL_LABEL})\s+(\S.*)$`,
  "u",
);
const SECTION_INTEGER_RE = /^(\d{1,3})[.)]\s+(.*)$/u;
/**
 * Corpus-style dotless head for spine-less texts: a single provision
 * excerpt ("164 (1) A judge may...") has too few marks to form a spine,
 * but a bare number followed by a parenthesized digit is a subsection
 * marker no year, price, or page number produces.
 */
const SECTION_BARE_SUBSECTION_RE = /^(\d{1,3}(?:\.\d{1,3}){0,3})[ \t]+(?=\(\d)/u;
const SCHEDULE_RE = new RegExp(
  String.raw`^(${SCHEDULE_WORDS})\s+([A-Z0-9][\w.\-]*)\s*[—–\-.:]?\s*(.*)$`,
  "u",
);
const ENUM_RE =
  /^\((\d{1,3}|[a-z]{1,2}|[ivxlcdm]{1,6}|[A-Z]{1,2}|[IVXLCDM]{1,6})\)\s*(.*)$/u;
/**
 * Contract drafting's two unbracketed enumerator dialects. `a) ...` is what a
 * PDF extractor leaves when the opening bracket is lost, and what a drafter
 * writes who never typed it; `a.` / `iv.` is the dotted convention (also
 * Ontario's sub-paragraph ladder). Both require same-line content, mirroring
 * the ALR SECTION_MARK_RE lookahead: a bare `a)` line is not an enumerator.
 *
 * Neither dialect carries digits or capitals, and that is a corpus decision,
 * not caution: across 6,123 documents every one of the 105 `N)` lines is
 * already claimed by SECTION_INTEGER_RE above, and `A)` occurs once in the
 * whole corpus. Restricting to lowercase alpha/roman also makes the dialect
 * candidate set provably DISJOINT from the section-head set — every section
 * grammar here needs a digit or a container/schedule word — so these forms
 * can only ever add subsections, never move a section.
 */
const ENUM_TAIL_RE = /^([a-z]{1,2}|[ivxlcdm]{1,6})\)[ \t]+(\S.*)$/u;
const ENUM_DOT_RE = /^([a-z]{1,2}|[ivxlcdm]{1,6})\.[ \t]+(\S.*)$/u;

/** "12.", "12.1" heading guards, mirroring collectNumberAnchors. */
const headingLike = (rest: string) => rest === "" || /^["'“(A-Z]/u.test(rest);

// ---------------------------------------------------------------------------
// Enumeration ladders with (h)->(i) disambiguation
// ---------------------------------------------------------------------------

type EnumFamily =
  | "digit"
  | "lower-alpha"
  | "lower-roman"
  | "upper-alpha"
  | "upper-roman";

interface EnumFrame {
  family: EnumFamily;
  value: number;
  /** full label of this frame's latest item, e.g. "sec8.01(a)" */
  label: string;
  depth: number;
}

interface EnumInterpretation {
  family: EnumFamily;
  value: number;
}

const MAX_LADDER_DEPTH = 6;

const isRomanToken = (token: string) => /^[ivxlcdm]{1,6}$/u.test(token);

function alphaValue(token: string): number | null {
  if (/^[a-z]$/u.test(token)) return token.charCodeAt(0) - 96;
  // doubling convention: (z) -> (aa) -> (bb)
  if (/^([a-z])\1$/u.test(token)) return 26 + (token.charCodeAt(0) - 96);
  return null;
}

/**
 * Ordered readings of one enumerator token, alphabet reading first. The
 * resolver below is a port of Text-Fidelity's counter-stack parse
 * (tools/ocr/layout_regioning/heading_grammar_inventory.py,
 * parse_heading_ladder): strict increments are tried across ALL readings
 * before any level opens, so "(i)" after "(h)" increments the alphabet
 * ladder while a fresh "(i)" opens a roman one — the classic disambiguation
 * emerges from pass order instead of special cases. Forward jumps and
 * mid-counter opens are tolerated as gaps (amendments delete clauses; lists
 * open mid-paragraph); value-1 arrivals on a live frame are restarts;
 * backward values are violations. Gap POLICING stays in docxStructuralLint.
 */
function interpretationsOf(token: string): EnumInterpretation[] {
  if (/^\d+$/u.test(token)) return [{ family: "digit", value: Number(token) }];
  const lower = token.toLowerCase();
  const isUpper = token !== lower;
  const alpha = alphaValue(lower);
  const roman = isRomanToken(lower) ? romanToInt(lower.toUpperCase()) : null;
  const alphaReading: EnumInterpretation | null =
    alpha !== null
      ? { family: isUpper ? "upper-alpha" : "lower-alpha", value: alpha }
      : null;
  const romanReading: EnumInterpretation | null =
    roman !== null
      ? { family: isUpper ? "upper-roman" : "lower-roman", value: roman }
      : null;
  // Single characters read alphabet-first (the (h)->(i) convention). For
  // multi-character tokens the readings are exclusive: "(ii)"/"(xx)" are
  // roman in real drafting (roman lists stay small, so value <= 50), while
  // "(aa)"/"(bb)" — and roman-invalid or implausibly large doubles like
  // "(cc)" = 200 — are the post-(z) alphabet doubling convention.
  if (lower.length > 1) {
    if (romanReading && romanReading.value <= 50) return [romanReading];
    if (alphaReading) return [alphaReading];
    return romanReading ? [romanReading] : [];
  }
  return [alphaReading, romanReading].filter(
    (reading): reading is EnumInterpretation => reading !== null,
  );
}

type EnumDialect = "tail" | "dot";

/**
 * Document-level admission for the unbracketed dialects — the same shape of
 * argument statuteSpine makes for bare-number section heads, one level down.
 * No surface guard can tell an enumerator from an abbreviation: `Inc.`, `No.`,
 * `v.` and `s. 231` are all lowercase-token-plus-dot at a line start. What
 * they cannot do is RUN. A real ladder opens at value 1 and climbs
 * monotonically in one family, so admission asks exactly that: a strictly
 * increasing run of at least MIN_DIALECT_RUN readings (amendments delete
 * items, so a gap of up to two is tolerated inside a live run) opening at
 * value 1. The readings come from `interpretationsOf`, so the dialects
 * inherit the (h)->(i) alphabet/roman disambiguation unchanged.
 *
 * Candidates exclude anything the canonical bracketed form already claims, so
 * a document that enumerates properly never has its ladder reinterpreted.
 */
const MIN_DIALECT_RUN = 3;
const MAX_DIALECT_GAP = 2;

function longestOpeningRun(tokens: string[]): number {
  const live = new Map<EnumFamily, { last: number; run: number }>();
  let best = 0;
  for (const token of tokens) {
    for (const reading of interpretationsOf(token)) {
      const state = live.get(reading.family) ?? { last: 0, run: 0 };
      if (reading.value === 1) {
        state.last = 1;
        state.run = 1;
      } else if (
        state.run > 0 &&
        reading.value > state.last &&
        reading.value - state.last <= MAX_DIALECT_GAP
      ) {
        state.last = reading.value;
        state.run += 1;
      }
      if (state.run > best) best = state.run;
      live.set(reading.family, state);
    }
  }
  return best;
}

function admitEnumDialects(lines: Line[]): ReadonlySet<EnumDialect> {
  const tokens: Record<EnumDialect, string[]> = { tail: [], dot: [] };
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || ENUM_RE.test(text)) continue;
    const tail = text.match(ENUM_TAIL_RE);
    if (tail) {
      tokens.tail.push(tail[1]);
      continue;
    }
    const dot = text.match(ENUM_DOT_RE);
    if (dot) tokens.dot.push(dot[1]);
  }
  const admitted = new Set<EnumDialect>();
  for (const dialect of ["tail", "dot"] as const) {
    if (longestOpeningRun(tokens[dialect]) >= MIN_DIALECT_RUN) {
      admitted.add(dialect);
    }
  }
  return admitted;
}

/** The enumerator on a line, in whichever dialect the document earned. */
function matchEnumerator(
  text: string,
  dialects: ReadonlySet<EnumDialect>,
): RegExpMatchArray | null {
  return (
    text.match(ENUM_RE) ??
    (dialects.has("tail") ? text.match(ENUM_TAIL_RE) : null) ??
    (dialects.has("dot") ? text.match(ENUM_DOT_RE) : null)
  );
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

function discoverNodes(
  text: string,
  tableCells: readonly TableCellSpan[] = [],
): DiscoveredNodes {
  const lines = splitLines(text);
  const structuralText = maskTableCells(text, tableCells);
  const excluded = [...tableCells].sort((a, b) => a.start - b.start);
  let excludedAt = 0;
  const nodes: SkeletonNode[] = [];
  const schedules: string[] = [];
  // Statute-style bare-number heads ("164 (1) Every one...") are decided by
  // a document-level scope competition, not per-line guards; when a spine
  // wins, it owns bare-number section detection and the per-line regexes
  // below only handle the styles it cannot claim (word/container/schedule).
  const spine = computeStatuteSpine(structuralText);
  const spineByStart = new Map(spine.map((mark) => [mark.start, mark]));
  const dialects = admitEnumDialects(splitLines(structuralText));

  let container: SkeletonNode | null = null;
  let section: SkeletonNode | null = null;
  let enumStack: EnumFrame[] = [];
  const ladder: LadderDiagnostics = {
    increments: 0,
    levelOpens: 0,
    midcounterOpens: 0,
    forwardJumps: 0,
    restarts: 0,
    violations: 0,
  };
  const usedLabels = new Set<string>();

  const push = (node: SkeletonNode) => {
    nodes.push(node);
    return node;
  };

  const frameIndex = (family: EnumFamily) => {
    for (let i = enumStack.length - 1; i >= 0; i -= 1) {
      if (enumStack[i].family === family) return i;
    }
    return -1;
  };

  const uniqueLabel = (base: string) => {
    if (!usedLabels.has(base)) return base;
    let occurrence = 2;
    while (usedLabels.has(`${base}@${occurrence}`)) occurrence += 1;
    return `${base}@${occurrence}`;
  };

  const pushSubsection = (
    label: string,
    parentLabel: string,
    depth: number,
    lineStart: number,
    rest: string,
  ) => {
    usedLabels.add(label);
    push({
      kind: "subsection",
      label,
      display: label.replace(/^sec/u, "Section "),
      heading: rest.slice(0, 80),
      depth,
      start: lineStart,
      end: text.length,
      parentLabel,
    });
  };

  const openEnum = (token: string, lineStart: number, rest: string) => {
    if (!section) return;
    const sectionLabel = section.label;
    const sectionDepth = section.depth;
    const readings = interpretationsOf(token);
    if (!readings.length) return;

    // Pass 1 — strict increment on a live frame (pops deeper frames).
    for (const reading of readings) {
      const at = frameIndex(reading.family);
      if (at >= 0 && enumStack[at].value + 1 === reading.value) {
        enumStack.length = at + 1;
        const frame = enumStack[at];
        frame.value = reading.value;
        const parentLabel = at > 0 ? enumStack[at - 1].label : sectionLabel;
        const label = uniqueLabel(`${parentLabel}(${token})`);
        frame.label = label;
        ladder.increments += 1;
        pushSubsection(label, parentLabel, frame.depth, lineStart, rest);
        return;
      }
    }
    // Pass 2 — fresh level opening at value 1.
    for (const reading of readings) {
      if (
        reading.value === 1 &&
        frameIndex(reading.family) < 0 &&
        enumStack.length < MAX_LADDER_DEPTH
      ) {
        const parent = enumStack[enumStack.length - 1];
        const parentLabel = parent ? parent.label : sectionLabel;
        const depth = (parent ? parent.depth : sectionDepth) + 1;
        const label = uniqueLabel(`${parentLabel}(${token})`);
        enumStack.push({ family: reading.family, value: 1, label, depth });
        ladder.levelOpens += 1;
        pushSubsection(label, parentLabel, depth, lineStart, rest);
        return;
      }
    }
    // Pass 3 — restart (value 1 on a live frame) or forward jump (gap).
    for (const reading of readings) {
      const at = frameIndex(reading.family);
      if (at < 0) continue;
      const isRestart = reading.value === 1;
      if (isRestart || reading.value > enumStack[at].value + 1) {
        enumStack.length = at + 1;
        const frame = enumStack[at];
        frame.value = reading.value;
        const parentLabel = at > 0 ? enumStack[at - 1].label : sectionLabel;
        const label = uniqueLabel(`${parentLabel}(${token})`);
        frame.label = label;
        if (isRestart) ladder.restarts += 1;
        else ladder.forwardJumps += 1;
        pushSubsection(label, parentLabel, frame.depth, lineStart, rest);
        return;
      }
    }
    // Pass 4 — mid-counter open: a list that began mid-paragraph surfaces
    // at a line start partway through ("(b) ... (i) Asset Sales." then
    // "(ii)" on its own line).
    for (const reading of readings) {
      if (
        frameIndex(reading.family) < 0 &&
        enumStack.length < MAX_LADDER_DEPTH
      ) {
        const parent = enumStack[enumStack.length - 1];
        const parentLabel = parent ? parent.label : sectionLabel;
        const depth = (parent ? parent.depth : sectionDepth) + 1;
        const label = uniqueLabel(`${parentLabel}(${token})`);
        enumStack.push({
          family: reading.family,
          value: reading.value,
          label,
          depth,
        });
        ladder.midcounterOpens += 1;
        pushSubsection(label, parentLabel, depth, lineStart, rest);
        return;
      }
    }
    // Backward value on a live ladder: disorder, not structure. The stack
    // stays untouched; the node still lands, occurrence-suffixed, so its
    // text stays addressable.
    ladder.violations += 1;
    const label = uniqueLabel(`${sectionLabel}(${token})`);
    pushSubsection(label, sectionLabel, sectionDepth + 1, lineStart, rest);
  };

  for (const line of lines) {
    const trimmedLine = line.text.trim();
    if (!trimmedLine) continue;
    const lineStart = line.start + (line.text.length - line.text.trimStart().length);
    while (excluded[excludedAt]?.end <= lineStart) excludedAt += 1;
    if (
      excluded[excludedAt]?.start <= lineStart &&
      lineStart < excluded[excludedAt].end
    ) {
      continue;
    }

    const containerMatch = trimmedLine.match(CONTAINER_RE);
    if (containerMatch) {
      const word = containerMatch[1].toLowerCase();
      const numberToken = containerMatch[2];
      const value = /^\d+$/u.test(numberToken)
        ? Number(numberToken)
        : romanToInt(numberToken.toUpperCase());
      if (value !== null) {
        const kind = (
          word === "article" ? "article" : word === "part" ? "part" : "division"
        ) as SkeletonNodeKind;
        const prefix = kind === "article" ? "art" : kind === "part" ? "part" : "div";
        container = push({
          kind,
          label: `${prefix}${value}`,
          display: `${containerMatch[1].toUpperCase()} ${numberToken}`,
          heading: containerMatch[3].trim().slice(0, 120),
          depth: 0,
          start: lineStart,
          end: text.length,
        });
        section = null;
        enumStack = [];
        continue;
      }
    }

    const scheduleMatch = trimmedLine.match(SCHEDULE_RE);
    if (scheduleMatch) {
      const word = scheduleMatch[1].toLowerCase();
      const prefix =
        word === "schedule"
          ? "sched"
          : word === "exhibit"
            ? "exh"
            : word === "annex"
              ? "annex"
              : "app";
      const label = `${prefix}${scheduleMatch[2].toLowerCase()}`;
      // Schedule references in prose ("as set forth on Schedule 7.01") are
      // not headings: require a heading-like or empty continuation.
      if (!headingLike(scheduleMatch[3])) {
        // fall through to other matchers
      } else {
        container = push({
          kind: "schedule",
          label,
          display: `${scheduleMatch[1].toUpperCase()} ${scheduleMatch[2]}`,
          heading: scheduleMatch[3].trim().slice(0, 120),
          depth: 0,
          start: lineStart,
          end: text.length,
        });
        schedules.push(`${scheduleMatch[1]} ${scheduleMatch[2]}`);
        section = null;
        enumStack = [];
        continue;
      }
    }

    const spineMark = spineByStart.get(lineStart);
    if (spineMark) {
      const content = line.text.slice(spineMark.contentStart - line.start);
      section = push({
        kind: "section",
        label: `sec${spineMark.label}`,
        display: `Section ${spineMark.label}`,
        heading: content.trim().slice(0, 120),
        depth: container ? 1 : 0,
        start: lineStart,
        end: text.length,
        parentLabel: container?.label,
      });
      enumStack = [];
      const inline = content.match(ENUM_RE);
      if (inline) openEnum(inline[1], spineMark.contentStart, inline[2]);
      continue;
    }

    // A winning spine owns section detection outright: per-line acceptance
    // would readmit exactly what the competition rejected — years, page
    // numbers, cross-reference lists, and "Section N" print running heads.
    const sectionWordMatch = spine.length
      ? null
      : trimmedLine.match(SECTION_WORD_RE);
    const sectionDecimalMatch =
      sectionWordMatch || spine.length
        ? null
        : trimmedLine.match(SECTION_DECIMAL_RE);
    const sectionIntegerMatch =
      sectionWordMatch || sectionDecimalMatch || spine.length
        ? null
        : trimmedLine.match(SECTION_INTEGER_RE);
    const sectionBareMatch =
      sectionWordMatch || sectionDecimalMatch || sectionIntegerMatch || spine.length
        ? null
        : trimmedLine.match(SECTION_BARE_SUBSECTION_RE);
    let sectionNumber: string | null = null;
    let sectionHeading = "";
    if (sectionWordMatch && headingLike(sectionWordMatch[2])) {
      // The guard rejects prose lines that merely BEGIN with a reference
      // ("Section 2.05 provides that ..."): true headings continue with a
      // capital, a quote, a parenthetical, or nothing.
      sectionNumber = sectionWordMatch[1];
      sectionHeading = sectionWordMatch[2];
    } else if (sectionDecimalMatch && headingLike(sectionDecimalMatch[2])) {
      sectionNumber = sectionDecimalMatch[1];
      sectionHeading = sectionDecimalMatch[2];
    } else if (
      sectionIntegerMatch &&
      Number(sectionIntegerMatch[1]) <= 500 &&
      sectionIntegerMatch[2].trim() !== "" &&
      headingLike(sectionIntegerMatch[2])
    ) {
      // Bare integers need a heading ("2. Definitions"): a lone "23." line
      // is a page number, not a section.
      sectionNumber = sectionIntegerMatch[1];
      sectionHeading = sectionIntegerMatch[2];
    } else if (sectionBareMatch) {
      sectionNumber = sectionBareMatch[1];
      sectionHeading = trimmedLine.slice(sectionBareMatch[0].length);
    }
    if (sectionNumber) {
      section = push({
        kind: "section",
        label: `sec${sectionNumber}`,
        display: `Section ${sectionNumber}`,
        heading: sectionHeading.trim().slice(0, 120),
        depth: container ? 1 : 0,
        start: lineStart,
        end: text.length,
        parentLabel: container?.label,
      });
      enumStack = [];
      // Statute style puts the first subsection on the section line:
      // "8. (1) A judge may...".
      const inline = sectionHeading.match(ENUM_RE);
      if (inline) {
        openEnum(
          inline[1],
          lineStart + trimmedLine.indexOf(`(${inline[1]})`),
          inline[2],
        );
      }
      continue;
    }

    // Last branch in the loop: a line only reaches the ladder after every
    // container, schedule, spine and section matcher has declined it, so a
    // new enumerator dialect cannot move a section boundary.
    const enumMatch = matchEnumerator(trimmedLine, dialects);
    if (enumMatch && section) {
      openEnum(enumMatch[1], lineStart, enumMatch[2]);
    }
  }

  closeSpans(nodes, text.length);
  return { nodes, schedules, ladder };
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
 * Recovery is OFFSET-EXACT by construction: the first space of an internal
 * run is replaced by a newline and the rest of the run is kept, so the
 * recovered text is the same length as the original, character for
 * character, and differs from it only in whitespace. Every offset a node
 * discovered over it carries is therefore a valid offset in the original,
 * and the SourceDoc, defined terms and quote verification below are all
 * built from the ORIGINAL text regardless of which segmentation won.
 */
function recoverSpaceRuns(text: string): string {
  return text.replace(
    /(?<=\S)[ \t]([ \t]+)(?=\S)/gu,
    (_match, rest: string) => `\n${rest}`,
  );
}

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
const HEAD_WORD = `(?:${CONTAINER_WORDS}|${SECTION_WORDS}|${SCHEDULE_WORDS})`;
/**
 * A terminator is whatever ends a printed line before a heading. Kept wide
 * on purpose — a full stop, a semicolon or colon in older drafting, and any
 * closing quote or bracket after one — because the point of the guard is the
 * ANTECEDENT, not the punctuation dialect.
 */
const SENTENCE_JOIN_RE = new RegExp(
  String.raw`(?<=[.;:][)\]"'”’»]?)[ \t]` +
    String.raw`(?=${HEAD_WORD}\s+[IVXLCDM\d]|${DECIMAL_LABEL}\s+\S|\(\w{1,3}\)\s)`,
  "gu",
);

function recoverSentenceJoins(text: string): string {
  return text.replace(SENTENCE_JOIN_RE, "\n");
}

/**
 * A real inventory of heads runs the length of the instrument. A table of
 * contents repeats every label inside a compressed prefix, and space-run
 * recovery reveals it preferentially — a contents line is padded with runs,
 * a body heading usually is not. Measured over the 69 mini documents the
 * separation is not close: the head span of a contents-only inventory is
 * 0.0077, 0.0079, 0.0083, 0.0122 of the document, the next inventory up is
 * 0.1237 and real ones run 0.30-1.00. The gate sits in that 10x gap.
 *
 * This is `passesSpineGuards`' startRatio guard at the other end of the
 * document, and it is why Boingo Wireless and Anworth keep their thin
 * as-extracted reading: 80 and 99 contents entries that resolve beautifully
 * to each other are not this document's structure, and following one would
 * land a reader on a page number.
 */
const MIN_HEAD_SPAN = 0.05;

function headSpan(nodes: SkeletonNode[], length: number): number {
  if (!length) return 0;
  let low = Number.POSITIVE_INFINITY;
  let high = -1;
  for (const node of nodes) {
    if (node.kind !== "section") continue;
    if (node.start < low) low = node.start;
    if (node.start > high) high = node.start;
  }
  return high < 0 ? 0 : (high - low) / length;
}

// ---------------------------------------------------------------------------
// The contents page as an OUTLINE
// ---------------------------------------------------------------------------

/**
 * A contents page is a legitimate OUTLINE and an illegitimate SPAN INDEX.
 *
 * `MIN_HEAD_SPAN` above is right to refuse a contents-only inventory as this
 * document's structure — following one lands a reader on a page number. But
 * refusing it as a span index threw away a real inventory: measured on the 69
 * LegalBench-RAG mini documents, Boingo Wireless compiles 13 titled section
 * heads and its contents page names 96 provisions; Cimarex (hold-out) compiles
 * 16 and names 109. So the contents reading is kept, as a SEPARATE product
 * that carries no offsets into the provisions it names.
 *
 * Three properties make the split safe:
 *
 *   - `nodes` never sees it. This reader runs on the ORIGINAL text, outside
 *     the segmentation competition, and its output is never merged in.
 *   - An entry has no span. `contentsLineStart` is the offset of the contents
 *     LINE; a consumer that wants the provision's text must resolve `label`
 *     through the real node inventory (`readSection`) or fail.
 *   - It carries the page the contents cites, which is the thing a
 *     page-addressed reader needs and the thing a span index cannot give.
 *
 * Refusal beats guessing (CLAUDE.md rule 5): with no identifiable contents
 * region the result is a typed refusal, not a low-confidence outline.
 */
export type ContentsRefusal =
  /** the document never says it has a table of contents */
  | "no_contents_marker"
  /** the marker is there, but no entry grammar follows it */
  | "no_contents_entries"
  /** an entry run too short to be an inventory */
  | "too_few_contents_entries"
  /** entries that cite no pages: a clause list, not a contents page */
  | "contents_without_page_numbers";

export interface ContentsEntry {
  /** shared locator dialect, joinable to `SkeletonNode.label` ("sec8.01", "art8") */
  label: string;
  display: string;
  heading: string;
  depth: number;
  parentLabel?: string;
  /** the page this contents line cites, or null when it cites none */
  page: number | null;
  /**
   * Offset of the CONTENTS LINE — deliberately NOT a provision span, and
   * deliberately not a `start`/`end` pair. The contents entry knows where the
   * document ADVERTISES the provision, never where the provision is.
   */
  contentsLineStart: number;
}

export interface ContentsOutline {
  entries: ContentsEntry[];
  /** span of the contents region itself (the contents page), never a provision */
  regionStart: number;
  regionEnd: number;
  /** how many entries cite a page number */
  pagesCited: number;
}

/**
 * The document saying it has a contents page. "TABLE OF CONTENTS" anywhere
 * (SEC filings repeat it as a running header, so the first one is taken and
 * later ones are fallbacks), or a bare CONTENTS/INDEX alone on its line —
 * standing alone is what separates the heading from the 84 documents here
 * whose only "contents" is the prose of a headings-are-for-convenience clause.
 */
const CONTENTS_ANCHOR_RE =
  /(?:(?<=^|[\r\n\t ])TABLE[ \t]+OF[ \t]+CONTENTS(?=[\r\n\t ]|$)|(?<=^|[\r\n])[ \t]*(?:CONTENTS|INDEX)[ \t]*(?=[\r\n]|$))/giu;

/**
 * A contents entry begins with a head in the same vocabularies the body
 * grammars use, so the outline cannot drift from the span compiler. Entries
 * are cut at the heads themselves rather than at line starts because the four
 * extraction dialects in the corpus disagree about where an entry ends: packed
 * into one line with single spaces (Alexion), separated by space runs (CAI),
 * one token per cell (Constellation), or broken mid-entry (Anworth). All four
 * agree that a head starts one and the previous one ends there.
 *
 * Schedule/exhibit heads need a line start or a space run in front of them.
 * They are the one vocabulary that also appears INSIDE contents titles ("1.2
 * Company Consent; Schedule 14D-9 5"), and admitting those mid-title cost
 * Acceleron half its outline (55 entries instead of 107) before the guard.
 *
 * A bare integer needs a terminator ("1." not "1"), because in a contents
 * region an un-terminated integer is far more often the PAGE of the previous
 * entry. The cost is measured and accepted: 1 of 124 documents (AfriGIS, a
 * dot-leader NDA whose entries read "1 INTERPRETATION ..... 3") refuses
 * entirely for want of it, and one more loses its top level.
 */
const CONTENTS_HEAD_RE = new RegExp(
  String.raw`(?:^|\s)(?:` +
    String.raw`(${CONTAINER_WORDS})[ \t]+([IVXLCDM]{1,7}|\d{1,3})[.:]?` +
    String.raw`|(?<=[\r\n]|[ \t]{2})(${SCHEDULE_WORDS})[ \t]+([A-Z0-9][\w.\-]{0,12}?)[.:]?` +
    String.raw`|(?:${SECTION_WORDS})[ \t]+(\d{1,3}(?:\.\d{1,3})*[A-Za-z]?)[.)]?` +
    String.raw`|(${DECIMAL_LABEL})[.)]?` +
    String.raw`|(\d{1,3})[.)]` +
    String.raw`)(?=[ \t\r\n]|$)`,
  "gu",
);

/**
 * An entry's own line ends at the first blank line. Printed page footers land
 * between contents lines ("... Publicity 65 <blank> 2 <blank> Section 6.4"),
 * and absorbing that "2" as the entry's page reads as a page DECREASE — which
 * cost Cantel and Columbia a third of their outlines before this cut.
 */
const CONTENTS_UNIT_END_RE = /[^\S\n]*\n[^\S\n]*\n/u;

/** the page a contents line cites, always its last token */
const CONTENTS_PAGE_RE = /(?:^|\s)(\d{1,4})$/u;

/**
 * Contents lines are SHORT — that is what separates an inventory from the
 * provisions it inventories. Measured over the 39 documents here that carry
 * one, the largest gap between consecutive entries INSIDE a contents region is
 * 28-176 characters, while the gap that ends one is 524-7,111. The threshold
 * is inert across that whole band: 200, 400 and 800 produce byte-identical
 * outlines on all 124 documents (3,786 entries), and only 3 documents move at
 * 1,600. The structural stops below, not this one, decide the boundary.
 */
const CONTENTS_MAX_ENTRY_GAP = 400;
/** contents pages sit at one place in a document; no need to read it all */
const CONTENTS_WINDOW = 80_000;
/** SEC filings repeat the running header; the real page is rarely past these */
const CONTENTS_MAX_ANCHORS = 4;
const MIN_CONTENTS_ENTRIES = 5;
/**
 * A contents entry points at a page. A run of numbered heads that points
 * nowhere is the document itself, not its contents — this is the gate that
 * keeps a marker matched in prose from walking the body. Accepted regions here
 * cite pages on 0.84-1.00 of their entries.
 */
const MIN_CONTENTS_PAGE_SHARE = 0.6;
/** an exhibits list may close a contents page without pages; a body cannot */
const MAX_PAGELESS_RUN = 3;

interface ContentsHead {
  start: number;
  end: number;
  match: RegExpExecArray;
}

/**
 * Read one candidate region. Returns null when nothing entry-shaped follows
 * the marker at all; the caller applies the acceptance gates.
 */
function readContentsRegion(text: string, from: number): ContentsOutline | null {
  const region = text.slice(from, Math.min(text.length, from + CONTENTS_WINDOW));
  const heads: ContentsHead[] = [];
  CONTENTS_HEAD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTENTS_HEAD_RE.exec(region))) {
    const lead = match[0].length - match[0].trimStart().length;
    heads.push({ start: match.index + lead, end: match.index + match[0].length, match });
    CONTENTS_HEAD_RE.lastIndex = match.index + match[0].length;
  }
  if (!heads.length || heads[0].start > CONTENTS_MAX_ENTRY_GAP) return null;

  const entries: ContentsEntry[] = [];
  const byLabel = new Map<string, ContentsEntry>();
  let container: string | null = null;
  let previousPage = 0;
  let pageless = 0;
  let pagelessFrom = 0;
  let lastHead = -1;
  for (let i = 0; i < heads.length; i += 1) {
    // A contents line is short; a provision is not.
    if (i > 0 && heads[i].start - heads[i - 1].end > CONTENTS_MAX_ENTRY_GAP) break;
    const head = heads[i];
    const until =
      i + 1 < heads.length &&
      heads[i + 1].start - head.end <= CONTENTS_MAX_ENTRY_GAP
        ? heads[i + 1].start
        : Math.min(region.length, head.end + 200);
    const raw = region.slice(head.end, until);
    const cut = raw.search(CONTENTS_UNIT_END_RE);
    const unit = (cut < 0 ? raw : raw.slice(0, cut)).replace(/\s+/gu, " ").trim();
    const pageMatch = unit.match(CONTENTS_PAGE_RE);
    const page = pageMatch ? Number(pageMatch[1]) : null;
    // A contents page counts up. A lower page means this is no longer one.
    if (page !== null && page < previousPage) break;

    const found = head.match;
    let label: string;
    let display: string;
    let depth = 0;
    let parentLabel: string | undefined;
    if (found[1]) {
      const word = found[1].toLowerCase();
      const value = /^\d+$/u.test(found[2])
        ? Number(found[2])
        : romanToInt(found[2].toUpperCase());
      if (value === null) continue;
      const prefix = word === "article" ? "art" : word === "part" ? "part" : "div";
      label = `${prefix}${value}`;
      display = `${found[1].toUpperCase()} ${found[2]}`;
    } else if (found[3]) {
      const word = found[3].toLowerCase();
      const prefix =
        word === "schedule"
          ? "sched"
          : word === "exhibit"
            ? "exh"
            : word === "annex"
              ? "annex"
              : "app";
      label = `${prefix}${found[4].toLowerCase()}`;
      display = `${found[3].toUpperCase()} ${found[4]}`;
    } else {
      const number = (found[5] ?? found[6] ?? found[7] ?? "").replace(/\.$/u, "");
      if (!number) continue;
      label = `sec${number}`;
      display = `Section ${number}`;
      // Nest on the document's own numbering when it states it ("1.1" under
      // "1."), otherwise under the container the entries sit in.
      const numbered = number.includes(".")
        ? byLabel.get(`sec${number.slice(0, number.lastIndexOf("."))}`)
        : undefined;
      if (numbered) {
        parentLabel = numbered.label;
        depth = numbered.depth + 1;
      } else if (container) {
        parentLabel = container;
        depth = 1;
      }
    }
    // A contents page names each provision once. A repeat means the walk has
    // left it — the near-universal case being the index of defined terms that
    // follows one.
    if (byLabel.has(label)) break;
    if (page === null) {
      if (pageless === 0) pagelessFrom = entries.length;
      pageless += 1;
      if (pageless > MAX_PAGELESS_RUN) {
        entries.length = pagelessFrom;
        break;
      }
    } else {
      pageless = 0;
      previousPage = page;
    }
    if (found[1] || found[3]) container = label;
    const heading = (pageMatch ? unit.slice(0, unit.length - pageMatch[0].length) : unit)
      .replace(/[.…\s]+$/u, "")
      .replace(/^[\s–—\-:.]+/u, "")
      .trim();
    const entry: ContentsEntry = {
      label,
      display,
      heading,
      depth,
      parentLabel,
      page,
      contentsLineStart: from + head.start,
    };
    byLabel.set(label, entry);
    entries.push(entry);
    lastHead = i;
  }
  if (!entries.length) return null;
  return {
    entries,
    regionStart: from + heads[0].start,
    regionEnd: from + heads[Math.max(0, Math.min(lastHead, heads.length - 1))].end,
    pagesCited: entries.filter((entry) => entry.page !== null).length,
  };
}

/**
 * The document's table of contents, read as an outline. Deterministic, no
 * model calls, and independent of the segmentation competition — this runs on
 * the text as given and never touches `nodes`.
 */
export function readContentsOutline(text: string): {
  outline: ContentsOutline | null;
  refusal: ContentsRefusal | null;
} {
  CONTENTS_ANCHOR_RE.lastIndex = 0;
  const anchors: number[] = [];
  let anchor: RegExpExecArray | null;
  while ((anchor = CONTENTS_ANCHOR_RE.exec(text))) {
    anchors.push(anchor.index + anchor[0].length);
    if (anchors.length >= CONTENTS_MAX_ANCHORS) break;
  }
  if (!anchors.length) return { outline: null, refusal: "no_contents_marker" };
  let refusal: ContentsRefusal = "no_contents_entries";
  for (const from of anchors) {
    const outline = readContentsRegion(text, from);
    if (!outline) continue;
    if (outline.entries.length < MIN_CONTENTS_ENTRIES) {
      refusal = "too_few_contents_entries";
      continue;
    }
    if (outline.pagesCited / outline.entries.length < MIN_CONTENTS_PAGE_SHARE) {
      refusal = "contents_without_page_numbers";
      continue;
    }
    return { outline, refusal: null };
  }
  return { outline: null, refusal };
}

/**
 * Segmentation hypotheses, in precedence order — the text as extracted
 * first, so a tie always keeps what the extractor produced. Each is the same
 * length as the original and differs only in whitespace.
 */
function segmentations(text: string): string[] {
  const joined = recoverSentenceJoins(text);
  const hypotheses = [
    text,
    recoverSpaceRuns(text),
    joined,
    recoverSpaceRuns(joined),
  ];
  return hypotheses.filter(
    (candidate, index) => hypotheses.indexOf(candidate) === index,
  );
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
function endorsement(doc: SourceDoc, references: ProvisionReference[]): number {
  let landed = 0;
  for (const reference of references) {
    if (reference.external) continue;
    const key = reference.shape === "roman" ? reference.aliasKey : reference.locator;
    if (!key) continue;
    const position = doc.index.get(key.toLowerCase());
    if (position === undefined) continue;
    const target = doc.blocks[position];
    if (target.start >= reference.start && target.start < reference.end) continue;
    landed += 1;
  }
  return landed;
}


/**
 * The recoveries above can only ADD line starts, so they can only add
 * candidate heads — but a spine competition is not monotone in its candidate
 * set, and on a well-lineated document the added noise beats the real spine
 * (measured: CIT Group 105 sections -> 3, Bryn Mawr 78 -> 12). So the
 * segmentations COMPETE, on the same principle statuteSpine uses one level
 * down: the document decides. Ties go to the text as extracted.
 */
export interface CompileSkeletonOptions {
  /**
   * Whether this text may have lost its line breaks to an extractor, and so
   * whether the segmentation competition may run at all.
   *
   * Default true, because the Library lane compiles PDF- and DOCX-derived
   * agreements and that is what the recoveries exist for. Pass false for
   * text from an authoritative structured source, where the line breaks are
   * the publisher's and there is nothing to recover — the A2AJ lane passes
   * it so that legislation and case law cannot reach the competition BY
   * CONSTRUCTION rather than by a corpus diff showing they happened not to.
   *
   * The construction is not ceremony. Re-measured over the whole A2AJ English
   * statute corpus on 2026-07-31, the flag is NOT inert: 45 of 23,531
   * statutes compile a different node inventory with the recovery on than
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
  recoverExtraction?: boolean;
  /** Exact native cells; plain text alone cannot recover table boundaries. */
  tableCells?: readonly TableCellSpan[];
}

/**
 * Compiling a skeleton is the most-repeated expensive thing in the tool
 * layer, and until now it was repeated every single time: 20+ call sites in
 * backend/src, none memoized, with search paths compiling the same document
 * more than once per call and Grep compiling one per matching document. The
 * extracted text beside it has been cached for ages
 * (`textCache`, `parseCache`), so the string was free and the structure was
 * not.
 *
 * The key is not the text alone. `id` becomes `doc.id`, and
 * `recoverExtraction` genuinely changes the node inventory — 45 of 23,531
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
const skeletonCache = new Map<string, AgreementSkeleton>();

function skeletonCacheKey(
  text: string,
  id: string,
  options: CompileSkeletonOptions,
): string {
  return [
    sha256(text),
    id,
    options.recoverExtraction === false ? "norecover" : "recover",
    options.tableCells?.length
      ? sha256(JSON.stringify(options.tableCells))
      : "nocells",
  ].join("\u0000");
}

export function compileAgreementSkeleton(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): AgreementSkeleton {
  const cacheKey = skeletonCacheKey(text, id, options);
  const cached = skeletonCache.get(cacheKey);
  if (cached) {
    // Refresh recency: the tool layer reads one document repeatedly within a
    // turn, then moves on.
    skeletonCache.delete(cacheKey);
    skeletonCache.set(cacheKey, cached);
    return cached;
  }
  const compiled = compileAgreementSkeletonUncached(text, id, options);
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

function compileAgreementSkeletonUncached(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
): AgreementSkeleton {
  const lines = splitLines(text);
  const hypotheses =
    options.recoverExtraction === false ? [text] : segmentations(text);
  let best = discoverNodes(hypotheses[0], options.tableCells);
  if (hypotheses.length > 1) {
    const references = findProvisionReferences(text);
    const docOf = (found: DiscoveredNodes) =>
      createSourceDoc({
        provider: null,
        id,
        text,
        blocks: found.nodes.map(toBlock),
      });
    let bestScore = endorsement(docOf(best), references);
    for (const hypothesis of hypotheses.slice(1)) {
      const candidate = discoverNodes(hypothesis, options.tableCells);
      if (headSpan(candidate.nodes, text.length) < MIN_HEAD_SPAN) continue;
      const score = endorsement(docOf(candidate), references);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
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
  // Additive and independent: read from the ORIGINAL text, never merged into
  // `nodes`, and no input to the competition that produced them.
  const { outline, refusal } = readContentsOutline(text);

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

/** each node ends where the next node of equal-or-shallower depth begins */
function closeSpans(nodes: SkeletonNode[], textLength: number) {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodes[j].depth <= nodes[i].depth) {
        nodes[i].end = nodes[j].start;
        break;
      }
    }
    if (nodes[i].end > textLength) nodes[i].end = textLength;
  }
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
