/**
 * Figure reconciliation — provenance for the figures a deliverable states.
 *
 * NOT a calculator wing. The measured record says arithmetic is not the
 * problem: across the Harvey-LAB Phase C grid, 181 of 185 derived money figures
 * (97.8%) reconstruct exactly from source values by a single operation, the
 * four residuals are range-expression parse artifacts, and there are zero
 * computed-date errors. Adding arithmetic tools measured NET NEGATIVE.
 *
 * What did cost criteria is BASE SELECTION and incomplete quotation from an
 * already-served passage. The named case (`white-collar/…floor`, criteria
 * C-028 and C-031) is one paragraph of served text that states both readings:
 *
 *   "…the credit shall be $92,500,000 (the 'CFTC Offset'). The net amount
 *    payable … shall be $300,000,000 ($392,500,000 minus $92,500,000 …). …
 *    (i) The first installment shall be $274,750,000 less $64,750,000 …
 *    yielding a net first installment payment of $210,000,000"
 *
 * The deliverable wrote "70% net ($210,000,000)". 70% of the NET base is
 * $210,000,000; 70% of the GROSS base fifteen characters earlier is
 * $274,750,000 — and the source states that number too. Both figures are
 * verbatim-true; only one answers the question. No arithmetic check can see
 * this, because no arithmetic is wrong.
 *
 * So this module reports two things:
 *
 *  1. Provenance per figure — VERBATIM (the value key occurs in served text),
 *     RECONSTRUCTIBLE (a single operation over two served figures inside one
 *     served window, with the bases named), or UNGROUNDED.
 *  2. COMPETING-BASE ambiguity — the deliverable states "p% … F"; a served base
 *     B satisfies p%·B = F; a different base B' sits within a short window of B
 *     in the same served passage; and p%·B' is ITSELF attested verbatim in the
 *     served text. That last condition is the precision mechanism: the source
 *     computed both readings, so the deliverable picked one of two
 *     source-stated answers and a reader cannot tell which was meant.
 *
 * Value keys come from `extractAnchors`, which already collides "$2.25 million"
 * with "$2,250,000", so formatting never manufactures a finding. Nothing here
 * calls a model, and the module holds no I/O: served text and its offsets are
 * the caller's to supply.
 */
import { extractAnchors } from "../deterministic-library-analysis/legalTextAnchors";

/** A contiguous run of served source text, with its offset on the doc plane. */
export interface ServedPassage {
  document: string;
  /** the served characters */
  text: string;
  /** offset of text[0] on the document's served body plane */
  at: number;
}

export type FigureStatus = "verbatim" | "reconstructible" | "ungrounded";

export interface FigureWitness {
  document: string;
  at: number;
  raw: string;
}

export interface FigureBase extends FigureWitness {
  value: number;
}

export interface FigureDerivation {
  /** "a×p%", "a−b", "a÷n", … */
  op: string;
  /** the arithmetic, spelled out */
  detail: string;
  bases: FigureBase[];
}

export interface FigureReconciliation {
  cls: "money" | "percent" | "date";
  /** the figure as the deliverable wrote it */
  raw: string;
  /** canonical value key */
  norm: string;
  /** char offset in the deliverable */
  at: number;
  status: FigureStatus;
  /** where the served text attests it (verbatim only), capped */
  witnesses: FigureWitness[];
  derivation?: FigureDerivation;
}

/** A source-stated `minuend − subtrahend = result` identity, all three figures
 *  inside one passage: the gross/net shape a percentage can be read against
 *  two ways. */
export interface AdjustmentIdentity {
  document: string;
  minuend: FigureBase;
  subtrahend: FigureBase;
  result: FigureBase;
  /** char span from the first to the last of the three */
  spanChars: number;
}

export interface CompetingBaseFinding {
  kind: "competing_base";
  /** which side of the identity the deliverable applied the percentage to */
  direction: "used-net" | "used-gross";
  /** the deliverable's sentence, whitespace-collapsed */
  draftExcerpt: string;
  draftAt: number;
  /** the percentage the deliverable pairs with the figure */
  percent: number;
  /** the figure the deliverable states */
  statedRaw: string;
  statedValue: number;
  /** the served base that yields the stated figure */
  chosenBase: FigureBase;
  /** the other side of the identity */
  competingBase: FigureBase;
  /** p% of the competing base */
  competingValue: number;
  /** served text that states the competing product verbatim */
  competingWitness: FigureWitness;
  /** the identity that makes the two bases interchangeable in prose */
  identity: AdjustmentIdentity;
}

