// Seeds whose built target page is currently cached — lets replay testing
// start while the crawl is still filling.
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
const outPath = path.join(resultsDir, "seeds-cached-now.jsonl");

function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return rawUrl.split("#")[0];
  }
}
const cached = new Set(
  fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return normalizeKey(JSON.parse(l).url); } catch { return null; } })
    .filter(Boolean),
);
const { buildLegalSourcePinpointUrl } = await import(
  pathToFileURL(path.join(here, "builder-candidate.ts")).href
);
const doctext = new Map(
  fs.readFileSync(path.join(resultsDir, "doctext.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.key, r.text]),
);
const seeds = fs.readFileSync(seedsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const out = [];
for (const seed of seeds) {
  const target = buildLegalSourcePinpointUrl(
    {
      url: seed.url,
      ...(seed.anchor ? { anchor: seed.anchor } : {}),
      blockText: seed.blockText,
      ...(doctext.get(seedDocumentKey(seed))
        ? { documentText: doctext.get(seedDocumentKey(seed)) }
        : {}),
    },
    seed.quotes ?? [],
  );
  if (!target) continue;
  if (cached.has(normalizeKey(target.split("#")[0]))) out.push(seed);
}
fs.writeFileSync(outPath, `${out.map((s) => JSON.stringify(s)).join("\n")}\n`);
console.log(JSON.stringify({ cachedPages: cached.size, gateableNow: out.length, of: seeds.length }));
