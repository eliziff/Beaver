/**
 * Retrieval gate: the benchmark harness that makes the "vectors only if they
 * earn it" rule of docs/pinpoint-retrieval-and-vector-embeddings.md ("Vector
 * boundary and benchmark gate") falsifiable. Style mirrors beaverCan.ts: zod
 * strict schemas are the single source of truth, everything is parse-or-throw,
 * and unknown keys or fixtures that drift from their corpus fail loudly.
 *
 * Two artifacts are versioned together:
 *
 * - a RETRIEVAL SET (set-v1.json): items pairing a natural-language query with
 *   a corpus document reference, gold structural locators, and a verbatim gold
 *   quote that answers the query;
 * - a CORPUS SLICE (slice-v1.json): the frozen candidate pool — every section
 *   of every referenced document, pinned to a corpus revision — so a run is
 *   reproducible even if the live corpus snapshot changes.
 *
 * Locator dialect: within a document, structural handles use the shared
 * sourceDoc dialect for statutes — `sec` + section label ("sec2", "sec12.1",
 * "sec231(5)") — the same labels a2aj_structure.single_section_blocks,
 * legalTextSkeleton, and sourceDocA2AJ emit and beaverCan pinpoints use.
 * Because the candidate pool spans many documents, a FULL locator qualifies
 * the handle with the document's CITATION KEY:
 *
 *     `<citation_key>#<handle>`   e.g.  "rsc1985ci21#sec2"
 *
 * Document identity is PORTED, not reinvented: `citationLookupKey` below is a
 * line-for-line port of the reference implementation's normalizer
 * (ALR-Quote-Verifier local_a2aj._citation_lookup_key — the function that
 * keys the corpus's lookup.duckdb; toa_maker._citation_key is its
 * authority-matching cousin, and a2ajLocalBulk.ts carries the same port as
 * its unexported `citationKey`). The reference project is read-only and never
 * runtime-imported; equivalence is proven by a differential test against an
 * oracle dump produced by scripts/retrieval-gate-oracle-probe.py (the
 * skeleton-oracle-probe pattern). Derivation freezes the key into every
 * corpus_ref/slice doc as `citation_key`; the scorer compares locators by
 * exact string equality after a defensive trim/whitespace-collapse/casefold
 * (tolerance for sloppy candidate plumbing, not identity logic). A retrieval
 * score never becomes a locator: candidates carry only a locator plus the
 * text the retriever claims that locator holds.
 *
 * Metric definitions (deterministic, no model calls):
 *
 * - recall_at_5 / recall_at_10: fraction of items where ANY gold full locator
 *   appears among the top 5 / top 10 ranked candidates (normalized-exact
 *   locator match). Rank is 1-based candidate-array order.
 * - locator_accuracy: fraction of items whose rank-1 candidate's locator
 *   matches a gold full locator. Right-text-under-a-wrong-locator does NOT
 *   count: the authoritative-lookup plane needs the handle, not the prose.
 * - unsupported_claim_rate: a candidate CLAIMS to answer an item iff its
 *   locator matches a gold full locator (the retriever asserts "this locator
 *   answers the query"). Per item, the claiming candidate is the highest
 *   ranked such candidate within the top 10 (the Recall@10 window). The claim
 *   is UNSUPPORTED iff the candidate's returned text does not contain the
 *   item's gold_quote under whitespace normalization (collapse runs to one
 *   space, trim; case-sensitive — beaverCan's quote rule). The rate is
 *   unsupported claims / items with a claim, or null when no item has a
 *   claim. The denominator is claims, not items: this metric isolates
 *   locator→text fidelity (the plane-boundary invariant: text drifting from
 *   the locator it is attributed to), while recall already scores the misses.
 *   This is a deterministic proxy for — and deliberately narrower than — the
 *   model-judged unsupported-claim rates reported by CanLegalRAGBench.
 *
 * The acceptance rule is deliberately asymmetric (doc, closing paragraph): a
 * vector candidate must prove a meaningful recall gain over the lexical
 * baseline without regressing locator accuracy or claim support; the baseline
 * never has to prove vectors are useless. `applyAsymmetricGate` encodes the
 * quality axes; latency, index size, and build time are recorded in run
 * reports for human judgment, not decided here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";

const ITEM_ID = /^RG-\d{3}$/u;
const SET_ID = /^[a-z0-9][a-z0-9._-]*$/u;
/** `sec` + statute section label, beaverCan's statute pinpoint alphabet. */
const SEC_HANDLE = /^sec\d+[\d.()a-z]*$/u;
const JURISDICTION = /^CA(-[A-Z]{2})?$/u;
const DATASET = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;

