#!/usr/bin/env node

import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { a2ajLocalBulkPath } from "../../../backend/src/lib/a2ajLocalBulk";

const DRAW_CACHE_DIR = path.join(__dirname, "..", "scratch", ".drawcache");
const TEXT_CACHE_DIR = path.join(__dirname, "..", "scratch", ".textcache");

const fingerprint = (() => {
  const s = statSync(a2ajLocalBulkPath());
  return `${s.size}:${s.mtimeMs}`;
})();

const candidates = JSON.parse(
  readFileSync(path.join(DRAW_CACHE_DIR, "4.SCC.1000.json"), "utf8"),
).candidates as Array<{ documentId: number }>;

const cacheBase = fingerprint.replace(/:/g, "_");
const index = JSON.parse(
  readFileSync(path.join(TEXT_CACHE_DIR, `${cacheBase}.index.json`), "utf8"),
) as { entries: Array<{ documentId: number; offset: number; length: number }> };
const bin = readFileSync(path.join(TEXT_CACHE_DIR, `${cacheBase}.texts.bin`));
const byId = new Map(index.entries.map((e) => [e.documentId, e]));

const jobs = candidates.flatMap((c) => {
  const e = byId.get(c.documentId);
  if (!e) return [];
  return [{
    documentId: c.documentId,
    citation: "x",
    dataset: "",
    name: null,
    text: bin.toString("utf8", e.offset, e.offset + e.length),
    url: null,
    alternateCitation: null,
  }];
});

const bundle = path.join(__dirname, "..", "scratch", "worker.bundle.mjs");

function runWithBatch(list: typeof jobs, batchSize: number, workers: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let results = 0;
    const finished = () => {
      if (active === 0) resolve(results);
    };
    const spawn = () => {
      const worker = new Worker(bundle);
      active += 1;
      worker.on("message", (rs: unknown[]) => {
        results += rs.length;
        if (next < list.length) {
          worker.postMessage(list.slice(next, (next += batchSize)));
        } else {
          active -= 1;
          worker.terminate();
          finished();
        }
      });
      worker.on("error", (e) => {
        active -= 1;
        worker.terminate();
        reject(e);
      });
      if (next < list.length) worker.postMessage(list.slice(next, (next += batchSize)));
      else {
        active -= 1;
        worker.terminate();
        finished();
      }
    };
    for (let i = 0; i < Math.min(workers, Math.ceil(list.length / batchSize)); i += 1) spawn();
  });
}

(async () => {
  console.log(`jobs: ${jobs.length}, fingerprint: ${fingerprint}`);
  const sorted = [...jobs].sort((a, b) => b.text.length - a.text.length);
  for (const sort of ["asc", "desc"] as const) {
    const list = sort === "desc" ? sorted : jobs;
    for (const batch of [25, 50]) {
      const t0 = performance.now();
      const results = await runWithBatch(list, batch, 8);
      console.log(`sort=${sort} batch=${batch} workers=8: ${(performance.now() - t0).toFixed(0)}ms (${results} results)`);
    }
  }
})();
