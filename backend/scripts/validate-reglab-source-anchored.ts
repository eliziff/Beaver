/**
 * Source-anchored validation of the lint features on RegLab expert labels.
 *
 * The jurisdiction-matched, claim-segmented re-test the research plan
 * gates on: claims from segment_reglab_claims.py are scored against the
 * TEXT OF THE CASES THEY THEMSELVES CITE (fetch_reglab_sources.py
 * cache), using the shipped lintLegalClaim — never re-implemented
 * ad-hoc. Reports:
 *
 *   0. citation resolution rate per expert label (a cited case that
 *      does not resolve is the cheapest source-anchored signal);
 *   1. claim-level AUC per feature, grounded vs misgrounded(+ungrounded)
 *      — weak labels (response-level labels applied to member claims),
 *      stated as such;
 *   2. response-level AUC via max- and mean-pooling over cited claims —
 *      the honest unit for expert labels.
 *
 * Per-claim feature rows are archived next to the source cache.
 *
 *   npx tsx scripts/validate-reglab-source-anchored.ts
 */
import fs from "node:fs";
import path from "node:path";

import { lintLegalClaim } from "../src/lib/legalClaimLint";

const LOCAL =
  process.env.LOCALAPPDATA ??
  path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
const BASE = path.join(LOCAL, "OpenLegalData", "misgrounding-corpus");
const CLAIMS = path.join(BASE, "reglab_claims.jsonl");
const CITATIONS = path.join(BASE, "us_sources", "citations.jsonl");
const OPINIONS = path.join(BASE, "us_sources", "opinions");
const OUT = path.join(BASE, "us_sources", "claim_features.jsonl");

type ClaimRow = {
  row_key: string;
  label: "grounded" | "misgrounded" | "ungrounded";
  question: string;
  claim: string;
  sentence_index: number;
  citations: string[];
  citation_inherited: boolean;
};

