/**
 * Probe for the H1 stated-pair carry-through omission detector (plan §4 H1).
 *
 * General mechanism (not CoC-specific): a source asserts that a money amount
 * M "represents/accounts for P% of <base>" (base = total revenue, total value,
 * adjusted EBITDA, net worth, …), and states the whole W for that base
 * elsewhere ("total revenue of W"). Identity: M/W ≈ P within stated precision.
 * The drafted deliverable may then restate one half of the identity (P% or M)
 * and drop the other. The omission organ flags "draft engages P% but never the
 * amount M" (or the reverse), bounded + source-addressed.
 *
 * Anti-overfit (CLAUDE.md + repo doctrine): the binding is gated on identity
 * closure, never on the specific task/values. A percent that does not close an
 * identity against a stated whole is a rate/threshold/escalation and is left
 * alone. The naive proximity pairing (percent near money) is measured below and
 * rejected: 132 false omissions on this stack.
 *
 * Run: npx tsx scripts/cof-omission-probe.ts (from backend/)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractAnchors } from "../src/lib/legalTextAnchors";

const SRC_DIR = "C:/Users/elias/Desktop/MikeOSS Fork/.tmp/cof-probe/src";
const DRAFT_FILE =
  "C:/Users/elias/Desktop/MikeOSS Fork/.tmp/cof-probe/draft/coc-analysis-report.txt";

/** Relative tolerance for amount identity. */
const VALUE_TOL = 0.02;
/** Percent tolerance: half a unit in the last stated decimal. */
const PCT_TOL = 0.55;
/** How far after a percent the "of <base>" idiom may sit. */
const OF_REACH = 16;
/** How far a part amount may sit from its percent. */
const PART_REACH = 220;
/** Percent is a threshold, not a share, when these precede it. */
const THRESHOLD_RE =
  /\b(?:more than|less than|at least|not less than|at most|no more than|exceeding|equal to|up to|at or above|at or below|in excess of)\b/iu;
/** Bases that can carry a money whole ("% of total revenue"). */
const BASE_RE =
  /\b(?:revenue|sales|income|earnings|ebitda?|value|net worth|assets?|capital|equity|interest|shares?|fees?|cost|price|expenses?|revenue share)\b/iu;
/** "of the Company's total 2024 revenue" -> normalize to "total revenue". */
const BASE_NORM_RE = /\b(?:total|annual|net|gross|adjusted|consolidated|fiscal|2024|2025|2026|the|company['’]?s|its)\b/giu;

interface MoneyAnchor {
  value: number;
  raw: string;
  index: number;
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
    if (Number.isFinite(v)) out.push({ value: v, raw: hit.raw, index: hit.index });
  }
  return out;
};

const pctAnchors = (text: string): PctAnchor[] => {
  const out: PctAnchor[] = [];
  for (const hit of extractAnchors(text)) {
    if (hit.cls !== "percent") continue;
    const [, value] = hit.norm.split(":");
    const v = Number(value);
    if (Number.isFinite(v))
      out.push({
        value: v,
        raw: hit.raw,
        index: hit.index,
        end: hit.index + hit.raw.length,
      });
  }
  return out;
};

const hasMoneyNear = (
  anchors: MoneyAnchor[],
  value: number,
): MoneyAnchor | null => {
  for (const a of anchors) {
    if (Math.abs(a.value - value) / Math.max(value, 1) <= VALUE_TOL) return a;
  }
  return null;
};

const hasPctNear = (anchors: PctAnchor[], value: number): PctAnchor | null => {
  for (const a of anchors) {
    if (Math.abs(a.value - value) <= PCT_TOL) return a;
  }
  return null;
};

/** The base noun a percent claims to be "of", or null. */
function ofBase(text: string, pct: PctAnchor): string | null {
  const lead = text.slice(pct.end, pct.end + OF_REACH);
  const m = /\bof\b/iu.exec(lead);
  if (!m) return null;
  const rest = text.slice(pct.end + m.index + m[0].length, pct.end + OF_REACH + 80);
  const base = BASE_RE.exec(rest);
  if (!base) return null;
  return (base[0].toLowerCase().replace(BASE_NORM_RE, "").trim() || base[0]).toLowerCase();
}

function main(): void {
  const draftText = readFileSync(DRAFT_FILE, "utf8");
  const draftMoney = moneyAnchors(draftText);
  const draftPct = pctAnchors(draftText);

  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".txt")).sort();
  const findings: string[] = [];
  let claims = 0;
  let closed = 0;
  let engaged = 0;

  for (const file of files) {
    const text = readFileSync(path.join(SRC_DIR, file), "utf8");
    const money = moneyAnchors(text);
    const pct = pctAnchors(text);
    for (const p of pct) {
      // Threshold percents ("more than fifty percent") are not shares.
      const before = text.slice(Math.max(0, p.index - 40), p.index);
      if (THRESHOLD_RE.test(before)) continue;
      const base = ofBase(text, p);
      if (!base) continue; // no "of <base>" — a rate/escalation/fee, not a share.
      claims += 1;
      // The part amount: nearest money to the percent.
      let part: MoneyAnchor | null = null;
      let bestGap = Infinity;
      for (const m of money) {
        const g = Math.min(
          Math.abs(m.index - p.end),
          Math.abs(p.index - m.index),
        );
        if (g <= PART_REACH && g < bestGap) {
          part = m;
          bestGap = g;
        }
      }
      if (!part) continue;
      // The whole: any money in this source labeled <base> (order-free join).
      let whole: MoneyAnchor | null = null;
      for (const m of money) {
        if (m === part) continue;
        const label = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
        if (!label.includes(base) && !label.includes("total")) continue;
        const ratio = (part.value / m.value) * 100;
        if (Math.abs(ratio - p.value) <= PCT_TOL) {
          whole = m;
          break;
        }
      }
      if (!whole) continue;
      closed += 1;
      // Omission mode: draft engages the percent but omits the amount.
      const draftHasPct = hasPctNear(draftPct, p.value);
      const draftHasMoney = hasMoneyNear(draftMoney, part.value);
      if (draftHasPct && !draftHasMoney) {
        engaged += 1;
        findings.push(
          `OMISSION  ${file}: ${part.raw} / ${p.raw} of <${base}> / whole ${whole.raw}` +
            ` — draft states ${p.raw} but no amount ≈ ${part.raw}`,
        );
      } else if (!draftHasPct && draftHasMoney) {
        engaged += 1;
        findings.push(
          `OMISSION  ${file}: ${part.raw} / ${p.raw} of <${base}> / whole ${whole.raw}` +
            ` — draft states amount ${part.raw} but no ${p.raw}`,
        );
      }
    }
  }

  console.log(`DRAFT: money=${draftMoney.length} pct=${draftPct.length}`);
  console.log(`SRC percent-of-base claims: ${claims}  closed identities: ${closed}`);
  console.log(`draft-engagement omissions: ${findings.length}`);
  console.log("\n=== FINDINGS ===");
  for (const f of findings) console.log(f);
}

main();
