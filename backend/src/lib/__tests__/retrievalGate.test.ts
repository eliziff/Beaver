/**
 * Retrieval-gate scorer, schema, and identity-port tests.
 *
 * Scorer fixtures are hand-built to pin each metric's edge cases: gold at
 * rank 6 (Recall@5 miss / @10 hit), right-text-under-wrong-locator (no
 * credit), unsupported claim (gold locator whose text lacks the gold quote),
 * the top-10 claim window, and the claims-not-items denominator of
 * unsupported_claim_rate. citationLookupKey is proven equivalent to the
 * read-only reference implementation (local_a2aj._citation_lookup_key) by a
 * differential test against the oracle dump produced by
 * scripts/retrieval-gate-oracle-probe.py — the skeleton-oracle pattern.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RETRIEVAL_GATE_DIR,
  applyAsymmetricGate,
  checkRetrievalSetAgainstSlice,
  citationLookupKey,
  fullLocator,
  loadRetrievalSet,
  loadRetrievalSlice,
  retrievalSetSchema,
  retrievalSliceSchema,
  scoreRetrievalRun,
  type RankedCandidate,
  type RetrievalMetrics,
  type RetrievalSetV1,
  type RetrievalSliceV1,
} from "../retrievalGate";

const CITATION = "RSC 1985, c I-21";
const KEY = "rsc1985ci21";
const QUOTE = "This Act may be cited as the Interpretation Act.";
const REF = {
  jurisdiction: "CA",
  dataset: "LEGISLATION-FED",
  citation: CITATION,
  citation_key: KEY,
};

function makeSet(
  overrides: Array<Partial<RetrievalSetV1["items"][number]>>,
): RetrievalSetV1 {
  return retrievalSetSchema.parse({
    schema_version: 1,
    set_id: "test-set",
    created: "2026-07-28",
    items: overrides.map((override, index) => ({
      item_id: `RG-${String(index + 1).padStart(3, "0")}`,
      query: "What does the Interpretation Act say about the short title?",
      corpus_ref: REF,
      gold_locators: ["sec1"],
      gold_quote: QUOTE,
      ...override,
    })),
  });
}

const GOLD = fullLocator(KEY, "sec1");

/** n distractor candidates with unique wrong locators. */
function distractors(n: number, offset = 0): RankedCandidate[] {
  return Array.from({ length: n }, (_, index) => ({
    locator: fullLocator(KEY, `sec${900 + offset + index}`),
    text: `Distractor section ${offset + index} about unrelated matters entirely.`,
  }));
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempJson(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "retrieval-gate-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "data.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

describe("scoreRetrievalRun", () => {
  it("scores gold at rank 6 as a Recall@5 miss and a Recall@10 hit", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [
        ...distractors(5),
        { locator: GOLD, text: `Preamble. ${QUOTE} Trailing text.` },
      ],
    });
    const [item] = report.items;
    expect(item.hit_rank).toBe(6);
    expect(item.recall_at_5).toBe(false);
    expect(item.recall_at_10).toBe(true);
    expect(item.top1_locator_match).toBe(false);
    expect(item.claim).toEqual({ rank: 6, supported: true });
    expect(report.metrics.recall_at_5).toBe(0);
    expect(report.metrics.recall_at_10).toBe(1);
  });

  it("scores gold at rank 1 as a hit on every metric", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [{ locator: GOLD, text: QUOTE }, ...distractors(9)],
    });
    const [item] = report.items;
    expect(item.hit_rank).toBe(1);
    expect(item.top1_locator_match).toBe(true);
    expect(report.metrics.locator_accuracy).toBe(1);
    expect(report.metrics.unsupported_claim_rate).toBe(0);
  });

  it("gives no credit for the right text under a wrong locator", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      // The retriever surfaces the answering text but attributes it to a
      // different section: the authoritative-lookup plane needs the handle.
      "RG-001": [{ locator: fullLocator(KEY, "sec99"), text: QUOTE }],
    });
    const [item] = report.items;
    expect(item.hit_rank).toBeNull();
    expect(item.top1_locator_match).toBe(false);
    expect(item.claim).toBeNull();
    expect(report.metrics.recall_at_10).toBe(0);
    expect(report.metrics.claims).toBe(0);
    expect(report.metrics.unsupported_claim_rate).toBeNull();
  });

  it("counts a gold-locator candidate whose text lacks the quote as an unsupported claim", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [
        ...distractors(2),
        { locator: GOLD, text: "Stale chunk text drifted from its locator." },
      ],
    });
    expect(report.items[0].claim).toEqual({ rank: 3, supported: false });
    expect(report.metrics.claims).toBe(1);
    expect(report.metrics.unsupported_claims).toBe(1);
    expect(report.metrics.unsupported_claim_rate).toBe(1);
  });

  it("treats gold at rank 11 as outside both recall and the claim window", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [...distractors(10), { locator: GOLD, text: QUOTE }],
    });
    const [item] = report.items;
    expect(item.hit_rank).toBe(11);
    expect(item.recall_at_10).toBe(false);
    expect(item.claim).toBeNull();
  });

  it("compares locators exactly after trim/whitespace-collapse/casefold only", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [{ locator: `  ${GOLD.toUpperCase()}  `, text: QUOTE }],
    });
    expect(report.items[0].hit_rank).toBe(1);
    // A different handle is a different locator, whatever the text says.
    const miss = scoreRetrievalRun(set, {
      "RG-001": [{ locator: fullLocator(KEY, "sec1(1)"), text: QUOTE }],
    });
    expect(miss.items[0].hit_rank).toBeNull();
  });

  it("verifies quotes whitespace-normalized but case-sensitively", () => {
    const set = makeSet([{}]);
    const wrapped = scoreRetrievalRun(set, {
      "RG-001": [
        {
          locator: GOLD,
          text: "This  Act\nmay be\n\ncited   as the Interpretation Act.",
        },
      ],
    });
    expect(wrapped.items[0].claim).toEqual({ rank: 1, supported: true });
    const lowercased = scoreRetrievalRun(set, {
      "RG-001": [{ locator: GOLD, text: QUOTE.toLowerCase() }],
    });
    expect(lowercased.items[0].claim).toEqual({ rank: 1, supported: false });
  });

  it("uses the first occurrence when a gold locator repeats in the ranking", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [
        ...distractors(1),
        { locator: GOLD, text: "Wrong text at the first occurrence." },
        { locator: GOLD, text: QUOTE },
      ],
    });
    expect(report.items[0].hit_rank).toBe(2);
    expect(report.items[0].claim).toEqual({ rank: 2, supported: false });
  });

  it("accepts any gold locator when an item lists several", () => {
    const set = makeSet([{ gold_locators: ["sec1", "sec2"] }]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [{ locator: fullLocator(KEY, "sec2"), text: QUOTE }],
    });
    expect(report.items[0].hit_rank).toBe(1);
  });

  it("scores an empty candidate list as misses without a claim", () => {
    const set = makeSet([{}]);
    const report = scoreRetrievalRun(set, { "RG-001": [] });
    expect(report.items[0]).toMatchObject({
      hit_rank: null,
      recall_at_5: false,
      recall_at_10: false,
      top1_locator_match: false,
      claim: null,
    });
  });

  it("aggregates with claims (not items) as the unsupported-rate denominator", () => {
    const set = makeSet([{}, {}, {}]);
    const report = scoreRetrievalRun(set, {
      "RG-001": [{ locator: GOLD, text: QUOTE }],
      "RG-002": [...distractors(5), { locator: GOLD, text: "drifted text" }],
      "RG-003": distractors(10),
    });
    expect(report.metrics.items).toBe(3);
    expect(report.metrics.recall_at_5).toBeCloseTo(1 / 3);
    expect(report.metrics.recall_at_10).toBeCloseTo(2 / 3);
    expect(report.metrics.locator_accuracy).toBeCloseTo(1 / 3);
    expect(report.metrics.claims).toBe(2);
    expect(report.metrics.unsupported_claims).toBe(1);
    expect(report.metrics.unsupported_claim_rate).toBeCloseTo(1 / 2);
  });

  it("throws on candidates for unknown items and on missing items", () => {
    const set = makeSet([{}]);
    expect(() =>
      scoreRetrievalRun(set, { "RG-001": [], "RG-999": [] }),
    ).toThrow(/unknown item RG-999/u);
    expect(() => scoreRetrievalRun(set, {})).toThrow(
      /missing candidates for RG-001/u,
    );
  });
});

