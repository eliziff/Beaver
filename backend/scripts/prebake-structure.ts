/**
 * Pre-bake structure sidecars for the documents worth paying for once.
 *
 * The in-memory memo helps within a process. It does nothing for a cold start
 * on a laptop, and the documents where that hurts most are the ones a model
 * most needs to navigate rather than read: the Income Tax Act is 7.3 million
 * characters, and its cross-reference graph alone costs ~13.7 seconds to
 * build. Baked once, it is a file read.
 *
 * Usage:
 *   npx tsx scripts/prebake-structure.ts <laws.jsonl> [--match "<substring>"]...
 *
 * `laws.jsonl` is one {id, text} per line — `scripts/dump_a2aj_laws.py`
 * produces it from the local A2AJ corpus. With no `--match`, the LANDMARKS
 * below are baked; each `--match` is a case-insensitive substring tested
 * against the row id, so a jurisdiction or a single act can be named.
 *
 * Sidecars are content-addressed on the text, so a consolidation update
 * simply misses and re-bakes. There is no staleness to manage.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { bakeStructure } from "../src/lib/legalStructureSidecar";

/**
 * Statutes that are consulted constantly, are far too large to read, and
 * whose structure is therefore the only practical way in.
 */
const LANDMARKS = [
  "RSC 1985, c 1 (5th Supp)", // Income Tax Act
  "RSC 1985, c C-46", // Criminal Code
  "RSC 1985, c C-44", // Canada Business Corporations Act
  "RSC 1985, c B-3", // Bankruptcy and Insolvency Act
  "SC 2000, c 5", // PIPEDA
  "RSC 1985, c C-42", // Copyright Act
  "RSC 1985, c T-13", // Trademarks Act
  "SC 1985, c C-34", // Competition Act
];

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: prebake-structure.ts <laws.jsonl> [--match <sub>]...");
    process.exit(2);
  }
  const matches: string[] = [];
  for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--match" && process.argv[i + 1]) {
      matches.push(process.argv[i + 1].toLowerCase());
      i += 1;
    }
  }
  const wanted = matches.length ? matches : LANDMARKS.map((m) => m.toLowerCase());

  const reader = createInterface({
    input: createReadStream(input, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let scanned = 0;
  let baked = 0;
  let totalMs = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { id: string; text: string };
    scanned += 1;
    const id = row.id.toLowerCase();
    if (!wanted.some((needle) => id.includes(needle))) continue;
    // BOTH constructions, because the same statute arrives two ways. The
    // A2AJ lane compiles it with recovery off, since that feed kept its line
    // breaks. The same Act uploaded as a PDF is extraction output and gets
    // recovery on. They are different artifacts -- 45 of 23,531 statutes
    // compile differently -- so baking one leaves the other paying in full.
    const report = await bakeStructure(row.text, row.id, {
      recoverExtraction: false,
    });
    const recovered = await bakeStructure(row.text, row.id, {
      recoverExtraction: true,
    });
    baked += 1;
    totalMs += report.skeletonMs + report.graphMs;
    totalMs += recovered.skeletonMs + recovered.graphMs;
    console.log(
      `${report.id}\n  ${report.chars.toLocaleString()} chars  ` +
        `${report.nodes.toLocaleString()} nodes  ${report.edges.toLocaleString()} edges  ` +
        `skeleton ${Math.round(report.skeletonMs)}ms  graph ${Math.round(report.graphMs)}ms`,
    );
  }
  console.log(
    `\nscanned ${scanned.toLocaleString()}, baked ${baked}, ` +
      `${(totalMs / 1000).toFixed(1)}s of compute now on disk`,
  );
}

void main();
