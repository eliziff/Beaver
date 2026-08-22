#!/usr/bin/env node
// Harvests a stratified 1000-decision corpus from A2AJ for text-fragment
// gating. Idempotent: results/manifest.jsonl pins every processed decision;
// re-running tops up remaining quota and never reprocesses a citation.
//
// Usage (repo root): npx tsx experiments/text-fragment-fidelity/harvest.mjs
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const manifestPath = path.join(resultsDir, "manifest.jsonl");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const coveragePath = path.join(resultsDir, "coverage.json");
const TARGET_DECISIONS = Number(process.env.CORPUS_TARGET ?? 1000);
const PER_DATASET_FLOOR = 10;
const SLEEP_MS = 1050;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = path.resolve(here, "..", "..");
const { a2ajLegalSourceProvider } = await import(
  new URL("../../backend/src/lib/legalSources/a2aj.ts", import.meta.url).href
);

function hash32(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEARCH_QUERIES = [
  "the application",
  "the respondent submits",
  "the applicant",
  "the evidence establishes",
  "under section",
  "the court concludes",
];

async function loadJsonl(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}
function appendJsonl(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

let manifest = new Map();
for (const row of await loadJsonl(manifestPath)) {
  if (row.citation && !manifest.has(row.citation)) manifest.set(row.citation, row);
}
const seededLabels = new Set((await loadJsonl(seedsPath)).map((row) => row.label));

if (!fs.existsSync(coveragePath)) {
  const coverage = await a2ajLegalSourceProvider.coverage("cases");
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 1));
  await sleep(SLEEP_MS);
}
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));

function planQuotas() {
  const usable = coverage
    .filter((row) => row.docType === "cases" && row.documentCount > 0)
    .sort((a, b) => a.dataset.localeCompare(b.dataset));
  const quotas = new Map(usable.map((row) => [row.dataset, PER_DATASET_FLOOR]));
  let assigned = quotas.size * PER_DATASET_FLOOR;
  const weights = usable.map((row) => Math.log10(Math.max(row.documentCount, 10)));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  while (assigned < TARGET_DECISIONS) {
    let placedAny = false;
    for (let i = 0; i < usable.length && assigned < TARGET_DECISIONS; i += 1) {
      const share = Math.floor(
        ((TARGET_DECISIONS - quotas.size * PER_DATASET_FLOOR) * weights[i]) / weightSum,
      );
      const extra = Math.min(
        Math.max(1, Math.round(share / 50)) || 1,
        Math.max(usable[i].documentCount - quotas.get(usable[i].dataset), 1),
        TARGET_DECISIONS - assigned,
      );
      quotas.set(usable[i].dataset, quotas.get(usable[i].dataset) + extra);
      assigned += extra;
      placedAny = true;
    }
    if (!placedAny) break;
  }
  return quotas;
}

function wordSlice(text, startWord, words) {
  const tokens = text.split(/\s+/u);
  if (startWord + words > tokens.length) return null;
  return tokens.slice(startWord, startWord + words).join(" ");
}

