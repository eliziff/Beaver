#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const [beforeName, afterName, outputName] = process.argv.slice(2);
if (!beforeName || !afterName || !outputName) {
  throw new Error("usage: diff-target-corpus.mjs BEFORE AFTER OUTPUT");
}
const before = new Map(read(beforeName).map((row) => [row.label, row]));
const changed = read(afterName).filter((row) => before.get(row.label)?.target !== row.target);
fs.writeFileSync(path.join(results, outputName), `${changed.map(JSON.stringify).join("\n")}\n`);
console.log(JSON.stringify({ beforeName, afterName, outputName, changed: changed.length }));
