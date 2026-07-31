/**
 * C4 evidence-layer feature matrix builder (research plan workstream C4;
 * docs/legal-grounding-restart-plan-2026-07-31.md priority 3).
 *
 * ONE derived matrix row per archived composed claim, every deterministic
 * witness a column, citator-derived columns joined from the local noteup
 * graph. Zero model calls: the lint is recomputed offline over archived
 * claim text + the spans the claim itself cited, with the SAME
 * jurisdiction-matched alienness index the run used (US cells ->
 * trigrams-en-us.sqlite, CA cells -> the Canadian default), and the same
 * question text the composer saw, reloaded from the benchmark loaders.
 *
 * Labels are CHECKER-DERIVED and carry the measured 0-13% flip rate
 * (H17). Two label columns are emitted and kept separate:
 *   cell_reject   - the cell's holistic verdict is not "supported"
 *                   (the honest unit: the checker judges the CELL)
 *   c2_label      - the C2/calibrate-claim-lint propagation
 *                   (supported -> accepted; single-claim non-supported
 *                   -> rejected; everything else null)
 *
 * Contamination note carried on every row: `lint_in_loop` is true for
 * the Stage 7 lint_gated arm, whose archived claim text is POST-revision
 * (the gate bounced flagged claims once). Those rows must be excluded
 * from any lint-as-predictor analysis.
 *
 * Read-only over receipts and local indexes; writes ONE new jsonl under
 * the receipt store plus a manifest with its sha256. Never overwrites.
 *
 *   npx tsx scripts/c4-build-matrix.ts [--out <file>] [--stages 1,2,...]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  citationLookupKey,
  standsForProfile,
  type StandsForProfile,
} from "../src/lib/caselawCitator";
import { courtLevel } from "../src/lib/courtLevels";
import { contentWordCount, lintLegalClaim } from "../src/lib/legalClaimLint";
import {
  clercCases,
  cslbCases,
  housingCases,
  type BenchmarkCase,
} from "../src/lib/legalGroundingBenchmarks";
import { withReadonlySqlite } from "../src/lib/legalDataPath";

function flag(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const LOCAL =
  process.env.LOCALAPPDATA?.trim() ||
  path.join(os.homedir(), "AppData", "Local");
const ARCHIVE = flag(
  "receipts",
  path.join(
    LOCAL,
    "OpenLegalData",
    "experiments",
    "legal-grounding",
    "2026-07-30",
  ),
);
const OUT = flag("out", path.join(ARCHIVE, "c4-claim-matrix-20260731.jsonl"));
const CITATOR = path.join(LOCAL, "ALR Quote Verifier", "citator", "noteup.sqlite");
const US_INDEX = path.join(
  LOCAL,
  "ALR Quote Verifier",
  "alienness",
  "trigrams-en-us.sqlite",
);

/**
 * The Canadian/US grounding lane only. Stages 14-18 are LegalBench-RAG
 * (contract QA: no citations, no courts, a different bed the restart plan
 * deprioritises) and stage20 is another session's in-flight checker
 * crossing. Both are excluded by name, recorded here rather than in a
 * filter expression so the exclusion is auditable.
 */
const LANE = new Set([
  "stage1-h1.jsonl",
  "stage1-h1-rerun.jsonl",
  "stage2-h2.jsonl",
  "stage3-h3.jsonl",
  "stage4-h4.jsonl",
  "stage5-h5.jsonl",
  "stage6-h6.jsonl",
  "stage7-h7.jsonl",
  "stage8-h8.jsonl",
  "stage8b-h15h16h17.jsonl",
  "stage9-h19h20.jsonl",
  "stage10-h18.jsonl",
  "stage11-luna-baseline.jsonl",
  "stage12-claude5.jsonl",
  "stage12b-transport-probe.jsonl",
  "stage13-ladder.jsonl",
  "stage13-solmax.jsonl",
]);

