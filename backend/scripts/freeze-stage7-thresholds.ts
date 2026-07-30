/**
 * Stage 7 threshold freeze (docs/legal-grounding-experiments-2026-07-30.md,
 * Frozen Hypothesis 7).
 *
 * Pre-registered procedure: operating points are frozen BEFORE the run
 * at values that flag ZERO grounded max-pooled responses in the RegLab
 * validation set (expert labels, US-index features archived by
 * validate-reglab-source-anchored.ts). Max-pooling means a response is
 * flagged when ANY member claim exceeds the threshold, so the zero-flag
 * point per feature is the maximum claim-level value observed across
 * grounded responses — computed here with the shipped lint's own
 * content-word definition for the minimum-length applicability gate
 * (claims below it are citation fragments produced by sentence
 * segmentation, not composable claims; the gate is part of the frozen
 * operating point).
 *
 * Read-only over the archive; prints the freeze block to paste into the
 * experiment log. Zero model calls.
 *
 *   npx tsx scripts/freeze-stage7-thresholds.ts [--min-content-words 12]
 */
import fs from "node:fs";
import path from "node:path";

import { contentWordCount } from "../src/lib/legalClaimLint";

const LOCAL =
  process.env.LOCALAPPDATA ??
  path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
const BASE = path.join(LOCAL, "OpenLegalData", "misgrounding-corpus");

function readJsonl(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const flagIndex = process.argv.indexOf("--min-content-words");
const minContent = flagIndex >= 0 ? Number(process.argv[flagIndex + 1]) : 12;
if (!Number.isInteger(minContent) || minContent < 0)
  throw new Error("--min-content-words must be a non-negative integer");

const features = readJsonl(path.join(BASE, "us_sources", "claim_features.jsonl"));
const claimText = new Map(
  readJsonl(path.join(BASE, "reglab_claims.jsonl")).map((row) => [
    `${row.row_key}:${row.sentence_index}`,
    row.claim as string,
  ]),
);

const eligible = features.filter(
  (row) =>
    contentWordCount(
      claimText.get(`${row.row_key}:${row.sentence_index}`) ?? "",
    ) >= minContent,
);

const responses = new Map<string, { label: string; rows: any[] }>();
for (const row of eligible) {
  const entry = responses.get(row.row_key) ?? { label: row.label, rows: [] };
  entry.rows.push(row);
  responses.set(row.row_key, entry);
}

console.log(
  `claims ${features.length} -> eligible ${eligible.length} at >=${minContent} ` +
    `lint content words; responses with eligible claims: ${responses.size}`,
);
for (const name of [
  "novel_content_fraction",
  "unattested_trigram_share",
  "prompt_only_share",
]) {
  const grounded = eligible
    .filter((row) => row.label === "grounded")
    .map((row) => row.features[name])
    .filter((value: number | undefined): value is number => value !== undefined);
  const threshold = Math.max(...grounded);
  const flagRate = (label: string) => {
    const pool = [...responses.values()].filter(
      (entry) => entry.label === label,
    );
    const flagged = pool.filter((entry) =>
      entry.rows.some((row: any) => (row.features[name] ?? -1) > threshold),
    ).length;
    return `${flagged}/${pool.length}`;
  };
  console.log(
    `${name.padEnd(28)} t=${threshold.toFixed(6)}  ` +
      `grounded ${flagRate("grounded")}  misgrounded ${flagRate(
        "misgrounded",
      )}  ungrounded ${flagRate("ungrounded")}`,
  );
}
