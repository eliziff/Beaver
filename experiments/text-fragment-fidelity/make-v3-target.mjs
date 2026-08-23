// Builds the targeted v3 gate set: seeds whose URL changed between the
// production and candidate builders, plus the actionable failure classes,
// plus a seeded random sample of unchanged seeds for placement stats.
import fs from "node:fs";

const seeds = fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const changed = new Set(
  fs.readFileSync("experiments/text-fragment-fidelity/results/changed-labels.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)),
);
const actionable = new Set(
  fs.readFileSync("experiments/text-fragment-fidelity/results/flagged-classes.json", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => ["projection-gap", "quote-restyled", "styling-difference"].includes(r.klass))
    .map((r) => r.label),
);

const target = new Set([...changed, ...actionable]);
// Seeded sample of unchanged seeds: one in five.
const hash = (value) => {
  let h = 2166136261;
  for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
};
for (const seed of seeds) {
  if (target.has(seed.label)) continue;
  if (hash(seed.label) % 5 === 0) target.add(seed.label);
}

const out = seeds.filter((seed) => target.has(seed.label));
fs.writeFileSync(
  "experiments/text-fragment-fidelity/results/seeds-v3-target.jsonl",
  `${out.map((s) => JSON.stringify(s)).join("\n")}\n`,
);
console.log(JSON.stringify({
  totalSeeds: seeds.length,
  changed: changed.size,
  actionable: actionable.size,
  targetSet: out.length,
}));
