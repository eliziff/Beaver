#!/usr/bin/env node
// Compares two planner-equivalence.mts outputs: identical bytes, or every row that differs.
// Usage: node experiments/text-fragment-fidelity/compare-equivalence.mjs results/equivalence/<before> results/equivalence/<after>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const here = import.meta.dirname;
const [before, after] = process.argv.slice(2).map((name) => path.join(path.resolve(here, name), "all.jsonl"));
const bytes = (file) => fs.readFileSync(file);
const rows = (file) => bytes(file).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sha = (file) => createHash("sha256").update(bytes(file)).digest("hex");
const [left, right] = [rows(before), rows(after)];
const index = (list) => new Map(list.map((row) => [`${row.kind}|${row.key}`, JSON.stringify(row.value)]));
const [a, b] = [index(left), index(right)];
const differing = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
const kinds = Object.fromEntries(Object.entries(Object.groupBy(left, (row) => row.kind)).map(([kind, list]) => [kind, list.length]));
const documents = new Set(left.map((row) => row.key.split("|").slice(0, 2).join("|")));
const datasets = new Set(left.filter((row) => row.kind === "link").map((row) => row.value.stableId?.split(":")[2]));
console.log(JSON.stringify({ before: { rows: left.length, sha256: sha(before) }, after: { rows: right.length, sha256: sha(after) },
  identical: sha(before) === sha(after), differing: differing.length, kinds, documents: documents.size, datasets: datasets.size }, null, 1));
for (const key of differing.slice(0, 20)) console.log("DIFF", key, "\n  before:", a.get(key)?.slice(0, 300), "\n  after: ", b.get(key)?.slice(0, 300));
process.exitCode = differing.length ? 1 : 0;
