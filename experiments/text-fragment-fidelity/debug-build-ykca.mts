import { buildLegalSourcePinpointUrl } from "./builder-candidate";
import fs from "node:fs";

const seeds = fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const doctext = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/doctext.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key, r.text]),
);
const seed = seeds.find((s) => s.label === "YKCA_2019_YKCA_18_p18_short-exact");
const key = seed.label.split("_").slice(1, -1).join("_");
process.env.BUILDER_DEBUG = "1";
const url = buildLegalSourcePinpointUrl(
  {
    url: seed.url,
    anchor: seed.anchor,
    blockText: seed.blockText,
    documentText: doctext.get(key),
  },
  seed.quotes,
);
process.env.BUILDER_DEBUG = "";
console.log("URL:", url);
