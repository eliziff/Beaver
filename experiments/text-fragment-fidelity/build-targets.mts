#!/usr/bin/env node
// Materialize the exact candidate URL for every seed. This keeps the
// ChromeDriver gate independent of TypeScript runtime loading.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const builder = process.argv[2] ?? "production";
if (!["production", "candidate"].includes(builder)) throw new Error("builder must be production or candidate");
const { buildLegalSourcePinpointUrl } = await import(builder === "production"
  ? pathToFileURL(path.join(here, "../../backend/src/lib/legalSourceLinks.ts")).href
  : "./builder-candidate.ts");
const structure = builder === "production"
  ? (await import(pathToFileURL(path.join(here, "../../backend/src/lib/structureNative.ts")).href))
      .structureNative()
  : null;
const results = path.join(here, "results");
const readLines = (file: string) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
const seeds = readLines(path.join(results, "seeds.jsonl")).map((line) => JSON.parse(line));
const doctext = new Map<string, { citation: string; dataset: string; text: string }>();
for (const line of readLines(path.join(results, "doctext.jsonl"))) {
  const row = JSON.parse(line);
  if (row.key && row.text) doctext.set(row.key, row);
}
const missingDocuments = seeds.flatMap((seed) => {
  const key = seedDocumentKey(seed);
  return key && !doctext.has(key) ? [{ label: seed.label, key }] : [];
});
if (missingDocuments.length) throw new Error(`missing ${missingDocuments.length} full documents: ${JSON.stringify(missingDocuments)}`);
const rows = Array(seeds.length);
const groups = Map.groupBy(seeds.map((seed, index) => ({ seed, index })),
  ({ seed }) => seedDocumentKey(seed));
for (const [documentKey, members] of groups) {
  const source = doctext.get(documentKey ?? "")!;
  const documentText = builder === "production"
    ? await structure!.deriveDocumentStructure({ kind: "a2aj", input: {
        citation: source.citation,
        source_kind: /^(?:LEGISLATION|REGULATIONS)-/u.test(source.dataset) ? "laws" : "cases",
        text: source.text,
        dataset: source.dataset,
        url: members[0].seed.url,
      } })
    : source.text;
  for (const { seed, index } of members) {
    const target = buildLegalSourcePinpointUrl({
      url: seed.url,
      ...(seed.anchor ? { anchor: seed.anchor } : {}),
      blockText: seed.blockText ?? "",
      documentText,
    }, seed.quotes ?? []);
    rows[index] = { ...seed, target };
  }
}
const fullDocuments = rows.length;
const output = path.join(results, builder === "production" ? "targets.jsonl" : "candidate-targets.jsonl");
fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(JSON.stringify({ builder, targets: rows.length, links: rows.filter((row) => row.target).length, fullDocuments, blockFallbacks: rows.length - fullDocuments, output }));