if (existsSync(OUT))
  throw new Error(`refusing to overwrite existing matrix: ${OUT}`);

// ---------------------------------------------------------------- prompts

const repoRoot = path.resolve(__dirname, "..", "..");
const tempRoot = path.join(os.tmpdir(), "beaver-legal-grounding");
const prompts = new Map<string, string>();
const promptSources: Record<string, number> = {};
function loadPrompts(label: string, load: () => BenchmarkCase[] | Promise<BenchmarkCase[]>) {
  return Promise.resolve()
    .then(load)
    .then((cases) => {
      for (const item of cases) prompts.set(item.id, item.prompt);
      promptSources[label] = cases.length;
    })
    .catch((error) => {
      promptSources[label] = -1;
      console.warn(`prompt source ${label} unavailable: ${String(error)}`);
    });
}

// ------------------------------------------------------------- citator join

type CitatorColumns = {
  cited_key: string | null;
  citer_count: number | null;
  cited_court: string | null;
  cited_court_level: number | null;
  profile_tier: string | null;
  profile_usable: number | null;
};
const citatorCache = new Map<string, CitatorColumns>();

function courtForKey(key: string): string | null {
  return (
    withReadonlySqlite(CITATOR, (database) => {
      const row = database
        .prepare(
          `SELECT case_doc.court AS court
             FROM case_key JOIN case_doc ON case_doc.id = case_key.case_id
            WHERE case_key.citation_key = ? LIMIT 1`,
        )
        .get(key) as { court?: string } | undefined;
      return row?.court ?? null;
    }) ?? null
  );
}

function citatorColumns(citation: string | null | undefined): CitatorColumns {
  const empty: CitatorColumns = {
    cited_key: null,
    citer_count: null,
    cited_court: null,
    cited_court_level: null,
    profile_tier: null,
    profile_usable: null,
  };
  if (!citation) return empty;
  let key: string;
  try {
    key = citationLookupKey(citation);
  } catch {
    return empty;
  }
  const cached = citatorCache.get(key);
  if (cached) return cached;
  let profile: StandsForProfile | null = null;
  try {
    profile = standsForProfile({ citation });
  } catch {
    profile = null;
  }
  const court = courtForKey(key);
  const columns: CitatorColumns = {
    cited_key: key,
    citer_count: profile ? profile.totalCiters : null,
    cited_court: court,
    cited_court_level: courtLevel(court)?.level ?? null,
    profile_tier: profile ? profile.tier : null,
    profile_usable: profile ? profile.candidates.length : null,
  };
  citatorCache.set(key, columns);
  return columns;
}

// ------------------------------------------------------------------- main