describe("schemas and loaders", () => {
  const validSet = () => ({
    schema_version: 1,
    set_id: "test-set",
    created: "2026-07-28",
    items: [
      {
        item_id: "RG-001",
        query: "What does the Interpretation Act say about the short title?",
        corpus_ref: REF,
        gold_locators: ["sec1"],
        gold_quote: QUOTE,
      },
    ],
  });

  it("rejects unknown keys, bad ids, and bad handles", () => {
    expect(() =>
      retrievalSetSchema.parse({ ...validSet(), surprise: true }),
    ).toThrow();
    const badId = validSet();
    badId.items[0].item_id = "ITEM-1";
    expect(() => retrievalSetSchema.parse(badId)).toThrow();
    const badHandle = validSet();
    badHandle.items[0].gold_locators = ["s1"];
    expect(() => retrievalSetSchema.parse(badHandle)).toThrow();
    const badKey = validSet();
    badKey.items[0].corpus_ref = { ...REF, citation_key: "RSC 1985" };
    expect(() => retrievalSetSchema.parse(badKey)).toThrow();
  });

  it("loadRetrievalSet rejects duplicate item ids", () => {
    const duplicated = validSet();
    duplicated.items.push({ ...duplicated.items[0] });
    expect(() => loadRetrievalSet(tempJson(duplicated))).toThrow(
      /duplicate item_id/u,
    );
  });

  it("loadRetrievalSlice rejects citation_key identity collisions", () => {
    const doc = {
      dataset: "LEGISLATION-FED",
      jurisdiction: "CA",
      citation: CITATION,
      citation_key: KEY,
      name: "Interpretation Act",
      sections: [{ label: "sec1", heading: "Short title", text: QUOTE }],
    };
    const slice = {
      schema_version: 1,
      set_id: "test-set",
      created: "2026-07-28",
      docs: [doc, { ...doc, citation: "RSC 1985, c. I-21" }],
    };
    expect(() => loadRetrievalSlice(tempJson(slice))).toThrow(
      /identity collision/u,
    );
  });

  it("cross-checks set against slice: doc, handle, and quote containment", () => {
    const set = makeSet([{}]);
    const slice = retrievalSliceSchema.parse({
      schema_version: 1,
      set_id: "test-set",
      created: "2026-07-28",
      docs: [
        {
          dataset: "LEGISLATION-FED",
          jurisdiction: "CA",
          citation: CITATION,
          citation_key: KEY,
          name: "Interpretation Act",
          sections: [
            { label: "sec1", heading: "Short title", text: `1 ${QUOTE}` },
          ],
        },
      ],
    }) as RetrievalSliceV1;
    expect(() => checkRetrievalSetAgainstSlice(set, slice)).not.toThrow();

    const missingDoc = makeSet([
      { corpus_ref: { ...REF, citation_key: "other" } },
    ]);
    expect(() => checkRetrievalSetAgainstSlice(missingDoc, slice)).toThrow(
      /citation_key not in slice/u,
    );
    const missingHandle = makeSet([{ gold_locators: ["sec2"] }]);
    expect(() => checkRetrievalSetAgainstSlice(missingHandle, slice)).toThrow(
      /gold locator sec2 not in/u,
    );
    const wrongQuote = makeSet([
      { gold_quote: "A quotation that the gold section does not contain." },
    ]);
    expect(() => checkRetrievalSetAgainstSlice(wrongQuote, slice)).toThrow(
      /gold_quote not found/u,
    );
  });
});

