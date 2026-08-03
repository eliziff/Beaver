#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";
import { Worker } from "node:worker_threads";
import type { WorkerJob, WorkerResult } from "../seedtypes";

const bundle = path.join(__dirname, "worker.bundle.mjs");
console.log(`bundle: ${(statSync(bundle).size / 1024).toFixed(0)}KB`);

const cache = JSON.parse(readFileSync(path.join(__dirname, ".drawcache", "3.SCC.1000.json"), "utf8")) as {
  candidates: Array<{ documentId: number }>;
};
const db = new DatabaseSync(a2ajLocalBulkPath(), { readOnly: true });
const ids = cache.candidates.map((c) => c.documentId);

let t = performance.now();
const jobs: WorkerJob[] = [];
for (let index = 0; index < ids.length; index += 500) {
  const chunk = ids.slice(index, index + 500);
  const marks = chunk.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, unofficial_text_en, citation_en, citation2_en, url_en, dataset, name_en FROM document WHERE id IN (${marks})`).all(...chunk) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const text = String(row.unofficial_text_en ?? "").trim();
    if (!text) continue;
    jobs.push({
      documentId: Number(row.id),
      citation: String(row.citation_en ?? row.citation2_en ?? ""),
      dataset: String(row.dataset ?? ""),
      name: row.name_en ? String(row.name_en) : null,
      text,
      url: row.url_en ? String(row.url_en) : null,
      alternateCitation: row.citation2_en ? String(row.citation2_en) : null,
    });
  }
}
db.close();
console.log(`select texts: ${(performance.now() - t).toFixed(0)}ms (${jobs.length} jobs)`);

async function runPoolFor(workers: number) {
  const chunks: WorkerJob[][] = [];
  for (let index = 0; index < jobs.length; index += 50) chunks.push(jobs.slice(index, index + 50));
  const t = performance.now();
  let results = 0;
  await new Promise<void>((resolve) => {
    let next = 0;
    let active = 0;
    const spawn = () => {
      const worker = new Worker(bundle);
      active += 1;
      worker.on("message", (batch: WorkerResult[]) => {
        results += batch.length;
        if (next < chunks.length) worker.postMessage(chunks[next++]);
        else { active -= 1; worker.terminate(); if (active === 0) resolve(); }
      });
      if (next < chunks.length) worker.postMessage(chunks[next++]);
      else { active -= 1; worker.terminate(); if (active === 0) resolve(); }
    };
    for (let index = 0; index < Math.min(workers, chunks.length); index += 1) spawn();
  });
  console.log(`pool workers=${workers}: ${(performance.now() - t).toFixed(0)}ms (${results} results)`);
}

async function main() {
  for (const workers of [2, 4, 8]) {
    await runPoolFor(workers);
  }
}

void main();
