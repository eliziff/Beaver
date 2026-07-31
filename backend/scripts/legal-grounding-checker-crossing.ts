/**
 * PROVISIONAL, BENCHMARK-TESTED ONLY.
 *
 * Checker-family crossing on BANKED compositions (registered twice in
 * docs/legal-grounding-experiments-2026-07-30.md, never run).
 *
 * The program's founding premise — "the harness carries grounding
 * decisions, not the model family" (H5) — rests on 8 cells over one item
 * pair. This re-judges archived answers with a DIFFERENT checker family
 * while holding the composition, the evidence, the question, the system
 * prompt and the tool fixed: no composer call is made, so the only thing
 * that varies is who checks.
 *
 * Three conditions per sampled row:
 *   original     the verdict already in the receipt (not re-run)
 *   same_family  re-check on the SAME checker model — the run-to-run
 *                stochasticity floor measured at THIS n, not borrowed
 *   cross_family re-check on the other family's anchor model
 *
 * Rows whose claims all cleared the deterministic verbatim tier never saw
 * a checker at all. They are sampled separately (`--det-sample`) and sent
 * to BOTH families, because "family-invariant by construction" is a claim
 * about the tier, and a model checker rejecting a tier-cleared answer is a
 * bigger finding than the crossing itself.
 *
 *   npx tsx scripts/legal-grounding-checker-crossing.ts `
 *     --judged-sample 110 --det-sample 24 --replicates 1 `
 *     --output <receipt store>/stage20-checker-crossing.jsonl
 */
import "../src/lib/loadEnv";

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createLegalEvidenceTurnState,
  deterministicClaimSupport,
  holisticVerificationPass,
  type GroundedLegalClaim,
  type LegalEvidenceMode,
  type LegalEvidenceReceiptEvent,
  type LegalEvidenceTurnState,
} from "../src/lib/chat/legalEvidenceExperiment";
import { receiptPath } from "../src/lib/experimentReceipts";
import {
  clercCases,
  cslbCases,
  housingCases,
  readJsonl,
} from "../src/lib/legalGroundingBenchmarks";
import type { NormalizedLlmUsage } from "../src/lib/llm";

/** Anchor model per family: the composer/checker each family ran most. */
const FAMILY_ANCHOR = {
  codex: "codex:gpt-5.6-sol",
  claude: "claude-p:claude-sonnet-4-6",
} as const;

type Family = keyof typeof FAMILY_ANCHOR;

function familyOf(model: string): Family | null {
  if (model.startsWith("codex:")) return "codex";
  if (model.startsWith("claude-p:") || model.startsWith("claude:"))
    return "claude";
  return null;
}

/** The banked row shape this probe consumes (a subset of RunReceipt). */
type BankedRow = {
  case_id: string;
  suite: string;
  source_class: string;
  arm: string;
  model: string;
  checker_model: string | null;
  effort: string;
  status: string;
  holistic_verdict: string | null;
  rank_policy?: string | null;
  legal_evidence_receipt: LegalEvidenceReceiptEvent | null;
};

type Candidate = {
  source_file: string;
  source_line: number;
  row: BankedRow;
  receipt: LegalEvidenceReceiptEvent;
  checker: string;
  family: Family;
  /** Every claim cleared the deterministic verbatim tier as banked. */
  det_all: boolean;
  /** Deterministic tier recomputed here from the banked receipt. */
  det_all_recomputed: boolean;
  det_per_claim_matches_banked: boolean;
};

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

/** Deterministic PRNG so the sample is reproducible from the seed alone. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/**
 * Rebuild the turn state the original checker saw: the same evidence
 * receipts under the same evidence_ids, the same submitted claims, the
 * same mode, and (lint_gated only) the same lint receipts, which ride
 * into the checker prompt as deterministic observations.
 */
