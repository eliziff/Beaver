/**
 * Run one candidate retriever over a retrieval-gate set and score it
 * (docs/pinpoint-retrieval-and-vector-embeddings.md, "Vector boundary and
 * benchmark gate"). Deterministic, offline, no model calls.
 *
 *   npx tsx scripts/retrieval-gate-run.ts [--set <set.json>]
 *     [--slice <slice.json>] [--out <report.json>]
 *
 * Baseline retriever: lexical-bm25-v1, implemented inline. The corpus's
 * lookup.duckdb was probed and is an EXACT citation/name lookup index
 * (lookup_type in {citation, name}; schema 5) — it has no full-text search —
 * and the laws corpus has no FTS sidecar (the journal FTS5 sidecar covers
 * journals only). So candidate discovery here is Okapi BM25 (k1=1.2, b=0.75)
 * over the frozen slice: one document per section, field text = act name +
 * heading + section text (title-with-section indexing, the same idea as the
 * journal sidecar's weighted metadata field, unweighted in v1). Tokens are
 * lowercased Unicode letter/digit runs, length >= 2, minus a fixed English
 * function-word stopword list. Ties break on locator (ascending) so ranking
 * is fully deterministic. The retriever emits `<citation_key>#<handle>`
 * locators plus the pool text it indexed — a retrieval score never becomes
 * text; the slice text IS the authoritative section text.
 *
 * The report prints the asymmetric acceptance rule: a vector candidate must
 * beat this baseline's Recall@10 by >= 5 points absolute WITHOUT regressing
 * Recall@5, locator accuracy, or unsupported-claim rate (and without erasing
 * the win through latency/index size, judged from the recorded timings); the
 * baseline never has to prove vectors are useless.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RETRIEVAL_GATE_DIR,
  applyAsymmetricGate,
  checkRetrievalSetAgainstSlice,
  fullLocator,
  loadRetrievalSet,
  loadRetrievalSlice,
  scoreRetrievalRun,
  type RankedCandidate,
  type RetrievalSliceV1,
} from "../src/lib/retrievalGate";

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const setPath = argument("set", path.join(RETRIEVAL_GATE_DIR, "set-v1.json"));
const slicePath = argument(
  "slice",
  path.join(RETRIEVAL_GATE_DIR, "slice-v1.json"),
);
const RETRIEVER_ID = "lexical-bm25-v1";

// ---------------------------------------------------------------------------
// Baseline retriever: BM25 over the frozen slice.
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;
const TOP_K = 10;
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by do does for from had has have if in " +
    "into is it its may must no not of on or shall so such that the their " +
    "them then there these they this to under upon was were what when where " +
    "which who will with"
  ).split(" "),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

interface IndexedSection {
  locator: string;
  text: string;
  length: number;
  counts: Map<string, number>;
}

interface Bm25Index {
  sections: IndexedSection[];
  postings: Map<string, Array<[number, number]>>;
  averageLength: number;
}

function buildIndex(slice: RetrievalSliceV1): Bm25Index {
  const sections: IndexedSection[] = [];
  for (const doc of slice.docs) {
    for (const section of doc.sections) {
      const field = `${doc.name ?? ""}\n${section.heading ?? ""}\n${section.text}`;
      const tokens = tokenize(field);
      const counts = new Map<string, number>();
      for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
      sections.push({
        locator: fullLocator(doc.citation_key, section.label),
        text: section.text,
        length: tokens.length,
        counts,
      });
    }
  }
  const postings = new Map<string, Array<[number, number]>>();
  for (const [index, section] of sections.entries()) {
    for (const [token, count] of section.counts) {
      let list = postings.get(token);
      if (!list) postings.set(token, (list = []));
      list.push([index, count]);
    }
  }
  const averageLength =
    sections.reduce((sum, section) => sum + section.length, 0) /
    (sections.length || 1);
  return { sections, postings, averageLength };
}

function retrieve(index: Bm25Index, query: string): RankedCandidate[] {
  const scores = new Map<number, number>();
  const total = index.sections.length;
  for (const token of new Set(tokenize(query))) {
    const list = index.postings.get(token);
    if (!list) continue;
    const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5));
    for (const [sectionIndex, frequency] of list) {
      const section = index.sections[sectionIndex];
      const norm = 1 - B + B * (section.length / index.averageLength);
      const term = (frequency * (K1 + 1)) / (frequency + K1 * norm);
      scores.set(sectionIndex, (scores.get(sectionIndex) ?? 0) + idf * term);
    }
  }
  return [...scores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return index.sections[left[0]].locator <
        index.sections[right[0]].locator
        ? -1
        : 1;
    })
    .slice(0, TOP_K)
    .map(([sectionIndex]) => ({
      locator: index.sections[sectionIndex].locator,
      text: index.sections[sectionIndex].text,
    }));
}

// ---------------------------------------------------------------------------
// Run + report
// ---------------------------------------------------------------------------

const milliseconds = (from: bigint, to: bigint) => Number(to - from) / 1e6;
const percent = (fraction: number | null) =>
  fraction === null ? "n/a" : `${(fraction * 100).toFixed(1)}%`;

function main(): void {
  const set = loadRetrievalSet(setPath);
  const slice = loadRetrievalSlice(slicePath);
  checkRetrievalSetAgainstSlice(set, slice);

  const buildStart = process.hrtime.bigint();
  const index = buildIndex(slice);
  const buildEnd = process.hrtime.bigint();

  const candidates: Record<string, RankedCandidate[]> = {};
  const perQuery: number[] = [];
  for (const item of set.items) {
    const start = process.hrtime.bigint();
    candidates[item.item_id] = retrieve(index, item.query);
    perQuery.push(milliseconds(start, process.hrtime.bigint()));
  }
  const report = scoreRetrievalRun(set, candidates);

  const sortedTimes = [...perQuery].sort((left, right) => left - right);
  const timing = {
    index_build_ms: Number(milliseconds(buildStart, buildEnd).toFixed(3)),
    retrieval_total_ms: Number(
      perQuery.reduce((sum, value) => sum + value, 0).toFixed(3),
    ),
    retrieval_mean_ms: Number(
      (perQuery.reduce((sum, value) => sum + value, 0) / perQuery.length).toFixed(
        3,
      ),
    ),
    retrieval_p95_ms: Number(
      sortedTimes[Math.min(
        sortedTimes.length - 1,
        Math.ceil(sortedTimes.length * 0.95) - 1,
      )].toFixed(3),
    ),
  };

  const byJurisdiction = new Map<string, { items: number; at10: number }>();
  for (const [index_, item] of set.items.entries()) {
    const bucket = byJurisdiction.get(item.corpus_ref.jurisdiction) ?? {
      items: 0,
      at10: 0,
    };
    bucket.items += 1;
    if (report.items[index_].recall_at_10) bucket.at10 += 1;
    byJurisdiction.set(item.corpus_ref.jurisdiction, bucket);
  }

  const outPath = argument(
    "out",
    path.join(RETRIEVAL_GATE_DIR, `report-${RETRIEVER_ID}.${set.set_id}.json`),
  );
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        created: new Date().toISOString(),
        set_id: set.set_id,
        corpus_revision: slice.corpus?.revision ?? null,
        retriever: {
          id: RETRIEVER_ID,
          description:
            "Okapi BM25 over the frozen slice; one document per section; field = act name + heading + section text; deterministic locator tie-break.",
          params: { k1: K1, b: B, top_k: TOP_K, stopwords: STOPWORDS.size },
        },
        pool: {
          docs: slice.docs.length,
          sections: index.sections.length,
        },
        timing_ms: timing,
        metrics: report.metrics,
        by_jurisdiction: Object.fromEntries(
          [...byJurisdiction.entries()].map(([jurisdiction, bucket]) => [
            jurisdiction,
            { items: bucket.items, recall_at_10: bucket.at10 / bucket.items },
          ]),
        ),
        items: report.items,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const metrics = report.metrics;
  const rows: Array<[string, string]> = [
    ["items", String(metrics.items)],
    ["pool sections", String(index.sections.length)],
    ["Recall@5", percent(metrics.recall_at_5)],
    ["Recall@10", percent(metrics.recall_at_10)],
    ["locator accuracy (top-1)", percent(metrics.locator_accuracy)],
    [
      "unsupported-claim rate",
      `${percent(metrics.unsupported_claim_rate)} (${metrics.unsupported_claims}/${metrics.claims} claims)`,
    ],
    ["index build", `${timing.index_build_ms} ms`],
    [
      "retrieval",
      `${timing.retrieval_total_ms} ms total, ${timing.retrieval_mean_ms} ms mean, ${timing.retrieval_p95_ms} ms p95`,
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(`retrieval gate — ${RETRIEVER_ID} on ${set.set_id}`);
  for (const [label, value] of rows)
    console.log(`  ${label.padEnd(width)}  ${value}`);
  console.log("  by jurisdiction (Recall@10):");
  for (const [jurisdiction, bucket] of byJurisdiction)
    console.log(
      `    ${jurisdiction.padEnd(6)} ${bucket.at10}/${bucket.items}`,
    );
  const misses = report.items.filter((item) => !item.recall_at_10);
  if (misses.length)
    console.log(
      `  missed@10: ${misses.map((item) => item.item_id).join(", ")}`,
    );
  console.log(`  report: ${outPath}`);

  // The gate, stated on this baseline: candidate metrics must satisfy
  // applyAsymmetricGate(baseline, candidate). A tie is a failure.
  const selfTest = applyAsymmetricGate(metrics, metrics);
  console.log(
    `\nasymmetric gate: a vector candidate must reach Recall@10 >= ${percent(
      Math.min(1, metrics.recall_at_10 + 0.05),
    )} (baseline ${percent(metrics.recall_at_10)} + 5pts absolute) without regressing ` +
      `Recall@5, locator accuracy, or unsupported-claim rate. ` +
      `The baseline itself does NOT pass (ties fail): ${selfTest.reasons.join("; ")}.`,
  );
}

main();
