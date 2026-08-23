#!/usr/bin/env node
// Materialize the deliberately minimal one-range-per-quote candidate.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
(globalThis as { __dirname?: string }).__dirname = path.join(here, "../../backend/src/lib");
const { buildCoreRangePinpointUrl, buildLineCorePinpointUrl } = await import("./builder-candidate.ts");
const { buildLegalSourcePinpointUrl: buildProductionUrl } = await import(
  pathToFileURL(path.join(here, "../../backend/src/lib/legalSourceLinks.ts")).href);
const results = path.join(here, "results");
const mode = process.argv[2] === "line" ? "line" : "range";
const boundary = mode === "line" ? 0 : Number(process.argv[2] ?? 1);
const lines = (file: string) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
const seeds = lines(path.join(results, "seeds.jsonl")).map(JSON.parse);
const doctext = new Map(lines(path.join(results, "doctext.jsonl")).map((line) => {
  const row = JSON.parse(line);
  return [row.key, row.text] as const;
}));
const missingDocuments = seeds.flatMap((seed) => {
  const key = seedDocumentKey(seed);
  return key && !doctext.has(key) ? [{ label: seed.label, key }] : [];
});
if (missingDocuments.length) throw new Error(`missing ${missingDocuments.length} full documents: ${JSON.stringify(missingDocuments)}`);
let fullDocuments = 0;
const rows = seeds.map((seed) => ({
  ...seed,
  target: (() => {
    const documentKey = seedDocumentKey(seed);
    const documentText = doctext.get(documentKey ?? "");
    if (documentText) fullDocuments += 1;
    const evidence = {
      url: seed.url,
      ...(seed.anchor ? { anchor: seed.anchor } : {}),
      blockText: seed.blockText ?? "",
      ...(documentText ? { documentText } : {}),
    };
    if (mode !== "line") return buildCoreRangePinpointUrl(evidence, seed.quotes ?? [], boundary);
    const candidate = buildLineCorePinpointUrl(evidence, seed.quotes ?? []);
    const fragment = candidate.split(":~:")[1];
    const base = buildProductionUrl(evidence, []);
    return fragment ? `${base}:~:${fragment}` : base;
  })(),
}));
const output = path.join(results, mode === "line" ? "line-core-targets.jsonl" : `core-range-${boundary}-targets.jsonl`);
fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const directives = (target: string) => (target.split(":~:")[1] ?? "").split("&").filter((part) => part.startsWith("text=")).length;
console.log(JSON.stringify({
  targets: rows.length,
  mode,
  boundary,
  fullDocuments,
  blockFallbacks: rows.length - fullDocuments,
  links: rows.filter((row) => directives(row.target)).length,
  directives: rows.reduce((sum, row) => sum + directives(row.target), 0),
  averageUrl: Math.round(rows.reduce((sum, row) => sum + row.target.length, 0) / rows.length),
  maximumUrl: Math.max(...rows.map((row) => row.target.length)),
  output,
}));
