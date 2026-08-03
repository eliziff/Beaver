/**
 * Deadline working-back omission scan — the time-domain sibling of the
 * derived-value carry-through organ (legalDerivedValueScan.ts).
 *
 * General legal pattern: a source states a calendar relationship of the form
 * "trigger X [units] before/after/within [anchor calendar date]" — a consent
 * request due 60 days before a closing, a notice to be given not later than
 * 120 days prior to a lease expiration, a repurchase offer within 30 days of a
 * change of control. The resolved deadline follows deterministically:
 *
 *   anchor date −/+ duration = resolved date
 *
 * An analytical deliverable that ENGAGES the relationship — states the anchor
 * date, or the duration, or the trigger wording — but omits the resolved date
 * leaves the reader unable to act. This organ finds those stated relationships
 * in the source stack and reports the resolved deadline the deliverable
 * engaged but dropped.
 *
 * Binding is by deterministic calendar resolution, never by guessing. A
 * period whose base is not a stated calendar date ("within 30 days of
 * receipt", "60 days after the Effective Date" where the value is undefined
 * in the document), whose first following date is itself a restated deadline,
 * or which is counted in units needing a holiday calendar (business, clear,
 * trading days; quarters) is REFUSED, never approximated (CLAUDE.md rule 5;
 * the unit conventions mirror legalTemporalScan.ts).
 *
 * Scope: analytical deliverables only. In operative drafting a "60 days
 * before the Closing" clause IS the operative term and the resolved date may
 * legitimately be absent; the caller gates this organ to analytical requests.
 */
import { extractAnchors } from "./legalTextAnchors";

export interface DeadlineDocument {
  name: string;
  text: string;
}

export interface DeadlineRef {
  document: string;
  display: string;
  /** canonical value key: ISO date, or dur:<n>:<unit> */
  value: string;
  /** char offset of the span in its document: where to quote from */
  at: number;
  excerpt: string;
}

export interface DeadlineRelationship {
  document: string;
  /** the action the deadline binds, when a trigger noun is collocated; null otherwise */
  trigger: string | null;
  base: DeadlineRef;
  duration: DeadlineRef;
  direction: "after" | "before";
  /** "no later than" / "within" make the resolved date a ceiling, not an equality */
  bound: boolean;
  /** the resolved deadline, ISO */
  resolved: string;
  /** the arithmetic, spelled out */
  detail: string;
}

export interface DeadlineOmission {
  kind: "deadline_omission";
  /** which side(s) of the stated relationship the deliverable carried */
  engaged: ("anchor" | "duration" | "trigger")[];
  /** the action the deadline binds, when a trigger noun is collocated; null otherwise */
  trigger: string | null;
  /** the arithmetic and the omission, spelled out */
  detail: string;
  anchor: DeadlineRef;
  duration: DeadlineRef;
  /** the resolved deadline the deliverable omitted, ISO */
  resolved: string;
}

export interface DeadlineRefusal {
  reason: "calendar_dependent" | "unstated_anchor" | "ambiguous_base" | "scan_capped";
  detail: string;
  count: number;
}

export interface DeadlineOmissionReport {
  findings: DeadlineOmission[];
  /** source relationships that resolved to a deadline date */
  resolved: number;
  /** resolved relationships the deliverable engaged */
  engaged: number;
  refusals: DeadlineRefusal[];
}

const MAX_FINDINGS = 12;
const EXCERPT_CHARS = 160;

/** Units resolvable from the passage alone (mirrors legalTemporalScan.ts). */
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
// Date"). Mirrors legalTemporalScan.ts so the same passages resolve the same
// way. "of" is an after-direction per that machinery ("30 days of receipt").
const AFTER_RE =
  /\b(?:after|from|following|of|commencing on|beginning on|apr[èe]s|suivant|à compter de|a compter de)\b/iu;
const BEFORE_RE =
  /\b(?:before|prior to|preceding|in advance of|avant|pr[ée]c[ée]dant)\b/iu;
const WITHIN_RE = /\b(?:within|no later than|not later than|dans les|au plus tard)\b/iu;
const EXACT_MARKER_RE =
  /(?:\bi\.\s?e\.|\bthat is\b|\bbeing\b|\bnamely\b|\bwhich is\b|\bviz\.|\bsoit\b|c\.-à-d\.)/iu;
const BOUND_MARKER_RE =
  /(?:\bon or before\b|\bno later than\b|\bnot later than\b|\bau plus tard\b)/iu;

