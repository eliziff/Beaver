#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const here = import.meta.dirname;
const results = path.join(here, "results");
const buildInputs = [
  "../../backend/src/lib/a2ajWebLinks.ts",
  "../../backend/src/lib/legalSourceLinks.ts",
  "../../backend/src/lib/legalSources/a2aj.ts",
  "../../legal-structure/src/document_query/text_fragment.rs",
].map((file) => path.resolve(here, file)).concat([
  path.join(results, "doctext.jsonl"), path.join(results, "targets.jsonl"),
]);
const buildReceipt = buildInputs.reduce(
  (hash, file) => hash.update(file).update("\0").update(fs.readFileSync(file)).update("\0"),
  crypto.createHash("sha256").update("a2aj-target-build-v2\0"),
).digest("hex");
const read = (name: string) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const proofBundle = (names: string[]) => {
  const byTarget = new Map<string, any>();
  const labels = new Set<string>();
  for (const row of names.flatMap(read)) {
    labels.add(row.label);
    const key = `${row.label}\n${row.target}`;
    byTarget.set(key, row);
  }
  return { byTarget, labels };
};
const targetRows = (name: string) => new Map(read(name)
  .map((row) => [row.label, row] as const));

const proven404 = "FCA_2026_FC_103_p20_short-exact";
const seeds = read("seeds.jsonl").filter((row) => row.label !== proven404);
const caseTargetRows = targetRows("a2aj-search-production-cases-fallback-targets.jsonl");
const lawTargetRows = targetRows("a2aj-search-all-fallback-targets.jsonl");
const publisherTargetRows = targetRows("targets.jsonl");
const caseTargets = new Map([...caseTargetRows].map(([label, row]) => [label, row.target]));
const lawTargets = new Map([...lawTargetRows].map(([label, row]) => [label, row.target]));
const publisherTargets = new Map([...publisherTargetRows].map(([label, row]) => [label, row.target]));
const webCases = new Set(caseTargets.keys());
const caseProofFiles = fs.readdirSync(results)
  .filter((name) => /^a2aj-search-production-final-case-shard-\d+\.jsonl$/u.test(name))
  .sort();
const lawProofFiles = fs.readdirSync(results)
  .filter((name) => /^a2aj-search-production-final-law-shard-\d+\.jsonl$/u.test(name))
  .sort();
const caseProof = proofBundle(caseProofFiles);
const lawProof = proofBundle([
  ...lawProofFiles,
]);
const publisherProof = proofBundle([
  "webdriver-exact-final-sentence-seam.jsonl",
  "webdriver-exact-final-current-html.jsonl",
]);
const cacheVerdicts = new Map<string, boolean>();
const validCache = (proof: any, directory: string) => {
  const identity = proof?.cacheIdentity;
  if (!identity?.file || !identity.sha256 || !Number.isInteger(identity.bytes)) return false;
  const file = path.join(results, directory, identity.file);
  const key = `${file}\n${identity.bytes}\n${identity.sha256}`;
  if (!cacheVerdicts.has(key)) {
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    cacheVerdicts.set(key, !!bytes && bytes.length === identity.bytes &&
      crypto.createHash("sha256").update(bytes).digest("hex") === identity.sha256);
  }
  return cacheVerdicts.get(key)!;
};

const failures: unknown[] = [];
const counts = { laws: 0, a2ajCases: 0, publisherCases: 0 };
const contextPaint = { rows: 0, words: 0, maxWords: 0 };
for (const seed of seeds) {
  const law = /^(?:LEGISLATION|REGULATIONS)-/u.test(seed.dataset);
  const route = law ? "laws" : webCases.has(seed.label) ? "a2ajCases" : "publisherCases";
  counts[route]++;
  const target = law ? lawTargets.get(seed.label)
    : route === "a2ajCases" ? caseTargets.get(seed.label)
    : publisherTargets.get(seed.label);
  const proofs = law ? lawProof : route === "a2ajCases" ? caseProof : publisherProof;
  const proof = proofs.byTarget.get(`${seed.label}\n${target}`);
  const currentTarget = route === "laws" ? lawTargetRows.get(seed.label)
    : route === "a2ajCases" ? caseTargetRows.get(seed.label) : null;
  const verdict = currentTarget && currentTarget.buildReceipt !== buildReceipt
    ? "stale-build-target"
    : proof?.verdict !== "exact-match" ? proof?.verdict ?? "missing-proof"
    : route !== "publisherCases" && (proof.verificationContract !== "a2aj-search-link-v2" ||
      !proof.checks || Object.values(proof.checks).some((value) => value !== true))
      ? "invalid-proof-contract"
    : !validCache(proof, route === "publisherCases" ? "page-html" : "a2aj-search-pages")
      ? "invalid-cache"
    : null;
  if (verdict) {
    failures.push({ label: seed.label, route,
      verdict: verdict === "missing-proof" && proofs.labels.has(seed.label)
        ? "stale-target-proof" : verdict });
  } else if (route !== "publisherCases" && proof.extraPaintWords > 0) {
    contextPaint.rows++;
    contextPaint.words += proof.extraPaintWords;
    contextPaint.maxWords = Math.max(contextPaint.maxWords, proof.extraPaintWords);
  }
}

const expected = seeds.length;
const routed = counts.laws + counts.a2ajCases + counts.publisherCases;
const failureCounts = failures.reduce<Record<string, number>>((totals, failure: any) => {
  const key = `${failure.route}:${failure.verdict}`;
  totals[key] = (totals[key] ?? 0) + 1;
  return totals;
}, {});
const failureSamples = Object.fromEntries(Object.keys(counts).map((route) => [
  route,
  failures.filter((failure: any) => failure.route === route).slice(0, 5),
]));
const summary = { expected, routed, counts, contextPaint, failureCounts, failureSamples };
console.log(JSON.stringify(summary));
if (expected !== 2370 || routed !== expected || failures.length) process.exitCode = 1;
