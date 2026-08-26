#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const candidateName = process.argv[2] ?? "a2aj-document-fallback-targets-v6.jsonl";
const outputName = process.argv[3] ?? "webdriver-exact-a2aj-document-v6-reused.jsonl";
const candidates = read(candidateName);
const prior = [
  ["v2", "a2aj-document-fallback-targets-v2.jsonl", "webdriver-exact-final-a2aj-document-v2.jsonl"],
  ["v4", "a2aj-document-fallback-targets-v4.jsonl", "webdriver-exact-fast-a2aj-document-v4.jsonl"],
  ["v5", "a2aj-document-fallback-targets-v5.jsonl", "webdriver-exact-fast-a2aj-document-v5.jsonl"],
  ["v7", "a2aj-document-fallback-targets-v7-changed.jsonl",
    "webdriver-exact-fast-a2aj-document-v7-changed.jsonl"],
  ["v9", "a2aj-document-fallback-targets-v9-changed.jsonl",
    "webdriver-exact-fast-a2aj-document-v9-changed.jsonl"],
  ["v10", "a2aj-document-fallback-targets-v10-changed.jsonl",
    "webdriver-exact-fast-a2aj-document-v10-changed-contract-v3.jsonl"],
].flatMap(([run, targetName, proofName]) => {
  const proofs = new Map(read(proofName).map((row) => [row.label, row]));
  return read(targetName).map((target) => ({ run, target, proof: proofs.get(target.label) }));
});
const bound = [];
for (const candidate of candidates) {
  const matches = prior.filter(({ target, proof }) => proof
    && target.label === candidate.label
    && target.target === candidate.target
    && JSON.stringify(target.directives) === JSON.stringify(candidate.directives)
    && JSON.stringify(target.sourceWordIntervals) === JSON.stringify(candidate.sourceWordIntervals)
    && JSON.stringify(target.paintQuotes) === JSON.stringify(candidate.paintQuotes));
  const match = matches.find(({ proof }) => proof.verdict === "exact-match") ?? matches[0];
  if (!match) throw new Error(`no identical prior browser proof for ${candidate.label}`);
  bound.push({ ...match.proof, reusedFrom: match.run });
}
fs.writeFileSync(path.join(results, outputName), `${bound.map(JSON.stringify).join("\n")}\n`);
const verdicts = Object.groupBy(bound, (row) => row.verdict);
console.log(JSON.stringify({ candidateName, outputName, rows: bound.length,
  verdicts: Object.fromEntries(Object.entries(verdicts).map(([key, rows]) => [key, rows.length])) }));
