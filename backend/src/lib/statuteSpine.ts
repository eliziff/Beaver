/**
 * Statute section-spine detection, ported from the corpus-proven grammar in
 * ALR-Quote-Verifier's verifier_core/a2aj_structure.py (section_structure).
 * Measured there across the full A2AJ laws corpus; measured here by the
 * provider-map and compatibility-reference gate in
 * scripts/skeleton-oracle-probe.py + skeleton-oracle-diff.ts.
 *
 * The design insight being ported: statute heads are bare numbers at line
 * start ("164 (1) Every one commits..."), which no per-line guard can safely
 * accept — a year, a dollar figure, a page number all look identical. Safety
 * comes from a document-level competition instead: marks join strictly
 * increasing same-arity scopes, and only a scope with enough members
 * covering enough of the document becomes the spine. The measured A2AJ
 * additions are a second-chance dot-terminated/Markdown grammar for NT, PE
 * and NB, plus ALR's instrument-gated hyphenated rule numbering.
 */

export type SpineStyle =
  | "integer"
  | "dot"
  | "dotterm"
  | "hyphen"
  | "mixed";
type SpineFamily = "bare" | "dotterm" | "markdown";

export interface SpineMark {
  /** section label, e.g. "164" or "672.53" */
  label: string;
  /** absolute offset of the line-start marker */
  start: number;
  /** absolute offset of the text after the mark and its trailing space */
  contentStart: number;
  style: SpineStyle;
  family: SpineFamily;
}

const NUMERIC_SECTION_LABEL =
  String.raw`\d{1,8}(?:[.-]\d{1,8}){0,3}[A-Z]{0,2}`;
const MARKDOWN_SECTION_LABEL =
  String.raw`\d{1,8}(?:[.-]\d{1,8}){1,3}[A-Z]{0,2}`;

/**
 * ALR a2aj_structure.SECTION_MARK_RE: digits with up to four dot/hyphen
 * components followed by content on the same line. Hyphenated hypotheses are
 * collected here but admitted only for rules instruments.
 */
const BARE_MARK_RE = new RegExp(
  String.raw`^[ \t]*(?<emphasis>\*\*)?(?<label>${NUMERIC_SECTION_LABEL})\k<emphasis>(?=[ \t]+(?:\(?\d|\p{L}|[\[*“"«])|[ \t]*\(|[ \t]*$)`,
  "gmu",
);

/**
 * NT/PE dot-terminated provisions are a separate syntactic family. They must
 * not join an incidental later bare-number table or an Ontario paragraph list.
 */
const DOTTERM_MARK_RE = new RegExp(
  String.raw`^[ \t]*(?<emphasis>\*\*)?(?<label>${NUMERIC_SECTION_LABEL})\k<emphasis>(?<trailingDot>[.)])(?=[ \t]+\S|[ \t]*\()`,
  "gmu",
);

/** NB rules and other numeric Markdown headings are their own family too. */
const MARKDOWN_MARK_RE = new RegExp(
  String.raw`^[ \t]*#{1,6}[ \t]+(?<emphasis>\*\*)?(?<label>${MARKDOWN_SECTION_LABEL})\k<emphasis>(?<trailingDot>\.)?(?=[ \t]+\S|[ \t]*$)`,
  "gmu",
);

