// Purges Decisia-family cache entries (JS-injected shells) so the crawl can
// re-fetch them with a longer settle that captures the rendered decision.
import fs from "node:fs";
import path from "node:path";

const resultsDir = "experiments/text-fragment-fidelity/results";
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
const rows = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const isDecisiaFamily = (url) =>
  /decisia\.lexum\.com|decisions?\.[\w-]+\.(?:gc\.)?ca|coadecisions\.|decision\.tcc-cci\.gc\.ca/iu.test(url);
const kept = rows.filter((r) => !isDecisiaFamily(r.url));
const purged = rows.filter((r) => isDecisiaFamily(r.url));
fs.writeFileSync(manifestPath, `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`);
for (const row of purged) {
  if (row.file) {
    const file = path.join(resultsDir, "page-html", row.file);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
console.log(JSON.stringify({ purged: purged.length, kept: kept.length }));