export interface ReconciliationOptions {
  /** relative tolerance for value identity */
  tolerance: number;
  /** how far apart two served figures may sit and still compose */
  reconstructionWindow: number;
  /** how far from a stated figure the deliverable's percentage may sit */
  percentReach: number;
  /** how far from the competing base its source-stated product may sit */
  competingBaseWindow: number;
  /** the three figures of an adjustment identity must fit inside this span */
  identityWindow: number;
  /** integer divisors/multipliers admitted as a single operation */
  maxIntegerFactor: number;
  /** witnesses recorded per figure */
  maxWitnesses: number;
}

export const DEFAULT_RECONCILIATION_OPTIONS: ReconciliationOptions = {
  tolerance: 0.005,
  reconstructionWindow: 1200,
  percentReach: 120,
  competingBaseWindow: 1200,
  identityWindow: 300,
  maxIntegerFactor: 12,
  maxWitnesses: 3,
};

interface ServedHit {
  document: string;
  at: number;
  raw: string;
  norm: string;
  value: number;
}

const moneyValue = (norm: string): number | null => {
  const m = norm.match(/^money:[^:]*:(-?[\d.]+)$/u);
  return m ? Number(m[1]) : null;
};
const pctValue = (norm: string): number | null => {
  const m = norm.match(/^pct:(-?[\d.]+)$/u);
  return m ? Number(m[1]) : null;
};

const close = (a: number, b: number, tol: number) =>
  Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1);

const money = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

interface ServedIndex {
  /** every value key attested anywhere in served text */
  norms: Map<string, FigureWitness[]>;
  /** money hits per document, in offset order */
  moneyByDoc: Map<string, ServedHit[]>;
  /** percent hits per document, in offset order */
  pctByDoc: Map<string, ServedHit[]>;
}

function buildServedIndex(passages: ServedPassage[]): ServedIndex {
  const norms = new Map<string, FigureWitness[]>();
  const moneyByDoc = new Map<string, ServedHit[]>();
  const pctByDoc = new Map<string, ServedHit[]>();
  for (const passage of passages) {
    for (const hit of extractAnchors(passage.text)) {
      const at = passage.at + hit.index;
      const witness: FigureWitness = {
        document: passage.document,
        at,
        raw: hit.raw,
      };
      const list = norms.get(hit.norm);
      if (list) list.push(witness);
      else norms.set(hit.norm, [witness]);
      const value =
        hit.cls === "money"
          ? moneyValue(hit.norm)
          : hit.cls === "percent"
            ? pctValue(hit.norm)
            : null;
      if (value === null) continue;
      const target = hit.cls === "money" ? moneyByDoc : pctByDoc;
      const bucket = target.get(passage.document);
      const entry: ServedHit = {
        document: passage.document,
        at,
        raw: hit.raw,
        norm: hit.norm,
        value,
      };
      if (bucket) bucket.push(entry);
      else target.set(passage.document, [entry]);
    }
  }
  for (const bucket of moneyByDoc.values()) bucket.sort((a, b) => a.at - b.at);
  for (const bucket of pctByDoc.values()) bucket.sort((a, b) => a.at - b.at);
  return { norms, moneyByDoc, pctByDoc };
}

/** A single operation over two served figures inside one window. */
function reconstruct(
  target: number,
  index: ServedIndex,
  opts: ReconciliationOptions,
): FigureDerivation | null {
  for (const [document, hits] of index.moneyByDoc) {
    const pcts = index.pctByDoc.get(document) ?? [];
    for (let i = 0; i < hits.length; i++) {
      const a = hits[i];
      if (a.value === 0) continue;
      const base = (h: ServedHit): FigureBase => ({
        document,
        at: h.at,
        raw: h.raw,
        value: h.value,
      });
      // a op b, b within the window
      for (let j = i + 1; j < hits.length; j++) {
        const b = hits[j];
        if (b.at - a.at > opts.reconstructionWindow) break;
        if (close(a.value + b.value, target, opts.tolerance)) {
          return {
            op: "a+b",
            detail: `${money(a.value)} + ${money(b.value)} = ${money(target)}`,
            bases: [base(a), base(b)],
          };
        }
        if (close(a.value - b.value, target, opts.tolerance)) {
          return {
            op: "a−b",
            detail: `${money(a.value)} − ${money(b.value)} = ${money(target)}`,
            bases: [base(a), base(b)],
          };
        }
        if (close(b.value - a.value, target, opts.tolerance)) {
          return {
            op: "a−b",
            detail: `${money(b.value)} − ${money(a.value)} = ${money(target)}`,
            bases: [base(b), base(a)],
          };
        }
      }
      // a scaled by a percent stated nearby
      for (const p of pcts) {
        if (Math.abs(p.at - a.at) > opts.reconstructionWindow) continue;
        if (!p.value) continue;
        if (close((a.value * p.value) / 100, target, opts.tolerance)) {
          return {
            op: "a×p%",
            detail: `${p.value}% × ${money(a.value)} = ${money(target)}`,
            bases: [base(a), { document, at: p.at, raw: p.raw, value: p.value }],
          };
        }
        if (close((a.value * 100) / p.value, target, opts.tolerance)) {
          return {
            op: "a÷p%",
            detail: `${money(a.value)} ÷ ${p.value}% = ${money(target)}`,
            bases: [base(a), { document, at: p.at, raw: p.raw, value: p.value }],
          };
        }
      }
      // a scaled by a small integer
      for (let n = 2; n <= opts.maxIntegerFactor; n++) {
        if (close(a.value / n, target, opts.tolerance)) {
          return {
            op: "a÷n",
            detail: `${money(a.value)} ÷ ${n} = ${money(target)}`,
            bases: [base(a)],
          };
        }
        if (close(a.value * n, target, opts.tolerance)) {
          return {
            op: "a×n",
            detail: `${money(a.value)} × ${n} = ${money(target)}`,
            bases: [base(a)],
          };
        }
      }
    }
  }
  return null;
}