function findWindows(text) {
  const hits = [];
  const lower = text.toLowerCase();
  const patterns = [
    [/\((?:[a-z][\w.'’ ]{0,28})?,? at paras?\.\s*\d/gu, "hard-case-cite"],
    [/(?:^|[^a-z])s\.\s?\d/gu, "hard-statute-ref"],
    [/\bsections?\s+\d/gu, "hard-section-word"],
    [/\b(act|code|regulations?|rules)\b/gu, "hard-act-name"],
  ];
  for (const [pattern, tag] of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(lower))) {
      hits.push({ index: match.index, tag });
      break;
    }
  }
  return hits;
}

function wordIndexAt(text, charIndex) {
  let words = 0;
  const re = /\S+/gu;
  let match;
  while ((match = re.exec(text))) {
    if (match.index >= charIndex) break;
    words += 1;
  }
  return words;
}

function receiptsForDoc(citation, dataset, url, source) {
  const rng = mulberry32(hash32(`${dataset}:${citation}`));
  const blocks = (source.blocks ?? [])
    .filter((block) => block.kind === "paragraph")
    .map((block) => ({
      label: String(block.label ?? "").replace(/^par/i, ""),
      text: source.text.slice(block.start, block.end).replace(/\s+/gu, " ").trim(),
    }))
    .filter((block) => {
      const words = block.text.split(/\s+/u).length;
      return words >= 45 && words <= 400;
    });
  if (!blocks.length) return [];

  const sanitize = String(citation).replace(/[^\w.-]+/gu, "_");
  const receipts = [];
  const pushReceipt = (blockLabel, shape, quote) => {
    let label = `${dataset}_${sanitize}_p${blockLabel}_${shape}`;
    let suffix = 2;
    while (seededLabels.has(label)) label = `${dataset}_${sanitize}_p${blockLabel}_${shape}_${suffix++}`;
    seededLabels.add(label);
    receipts.push({
      label,
      providerClass: "a2aj-case",
      dataset,
      shape,
      url,
      anchor: `par${blockLabel}`,
      blockText: blocks.find((b) => b.label === blockLabel)?.text ?? "",
      quotes: [quote],
    });
  };

  // Receipt 1: short exact window near a deterministic block choice.
  const shortBlock = blocks[Math.floor(rng() * blocks.length)];
  const shortQuote = wordSlice(shortBlock.text, 2, 9);
  if (shortQuote) pushReceipt(shortBlock.label, "short-exact", shortQuote);

  // Receipt 2: authority-cluster window when present, else long range.
  const order = [0.5, 0.25, 0.75, 0.08, 0.92].map(
    (fraction) => blocks[Math.min(blocks.length - 1, Math.floor(blocks.length * fraction))],
  );
  let hardDone = false;
  for (const block of order) {
    if (hardDone) break;
    for (const hit of findWindows(block.text)) {
      const centre = wordIndexAt(block.text, hit.index);
      const start = Math.max(0, centre - 8);
      const width = hit.tag === "hard-act-name" ? 16 : 22;
      const quote = wordSlice(block.text, start, width);
      if (!quote) continue;
      pushReceipt(block.label, hit.tag, quote);
      hardDone = true;
      break;
    }
  }
  if (!hardDone) {
    const longBlock = blocks[Math.floor(rng() * blocks.length)];
    const longStart = Math.floor(longBlock.text.split(/\s+/u).length * 0.15);
    const longQuote = wordSlice(longBlock.text, longStart, 70);
    if (longQuote) pushReceipt(longBlock.label, "long-range", longQuote);
  }
  return receipts;
}

async function main() {
  const quotas = planQuotas();
  console.log(JSON.stringify({ event: "quota-plan", datasets: quotas.size, target: TARGET_DECISIONS }));

  const perDatasetDone = new Map();
  for (const row of manifest.values()) {
    perDatasetDone.set(row.dataset, (perDatasetDone.get(row.dataset) ?? 0) + 1);
  }

  for (const [dataset, quota] of [...quotas.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const done = perDatasetDone.get(dataset) ?? 0;
    let needed = quota - done;
    if (needed <= 0) continue;

    // Collect fresh candidate citations via rotating full-text searches.
    const candidates = [];
    for (let page = 0; page < 8 && candidates.length < needed * 3; page += 1) {
      const query = SEARCH_QUERIES[(page + hash32(dataset)) % SEARCH_QUERIES.length];
      let hits = [];
      try {
        hits = await a2ajLegalSourceProvider.search({
          text: query, kinds: ["case"], language: "en", perProviderLimit: 50,
          collection: dataset,
        }) ?? [];
      } catch (error) {
        console.log(JSON.stringify({ event: "search-error", dataset, error: String(error).slice(0, 100) }));
        break;
      }
      for (const hit of hits) {
        const citation = hit?.citation;
        if (!citation || manifest.has(citation)) continue;
        candidates.push({ citation, url: typeof hit?.url === "string" ? hit.url : "" });
        if (candidates.length >= needed * 3) break;
      }
      await sleep(SLEEP_MS);
    }
    if (!candidates.length) {
      console.log(JSON.stringify({ event: "dataset-starved", dataset, needed }));
      continue;
    }

    for (const candidate of candidates) {
      if (needed <= 0) break;
      const { citation } = candidate;
      let lookup = null;
      try {
        lookup = await a2ajLegalSourceProvider.lookup({
          citation, docType: "cases", language: "en", kind: "paragraph", locator: "1",
        });
      } catch (error) {
        appendJsonl(manifestPath, { citation, dataset, url: candidate.url, status: `lookup-error` });
        manifest.set(citation, {});
        continue;
      }
      await sleep(SLEEP_MS);
      if (!lookup || lookup.status !== "found") {
        appendJsonl(manifestPath, { citation, dataset, url: candidate.url, status: `lookup-${lookup?.status ?? "null"}` });
        manifest.set(citation, {});
        continue;
      }
      const url = typeof lookup.url === "string" ? lookup.url : "";
      if (!/^https?:\/\//iu.test(url)) {
        appendJsonl(manifestPath, { citation, dataset, url, status: "no-public-url" });
        manifest.set(citation, {});
        continue;
      }
      const source = a2ajLegalSourceProvider.source(lookup);
      const receipts = source?.blocks?.length
        ? receiptsForDoc(citation, dataset, url, source)
        : [];
      appendJsonl(manifestPath, {
        citation, dataset, url,
        status: receipts.length ? "ok" : "no-blocks",
        receipts: receipts.length,
      });
      manifest.set(citation, {});
      for (const receipt of receipts) appendJsonl(seedsPath, receipt);
      needed -= 1;
      if ((manifest.size % 25) === 0) {
        console.log(JSON.stringify({ event: "progress", decisionsSeen: manifest.size, pendingQuota: needed }));
      }
    }
    console.log(JSON.stringify({ event: "dataset-complete", dataset, quota, added: quota - done - needed }));
  }

  const statuses = {};
  for (const row of await loadJsonl(manifestPath)) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  console.log(JSON.stringify({
    event: "harvest-done", decisions: manifest.size, statuses,
    seeds: (await loadJsonl(seedsPath)).length,
  }));
}

main();
