// Temporal reconciliation inside a passage: does the deadline arithmetic the
// drafting asserts actually close?
//
// Deadlines are stated redundantly — a period measured from a named event,
// together with the resolved calendar date. One identity is computable
// without a model:
//
//   anchor date ± duration = stated date
//
// Only triples stated locally and joined by a direction idiom are checked;
// the idiom fixes which date is the base. Periods whose resolution needs a
// holiday calendar or a computation-of-time convention the passage does not
// fix are abstentions, never approximated as calendar days. Findings carry
// the arithmetic so a reader can judge materiality.
import { extractAnchors } from "./legalTextAnchors";
import {
  compileAgreementSkeleton,
  type SkeletonNode,
} from "./legalTextSkeleton";

export interface TemporalDocument {
  name: string;
  text: string;
}

export interface TemporalRef {
  document: string;
  display: string;
  /** canonical value key: ISO date, or dur:<n>:<unit> */
  value: string;
  excerpt: string;
  /** char offset of the span in its document: where to quote from */
  at: number;
  /**
   * The excerpt is the document's text verbatim — no ellipsis added, no
   * whitespace run rewritten — so a quote mined from it verifies as-is.
   * False means quote from the document at `at`, not from the excerpt.
   */
  verbatim: boolean;
  /** enclosing skeleton node label ("sec3.1"), or null in unsectioned text */
  section: string | null;
}

export interface TemporalFinding {
  kind: "date_arithmetic";
  scope: "same-document";
  /** "exact": the passage equates the dates; "bound": stated may not fall later */
  relation: "exact" | "bound";
  direction: "after" | "before";
  /** the arithmetic, spelled out */
  detail: string;
  base: TemporalRef;
  duration: TemporalRef;
  stated: TemporalRef;
  /** base ± duration */
  computed: string;
  /** stated − computed, in days */
  delta_days: number;
}

export interface TemporalAbstention {
  reason: "calendar_dependent" | "ambiguous_base" | "scan_capped";
  detail: string;
  count: number;
}

export interface TemporalScanReport {
  findings: TemporalFinding[];
  /** identities checked that closed */
  consistent: number;
  checks: { date_arithmetic: number };
  abstentions: TemporalAbstention[];
  anchors_examined: number;
}

/** Units resolvable from the passage alone. */
const PLAIN_UNITS = new Set(["day", "calendar_day", "week", "month", "year"]);
/** Units needing a holiday calendar or a fiscal/terminal-day convention. */
const CALENDAR_UNITS = new Set([
  "business_day",
  "clear_day",
  "trading_day",
  "quarter",
  "fiscal_quarter",
]);

// The idiom attaches the period to its base ("45 days after the Effective
// Date (November 1, 2024)"). Deliberately excluded: "on or about", "as of",
// "between … and …", and the at-least/not-less-than family, whose inequality
// runs the other way.
const AFTER_RE =
  /\b(?:after|from|following|of|commencing on|beginning on|apr[èe]s|suivant|à compter de|a compter de)\b/iu;
const BEFORE_RE =
  /\b(?:before|prior to|preceding|in advance of|avant|pr[ée]c[ée]dant)\b/iu;
// The resolved date restates the deadline: equality markers vs bound markers.
const EXACT_MARKER_RE =
  /(?:\bi\.\s?e\.|\bthat is\b|\bbeing\b|\bnamely\b|\bwhich is\b|\bviz\.|\bsoit\b|c\.-à-d\.)/iu;
const BOUND_MARKER_RE =
  /(?:\bon or before\b|\bno later than\b|\bnot later than\b|\bau plus tard\b)/iu;
// "within N days …" makes the resolved date a ceiling, not an equality.
const WITHIN_RE = /\b(?:within|no later than|not later than|dans les|au plus tard)\b/iu;

/** Whole triple, end to end. */
const TRIPLE_SPAN = 200;
/** Duration end to base date: the idiom must sit in this gap. */
const IDIOM_GAP = 60;
const MARKER_REACH = 40;
const WITHIN_REACH = 30;
const DUP_GAP = 40;
const MAX_FINDINGS = 40;
const EXCERPT_CHARS = 160;

const DAY_MS = 86_400_000;

const epochDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

