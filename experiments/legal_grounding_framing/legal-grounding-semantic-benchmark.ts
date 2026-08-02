/** Run Beaver's strict semantic checker over frozen claim/passage benchmarks. */
import "../../backend/src/lib/loadEnv";

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  registerLegalEvidence,
  semanticClaimVerificationPass,
} from "../../backend/src/lib/chat/legalEvidenceExperiment";
import { receiptPath } from "../../backend/src/lib/experimentReceipts";
import type { NormalizedLlmUsage } from "../../backend/src/lib/llm";

type GoldLabel =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "unlabelled";
type BenchmarkRow = {
  id: string;
  source: string;
  source_class?: "case" | "legislation";
  split: string;
  doc_id: string;
  response_id?: string;
  case_id?: string;
  claim: string;
  citation?: string | null;
  evidence_texts: string[];
  label: GoldLabel;
  label_provenance?: string;
  mutation_type?: string | null;
  mutation_template_id?: string | null;
  request_context?: string | null;
  original_label?: string | null;
};
type Verdict = "supported" | "insufficient" | "contradicted" | "invalid" | "abstain";
type Receipt = {
  schema_version: 1;
  probe: "semantic_checker_benchmark";
  benchmark_file: string;
  benchmark_sha256: string;
  row_id: string;
  source: string;
  split: string;
  doc_id: string;
  response_id: string;
  case_id: string | null;
  claim_sha256: string;
  evidence_span_sha256: string[];
  citation: string | null;
  gold_label: GoldLabel;
  gold_provenance: string | null;
  mutation_type: string | null;
  mutation_template_id: string | null;
  original_label: string | null;
  checker_model: string;
  effort: string;
  replicate: number;
  context_status: string | null;
  evidence_status: string | null;
  coverage: string | null;
  verdict: Verdict;
  reason_code: string;
  review_required: boolean;
  latency_ms: number;
  usage: NormalizedLlmUsage | null;
  error: string | null;
};

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function receiptKey(row: Pick<Receipt, "row_id" | "checker_model" | "effort" | "replicate">) {
  return [row.row_id, row.checker_model, row.effort, row.replicate].join("|");
}

function resolvedVerdict(args: {
  contextStatus: string | null;
  evidenceStatus: string | null;
  coverage: string | null;
  error: string | null;
}): { verdict: Verdict; reason: string } {
  if (args.error)
    return { verdict: "invalid", reason: "checker_transport_or_contract_error" };
  if (args.contextStatus === "ambiguous")
    return { verdict: "abstain", reason: "claim_context_ambiguous" };
  if (args.contextStatus !== "preserved")
    return { verdict: "invalid", reason: "claim_context_changed_or_missing" };
  if (args.coverage !== "complete")
    return { verdict: "abstain", reason: "checker_coverage_incomplete" };
  if (args.evidenceStatus === "supported")
    return { verdict: "supported", reason: "exact_passages_support_entire_claim" };
  if (args.evidenceStatus === "contradicted")
    return { verdict: "contradicted", reason: "exact_passages_contradict_claim" };
  if (args.evidenceStatus === "insufficient")
    return { verdict: "insufficient", reason: "exact_passages_do_not_establish_claim" };
  return { verdict: "invalid", reason: "checker_verdict_missing" };
}

async function runPool<T>(rows: T[], workers: number, work: (row: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, rows.length) }, async () => {
      while (next < rows.length) {
        const index = next;
        next += 1;
        await work(rows[index]);
      }
    }),
  );
}

function shuffle<T>(rows: T[], seed: number): T[] {
  let value = seed >>> 0;
  const random = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...rows];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

