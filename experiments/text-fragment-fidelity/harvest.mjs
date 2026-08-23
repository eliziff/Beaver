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
const TARGET_DECISIONS = Number(process.env.CORPUS_TARGET ?? (process.argv.includes("--laws") ? 400 : 1000));
const PER_DATASET_FLOOR = process.argv.includes("--laws") ? 15 : 10;
const SLEEP_MS = process.argv.includes("--laws") ? 250 : 1050;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DOC_TYPE = process.argv.includes("--laws") ? "laws" : "cases";
const KIND = DOC_TYPE === "laws" ? "section" : "paragraph";
const BLOCK_KIND = DOC_TYPE === "laws" ? "section" : "paragraph";
const DOC_KIND = DOC_TYPE === "laws" ? "legislation" : "case";
const ANCHOR_PREFIX = DOC_TYPE === "laws" ? "sec" : "par";

// Principle: reliability over completeness — drop tiny hard bits at edges,
// paint the core, never paint extraneous content. Harvest centres hard tokens
// interior (centre -8) so edges are clean prose; builder variants cover
// interior hard bits. Multi-directive windows use trimmed short-exact cores
// with ≥10-word separation and uniqueness verification.
const HARVEST_LEADING_LABELS = [
  /^\[\s*\d{1,4}\s*\]\s*/u,
  /^\d{1,4}\]\s*/u,
  /^\d{1,4}(?:\.\d{1,4})*\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+/u,
  /^\(\s*[A-Za-z0-9]{1,5}\s*\)\s*/u,
  /^[A-Za-z]{1,3}\)\s*/u,
  /^\d{1,4}[.)]\s*/u,
  /^\d{1,4}\s+(?=[A-Z“"(])/u,
];
function stripHarvestLeadingLabels(text) {
  let stripped = text;
  for (let iter = 0; iter < 4; iter += 1) {
    let changed = false;
    for (const pattern of HARVEST_LEADING_LABELS) {
      const match = stripped.match(pattern)?.[0];
      if (match && match.length < stripped.trimEnd().length) {
        stripped = stripped.slice(match.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return stripped.trim();
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    if (count > 1) break;
    pos += needle.length;
  }
  return count;
}
function isUniquePhrase(haystack, phrase) {
  return countOccurrences(haystack, phrase) === 1;
}

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
  const casesCov = await a2ajLegalSourceProvider.coverage("cases");
  const lawsCov = await a2ajLegalSourceProvider.coverage("laws");
  fs.writeFileSync(coveragePath, JSON.stringify([...casesCov, ...lawsCov], null, 1));
  await sleep(SLEEP_MS);
}
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));

function planQuotas() {
  const usable = coverage
    .filter((row) => row.docType === DOC_TYPE && row.documentCount > 0)
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
  const base = [
    [/\((?:[a-z][\w.'’ ]{0,28})?,? at paras?\.\s*\d/gu, "hard-case-cite"],
    [/(?:^|[^a-z])s\.\s?\d/gu, "hard-statute-ref"],
    [/\bsections?\s+\d/gu, "hard-section-word"],
    [/\b(act|code|regulations?|rules)\b/gu, "hard-act-name"],
  ];
  const hardLegislation = DOC_TYPE === "laws" ? [
    [/\b\d+\(\d+\)(?:\([a-z]+\))?(?:\([ivx]+\))?/gu, "hard-nested-subsection"],
    [/\b(regulations?|act|code)\b[^.]{0,40}\bs\.\s*\d/gu, "hard-statute-in-provision"],
    [/\bs\.\s*\d+\(\d+\)/gu, "hard-statute-subsection"],
  ] : [];
  for (const [pattern, tag] of [...base, ...hardLegislation]) {
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
    .filter((block) => block.kind === BLOCK_KIND)
    .map((block) => ({
      label: String(block.label ?? "").replace(new RegExp(`^${ANCHOR_PREFIX}`, "i"), ""),
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
    let label = `${dataset}_${sanitize}_${ANCHOR_PREFIX}${blockLabel}_${shape}`;
    let suffix = 2;
    while (seededLabels.has(label)) label = `${dataset}_${sanitize}_${ANCHOR_PREFIX}${blockLabel}_${shape}_${suffix++}`;
    seededLabels.add(label);
    receipts.push({
      label,
      providerClass: DOC_TYPE === "laws" ? "a2aj-legislation" : "a2aj-case",
      dataset,
      shape,
      url,
      anchor: `${ANCHOR_PREFIX}${blockLabel}`,
      blockText: blocks.find((b) => b.label === blockLabel)?.text ?? "",
      quotes: [quote],
    });
  };

  // Receipt 1: short exact window near a deterministic block choice.
  const shortBlock = blocks[Math.floor(rng() * blocks.length)];
  const shortQuote = wordSlice(shortBlock.text, 2, 9);
  if (shortQuote) pushReceipt(shortBlock.label, "short-exact", shortQuote);

  // Receipt 2: authority-cluster window when present, else long range.
  // Principle: hard token is centred interior (centre -8 → ≥8 words lead, 8-14 trail)
  // so edges are clean prose; builder variants cover interior hard bits. Edges
  // are trimmed if a tiny label leaked in, preserving the core.
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
      const raw = wordSlice(block.text, start, width);
      if (!raw) continue;
      const quote = stripHarvestLeadingLabels(raw);
      if (!quote || quote.split(/\s+/u).length < 10) continue;
      // Verify hard token still present interior (not trimmed away) — crude check that
      // cleaned quote still contains a hard-ish fragment (digit or Act/Code word).
      const lower = quote.toLowerCase();
      const stillHard = /(?:\d\(|\bs\.\s*\d|\bsections?\s+\d|\bact\b|\bcode\b|\bregulations?\b)/u.test(lower)
        || hit.tag === "hard-case-cite";
      if (!stillHard && hit.tag !== "hard-case-cite") {
        // If trimming removed the hit entirely, skip this hit and try next block.
        // The centre -8 already made the hit interior; stripping should not erase it.
        continue;
      }
      pushReceipt(block.label, hit.tag, quote);
      hardDone = true;
      break;
    }
  }
  if (!hardDone) {
    const longBlock = blocks[Math.floor(rng() * blocks.length)];
    const longStart = Math.floor(longBlock.text.split(/\s+/u).length * 0.15);
    const longQuote = wordSlice(longBlock.text, longStart, 70);
    if (longQuote) {
      const cleanedLong = stripHarvestLeadingLabels(longQuote);
      pushReceipt(longBlock.label, "long-range", cleanedLong || longQuote);
    }
  }

  // Receipt 3: multi-directive — two short-exact cores in SAME block, ≥10 words apart,
  // each leader-trimmed and verified distinct (non-overlapping, unique in block).
  // Builder will emit one URL with two text= directives; reliability over
  // completeness means each core is a clean core, not a hard edge.
  {
    let multiDone = false;
    // Deterministic candidate order: shuffle blocks with document-seeded rng.
    const multiCandidates = [...blocks];
    for (let i = multiCandidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = multiCandidates[i];
      multiCandidates[i] = multiCandidates[j];
      multiCandidates[j] = tmp;
    }
    for (const candidate of multiCandidates) {
      if (multiDone) break;
      const tokens = candidate.text.split(/\s+/u);
      if (tokens.length < 32) continue;
      const startA = 2;
      const rawA = wordSlice(candidate.text, startA, 9);
      if (!rawA) continue;
      const windowA = stripHarvestLeadingLabels(rawA);
      if (!windowA || windowA.split(/\s+/u).length < 6) continue;
      if (!isUniquePhrase(candidate.text, windowA)) continue;
      const minStartB = startA + 9 + 10;
      const maxStartB = tokens.length - 9;
      if (minStartB > maxStartB) continue;
      const mid = Math.floor(tokens.length * 0.5);
      let baseB = Math.max(minStartB, mid);
      if (baseB > maxStartB) baseB = minStartB;
      const attempts = [baseB, baseB + 3, Math.max(minStartB, baseB - 5), minStartB, maxStartB - 4];
      let windowB = null;
      let finalStartB = baseB;
      for (const candStart of attempts) {
        if (candStart < minStartB || candStart > maxStartB) continue;
        const rawB = wordSlice(candidate.text, candStart, 9);
        if (!rawB) continue;
        const cleanedB = stripHarvestLeadingLabels(rawB);
        if (!cleanedB || cleanedB.split(/\s+/u).length < 6) continue;
        if (cleanedB === windowA) continue;
        if (!isUniquePhrase(candidate.text, cleanedB)) continue;
        windowB = cleanedB;
        finalStartB = candStart;
        break;
      }
      if (!windowB) continue;
      if (finalStartB < startA + 9 + 10) continue;
      let label = `${dataset}_${sanitize}_${ANCHOR_PREFIX}${candidate.label}_multi-directive`;
      let suffix = 2;
      while (seededLabels.has(label)) label = `${dataset}_${sanitize}_${ANCHOR_PREFIX}${candidate.label}_multi-directive_${suffix++}`;
      seededLabels.add(label);
      receipts.push({
        label,
        providerClass: DOC_TYPE === "laws" ? "a2aj-legislation" : "a2aj-case",
        dataset,
        shape: "multi-directive",
        url,
        anchor: `${ANCHOR_PREFIX}${candidate.label}`,
        blockText: candidate.text,
        quotes: [windowA, windowB],
      });
      multiDone = true;
    }
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
          text: query, kinds: [DOC_KIND], language: "en", perProviderLimit: 50,
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
          citation, docType: DOC_TYPE, language: "en", kind: KIND, locator: "1",
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
