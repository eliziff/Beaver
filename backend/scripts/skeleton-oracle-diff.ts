/**
 * Fail-closed compatibility gate for Beaver's shipping A2AJ compiler.
 *
 * This file intentionally contains no structure detector or grammar. It only
 * loads reference rows and calls compileA2AJSourceDoc. Each nonempty provider
 * map entry must have one native block whose compiled-text slice is the exact
 * provider value; this check is independent of JSON key order. ALR rows are
 * compatibility baselines, not truth: complete-tuple additions and strict
 * interval refinements are reported, while losses and changed baseline tuples
 * fail. Independent reviewed-gold and false-positive sweeps decide whether
 * additive behavior is correct.
 *
 * Usage:
 *   npx tsx scripts/skeleton-oracle-diff.ts probe.jsonl
 *       [--csv report.csv]
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { compileA2AJSourceDoc } from "../src/lib/sourceDocA2AJ";

type Kind = "paragraph" | "page" | "section";
type Block = { label: string; start: number; end: number };
type ProbeRow = {
  sourceKind: "case" | "law";
  dataset: string;
  language: string;
  citation: string;
  alternateCitation: string;
  name: string;
  chars: number;
  sectionMap: Record<string, string> | null;
  referenceSource: "alr_compatibility";
  reference: Record<Kind, Block[]>;
  text: string;
};
type Outcome = "exact" | "additive" | "refined" | "lost" | "changed";
type Comparison = {
  outcome: Outcome;
  referenceCount: number;
  actualCount: number;
  referenceSummary: string;
  actualSummary: string;
  issues: string[];
};

function argument(name: string) {
  const position = process.argv.indexOf(`--${name}`);
  return position < 0 ? undefined : process.argv[position + 1];
}

function sameBlock(left: Block, right: Block) {
  return (
    left.label === right.label &&
    left.start === right.start &&
    left.end === right.end
  );
}

function same(left: Block[], right: Block[]) {
  return (
    left.length === right.length &&
    left.every((block, index) => sameBlock(block, right[index]))
  );
}

function summary(blocks: Block[]) {
  const render = ({ label, start, end }: Block) => `${label}@${start}:${end}`;
  if (blocks.length <= 8) return blocks.map(render).join(" ");
  return [
    ...blocks.slice(0, 3).map(render),
    `... ${blocks.length - 6} omitted ...`,
    ...blocks.slice(-3).map(render),
  ].join(" ");
}

function issueSummary(issues: string[]) {
  if (issues.length <= 12) return issues.join("; ");
  return `${issues.slice(0, 12).join("; ")}; ... ${issues.length - 12} more`;
}

function csv(value: string | number) {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function orderedSubsequence(reference: Block[], actual: Block[]) {
  if (!reference.length) return true;
  let position = 0;
  for (const block of actual) {
    if (sameBlock(reference[position], block)) position += 1;
    if (position === reference.length) return true;
  }
  return reference.length === 0;
}

function validIntervals(blocks: Block[]) {
  return blocks.every(
    (block, index) =>
      block.start < block.end &&
      (index === 0 || blocks[index - 1].end <= block.start),
  );
}

/**
 * A new locator may shorten an old block only by splitting that exact
 * interval. Every old label stays at the same start, and the resulting
 * same-kind blocks must tile the old half-open interval without a gap,
 * overlap, or overrun.
 */
function strictRefinement(reference: Block[], actual: Block[]) {
  if (
    actual.length <= reference.length ||
    !validIntervals(reference) ||
    !validIntervals(actual)
  ) {
    return false;
  }
  const occurrences = new Map<
    string,
    { block: Block; index: number } | null
  >();
  actual.forEach((block, index) => {
    occurrences.set(
      block.label,
      occurrences.has(block.label) ? null : { block, index },
    );
  });
  let position = 0;
  let split = false;
  for (const expected of reference) {
    while (
      position < actual.length &&
      actual[position].end <= expected.start
    ) {
      position += 1;
    }
    const retained = occurrences.get(expected.label);
    if (
      !retained ||
      retained.index !== position ||
      retained.block.start !== expected.start
    ) {
      return false;
    }
    let cursor = expected.start;
    let tiles = 0;
    while (
      position < actual.length &&
      actual[position].start < expected.end
    ) {
      const tile = actual[position];
      if (
        tile.start !== cursor ||
        tile.end <= tile.start ||
        tile.end > expected.end
      ) {
        return false;
      }
      cursor = tile.end;
      tiles += 1;
      position += 1;
    }
    if (cursor !== expected.end) return false;
    split ||= tiles > 1;
  }
  return split;
}

