/**
 * Retrospective, zero-model-call audit of the archived C4 matrix.
 *
 * This deliberately does not import the current lint, retrieval, citator, or
 * checker code. It reads frozen feature values from one archived matrix and
 * writes a new receipt outside the repository.
 *
 *   npx tsx scripts/legal-grounding-length-audit.ts
 *   npx tsx scripts/legal-grounding-length-audit.ts --self-test
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Label = 0 | 1;
type Row = {
  case_id?: string;
  cell_key?: string;
  jurisdiction?: string;
  source_class?: string;
  lint_in_loop?: boolean;
  claim_content_words?: number;
  cell_reject?: Label;
  c2_label?: "accepted" | "rejected" | null;
  features?: { unattested_trigram_share?: number };
};

type Scored = Row & { label: Label; length: number; alienness: number; residual: number };
type Metric = {
  n: number;
  positives: number;
  auc: number | null;
  oriented_auc: number | null;
  fixed_threshold?: { threshold: number; predicted: number; precision: number | null; recall: number | null; false_positive_rate: number | null };
  bootstrap_ci?: [number, number] | null;
};

const LOCAL = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
const DEFAULT_DIR = path.join(LOCAL, "OpenLegalData", "experiments", "legal-grounding", "2026-07-30");
const DEFAULT_MATRIX = path.join(DEFAULT_DIR, "c4-claim-matrix-20260731c.jsonl");
const DEFAULT_MANIFEST = path.join(DEFAULT_DIR, "c4-claim-matrix-20260731c.manifest.json");
const ALIENNESS_THRESHOLD = 0.823529;
const MIN_CONTENT_WORDS = 12;
const BOOTSTRAPS = 1000;
const SEED = 20260801;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function auc(rows: Array<{ label: Label; score: number }>): number | null {
  const positives = rows.filter((row) => row.label === 1).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const meanRank = (rank + rank + j - i - 1) / 2;
    for (let k = i; k < j; k += 1) if (sorted[k].label === 1) positiveRankSum += meanRank;
    rank += j - i;
    i = j;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function orientedAuc(value: number | null): number | null {
  return value === null ? null : Math.max(value, 1 - value);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function isotonicFit(training: Scored[]): Array<{ lo: number; hi: number; value: number }> {
  const points = [...training]
    .sort((a, b) => a.length - b.length || a.alienness - b.alienness)
    .map((row) => ({ lo: row.length, hi: row.length, sum: row.alienness, count: 1 }));
  const blocks: typeof points = [];
  for (const point of points) {
    blocks.push(point);
    while (blocks.length >= 2) {
      const left = blocks[blocks.length - 2];
      const right = blocks[blocks.length - 1];
      if (left.sum / left.count <= right.sum / right.count) break;
      blocks.splice(blocks.length - 2, 2, {
        lo: left.lo,
        hi: right.hi,
        sum: left.sum + right.sum,
        count: left.count + right.count,
      });
    }
  }
  return blocks.map((block) => ({ lo: block.lo, hi: block.hi, value: block.sum / block.count }));
}

function predict(blocks: Array<{ lo: number; hi: number; value: number }>, length: number): number {
  if (length <= blocks[0].lo) return blocks[0].value;
  for (const block of blocks) if (length <= block.hi) return block.value;
  return blocks[blocks.length - 1].value;
}

function scoreResiduals(rows: Scored[]): Scored[] {
  const byCase = new Map<string, Scored[]>();
  for (const row of rows) {
    const key = row.case_id ?? row.cell_key ?? "missing-case";
    const group = byCase.get(key) ?? [];
    group.push(row);
    byCase.set(key, group);
  }
  return [...byCase.entries()].flatMap(([heldOut, test]) => {
    const training = rows.filter((row) => (row.case_id ?? row.cell_key ?? "missing-case") !== heldOut);
    const blocks = isotonicFit(training.length ? training : rows);
    return test.map((row) => ({ ...row, residual: row.alienness - predict(blocks, row.length) }));
  });
}

function fixedThreshold(rows: Array<{ label: Label; score: number }>): Metric["fixed_threshold"] {
  const selected = rows.filter((row) => row.score > ALIENNESS_THRESHOLD);
  const tp = selected.filter((row) => row.label === 1).length;
  const fp = selected.length - tp;
  const positives = rows.filter((row) => row.label === 1).length;
  const negatives = rows.length - positives;
  return {
    threshold: ALIENNESS_THRESHOLD,
    predicted: selected.length,
    precision: selected.length ? tp / selected.length : null,
    recall: positives ? tp / positives : null,
    false_positive_rate: negatives ? fp / negatives : null,
  };
}

function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function bootstrapAuc(rows: Scored[], score: (row: Scored) => number): [number, number] | null {
  const cells = [...new Set(rows.map((row) => row.cell_key ?? "missing-cell"))];
  const byCell = new Map<string, Scored[]>();
  for (const row of rows) {
    const key = row.cell_key ?? "missing-cell";
    byCell.set(key, [...(byCell.get(key) ?? []), row]);
  }
  const random = lcg(SEED);
  const values: number[] = [];
  for (let i = 0; i < BOOTSTRAPS; i += 1) {
    const sample: Scored[] = [];
    for (let j = 0; j < cells.length; j += 1) sample.push(...(byCell.get(cells[Math.floor(random() * cells.length)]) ?? []));
    const value = auc(sample.map((row) => ({ label: row.label, score: score(row) })));
    if (value !== null) values.push(value);
  }
  const lo = percentile(values, 0.025);
  const hi = percentile(values, 0.975);
  return lo === null || hi === null ? null : [lo, hi];
}

function metric(rows: Scored[], score: (row: Scored) => number, threshold = false): Metric {
  const scored = rows.map((row) => ({ label: row.label, score: score(row) }));
  const value = auc(scored);
  return {
    n: rows.length,
    positives: rows.filter((row) => row.label === 1).length,
    auc: value,
    oriented_auc: orientedAuc(value),
    ...(threshold ? { fixed_threshold: fixedThreshold(scored) } : {}),
    bootstrap_ci: bootstrapAuc(rows, score),
  };
}

function readRows(matrix: string, expectedHash: string): Row[] {
  const body = readFileSync(matrix, "utf8");
  const actualHash = sha256(body);
  if (actualHash !== expectedHash) throw new Error(`matrix hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  return body.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function eligible(rows: Row[], labelKind: "cell_reject" | "c2_label"): Scored[] {
  return rows.flatMap((row) => {
    if (row.lint_in_loop) return [];
    const length = row.claim_content_words;
    const alienness = row.features?.unattested_trigram_share;
    const label = labelKind === "cell_reject" ? row.cell_reject : row.c2_label === "rejected" ? 1 : row.c2_label === "accepted" ? 0 : undefined;
    if (!Number.isFinite(length) || length! < MIN_CONTENT_WORDS || !Number.isFinite(alienness) || label === undefined) return [];
    return [{ ...row, label, length: length!, alienness: alienness!, residual: 0 }];
  });
}

function run(rows: Row[], labelKind: "cell_reject" | "c2_label") {
  const data = scoreResiduals(eligible(rows, labelKind));
  const length = metric(data, (row) => row.length);
  const alienness = metric(data, (row) => row.alienness, true);
  const residual = metric(data, (row) => row.residual);
  return {
    label: labelKind,
    rows: data.length,
    cells: new Set(data.map((row) => row.cell_key)).size,
    cases: new Set(data.map((row) => row.case_id)).size,
    positives: data.filter((row) => row.label === 1).length,
    length,
    alienness,
    length_controlled_alienness: residual,
    delta_alienness_minus_length: alienness.auc === null || length.auc === null ? null : alienness.auc - length.auc,
    delta_residual_minus_length: residual.auc === null || length.auc === null ? null : residual.auc - length.auc,
  };
}

function byStratum(rows: Row[], labelKind: "cell_reject" | "c2_label") {
  const strata = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.jurisdiction ?? "unknown"}/${row.source_class ?? "unknown"}`;
    strata.set(key, [...(strata.get(key) ?? []), row]);
  }
  return Object.fromEntries(
    [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, run(group, labelKind)]),
  );
}

function verdict(primary: ReturnType<typeof run>, secondary: ReturnType<typeof run>): string {
  const primaryDelta = primary.length_controlled_alienness.auc === null || primary.length.auc === null
    ? null
    : primary.length_controlled_alienness.auc - primary.length.auc;
  const secondaryDelta = secondary.length_controlled_alienness.auc === null || secondary.length.auc === null
    ? null
    : secondary.length_controlled_alienness.auc - secondary.length.auc;
  if (primaryDelta === null || secondaryDelta === null) return "unstable";
  return primaryDelta >= 0.05 && secondaryDelta >= 0.05 ? "incremental_signal" : primaryDelta <= 0.05 && secondaryDelta <= 0.05 ? "no_incremental_signal" : "unstable";
}

function selfTest() {
  const rows = [
    { case_id: "a", cell_key: "a1", claim_content_words: 12, cell_reject: 0 as Label, features: { unattested_trigram_share: 0.1 } },
    { case_id: "b", cell_key: "b1", claim_content_words: 24, cell_reject: 1 as Label, features: { unattested_trigram_share: 0.9 } },
    { case_id: "c", cell_key: "c1", claim_content_words: 36, cell_reject: 0 as Label, features: { unattested_trigram_share: 0.2 } },
  ];
  const output = run(rows, "cell_reject");
  if (output.rows !== 3 || output.length.auc === null || output.alienness.auc === null || output.length_controlled_alienness.auc === null) throw new Error("self-test failed");
  console.log("self-test passed");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const matrix = flag("matrix", DEFAULT_MATRIX);
  const manifestPath = flag("manifest", DEFAULT_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
  if (!existsSync(matrix)) throw new Error(`matrix not found: ${matrix}`);
  const rows = readRows(matrix, manifest.sha256);
  const eligibleRows = rows.filter((row) => !row.lint_in_loop && (row.claim_content_words ?? 0) >= MIN_CONTENT_WORDS && Number.isFinite(row.features?.unattested_trigram_share));
  const primary = run(rows, "cell_reject");
  const secondary = run(rows, "c2_label");
  const result = {
    experiment: "legal-grounding-length-controlled-alienness",
    status: "exploratory",
    input: { matrix, manifest: manifestPath, sha256: manifest.sha256, rows: rows.length },
    protocol: { min_content_words: MIN_CONTENT_WORDS, alienness_threshold: ALIENNESS_THRESHOLD, bootstraps: BOOTSTRAPS, seed: SEED, folds: "leave-one-case-out", bootstrap_cluster: "cell", citator_used: false, model_calls: 0 },
    exclusions: { lint_in_loop: rows.filter((row) => row.lint_in_loop).length, eligible_rows: eligibleRows.length, excluded_rows: rows.length - eligibleRows.length },
    verdict: verdict(primary, secondary),
    interpretation: "A positive primary result does not survive if the propagated claim-label analysis is null or negative; checker-derived labels are not gold.",
    analyses: [
      { ...primary, strata: byStratum(rows, "cell_reject") },
      { ...secondary, strata: byStratum(rows, "c2_label") },
    ],
  };
  const out = flag("out", path.join(DEFAULT_DIR, `alienness-length-audit-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`));
  if (existsSync(out)) throw new Error(`refusing to overwrite: ${out}`);
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ out, ...result }, null, 2));
}

main();