const secHandle = z.string().regex(SEC_HANDLE, 'structural handle like "sec2"');
/** Output alphabet of citationLookupKey. */
const CITATION_KEY = /^[a-z0-9]+$/u;
const citationKey = z
  .string()
  .regex(CITATION_KEY, "citationLookupKey output");

/**
 * Beaver-owned port of local_a2aj._citation_lookup_key (read-only reference
 * implementation; equivalence proven by the oracle differential test, see
 * file header). "RSA 2000, c A-4.2" -> "rsa2000ca4dot2". Digit-bounded
 * ".", "-", "/" become "dot"/"dash"/"slash" so revision punctuation
 * survives the alphanumeric squeeze. Python's casefold() is toLowerCase()
 * plus full case folding; the one folding that survives NFKC and can reach
 * the [a-z0-9] output is sharp-s -> "ss" (the oracle differential test
 * caught exactly this divergence), so it is applied explicitly. Unicode-\d
 * differences are neutralized by the leading NFKC; the differential test
 * remains the arbiter if the corpus ever disagrees.
 */
export function citationLookupKey(value: string): string {
  let v = (value || "").normalize("NFKC");
  v = v.replace(/–/gu, "-").replace(/—/gu, "-");
  v = v.replace(/(?<=\d)\.(?=\d)/gu, "dot");
  v = v.replace(/(?<=\d)-(?=\d)/gu, "dash");
  v = v.replace(/(?<=\d)\/(?=\d)/gu, "slash");
  return v
    .toLowerCase()
    .replace(/ß/gu, "ss")
    .replace(/[^a-z0-9]+/gu, "");
}

export const retrievalCorpusRefSchema = z.strictObject({
  jurisdiction: z.string().regex(JURISDICTION, "CA or CA-XX"),
  /** Corpus dataset the document lives in, e.g. "LEGISLATION-FED". */
  dataset: z.string().regex(DATASET),
  /** Display citation as stored in the corpus row. */
  citation: z.string().min(1),
  /** Canonical document identity: citationLookupKey(citation). */
  citation_key: citationKey,
});

export const retrievalItemSchema = z.strictObject({
  item_id: z.string().regex(ITEM_ID, "RG-000"),
  /** Natural-language ask, e.g. "What does the Interpretation Act say about …". */
  query: z.string().min(8),
  corpus_ref: retrievalCorpusRefSchema,
  /** Within-document structural handles; any one of them is a correct hit. */
  gold_locators: z.array(secHandle).min(1),
  /** Verbatim span from a gold section that answers the query. */
  gold_quote: z.string().min(20).max(600),
});

const corpusProvenanceSchema = z.strictObject({
  /** e.g. "a2aj-laws-parquet" */
  source: z.string().min(1),
  /** Corpus snapshot identity (laws/lookup.duckdb metadata revision). */
  revision: z.string().min(1),
  /** Per-dataset parquet hashes from the corpus manifest, when known. */
  files: z
    .array(z.strictObject({ path: z.string().min(1), sha256: z.string().min(1) }))
    .optional(),
});

export const retrievalSetSchema = z.strictObject({
  schema_version: z.literal(1),
  set_id: z.string().regex(SET_ID),
  created: z.iso.date(),
  /** Honest-limitation notes travel with the data, not just the generator. */
  notes: z.array(z.string().min(1)).optional(),
  corpus: corpusProvenanceSchema.optional(),
  items: z.array(retrievalItemSchema).min(1),
});

