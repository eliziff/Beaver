#!/usr/bin/env node

import { Worker } from "node:worker_threads";
import path from "node:path";

const SRC = path.join(__dirname, "noopworker.ts");
const jobs = Array.from({ length: 1000 }, (_, i) => ({ id: i, text: "x".repeat(15000 + (i % 7) * 1000) }));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

function spawnWorkers(n: number): Worker[] {
  return Array.from({ length: n }, () => new Worker(SRC));
}

function spawnTiming(n: number): Promise<number> {
  const ws = spawnWorkers(n);
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    let ready = 0;
    for (const w of ws) {
      w.once("online", () => {
        ready += 1;
        if (ready === n) resolve(performance.now() - t0);
      });
      w.once("error", reject);
      w.once("exit", (code) => {
        if (code !== 0) reject(new Error(`worker exited ${code}`));
      });
    }
  });
}

function runRound(workers: number, batch: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = spawnWorkers(workers);
    const t0 = performance.now();
    let ti = 0;
    let got = 0;
    const feed = () => {
      for (const w of ws) {
        const slice = jobs.slice(ti, ti + batch);
        if (slice.length) {
          w.postMessage(slice);
          ti += slice.length;
        }
      }
    };
    const onMsg = () => {
      got += 1;
      if (got === workers * Math.ceil(jobs.length / (workers * batch))) {
        const dt = performance.now() - t0;
        for (const w of ws) w.terminate();
        resolve(dt);
      }
    };
    for (const w of ws) {
      w.on("message", onMsg);
      w.on("error", reject);
    }
    feed();
  });
}

(async () => {
  for (const w of [2, 4, 8]) {
    const spawn = await withTimeout(spawnTiming(w), 30000, `spawn ${w}`);
    console.log(`spawn ${w} workers: ${spawn.toFixed(0)}ms`);
  }
  for (const b of [50, 250, 1000]) {
    for (const w of [4, 8]) {
      const t = await withTimeout(runRound(w, b), 60000, `round ${w}/${b}`);
      const batches = Math.ceil(jobs.length / (workersOf(b, w) * b));
      console.log(`round workers=${w} batch=${b}: ${t.toFixed(0)}ms (${jobs.length} jobs in ${batches} waves)`);
    }
  }
})();

function workersOf(_b: number, _w: number): number {
  return _w;
}
