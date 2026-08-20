// Arithmetic reconciliation across a document stack: does the math the
// documents assert actually close?
//
// Legal drafting states the same quantity three ways — a part, its whole,
// and the percentage relating them — and restates subtotals against
// totals. Nothing enforces agreement between statements pages or exhibits
// apart, which is where expensive defects live. Two identities are
// computable without a model:
//
//   part / whole = percent
//   sum(parts)   = total
//
// Tolerance follows stated precision: half a unit in the last stated
// decimal place ("82%" checks to ±0.5, "95.7%" to ±0.05). Anything the
// scan cannot pair is reported as an abstention, not guessed at; findings
// carry the arithmetic so a reader can judge materiality.
import { extractAnchors } from "./legalTextAnchors";
import {
  compileAgreementSkeleton,
  type SkeletonNode,
} from "../../src/lib/legalTextSkeleton";

export interface ConflictDocument {
  name: string;
  text: string;
}

export interface FigureRef {
  document: string;
  display: string;
  value: number;
  excerpt: string;
  /** char offset of the figure in its document: where to quote from */
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

export interface ConflictFinding {
  kind: "percent_of_whole" | "sum_of_parts";
  /** value-key unit family the figures share (sqft, acre, dlr, …) */
  unit: string;
  scope: "cross-document" | "same-document";
  /** the arithmetic, spelled out */
  detail: string;
  part?: FigureRef;
  whole?: FigureRef;
  stated_percent?: number;
  implied_percent?: number;
  /** whole × stated percent: what the part would be if the percent held */
  expected_part?: number;
  /** the stated percent was hedged (approximately/about/environ) */
  approximate?: boolean;
  parts?: FigureRef[];
  parts_sum?: number;
  total?: FigureRef;
}

export interface ConflictAbstention {
  reason: "unjoined_percent_claim" | "scan_capped" | "incomplete_parts_column";
  detail: string;
  count: number;
}

export interface ConflictScanReport {
  findings: ConflictFinding[];
  /** identities checked that closed within tolerance */
  consistent: number;
  checks: { percent_of_whole: number; sum_of_parts: number };
  abstentions: ConflictAbstention[];
  anchors_examined: number;
}

/** Quantity classes whose values can appear as part, whole, or summand. */
const QUANTITY_CLASSES = new Set(["area", "money"]);

/** "112,940 RSF leased of 118,000 RSF": the gap that links part to whole. */
const OF_GAP_RE = /\b(?:of|out of|de|d['’]|sur)\b/iu;
const MAX_OF_GAP = 40;
const GAP_WORD_RE = /[\p{L}\p{N}']+/gu;

/**
 * True part-of-whole idiom puts the linker right after the part ("leased
 * of", "of the approximately"); a linker buried behind a phrase ("Pending
 * TI allowance of $485,000") belongs to that phrase, not to the pair. A
 * colon in the gap opens a new labeled field ("Initial draw: $1,000 Line
 * of credit: $4,000"), so the "of" belongs to that label, not to a pair.
 */
function ofLinked(gap: string): boolean {
  if (gap.length > MAX_OF_GAP) return false;
  if (gap.includes(":")) return false;
  const linker = OF_GAP_RE.exec(gap);
  if (!linker) return false;
  const wordsBefore = gap.slice(0, linker.index).match(GAP_WORD_RE) ?? [];
  return wordsBefore.length <= 1;
}
/** A percent restating a pair sits in its span or just outside either end. */
const PERCENT_REACH = 40;
const CLAIM_REACH = 200;
const LABEL_REACH = 60;
const COMPANION_REACH = 300;
const APPROX_RE = /\b(?:approximately|about|roughly|environ|~)\s*$/iu;
const OCCUPANCY_RE = /occupi|occupanc|leased|vacan|lou[ée]/iu;
const PART_LABEL_RE = /\bleased\b|\blou[ée]e?s?\b/iu;
const SUBTOTAL_LABEL_RE = /sub-?total|sous-total/iu;
const TOTAL_LABEL_RE = /\btotal\b|\btotaux\b/iu;
/** How far past its last part a stated total may sit and still be its total. */
const TOTAL_LOCALITY = 240;
const MAX_FINDINGS = 40;
const EXCERPT_CHARS = 160;

interface Fig {
  document: string;
  unit: string;
  value: number;
  raw: string;
  index: number;
  end: number;
  /** already explained by a checked local part-of-whole triple */
  consumed: boolean;
}

interface Pct {
  document: string;
  value: number;
  /** half a unit in the last stated decimal place */
  tolerance: number;
  raw: string;
  index: number;
  end: number;
  approximate: boolean;
  consumed: boolean;
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

type SectionAt = (at: number) => Promise<string | null>;

/**
 * Deepest skeleton node containing an offset, as a citable label. The
 * skeleton is compiled at most once per document and only when a finding
 * actually needs a handle, so clean documents pay nothing.
 *
 * The recovery stays on: a `ConflictDocument` is Library text, i.e. PDF/DOCX
 * extraction output — an uploaded Act included — and recovering line breaks
 * an extractor lost is what it is for. Legislation is scoped out where it
 * arrives from an AUTHORITATIVE feed carrying the publisher's line breaks
 * (the A2AJ lane in `passageRetrieval`), and no such feed reaches this scan.
 */
function sectionResolver(text: string): SectionAt {
  let nodes: Promise<SkeletonNode[]> | null = null;
  return async (at) => {
    nodes ??= compileAgreementSkeleton(text).then((skeleton) => skeleton.nodes);
    let best: SkeletonNode | null = null;
    for (const node of await nodes) {
      if (node.start > at || at >= node.end) continue;
      if (!best || node.depth > best.depth) best = node;
    }
    return best?.label ?? null;
  };
}

const noSection: SectionAt = async () => null;

const ref = async (
  text: string,
  fig: Fig,
  sectionAt: SectionAt,
): Promise<FigureRef> => ({
  document: fig.document,
  display: fig.raw,
  value: fig.value,
  at: fig.index,
  section: await sectionAt(fig.index),
  ...excerptAt(text, fig.index, fig.raw.length),
});

const fmt = (value: number) =>
  Number(value.toFixed(2)).toLocaleString("en-US");

/** Decimal places actually written, from the surface form. */
function statedDecimals(raw: string): number {
  const match = raw.match(/\d+[.,](\d+)/u);
  return match ? match[1].length : 0;
}

/** The label text owned by a figure: back to the previous anchor, capped. */
function labelBefore(
  text: string,
  fig: { index: number },
  anchors: Array<{ end: number; index: number }>,
): string {
  let floor = Math.max(0, fig.index - LABEL_REACH);
  for (const other of anchors) {
    if (other.end <= fig.index && other.end > floor) floor = other.end;
  }
  return text.slice(floor, fig.index);
}

export async function conflictScan(
  documents: readonly ConflictDocument[],
): Promise<ConflictScanReport> {
  const findings: ConflictFinding[] = [];
  const seen = new Set<string>();
  let consistent = 0;
  let anchorsExamined = 0;
  let unjoinedClaims = 0;
  let incompleteColumns = 0;
  const checks = { percent_of_whole: 0, sum_of_parts: 0 };

  const emit = (finding: ConflictFinding, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  interface Claim {
    unit: string;
    whole: Fig;
    pct: Pct;
    document: string;
  }
  const claims: Claim[] = [];
  const partFigs: Array<{ fig: Fig; text: string }> = [];
  const figsByDocument = new Map<
    string,
    { text: string; figs: Fig[]; sectionAt: SectionAt }
  >();

  for (const document of documents) {
    const hits = extractAnchors(document.text);
    const sectionAt = sectionResolver(document.text);
    const figs: Fig[] = [];
    const pcts: Pct[] = [];
    for (const hit of hits) {
      const [cls, unit, value] = hit.norm.split(":");
      if (QUANTITY_CLASSES.has(cls)) {
        anchorsExamined += 1;
        figs.push({
          document: document.name,
          unit,
          value: Number(value),
          raw: hit.raw,
          index: hit.index,
          end: hit.index + hit.raw.length,
          consumed: false,
        });
      } else if (cls === "pct") {
        anchorsExamined += 1;
        pcts.push({
          document: document.name,
          value: Number(unit),
          tolerance: 0.5 * 10 ** -statedDecimals(hit.raw),
          raw: hit.raw,
          index: hit.index,
          end: hit.index + hit.raw.length,
          approximate: APPROX_RE.test(
            document.text.slice(Math.max(0, hit.index - 30), hit.index),
          ),
          consumed: false,
        });
      }
    }
    figs.sort((a, b) => a.index - b.index);
    pcts.sort((a, b) => a.index - b.index);
    figsByDocument.set(document.name, { text: document.text, figs, sectionAt });

    // The words-and-numerals convention restates one percent twice
    // ("five percent (5%)"); keep the digit form's precision.
    const dedupedPcts = pcts.filter(
      (pct, i) =>
        !(
          i > 0 &&
          pcts[i - 1].value === pct.value &&
          pct.index - pcts[i - 1].end <= 40
        ),
    );

    const allAnchors = [...figs, ...dedupedPcts];

    // Identity 1, stated locally: "<part> … of <whole> … (<percent>)".
    for (let i = 0; i < figs.length; i += 1) {
      for (let j = i + 1; j < figs.length; j += 1) {
        const part = figs[i];
        const whole = figs[j];
        if (part.unit !== whole.unit) continue;
        if (part.value >= whole.value || whole.value === 0) continue;
        if (!ofLinked(document.text.slice(part.end, whole.index))) continue;
        const near = dedupedPcts
          .filter(
            (pct) =>
              !pct.consumed &&
              pct.end >= part.index - PERCENT_REACH &&
              pct.index <= whole.end + PERCENT_REACH,
          )
          .sort(
            (a, b) =>
              Math.min(
                Math.abs(a.index - whole.end),
                Math.abs(part.index - a.end),
              ) -
              Math.min(
                Math.abs(b.index - whole.end),
                Math.abs(part.index - b.end),
              ),
          );
        const pct = near[0];
        if (!pct) continue;
        pct.consumed = true;
        part.consumed = true;
        whole.consumed = true;
        checks.percent_of_whole += 1;
        const implied = (part.value / whole.value) * 100;
        if (Math.abs(implied - pct.value) <= pct.tolerance) {
          consistent += 1;
          continue;
        }
        const expected = (whole.value * pct.value) / 100;
        emit(
          {
            kind: "percent_of_whole",
            unit: part.unit,
            scope: "same-document",
            detail:
              `${fmt(whole.value)} × ${pct.value}% = ${fmt(expected)} ≠ ` +
              `${fmt(part.value)} stated (Δ ${fmt(Math.abs(part.value - expected))}; ` +
              `stated figures imply ${fmt(implied)}%)`,
            part: await ref(document.text, part, sectionAt),
            whole: await ref(document.text, whole, sectionAt),
            stated_percent: pct.value,
            implied_percent: Number(implied.toFixed(2)),
            expected_part: expected,
            approximate: pct.approximate,
          },
          `pw:${part.unit}:${part.value}:${whole.value}:${pct.value}`,
        );
      }
    }

    // Identity 1, stated pages apart: a percent tied to a whole here
    // ("… 312,000 rentable square feet … 82% occupied"), the part it
    // implies stated elsewhere ("Total Leased … 258,140 SF").
    for (const pct of dedupedPcts) {
      if (pct.consumed) continue;
      const context = document.text.slice(
        Math.max(0, pct.index - 80),
        pct.end + 80,
      );
      if (!OCCUPANCY_RE.test(context)) continue;
      const nearestByUnit = new Map<string, Fig>();
      for (const fig of figs) {
        if (fig.end < pct.index - CLAIM_REACH) continue;
        if (fig.index > pct.end + CLAIM_REACH) continue;
        const distance = Math.min(
          Math.abs(pct.index - fig.end),
          Math.abs(fig.index - pct.end),
        );
        const held = nearestByUnit.get(fig.unit);
        const heldDistance = held
          ? Math.min(Math.abs(pct.index - held.end), Math.abs(held.index - pct.end))
          : Infinity;
        if (distance < heldDistance) nearestByUnit.set(fig.unit, fig);
      }
      if (!nearestByUnit.size) {
        unjoinedClaims += 1;
        continue;
      }
      for (const [unit, whole] of nearestByUnit) {
        claims.push({ unit, whole, pct, document: document.name });
      }
    }

    // Figures labeled as the leased/occupied part of some whole. A figure
    // a local triple already explained cannot be a claim's part as well.
    for (const fig of figs) {
      if (fig.consumed) continue;
      if (PART_LABEL_RE.test(labelBefore(document.text, fig, allAnchors))) {
        partFigs.push({ fig, text: document.text });
      }
    }

    // Identity 2: subtotal columns against stated totals.
    const subtotalFigs = figs.filter((fig) =>
      SUBTOTAL_LABEL_RE.test(labelBefore(document.text, fig, allAnchors)),
    );
    const totalFigs = figs.filter((fig) => {
      const label = labelBefore(document.text, fig, allAnchors);
      return TOTAL_LABEL_RE.test(label) && !SUBTOTAL_LABEL_RE.test(label);
    });
    const totalSet = new Set(totalFigs);
    const units = new Set(subtotalFigs.map((fig) => fig.unit));
    for (const unit of units) {
      const leads = subtotalFigs.filter((fig) => fig.unit === unit);
      if (leads.length < 2) continue;
      // Each subtotal line may pair its figure with an of-linked whole
      // ("112,940 RSF leased of 118,000 RSF"): sum both columns.
      const partners = leads.map((lead) => {
        const next = figs.find(
          (fig) =>
            fig.unit === unit &&
            fig.index > lead.end &&
            ofLinked(document.text.slice(lead.end, fig.index)),
        );
        return next ?? null;
      });
      const columns: Fig[][] = [leads];
      if (partners.every(Boolean)) columns.push(partners as Fig[]);
      const columnFigs = new Set(columns.flat());
      for (const column of columns) {
        const sum = column.reduce((total, fig) => total + fig.value, 0);
        const runEnd = Math.max(...column.map((fig) => fig.end));
        const comparable = totalFigs.filter(
          (fig) => fig.unit === unit && sum / fig.value > 0.9 && sum / fig.value < 1.1,
        );
        if (!comparable.length) continue;
        // A stated total owns this run only if it follows the last part
        // within a table's reach and no same-unit figure the column did
        // not account for sits between: an intervening figure is evidence
        // the parts list is incomplete, so the sum proves nothing.
        const local = comparable.filter(
          (fig) =>
            fig.index >= runEnd &&
            fig.index - runEnd <= TOTAL_LOCALITY &&
            !figs.some(
              (other) =>
                other.unit === unit &&
                other.index >= runEnd &&
                other.index < fig.index &&
                !columnFigs.has(other) &&
                !totalSet.has(other),
            ),
        );
        if (!local.length) {
          incompleteColumns += 1;
          continue;
        }
        checks.sum_of_parts += 1;
        const exact = local.find((fig) => fig.value === sum);
        if (exact) {
          consistent += 1;
          continue;
        }
        const total = local[0];
        emit(
          {
            kind: "sum_of_parts",
            unit,
            scope: "same-document",
            detail:
              `${column.map((fig) => fmt(fig.value)).join(" + ")} = ${fmt(sum)} ≠ ` +
              `${fmt(total.value)} stated total (Δ ${fmt(Math.abs(sum - total.value))})`,
            parts: await Promise.all(
              column.map((fig) => ref(document.text, fig, sectionAt)),
            ),
            parts_sum: sum,
            total: await ref(document.text, total, sectionAt),
          },
          `sp:${unit}:${sum}:${total.value}`,
        );
      }
    }
  }

  // Join the claims: a claim's whole must be restated near the part
  // figure, which is what licenses treating them as the same quantity.
  for (const claim of claims) {
    let joined = false;
    const wholeHome = figsByDocument.get(claim.document);
    for (const { fig: part, text } of partFigs) {
      if (part.unit !== claim.unit || part.value >= claim.whole.value) continue;
      const home = figsByDocument.get(part.document);
      if (!home) continue;
      const companion = home.figs.find(
        (fig) =>
          fig.unit === claim.unit &&
          fig.value === claim.whole.value &&
          fig !== part &&
          Math.abs(fig.index - part.index) <= COMPANION_REACH,
      );
      if (!companion) continue;
      joined = true;
      checks.percent_of_whole += 1;
      const implied = (part.value / claim.whole.value) * 100;
      if (Math.abs(implied - claim.pct.value) <= claim.pct.tolerance) {
        consistent += 1;
        continue;
      }
      const expected = (claim.whole.value * claim.pct.value) / 100;
      emit(
        {
          kind: "percent_of_whole",
          unit: claim.unit,
          scope:
            claim.document === part.document
              ? "same-document"
              : "cross-document",
          detail:
            `${fmt(claim.whole.value)} × ${claim.pct.value}% = ${fmt(expected)} ≠ ` +
            `${fmt(part.value)} stated (Δ ${fmt(Math.abs(part.value - expected))}; ` +
            `stated figures imply ${fmt(implied)}%)`,
          part: await ref(text, part, home.sectionAt),
          whole: await ref(
            wholeHome?.text ?? "",
            claim.whole,
            wholeHome?.sectionAt ?? noSection,
          ),
          stated_percent: claim.pct.value,
          implied_percent: Number(implied.toFixed(2)),
          expected_part: expected,
          approximate: claim.pct.approximate,
        },
        `pw:${claim.unit}:${part.value}:${claim.whole.value}:${claim.pct.value}`,
      );
    }
    if (!joined) unjoinedClaims += 1;
  }

  findings.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "cross-document" ? -1 : 1;
    return 0;
  });

  const abstentions: ConflictAbstention[] = [];
  if (unjoinedClaims) {
    abstentions.push({
      reason: "unjoined_percent_claim",
      detail:
        "percentage claims whose part or whole is stated nowhere the scan can pair; not checked",
      count: unjoinedClaims,
    });
  }
  if (incompleteColumns) {
    abstentions.push({
      reason: "incomplete_parts_column",
      detail:
        "parts columns with an unaccounted same-unit figure before the stated total, or no total local to the run; not checked",
      count: incompleteColumns,
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