async function main() {
  await loadPrompts("cslb", () =>
    cslbCases(
      path.join(
        repoRoot,
        "benchmarks/legal-generalization-corpus/cslb/repo/data/a2aj_benchmark.jsonl",
      ),
      "validation",
      10_000,
    ),
  );
  await loadPrompts("clerc", () =>
    clercCases(path.join(tempRoot, "clerc/generation/test.jsonl"), 10_000),
  );
  await loadPrompts("housing", () =>
    housingCases(
      path.join(tempRoot, "housing_qa/data/questions.json.zip"),
      [0, 1, 5, 57, 58, 163, 286, 290, 354, 356, 590, 595, 605],
    ),
  );

  const files = readdirSync(ARCHIVE)
    .filter((name) => LANE.has(name))
    .sort();
  const out: string[] = [];
  const stageCells: Record<string, number> = {};
  let cells = 0;
  let cellsWithVerdict = 0;

  for (const file of files) {
    const stage = file.replace(/\.jsonl$/u, "");
    for (const line of readFileSync(path.join(ARCHIVE, file), "utf8").split(
      /\r?\n/u,
    )) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const rec = row.legal_evidence_receipt ?? row.receipt;
      if (!rec) continue;
      cells += 1;
      const verdict = rec.verification?.holistic;
      if (!verdict || verdict === "not_run") continue;
      cellsWithVerdict += 1;
      stageCells[stage] = (stageCells[stage] ?? 0) + 1;
      const claims: any[] = rec.claims ?? [];
      const spans = new Map<string, string>(
        (rec.evidence ?? []).map((e: any) => [e.evidence_id, e.span_text ?? ""]),
      );
      const citations = new Map<string, string>(
        (rec.evidence ?? []).map((e: any) => [e.evidence_id, e.citation ?? ""]),
      );
      const question = prompts.get(row.case_id) ?? null;
      const cellKey = `${stage}::${row.case_id}::${row.model}::${row.arm}::${row.effort}::${cells}`;
      const c2Label =
        verdict === "supported"
          ? "accepted"
          : claims.length === 1
            ? "rejected"
            : null;

      claims.forEach((claim, claimIndex) => {
        const spanTexts = (claim.evidence_ids ?? [])
          .map((id: string) => spans.get(id) ?? "")
          .filter(Boolean);
        const text = (claim.text ?? "").trim();
        if (!text) return;
        const features: Record<string, number> = {};
        if (spanTexts.length) {
          const lint = lintLegalClaim({
            claim: text,
            spans: spanTexts,
            ...(question ? { question } : {}),
            ...(row.jurisdiction === "US"
              ? { alienessIndexPath: US_INDEX }
              : {}),
          });
          for (const receipt of lint.receipts)
            features[receipt.feature] = receipt.value;
        }
        const firstCitation = (claim.evidence_ids ?? [])
          .map((id: string) => citations.get(id))
          .find((value: string | undefined) => Boolean(value));
        out.push(
          JSON.stringify({
            stage,
            cell_key: cellKey,
            case_id: row.case_id,
            suite: row.suite,
            jurisdiction: row.jurisdiction,
            source_class: row.source_class,
            adversarial: row.adversarial ?? null,
            model: row.model,
            checker_model: row.checker_model ?? null,
            arm: row.arm,
            effort: row.effort ?? null,
            lint_in_loop: stage === "stage7-h7" && row.arm === "lint_gated",
            holistic: verdict,
            cell_reject: verdict === "supported" ? 0 : 1,
            /** Gold-derived cell quality, independent of the checker and
             * therefore of the 0-13% flip rate. The only quality axis in
             * the archive that the checker's own verdict cannot circle. */
            target_token_f1: row.target_token_f1 ?? null,
            expected_answer_match: row.expected_answer_match ?? null,
            inline_citation_rate: row.inline_citation_rate ?? null,
            c2_label: c2Label,
            claim_index: claimIndex,
            claims_in_cell: claims.length,
            claim_kind: claim.kind ?? null,
            deterministic_support: Boolean(claim.deterministic_support),
            question_available: Boolean(question),
            n_spans: spanTexts.length,
            claim_content_words: contentWordCount(text),
            claim_chars: text.length,
            span_chars: spanTexts.join(" ").length,
            archived_lint: claim.lint ?? null,
            /** Stage 9's recorded conclusion-claim alienness spectrum
             * (cell-level, 424/515 rows) — the C4 matrix growth the log
             * banked and never analysed. */
            conclusion_alienness: row.conclusion_alienness ?? null,
            features,
            citator: citatorColumns(firstCitation),
          }),
        );
      });
    }
  }

  const body = out.join("\n") + "\n";
  writeFileSync(OUT, body);
  const sha = createHash("sha256").update(body, "utf8").digest("hex");
  const manifest = {
    built: new Date().toISOString(),
    out: OUT,
    sha256: sha,
    rows: out.length,
    cells_scanned: cells,
    cells_with_verdict: cellsWithVerdict,
    stage_cells: stageCells,
    files: files,
    prompt_sources: promptSources,
    citator: CITATOR,
    us_index: US_INDEX,
    distinct_citations_joined: citatorCache.size,
  };
  const manifestPath = OUT.replace(/\.jsonl$/u, ".manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main();
