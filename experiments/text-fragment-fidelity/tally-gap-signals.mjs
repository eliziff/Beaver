import fs from "node:fs";
import path from "node:path";

const dir = "experiments/text-fragment-fidelity/results/pagecache";
const classes = fs.readFileSync("experiments/text-fragment-fidelity/results/flagged-classes.json", "utf8")
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const seeds = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const actionable = classes.filter((r) => r.klass === "projection-gap" || r.klass === "quote-restyled");
const tally = {};
const examples = {};
for (const c of actionable) {
  const seed = seeds.get(c.label);
  if (!seed) continue;
  const safe = c.label.replace(/[^\w.-]+/gu, "_");
  const file = path.join(dir, `${safe}.txt`);
  if (!fs.existsSync(file)) { tally.noCache = (tally.noCache ?? 0) + 1; continue; }
  const text = fs.readFileSync(file, "utf8");
  const quote = seed.quotes[0];
  const signals = [];
  if (/\b(s|ss|para|paras|art|p|pp)\.\u00A0\d/iu.test(text) && /\b(s|ss|para|paras|art|p|pp)\.\s?\d/iu.test(quote)) {
    signals.push("nbsp-pinpoint");
  }
  if (/[\u201C\u201D]/u.test(text) && /"/u.test(quote)) signals.push("curly-quote");
  if (/[:.]\s+[A-Z]/u.test(quote)) signals.push("sentence-join");
  if (/^\[?\d{1,3}\]?\b/u.test(seed.blockText.trim()) && /:\s+[A-Z]/u.test(quote)) signals.push("numbered-lead-in");
  for (const signal of signals.length ? signals : ["unexplained"]) {
    tally[signal] = (tally[signal] ?? 0) + 1;
    examples[signal] = examples[signal] ?? [];
    if (examples[signal].length < 5) examples[signal].push(c.label);
  }
}
console.log(JSON.stringify({ actionable: actionable.length, tally }, null, 1));
for (const [key, list] of Object.entries(examples)) console.log(`${key}: ${list.join(", ")}`);
