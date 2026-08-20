/**
 * Measurement probe for conflictScan: run it over plain-text files and
 * print anchors, findings, and abstentions. Usage:
 *   npx tsx scripts/probe-conflict-scan.ts <file> [<file> ...]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { conflictScan } from "../experiments/deterministic-library-analysis/legalConflictScan";
import { extractAnchors } from "../experiments/deterministic-library-analysis/legalTextAnchors";

async function main() {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error("usage: probe-conflict-scan.ts <file> [<file> ...]");
    process.exit(2);
  }

  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const name = basename(path);
    const areas = extractAnchors(text).filter((hit) => hit.cls === "area");
    console.log(`\n=== ${name} (${text.length} chars, ${areas.length} area anchors)`);
    for (const hit of areas.slice(0, 40)) {
      console.log(`  ${hit.norm.padEnd(24)} «${hit.raw}»`);
    }
    const report = await conflictScan([{ name, text }]);
    console.log(
      `checks: pw=${report.checks.percent_of_whole} sp=${report.checks.sum_of_parts}` +
        ` consistent=${report.consistent} findings=${report.findings.length}` +
        ` anchors=${report.anchors_examined}`,
    );
    for (const finding of report.findings) {
      console.log(`  [${finding.kind}|${finding.unit}|${finding.scope}] ${finding.detail}`);
      if (finding.part) console.log(`    part:  ${finding.part.excerpt}`);
      if (finding.whole) console.log(`    whole: ${finding.whole.excerpt}`);
    }
    for (const abstention of report.abstentions) {
      console.log(`  abstain(${abstention.reason}) ×${abstention.count}: ${abstention.detail}`);
    }
  }
}

void main();