export const retrievalSliceSectionSchema = z.strictObject({
  /** Full within-document handle, e.g. "sec12.1". */
  label: secHandle,
  /** Section heading / marginal note, when the document supplies one. */
  heading: z.string().min(1).nullable(),
  text: z.string().min(1),
});

export const retrievalSliceDocSchema = z.strictObject({
  dataset: z.string().regex(DATASET),
  jurisdiction: z.string().regex(JURISDICTION),
  citation: z.string().min(1),
  /** Same inherited identity as corpus_ref.citation_key. */
  citation_key: citationKey,
  name: z.string().min(1).nullable(),
  sections: z.array(retrievalSliceSectionSchema).min(1),
});

export const retrievalSliceSchema = z.strictObject({
  schema_version: z.literal(1),
  /** The set this slice was frozen for. */
  set_id: z.string().regex(SET_ID),
  created: z.iso.date(),
  corpus: corpusProvenanceSchema.optional(),
  docs: z.array(retrievalSliceDocSchema).min(1),
});

export type RetrievalCorpusRef = z.infer<typeof retrievalCorpusRefSchema>;
export type RetrievalItem = z.infer<typeof retrievalItemSchema>;
export type RetrievalSetV1 = z.infer<typeof retrievalSetSchema>;
export type RetrievalSliceSection = z.infer<typeof retrievalSliceSectionSchema>;
export type RetrievalSliceDoc = z.infer<typeof retrievalSliceDocSchema>;
export type RetrievalSliceV1 = z.infer<typeof retrievalSliceSchema>;

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
export const RETRIEVAL_GATE_DIR = path.join(
  REPO_ROOT,
  "benchmarks",
  "retrieval_gate",
);

/** JSON Schema mirrors of the zod contracts, for committed .schema.json files. */
export function retrievalGateJsonSchemas(): { set: unknown; slice: unknown } {
  return {
    set: z.toJSONSchema(retrievalSetSchema),
    slice: z.toJSONSchema(retrievalSliceSchema),
  };
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath))
    fail(path.basename(filePath), `missing file ${filePath}`);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** `<citation_key>#<handle>` — the fully qualified locator retrievers emit.
 * The citation_key half comes from the artifacts (inherited identity); this
 * function only joins, it never normalizes. */
export function fullLocator(citationKeyValue: string, handle: string): string {
  return `${citationKeyValue}#${handle}`;
}

/** Defensive comparison fold (trim, collapse whitespace, casefold). Identity
 * normalization is citationLookupKey applied at derivation time — this only
 * forgives candidate plumbing that adds spaces or letter case. */
