#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const lines = (name: string) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const label = process.argv[2];
const seed = lines("seeds.jsonl").find((row) => row.label === label);
if (!seed) throw new Error(`unknown seed: ${label}`);
const source = lines("doctext.jsonl").find((row) => row.key === seedDocumentKey(seed));
if (!source) throw new Error(`missing source: ${label}`);
const { structureNative } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/structureNative.ts"),
).href);
const native = await structureNative().deriveDocumentStructure({
  kind: "a2aj",
  input: {
    citation: source.citation,
    source_kind: /^(?:LEGISLATION|REGULATIONS)-/u.test(source.dataset) ? "laws" : "cases",
    text: source.text,
    dataset: source.dataset,
    url: seed.url,
  },
});
console.log(JSON.stringify({
  nativeText: structureNative().documentText(native),
  plan: structureNative().textFragmentPlan(
    seed.blockText ?? "", seed.quotes ?? [], false, false, native,
  ),
}));
