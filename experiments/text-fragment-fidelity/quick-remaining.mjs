import fs from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";
import { pageTextOf, tolerantPattern } from "./gap-lib.mjs";

const rows = fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.truth==="quote-present-unpainted");
const seeds = new Map(fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).map(s=>[s.label,s]));
const remaining = [];
for (const r of rows) {
  const s = seeds.get(r.label);
  const url = buildLegalSourcePinpointUrl({ url: s.url, anchor: s.anchor, blockText: s.blockText, documentText: s.blockText }, s.quotes);
  const frags = url?.split(":~:text=")[1]?.split("&text=").map(f=>{try{return decodeURIComponent(f)}catch{return f}}) ?? [];
  const page = pageTextOf({ target: url });
  const paints = frags.some(f=> f.split(",").every(p=> page && !page.cacheMiss && tolerantPattern(p).test(page.raw)));
  if (!paints) remaining.push(r);
}
const hostCount={};
for(const r of remaining) hostCount[r.host]=(hostCount[r.host]??0)+1;
console.log("remaining", remaining.length, hostCount);
console.log(remaining.slice(0,3).map(r=> ({label:r.label, host:r.host, signals:r.signals })));