export function normalizeLocator(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Quote containment normalization: whitespace-collapsed, case-sensitive. */
const normalizeText = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Parse-or-throw a retrieval set file and enforce cross-item invariants. */
export function loadRetrievalSet(filePath: string): RetrievalSetV1 {
  const set = retrievalSetSchema.parse(readJson(filePath));
  const where = path.basename(filePath);
  const ids = set.items.map((item) => item.item_id);
  if (new Set(ids).size !== ids.length) fail(where, "duplicate item_id");
  for (const item of set.items) {
    if (new Set(item.gold_locators).size !== item.gold_locators.length)
      fail(where, `${item.item_id}: duplicate gold locator`);
  }
  return set;
}

/** Parse-or-throw a corpus slice file and enforce uniqueness invariants. */
export function loadRetrievalSlice(filePath: string): RetrievalSliceV1 {
  const slice = retrievalSliceSchema.parse(readJson(filePath));
  const where = path.basename(filePath);
  const citations = slice.docs.map((doc) => doc.citation);
  if (new Set(citations).size !== citations.length)
    fail(where, "duplicate doc citation");
  const keys = slice.docs.map((doc) => doc.citation_key);
  if (new Set(keys).size !== keys.length)
    fail(where, "duplicate doc citation_key (identity collision)");
  for (const doc of slice.docs) {
    const labels = doc.sections.map((section) => section.label);
    if (new Set(labels).size !== labels.length)
      fail(where, `${doc.citation}: duplicate section label`);
  }
  return slice;
}

/**
 * Cross-check a set against its frozen slice: every item's document is in the
 * slice with matching dataset/jurisdiction, every gold handle resolves to a
 * section, and the gold quote is verbatim-contained (whitespace-normalized)
 * in at least one gold section — the same containment rule the scorer applies
 * to candidate text, so gold can never assert what the corpus cannot support.
 */
export function checkRetrievalSetAgainstSlice(
  set: RetrievalSetV1,
  slice: RetrievalSliceV1,
): void {
  if (set.set_id !== slice.set_id)
    fail(set.set_id, `slice is for set ${slice.set_id}`);
  const docs = new Map(slice.docs.map((doc) => [doc.citation_key, doc]));
  for (const item of set.items) {
    const where = item.item_id;
    const doc = docs.get(item.corpus_ref.citation_key);
    if (!doc)
      fail(where, `citation_key not in slice: ${item.corpus_ref.citation_key}`);
    if (doc.citation !== item.corpus_ref.citation)
      fail(where, `citation ${item.corpus_ref.citation} != slice ${doc.citation}`);
    if (doc.dataset !== item.corpus_ref.dataset)
      fail(where, `dataset ${item.corpus_ref.dataset} != slice ${doc.dataset}`);
    if (doc.jurisdiction !== item.corpus_ref.jurisdiction)
      fail(
        where,
        `jurisdiction ${item.corpus_ref.jurisdiction} != slice ${doc.jurisdiction}`,
      );
    const sections = new Map(
      doc.sections.map((section) => [section.label, section]),
    );
    const quote = normalizeText(item.gold_quote);
    let supported = false;
    for (const handle of item.gold_locators) {
      const section = sections.get(handle);
      if (!section)
        fail(where, `gold locator ${handle} not in ${doc.citation}`);
      if (normalizeText(section.text).includes(quote)) supported = true;
    }
    if (!supported)
      fail(
        where,
        `gold_quote not found in any gold section: "${item.gold_quote.slice(0, 60)}..."`,
      );
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** One ranked retriever result: a full locator plus the text it claims holds. */
export interface RankedCandidate {
  locator: string;
  text: string;
}

export interface ScoredItem {
  item_id: string;
  /** Composed `<citation_key>#<handle>` gold locators. */
  gold_full_locators: string[];
  /** 1-based rank of the first gold-locator candidate, or null. */
  hit_rank: number | null;
  recall_at_5: boolean;
  recall_at_10: boolean;
  top1_locator_match: boolean;
  /** Highest-ranked top-10 candidate whose locator matches gold, if any. */
  claim: { rank: number; supported: boolean } | null;
}

export interface RetrievalMetrics {
  items: number;
  /** Fractions in [0,1]. */
  recall_at_5: number;
  recall_at_10: number;
  locator_accuracy: number;
  claims: number;
  unsupported_claims: number;
  /** unsupported_claims / claims; null when no item produced a claim. */
  unsupported_claim_rate: number | null;
}

export interface RetrievalGateReport {
  set_id: string;
  metrics: RetrievalMetrics;
  items: ScoredItem[];
}

const RECALL_WINDOW_SMALL = 5;
const RECALL_WINDOW_LARGE = 10;

function scoreItem(
  item: RetrievalItem,
  candidates: RankedCandidate[],
): ScoredItem {
  const gold = item.gold_locators.map((handle) =>
    fullLocator(item.corpus_ref.citation_key, handle),
  );
  const goldNormalized = new Set(gold.map(normalizeLocator));
  let hitRank: number | null = null;
  for (const [index, candidate] of candidates.entries()) {
    if (goldNormalized.has(normalizeLocator(candidate.locator))) {
      hitRank = index + 1;
      break;
    }
  }
  const claim =
    hitRank !== null && hitRank <= RECALL_WINDOW_LARGE
      ? {
          rank: hitRank,
          supported: normalizeText(candidates[hitRank - 1].text).includes(
            normalizeText(item.gold_quote),
          ),
        }
      : null;
  return {
    item_id: item.item_id,
    gold_full_locators: gold,
    hit_rank: hitRank,
    recall_at_5: hitRank !== null && hitRank <= RECALL_WINDOW_SMALL,
    recall_at_10: hitRank !== null && hitRank <= RECALL_WINDOW_LARGE,
    top1_locator_match: hitRank === 1,
    claim,
  };
}

/**
 * Score one retriever run over a set. `candidates` must contain exactly the
 * set's item_ids (an item the retriever returned nothing for maps to an empty
 * array — the key must still be present, so silent drops cannot masquerade as
 * misses of a smaller set).
 */
export function scoreRetrievalRun(
  set: RetrievalSetV1,
  candidates: Record<string, RankedCandidate[]>,
): RetrievalGateReport {
  const known = new Set(set.items.map((item) => item.item_id));
  for (const key of Object.keys(candidates))
    if (!known.has(key)) fail(set.set_id, `candidates for unknown item ${key}`);
  const items = set.items.map((item) => {
    const ranked = candidates[item.item_id];
    if (!ranked) fail(set.set_id, `missing candidates for ${item.item_id}`);
    return scoreItem(item, ranked);
  });

  const count = items.length;
  const fraction = (predicate: (item: ScoredItem) => boolean) =>
    items.filter(predicate).length / count;
  const claims = items.filter((item) => item.claim !== null).length;
  const unsupported = items.filter(
    (item) => item.claim !== null && !item.claim.supported,
  ).length;
  return {
    set_id: set.set_id,
    metrics: {
      items: count,
      recall_at_5: fraction((item) => item.recall_at_5),
      recall_at_10: fraction((item) => item.recall_at_10),
      locator_accuracy: fraction((item) => item.top1_locator_match),
      claims,
      unsupported_claims: unsupported,
      unsupported_claim_rate: claims ? unsupported / claims : null,
    },
    items,
  };
}

// ---------------------------------------------------------------------------
// Asymmetric acceptance gate
// ---------------------------------------------------------------------------

export interface AsymmetricGateOptions {
  /**
   * Minimum ABSOLUTE Recall@10 gain the candidate must prove. The doc demands
   * a "meaningful recall gain"; 0.05 (five points) is the default reading and
   * is deliberately explicit so tightening it is a one-line review.
   */
  minRecallGain?: number;
}

export interface AsymmetricGateDecision {
  pass: boolean;
  /** Every reason the candidate failed; empty exactly when pass is true. */
  reasons: string[];
}

/**
 * The doc's rule, executable: the candidate (e.g. embeddings) must prove a
 * meaningful Recall@10 gain AND must not regress Recall@5, locator accuracy,
 * or claim support. Ties on the gain axis fail — the burden of proof sits
 * entirely on the candidate; the baseline never has to prove the candidate is
 * useless. Latency/size/build-time live in run reports, outside this gate.
 */
export function applyAsymmetricGate(
  baseline: RetrievalMetrics,
  candidate: RetrievalMetrics,
  options?: AsymmetricGateOptions,
): AsymmetricGateDecision {
  const minGain = options?.minRecallGain ?? 0.05;
  const reasons: string[] = [];
  const gain = candidate.recall_at_10 - baseline.recall_at_10;
  if (gain < minGain)
    reasons.push(
      `recall_at_10 gain ${gain.toFixed(4)} < required ${minGain.toFixed(4)}`,
    );
  if (candidate.recall_at_5 < baseline.recall_at_5)
    reasons.push("recall_at_5 regressed");
  if (candidate.locator_accuracy < baseline.locator_accuracy)
    reasons.push("locator_accuracy regressed");
  const rate = (metrics: RetrievalMetrics) =>
    metrics.unsupported_claim_rate ?? 0;
  if (rate(candidate) > rate(baseline))
    reasons.push("unsupported_claim_rate regressed");
  return { pass: reasons.length === 0, reasons };
}