describe("applyAsymmetricGate", () => {
  const baseline: RetrievalMetrics = {
    items: 48,
    recall_at_5: 0.85,
    recall_at_10: 0.9,
    locator_accuracy: 0.8,
    claims: 43,
    unsupported_claims: 0,
    unsupported_claim_rate: 0,
  };

  it("fails a tie: the burden of proof is on the candidate", () => {
    const decision = applyAsymmetricGate(baseline, baseline);
    expect(decision.pass).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/recall_at_10 gain/u);
  });

  it("passes a meaningful recall gain with no regressions", () => {
    const decision = applyAsymmetricGate(baseline, {
      ...baseline,
      recall_at_10: 0.96,
    });
    expect(decision).toEqual({ pass: true, reasons: [] });
  });

  it("fails a recall gain that regresses locator accuracy or claim support", () => {
    const decision = applyAsymmetricGate(baseline, {
      ...baseline,
      recall_at_10: 1,
      locator_accuracy: 0.79,
      unsupported_claim_rate: 0.1,
    });
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toContain("locator_accuracy regressed");
    expect(decision.reasons).toContain("unsupported_claim_rate regressed");
  });
});

describe("citationLookupKey (Beaver port)", () => {
  it("marks digit-bounded punctuation and squeezes to [a-z0-9]", () => {
    expect(citationLookupKey("RSA 2000, c A-4.2")).toBe("rsa2000ca4dot2");
    expect(citationLookupKey("SOR/86-1078")).toBe("sor86dash1078");
    expect(citationLookupKey("R.S.O. 1990, c. A.13")).toBe("rso1990ca13");
    expect(citationLookupKey("")).toBe("");
  });

  it("matches the reference oracle dump input-for-input", () => {
    // Differential proof against local_a2aj._citation_lookup_key output
    // captured by scripts/retrieval-gate-oracle-probe.py.
    const fixture = JSON.parse(
      readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "retrieval_gate",
          "citation-key-oracle.json",
        ),
        "utf8",
      ),
    ) as {
      citation_keys: Array<{ input: string; oracle_key: string }>;
      exact_gold: Array<{
        citation: string;
        citation_key: string;
        found: boolean;
        sections: Record<string, string>;
      }>;
    };
    expect(fixture.citation_keys.length).toBeGreaterThanOrEqual(16);
    for (const { input, oracle_key } of fixture.citation_keys)
      expect(citationLookupKey(input), JSON.stringify(input)).toBe(oracle_key);
    // Every gold document was found by the reference store's exact lookup.
    for (const entry of fixture.exact_gold) {
      expect(entry.found, entry.citation).toBe(true);
      expect(citationLookupKey(entry.citation)).toBe(entry.citation_key);
    }
  });
});

