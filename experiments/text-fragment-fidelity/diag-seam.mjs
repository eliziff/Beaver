import fs from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";

const score = fs.readFileSync(path.join(import.meta.dirname, "results/scorecard.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l))
  .filter(r=>r.truth==="quote-present-unpainted" && r.signals.includes("cross-block-seam"))
  .slice(0,3);

const seeds = new Map(
  fs.readFileSync(path.join(import.meta.dirname, "results/seeds.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
    .map(s=>[s.label, s])
);

for (const row of score) {
  const seed = seeds.get(row.label);
  console.log("\n===", row.label, row.host);
  const seedQuote = seed?.quotes?.[0] ?? "";
  console.log("quote:", JSON.stringify(seedQuote.slice(0,120)));
  console.log("directives tried:", row.directives.slice(0,2).map(d=>JSON.stringify(d.slice(0,80))));
  if (!seed) { console.log("no seed"); continue; }
  const url = buildLegalSourcePinpointUrl(
    { url: seed.url, anchor: seed.anchor ?? "par1", blockText: seed.blockText ?? "", documentText: seed.blockText ?? "" },
    [seedQuote]
  );
  console.log("built:", url ? url.split(":~:")[1]?.slice(0,120) : "no fragment");
  // Check why range failed: look at block text for \n
  const bt = seed.blockText ?? "";
  console.log("block has \\n:", bt.includes("\n"), "len", bt.length, "words", bt.split(/\s+/).length);
  console.log("block snippet:", JSON.stringify(bt.slice(0,200)));
}
