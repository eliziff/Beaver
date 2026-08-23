import fs from "node:fs";
import path from "node:path";
import { pageTextOf, tolerantPattern } from "./gap-lib.mjs";

const score = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.json"),"utf8"));
console.log("gapSignals", score.gapSignals);
const rows = fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.truth==="quote-present-unpainted" && r.signals.includes("other")).slice(0,3);
const seeds = new Map(fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).map(s=>[s.label,s]));
for (const r of rows) {
  const s = seeds.get(r.label);
  console.log("\n===", r.label, s.url);
  console.log("quote", JSON.stringify(s.quotes[0].slice(0,100)));
  console.log("directives", r.directives?.[0]?.slice(0,120));
  // Check page
  const fake = { target: r.directives?.[0] ? `https://example.com#:~:text=${encodeURIComponent(r.directives[0])}` : s.url };
  // Actually need real target from gate, but we have r.directives as built fragments, not full target
  // Use pageTextOf with a fake gate row that has target = s.url + "#:~:text=" + directive
  const target = s.url + "#:~:text=" + encodeURIComponent(s.quotes[0].slice(0,40));
  const page = pageTextOf({ target });
  console.log("page has quote?", page && !page.cacheMiss ? tolerantPattern(s.quotes[0].slice(0,40)).test(page.raw) : "miss");
}
