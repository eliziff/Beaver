/**
 * Derived-value carry-through scan — a deterministic omission organ.
 *
 * General legal pattern: an analytical deliverable asserts that a money
 * amount M "represents / accounts for / is P% of <base>" and a whole W is
 * stated for that base ("total revenue of W"). When a drafter restates one
 * half of the identity (the percent, or the amount) and drops the other, a
 * reader cannot size the risk. This organ finds those stated identities in
 * the source stack and reports the half the deliverable engaged but omitted.
 *
 * Identities are bound by arithmetic closure, never by proximity:
 *   part / whole ≈ percent   (within stated precision)
 * A percent that does not close an identity against a stated whole is a
 * rate, threshold, escalation, or fee point ("more than fifty percent",
 * "escalating at three percent", "from 14% to 17%") and is left alone —
 * those are not share-of-base claims and must never bind (CLAUDE.md rule 5;
 * measured: naive proximity pairing produced 132 false omissions on the
 * change-of-control stack, closure pairing produced the 5 real ones).
 *
 * Scope: analytical deliverables only. In operative drafting (a contract
 * clause "fee equal to 14% of Net Revenue") the percent IS the operative
 * term and the underlying amount may legitimately be absent; the caller
 * gates this organ to analytical requests.
 *
 * Measure-first basis (2026-08-03, change-of-control stack, 19 sources +
 * draft): 81 percent-of-base claims, 20 closed identities, 5 draft
 * engagement omissions — each matching a failed gold criterion (C-008
 * $22.1M/25.3%, C-009 $23.9M/27.4%, C-010 $9.1M/10.4%); zero false
 * positives on that stack.
 *
 * Generalization probe (2026-08-03, whole vendored LAB corpus): the trigger
 * pattern is not change-of-control-specific — 80 tasks across ~15 families
 * state closed percent-of-base identities. But value-only draft engagement
 * collides unrelated percents: a draft citing "pricing 4%–7% lower" or
 * "using a 5% threshold" is a different claim than the source's "7% of
 * industry revenue" or "5% of purchase price", and range text like
 * "8%–12% price increases" parses as a 12% anchor that value-collides with
 * an 11.6% identity. The engagement gate therefore requires the draft's
 * percent to be stated as "of <base>" matching the identity's base; measured,
 * that drops 8 cross-family false findings while preserving the 5
 * change-of-control ones. Percent-is-the-finding task kinds (antitrust share,
 * HSR thresholds) and operative drafting are additionally gated by the caller.
 */
import { extractAnchors } from "./legalTextAnchors";

export interface DerivedValueDocument {
  name: string;
  text: string;
}

export interface DerivedValueRef {
  document: string;
  display: string;
  value: number;
  /** char offset in the document: where to quote from */
  at: number;
  excerpt: string;
}

export interface DerivedValueOmission {
  kind: "derived_value_omission";
  /**
   * "percent_without_amount": the deliverable restates the percent but omits
   * the amount; "amount_without_percent": the reverse.
   */
  direction: "percent_without_amount" | "amount_without_percent";
  /** the base noun the percent is a share of ("revenue", "value", …) */
  base: string;
  /** the arithmetic, spelled out */
  detail: string;
  part: DerivedValueRef;
  percent: DerivedValueRef;
  whole: DerivedValueRef;
}

const MAX_FINDINGS = 12;
const EXCERPT_CHARS = 160;

/** Relative tolerance for amount identity. */
const VALUE_TOL = 0.02;
/** Percent tolerance: half a unit in the last stated decimal place. */
const PCT_TOL = 0.55;
/** How far after a percent the "of <base>" idiom may sit. */
const OF_REACH = 16;
/** How far a part amount may sit from its percent. */
const PART_REACH = 220;
/**
 * Cross-document whole index reach: how close a base noun must sit to a money
 * anchor in ANOTHER source for that anchor to serve as the whole (C2). Wider
 * than the single-document 60-char label window because the whole's label can
 * be a sentence away ("total revenue was $87,300,000").
 */
const CROSS_DOC_BASE_REACH = 500;
/** Percent is a threshold, not a share, when these precede it. */
const THRESHOLD_RE =
  /\b(?:more than|less than|at least|not less than|at most|no more than|exceeding|equal to|up to|at or above|at or below|in excess of)\b/iu;
/** Bases that can carry a money whole ("% of total revenue"). */
const BASE_RE =
  /\b(?:revenue|sales|income|earnings|ebitda?|value|net worth|assets?|capital|equity|interest|shares?|fees?|cost|price|expenses?|revenue share|turnover|profit|consideration|premium|principal|notional|commitment|market cap|enterprise value|aum)\b/iu;