function stateFromReceipt(
  receipt: LegalEvidenceReceiptEvent,
): LegalEvidenceTurnState {
  const state = createLegalEvidenceTurnState(
    receipt.mode as LegalEvidenceMode,
  );
  for (const evidence of receipt.evidence)
    state.evidence.set(evidence.evidence_id, { receipt: evidence });
  state.answer = receipt.claims.map(
    (claim): GroundedLegalClaim => ({
      text: claim.text,
      evidence_ids: claim.evidence_ids,
      kind: claim.kind,
      premise_source: claim.premise_source,
      premise_text: claim.premise_text,
    }),
  );
  if (receipt.mode === "lint_gated")
    state.lintReceipts = receipt.claims.map((claim) => claim.lint ?? []);
  return state;
}

async function questionIndex(): Promise<Map<string, string>> {
  const repoRoot = path.resolve(__dirname, "../..");
  const tempRoot = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    "beaver-legal-grounding",
  );
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
  const housingIds = flag("housing-ids", "0,1,5,57,58,163,286,290,354,356,590,595,605")
    .split(",")
    .map((value) => Number(value.trim()));
  const cases = [
    ...cslbCases(cslbFile, "validation", 10_000),
    ...clercCases(clercFile, 10_000),
    ...(await housingCases(housingFile, housingIds)),
  ];
  return new Map(cases.map((item) => [item.id, item.prompt]));
}

function loadCandidates(store: string, files: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const file of files) {
    const full = path.join(store, file);
    if (!existsSync(full)) throw new Error(`receipt not found: ${full}`);
    readJsonl<BankedRow>(full).forEach((row, index) => {
      const receipt = row.legal_evidence_receipt;
      if (
        row.status !== "completed" ||
        !receipt ||
        !receipt.claims?.length ||
        !receipt.evidence?.length
      )
        return;
      const checker = row.checker_model || row.model;
      const family = familyOf(checker);
      if (!family) return;
      const state = stateFromReceipt(receipt);
      const recomputed = (state.answer ?? []).map((claim) =>
        deterministicClaimSupport(claim, state),
      );
      const banked = receipt.claims.map((claim) =>
        claim.deterministic_support === true,
      );
      const hadTier = receipt.claims.some(
        (claim) => claim.deterministic_support !== undefined,
      );
      out.push({
        source_file: file,
        source_line: index,
        row,
        receipt,
        checker,
        family,
        det_all: hadTier && banked.every(Boolean),
        det_all_recomputed: recomputed.every(Boolean),
        det_per_claim_matches_banked:
          !hadTier ||
          (recomputed.length === banked.length &&
            recomputed.every((value, at) => value === banked[at])),
      });
    });
  }
  return out;
}

/**
 * Stratified draw. Strata are (original checker family × source_class ×
 * original verdict), with accepts deliberately over-sampled: a false
 * accept is the failure mode that matters, and it can only be seen on a
 * row the original checker accepted.
 */
function drawJudged(
  candidates: Candidate[],
  total: number,
  random: () => number,
): Candidate[] {
  const judged = candidates.filter((item) => item.row.holistic_verdict);
  const weights: Record<string, number> = {
    supported: 0.6,
    partially_supported: 0.3,
    unsupported: 0.1,
  };
  const picked: Candidate[] = [];
  for (const family of ["claude", "codex"] as Family[]) {
    for (const [verdict, share] of Object.entries(weights)) {
      for (const sourceClass of ["case", "legislation"]) {
        const pool = shuffled(
          judged.filter(
            (item) =>
              item.family === family &&
              item.row.holistic_verdict === verdict &&
              item.row.source_class === sourceClass,
          ),
          random,
        );
        const want = Math.round((total / 2) * share * 0.5);
        // Spread the draw across arms and case ids before truncating, so
        // one arm or one item cannot own a stratum.
        const seen = new Map<string, number>();
        const spread = [...pool].sort((left, right) => {
          const key = (item: Candidate) =>
            `${item.row.arm}|${item.row.case_id}`;
          const rank = (item: Candidate) => {
            const at = (seen.get(key(item)) ?? 0) + 1;
            seen.set(key(item), at);
            return at;
          };
          return rank(left) - rank(right);
        });
        picked.push(...spread.slice(0, want));
      }
    }
  }
  return picked;
}

