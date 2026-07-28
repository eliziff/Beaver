/**
 * Amendment-calculus parser eval against USLM gold.
 *
 * The US GPO publishes public laws with every amendment verb wrapped in
 * <amendingAction type="…"> and every quoted string in <quotedText> /
 * every quoted block in <quotedContent>. That is typed gold nobody had to
 * annotate. We flatten each law to its plain-text plane, run
 * parseAmendmentInstructions, and score:
 *   - quotedText recovery: exact-string recall of gold quoted strings
 *     among op.oldText / newText / anchorText
 *   - quotedContent recovery: onset (first 40 chars) of each quoted block
 *     found in some op.newText
 *   - op-kind counts vs gold action-type counts (calibration, not identity:
 *     one substitute_text op covers one delete + one insert action)
 *
 * Usage: npx tsx scripts/amend-ops-eval.ts <dir-of-USLM-xml> [maxFiles]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseAmendmentInstructions } from "../src/lib/legalAmendOps";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&[a-z]+;/gu, (entity) => ENTITIES[entity] ?? entity);
}

function stripTags(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<toc[\s\S]*?<\/toc>/gu, " ")
      .replace(/<\/(?:p|section|subsection|paragraph|subparagraph|clause|chapeau|content|heading|num)>/gu, "\n")
      .replace(/<[^>]+>/gu, ""),
  )
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n");
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

function main() {
  const [dir, maxArg] = process.argv.slice(2);
  if (!dir) {
    console.error("Usage: amend-ops-eval.ts <dir-of-USLM-xml> [maxFiles]");
    process.exit(2);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".xml"))
    .sort()
    .slice(0, maxArg ? Number(maxArg) : undefined);

  const goldTypes = new Map<string, number>();
  const opKinds = new Map<string, number>();
  const unparsedReasons = new Map<string, number>();
  let goldQuotes = 0;
  let goldQuotesRecovered = 0;
  let goldBlocks = 0;
  let goldBlocksRecovered = 0;
  let filesWithActions = 0;
  let totalOps = 0;
  let totalUnparsed = 0;
  const missSamples: string[] = [];

  for (const name of files) {
    const xml = readFileSync(join(dir, name), "utf-8");
    const actionTypes = [...xml.matchAll(/<amendingAction type="(\w+)"/gu)].map(
      (match) => match[1],
    );
    if (!actionTypes.length) continue;
    filesWithActions += 1;
    for (const type of actionTypes) {
      goldTypes.set(type, (goldTypes.get(type) ?? 0) + 1);
    }

    const quoted = [...xml.matchAll(/<quotedText[^>]*>([\s\S]*?)<\/quotedText>/gu)]
      .map((match) => squash(stripTags(match[1])))
      .filter(Boolean);
    const blocks = [...xml.matchAll(/<quotedContent[^>]*>([\s\S]*?)<\/quotedContent>/gu)]
      .map((match) => squash(stripTags(match[1])).slice(0, 40))
      .filter((onset) => onset.length >= 8);

    const plain = stripTags(xml);
    const parsed = parseAmendmentInstructions(plain);
    totalOps += parsed.ops.length;
    totalUnparsed += parsed.unparsed.length;
    for (const op of parsed.ops) {
      opKinds.set(op.kind, (opKinds.get(op.kind) ?? 0) + 1);
    }
    for (const entry of parsed.unparsed) {
      unparsedReasons.set(entry.reason, (unparsedReasons.get(entry.reason) ?? 0) + 1);
    }

    const extracted = new Set<string>();
    const extractedList: string[] = [];
    for (const op of parsed.ops) {
      for (const field of [op.oldText, op.newText, op.anchorText]) {
        if (field) {
          const value = squash(field);
          extracted.add(value);
          if (value.length >= 12) extractedList.push(value);
        }
      }
    }
    for (const quote of quoted) {
      goldQuotes += 1;
      // Exact field match, or nested inside a recovered block (quotes
      // inside inserted text are still quotedText in the gold markup).
      if (
        extracted.has(quote) ||
        extractedList.some((field) => field.includes(quote))
      ) {
        goldQuotesRecovered += 1;
      } else if (missSamples.length < 12) {
        missSamples.push(`${name}: “${quote.slice(0, 70)}”`);
      }
    }
    const dequote = (text: string) => text.replace(/[“”‘’]/gu, "");
    const newTexts = parsed.ops
      .map((op) => (op.newText ? dequote(squash(op.newText)) : ""))
      .filter(Boolean);
    for (const onset of blocks) {
      goldBlocks += 1;
      const needle = dequote(onset);
      if (newTexts.some((text) => text.includes(needle))) {
        goldBlocksRecovered += 1;
      }
    }
  }

  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "n/a");
  console.log(`files: ${files.length} scanned, ${filesWithActions} with amendingActions`);
  console.log(`gold action types: ${[...goldTypes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`our ops (${totalOps}): ${[...opKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`unparsed instructions: ${totalUnparsed}`);
  console.log(`quotedText recall: ${goldQuotesRecovered}/${goldQuotes} (${pct(goldQuotesRecovered, goldQuotes)}%)`);
  console.log(`quotedContent onset recall: ${goldBlocksRecovered}/${goldBlocks} (${pct(goldBlocksRecovered, goldBlocks)}%)`);
  console.log(`top unparsed reasons: ${[...unparsedReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join("; ")}`);
  if (missSamples.length) {
    console.log("\nsample missed quotes:");
    for (const sample of missSamples) console.log(`  ${sample}`);
  }
}

main();
