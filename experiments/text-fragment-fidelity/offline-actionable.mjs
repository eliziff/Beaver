// Offline validation: for every actionable failure with a cached rendered
// page (pagecache), build the candidate URL and check whether ANY directive
// spelling now appears in the rendered text. Lenient matcher (whitespace-run
// insensitive, NBSP-folded, punctuation-exact): if even this fails, the
// variant set is missing a spelling - i.e. a new error class.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seeds = new Map(
  fs.readFileSync(path.join(resultsDir, "seeds.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const actionable = new Set(
  fs.readFileSync(path.join(resultsDir, "flagged-classes.json"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => ["projection-gap", "quote-restyled", "styling-difference"].includes(r.klass))
    .map((r) => r.label),
);
const { buildLegalSourcePinpointUrl } = await import(
  pathToFileURL(path.join(here, "builder-candidate.ts")).href
);

const tokenize = (text) =>
  String(text).replace(/\u00A0/gu, " ").split(/\s+/u).filter(Boolean).map((t) => t.toLowerCase());
function phraseFound(phrase, tokens) {
  const words = tokenize(phrase);
  if (!words.length) return false;
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    if (words.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}
function directivePhrases(frag) {
  const pieces = frag.split("&text=").map((p) => {
    const trimmed = p.replace(/%(?![0-9A-Fa-f]{2})/gu, "");
    try { return decodeURIComponent(trimmed); } catch { return trimmed; }
  });
  const out = [];
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.includes("-, ") || piece.includes(" ,-") || piece.includes("-, ")) {
      // context form(s): isolate the target between -markers
      let target = piece;
      target = target.replace(/^[^,]*-,/u, "").replace(/,-[^,]*$/u, "");
      if (target) out.push(target.trim());
    } else if (piece.includes(",")) {
      const [start, end] = piece.split(",");
      out.push(start.trim(), end.trim());
    } else {
      out.push(piece.trim());
    }
  }
  return out.filter(Boolean);
}

const results = [];
for (const label of actionable) {
  const seed = seeds.get(label);
  if (!seed) continue;
  const safe = label.replace(/[^\w.-]+/gu, "_");
  const cachePath = path.join(resultsDir, "pagecache", `${safe}.txt`);
  if (!fs.existsSync(cachePath)) continue;
  const rendered = fs.readFileSync(cachePath, "utf8");
  const tokens = tokenize(rendered);
  const url = buildLegalSourcePinpointUrl(
    { url: seed.url, anchor: seed.anchor, blockText: seed.blockText },
    seed.quotes ?? [],
  );
  const frag = url?.split(":~:text=")[1] ?? "";
  const phrases = directivePhrases(frag);
  const matched = phrases.map((phrase) => ({ phrase, found: phraseFound(phrase, tokens) }));
  const resolved = matched.some((m) => m.found);
  results.push({ label, dataset: seed.dataset, shape: seed.shape, resolved, phrases: matched.filter((m) => !m.found).map((m) => m.phrase.slice(0, 60)) });
}
fs.writeFileSync(
  path.join(resultsDir, "offline-actionable.json"),
  `${results.map((r) => JSON.stringify(r)).join("\n")}\n`,
);
const resolvedCount = results.filter((r) => r.resolved).length;
const missing = results.filter((r) => !r.resolved);
const byShape = {};
for (const r of missing) byShape[r.shape] = (byShape[r.shape] ?? 0) + 1;
console.log(JSON.stringify({ checked: results.length, resolved: resolvedCount, missing: missing.length, missingByShape: byShape }, null, 1));
console.log("---- still-missing labels:");
for (const r of missing) console.log(`${r.dataset} ${r.shape} ${r.label}`);
