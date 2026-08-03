/**
 * Probe for the H2 deadline working-back omission organ (plan §4 H2).
 *
 * Source-side only (no draft needed). General mechanism (not benchmark-specific):
 * a source states a calendar relationship "trigger X [units] before/after/within
 * [anchor calendar date]" — consent windows, notice periods, repurchase
 * deadlines, filing deadlines, lease option deadlines — from which a resolved
 * deadline follows deterministically (anchor −/+ duration). This script counts
 * how often that relationship is stated across two vendored LAB tasks, how many
 * resolve deterministically, and how many are refused (unstated anchor,
 * ambiguous base, calendar-dependent units) — a measure-first probe like
 * cof-omission-probe.ts, not a deliverable.
 *
 * Run: npx tsx scripts/deadline-omission-probe.ts (from backend/)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadZip } from "../src/lib/zip";
import { detectDeadlineRelationships } from "../src/lib/legalDeadlineOmissionScan";

const TASKS = [
  "C:/Users/elias/Desktop/MikeOSS Fork/benchmarks/harvey-labs/tasks/corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts",
  "C:/Users/elias/Desktop/MikeOSS Fork/benchmarks/harvey-labs/tasks/tax/draft-transfer-pricing-documentation",
];

/** Minimal docx body → plain text (paragraphs + table cells on lines). */
async function docxToText(bytes: Buffer): Promise<string> {
  const zip = await loadZip(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) return "";
  const xml = await entry.async("text");
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ");
}

function refusalSummary(refusals: Map<string, number>): string {
  if (!refusals.size) return "(none)";
  return [...refusals.entries()].map(([reason, count]) => `${reason}:${count}`).join("  ");
}

async function scanTask(taskDir: string): Promise<void> {
  const docsDir = path.join(taskDir, "documents");
  let files: string[];
  try {
    files = readdirSync(docsDir);
  } catch {
    console.log(`\n=== ${taskDir}\n  (no documents/)`);
    return;
  }
  const docx = files.filter((f) => f.endsWith(".docx")).sort();

  let resolved = 0;
  let filesWithRelationships = 0;
  const refusals = new Map<string, number>();
  const samples: string[] = [];

  for (const file of docx) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(docsDir, file));
    } catch {
      continue;
    }
    const text = await docxToText(bytes);
    if (!text.trim().length) continue;
    const result = detectDeadlineRelationships({ name: file, text });
    resolved += result.relationships.length;
    if (result.relationships.length > 0) filesWithRelationships += 1;
    for (const refusal of result.refusals) {
      refusals.set(refusal.reason, (refusals.get(refusal.reason) ?? 0) + refusal.count);
    }
    for (const rel of result.relationships) {
      if (samples.length < 10) {
        samples.push(
          `${file}:\n    ${rel.detail}${rel.bound ? "  [no later than]" : ""}`,
        );
      }
    }
  }

  const refusedTotal = [...refusals.values()].reduce((a, b) => a + b, 0);
  console.log(`\n=== ${path.basename(taskDir)}`);
  console.log(
    `  docs: ${docx.length}   relationships found: ${resolved + refusedTotal}` +
      `   resolved: ${resolved}   refused: ${refusedTotal}`,
  );
  console.log(`  files carrying a resolved relationship: ${filesWithRelationships}`);
  console.log(`  refused by reason: ${refusalSummary(refusals)}`);
  if (samples.length) {
    console.log(`  sample of ${samples.length} resolved relationships:`);
    for (const s of samples) console.log(`    ${s}`);
  } else {
    console.log("  (no resolvable deadline relationships found)");
  }
}

async function main(): Promise<void> {
  for (const task of TASKS) await scanTask(task);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
