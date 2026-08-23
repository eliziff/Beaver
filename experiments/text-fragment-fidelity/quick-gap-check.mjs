import fs from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";
import { pageTextOf, tolerantPattern } from "./gap-lib.mjs";

const score = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.json"),"utf8"));
console.log("prev gaps", score.gapSignals);
const rows = fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.truth==="quote-present-unpainted");
const seeds = new Map(fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).map(s=>[s.label,s]));
let wouldPaint=0, stillGap=0;
for (const r of rows) {
  const s = seeds.get(r.label);
  if (!s) { stillGap++; continue; }
  const url = buildLegalSourcePinpointUrl({ url: s.url, anchor: s.anchor, blockText: s.blockText, documentText: s.blockText }, s.quotes);
  if (!url || !url.includes(":~:text=")) { stillGap++; continue; }
  const frags = url.split(":~:text=")[1].split("&text=").map(f=>{try{return decodeURIComponent(f)}catch{return f}});
  const fake = { target: url };
  const page = pageTextOf(fake);
  if (!page || page.cacheMiss) { stillGap++; continue; }
  const paints = frags.some(f=> {
    const parts=f.split(",");
    return parts.every(p=> tolerantPattern(p).test(page.raw));
  });
  if (paints) wouldPaint++; else stillGap++;
}
console.log(`offline: would paint ${wouldPaint}/${rows.length}, still gap ${stillGap} (${(wouldPaint/rows.length*100).toFixed(1)}% of gaps closed)`);
console.log(`projected painted ${2017+wouldPaint} / 2371 = ${((2017+wouldPaint)/2371*100).toFixed(1)}%`);
