/**
 * Calibration harness for legalClaimLint (research plan workstream C2).
 *
 * Reads archived experiment receipts (claim-level labels: supported
 * answers = accepted; single-claim rejected answers = rejected; probe
 * suites), runs the shipped lint against the installed alienness index,
 * and reports per-feature rank-AUC plus threshold sweeps. Read-only over
 * receipts; writes nothing but stdout. Labels are checker-derived, not
 * gold — this ranks features and picks provisional thresholds, it does
 * not certify them.
 *
 *   npx tsx scripts/calibrate-claim-lint.ts
 *   npx tsx scripts/calibrate-claim-lint.ts --receipts <dir> [--stage6 <file>]
 */
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { lintLegalClaim } from "../src/lib/legalClaimLint";

function flag(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const archive = flag(
  "receipts",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "OpenLegalData",
    "experiments",
    "legal-grounding",
    "2026-07-30",
  ),
);
const extra = flag(
  "stage6",
  path.join(os.tmpdir(), "beaver-legal-grounding", "stage6-h6.jsonl"),
);

type Sample = { label: "accepted" | "rejected"; values: Map<string, number> };

const samples: Sample[] = [];
const files = readdirSync(archive)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => path.join(archive, name));
try {
  readFileSync(extra);
  files.push(extra);
} catch {
  // stage file optional
}

for (const file of files) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const rec = row.legal_evidence_receipt ?? row.receipt;
    if (!rec) continue;
    const verdict = rec.verification?.holistic;
    if (!verdict || verdict === "not_run") continue;
    const claims = rec.claims ?? [];
    let label: Sample["label"];
    if (verdict === "supported") label = "accepted";
    else if (claims.length === 1) label = "rejected";
    else continue;
    const spans = new Map<string, string>(
      (rec.evidence ?? []).map((e: { evidence_id: string; span_text?: string }) => [
        e.evidence_id,
        e.span_text ?? "",
      ]),
    );
    for (const claim of claims) {
      if (claim.deterministic_support) continue;
      const spanTexts = claim.evidence_ids
        .map((id: string) => spans.get(id) ?? "")
        .filter(Boolean);
      if (!spanTexts.length || !claim.text?.trim()) continue;
      const result = lintLegalClaim({ claim: claim.text, spans: spanTexts });
      samples.push({
        label,
        values: new Map(
          result.receipts.map((receipt) => [receipt.feature, receipt.value]),
        ),
      });
    }
  }
}

const accepted = samples.filter((sample) => sample.label === "accepted");
const rejected = samples.filter((sample) => sample.label === "rejected");
console.log(
  `claims: ${samples.length} (accepted ${accepted.length}, rejected ${rejected.length})`,
);
const features = [...new Set(samples.flatMap((s) => [...s.values.keys()]))];
console.log(
  `${"feature".padEnd(26)} ${"acc mean".padStart(9)} ${"rej mean".padStart(9)} ${"AUC".padStart(6)}`,
);
for (const feature of features) {
  const a = accepted
    .map((s) => s.values.get(feature))
    .filter((v): v is number => v !== undefined);
  const b = rejected
    .map((s) => s.values.get(feature))
    .filter((v): v is number => v !== undefined);
  if (!a.length || !b.length) continue;
  let wins = 0;
  let ties = 0;
  for (const x of a) for (const y of b) {
    if (y > x) wins += 1;
    else if (y === x) ties += 1;
  }
  const auc = (wins + ties / 2) / (a.length * b.length);
  const mean = (values: number[]) =>
    values.reduce((total, value) => total + value, 0) / values.length;
  console.log(
    `${feature.padEnd(26)} ${mean(a).toFixed(3).padStart(9)} ${mean(b).toFixed(3).padStart(9)} ${auc.toFixed(3).padStart(6)}`,
  );
}

// Threshold sweep for the two headline features.
for (const feature of ["unattested_trigram_share", "novel_content_fraction"]) {
  console.log(`\nthreshold sweep — ${feature} (flag = value > t)`);
  console.log("t     flag-rate(rej)  flag-rate(acc)");
  for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    const rate = (group: Sample[]) => {
      const values = group
        .map((s) => s.values.get(feature))
        .filter((v): v is number => v !== undefined);
      return values.length
        ? values.filter((v) => v > t).length / values.length
        : 0;
    };
    console.log(
      `${t.toFixed(2)}  ${rate(rejected).toFixed(3).padStart(13)} ${rate(accepted).toFixed(3).padStart(15)}`,
    );
  }
}
