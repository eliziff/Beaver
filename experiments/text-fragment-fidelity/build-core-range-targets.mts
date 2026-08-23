#!/usr/bin/env node
// Materialize the deliberately minimal one-range-per-quote candidate.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { resolveCachedSourceUrl } from "./source-representation.mjs";

const here = import.meta.dirname;
(globalThis as { __dirname?: string }).__dirname = path.join(here, "../../backend/src/lib");
const {
  buildCoreRangePinpointUrl,
  buildLineCorePinpointUrl,
  buildMaximalPinpointUrl,
  maximalCoreQuotes,
  sourceUrl,
} = await import("./builder-candidate.ts");
const { buildLegalSourcePinpointUrl: buildProductionUrl } = await import(
  pathToFileURL(path.join(here, "../../backend/src/lib/legalSourceLinks.ts")).href);
const results = path.join(here, "results");
const mode = ["line", "hybrid", "maximal"].includes(process.argv[2]) ? process.argv[2] : "range";
const boundary = mode === "range" ? Number(process.argv[2] ?? 1) : 0;
const lines = (file: string) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
function directiveResolves(target: string, documentText: string) {
  const text = normalized(documentText);
  const payload = target.split(":~:")[1] ?? "";
  return payload.split("&").filter((part) => part.startsWith("text=")).some((raw) => {
    const pieces = raw.slice(5).split(",");
    const prefix = pieces[0]?.endsWith("-") ? normalized(decodeURIComponent(pieces.shift()!.slice(0, -1))) : "";
    const suffix = pieces.at(-1)?.startsWith("-") ? normalized(decodeURIComponent(pieces.pop()!.slice(1))) : "";
    if (!pieces.length || pieces.length > 2) return false;
    const startText = normalized(decodeURIComponent(pieces[0]));
    const endText = pieces[1] ? normalized(decodeURIComponent(pieces[1])) : "";
    for (let start = text.indexOf(startText); start >= 0; start = text.indexOf(startText, start + 1)) {
      if (prefix && !text.slice(0, start).trimEnd().endsWith(prefix)) continue;
      const end = endText ? text.indexOf(endText, start + startText.length) : start + startText.length;
      if (end < 0) continue;
      const after = text.slice(end + (endText ? endText.length : 0)).trimStart();
      if (!suffix || after.startsWith(suffix)) return true;
    }
    return false;
  });
}
function quotesResolveUniquely(quotes: string[], documentText: string) {
  const text = normalized(documentText);
  return quotes.every((quote) => {
    const wanted = normalized(quote);
    const first = text.indexOf(wanted);
    return first >= 0 && text.indexOf(wanted, first + 1) < 0;
  });
}
const seeds = lines(path.join(results, "seeds.jsonl")).map(JSON.parse);
const doctext = new Map(lines(path.join(results, "doctext.jsonl")).map((line) => {
  const row = JSON.parse(line);
  return [row.key, row.text] as const;
}));
const missingDocuments = seeds.flatMap((seed) => {
  const key = seedDocumentKey(seed);
  return key && !doctext.has(key) ? [{ label: seed.label, key }] : [];
});
if (missingDocuments.length) throw new Error(`missing ${missingDocuments.length} full documents: ${JSON.stringify(missingDocuments)}`);
let fullDocuments = 0;
const rows = seeds.map((seed) => {
  const documentKey = seedDocumentKey(seed);
  const documentText = doctext.get(documentKey ?? "");
  if (documentText) fullDocuments += 1;
  const evidence = {
    url: resolveCachedSourceUrl(sourceUrl(seed.url, seed.anchor) ?? seed.url),
    ...(seed.anchor ? { anchor: seed.anchor } : {}),
    blockText: seed.blockText ?? "",
    ...(documentText ? { documentText } : {}),
  };
  let target;
  if (mode === "range") target = buildCoreRangePinpointUrl(evidence, seed.quotes ?? [], boundary);
  else if (mode === "maximal") target = buildMaximalPinpointUrl(evidence, seed.quotes ?? []);
  else {
    const candidate = buildLineCorePinpointUrl(evidence, seed.quotes ?? []);
    const fragment = candidate.split(":~:")[1];
    const production = buildProductionUrl(evidence, mode === "hybrid" ? seed.quotes ?? [] : []);
    const pdf = /\.pdf(?:$|[?#])|\/document\.do(?:$|[?#])/iu.test(production.split("#")[0]);
    const useCandidate = mode === "line" || !production.includes(":~:text=") ||
      !directiveResolves(production, documentText ?? "") ||
      pdf && !quotesResolveUniquely(seed.quotes ?? [], documentText ?? "");
    const base = production.split(":~:")[0];
    const separator = base.includes("#") ? ":~:" : "#:~:";
    target = useCandidate && fragment ? `${base}${separator}${fragment}` : production;
  }
  return {
    ...seed,
    paintQuotes: maximalCoreQuotes(evidence, seed.quotes ?? []),
    target,
  };
});
const output = path.join(results, mode === "line" ? "line-core-targets.jsonl" :
  mode === "maximal" ? "maximal-targets.jsonl" :
  mode === "hybrid" ? "hybrid-targets.jsonl" : `core-range-${boundary}-targets.jsonl`);
fs.writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const directives = (target: string) => (target.split(":~:")[1] ?? "").split("&").filter((part) => part.startsWith("text=")).length;
console.log(JSON.stringify({
  targets: rows.length,
  mode,
  boundary,
  fullDocuments,
  blockFallbacks: rows.length - fullDocuments,
  links: rows.filter((row) => directives(row.target)).length,
  directives: rows.reduce((sum, row) => sum + directives(row.target), 0),
  averageUrl: Math.round(rows.reduce((sum, row) => sum + row.target.length, 0) / rows.length),
  maximumUrl: Math.max(...rows.map((row) => row.target.length)),
  output,
}));
