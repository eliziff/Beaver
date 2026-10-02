// Classifies every wrong match eval.ts recorded for the chosen configurations and writes
// wrong-matches.tsv (public case metadata only). Run after eval.ts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nameTokens } from "./lib";

const CONFIGS = ["crown/aware2/none", "exact/aware/none"];
const wrongs = JSON.parse(readFileSync(path.join(__dirname, "results", "wrong-matches.json"), "utf8")) as
  Record<string, { style: string; cite: string; dataset: string; year: number; picked: string; truth: string }[]>;
const jaccard = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared || 1);
};

const lines = ["config\tset\tcategory\tcited style\tcited\tcourt\tyear\tpicked (name | citations | dataset | date)\tknown record"];
const counts: Record<string, Record<string, number>> = {};
for (const [key, list] of Object.entries(wrongs)) {
  const [set, config] = key.split(" :: ");
  if (!CONFIGS.includes(config)) continue;
  for (const w of list) {
    const [truthName, , truthDataset, truthDate] = w.truth.split(" | ");
    const truthYear = Number(truthDate.slice(0, 4));
    let category: string;
    if (set === "scc-own-name-reporter-year") category = "reporter-year window: same-name SCC decision in window, known record outside it";
    else if (truthYear !== w.year) category = "A2AJ decision date in another year than the citation";
    else if (truthDataset !== w.dataset) category = "known record filed under another A2AJ dataset";
    else if (/ c\.? /u.test(truthName) && !/ v\.? /u.test(truthName)) category = "known record named in French only";
    else if (jaccard(nameTokens(truthName), nameTokens(w.style)) >= 0.5) category = "known record's A2AJ name is a variant (typo, punctuation, abbreviation, given name)";
    else category = "known record's A2AJ name is a different style (other party, other title)";
    ((counts[`${config} :: ${set}`] ??= {})[category] = (counts[`${config} :: ${set}`][category] ?? 0) + 1);
    lines.push([config, set, category, w.style, w.cite, w.dataset, w.year, w.picked, w.truth].join("\t"));
  }
}
writeFileSync(path.join(__dirname, "wrong-matches.tsv"), lines.join("\n") + "\n");
console.log(JSON.stringify(counts, null, 1));
