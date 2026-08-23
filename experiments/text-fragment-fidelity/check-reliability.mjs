import fs from "node:fs";
import path from "node:path";
import { buildLegalSourcePinpointUrl } from "./builder-candidate.ts";

const here = import.meta.dirname;
const seeds = fs.readFileSync(path.join(here, "results/scorecard.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l))
  .filter(r=>r.truth==="quote-present-unpainted" && r.signals.includes("cross-block-seam"));

const seedsRaw = new Map(
  fs.readFileSync(path.join(here, "results/seeds.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
    .map(s=>[s.label, s])
);

let wouldEmit = 0;
let noFragment = 0;
for (const row of seeds) {
  const seed = seedsRaw.get(row.label);
  if (!seed) continue;
  // seeds.jsonl has blockText/quote? Check shape: seeds have `blockText` and `quote` fields?
  const blockText = seed.blockText ?? seed.text ?? "";
  const quote = seed.quote ?? row.quote ?? "";
  const docText = seed.documentText ?? blockText;
  const url = seed.url ?? row.host;
  // Build with current builder
  const result = buildLegalSourcePinpointUrl(
    { url: seed.url, anchor: seed.anchor ?? row.directives?.[0]?.split("#")[1]?.split(":")[0] ?? "par1", blockText, documentText: docText },
    [quote]
  );
  const hasFragment = result && result.includes(":~:text=");
  if (hasFragment) wouldEmit++; else noFragment++;
}
console.log(`seam gaps: ${seeds.length}, would still emit fragment: ${wouldEmit}, now anchor-only: ${noFragment}`);
console.log(`0 non-reliable for seam? ${wouldEmit===0 ? "YES" : "NO — still emits"}`);
