import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultNativeAddon, nativeAddonFile } from "../shared/nativeAddonFile.mjs";
import { structureEngineAddon } from "../shared/structure-engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(root, "native", "legal-structure-node");
const binary = process.env.LEGAL_STRUCTURE_NATIVE?.trim() || defaultNativeAddon(nativeRoot);
// The first reading includes loading the engine, as Beaver loads it, with no sample warm-up.
const coldStarted = performance.now(), module = { exports: {} };
process.dlopen(module, nativeAddonFile(binary, nativeRoot));
const parse = structureEngineAddon(module.exports).citationOccurrencesInText;
const input = `
R v Grant, 2009 SCC 32, [2009] 2 SCR 353 at para 29; R v Oakes,
[1986] 1 SCR 103, 1986 CanLII 46 (SCC); Canada v Vavilov, 2019 SCC 65,
[2019] 4 SCR 653 at paras 10–12; R v Jordan, 2016 SCC 27, [2016] 1 SCR 631;
Alberta (Information and Privacy Commissioner) v University of Calgary,
2016 SCC 53, [2016] 2 SCR 555; Federal Courts Rules, SOR/98-106, rr 369–370.
`;
const samples = 51, budgetMs = 50, coldBudgetMs = 500;
const times = [], required = ["2009 SCC 32", "[2009] 2 SCR 353", "1986 CanLII 46",
  "[1986] 1 SCR 103", "2019 SCC 65", "[2019] 4 SCR 653", "2016 SCC 27", "[2016] 1 SCR 631"];
let occurrences = [], coldMs;
for (let index = 0; index < samples; index++) {
  const started = performance.now();
  occurrences = parse(`${input}\nMeasured sample ${index}.`);
  const elapsed = performance.now() - started;
  if (index === 0) coldMs = performance.now() - coldStarted;
  else times.push(elapsed);
  const found = occurrences.map(({ text }) => text).join("\n");
  if (required.some(citation => !found.includes(citation)))
    throw new Error(`Native citation sample ${index} missed expected citations: ${found}`);
}

times.sort((left, right) => left - right);
const medianMs = times[Math.floor(times.length / 2)], p95Ms = times[Math.floor(times.length * .95)];
const result = { schema_version: "beaver.authorities-citation-performance.v2",
  machine_test: true, runId: randomUUID(), binary: relative(root, binary), changingInputs: true,
  cold: { ms: +coldMs.toFixed(3), budgetMs: coldBudgetMs },
  warm: { samples: times.length, budgetMs, medianMs: +medianMs.toFixed(3),
    p95Ms: +p95Ms.toFixed(3), maxMs: +times.at(-1).toFixed(3) },
  occurrences: occurrences.length };
console.log(JSON.stringify(result));
if (coldMs > coldBudgetMs || p95Ms > budgetMs) process.exitCode = 1;
