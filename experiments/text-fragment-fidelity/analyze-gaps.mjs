import fs from "node:fs";
import path from "node:path";

const resultsDir = path.join(import.meta.dirname, "results");
const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
};
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

const rows = readLines(path.join(resultsDir, "scorecard.jsonl")).map(parse).filter(Boolean);
const gap = rows.filter((r) => r.truth === "quote-present-unpainted");

const groupA = gap.filter((r) => r.signals.includes("cross-block-seam"));
const groupB = gap.filter((r) => r.signals.includes("other") && !r.signals.includes("cross-block-seam"));
const otherGap = gap.filter((r) => !r.signals.includes("cross-block-seam") && !r.signals.includes("other"));

console.log("total rows:", rows.length);
console.log("gap (unpainted):", gap.length);
console.log("group A (cross-block-seam):", groupA.length);
console.log("group B (other):", groupB.length);
console.log("other gap (neither):", otherGap.length);
console.log("\n-- other gap signals breakdown --");
const sigCount = {};
for (const r of otherGap) {
  for (const s of r.signals) sigCount[s] = (sigCount[s] ?? 0) + 1;
}
console.log(JSON.stringify(sigCount, null, 1));

console.log("\n-- group A host breakdown --");
const hostA = {};
for (const r of groupA) hostA[r.host] = (hostA[r.host] ?? 0) + 1;
console.log(JSON.stringify(hostA, null, 1));

console.log("\n-- group B host breakdown --");
const hostB = {};
for (const r of groupB) hostB[r.host] = (hostB[r.host] ?? 0) + 1;
console.log(JSON.stringify(hostB, null, 1));
