/**
 * Recheck routed, non-verbatim claims against only their cited exact passages.
 * The checker is blind to benchmark labels, arms, and cheap-signal values.
 */
import "../src/lib/loadEnv";

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createLegalEvidenceTurnState,
  semanticClaimVerificationPass,
  type GroundedLegalClaim,
  type LegalEvidenceReceiptEvent,
} from "../src/lib/chat/legalEvidenceExperiment";
import { receiptPath } from "../src/lib/experimentReceipts";
import {
  legalGroundingQuestionIndex,
  readJsonl,
} from "../src/lib/legalGroundingBenchmarks";
import type { NormalizedLlmUsage } from "../src/lib/llm";

type MatrixClaim = {
  schema_version: 2;
  record_type: "claim";
  cell_id: string;
  claim_id: string;
  claim_index: number;
  source_file: string;
  source_sha256: string;
  source_line: number;
  split: string | null;
  replicate: number | null;
  case_id: string | null;
  suite: string | null;
  jurisdiction: string | null;
  source_class: string | null;
  model: string | null;
  checker_model: string | null;
  effort: string | null;
  arm: string | null;
  claim_kind: string | null;
  claim_text: string;
  evidence_ids: string[];
  route: string;
};

type BankedRow = {
  case_id?: string;
  legal_evidence_receipt?: LegalEvidenceReceiptEvent | null;
};

type RoutedVerdict =
  | "supported"
  | "insufficient"
  | "contradicted"
  | "invalid"
  | "abstain";

