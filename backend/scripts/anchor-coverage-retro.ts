/**
 * Retro-run the deterministic anchor-coverage report over completed run
 * artifacts (or any source/draft file sets). Zero model calls: this is the
 * measurement harness for backend/src/lib/legalTextAnchors.ts.
 *
 * Usage:
 *   npx tsx scripts/anchor-coverage-retro.ts \
 *     --sources <dir|file ...> --drafts <dir|file ...> [--max-rows N]
 *
 * Parsers are imported from their leaf modules (not documentOps) so the
 * script runs without server environment configuration.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import {
  anchorCoverage,
  type AnchorDocument,
} from "../src/lib/legalTextAnchors";
import { extractDocxBodyText } from "../src/lib/docxTrackedChanges";
import { extractPresentationText } from "../src/lib/officeText";
import { spreadsheetToLLMText } from "../src/lib/spreadsheet";

const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "md", "eml", "csv", "html", "htm"]);

async function extractText(path: string): Promise<string | null> {
  const extension = extname(path).slice(1).toLowerCase();
  const bytes = readFileSync(path);
  if (extension === "docx") {
    const body = await extractDocxBodyText(bytes);
    if (body) return body;
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  if (extension === "xlsx" || extension === "xls" || extension === "xlsm") {
    return spreadsheetToLLMText(bytes);
  }
  if (extension === "pptx") {
    return extractPresentationText(bytes);
  }
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    return bytes.toString("utf-8");
  }
  return null;
}

function expand(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isFile()) files.push(full);
      }
    } else {
      files.push(path);
    }
  }
  return files;
}

async function loadSide(paths: string[]) {
  const documents: AnchorDocument[] = [];
  const skipped: string[] = [];
  for (const file of expand(paths)) {
    const text = await extractText(file);
    if (text === null) skipped.push(basename(file));
    else documents.push({ name: basename(file), text });
  }
  return { documents, skipped };
}

function parseArgs(argv: string[]) {
  const sources: string[] = [];
  const drafts: string[] = [];
  let maxRows = 200;
  let bucket: string[] | null = null;
  for (const arg of argv) {
    if (arg === "--sources") bucket = sources;
    else if (arg === "--drafts") bucket = drafts;
    else if (arg === "--max-rows") bucket = null;
    else if (bucket) bucket.push(arg);
    else if (/^\d+$/u.test(arg)) maxRows = Number(arg);
  }
  return { sources, drafts, maxRows };
}

async function main() {
  const { sources, drafts, maxRows } = parseArgs(process.argv.slice(2));
  if (!sources.length || !drafts.length) {
    console.error("Usage: --sources <dir|file ...> --drafts <dir|file ...>");
    process.exit(2);
  }
  const sourceSide = await loadSide(sources);
  const draftSide = await loadSide(drafts);
  const report = anchorCoverage(sourceSide.documents, draftSide.documents, {
    maxRowsPerClass: maxRows,
  });

  console.log(`sources: ${report.source_documents.join(", ")}`);
  console.log(`drafts:  ${report.draft_documents.join(", ")}`);
  for (const side of [sourceSide, draftSide]) {
    if (side.skipped.length) console.log(`skipped: ${side.skipped.join(", ")}`);
  }
  console.log("\nclass     src-distinct draft-distinct matched src-only draft-only");
  for (const [cls, coverage] of Object.entries(report.classes)) {
    console.log(
      `${cls.padEnd(9)} ${String(coverage.source_distinct).padStart(12)} ` +
        `${String(coverage.draft_distinct).padStart(14)} ` +
        `${String(coverage.matched).padStart(7)} ` +
        `${String(coverage.source_only.length).padStart(8)} ` +
        `${String(coverage.draft_only.length).padStart(10)}`,
    );
  }
  for (const [cls, coverage] of Object.entries(report.classes)) {
    if (coverage.source_only.length) {
      console.log(`\n--- ${cls}: in sources, never in drafts ---`);
      for (const row of coverage.source_only) {
        console.log(
          `  ${row.display}  [${row.norm} x${row.count}]  ...${row.excerpt.slice(0, 110)}`,
        );
      }
      if (coverage.source_only_truncated) console.log("  (truncated)");
    }
  }
  for (const [cls, coverage] of Object.entries(report.classes)) {
    if (coverage.draft_only.length) {
      console.log(`\n=== ${cls}: in drafts, never in sources (grounding) ===`);
      for (const row of coverage.draft_only) {
        console.log(
          `  ${row.display}  [${row.norm} x${row.count}]  ...${row.excerpt.slice(0, 110)}`,
        );
      }
      if (coverage.draft_only_truncated) console.log("  (truncated)");
    }
  }
  const pairs = report.numeral_word_pairs;
  console.log(
    `\nwords-vs-numerals: ${pairs.checked} pairs checked, ${pairs.mismatches.length} mismatches`,
  );
  for (const mismatch of pairs.mismatches) {
    console.log(
      `  ${mismatch.document}: "${mismatch.phrase} (${mismatch.numeral})" words say ${mismatch.wordsValue} — ${mismatch.excerpt.slice(0, 90)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
