#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

const here = import.meta.dirname;
const results = path.join(here, "results");
const [
  routedName = "a2aj-document-routed-targets-v25.jsonl",
  fallbackProofName = "webdriver-exact-final-routed-lawweb-v25-full.jsonl",
  outputName = "final-composite-proof-v25.jsonl",
] = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const byLabel = (rows, name) => {
  const output = new Map();
  for (const row of rows) {
    if (output.has(row.label)) throw new Error(`duplicate ${name} label: ${row.label}`);
    output.set(row.label, row);
  }
  return output;
};
const excluded404 = "FCA_2026_FC_103_p20_short-exact";
const bestEffortLimit = "LEGISLATION-SK_SS_2015_c_I-9.11_sec4-3_hard-act-name";
const targets = read("publisher-plan-candidates.jsonl")
  .filter(({ label }) => label !== excluded404);
const targetLabels = byLabel(targets, "target");
const routed = byLabel(read(routedName), "route");
const fallbackProof = byLabel(
  read(fallbackProofName), "Law Web proof");
const publisherProof = byLabel(
  read("webdriver-exact-corrected-provider-v24-bound.jsonl"), "publisher proof");
if (targetLabels.size !== targets.length || routed.size !== fallbackProof.size ||
    [...routed.keys()].some((label) => !fallbackProof.has(label))) {
  throw new Error("target, route, or Law Web proof label set mismatch");
}
const cacheRoots = ["page-html", "live-rendered-html"].map((name) =>
  path.join(results, name));

function cacheBound(row) {
  const identity = row.cacheIdentity;
  if (!identity?.file || !identity.sha256 || !Number.isInteger(identity.bytes)) return false;
  return cacheRoots.some((root) => {
    const file = path.join(root, identity.file);
    if (!fs.existsSync(file)) return false;
    const bytes = fs.readFileSync(file);
    return bytes.length === identity.bytes &&
      crypto.createHash("sha256").update(bytes).digest("hex") === identity.sha256;
  });
}

const output = [];
const failures = [];
for (const target of targets) {
  const route = routed.has(target.label) ? "a2aj-law-web" : "publisher";
  const planned = routed.get(target.label) ?? target;
  const proof = route === "a2aj-law-web"
    ? fallbackProof.get(target.label) : publisherProof.get(target.label);
  const expectedVerdict = target.label === bestEffortLimit
    ? "pdf-natural-paint-geometry-extraneous" : "exact-match";
  const reasons = [
    !proof && "missing-proof",
    proof?.target !== planned.target && "target-mismatch",
    proof?.verdict !== expectedVerdict && `verdict:${proof?.verdict}`,
    proof?.sourceContract?.accepted !== true && "source-contract",
    proof && !cacheBound(proof) && "cache-identity",
  ].filter(Boolean);
  if (reasons.length) failures.push({ label: target.label, route, reasons });
  else output.push({ route, ...proof });
}

const body = `${output.map(JSON.stringify).join("\n")}\n`;
fs.writeFileSync(path.join(results, outputName), body);
const summary = {
  gettable: targets.length,
  exact: output.filter(({ verdict }) => verdict === "exact-match").length,
  bestEffortLimits: output.filter(({ verdict }) => verdict !== "exact-match").length,
  routes: Object.fromEntries(Object.entries(Object.groupBy(output, ({ route }) => route))
    .map(([route, rows]) => [route, rows.length])),
  cacheBound: output.length,
  failures,
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
};
console.log(JSON.stringify(summary));
if (targets.length !== 2_370 || output.length !== targets.length || failures.length) {
  process.exitCode = 1;
}