type CrossReceipt = {
  schema_version: 1;
  probe: "checker_family_crossing";
  source_file: string;
  source_line: number;
  case_id: string;
  suite: string;
  source_class: string;
  arm: string;
  mode: string;
  rank_policy: string | null;
  composer_model: string;
  original_checker_model: string;
  original_checker_family: Family;
  original_verdict: string | null;
  original_status: string;
  original_det_all: boolean;
  det_all_recomputed: boolean;
  det_per_claim_matches_banked: boolean;
  stratum: "judged" | "deterministic";
  condition: "same_family" | "cross_family";
  replicate: number;
  recheck_checker_model: string;
  recheck_checker_family: Family;
  effort: string;
  verdict: string | null;
  latency_ms: number;
  usage: NormalizedLlmUsage | null;
  error: string | null;
};

function cellKey(row: {
  source_file: string;
  source_line: number;
  recheck_checker_model: string;
  replicate: number;
}) {
  return [
    row.source_file,
    row.source_line,
    row.recheck_checker_model,
    row.replicate,
  ].join("|");
}

async function runPool<T>(
  cells: T[],
  limit: number,
  key: (cell: T) => string,
  perKey: number,
  worker: (cell: T) => Promise<void>,
): Promise<void> {
  const pending = [...cells];
  const active = new Map<string, number>();
  let running = 0;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!pending.length && running === 0) return resolve();
      for (let index = 0; index < pending.length && running < limit; ) {
        const cell = pending[index];
        const lane = key(cell);
        if ((active.get(lane) ?? 0) >= perKey) {
          index += 1;
          continue;
        }
        pending.splice(index, 1);
        active.set(lane, (active.get(lane) ?? 0) + 1);
        running += 1;
        worker(cell).then(
          () => {
            active.set(lane, active.get(lane)! - 1);
            running -= 1;
            pump();
          },
          (error) => {
            failed = true;
            reject(error);
          },
        );
      }
    };
    pump();
  });
}