function toISO(days: number): string {
  const date = new Date(days * DAY_MS);
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${m}-${d}`;
}

const daysInMonth = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

/** UTC calendar arithmetic; month/year land on the anniversary day, clamped. */
function shift(iso: string, count: number, unit: string, sign: 1 | -1): string | null {
  if (unit === "day" || unit === "calendar_day") {
    return toISO(epochDay(iso) + sign * count);
  }
  if (unit === "week") return toISO(epochDay(iso) + sign * 7 * count);
  if (unit === "month" || unit === "year") {
    const [y, m, d] = iso.split("-").map(Number);
    const months = unit === "year" ? 12 * count : count;
    const total = m - 1 + sign * months;
    const year = y + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12 + 1;
    return toISO(
      Date.UTC(year, month - 1, Math.min(d, daysInMonth(year, month))) / DAY_MS,
    );
  }
  return null;
}

const unitLabel = (count: number, unit: string) =>
  `${count} ${unit.replace(/_/gu, " ")}${count === 1 ? "" : "s"}`;

interface Span {
  raw: string;
  norm: string;
  index: number;
  end: number;
}

/** Display excerpt plus whether it is still the document's own bytes. */
const excerptAt = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - EXCERPT_CHARS / 2);
  const end = Math.min(text.length, at + length + EXCERPT_CHARS / 2);
  const window = text.slice(start, end);
  const display = window.replace(/\s+/gu, " ").trim();
  return {
    excerpt: (start > 0 ? "…" : "") + display + (end < text.length ? "…" : ""),
    verbatim: start === 0 && end === text.length && display === window,
  };
};

type SectionAt = (at: number) => string | null;

/**
 * Deepest skeleton node containing an offset, as a citable label. The
 * skeleton is compiled at most once per document and only when a finding
 * actually needs a handle, so clean documents pay nothing.
 */
function sectionResolver(text: string): SectionAt {
  let nodes: SkeletonNode[] | null = null;
  return (at) => {
    nodes ??= compileAgreementSkeleton(text).nodes;
    let best: SkeletonNode | null = null;
    for (const node of nodes) {
      if (node.start > at || at >= node.end) continue;
      if (!best || node.depth > best.depth) best = node;
    }
    return best?.label ?? null;
  };
}

const ref = (
  document: string,
  text: string,
  span: Span,
  value: string,
  sectionAt: SectionAt,
): TemporalRef => ({
  document,
  display: span.raw,
  value,
  at: span.index,
  section: sectionAt(span.index),
  ...excerptAt(text, span.index, span.raw.length),
});

/** Earliest idiom wins: "after … before" is an after-period. */
function directionIn(gap: string): "after" | "before" | null {
  const after = AFTER_RE.exec(gap);
  const before = BEFORE_RE.exec(gap);
  if (after && before) return after.index < before.index ? "after" : "before";
  if (after) return "after";
  return before ? "before" : null;
}

const markersBefore = (text: string, at: number) => {
  const lead = text.slice(Math.max(0, at - MARKER_REACH), at);
  return { exact: EXACT_MARKER_RE.test(lead), bound: BOUND_MARKER_RE.test(lead) };
};

/** Words-and-numerals restatements of one period ("90 days (90 days)"). */
function dedupe(spans: Span[]): Span[] {
  return spans.filter(
    (span, i) =>
      !(i > 0 && spans[i - 1].norm === span.norm && span.index - spans[i - 1].end <= DUP_GAP),
  );
}

export function temporalScan(
  documents: readonly TemporalDocument[],
): TemporalScanReport {
  const findings: TemporalFinding[] = [];
  const seen = new Set<string>();
  let consistent = 0;
  let anchorsExamined = 0;
  let ambiguousBase = 0;
  let calendarDependent = 0;
  const checks = { date_arithmetic: 0 };

  for (const document of documents) {
    const sectionAt = sectionResolver(document.text);
    const dates: Span[] = [];
    const durations: Span[] = [];
    for (const hit of extractAnchors(document.text)) {
      if (hit.cls !== "date" && hit.cls !== "duration") continue;
      anchorsExamined += 1;
      const span: Span = {
        raw: hit.raw,
        norm: hit.norm,
        index: hit.index,
        end: hit.index + hit.raw.length,
      };
      (hit.cls === "date" ? dates : durations).push(span);
    }
    const byIndex = (a: Span, b: Span) => a.index - b.index;
    dates.sort(byIndex);
    durations.sort(byIndex);
    // Overlapping grammars can match one date twice.
    const uniqueDates = dates.filter(
      (date, i) => !(i > 0 && dates[i - 1].norm === date.norm && date.index < dates[i - 1].end),
    );

    for (const duration of dedupe(durations)) {
      const near = uniqueDates.filter(
        (date) =>
          date.end >= duration.index - TRIPLE_SPAN &&
          date.index <= duration.end + TRIPLE_SPAN,
      );
      if (near.length < 2) continue;

      // The base is the date the idiom attaches to, so it follows the period.
      const base = near.find((date) => date.index >= duration.end);
      if (!base || base.index - duration.end > IDIOM_GAP) continue;
      const direction = directionIn(document.text.slice(duration.end, base.index));
      if (!direction) continue;
      // A date carrying a resolution marker is a restated deadline, not a
      // base: with another date in reach, which is which is undecidable.
      const baseMarks = markersBefore(document.text, base.index);
      if (baseMarks.exact || baseMarks.bound) {
        ambiguousBase += 1;
        continue;
      }

      const candidates = near.filter((date) => {
        if (date === base) return false;
        const marks = markersBefore(document.text, date.index);
        if (!marks.exact && !marks.bound) return false;
        const start = Math.min(duration.index, base.index, date.index);
        const stop = Math.max(duration.end, base.end, date.end);
        return stop - start <= TRIPLE_SPAN;
      });
      if (!candidates.length) continue;
      if (candidates.length > 1) {
        ambiguousBase += 1;
        continue;
      }
      const stated = candidates[0];

      const parsed = /^dur:(\d+):([a-z_]+)$/u.exec(duration.norm);
      if (!parsed) continue;
      const count = Number(parsed[1]);
      const unit = parsed[2];
      if (CALENDAR_UNITS.has(unit)) {
        calendarDependent += 1;
        continue;
      }
      if (!PLAIN_UNITS.has(unit) || count <= 0) continue;

      const baseIso = base.norm.slice("date:".length);
      const statedIso = stated.norm.slice("date:".length);
      const computed = shift(baseIso, count, unit, direction === "after" ? 1 : -1);
      if (!computed) continue;
      const relation: "exact" | "bound" =
        markersBefore(document.text, stated.index).bound ||
        WITHIN_RE.test(
          document.text.slice(Math.max(0, duration.index - WITHIN_REACH), duration.index),
        )
          ? "bound"
          : "exact";

      checks.date_arithmetic += 1;
      const delta = epochDay(statedIso) - epochDay(computed);
      if (relation === "bound" ? delta <= 0 : delta === 0) {
        consistent += 1;
        continue;
      }
      const key = `da:${document.name}:${baseIso}:${direction}:${count}:${unit}:${statedIso}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const operator = direction === "after" ? "+" : "−";
      const magnitude = Math.abs(delta);
      findings.push({
        kind: "date_arithmetic",
        scope: "same-document",
        relation,
        direction,
        detail:
          `${baseIso} ${operator} ${unitLabel(count, unit)} = ${computed} ` +
          (relation === "bound"
            ? `< ${statedIso} stated (period exceeded by ${magnitude} day${magnitude === 1 ? "" : "s"})`
            : `≠ ${statedIso} stated (Δ ${magnitude} day${magnitude === 1 ? "" : "s"})`),
        base: ref(document.name, document.text, base, baseIso, sectionAt),
        duration: ref(
          document.name,
          document.text,
          duration,
          duration.norm,
          sectionAt,
        ),
        stated: ref(document.name, document.text, stated, statedIso, sectionAt),
        computed,
        delta_days: delta,
      });
    }
  }

  const abstentions: TemporalAbstention[] = [];
  if (calendarDependent) {
    abstentions.push({
      reason: "calendar_dependent",
      detail:
        "periods counted in business, clear, trading days or quarters; resolution needs a holiday calendar or fiscal convention the passage does not state",
      count: calendarDependent,
    });
  }
  if (ambiguousBase) {
    abstentions.push({
      reason: "ambiguous_base",
      detail:
        "locally linked date/period triples where the base date cannot be told from the resolved date; not checked",
      count: ambiguousBase,
    });
  }
  if (findings.length > MAX_FINDINGS) {
    abstentions.push({
      reason: "scan_capped",
      detail: `${findings.length - MAX_FINDINGS} further findings not reported`,
      count: findings.length - MAX_FINDINGS,
    });
  }

  return {
    findings: findings.slice(0, MAX_FINDINGS),
    consistent,
    checks,
    abstentions,
    anchors_examined: anchorsExamined,
  };
}
