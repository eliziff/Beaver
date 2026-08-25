#!/usr/bin/env node
// Materialize the exact candidate URL for every seed. This keeps the
// ChromeDriver gate independent of TypeScript runtime loading.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { cachedDerivedPdfEvidence } from "./source-representation.mjs";

const here = import.meta.dirname;
const builder = process.argv[2] ?? "production";
if (!["production", "candidate"].includes(builder)) throw new Error("builder must be production or candidate");
const links = await import(builder === "production"
  ? pathToFileURL(path.join(here, "../../backend/src/lib/legalSourceLinks.ts")).href
  : "./builder-candidate.ts");
const { buildLegalSourcePinpointUrl } = links;
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
const documents = [...groups];
let completedDocuments = 0;
const started = performance.now();
for (const group of documents) {
  const [documentKey, members] = group;
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
    const evidence = {
      url: seed.url,
      verifiedPdf: cachedDerivedPdfEvidence(seed.url),
      ...(seed.anchor ? { anchor: seed.anchor } : {}),
      blockText: seed.blockText ?? "",
      documentText,
    };
    const built = builder === "production"
      ? links.buildLegalSourcePinpoint(evidence, seed.quotes ?? [])
      : null;
    const target = built?.target ?? buildLegalSourcePinpointUrl(evidence, seed.quotes ?? []);
    rows[index] = { ...seed, target, ...(built?.plan ?? {}) };
  }
  completedDocuments++;
  if (completedDocuments % 100 === 0 || completedDocuments === documents.length) {
    const seconds = ((performance.now() - started) / 1_000).toFixed(1);
    console.error(`documents ${completedDocuments}/${documents.length} (${seconds}s)`);
  }
}
const fullDocuments = rows.length;
const output = path.join(results, builder === "production" ? "targets.jsonl" : "candidate-targets.jsonl");
fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(JSON.stringify({ builder, targets: rows.length, links: rows.filter((row) => row.target).length, fullDocuments, blockFallbacks: rows.length - fullDocuments, output }));