function tally(values: string[]) {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function decisionMetrics(
  rows: Receipt[],
  policy: "replicate_1" | "review_on_any",
  unit: "claim" | "response" = "claim",
) {
  const groups = new Map<string, Receipt[]>();
  for (const row of rows) {
    const group = groups.get(row.row_id) ?? [];
    group.push(row);
    groups.set(row.row_id, group);
  }
  const claimDecisions = [...groups.values()].map((replicates) => {
    const selected =
      policy === "replicate_1"
        ? replicates.find((row) => row.replicate === 1) ?? replicates[0]
        : null;
    const review = selected
      ? selected.review_required
      : replicates.some((row) => row.review_required);
    return { row: replicates[0], review };
  });
  const byResponse = new Map<string, typeof claimDecisions>();
  for (const decision of claimDecisions) {
    const group = byResponse.get(decision.row.response_id) ?? [];
    group.push(decision);
    byResponse.set(decision.row.response_id, group);
  }
  const decisions =
    unit === "claim"
      ? claimDecisions
      : [...byResponse.values()].map((claims) => ({
          row: claims[0].row,
          review: claims.some((item) => item.review),
        }));
  const unsupported = decisions.filter((item) => item.row.gold_label !== "supported");
  const supported = decisions.filter((item) => item.row.gold_label === "supported");
  const metrics = (items: typeof decisions) => ({
    n: items.length,
    false_negatives: items.filter(
      (item) => item.row.gold_label !== "supported" && !item.review,
    ).length,
    recall_unsupported:
      items.filter((item) => item.row.gold_label !== "supported").length > 0
        ? items.filter(
            (item) => item.row.gold_label !== "supported" && item.review,
          ).length /
          items.filter((item) => item.row.gold_label !== "supported").length
        : null,
    false_positive_rate:
      items.filter((item) => item.row.gold_label === "supported").length > 0
        ? items.filter(
            (item) => item.row.gold_label === "supported" && item.review,
          ).length /
          items.filter((item) => item.row.gold_label === "supported").length
        : null,
    review_rate: items.length
      ? items.filter((item) => item.review).length / items.length
      : null,
  });
  return {
    ...metrics(decisions),
    supported: supported.length,
    unsupported: unsupported.length,
    by_split: Object.fromEntries(
      [...new Set(decisions.map((item) => item.row.split))].sort().map((split) => [
        split,
        metrics(decisions.filter((item) => item.row.split === split)),
      ]),
    ),
    by_mutation: Object.fromEntries(
      [...new Set(decisions.map((item) => item.row.mutation_type ?? "gold"))]
        .sort()
        .map((mutation) => [
          mutation,
          metrics(
            decisions.filter(
              (item) => (item.row.mutation_type ?? "gold") === mutation,
            ),
          ),
        ]),
    ),
  };
}

function score(file: string) {
  const rows = readJsonl<Receipt>(file).map((row) => ({
    ...row,
    response_id: row.response_id ?? row.row_id,
    original_label: row.original_label ?? null,
  }));
  const unlabelled = rows.filter((row) => row.gold_label === "unlabelled");
  if (unlabelled.length) {
    throw new Error(
      `refusing gold metrics for ${unlabelled.length} independently checked, unlabelled rows`,
    );
  }
  const sources = [...new Set(rows.map((row) => row.source))].sort();
  const isRegLab = sources.includes("reglab-source-resolved");
  const byRow = new Map<string, Receipt[]>();
  for (const row of rows) {
    const group = byRow.get(row.row_id) ?? [];
    group.push(row);
    byRow.set(row.row_id, group);
  }
  const comparable = [...byRow.values()].filter((group) => group.length > 1);
  const output = {
    benchmark: `semantic-checker-${sources.join("+") || "unknown"}-v1`,
    receipts: file,
    sha256: hash(readFileSync(file)),
    label_provenance: tally(rows.map((row) => row.gold_provenance ?? "unknown")),
    calls: rows.length,
    rows: byRow.size,
    verdicts: tally(rows.map((row) => row.verdict)),
    invalid_or_abstain: rows.filter(
      (row) => row.verdict === "invalid" || row.verdict === "abstain",
    ).length,
    replicate_exact_agreement: comparable.length
      ? comparable.filter(
          (group) => new Set(group.map((row) => row.verdict)).size === 1,
        ).length / comparable.length
      : null,
    decision_policies: {
      one_call_claim: decisionMetrics(rows, "replicate_1", "claim"),
      one_call_response: decisionMetrics(rows, "replicate_1", "response"),
      review_on_any_of_replicates_claim: decisionMetrics(
        rows,
        "review_on_any",
        "claim",
      ),
      review_on_any_of_replicates_response: decisionMetrics(
        rows,
        "review_on_any",
        "response",
      ),
    },
    limitations: isRegLab
      ? [
          "RegLab labels are response-level expert labels projected onto extracted claims; they are not independent claim-level adjudication.",
          "Source passages are selected by deterministic lexical overlap from cited opinions; selection quality is a separate retrieval variable.",
          "Replicate agreement measures checker stability, not correctness of the labels.",
          "The checker receives only the claim and exact passages; labels and split are receipt metadata added after the call.",
        ]
      : [
          "CSLB negatives are deterministic mutations and wrong-passage swaps, not natural hallucinations or human-adjudicated errors.",
          "Replicate agreement measures checker stability, not correctness of the constructed labels.",
          "The checker receives only the claim and exact passages; gold labels, mutation names, and split are receipt metadata added after the call.",
        ],
  };
  const report = flag("report", "");
  if (report) writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

async function run() {
  if (flag("idle", "0") !== "0") {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
  } else if (flag("below-normal", "1") !== "0") {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  }
  const benchmark = flag("benchmark");
  if (!existsSync(benchmark)) throw new Error(`benchmark not found: ${benchmark}`);
  const model = flag("model", "codex:gpt-5.6-luna");
  const effort = flag("effort", "low");
  const workers = Number(flag("workers", "8"));
  const replicates = Number(flag("replicates", "2"));
  const timeoutMs = Number(flag("timeout-ms", "180000"));
  const limit = Number(flag("limit", "0"));
  const seed = Number(flag("seed", "20260802"));
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be >= 1");
  if (!Number.isInteger(replicates) || replicates < 1)
    throw new Error("--replicates must be >= 1");
  const allRows = readJsonl<BenchmarkRow>(benchmark);
  const invalid = allRows.filter(
    (row) => !row.id || !row.claim || !row.label || !row.evidence_texts?.length,
  );
  if (invalid.length) throw new Error(`${invalid.length} invalid benchmark rows`);
  const selected = shuffle(allRows, seed).slice(
    0,
    limit > 0 ? Math.min(limit, allRows.length) : allRows.length,
  );
  const cells = selected.flatMap((row) =>
    Array.from({ length: replicates }, (_, index) => ({
      row,
      replicate: index + 1,
    })),
  );
  console.log(
    JSON.stringify({
      benchmark_rows: allRows.length,
      selected_rows: selected.length,
      checker_calls: cells.length,
      model,
      effort,
      workers,
      replicates,
      priority: os.getPriority(),
      labels: tally(selected.map((row) => row.label)),
    }),
  );
  if (process.argv.includes("--dry-run")) return;
  const resume = flag("resume", "0") !== "0";
  const defaultOutput = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    "beaver-legal-grounding",
    `semantic-benchmark-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
  );
  const output = receiptPath(defaultOutput, { resume });
  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  if (resume && existsSync(output))
    for (const row of readJsonl<Receipt>(output))
      if (!row.error) done.add(receiptKey(row));
  else writeFileSync(output, "", "utf8");
  const pending = cells.filter(
    (cell) =>
      !done.has(
        receiptKey({
          row_id: cell.row.id,
          checker_model: model,
          effort,
          replicate: cell.replicate,
        }),
      ),
  );
  const benchmarkSha256 = hash(readFileSync(benchmark));
  let finished = 0;
  await runPool(pending, workers, async ({ row, replicate }) => {
    const started = Date.now();
    let error: string | null = null;
    let usage: NormalizedLlmUsage | null = null;
    let contextStatus: string | null = null;
    let evidenceStatus: string | null = null;
    let coverage: string | null = null;
    const state = createLegalEvidenceTurnState("compose_check");
    const evidence = row.evidence_texts.map((span, index) =>
      createBenchmarkEvidence({
        jurisdiction: "benchmark",
        sourceClass: row.source_class ?? "case",
        stableSourceId: `${row.id}:evidence:${index}`,
        sourceText: span,
        spanText: span,
        citation: row.citation ?? `benchmark:${row.id}`,
        dataset: row.source,
        locatorKind: "document",
        locatorLabel: row.citation ?? row.id,
      }),
    );
    for (const item of evidence) registerLegalEvidence(state, item);
    state.answer = [
      {
        text: row.claim,
        evidence_ids: evidence.map((item) => item.evidence_id),
        kind: "conclusion",
      },
    ];
    try {
      const result = await semanticClaimVerificationPass({
        state,
        model,
        requestContext: row.request_context ?? undefined,
        reasoningEffort: effort,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      usage = result.usage;
      contextStatus = state.verification?.[0]?.context_status ?? null;
      evidenceStatus = state.verification?.[0]?.evidence_status ?? null;
      coverage = state.coverage;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const resolved = resolvedVerdict({
      contextStatus,
      evidenceStatus,
      coverage,
      error,
    });
    const receipt: Receipt = {
      schema_version: 1,
      probe: "semantic_checker_benchmark",
      benchmark_file: benchmark,
      benchmark_sha256: benchmarkSha256,
      row_id: row.id,
      source: row.source,
      split: row.split,
      doc_id: row.doc_id,
      response_id: row.response_id ?? row.id,
      case_id: row.case_id ?? null,
      claim_sha256: hash(row.claim),
      evidence_span_sha256: evidence.map((item) => item.span_sha256),
      citation: row.citation ?? null,
      gold_label: row.label,
      gold_provenance: row.label_provenance ?? null,
      mutation_type: row.mutation_type ?? null,
      mutation_template_id: row.mutation_template_id ?? null,
      original_label: row.original_label ?? null,
      checker_model: model,
      effort,
      replicate,
      context_status: contextStatus,
      evidence_status: evidenceStatus,
      coverage,
      verdict: resolved.verdict,
      reason_code: resolved.reason,
      review_required: resolved.verdict !== "supported",
      latency_ms: Date.now() - started,
      usage,
      error,
    };
    appendFileSync(output, `${JSON.stringify(receipt)}\n`, "utf8");
    finished += 1;
    if (finished % 25 === 0 || error)
      console.log(`${finished}/${pending.length} | ${row.id} | ${resolved.verdict}`);
  });
  console.log(JSON.stringify({ receipts: output, completed: finished }, null, 2));
}

function selfTest() {
  const rows: Receipt[] = [
    { row_id: "positive", response_id: "positive", gold_label: "supported", review_required: false, replicate: 1, split: "test", mutation_type: null },
    { row_id: "negative", response_id: "negative", gold_label: "unsupported", review_required: true, replicate: 1, split: "test", mutation_type: "x" },
  ] as Receipt[];
  const result = decisionMetrics(rows, "replicate_1");
  if (result.recall_unsupported !== 1 || result.false_positive_rate !== 0)
    throw new Error("semantic benchmark metric self-test failed");
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else if (flag("score", "")) score(flag("score"));
else void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
