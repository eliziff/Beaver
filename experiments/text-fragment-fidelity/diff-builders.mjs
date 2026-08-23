import fs from "node:fs";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { buildLegalSourcePinpointUrl as buildProduction } from "file:///C:/Users/elias/Desktop/MikeOSS%20Fork/backend/src/lib/legalSourceLinks.ts";
import { buildLegalSourcePinpointUrl as buildCandidate } from "file:///C:/Users/elias/Desktop/MikeOSS%20Fork/experiments/text-fragment-fidelity/builder-candidate.ts";

const seeds = fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const doctext = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/doctext.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key, r.text]),
);
const classes = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/flagged-classes.json", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.label, r.klass]),
);

function build(builder, seed) {
  try {
    return builder(
      {
        url: seed.url,
        ...(seed.anchor ? { anchor: seed.anchor } : {}),
        blockText: seed.blockText,
        ...(doctext.get(seedDocumentKey(seed))
          ? { documentText: doctext.get(seedDocumentKey(seed)) }
          : {}),
      },
      seed.quotes ?? [],
    );
  } catch {
    return null;
  }
}

let changed = 0;
let same = 0;
const changedLabels = [];
const shapeChanged = {};
for (const seed of seeds) {
  const prod = build(buildProduction, seed);
  const cand = build(buildCandidate, seed);
  if (prod !== cand) {
    changed += 1;
    changedLabels.push(seed.label);
    shapeChanged[seed.shape] = (shapeChanged[seed.shape] ?? 0) + 1;
  } else {
    same += 1;
  }
}
console.log(JSON.stringify({ changed, same, byShape: shapeChanged }, null, 1));
fs.writeFileSync(
  "experiments/text-fragment-fidelity/results/changed-labels.jsonl",
  `${changedLabels.map((l) => JSON.stringify(l)).join("\n")}\n`,
);