// The generated seed artifacts are not committed; validate them fully when
// present (they exist on the derivation machine).
const setPath = path.join(RETRIEVAL_GATE_DIR, "set-v1.json");
const slicePath = path.join(RETRIEVAL_GATE_DIR, "slice-v1.json");
describe.skipIf(!existsSync(setPath) || !existsSync(slicePath))(
  "seed artifacts (set-v1 + slice-v1)",
  () => {
    it("load strictly, cross-check, and match the task's composition bounds", () => {
      const set = loadRetrievalSet(setPath);
      const slice = loadRetrievalSlice(slicePath);
      checkRetrievalSetAgainstSlice(set, slice);
      expect(set.items.length).toBeGreaterThanOrEqual(40);
      expect(set.items.length).toBeLessThanOrEqual(60);
      const jurisdictions = new Set(
        set.items.map((item) => item.corpus_ref.jurisdiction),
      );
      expect(jurisdictions.size).toBeGreaterThanOrEqual(3);
      // The easy-tier honesty note must travel with the data.
      expect((set.notes ?? []).join(" ")).toMatch(/EASY TIER/u);
    });

    it("agrees with the reference store's exact lookup on every gold section", () => {
      const fixture = JSON.parse(
        readFileSync(
          path.join(
            __dirname,
            "fixtures",
            "retrieval_gate",
            "citation-key-oracle.json",
          ),
          "utf8",
        ),
      ) as {
        exact_gold: Array<{
          citation: string;
          citation_key: string;
          sections: Record<string, string>;
        }>;
      };
      const slice = loadRetrievalSlice(slicePath);
      const docs = new Map(slice.docs.map((doc) => [doc.citation_key, doc]));
      let compared = 0;
      for (const entry of fixture.exact_gold) {
        const doc = docs.get(entry.citation_key);
        if (!doc) continue; // artifacts regenerated since the oracle ran
        const byLabel = new Map(
          doc.sections.map((section) => [section.label, section.text]),
        );
        for (const [handle, oracleText] of Object.entries(entry.sections)) {
          expect(byLabel.get(handle), `${entry.citation} ${handle}`).toBe(
            oracleText,
          );
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(0);
    });
  },
);
