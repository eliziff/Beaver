/**
 * Diff compileAgreementSkeleton's section detection against the corpus
 * oracle dump produced by skeleton-oracle-probe.py. Reports, per dataset
 * and overall, how often the skeleton sees the sections the corpus-proven
 * grammar sees. Label-level recall treats the oracle spine as gold.
 *
 * Usage: npx tsx backend/scripts/skeleton-oracle-diff.ts probe.jsonl [out.csv]
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";

interface ProbeRow {
  dataset: string;
  language: string;
  citation: string;
  name: string;
  chars: number;
  oracle: string[];
  text: string;
}

type Category =
  | "both_empty"
  | "match"
  | "ts_blind"
  | "ts_partial"
  | "ts_extra";

async function main() {
  const [probePath, csvPath] = process.argv.slice(2);
  if (!probePath) {
    console.error("usage: skeleton-oracle-diff.ts probe.jsonl [out.csv]");
    process.exit(1);
  }
  const byDataset = new Map<string, Record<Category, number>>();
  const totals: Record<Category, number> = {
    both_empty: 0,
    match: 0,
    ts_blind: 0,
    ts_partial: 0,
    ts_extra: 0,
  };
  let oracleLabels = 0;
  let recalledLabels = 0;
  const csvRows: string[] = [
    "dataset,language,citation,category,oracle_count,ts_count,missing,extra",
  ];

  const lines = createInterface({
    input: createReadStream(probePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ProbeRow;
    const skeleton = compileAgreementSkeleton(row.text, row.citation);
    const ts = skeleton.nodes
      .filter((node) => node.kind === "section")
      .map((node) => node.label.replace(/^sec/u, ""));
    const oracle = row.oracle;
    const tsSet = new Set(ts);
    const oracleSet = new Set(oracle);
    const missing = oracle.filter((label) => !tsSet.has(label));
    const extra = ts.filter((label) => !oracleSet.has(label));
    oracleLabels += oracleSet.size;
    recalledLabels += oracleSet.size - new Set(missing).size;

    let category: Category;
    if (!oracle.length && !ts.length) category = "both_empty";
    else if (!oracle.length) category = "ts_extra";
    else if (!ts.length) category = "ts_blind";
    else if (!missing.length && !extra.length) category = "match";
    else category = "ts_partial";

    totals[category] += 1;
    const bucket =
      byDataset.get(row.dataset) ??
      ({
        both_empty: 0,
        match: 0,
        ts_blind: 0,
        ts_partial: 0,
        ts_extra: 0,
      } satisfies Record<Category, number>);
    bucket[category] += 1;
    byDataset.set(row.dataset, bucket);
    csvRows.push(
      [
        row.dataset,
        row.language,
        JSON.stringify(row.citation),
        category,
        oracle.length,
        ts.length,
        JSON.stringify(missing.slice(0, 12).join(" ")),
        JSON.stringify(extra.slice(0, 12).join(" ")),
      ].join(","),
    );
  }

  const order: Category[] = [
    "match",
    "ts_partial",
    "ts_blind",
    "ts_extra",
    "both_empty",
  ];
  console.log(
    "dataset".padEnd(20) + order.map((c) => c.padStart(11)).join(""),
  );
  for (const [dataset, bucket] of [...byDataset.entries()].sort()) {
    console.log(
      dataset.padEnd(20) +
        order.map((c) => String(bucket[c]).padStart(11)).join(""),
    );
  }
  console.log(
    "TOTAL".padEnd(20) + order.map((c) => String(totals[c]).padStart(11)).join(""),
  );
  const denominator = oracleLabels || 1;
  console.log(
    `label-level recall vs oracle: ${recalledLabels}/${oracleLabels} ` +
      `(${((100 * recalledLabels) / denominator).toFixed(1)}%)`,
  );
  if (csvPath) {
    writeFileSync(csvPath, csvRows.join("\n") + "\n", "utf8");
    console.log(`wrote ${csvPath}`);
  }
}

void main();