/** Duration end to base date: the idiom must sit in this gap. */
const IDIOM_GAP = 60;
/** How far before a date its resolution marker ("i.e.") may sit. */
const MARKER_REACH = 40;
const WITHIN_REACH = 30;
const DUP_GAP = 40;
/** How far before the period the trigger noun may sit. */
const TRIGGER_REACH = 160;
/**
 * Base-event nouns a deadline period may be measured from when no calendar
 * value is stated ("30 days of receipt", "60 days after the Effective Date",
 * "45 days prior to the closing or effective date of such Change of Control").
 * The unstated-anchor refusal is only counted when one of these follows the
 * period, so an incidental "of" in an unrelated clause ("the benefit of its
 * creditors") cannot read as a deadline relationship.
 */
const BASE_EVENT_RE =
  /\b(?:receipt|delivery|expiration|termination|effective date|commencement|closing|execution|signing|awareness|notice|change of control|change in control|the date of|the\s+[a-z][a-z-]*\s+date)\b/iu;

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

const excerptAt = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - EXCERPT_CHARS / 2);
  const end = Math.min(text.length, at + length + EXCERPT_CHARS / 2);
  const window = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return (start > 0 ? "…" : "") + window + (end < text.length ? "…" : "");
};

interface Span {
  raw: string;
  norm: string;
  index: number;
  end: number;
}

