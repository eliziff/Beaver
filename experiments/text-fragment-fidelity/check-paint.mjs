import fs from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";
import { pageTextOf, tolerantPattern } from "./gap-lib.mjs";

const score = fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l))
  .filter(r=>r.truth==="quote-present-unpainted" && r.signals.includes("cross-block-seam"))
  .slice(0,5);

const seeds = new Map(
  fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
    .map(s=>[s.label, s])
);

// Minimal gateResults mock for pageTextOf: it needs gateRow.target
function fakeGateRow(seed, url) {
  return { target: url };
}

for (const row of score) {
  const seed = seeds.get(row.label);
  const quote = seed?.quotes?.[0] ?? "";
  const url = buildLegalSourcePinpointUrl(
    { url: seed.url, anchor: seed.anchor, blockText: seed.blockText, documentText: seed.blockText },
    [quote]
  );
  const rawFrags = url?.split(":~:text=")[1]?.split("&text=") ?? [];
  const decodedFrags = rawFrags.map(f=>{try{return decodeURIComponent(f)}catch{return f}});
  // Get cached page text
  const gateRow = fakeGateRow(seed, url);
  const page = pageTextOf(gateRow);
  let present = false;
  let matchedFrag = null;
  for (const df of decodedFrags) {
    // For range directives, split on comma into start/end and check both
    const parts = df.split(",");
    const partPresent = parts.every(p=> page && !page.cacheMiss && tolerantPattern(p).test(page.raw));
    if (partPresent) { present = true; matchedFrag = df; break; }
  }
  console.log(row.label, "frags:", decodedFrags.length, "presentOnPage:", present, "firstFrag:", JSON.stringify(decodedFrags[0]?.slice(0,70)));
  if (present) console.log("  matched frag:", JSON.stringify(matchedFrag?.slice(0,120)));
  else if (page && !page.cacheMiss) {
    // Show why first frag fails: find near miss
    const first = decodedFrags[0] ?? "";
    const pat = tolerantPattern(first.split(",")[0] ?? first);
    const idx = page.raw.search(pat);
    console.log("  first part search:", idx>=0?"found part":"not found", "page snippet:", JSON.stringify(page.raw.slice(0,200).replace(/\s+/g," ").slice(0,120)));
  }
}
