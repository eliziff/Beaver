#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const [freshName = "webdriver-exact-corrected-provider-v24-full.jsonl",
  outputName = "webdriver-exact-corrected-provider-v24-bound.jsonl",
  ...isolatedNames] =
  process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const index = (rows) => new Map(rows.map((row) => [row.label, row]));

const candidates = read("publisher-plan-candidates.jsonl")
  .filter(({ label }) => label !== "FCA_2026_FC_103_p20_short-exact");
const fresh = index(read(freshName));
const historical = index([
  ...read("webdriver-exact-final-publisher-current.jsonl"),
  ...read("webdriver-exact-final-publisher-current-errors.jsonl"),
]);
const isolated = index(isolatedNames.flatMap(read));
const output = [];
const failures = [];
let recoveredErrors = 0;
for (const candidate of candidates) {
  let proof = fresh.get(candidate.label);
  const controlled = isolated.get(candidate.label);
  if (proof?.verdict !== "exact-match" && controlled?.target === candidate.target &&
      controlled.verdict === "exact-match" && controlled.headed === true &&
      controlled.sourceContract?.accepted === true) proof = controlled;
  const prior = historical.get(candidate.label);
  if (proof?.verdict === "error" && prior?.target === candidate.target &&
      prior?.verdict !== "error" && prior?.headed === true &&
      prior?.sourceContract?.accepted === true) {
    proof = prior;
    recoveredErrors += 1;
  }
  if (!proof || proof.target !== candidate.target || proof.headed !== true ||
      proof.sourceContract?.accepted !== true) {
    failures.push(candidate.label);
  } else {
    output.push(proof);
  }
}
fs.writeFileSync(path.join(results, outputName),
  `${output.map(JSON.stringify).join("\n")}\n`);
console.log(JSON.stringify({
  rows: output.length,
  recoveredErrors,
  exact: output.filter(({ verdict }) => verdict === "exact-match").length,
  residuals: output.filter(({ verdict }) => verdict !== "exact-match").length,
  failures,
}));
if (failures.length || output.length !== candidates.length) process.exitCode = 1;
