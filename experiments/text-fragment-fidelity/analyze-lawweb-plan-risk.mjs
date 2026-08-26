#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

const results = path.join(import.meta.dirname, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row.text]));

for (const row of read(process.argv[2] ?? "a2aj-document-routed-targets-v20.jsonl")) {
  const text = documents.get(seedDocumentKey(row)) ?? "";
  const first = Math.min(...row.sourceWordIntervals.map((span) => span.start));
  const last = Math.max(...row.sourceWordIntervals.map((span) => span.end));
  const source = text.slice(first, last);
  const structuralLines = source.split(/\r?\n/u).filter((line) => line.trim()).length;
  const bareExact = row.directives.length === 1
    && row.directives[0].split(",").length === 1;
  console.log(JSON.stringify({
    label: row.label,
    publisherVerdict: row.publisherVerdict,
    structuralLines,
    bareExact,
    paintedWords: row.paintedWords,
    directives: row.directives.length,
  }));
}
