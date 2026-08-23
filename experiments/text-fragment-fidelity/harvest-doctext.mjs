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
const SLEEP_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { a2ajLegalSourceProvider } = await import(
  new URL("../../backend/src/lib/legalSources/a2aj.ts", import.meta.url).href
);
const { documentTextNative } = await import(
  new URL("../../backend/src/lib/structureNative.ts", import.meta.url).href
);

const manifest = fs.readFileSync(manifestPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  .filter((row) => row.status === "ok");
const identity = (row) => `${row.dataset}\0${row.citation}`;
const have = new Set(
  fs.existsSync(sidecarPath)
    ? fs.readFileSync(sidecarPath, "utf8").split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return identity(JSON.parse(l)); } catch { return null; } })
        .filter(Boolean)
    : [],
);
const pending = manifest.filter((row) => !have.has(identity(row)));
console.log(JSON.stringify({ total: manifest.length, have: have.size, pending: pending.length }));

const stream = fs.createWriteStream(sidecarPath, { flags: "a" });
let done = 0;
let hydrated = 0;
const failures = [];
for (const row of pending) {
  try {
    const docType = /^(?:LEGISLATION|REGULATIONS)-/u.test(row.dataset) ? "laws" : "cases";
    const document = await a2ajLegalSourceProvider.document({
      citation: row.citation, docType, language: "en", dataset: row.dataset,
    });
    const text = document?.native ? documentTextNative(document.native) : "";
    if (text) {
      const key = String(row.citation).replace(/[^\w.-]+/gu, "_");
      stream.write(`${JSON.stringify({ citation: row.citation, dataset: row.dataset, key, text })}\n`);
      hydrated += 1;
    } else {
      failures.push({ citation: row.citation, dataset: row.dataset, error: "not found" });
    }
  } catch (error) {
    failures.push({ citation: row.citation, dataset: row.dataset, error: String(error) });
  }
  done += 1;
  if (done % 25 === 0) console.log(JSON.stringify({ event: "progress", done, of: pending.length }));
  await sleep(SLEEP_MS);
}
stream.end();
console.log(JSON.stringify({ event: "doctext-done", processed: done, hydrated, failures }));
