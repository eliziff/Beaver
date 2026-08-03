/**
 * Real-data probe for the H3 undefined defined-term organ.
 *
 * Runs `undefinedTermScan` over the vendored indenture task — the grounded
 * draft against its source documents — and prints the honest measurement:
 * total candidates, how many fired, the exact fired terms, and a note on
 * whether the canonical validation term "Permitted Tax Distributions" (or any
 * analogous draft-only defined term) is among the findings.
 *
 * Measure-first (repo doctrine): if nothing fires, that is the answer — the
 * point is to measure, not to force a finding.
 *
 * Run: npx tsx scripts/undefined-term-probe.ts (from backend/)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadZip } from "../src/lib/zip";
import {
  undefinedTermScan,
  undefinedTermScanStats,
  type UndefinedTermDocument,
} from "../src/lib/legalUndefinedTermScan";

const REPO = "C:/Users/elias/Desktop/MikeOSS Fork";
const LAB = path.join(REPO, "benchmarks/harvey-labs");
const TASK = path.join(
  LAB,
  "tasks/capital-markets/draft-indenture-for-senior-secured-notes-offering",
);
const DRAFT_DIR = path.join(
  LAB,
  "results/2026-08-03-grounded-cache-v3--capital-markets--draft-indenture-for-senior-secured-notes-offering--grounded_structure_v1/output",
);

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

async function loadTaskSources(): Promise<UndefinedTermDocument[]> {
  const docsDir = path.join(TASK, "documents");
  const docs: UndefinedTermDocument[] = [];
  for (const file of readdirSync(docsDir).filter((f) => f.endsWith(".docx")).sort()) {
    try {
      const bytes = readFileSync(path.join(docsDir, file));
      const text = await docxToText(bytes);
      if (text.trim().length > 0) docs.push({ name: file, text });
    } catch (error) {
      console.warn(`  (unreadable docx, skipped: ${file} — ${(error as Error).message})`);
    }
  }
  return docs;
}

async function loadDraft(): Promise<UndefinedTermDocument | null> {
  const draftPath = path.join(DRAFT_DIR, "indenture-draft.docx");
  try {
    const text = await docxToText(readFileSync(draftPath));
    if (!text.trim()) return null;
    return { name: "indenture-draft.docx", text };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sources = await loadTaskSources();
  const draft = await loadDraft();
  console.log("=== undefined-term probe: indenture task (grounded-cache v3) ===\n");
  console.log(`sources (docx): ${sources.length}`);
  for (const source of sources) console.log(`  - ${source.name}`);
  if (!draft) {
    console.log("\nNo draft found at " + DRAFT_DIR);
    return;
  }
  console.log(`draft: ${draft.name}`);

  const stats = undefinedTermScanStats(sources, draft);
  console.log("\n--- candidate funnel ---");
  console.log(`  defined terms across sources + draft: ${stats.definedTerms}`);
  console.log(`  total capitalized phrase candidates:  ${stats.candidates}`);
  console.log(`  total candidate occurrences:          ${stats.occurrences}`);
  console.log(`  quoted-only mentions (markup boundary): ${stats.quotedOnly}`);

  const findings = undefinedTermScan(sources, draft);
  console.log("\n--- findings ---");
  console.log(`  fired: ${findings.length}`);
  for (const finding of findings) {
    console.log(`  - "${finding.term}"  (${finding.occurrences} unquoted use${finding.occurrences === 1 ? "" : "s"})`);
    console.log(`      ${finding.excerpt}`);
  }

  // The canonical validation example: is it fired, and if not, why?
  const canonical = "Permitted Tax Distributions";
  const firedCanonical = findings.some((f) => f.term === canonical);
  console.log("\n--- note on the validation term ---");
  if (firedCanonical) {
    console.log(`  "${canonical}" IS among the fired terms (draft-only, no source definition).`);
  } else {
    console.log(`  "${canonical}" is NOT fired.`);
    console.log("  It is defined in the source stack: term-sheet.docx contains (\"Permitted Tax Distributions\"),");
    console.log("  a parenthetical definition the organ picks up, so the draft's unquoted use is covered.");
    if (findings.length > 0) {
      console.log(`  The fired term${findings.length === 1 ? " is" : "s are"} ${findings.map((f) => `"${f.term}"`).join(", ")} — draft-only compounds with no source definition.`);
    } else {
      console.log("  Nothing fires: every capitalized phrase in the draft resolves to a definition,");
      console.log("  a quoted mention, a party/entity name, a jurisdiction, or a descriptive label.");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
