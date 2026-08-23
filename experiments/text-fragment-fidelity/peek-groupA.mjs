import fs from "node:fs";
import path from "node:path";

const resultsDir = path.join(import.meta.dirname, "results");
const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
};
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

const rows = readLines(path.join(resultsDir, "scorecard.jsonl")).map(parse).filter(Boolean);
const seeds = new Map(readLines(path.join(resultsDir, "seeds.jsonl")).map(parse).filter(Boolean).map((s) => [s.label, s]));
const gap = rows.filter((r) => r.truth === "quote-present-unpainted");
const groupA = gap.filter((r) => r.signals.includes("cross-block-seam"));

// Print first 25 group A with full details
for (const r of groupA.slice(0, 25)) {
  const seed = seeds.get(r.label);
  const quote = seed?.quotes?.[0] ?? "";
  console.log("=".repeat(100));
  console.log("LABEL:", r.label, "| host:", r.host, "| matchedWords:", r.matchedWords);
  console.log("QUOTE:", JSON.stringify(quote));
  console.log("DIRECTIVES:", JSON.stringify(r.directives));
  console.log("WINDOW:", JSON.stringify(r.window));
}