function difference(
  kind: Kind,
  reference: Block[],
  actual: Block[],
): Outcome {
  if (same(reference, actual)) return "exact";
  if (orderedSubsequence(reference, actual)) return "additive";
  const available = new Map<string, number>();
  for (const { label } of actual) {
    available.set(label, (available.get(label) ?? 0) + 1);
  }
  for (const { label } of reference) {
    const count = available.get(label) ?? 0;
    if (!count) return "lost";
    available.set(label, count - 1);
  }
  if (
    (kind === "paragraph" || kind === "section") &&
    strictRefinement(reference, actual)
  ) {
    return "refined";
  }
  return "changed";
}

function providerContract(row: ProbeRow): Comparison | null {
  const entries = Object.entries(row.sectionMap ?? {}).filter(
    ([key, value]) =>
      key.trim() &&
      value.trim() &&
      !/^\[blank\]$/iu.test(value.trim()),
  );
  if (!entries.length) return null;
  const issues: string[] = [];
  let exact = 0;
  for (const [key, value] of entries) {
    const doc = compileA2AJSourceDoc({
      citation: row.citation,
      alternateCitation: row.alternateCitation,
      dataset: row.dataset,
      name: row.name,
      docType: "laws",
      text: value,
      sectionMap: { [key]: value },
    });
    const expectedLabel = `sec${key.trim()}`;
    const blocks = doc.blocks.filter(
      (block) => block.kind === "section" && !block.parentLabel,
    );
    const block = blocks[0];
    const entryIssues: string[] = [];
    if (doc.text !== value) entryIssues.push("text bytes changed");
    if (blocks.length !== 1) {
      entryIssues.push(`${blocks.length} top-level blocks`);
    } else {
      if (block.label !== expectedLabel) {
        entryIssues.push(`label=${block.label}`);
      }
      if (block.origin !== "native") {
        entryIssues.push(`origin=${block.origin}`);
      }
      if (block.start !== 0 || block.end !== value.length) {
        entryIssues.push(`bounds=${block.start}:${block.end}`);
      }
    }
    if (entryIssues.length) {
      issues.push(`${expectedLabel}: ${entryIssues.join(", ")}`);
    } else {
      exact += 1;
    }
  }
  return {
    outcome: issues.length ? "changed" : "exact",
    referenceCount: entries.length,
    actualCount: exact,
    referenceSummary: `${entries.length} singleton provider renditions`,
    actualSummary: `${exact}/${entries.length} byte-and-block exact`,
    issues,
  };
}