function sentenceAround(text: string, at: number): string {
  let start = at;
  while (start > 0 && !/[.\n]/u.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !/[.\n]/u.test(text[end])) end++;
  return text
    .slice(Math.max(0, start - 1), Math.min(text.length, end + 1))
    .replace(/\s+/gu, " ")
    .trim();
}

export function reconcileFigures(params: {
  draft: string;
  served: ServedPassage[];
  options?: Partial<ReconciliationOptions>;
}): {
  figures: FigureReconciliation[];
  competingBases: CompetingBaseFinding[];
} {
  const opts = {
    ...DEFAULT_RECONCILIATION_OPTIONS,
    ...(params.options ?? {}),
  };
  const index = buildServedIndex(params.served);
  const draftHits = extractAnchors(params.draft);

  const figures: FigureReconciliation[] = [];
  const seen = new Set<string>();
  for (const hit of draftHits) {
    if (hit.cls !== "money" && hit.cls !== "percent" && hit.cls !== "date")
      continue;
    const dedupe = `${hit.norm}@${hit.index}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const witnesses = index.norms.get(hit.norm) ?? [];
    if (witnesses.length) {
      figures.push({
        cls: hit.cls,
        raw: hit.raw,
        norm: hit.norm,
        at: hit.index,
        status: "verbatim",
        witnesses: witnesses.slice(0, opts.maxWitnesses),
      });
      continue;
    }
    const value = hit.cls === "money" ? moneyValue(hit.norm) : null;
    const derivation =
      value === null ? null : reconstruct(value, index, opts);
    figures.push({
      cls: hit.cls,
      raw: hit.raw,
      norm: hit.norm,
      at: hit.index,
      status: derivation ? "reconstructible" : "ungrounded",
      witnesses: [],
      ...(derivation ? { derivation } : {}),
    });
  }

  /* ---------------- competing-base ambiguity ---------------- */

  const draftPcts = draftHits
    .filter((h) => h.cls === "percent")
    .map((h) => ({ at: h.index, value: pctValue(h.norm) ?? 0, raw: h.raw }))
    .filter((p) => p.value > 0 && p.value < 100);
  const draftMoney = draftHits
    .filter((h) => h.cls === "money")
    .map((h) => ({ at: h.index, value: moneyValue(h.norm) ?? 0, raw: h.raw }))
    .filter((m) => m.value > 0);

  // Every value key the DELIVERABLE states. A competing reading the
  // deliverable already reports is not an ambiguity: the reader has both
  // numbers. Measured on the Phase C grid, this single condition removes the
  // whole multi-column-table false-positive family — a syndicate allocation
  // row states one percentage against three bases (facility, revolver, total)
  // and correctly reports all three products, so every column looks like a
  // "competing base" for the other two until you ask whether the deliverable
  // dropped one.
  const draftNorms = new Set(draftHits.map((h) => h.norm));

  const identities = findAdjustmentIdentities(index, opts);
  const competingBases: CompetingBaseFinding[] = [];
  const emitted = new Set<string>();
  for (const stated of draftMoney) {
    for (const pct of draftPcts) {
      if (Math.abs(pct.at - stated.at) > opts.percentReach) continue;
      const p = pct.value / 100;
      for (const id of identities) {
        let chosen: FigureBase;
        let competing: FigureBase;
        let direction: CompetingBaseFinding["direction"];
        if (close(id.result.value * p, stated.value, opts.tolerance)) {
          chosen = id.result;
          competing = id.minuend;
          direction = "used-net";
        } else if (close(id.minuend.value * p, stated.value, opts.tolerance)) {
          chosen = id.minuend;
          competing = id.result;
          direction = "used-gross";
        } else {
          continue;
        }
        const competingValue = competing.value * p;
        if (close(competingValue, stated.value, opts.tolerance)) continue;
        // Key carries the base's own currency token (extractAnchors emits
        // "money:dlr:<cents>").
        const currency = "dlr";
        const key = `money:${currency}:${Math.round(competingValue * 100) / 100}`;
        // A reading the deliverable already reports is not an ambiguity.
        if (draftNorms.has(key)) continue;
        // The source must ITSELF state the competing product, near the
        // competing base — otherwise this is our arithmetic, not the
        // document's, and a reader was never offered two answers.
        const witness = (index.norms.get(key) ?? []).find(
          (w) =>
            w.document === id.document &&
            Math.abs(w.at - competing.at) <= opts.competingBaseWindow,
        );
        if (!witness) continue;
        const pctNearby = (index.pctByDoc.get(id.document) ?? []).some(
          (h) =>
            Math.abs(h.at - competing.at) <= opts.competingBaseWindow &&
            close(h.value, pct.value, opts.tolerance),
        );
        if (!pctNearby) continue;
        const dedupe = `${stated.at}:${pct.value}:${chosen.value}:${competing.value}`;
        if (emitted.has(dedupe)) continue;
        emitted.add(dedupe);
        competingBases.push({
          kind: "competing_base",
          direction,
          draftExcerpt: sentenceAround(params.draft, stated.at),
          draftAt: stated.at,
          percent: pct.value,
          statedRaw: stated.raw,
          statedValue: stated.value,
          chosenBase: chosen,
          competingBase: competing,
          competingValue,
          competingWitness: witness,
          identity: id,
        });
      }
    }
  }

  return { figures, competingBases };
}

/**
 * Source-stated `gross − adjustment = net` identities. All three figures must
 * sit inside one window, which is what makes the two totals interchangeable
 * when prose later says "the penalty": the document has just told the reader
 * they are the same obligation measured two ways.
 *
 * The subtrahend is deliberately NOT a candidate base. In `G − C = N` the two
 * quantities a later sentence can both call "the penalty" are G and N; C is
 * the credit, and a percentage of the credit answers a different question.
 * (Measured: admitting the subtrahend was the largest single false-positive
 * family on the Phase C grid.)
 */
export function findAdjustmentIdentities(
  index: ServedIndex,
  opts: ReconciliationOptions,
): AdjustmentIdentity[] {
  const out: AdjustmentIdentity[] = [];
  const seen = new Set<string>();
  for (const [document, hits] of index.moneyByDoc) {
    // CONSECUTIVE money mentions only, in prose order. Two properties of a
    // stated identity do the work, and both were measured necessary on the
    // Phase C grid:
    //
    //  - Order. `G − C = N` and `G − N = C` are the same arithmetic over the
    //    same three numbers, but the roles are not symmetric here: a
    //    percentage of the NET has a competing reading against the gross, a
    //    percentage of the CREDIT answers a different question. English
    //    writes the identity left to right — "$392,500,000 minus $92,500,000
    //    equals $300,000,000" — so the text says which is which.
    //  - Contiguity. A stated expression has no other money figure inside it.
    //    Without this, a repeated mention of the credit later in the
    //    paragraph re-forms the swapped assignment in legal prose order and
    //    the false positives come back.
    //
    // Both cost recall on identities split across an intervening figure
    // ("$392.5 million, less the $92.5 million CFTC Offset and $8 million of
    // fees, or $300 million"). That is the intended trade: the wing's
    // false-positive budget is near zero.
    for (let i = 0; i + 2 < hits.length; i++) {
      const m = hits[i];
      const s = hits[i + 1];
      const r = hits[i + 2];
      if (r.at - m.at > opts.identityWindow) continue;
      if (m.value <= 0 || s.value <= 0 || r.value <= 0) continue;
      if (!close(m.value - s.value, r.value, opts.tolerance)) continue;
      if (m.value <= r.value) continue;
      if (close(s.value, r.value, opts.tolerance)) continue;
      const key = `${document}:${m.at}:${s.at}:${r.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        document,
        minuend: { document, at: m.at, raw: m.raw, value: m.value },
        subtrahend: { document, at: s.at, raw: s.raw, value: s.value },
        result: { document, at: r.at, raw: r.raw, value: r.value },
        spanChars: r.at - m.at,
      });
    }
  }
  return out;
}
