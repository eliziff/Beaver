#!/usr/bin/env node
import fs from "node:fs";

const [targetsFile, proofFile, outputFile] = process.argv.slice(2);
if (!targetsFile || !proofFile || !outputFile) {
  throw new Error("usage: node select-browser-fallback.mjs <targets.jsonl> <offline-proof.jsonl> <output.jsonl>");
}
const read = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const proof = new Map(read(proofFile).map((row) => [row.label, row.verdict]));
const fallback = read(targetsFile).filter((row) => proof.get(row.label) !== "offline-compatible");
fs.writeFileSync(outputFile, fallback.map((row) => `${JSON.stringify(row)}\n`).join(""));
console.log(JSON.stringify({ targets: proof.size, browserFallback: fallback.length, offlineAccepted: proof.size - fallback.length }));