async function main() {
  const store = flag(
    "store",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "OpenLegalData/experiments/legal-grounding/2026-07-30",
    ),
  );
  const files = flag(
    "files",
    [
      "stage5-h5.jsonl",
      "stage6-h6.jsonl",
      "stage7-h7.jsonl",
      "stage8-h8.jsonl",
      "stage8b-h15h16h17.jsonl",
      "stage9-h19h20.jsonl",
      "stage10-h18.jsonl",
      "stage11-luna-baseline.jsonl",
      "stage12-claude5.jsonl",
      "stage13-ladder.jsonl",
      "stage13-solmax.jsonl",
    ].join(","),
  ).split(",");
  const seed = Number(flag("seed", "20260731"));
  const judgedSample = Number(flag("judged-sample", "110"));
  const detSample = Number(flag("det-sample", "24"));
  const replicates = Number(flag("replicates", "1"));
  const timeoutMs = Number(flag("timeout-ms", "180000"));
  const concurrency = Number(flag("concurrency", "6"));
  const perModel = Number(flag("per-model-concurrency", "3"));

  const candidates = loadCandidates(store, files);
  const questions = await questionIndex();
  const missing = candidates.filter(
    (item) => !questions.has(item.row.case_id),
  );
  if (missing.length)
    throw new Error(
      `no question text for ${missing.length} rows, e.g. ${missing[0].row.case_id}`,
    );

  const tierDrift = candidates.filter(
    (item) => !item.det_per_claim_matches_banked,
  );
  console.log(
    `candidates ${candidates.length} | judged ${
      candidates.filter((item) => item.row.holistic_verdict).length
    } | deterministic-cleared ${
      candidates.filter((item) => item.det_all).length
    } | tier recompute drift ${tierDrift.length}`,
  );

  const random = mulberry32(seed);
  const judged = drawJudged(candidates, judgedSample, random);
  const det = shuffled(
    candidates.filter((item) => item.det_all),
    random,
  ).slice(0, detSample);

  const cells: Array<{
    candidate: Candidate;
    stratum: "judged" | "deterministic";
    condition: "same_family" | "cross_family";
    checker: string;
    replicate: number;
  }> = [];
  for (const candidate of judged)
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      cells.push({
        candidate,
        stratum: "judged",
        condition: "same_family",
        checker: candidate.checker,
        replicate,
      });
      cells.push({
        candidate,
        stratum: "judged",
        condition: "cross_family",
        checker:
          FAMILY_ANCHOR[candidate.family === "codex" ? "claude" : "codex"],
        replicate,
      });
    }
  for (const candidate of det)
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      cells.push({
        candidate,
        stratum: "deterministic",
        condition: "same_family",
        checker: candidate.checker,
        replicate,
      });
      cells.push({
        candidate,
        stratum: "deterministic",
        condition: "cross_family",
        checker:
          FAMILY_ANCHOR[candidate.family === "codex" ? "claude" : "codex"],
        replicate,
      });
    }

  console.log(
    `sample: judged rows ${judged.length}, deterministic rows ${det.length}, checker calls ${cells.length}`,
  );
  if (process.argv.includes("--dry-run")) {
    const tally: Record<string, number> = {};
    for (const item of judged) {
      const key = `${item.family}|${item.row.source_class}|${item.row.holistic_verdict}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    console.log(JSON.stringify(tally, null, 1));
    const arms: Record<string, number> = {};
    judged.forEach((item) => {
      arms[item.row.arm] = (arms[item.row.arm] ?? 0) + 1;
    });
    console.log("arms", JSON.stringify(arms));
    return;
  }

  const resume = flag("resume", "0") !== "0";
  const output = receiptPath(
    path.join(store, "stage20-checker-crossing.jsonl"),
    { resume },
  );
  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  if (resume && existsSync(output)) {
    for (const row of readJsonl<CrossReceipt>(output))
      if (!row.error) done.add(cellKey(row));
  } else writeFileSync(output, "", "utf8");

  const pending = cells.filter(
    (cell) =>
      !done.has(
        cellKey({
          source_file: cell.candidate.source_file,
          source_line: cell.candidate.source_line,
          recheck_checker_model: cell.checker,
          replicate: cell.replicate,
        }),
      ),
  );
  console.log(`pending ${pending.length} of ${cells.length}`);
  let finished = 0;
  await runPool(
    pending,
    concurrency,
    (cell) => cell.checker,
    perModel,
    async (cell) => {
      const { candidate } = cell;
      const started = Date.now();
      const state = stateFromReceipt(candidate.receipt);
      let error: string | null = null;
      let usage: NormalizedLlmUsage | null = null;
      try {
        const result = await holisticVerificationPass({
          state,
          model: cell.checker,
          requestContext: questions.get(candidate.row.case_id),
          reasoningEffort: candidate.row.effort,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        usage = result.usage;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const receipt: CrossReceipt = {
        schema_version: 1,
        probe: "checker_family_crossing",
        source_file: candidate.source_file,
        source_line: candidate.source_line,
        case_id: candidate.row.case_id,
        suite: candidate.row.suite,
        source_class: candidate.row.source_class,
        arm: candidate.row.arm,
        mode: candidate.receipt.mode,
        rank_policy: candidate.row.rank_policy ?? null,
        composer_model: candidate.row.model,
        original_checker_model: candidate.checker,
        original_checker_family: candidate.family,
        original_verdict: candidate.row.holistic_verdict,
        original_status: candidate.receipt.status,
        original_det_all: candidate.det_all,
        det_all_recomputed: candidate.det_all_recomputed,
        det_per_claim_matches_banked: candidate.det_per_claim_matches_banked,
        stratum: cell.stratum,
        condition: cell.condition,
        replicate: cell.replicate,
        recheck_checker_model: cell.checker,
        recheck_checker_family: familyOf(cell.checker)!,
        effort: candidate.row.effort,
        verdict: state.holisticVerdict,
        latency_ms: Date.now() - started,
        usage,
        error,
      };
      appendFileSync(output, `${JSON.stringify(receipt)}\n`, "utf8");
      finished += 1;
      if (finished % 10 === 0 || error)
        console.log(
          `${finished}/${pending.length} | ${cell.condition} | ${cell.checker
            .split(":")
            .pop()} | ${candidate.row.case_id} | ${
            candidate.row.holistic_verdict ?? "det"
          } -> ${state.holisticVerdict ?? "ERR"}${error ? ` | ${error}` : ""}`,
        );
    },
  );
  console.log(`\nreceipts: ${output}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
