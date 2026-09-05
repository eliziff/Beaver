import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.LEGAL_STRUCTURE_NATIVE?.trim() || resolve(root,
  "native", "legal-structure-node", "target", "release",
  process.platform === "win32" ? "legal_structure_node.dll"
    : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so");
const module = { exports: {} };
process.dlopen(module, binary);
const parse = module.exports.citationOccurrencesInText;
if (typeof parse !== "function") throw new Error("Native citation parser is unavailable");
const input = `
R v Grant, 2009 SCC 32, [2009] 2 SCR 353 at para 29; R v Oakes,
[1986] 1 SCR 103, 1986 CanLII 46 (SCC); Canada v Vavilov, 2019 SCC 65,
[2019] 4 SCR 653 at paras 10–12; R v Jordan, 2016 SCC 27, [2016] 1 SCR 631;
Alberta (Information and Privacy Commissioner) v University of Calgary,
2016 SCC 53, [2016] 2 SCR 555; Federal Courts Rules, SOR/98-106, rr 369–370.
`;
const warmups = 10, samples = 51, budgetMs = 50;
for (let index = 0; index < warmups; index++) parse(`${input}\nWarm-up ${index}.`);
const times = [], required = ["2009 SCC 32", "[2009] 2 SCR 353", "1986 CanLII 46",
  "[1986] 1 SCR 103", "2019 SCC 65", "[2019] 4 SCR 653", "2016 SCC 27", "[2016] 1 SCR 631"];
let occurrences = [];
for (let index = 0; index < samples; index++) {
  const started = performance.now();
  occurrences = parse(`${input}\nMeasured sample ${index}.`);
  times.push(performance.now() - started);
}
const found = occurrences.map(({ text }) => text).join("\n");
if (required.some(citation => !found.includes(citation)))
  throw new Error(`Native citation proof missed expected citations: ${found}`);
times.sort((left, right) => left - right);
const medianMs = times[Math.floor(samples / 2)];
const result = { schema_version: "beaver.authorities-citation-performance.v1",
  binary, warmups, samples, changingInputs: true, budgetMs,
  medianMs: +medianMs.toFixed(3), p95Ms: +times[Math.floor(samples * .95)].toFixed(3),
  maxMs: +times.at(-1).toFixed(3), occurrences: occurrences.length };
console.log(JSON.stringify(result));
if (medianMs > budgetMs) process.exitCode = 1;
