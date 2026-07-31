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
import {
  createSourceDoc,
  lookupSourceDocLabel,
  normalizeSourceDocLocator,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLookup,
} from "./sourceDoc";
import { computeStatuteSpine } from "./statuteSpine";

export type SkeletonNodeKind =
  | "article"
  | "part"
  | "division"
  | "section"
  | "subsection"
  | "schedule";

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

const CONTAINER_RE =
  /^(ARTICLE|Article|PART|Part|DIVISION|Division)\s+([IVXLCDM]+|\d{1,3})\b\s*[—–\-.:]?\s*(.*)$/u;
const SECTION_WORD_RE =
  /^(?:Section|SECTION)\s+(\d{1,3}(?:\.\d{1,3})*[A-Za-z]?)[.)]?\s*[—–\-:]?\s*(.*)$/u;
const SECTION_DECIMAL_RE = /^(\d{1,3}\.\d{1,3}(?:\.\d{1,3})*)\s+(\S.*)$/u;
const SECTION_INTEGER_RE = /^(\d{1,3})[.)]\s+(.*)$/u;
/**
 * Corpus-style dotless head for spine-less texts: a single provision
 * excerpt ("164 (1) A judge may...") has too few marks to form a spine,
 * but a bare number followed by a parenthesized digit is a subsection
 * marker no year, price, or page number produces.
 */
const SECTION_BARE_SUBSECTION_RE = /^(\d{1,3}(?:\.\d{1,3}){0,3})[ \t]+(?=\(\d)/u;
const SCHEDULE_RE =
  /^(SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix)\s+([A-Z0-9][\w.\-]*)\s*[—–\-.:]?\s*(.*)$/u;
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

export function compileAgreementSkeleton(
  text: string,
  id = "",
): AgreementSkeleton {
  const lines = splitLines(text);
  const nodes: SkeletonNode[] = [];
  const schedules: string[] = [];
  // Statute-style bare-number heads ("164 (1) Every one...") are decided by
  // a document-level scope competition, not per-line guards; when a spine
  // wins, it owns bare-number section detection and the per-line regexes
  // below only handle the styles it cannot claim (word/container/schedule).
  const spine = computeStatuteSpine(text);
  const spineByStart = new Map(spine.map((mark) => [mark.start, mark]));
  const dialects = admitEnumDialects(lines);

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

  const doc = createSourceDoc({
    provider: null,
    id,
    text,
    blocks: nodes.map(toBlock),
  });

  const lineTexts = lines.map((line) => line.text);
  const definedTerms = buildDefinedTerms(lineTexts, lines, nodes);
  const crossReferences = buildCrossReferences(text, doc);

  return { nodes, doc, definedTerms, schedules, crossReferences, ladder };
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
  const normalized = normalizeSourceDocLocator("section", locator);
  if (normalized) {
    const found = lookupSourceDocLabel(
      skeleton.doc,
      "section",
      normalized,
      contextBlocks,
    );
    if (found.status === "found") return found;
  }
  return lookupSourceDocLabel(
    skeleton.doc,
    "section",
    locator.trim().toLowerCase(),
    contextBlocks,
  );
}

export interface OutlineOptions {
  maxChars?: number;
  maxDefinedTerms?: number;
}

/** Compact, complete map: the whole point is that nothing structural is lost. */
export function renderAgreementOutline(
  skeleton: AgreementSkeleton,
  options?: OutlineOptions,
): string {
  const maxChars = options?.maxChars ?? 8_000;
  const maxTerms = options?.maxDefinedTerms ?? 60;
  const lines: string[] = [];
  for (const node of skeleton.nodes) {
    const size = node.end - node.start;
    const indent = "  ".repeat(node.depth);
    const heading = node.heading ? ` ${node.heading}` : "";
    const sizeNote = node.depth === 0 ? ` (${Math.round(size / 4)} tokens approx)` : "";
    lines.push(`${indent}${node.display}${heading} [${node.label}]${sizeNote}`);
  }
  let body = lines.join("\n");
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    body = body.slice(0, body.lastIndexOf("\n"));
    truncated = true;
  }
  const parts = [body];
  if (truncated) {
    parts.push(`… outline truncated (${skeleton.nodes.length} nodes total)`);
  }
  if (skeleton.definedTerms.length) {
    const shown = skeleton.definedTerms.slice(0, maxTerms);
    parts.push(
      `Defined terms (${skeleton.definedTerms.length}): ` +
        shown
          .map(
            (entry) =>
              `"${entry.term}"${entry.sectionLabel ? ` [${entry.sectionLabel}]` : ""}`,
          )
          .join(", ") +
        (skeleton.definedTerms.length > shown.length ? ", …" : ""),
    );
  }
  if (skeleton.schedules.length) {
    parts.push(`Schedules/Exhibits: ${skeleton.schedules.join("; ")}`);
  }
  const refs = skeleton.crossReferences;
  parts.push(
    `Cross-references: ${refs.internal} internal, ${refs.external} external` +
      (refs.unresolved.length
        ? `; unresolved internal targets: ${refs.unresolved.join(", ")}`
        : ""),
  );
  if (skeleton.ladder.restarts || skeleton.ladder.violations) {
    parts.push(
      `Ladder notes: ${skeleton.ladder.restarts} enumerator restart(s), ` +
        `${skeleton.ladder.violations} out-of-order enumerator(s); repeated ` +
        `labels carry @n occurrence suffixes.`,
    );
  }
  return parts.join("\n\n");
}