/** Stop words inside the base label ("of the Company's total 2024 revenue"). */
const BASE_NORM_RE =
  /\b(?:total|annual|net|gross|adjusted|consolidated|fiscal|202[0-9]|the|company['’]?s|its)\b/giu;

interface MoneyAnchor {
  value: number;
  raw: string;
  index: number;
  end: number;
}
interface PctAnchor {
  value: number;
  raw: string;
  index: number;
  end: number;
}

const moneyAnchors = (text: string): MoneyAnchor[] => {
  const out: MoneyAnchor[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "money") continue;
    const [, , value] = hit.norm.split(":");
    const v = Number(value);
    if (Number.isFinite(v)) {
      out.push({ value: v, raw: hit.raw, index: hit.index, end: hit.index + hit.raw.length });
    }
  }
  return out;
};

const pctAnchors = (text: string): PctAnchor[] => {
  const out: PctAnchor[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "percent") continue;
    const [, value] = hit.norm.split(":");
    const v = Number(value);
    if (Number.isFinite(v)) {
      out.push({ value: v, raw: hit.raw, index: hit.index, end: hit.index + hit.raw.length });
    }
  }
  return out;
};

const excerptAt = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - EXCERPT_CHARS / 2);
  const end = Math.min(text.length, at + length + EXCERPT_CHARS / 2);
  const window = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return (start > 0 ? "…" : "") + window + (end < text.length ? "…" : "");
};

const fmt = (value: number) =>
  Number(value.toFixed(2)).toLocaleString("en-US");

/** The base noun a percent claims to be "of", or null (a rate, not a share). */
function ofBase(text: string, pct: PctAnchor): string | null {
  const lead = text.slice(pct.end, pct.end + OF_REACH);
  const of = /\bof\b/iu.exec(lead);
  if (!of) return null;
  const rest = text.slice(pct.end + of.index + of[0].length, pct.end + OF_REACH + 80);
  const base = BASE_RE.exec(rest);
  if (!base) return null;
  return (base[0].toLowerCase().replace(BASE_NORM_RE, "").trim() || base[0]).toLowerCase();
}

const hasMoneyNear = (anchors: MoneyAnchor[], value: number): boolean => {
  for (const a of anchors) {
    if (Math.abs(a.value - value) / Math.max(value, 1) <= VALUE_TOL) return true;
  }
  return false;
};

/** The draft's percent engages an identity only when it shares the base. */
const hasEngagedPct = (
  anchors: PctAnchor[],
  text: string,
  value: number,
  base: string,
): boolean => {
  for (const a of anchors) {
    if (Math.abs(a.value - value) > PCT_TOL) continue;
    if (ofBase(text, a) === base) return true;
  }
  return false;
};

/**
 * Whether the base noun appears within `reach` chars around a money anchor.
 * Used by the cross-document whole index (C2), where the whole may sit in a
 * different source and its label can be a full sentence away from the amount.
 */
const baseNear = (
  text: string,
  m: MoneyAnchor,
  base: string,
  reach: number,
): boolean => {
  const start = Math.max(0, m.index - reach);
  const end = Math.min(text.length, m.end + reach);
  return text.slice(start, end).toLowerCase().includes(base);
};

/** A part + percent whose whole is not stated in the part's own document. */
interface UnclosedIdentity {
  source: DerivedValueDocument;
  part: MoneyAnchor;
  percent: PctAnchor;
  base: string;
}

/**
 * Scan the source stack for stated (part, percent-of-base, whole) identities
 * and report the halves the drafted deliverable engaged but omitted. One
 * document's pair may be stated twice (prose + table): dedupe on identity.
 */