async function main() {
  const probePath = process.argv[2];
  if (!probePath || probePath.startsWith("--")) {
    console.error(
      "usage: skeleton-oracle-diff.ts probe.jsonl " +
        "[--csv report.csv]",
    );
    process.exit(2);
  }
  const csvPath = argument("csv");
  const outcomes = new Map<string, Record<Outcome, number>>();
  const failures: string[] = [];
  const csvRows = [
    "dataset,language,kind,reference_source,outcome,reference_count,actual_count,reference,actual,issues",
  ];
  let texts = 0;
  let comparisons = 0;
  const recordComparison = (
    row: ProbeRow,
    kind: Kind,
    referenceSource: "alr_compatibility" | "provider_section_map",
    comparison: Comparison,
  ) => {
    comparisons += 1;
    const { outcome } = comparison;
    const key = `${referenceSource}\t${row.dataset}`;
    const bucket = outcomes.get(key) ?? {
      exact: 0,
      additive: 0,
      refined: 0,
      lost: 0,
      changed: 0,
    };
    bucket[outcome] += 1;
    outcomes.set(key, bucket);
    const detail =
      `${row.dataset}/${row.language}/${kind}/${referenceSource}: ${outcome}; ` +
      `reference=[${comparison.referenceSummary}] ` +
      `actual=[${comparison.actualSummary}]` +
      (comparison.issues.length
        ? ` issues=[${issueSummary(comparison.issues)}]`
        : "");
    const failed =
      referenceSource === "provider_section_map"
        ? outcome !== "exact"
        : outcome === "lost" || outcome === "changed";
    if (failed) failures.push(detail);
    csvRows.push(
      [
        row.dataset,
        row.language,
        kind,
        referenceSource,
        outcome,
        comparison.referenceCount,
        comparison.actualCount,
        comparison.referenceSummary,
        comparison.actualSummary,
        comparison.issues.join("; "),
      ].map(csv).join(","),
    );
  };

  const lines = createInterface({
    input: createReadStream(probePath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ProbeRow;
    if (
      (row.sourceKind !== "case" && row.sourceKind !== "law") ||
      row.referenceSource !== "alr_compatibility" ||
      (row.sectionMap !== null &&
        (row.sourceKind !== "law" ||
          Array.isArray(row.sectionMap) ||
          Object.values(row.sectionMap).some(
            (value) => typeof value !== "string",
          ))) ||
      row.chars !== row.text.length
    ) {
      throw new Error("invalid SourceDoc compatibility row");
    }
    texts += 1;
    const doc = compileA2AJSourceDoc({
      citation: row.citation,
      alternateCitation: row.alternateCitation,
      dataset: row.dataset,
      name: row.name,
      docType: row.sourceKind === "case" ? "cases" : "laws",
      text: row.text,
    });
    const kinds: Kind[] =
      row.sourceKind === "case" ? ["paragraph", "page"] : ["section"];
    for (const kind of kinds) {
      const reference = row.reference[kind] ?? [];
      const actual = doc.blocks
        .filter((block) => block.kind === kind && !block.parentLabel)
        .map(({ label, start, end }) => ({ label, start, end }));
      recordComparison(row, kind, "alr_compatibility", {
        outcome: difference(kind, reference, actual),
        referenceCount: reference.length,
        actualCount: actual.length,
        referenceSummary: summary(reference),
        actualSummary: summary(actual),
        issues: [],
      });
    }
    const provider = row.sourceKind === "law" ? providerContract(row) : null;
    if (provider) {
      recordComparison(row, "section", "provider_section_map", provider);
    }
  }

  console.log(
    "reference_source\tdataset\texact\tadditive\trefined\tlost\tchanged",
  );
  const totals = new Map<string, Record<Outcome, number>>();
  for (const [key, bucket] of [...outcomes].sort()) {
    const [referenceSource, dataset] = key.split("\t");
    console.log(
      `${referenceSource}\t${dataset}\t${bucket.exact}\t${bucket.additive}\t${bucket.refined}\t${bucket.lost}\t${bucket.changed}`,
    );
    const total = totals.get(referenceSource) ?? {
      exact: 0,
      additive: 0,
      refined: 0,
      lost: 0,
      changed: 0,
    };
    total.exact += bucket.exact;
    total.additive += bucket.additive;
    total.refined += bucket.refined;
    total.lost += bucket.lost;
    total.changed += bucket.changed;
    totals.set(referenceSource, total);
  }
  for (const [referenceSource, total] of [...totals].sort()) {
    console.log(
      `TOTAL\t${referenceSource}\t${total.exact}\t${total.additive}\t${total.refined}\t${total.lost}\t${total.changed}`,
    );
  }
  console.log(`${texts} texts; ${comparisons} structure comparisons`);
  for (const failure of failures.slice(0, 20)) console.error(`DIFF ${failure}`);
  if (failures.length > 20) console.error(`... ${failures.length - 20} more`);
  if (csvPath) {
    writeFileSync(csvPath, `${csvRows.join("\n")}\n`, "utf8");
    console.log(`wrote ${csvPath}`);
  }
  if (failures.length) {
    const total = [...totals.values()].reduce(
      (sum, bucket) => ({
        exact: sum.exact + bucket.exact,
        additive: sum.additive + bucket.additive,
        refined: sum.refined + bucket.refined,
        lost: sum.lost + bucket.lost,
        changed: sum.changed + bucket.changed,
      }),
      { exact: 0, additive: 0, refined: 0, lost: 0, changed: 0 },
    );
    console.error(
      `${total.additive} additive gain(s), ${total.refined} strict refinement(s), ` +
        `${total.lost} loss(es), ` +
        `${total.changed} changed result(s); ${failures.length} policy failure(s)`,
    );
    process.exit(1);
  }
  const accepted = [...totals.values()].reduce(
    (sum, bucket) => ({
      additive: sum.additive + bucket.additive,
      refined: sum.refined + bucket.refined,
    }),
    { additive: 0, refined: 0 },
  );
  console.log(
    `${accepted.additive} additive result(s); ` +
      `${accepted.refined} strict refinement(s)`,
  );
  console.log("shipping compileA2AJSourceDoc passes reference compatibility");
}

void main();
