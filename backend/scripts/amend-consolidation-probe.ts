/**
 * End-to-end real-law probe for the amendment calculus.
 *
 * Feed it a real amending act (Annual Statutes text) plus the CURRENT
 * consolidated text of each target provision (from the local A2AJ bulk
 * corpus). Because the amendments are in force, today's consolidation IS
 * the gold consolidation: every compiled replace/add op's newText must
 * appear verbatim (glyph/whitespace-normalized) in the current law, and
 * every refusal must be a documented grammar scope limit, never a
 * misapplication.
 *
 * Usage:
 *   npx tsx scripts/amend-consolidation-probe.ts <amending.txt> \
 *     secN=<current-provision.txt> [...] [--expect-phrase "..."]
 */
import { readFileSync } from "node:fs";

import { parseAmendmentInstructions } from "../src/lib/legalAmendOps";

const normalize = (text: string) =>
  text
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"')
    // Corpus renderings flatten French superscript ordinals ("1^er
    // janvier"); the statute text writes "1er". Same glyph class.
    .replace(/\^/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

function main() {
  const args = process.argv.slice(2);
  const phraseAt = args.indexOf("--expect-phrase");
  const phrase = phraseAt !== -1 ? args[phraseAt + 1] : undefined;
  const positional = phraseAt !== -1 ? [...args.slice(0, phraseAt), ...args.slice(phraseAt + 2)] : args;
  const [amendingPath, ...mappings] = positional;
  if (!amendingPath || !mappings.length) {
    console.error("Usage: amend-consolidation-probe.ts <amending.txt> secN=<file> [...]");
    process.exit(2);
  }
  const amending = readFileSync(amendingPath, "utf-8");
  const targets = mappings.map((pair) => {
    const [label, path] = pair.split("=");
    return { label, text: readFileSync(path, "utf-8"), path };
  });

  const { ops, unparsed } = parseAmendmentInstructions(amending);
  console.log(`instructions: ${ops.length} ops compiled, ${unparsed.length} refused`);

  let verified = 0;
  let unverified = 0;
  for (const op of ops) {
    const home = targets.find((t) => op.target.startsWith(t.label));
    const line = `  op ${op.kind} @ ${op.target}`;
    if (!home) {
      console.log(`${line} — no current-text file supplied, skipped`);
      continue;
    }
    if (!op.newText) {
      console.log(`${line} — no newText (${op.kind}), nothing to verify`);
      continue;
    }
    const present = normalize(home.text).includes(normalize(op.newText));
    if (present) {
      verified += 1;
      console.log(`${line} — newText VERIFIED in current consolidation (${home.label})`);
    } else {
      unverified += 1;
      console.log(`${line} — newText NOT FOUND in current text (${home.label})`);
      console.log(`      block head: ${normalize(op.newText).slice(0, 110)}`);
    }
  }
  for (const refusal of unparsed) {
    console.log(`  refused: [${refusal.reason}] ${refusal.excerpt.slice(0, 100)}`);
  }
  console.log(
    `\nconsolidation agreement: ${verified}/${verified + unverified} op blocks present in today's law`,
  );
  if (phrase) {
    const hits = targets.filter((t) => normalize(t.text).includes(normalize(phrase)));
    console.log(
      `payload phrase present in ${hits.length}/${targets.length} target provisions ` +
        `(${hits.map((t) => t.label).join(", ")})`,
    );
  }
}

main();
