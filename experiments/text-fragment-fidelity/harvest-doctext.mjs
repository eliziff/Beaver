#!/usr/bin/env node
// Persists full compiled document text per harvested citation so the gate can
// build links exactly as production does (full-document uniqueness checks for
// ranges) instead of block-scoped verification.
// Idempotent: rows already in the sidecar are skipped.
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const manifestPath = path.join(resultsDir, "manifest.jsonl");
const sidecarPath = path.join(resultsDir, "doctext.jsonl");
const SLEEP_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { a2ajLegalSourceProvider } = await import(
  new URL("../../backend/src/lib/legalSources/a2aj.ts", import.meta.url).href
);

const manifest = fs.readFileSync(manifestPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  .filter((row) => row.status === "ok");
const have = new Set(
  fs.existsSync(sidecarPath)
    ? fs.readFileSync(sidecarPath, "utf8").split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l).citation; } catch { return null; } })
        .filter(Boolean)
    : [],
);
const pending = manifest.filter((row) => !have.has(row.citation));
console.log(JSON.stringify({ total: manifest.length, have: have.size, pending: pending.length }));

const stream = fs.createWriteStream(sidecarPath, { flags: "a" });
let done = 0;
for (const row of pending) {
  try {
    const lookup = await a2ajLegalSourceProvider.lookup({
      citation: row.citation, docType: "cases", language: "en", kind: "paragraph", locator: "1",
    });
    const source = lookup?.status === "found" ? a2ajLegalSourceProvider.source(lookup) : null;
    if (source?.text) {
      stream.write(`${JSON.stringify({ citation: row.citation, dataset: row.dataset, text: source.text })}\n`);
    }
  } catch {}
  done += 1;
  if (done % 25 === 0) console.log(JSON.stringify({ event: "progress", done, of: pending.length }));
  await sleep(SLEEP_MS);
}
stream.end();
console.log(JSON.stringify({ event: "doctext-done", processed: done }));