const DOTTERM_CONTENT_RE = /^["'“«(\p{L}\p{N}]/u;
const MARKDOWN_RANGE_CONTINUATION_RE =
  /^[ \t]*#{1,6}[ \t]+.*(?:[ \t](?:to|à)|[-–—])[ \t]*$/iu;
const SHORT_ROOT_ALONE_RE = /^[ \t]*([12])[ \t]*$/gmu;
const SHORT_ROOT_STATUS_RE =
  /^(?:\[\s*)?(?:repealed|revoked|abrog(?:ated|é|ée|és|ées)|renumbered|spent|not (?:yet )?in force|omitted)\b/iu;
const SHORT_ROOT_HEADING_RE = /^(?:(?:["'“«]\s*)?\p{Lu}|\(\d+\))/u;

type LabelPart = {
  separator: "" | "." | "-";
  value: string;
  digits: string | null;
  suffix: number;
};
type DottedOrder = "component" | "fraction";

function labelParts(label: string): LabelPart[] {
  const parts: LabelPart[] = [];
  let separator: LabelPart["separator"] = "";
  for (const value of label.split(/([.-])/u)) {
    if (value === "." || value === "-") {
      separator = value;
    } else if (value) {
      const numeric = value.match(/^(\d+)([A-Za-z]*)$/u);
      parts.push({
        separator,
        value,
        digits: numeric?.[1] ?? null,
        suffix: suffixValue(numeric?.[2] ?? ""),
      });
    }
  }
  return parts;
}

function suffixValue(value: string) {
  return [...value.toUpperCase()].reduce(
    (total, character) => total * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

/**
 * Legislative decimal components may be fractions (`17.262 < 17.27`) or
 * rule components (`11.9 < 11.10`); the document-level spine competes both
 * hypotheses. Hyphen components are integers (`1-2 < 1-10`), and suffixes
 * follow their unsuffixed provision (`2 < 2A < 2B < 3`).
 */
export function compareStatuteLabels(
  left: string,
  right: string,
  dottedOrder: DottedOrder,
): number {
  return compareOrderedParts(
    labelParts(left),
    labelParts(right),
    dottedOrder,
  );
}

function compareOrderedParts(
  first: LabelPart[],
  second: LabelPart[],
  dottedOrder: DottedOrder,
): number {
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const a = first[index];
    const b = second[index];
    if (!a || !b) return a ? 1 : b ? -1 : 0;
    if (a.separator !== b.separator) {
      return a.separator < b.separator ? -1 : 1;
    }
    if (a.digits !== null && b.digits !== null) {
      const fractional =
        a.separator === "." && dottedOrder === "fraction";
      const width = Math.max(a.digits.length, b.digits.length);
      const aDigits = fractional
        ? a.digits.padEnd(width, "0")
        : a.digits.replace(/^0+(?=\d)/u, "").padStart(width, "0");
      const bDigits = fractional
        ? b.digits.padEnd(width, "0")
        : b.digits.replace(/^0+(?=\d)/u, "").padStart(width, "0");
      if (aDigits !== bDigits) return aDigits < bDigits ? -1 : 1;
      if (a.digits.length !== b.digits.length) {
        return a.digits.length < b.digits.length ? -1 : 1;
      }
      const suffix = a.suffix - b.suffix;
      if (suffix) return suffix < 0 ? -1 : 1;
      continue;
    }
    if (a.digits !== null || b.digits !== null) {
      return a.digits !== null ? -1 : 1;
    }
    const aText = a.value.toUpperCase();
    const bText = b.value.toUpperCase();
    if (aText !== bText) return aText < bText ? -1 : 1;
  }
  return 0;
}

const key = (label: string): number[] =>
  label.split(/[.-]/u).map((part) => Number.parseInt(part, 10));

const sameArity = (a: { length: number }, b: { length: number }) =>
  a.length === b.length;

function collectMarks(
  text: string,
  grammar: RegExp,
  family: SpineFamily,
): SpineMark[] {
  const marks: SpineMark[] = [];
  for (const match of text.matchAll(grammar)) {
    const lineStart = match.index ?? 0;
    const firstNonspace = match[0].search(/\S/u);
    const start = lineStart + Math.max(0, firstNonspace);
    const label = match.groups?.label ?? match[1];
    const trailingDot = !!match.groups?.trailingDot;
    const afterMark = lineStart + match[0].length;
    const contentStart = afterMark + lengthOfSpaces(text, afterMark);
    const lineEndAt = text.indexOf("\n", contentStart);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    if (
      family === "bare" &&
      contentStart >= lineEnd &&
      MARKDOWN_RANGE_CONTINUATION_RE.test(
        previousNonblankLine(text, lineStart) ?? "",
      )
    ) {
      continue;
    }
    if (family === "dotterm") {
      const rest = text
        .slice(contentStart, lineEnd)
        .replace(/\r$/u, "");
      if (!DOTTERM_CONTENT_RE.test(rest)) continue;
    }
    marks.push({
      label,
      start,
      contentStart,
      style: trailingDot
        ? "dotterm"
        : label.includes(".") && label.includes("-")
          ? "mixed"
          : label.includes("-")
            ? "hyphen"
            : label.includes(".")
              ? "dot"
              : "integer",
      family,
    });
  }
  return marks;
}

function lengthOfSpaces(text: string, at: number): number {
  let length = 0;
  while (text[at + length] === " " || text[at + length] === "\t") length += 1;
  return length;
}

function previousNonblankLine(text: string, at: number) {
  let end = at;
  while (end > 0) {
    while (end > 0 && (text[end - 1] === "\r" || text[end - 1] === "\n")) {
      end -= 1;
    }
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    if (/\S/u.test(line)) return line;
    end = start;
  }
  return null;
}

function nextNonblankLine(text: string, at: number) {
  let cursor = at;
  while (cursor < text.length) {
    while (text[cursor] === "\r" || text[cursor] === "\n") cursor += 1;
    const end = text.indexOf("\n", cursor);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(cursor, lineEnd);
    const firstNonspace = line.search(/\S/u);
    if (firstNonspace >= 0) {
      return {
        start: cursor + firstNonspace,
        text: line.slice(firstNonspace),
      };
    }
    cursor = lineEnd + 1;
  }
  return null;
}

/**
 * Full spines need three members. A measured minority of real instruments has
 * only section 1, or sections 1 and 2, so recover that exact root shape only
 * after every full-spine hypothesis has failed.
 */
function shortRootSpine(text: string): SpineMark[] {
  const candidates = new Map<string, SpineMark>();
  let invalidLabelAlone = false;
  const add = (marker: SpineMark) => {
    if (!/^[12]$/u.test(marker.label)) return;
    const lineEndAt = text.indexOf("\n", marker.start);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    if (marker.contentStart >= lineEnd) {
      const continuation = nextNonblankLine(text, lineEnd);
      if (
        !continuation ||
        (!SHORT_ROOT_HEADING_RE.test(continuation.text) &&
          !SHORT_ROOT_STATUS_RE.test(continuation.text))
      ) {
        invalidLabelAlone = true;
        return;
      }
      marker = { ...marker, contentStart: continuation.start };
    }
    candidates.set(`${marker.label}:${marker.start}`, marker);
  };
  for (const marker of collectMarks(text, BARE_MARK_RE, "bare")) add(marker);
  for (const marker of collectMarks(text, DOTTERM_MARK_RE, "dotterm")) {
    add(marker);
  }
  for (const marker of collectMarks(text, MARKDOWN_MARK_RE, "markdown")) {
    add(marker);
  }
  // This deliberately separate grammar cannot widen the ordinary full-spine
  // detector. Its continuation guard is what rejects line-broken quantities.
  for (const match of text.matchAll(SHORT_ROOT_ALONE_RE)) {
    const start = match.index + (match[0].length - match[0].trimStart().length);
    add({
      label: match[1],
      start,
      contentStart: match.index + match[0].length,
      style: "integer",
      family: "bare",
    });
  }
  if (invalidLabelAlone) return [];

  const markers = [...candidates.values()].sort(
    (left, right) => left.start - right.start,
  );
  const ones = markers.filter(({ label }) => label === "1");
  const twos = markers.filter(({ label }) => label === "2");
  if (
    ones.length !== 1 ||
    twos.length > 1 ||
    (twos.length === 1 && twos[0].start <= ones[0].start)
  ) {
    return [];
  }
  const selected = twos.length ? [ones[0], twos[0]] : [ones[0]];
  const startRatio = selected[0].start / text.length;
  return startRatio <= 0.7 ? selected : [];
}

/**
 * The ALR compatibility algorithm's scope competition: each mark joins the strictly increasing
 * same-arity scope with the greatest last key, or opens a new scope; at
 * most eight scopes live at once (smallest evicted); scopes with fewer
 * than three members are noise.
 */
function scopesFor(
  marks: SpineMark[],
  styles: ReadonlySet<SpineStyle>,
  requireRoot = false,
  dottedOrder: DottedOrder = "component",
): SpineMark[][] {
  const scopes: SpineMark[][] = [];
  const ordered = new Map(
    marks.map((mark) => [mark, labelParts(mark.label)] as const),
  );
  for (const mark of marks) {
    if (!styles.has(mark.style)) continue;
    const value = ordered.get(mark)!;
    let best = -1;
    let bestParts: LabelPart[] | null = null;
    for (let i = 0; i < scopes.length; i += 1) {
      const lastMark = scopes[i][scopes[i].length - 1];
      const last = ordered.get(lastMark)!;
      if (
        !sameArity(value, last) ||
        compareOrderedParts(value, last, dottedOrder) <= 0
      ) {
        continue;
      }
      if (
        bestParts === null ||
        compareOrderedParts(last, bestParts, dottedOrder) > 0
      ) {
        best = i;
        bestParts = last;
      }
    }
    if (best >= 0) scopes[best].push(mark);
    else scopes.push([mark]);
    if (scopes.length > 8) {
      let smallest = 0;
      for (let i = 1; i < scopes.length; i += 1) {
        if (scopes[i].length < scopes[smallest].length) smallest = i;
      }
      scopes.splice(smallest, 1);
    }
  }
  return scopes.filter(
    (scope) =>
      scope.length >= 3 &&
      (!requireRoot || key(scope[0].label).every((part) => part === 1)),
  );
}

/**
 * ALR's SECTION_MARK_RE admits a mark only when content follows it on the same
 * line. Beaver widened that with a label-alone-on-line alternative — the
 * measured `_EXT` that lifted LEGISLATION-NS 0.795 -> 0.963 — because statutes
 * legitimately print a provision label with its heading on the next line.
 * Agreement text spends the same shape on centred page numbers, and a run of
 * page numbers is monotone, same-arity, document-spanning and starts early, so
 * it clears every guard and wins the competition outright — measured on
 * LegalBench-RAG-mini, 10 of 69 agreements drew a spine whose marks were
 * mostly or entirely contentless, and in those documents the spurious spine
 * also suppressed the real "Section N." headings.
 *
 * The rule below is the extension's own limit rather than its removal: a
 * label-alone mark may EXTEND a spine that substantive marks already carry, but
 * may never CONSTITUTE one. When the winner has no substantive member at all
 * the competition reruns over substantive marks only, so statute texts (where
 * label-alone provisions sit among ordinary ones) are untouched.
 */
function hasInlineContent(text: string, mark: SpineMark) {
  const lineEnd = text.indexOf("\n", mark.contentStart);
  return /\S/u.test(
    text.slice(mark.contentStart, lineEnd < 0 ? text.length : lineEnd),
  );
}

/**
 * Return the winning section spine for statute-style text, or [] when no
 * hypothesis clears the compatibility guards (>= 3 members and first section
 * starts in the first 70%). Hyphenated and mixed
 * rule labels participate only when `allowHyphen` is true.
 */
export function computeStatuteSpine(
  text: string,
  allowHyphen = false,
): SpineMark[] {
  if (!text) return [];
  const spine = spineOver(text, allowHyphen, (marks) => marks);
  if (!spine.length || spine.some((mark) => hasInlineContent(text, mark))) {
    return spine;
  }
  return spineOver(text, allowHyphen, (marks) =>
    marks.filter((mark) => hasInlineContent(text, mark)),
  );
}

function spineOver(
  text: string,
  allowHyphen: boolean,
  admit: (marks: SpineMark[]) => SpineMark[],
): SpineMark[] {
  const families = [
    admit(collectMarks(text, BARE_MARK_RE, "bare")),
    admit(collectMarks(text, DOTTERM_MARK_RE, "dotterm")),
    admit(collectMarks(text, MARKDOWN_MARK_RE, "markdown")),
  ];
  const candidates = families
    .map((marks) => statuteWinner(marks, text, allowHyphen))
    .filter((candidate): candidate is SpineMark[] => candidate !== null)
    .sort((left, right) => left[0].start - right[0].start);
  if (!candidates.length) return shortRootSpine(text);

  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index][0].start !== best[0].start) break;
    const chosen = chooseCandidate(best, candidates[index]);
    if (!chosen) return [];
    best = chosen;
  }
  return best[0].family === "dotterm"
    ? expandDottedDescendants(
        best,
        [...families[0], ...families[1]].sort(
          (left, right) => left.start - right.start,
        ),
        text,
      )
    : best;
}

function statuteWinner(
  marks: SpineMark[],
  text: string,
  allowHyphen: boolean,
): SpineMark[] | null {
  if (marks.length < 3) return null;
  const componentHypotheses = scopesFor(
    marks,
    new Set<SpineStyle>(["integer", "dot", "dotterm"]),
  );
  if (allowHyphen) {
    componentHypotheses.push(
      ...scopesFor(marks, new Set<SpineStyle>(["hyphen"]), true),
      ...scopesFor(marks, new Set<SpineStyle>(["mixed"]), true),
    );
  }
  const component = scopeWinner(componentHypotheses, marks, text);
  const fraction = scopeWinner(
    scopesFor(
      marks,
      new Set<SpineStyle>(["dot"]),
      false,
      "fraction",
    ),
    marks,
    text,
  );
  return chooseCandidate(component, fraction);
}

function scopeWinner(
  hypotheses: SpineMark[][],
  marks: SpineMark[],
  text: string,
): SpineMark[] | null {
  const candidates = hypotheses
    .map((hypothesis) => expandIntegerScope(hypothesis, marks, text))
    .filter((hypothesis) => passesSpineGuards(hypothesis, text))
    .sort(
      (left, right) =>
        right.length - left.length || left[0].start - right[0].start,
    );
  if (!candidates.length) return null;
  const best = candidates[0];
  const tied = candidates.find(
    (candidate, index) =>
      index > 0 &&
      candidate.length === best.length &&
      candidate[0].start === best[0].start &&
      !sameLabels(candidate, best),
  );
  return tied ? null : best;
}

function expandIntegerScope(
  scope: SpineMark[],
  marks: SpineMark[],
  text: string,
) {
  if (
    !scope.length ||
    scope[0].style === "dotterm" ||
    key(scope[0].label).length !== 1
  ) {
    return scope;
  }
  return expandDottedDescendants(scope, marks, text);
}

function expandDottedDescendants(
  scope: SpineMark[],
  marks: SpineMark[],
  text: string,
) {
  if (!scope.length || key(scope[0].label).length !== 1) return scope;
  // An integer spine legitimately contains dotted top-level provisions
  // (Criminal Code ss. 672.53, 672.54): pull unambiguous dotted descendants
  // into their parent interval; duplicated descendant labels stay out. Walk
  // the disjoint parent intervals once rather than rescanning all marks.
  const expanded: SpineMark[] = [];
  let cursor = 0;
  for (let index = 0; index < scope.length; index += 1) {
    const parent = scope[index];
    const end = scope[index + 1]?.start ?? text.length;
    const parentNumber = key(parent.label)[0];
    while (cursor < marks.length && marks[cursor].start <= parent.start) {
      cursor += 1;
    }
    const descendants: SpineMark[] = [];
    while (cursor < marks.length && marks[cursor].start < end) {
      const mark = marks[cursor];
      if (
        (mark.style === "dot" ||
          (mark.style === "dotterm" && mark.label.includes("."))) &&
        key(mark.label)[0] === parentNumber
      ) {
        descendants.push(mark);
      }
      cursor += 1;
    }
    const counts = new Map<string, number>();
    for (const mark of descendants) {
      counts.set(mark.label, (counts.get(mark.label) ?? 0) + 1);
    }
    expanded.push(parent);
    expanded.push(
      ...descendants.filter((mark) => counts.get(mark.label) === 1),
    );
  }
  return expanded;
}

function chooseCandidate(
  left: SpineMark[] | null,
  right: SpineMark[] | null,
): SpineMark[] | null {
  if (!left) return right;
  if (!right) return left;
  if (sameLabels(left, right)) return left;
  if (left[0].start !== right[0].start) {
    return left[0].start < right[0].start ? left : right;
  }
  if (left.length !== right.length) {
    return left.length > right.length ? left : right;
  }
  return null;
}

function sameLabels(left: SpineMark[], right: SpineMark[]) {
  return (
    left.length === right.length &&
    left.every((mark, index) => mark.label === right[index].label)
  );
}

function passesSpineGuards(spine: SpineMark[], text: string) {
  if (!spine.length || !text.length) return false;
  const startRatio = spine[0].start / text.length;
  return startRatio <= 0.7;
}
