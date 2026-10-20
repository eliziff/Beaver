import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { sourceReadings } from "../src/lib/sourceReadings";

// Independently invented text; no Library, document store or provider is read.
const source = (index: number) => {
  const pageTextByPage = Array.from({ length: 600 }, (_, page) => Buffer.from(
    (`A survey of fictional islands and their public gardens. ${index}:${page} `).repeat(100).slice(0, 5500),
  ).toString());
  return { pageTextByPage, ocrTextByPage: pageTextByPage.map(() => ""),
    pageBindings: pageTextByPage.map((_, page) => ({ pageIndex: page, label: String(page + 1) })),
    pageLabels: pageTextByPage.map((_, page) => String(page + 1)) };
};

assert(global.gc, "Run with node --expose-gc --import tsx scripts/measure-source-readings.mts from backend");
const heap = async () => {
  await turn(); global.gc!(); await turn(); global.gc!();
  return process.memoryUsage().heapUsed;
};
const mib = (bytes: number) => +(bytes / 1024 / 1024).toFixed(2);

async function measure(cached: boolean) {
  const read = cached ? sourceReadings() : async <T>(_key: unknown, _input: unknown, load: () => Promise<T>) => load();
  const before = await heap();
  let values: ReturnType<typeof source>[] = [], characters = 0, elapsed = 0;
  for (let index = 0; index < 8; index++) {
    const value = source(index);
    characters += JSON.stringify(value).length;
    const started = performance.now();
    values.push(await read({ synthetic: index }, {}, async () => value));
    elapsed += performance.now() - started;
  }
  const held = await heap(), pages = values.reduce((sum, value) => sum + value.pageTextByPage.length, 0);
  assert.equal(pages, 4800);
  values = [];
  const idle = await heap();
  // Keep the cache owner alive during the idle measurement.
  if (cached) await read({ synthetic: 7 }, {}, async () => { throw Error("Expected retained reading"); });
  return { cached, pages, characters, readingMs: +elapsed.toFixed(1),
    heldHeapMiB: mib(held - before), idleHeapMiB: mib(idle - before) };
}

console.log(JSON.stringify({ results: [await measure(false), await measure(true)] }, null, 2));