type SemanticReceipt = {
  schema_version: 1;
  probe: "routed_semantic_claim_check";
  source_matrix: string;
  source_matrix_sha256: string;
  source_file: string;
  source_sha256: string;
  source_line: number;
  cell_id: string;
  claim_id: string;
  claim_index: number;
  case_id: string;
  suite: string | null;
  split: string | null;
  jurisdiction: string | null;
  source_class: string | null;
  composer_model: string | null;
  composer_arm: string | null;
  checker_model: string;
  effort: string;
  replicate: number;
  claim_kind: string | null;
  evidence_ids: string[];
  evidence_citations: string[];
  evidence_span_sha256: string[];
  request_context_present: boolean;
  context_status: string | null;
  evidence_status: string | null;
  coverage: string | null;
  verdict: RoutedVerdict;
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

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(file: string) {
  return hash(readFileSync(file));
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(rows: T[], random: () => number): T[] {
  const out = [...rows];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/** Round-robin strata prevents one suite, arm, or model from consuming a
 * small smoke sample. Selection never reads a checker verdict or signal. */
function selectDiverse(rows: MatrixClaim[], limit: number, seed: number) {
  const random = mulberry32(seed);
  const groups = new Map<string, MatrixClaim[]>();
  for (const row of rows) {
    const key = [
      row.suite ?? "unknown",
      row.source_class ?? "unknown",
      row.jurisdiction ?? "unknown",
      row.arm ?? "unknown",
      row.model ?? "unknown",
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const queues = shuffle([...groups.entries()], random).map(([key, group]) => ({
    key,
    rows: shuffle(group, random),
  }));
  const selected: MatrixClaim[] = [];
  while (queues.length && selected.length < limit) {
    for (let index = 0; index < queues.length && selected.length < limit; ) {
      const next = queues[index].rows.shift();
      if (next) selected.push(next);
      if (!queues[index].rows.length) queues.splice(index, 1);
      else index += 1;
    }
  }
  return selected;
}

function routedVerdict(args: {
  contextStatus: string | null;
  evidenceStatus: string | null;
  coverage: string | null;
  error: string | null;
}): { verdict: RoutedVerdict; reason: string } {
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

function key(row: {
  cell_id: string;
  claim_id: string;
  checker_model: string;
  effort: string;
  replicate: number;
}) {
  return [
    row.cell_id,
    row.claim_id,
    row.checker_model,
    row.effort,
    row.replicate,
  ].join("|");
}

async function runPool<T>(
  rows: T[],
  workers: number,
  work: (row: T) => Promise<void>,
) {
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

async function buildQuestionIndex(selected: MatrixClaim[]) {
  if (flag("no-context", "0") !== "0") return new Map<string, string>();
  const repoRoot = path.resolve(__dirname, "../..");
  const tempRoot = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    "beaver-legal-grounding",
  );
  const suites = new Set(selected.map((row) => row.suite));
  const cslbFile = flag(
    "cslb",
    path.join(
      repoRoot,
      "benchmarks/legal-generalization-corpus/cslb/repo/data/a2aj_benchmark.jsonl",
    ),
  );
  const clercFile = flag(
    "clerc",
    process.env.CLERC_GENERATION_TEST ??
      path.join(tempRoot, "clerc/generation/test.jsonl"),
  );
  const housingFile = flag(
    "housing",
    process.env.HOUSING_QA_QUESTIONS ??
      path.join(tempRoot, "housing_qa/data/questions.json.zip"),
  );
  const required = [
    ...(suites.has("cslb") ? [{ suite: "cslb", file: cslbFile }] : []),
    ...(suites.has("clerc") ? [{ suite: "clerc", file: clercFile }] : []),
    ...(suites.has("housing") ? [{ suite: "housing", file: housingFile }] : []),
  ];
  const missing = required.filter((item) => !existsSync(item.file));
  if (missing.length)
    throw new Error(
      `missing original question source for ${missing
        .map((item) => `${item.suite}: ${item.file}`)
        .join(", ")}; pass --no-context 1 only for an explicit context ablation`,
    );
  const housingIds = selected
    .filter((row) => row.suite === "housing")
    .map((row) => Number(row.case_id?.split(":").pop()))
    .filter(Number.isFinite);
  return legalGroundingQuestionIndex({
    ...(suites.has("cslb")
      ? { cslb: { file: cslbFile, splits: ["validation", "test"] } }
      : {}),
    ...(suites.has("clerc") ? { clerc: { file: clercFile } } : {}),
    ...(suites.has("housing")
      ? { housing: { file: housingFile, ids: [...new Set(housingIds)] } }
      : {}),
  });
}

async function main() {
  const matrix = flag("matrix");
  if (!existsSync(matrix)) throw new Error(`matrix not found: ${matrix}`);
  const model = flag("model", "codex:gpt-5.6-luna");
  const effort = flag("effort", "low");
  const seed = Number(flag("seed", "20260801"));
  const limit = Number(flag("limit", "256"));
  const replicates = Number(flag("replicates", "1"));
  const workers = Number(flag("workers", flag("concurrency", "8")));
  const timeoutMs = Number(flag("timeout-ms", "180000"));
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be >= 1");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be >= 1");
  if (!Number.isInteger(replicates) || replicates < 1)
    throw new Error("--replicates must be >= 1");

  const matrixRows = readJsonl<Record<string, unknown>>(matrix);
  const eligible = matrixRows.filter(
    (row): row is MatrixClaim =>
      row.record_type === "claim" &&
      row.schema_version === 2 &&
      row.route === "semantic_check",
  );
  const selected = selectDiverse(eligible, Math.min(limit, eligible.length), seed);
  if (!selected.length) throw new Error("matrix has no routed semantic claims");
  const questions = await buildQuestionIndex(selected);
  const missingQuestions = selected.filter(
    (row) => row.case_id && !questions.has(row.case_id),
  );
  if (missingQuestions.length && flag("no-context", "0") === "0")
    throw new Error(
      `could not reconstruct ${missingQuestions.length} original questions, e.g. ${missingQuestions[0].case_id}`,
    );

  const cells = selected.flatMap((claim) =>
    Array.from({ length: replicates }, (_, index) => ({
      claim,
      replicate: index + 1,
    })),
  );
  console.log(
    JSON.stringify({
      eligible_claims: eligible.length,
      selected_claims: selected.length,
      checker_calls: cells.length,
      distinct_cases: new Set(selected.map((row) => row.case_id)).size,
      suites: [...new Set(selected.map((row) => row.suite))],
      model,
      effort,
      workers,
      seed,
    }),
  );
  if (process.argv.includes("--dry-run")) return;

  const resume = flag("resume", "0") !== "0";
  const defaultOutput = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    "beaver-legal-grounding",
    `routed-semantic-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
  );
  const output = receiptPath(defaultOutput, { resume });
  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  if (resume && existsSync(output))
    for (const row of readJsonl<SemanticReceipt>(output))
      if (!row.error) done.add(key(row));
  else writeFileSync(output, "", "utf8");

  const sourceCache = new Map<
    string,
    { sha256: string; rows: BankedRow[] }
  >();
  const pending = cells.filter(
    (cell) =>
      !done.has(
        key({
          cell_id: cell.claim.cell_id,
          claim_id: cell.claim.claim_id,
          checker_model: model,
          effort,
          replicate: cell.replicate,
        }),
      ),
  );
  let finished = 0;
  let invalid = 0;
  await runPool(pending, workers, async ({ claim: selectedClaim, replicate }) => {
    const started = Date.now();
    let error: string | null = null;
    let usage: NormalizedLlmUsage | null = null;
    let contextStatus: string | null = null;
    let evidenceStatus: string | null = null;
    let coverage: string | null = null;
    let citations: string[] = [];
    let spanHashes: string[] = [];
    try {
      let source = sourceCache.get(selectedClaim.source_file);
      if (!source) {
        if (!existsSync(selectedClaim.source_file))
          throw new Error(`source receipt file moved: ${selectedClaim.source_file}`);
        source = {
          sha256: fileHash(selectedClaim.source_file),
          rows: readJsonl<BankedRow>(selectedClaim.source_file),
        };
        sourceCache.set(selectedClaim.source_file, source);
      }
      if (source.sha256 !== selectedClaim.source_sha256)
        throw new Error("source receipt hash no longer matches matrix");
      const banked = source.rows[selectedClaim.source_line];
      const originalReceipt = banked?.legal_evidence_receipt;
      const originalClaim = originalReceipt?.claims[selectedClaim.claim_index];
      if (!originalReceipt || !originalClaim)
        throw new Error("claim no longer resolves at its receipt coordinate");
      if (
        originalClaim.text_sha256 !== selectedClaim.claim_id ||
        originalClaim.text !== selectedClaim.claim_text
      )
        throw new Error("claim identity no longer matches matrix");
      const evidenceById = new Map(
        originalReceipt.evidence.map((item) => [item.evidence_id, item]),
      );
      const evidence = originalClaim.evidence_ids.map((id) => evidenceById.get(id));
      if (evidence.some((item) => !item))
        throw new Error("claim-specific evidence is missing from source receipt");
      const state = createLegalEvidenceTurnState(originalReceipt.mode);
      for (const item of evidence) {
        state.evidence.set(item!.evidence_id, { receipt: item! });
      }
      const claim: GroundedLegalClaim = {
        text: originalClaim.text,
        evidence_ids: originalClaim.evidence_ids,
        kind: originalClaim.kind,
        premise_source: originalClaim.premise_source,
        premise_text: originalClaim.premise_text,
      };
      state.answer = [claim];
      citations = [...new Set(evidence.map((item) => item!.citation))];
      spanHashes = evidence.map((item) => item!.span_sha256);
      const result = await semanticClaimVerificationPass({
        state,
        model,
        requestContext:
          selectedClaim.case_id === null
            ? undefined
            : questions.get(selectedClaim.case_id),
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
    const resolved = routedVerdict({
      contextStatus,
      evidenceStatus,
      coverage,
      error,
    });
    if (resolved.verdict === "invalid") invalid += 1;
    const receipt: SemanticReceipt = {
      schema_version: 1,
      probe: "routed_semantic_claim_check",
      source_matrix: matrix,
      source_matrix_sha256: fileHash(matrix),
      source_file: selectedClaim.source_file,
      source_sha256: selectedClaim.source_sha256,
      source_line: selectedClaim.source_line,
      cell_id: selectedClaim.cell_id,
      claim_id: selectedClaim.claim_id,
      claim_index: selectedClaim.claim_index,
      case_id: selectedClaim.case_id ?? "unknown",
      suite: selectedClaim.suite,
      split: selectedClaim.split,
      jurisdiction: selectedClaim.jurisdiction,
      source_class: selectedClaim.source_class,
      composer_model: selectedClaim.model,
      composer_arm: selectedClaim.arm,
      checker_model: model,
      effort,
      replicate,
      claim_kind: selectedClaim.claim_kind,
      evidence_ids: selectedClaim.evidence_ids,
      evidence_citations: citations,
      evidence_span_sha256: spanHashes,
      request_context_present: Boolean(
        selectedClaim.case_id && questions.has(selectedClaim.case_id),
      ),
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
    if (finished % 10 === 0 || error)
      console.log(
        `${finished}/${pending.length} | ${selectedClaim.case_id} | ${resolved.verdict}${error ? ` | ${error}` : ""}`,
      );
  });
  console.log(
    JSON.stringify({ receipts: output, completed: finished, invalid }, null, 2),
  );
}

function selfTest() {
  const rows = [
    { suite: "a", source_class: "case", jurisdiction: "CA", arm: "x", model: "m" },
    { suite: "a", source_class: "case", jurisdiction: "CA", arm: "x", model: "m" },
    { suite: "b", source_class: "law", jurisdiction: "US", arm: "y", model: "n" },
  ].map((row, index) => ({ ...row, record_type: "claim", schema_version: 2, cell_id: String(index), claim_id: String(index), claim_index: 0, source_file: "f", source_sha256: "h", source_line: index, split: null, replicate: null, case_id: String(index), checker_model: null, effort: "low", claim_kind: "conclusion", claim_text: "claim", evidence_ids: ["e"], route: "semantic_check" })) as MatrixClaim[];
  const selected = selectDiverse(rows, 2, 1);
  if (new Set(selected.map((row) => row.suite)).size !== 2)
    throw new Error("diverse selection self-test failed");
  const verdict = routedVerdict({
    contextStatus: "preserved",
    evidenceStatus: "insufficient",
    coverage: "complete",
    error: null,
  });
  if (verdict.verdict !== "insufficient")
    throw new Error("semantic verdict self-test failed");
  console.log("ok");
}

if (process.argv.includes("--self-test")) selfTest();
else void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