export function derivedValueScan(
  sources: readonly DerivedValueDocument[],
  draft: DerivedValueDocument,
): DerivedValueOmission[] {
  const draftMoney = moneyAnchors(draft.text);
  const draftPct = pctAnchors(draft.text);
  const findings: DerivedValueOmission[] = [];
  const seen = new Set<string>();
  const cap = MAX_FINDINGS;

  const push = (
    source: string,
    text: string,
    part: MoneyAnchor,
    percent: PctAnchor,
    whole: MoneyAnchor,
    wholeSource: string,
    wholeText: string,
    base: string,
    direction: DerivedValueOmission["direction"],
  ) => {
    const key = `dv:${part.value}:${percent.value}:${whole.value}:${direction}`;
    if (seen.has(key)) return;
    seen.add(key);
    const wholeNote = wholeSource === source ? "" : `; whole from ${wholeSource}`;
    findings.push({
      kind: "derived_value_omission",
      direction,
      base,
      detail:
        direction === "percent_without_amount"
          ? `${fmt(whole.value)} ${base} × ${percent.value}% = ${fmt((whole.value * percent.value) / 100)} — the deliverable states ${percent.value}% of ${base} but never the amount (${source}${wholeNote})`
          : `${part.raw} = ${percent.value}% of ${fmt(whole.value)} ${base} — the deliverable states the amount ${part.raw} but never the ${percent.value}% share (${source}${wholeNote})`,
      part: {
        document: source,
        display: part.raw,
        value: part.value,
        at: part.index,
        excerpt: excerptAt(text, part.index, part.raw.length),
      },
      percent: {
        document: source,
        display: percent.raw,
        value: percent.value,
        at: percent.index,
        excerpt: excerptAt(text, percent.index, percent.raw.length),
      },
      whole: {
        document: wholeSource,
        display: whole.raw,
        value: whole.value,
        at: whole.index,
        excerpt: excerptAt(wholeText, whole.index, whole.raw.length),
      },
    });
    if (findings.length >= cap) return;
  };

  // Money anchors are extracted once per source and reused by both the
  // single-document pass and the cross-document whole index (C2).
  const sourceMoney = sources.map((doc) => ({ doc, money: moneyAnchors(doc.text) }));
  // Identities where part + percent close but the whole is not stated in the
  // part's own document; the cross-document pass below binds them.
  const unclosed: UnclosedIdentity[] = [];

  for (const { doc, money } of sourceMoney) {
    const text = doc.text;
    const pct = pctAnchors(text);
    for (const p of pct) {
      // Threshold percents ("more than fifty percent") are not shares.
      const before = text.slice(Math.max(0, p.index - 40), p.index);
      if (THRESHOLD_RE.test(before)) continue;
      // Totality statements ("100% of the Equity Interests", "0% of the
      // capital stock") are not share-of-pool claims: the part IS the whole,
      // so there is no derived value for a reader to size. Measured on the
      // indenture stack: a "$15,000,000 = 100% of $15,000,000" identity
      // produced a nonsense amount_without_percent finding.
      if (p.value >= 99.5 || p.value <= 0.5) continue;
      const base = ofBase(text, p);
      if (!base) continue;
      // The part amount: nearest money to the percent.
      let part: MoneyAnchor | null = null;
      let bestGap = Infinity;
      for (const m of money) {
        const g = Math.min(Math.abs(m.index - p.end), Math.abs(p.index - m.index));
        if (g <= PART_REACH && g < bestGap) {
          part = m;
          bestGap = g;
        }
      }
      if (!part) continue;
      // The whole: a money in the same source labeled with the base noun.
      let whole: MoneyAnchor | null = null;
      for (const m of money) {
        if (m === part) continue;
        const label = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
        if (!label.includes(base)) continue;
        if (Math.abs((part.value / m.value) * 100 - p.value) > PCT_TOL) continue;
        whole = m;
        break;
      }
      if (!whole) {
        unclosed.push({ source: doc, part, percent: p, base });
        continue;
      }
      // Engagement gate: the draft must carry one half *of this identity*,
      // else this is a coverage gap, not a carry-through omission. The draft's
      // percent must be stated as "of <base>" matching the identity's base —
      // a bare percent or one naming a different base is a different claim and
      // must not bind (measured collision: see header).
      const draftHasPct = hasEngagedPct(draftPct, draft.text, p.value, base);
      const draftHasMoney = hasMoneyNear(draftMoney, part.value);
      if (draftHasPct && !draftHasMoney) {
        push(doc.name, text, part, p, whole, doc.name, text, base, "percent_without_amount");
      } else if (!draftHasPct && draftHasMoney) {
        push(doc.name, text, part, p, whole, doc.name, text, base, "amount_without_percent");
      }
    }
  }

  // Cross-document whole index (audit finding C2): the whole amount is often
  // stated in a SEPARATE source ("total revenue = $87.3M" in a financial
  // exhibit) while the part + percent sit in the deal memo. When a source
  // pairs part + percent without a closing whole, scan every source for a
  // money anchor whose surrounding text carries the base noun and whose value
  // closes the identity (part / whole ≈ percent). The finding then names the
  // whole's document so the repair prompt can find it without re-searching.
  for (const un of unclosed) {
    let whole: MoneyAnchor | null = null;
    let wholeDoc: DerivedValueDocument | null = null;
    outer: for (const { doc, money } of sourceMoney) {
      for (const m of money) {
        if (m === un.part) continue;
        if (!baseNear(doc.text, m, un.base, CROSS_DOC_BASE_REACH)) continue;
        if (Math.abs((un.part.value / m.value) * 100 - un.percent.value) > PCT_TOL) continue;
        whole = m;
        wholeDoc = doc;
        break outer;
      }
    }
    if (!whole || !wholeDoc) continue;
    const draftHasPct = hasEngagedPct(draftPct, draft.text, un.percent.value, un.base);
    const draftHasMoney = hasMoneyNear(draftMoney, un.part.value);
    if (draftHasPct && !draftHasMoney) {
      push(un.source.name, un.source.text, un.part, un.percent, whole, wholeDoc.name, wholeDoc.text, un.base, "percent_without_amount");
    } else if (!draftHasPct && draftHasMoney) {
      push(un.source.name, un.source.text, un.part, un.percent, whole, wholeDoc.name, wholeDoc.text, un.base, "amount_without_percent");
    }
  }

  return findings.slice(0, cap);
}
