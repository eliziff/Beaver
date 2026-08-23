import fs from "node:fs";
import path from "node:path";
import { readLines, parse, resultsDir } from "./gap-lib.mjs";

const label = process.argv[2];
const gateRows = new Map(readLines(path.join(resultsDir, "gate-final5.jsonl")).map(parse).filter(Boolean).map((r) => [r.label, r]));
const seeds = new Map(readLines(path.join(resultsDir, "seeds.jsonl")).map(parse).filter(Boolean).map((s) => [s.label, s]));
const g = gateRows.get(label);
const s = seeds.get(label);
console.log("seed url:", s?.url);
console.log("gate target:", g?.target);