function readJsonl(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function auc(negative: number[], positive: number[]): number | null {
  if (!negative.length || !positive.length) return null;
  let wins = 0;
  let ties = 0;
  for (const a of negative)
    for (const b of positive) {
      if (b > a) wins += 1;
      else if (b === a) ties += 1;
    }
  return (wins + ties / 2) / (negative.length * positive.length);
}

function main() {
  const claims = readJsonl(CLAIMS) as ClaimRow[];
  const citationRows = readJsonl(CITATIONS);
  const clustersByCitation = new Map<string, number[]>();
  for (const row of citationRows) {
    clustersByCitation.set(
      row.citation,
      (row.cases ?? []).map((c: any) => c.cap_id),
    );
  }
  const opinionText = new Map<number, string>();
  for (const file of fs.readdirSync(OPINIONS)) {
    const data = JSON.parse(
      fs.readFileSync(path.join(OPINIONS, file), "utf8"),
    );
    const text = (data.opinions ?? [])
      .map((op: any) => op.text ?? "")
      .join("\n")
      .trim();
    if (text) opinionText.set(data.cap_id, text);
  }

  // 0. resolution + text coverage per label, at the citation-mention level
  const resolution: Record<string, { mentions: number; resolved: number; text: number }> =
    {};
  for (const claim of claims) {
    const bucket = (resolution[claim.label] ??= {
      mentions: 0,
      resolved: 0,
      text: 0,
    });
    for (const citation of claim.citations) {
      bucket.mentions += 1;
      const clusters = clustersByCitation.get(citation) ?? [];
      if (clusters.length) bucket.resolved += 1;
      if (clusters.some((id) => opinionText.has(id))) bucket.text += 1;
    }
  }
  console.log("citation resolution by expert label (mention level):");
  for (const [label, b] of Object.entries(resolution)) {
    console.log(
      `  ${label.padEnd(12)} mentions ${String(b.mentions).padStart(4)}  ` +
        `resolved ${((b.resolved / Math.max(1, b.mentions)) * 100).toFixed(1)}%  ` +
        `with text ${((b.text / Math.max(1, b.mentions)) * 100).toFixed(1)}%`,
    );
  }

  // score claims that have at least one cited source WITH text
  const featureRows: any[] = [];
  let skippedNoSource = 0;
  for (const claim of claims) {
    if (!claim.citations.length) continue;
    const spans = claim.citations
      .flatMap((citation) => clustersByCitation.get(citation) ?? [])
      .map((id) => opinionText.get(id))
      .filter((text): text is string => Boolean(text));
    if (!spans.length) {
      skippedNoSource += 1;
      continue;
    }
    const lint = lintLegalClaim({
      claim: claim.claim,
      spans,
      question: claim.question,
    });
    const features: Record<string, number> = {};
    for (const receipt of lint.receipts) features[receipt.feature] = receipt.value;
    featureRows.push({
      row_key: claim.row_key,
      label: claim.label,
      sentence_index: claim.sentence_index,
      citation_inherited: claim.citation_inherited,
      n_sources: spans.length,
      features,
    });
  }
  fs.writeFileSync(
    OUT,
    featureRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  console.log(
    `\nscored ${featureRows.length} cited claims ` +
      `(${skippedNoSource} skipped: no fetched source text) -> ${OUT}`,
  );

  const featureNames = [
    "novel_content_fraction",
    "novel_abstraction_terms",
    "novel_absolutes",
    "modality_upgrade",
    "entity_count",
    "prompt_only_share",
    "unattested_trigram_share",
    "prompt_alien_cooccurrence",
  ];

  const byLabel = (label: string) =>
    featureRows.filter((row) => row.label === label);
  const grounded = byLabel("grounded");
  const misgrounded = byLabel("misgrounded");
  const bad = featureRows.filter((row) => row.label !== "grounded");

  console.log(
    "\nclaim-level AUC (weak labels — response label applied to claims):",
  );
  console.log(
    `${"feature".padEnd(28)} ${"vs misg".padStart(8)} ${"vs bad".padStart(8)}`,
  );
  for (const name of featureNames) {
    const values = (rows: any[]) =>
      rows
        .map((row) => row.features[name])
        .filter((v: number | undefined): v is number => v !== undefined);
    const a1 = auc(values(grounded), values(misgrounded));
    const a2 = auc(values(grounded), values(bad));
    console.log(
      `${name.padEnd(28)} ${(a1 ?? NaN).toFixed(3).padStart(8)} ${(a2 ?? NaN)
        .toFixed(3)
        .padStart(8)}`,
    );
  }

  // response-level pooling — the unit the expert labels live at
  const responses = new Map<string, { label: string; rows: any[] }>();
  for (const row of featureRows) {
    const entry = responses.get(row.row_key) ?? { label: row.label, rows: [] };
    entry.rows.push(row);
    responses.set(row.row_key, entry);
  }
  console.log(
    `\nresponse-level AUC over ${responses.size} responses with scored claims:`,
  );
  console.log(
    `${"feature".padEnd(28)} ${"max/misg".padStart(9)} ${"max/bad".padStart(
      8,
    )} ${"mean/misg".padStart(10)} ${"mean/bad".padStart(9)}`,
  );
  for (const name of featureNames) {
    const pool = (aggregate: (vals: number[]) => number) => {
      const buckets: Record<string, number[]> = {
        grounded: [],
        misgrounded: [],
        bad: [],
      };
      for (const { label, rows } of responses.values()) {
        const vals = rows
          .map((row) => row.features[name])
          .filter((v: number | undefined): v is number => v !== undefined);
        if (!vals.length) continue;
        const pooled = aggregate(vals);
        if (label === "grounded") buckets.grounded.push(pooled);
        else {
          buckets.bad.push(pooled);
          if (label === "misgrounded") buckets.misgrounded.push(pooled);
        }
      }
      return buckets;
    };
    const maxPool = pool((vals) => Math.max(...vals));
    const meanPool = pool(
      (vals) => vals.reduce((sum, v) => sum + v, 0) / vals.length,
    );
    const fmt = (v: number | null) => (v ?? NaN).toFixed(3);
    console.log(
      `${name.padEnd(28)} ${fmt(
        auc(maxPool.grounded, maxPool.misgrounded),
      ).padStart(9)} ${fmt(auc(maxPool.grounded, maxPool.bad)).padStart(
        8,
      )} ${fmt(auc(meanPool.grounded, meanPool.misgrounded)).padStart(
        10,
      )} ${fmt(auc(meanPool.grounded, meanPool.bad)).padStart(9)}`,
    );
  }
}

main();