const ref = (doc: DeadlineDocument, span: Span): DeadlineRef => ({
  document: doc.name,
  display: span.raw,
  value: span.norm,
  at: span.index,
  excerpt: excerptAt(doc.text, span.index, span.raw.length),
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

/** Deadline-trigger nouns: the action a period binds across legal tasks. */
const TRIGGER_VOCAB_RE =
  /\b(?:consent|notice|approval|repurchase|tender|offer|filing|submission|delivery|payment|option|exercise|election|response|objection|claim|appeal|waiver|disclosure|registration|report|certificate|opinion|resolution|requisition|request|confirmation|acknowledgment|acknowledgement)\b/giu;
/** Words that must not join the trigger noun phrase ("deliver its consent"). */
const TRIGGER_STOP = new Set([
  "the", "a", "an", "its", "his", "her", "their", "our", "your", "such", "any",
  "each", "all", "every", "no", "shall", "will", "may", "must", "can", "be",
  "is", "are", "was", "were", "been", "to", "for", "of", "in", "on", "at",
  "by", "with", "from", "as", "or", "and", "that", "which", "who", "whose",
  "hereunder", "hereto", "thereof", "pursuant", "under", "provide", "provides",
  "provided", "deliver", "delivers", "give", "gives", "given", "submit",
  "submits", "make", "makes", "made", "execute", "executes", "obtain",
  "obtains", "require", "requires", "required", "not", "later", "than",
  "within", "at", "least", "prior", "before", "after", "following", "upon",
  "per", "signed", "dated",
]);

/**
 * The noun phrase the deadline binds, collocated before the period: "consent
 * request", "repurchase option", "notice of termination". Falls back to null
 * when no trigger noun is in reach — the anchor/duration identity then names
 * the relationship.
 */
function extractTrigger(text: string, duration: Span): string | null {
  const start = Math.max(0, duration.index - TRIGGER_REACH);
  const before = text.slice(start, duration.index);
  const matches = [...before.matchAll(TRIGGER_VOCAB_RE)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const headIndex = last.index ?? 0;
  const headEnd = headIndex + last[0].length;

  // Backward: up to two noun modifiers ("consent request", "repurchase option").
  const tokens = before.slice(0, headIndex).split(/\s+/u).filter(Boolean);
  const back: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && back.length < 2; i--) {
    const token = tokens[i].replace(/^[^A-Za-z]+|[^A-Za-z-]+$/gu, "");
    if (!token || !/^[A-Za-z][A-Za-z-]*$/u.test(token)) break;
    if (TRIGGER_STOP.has(token.toLowerCase())) break;
    back.unshift(token);
  }

  // Forward: an "of <noun>" complement ("notice of termination").
  const ofMatch = /^\s+of\s+([A-Za-z][A-Za-z-]*)/u.exec(before.slice(headEnd));
  const fwd = ofMatch ? ["of", ofMatch[1]] : [];

  const phrase = [...back, last[0], ...fwd];
  return phrase.length ? phrase.join(" ") : null;
}

const REFUSAL_DETAIL: Record<
  Exclude<DeadlineRefusal["reason"], "scan_capped">,
  string
> = {
  unstated_anchor:
    "a period joined to a base by a deadline idiom ('within 30 days of receipt', '60 days after the Effective Date') whose calendar anchor is not stated in the document; the resolved date is not computable",
  ambiguous_base:
    "a period whose first following date is itself a restated deadline (i.e./being/on or before), so the base cannot be told from the resolved date; not resolved",
  calendar_dependent:
    "a period counted in business, clear or trading days or quarters; resolution needs a holiday calendar or fiscal convention the passage does not state",
};

type RefusalKey = Exclude<DeadlineRefusal["reason"], "scan_capped">;

/**
 * Source-side only: find every stated "trigger X [units] before/after/within
 * [anchor calendar date]" relationship and resolve the deadline deterministically.
 * Relationships that cannot be resolved are refused, never guessed. One
 * document's pair may be stated twice (prose + restatement): deduped on the
 * identity (base + period + direction).
 */
export function detectDeadlineRelationships(doc: DeadlineDocument): {
  relationships: DeadlineRelationship[];
  refusals: DeadlineRefusal[];
} {
  const text = doc.text;
  const dates: Span[] = [];
  const durations: Span[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "date" && hit.cls !== "duration") continue;
    const span: Span = { raw: hit.raw, norm: hit.norm, index: hit.index, end: hit.index + hit.raw.length };
    (hit.cls === "date" ? dates : durations).push(span);
  }
  const byIndex = (a: Span, b: Span) => a.index - b.index;
  dates.sort(byIndex);
  durations.sort(byIndex);
  // Overlapping grammars can match one date twice.
  const uniqueDates = dates.filter(
    (date, i) => !(i > 0 && dates[i - 1].norm === date.norm && date.index < dates[i - 1].end),
  );

  const relationships: DeadlineRelationship[] = [];
  const refusalCounts = new Map<RefusalKey, number>();
  const seen = new Set<string>();
  const refuse = (reason: RefusalKey) =>
    refusalCounts.set(reason, (refusalCounts.get(reason) ?? 0) + 1);

  for (const duration of dedupe(durations)) {
    const parsed = /^dur:(\d+):([a-z_]+)$/u.exec(duration.norm);
    if (!parsed) continue;
    const count = Number(parsed[1]);
    const unit = parsed[2];
    if (count <= 0) continue;

    // The base date the idiom attaches to follows the period, close by.
    const following = uniqueDates.filter(
      (date) => date.index >= duration.end && date.index - duration.end <= IDIOM_GAP,
    );
    const gap = text.slice(duration.end, Math.min(text.length, duration.end + IDIOM_GAP));
    const direction = directionIn(gap);

    if (following.length === 0) {
      // A deadline idiom joins the period to a base-event noun ("within 30
      // days of receipt", "60 days after the Effective Date") but no calendar
      // anchor is stated in reach — refuse rather than guess a resolved date.
      // Requiring a base-event noun keeps an incidental "of" in an unrelated
      // clause ("the benefit of its creditors") from reading as a deadline.
      if (direction && BASE_EVENT_RE.test(gap)) refuse("unstated_anchor");
      continue;
    }
    if (!direction) continue;
    const base = following[0];
    // A base that is itself a restated deadline ("i.e./being/on or before")
    // cannot be told from the resolved date.
    const baseMarks = markersBefore(text, base.index);
    if (baseMarks.exact || baseMarks.bound) {
      refuse("ambiguous_base");
      continue;
    }
    if (CALENDAR_UNITS.has(unit)) {
      refuse("calendar_dependent");
      continue;
    }
    if (!PLAIN_UNITS.has(unit)) continue;

    const baseIso = base.norm.slice("date:".length);
    const resolved = shift(baseIso, count, unit, direction === "after" ? 1 : -1);
    if (!resolved) continue;

    const bound =
      WITHIN_RE.test(text.slice(Math.max(0, duration.index - WITHIN_REACH), duration.index)) ||
      BOUND_MARKER_RE.test(gap);
    const key = `dl:${baseIso}:${direction}:${count}:${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const operator = direction === "after" ? "+" : "−";
    const trigger = extractTrigger(text, duration);
    const relationshipLabel = trigger ? `${trigger} due ` : "deadline ";
    relationships.push({
      document: doc.name,
      trigger,
      base: ref(doc, base),
      duration: ref(doc, duration),
      direction,
      bound,
      resolved,
      detail: `${relationshipLabel}${baseIso} ${operator} ${unitLabel(count, unit)} = ${resolved}`,
    });
  }

  const refusals: DeadlineRefusal[] = [...refusalCounts.entries()].map(
    ([reason, count]) => ({ reason, detail: REFUSAL_DETAIL[reason], count }),
  );
  return { relationships, refusals };
}

/**
 * Scan the source stack for stated deadline relationships and report the
 * resolved deadlines the drafted deliverable engaged but omitted. The
 * deliverable engages when it carries the anchor date, the duration, or the
 * trigger wording; if it does but never carries the resolved date (within
 * ±1 day), emit a bounded finding. Relationships that cannot be resolved are
 * refused, not guessed.
 */
export function deadlineOmissionScan(
  sources: readonly DeadlineDocument[],
  draft: DeadlineDocument,
): DeadlineOmissionReport {
  const draftDates = new Map<string, number>();
  const draftDurations = new Set<string>();
  for (const hit of extractAnchors(draft.text)) {
    if (hit.cls === "date") {
      const iso = hit.norm.slice("date:".length);
      draftDates.set(iso, epochDay(iso));
    } else if (hit.cls === "duration") {
      draftDurations.add(hit.norm);
    }
  }
  const draftLower = draft.text.toLowerCase();

  const findings: DeadlineOmission[] = [];
  const seen = new Set<string>();
  const refusalCounts = new Map<RefusalKey, number>();
  let resolved = 0;
  let engaged = 0;

  for (const source of sources) {
    const { relationships, refusals } = detectDeadlineRelationships(source);
    for (const refusal of refusals) {
      // scan_capped is a global output cap, not a per-relationship refusal;
      // RefusalKey deliberately excludes it from the reason tally.
      if (refusal.reason === "scan_capped") continue;
      refusalCounts.set(
        refusal.reason,
        (refusalCounts.get(refusal.reason) ?? 0) + refusal.count,
      );
    }
    for (const rel of relationships) {
      resolved += 1;
      const sides: DeadlineOmission["engaged"] = [];
      if (draftDates.has(rel.base.value.slice("date:".length))) sides.push("anchor");
      if (draftDurations.has(rel.duration.value)) sides.push("duration");
      if (rel.trigger && triggerEngages(draftLower, rel.trigger)) sides.push("trigger");
      if (!sides.length) continue;
      engaged += 1;

      // Does the deliverable carry the resolved date (within ±1 day, the
      // anchor itself not counting — a 1-day deadline sits one day from its
      // anchor, so carrying the anchor is not carrying the resolved date)?
      const anchorIso = rel.base.value.slice("date:".length);
      const resolvedDay = epochDay(rel.resolved);
      let carried = false;
      for (const [iso, day] of draftDates) {
        if (iso === anchorIso) continue;
        if (Math.abs(day - resolvedDay) <= 1) {
          carried = true;
          break;
        }
      }
      if (carried) continue;

      const key = `dl:${rel.base.value}:${rel.duration.value}:${rel.direction}:${rel.resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const subject = rel.trigger
        ? `the ${rel.trigger}`
        : `the deadline measured from ${rel.base.value.slice("date:".length)}`;
      findings.push({
        kind: "deadline_omission",
        engaged: sides,
        trigger: rel.trigger,
        detail:
          `${rel.detail} — the deliverable engages ${subject} but never states ` +
          `the resolved deadline ${rel.resolved}`,
        anchor: rel.base,
        duration: rel.duration,
        resolved: rel.resolved,
      });
      if (findings.length > MAX_FINDINGS) break;
    }
  }

  const refusals: DeadlineRefusal[] = [];
  for (const reason of ["unstated_anchor", "ambiguous_base", "calendar_dependent"] as const) {
    const count = refusalCounts.get(reason) ?? 0;
    if (count) refusals.push({ reason, detail: REFUSAL_DETAIL[reason], count });
  }
  if (findings.length > MAX_FINDINGS) {
    refusals.push({
      reason: "scan_capped",
      detail: `${findings.length - MAX_FINDINGS} further findings not reported`,
      count: findings.length - MAX_FINDINGS,
    });
  }

  return {
    findings: findings.slice(0, MAX_FINDINGS),
    resolved,
    engaged,
    refusals,
  };
}

const hasPhrase = (haystack: string, phrase: string): boolean =>
  new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(haystack);

/**
 * Does the deliverable engage the trigger wording? The full phrase matches
 * ("consent request"); a paraphrase that keeps only the leading noun also
 * engages ("Consent must be delivered by…"). The leading noun is the most
 * distinctive token ("consent", "repurchase", "tender"); the trailing head
 * ("request", "option") is too generic to bind on alone.
 */
function triggerEngages(haystack: string, trigger: string): boolean {
  if (hasPhrase(haystack, trigger)) return true;
  const leading = trigger.split(/\s+/u)[0];
  return leading !== "of" && hasPhrase(haystack, leading);
}
