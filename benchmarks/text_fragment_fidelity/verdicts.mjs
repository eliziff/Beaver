#!/usr/bin/env node
// Verdicts of cache-tier rows, one per seed id (the last row for an id wins), judged by what was painted against the
// intended words:
//   hit                  >= 90% of the paint inside the intended words' box, not front matter;
//   straddles            50-90% inside: a slight under- or overpaint, logged, not a miss;
//   painted elsewhere    paint mostly outside the intended words (a wrong place: must never rise);
//   front matter         paint above the first body paragraph (a wrong place);
//   anchor only          nothing painted, the intended words in view (the #par/#sec landing still works);
//   no paint             nothing painted and the intended words not in view;
//   painted, target unknown / no cached page / pdf page / error.
// A row whose link has no text directive is "no fragment" whatever it painted.
// Usage: node verdicts.mjs <seeds.jsonl> <cache-tier.jsonl>... [--by strategy,host] [--json per-seed.jsonl]
//          [--before per-seed.jsonl]  (transitions from an earlier --json, by the same grouping)
import fs from "node:fs";

const argv = process.argv.slice(2);
const option = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
const positional = argv.filter((value, index) => !value.startsWith("--") && !argv[index - 1]?.startsWith("--"));
const [seedsPath, ...gatePaths] = positional;
const by = (option("--by") ?? "strategy,host").split(",");
const lines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.startsWith("{"));
const rows = new Map();
for (const file of gatePaths) for (const line of lines(file)) {
  const row = JSON.parse(line);
  rows.set(row.id, row);
}
const seeds = lines(seedsPath).map((line) => JSON.parse(line));
const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
const seedOf = (row) => seedById.get(row.id);
const words = (text) => (text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
// A passage's printed label ("[85]", "(a)", "2(1)") is left out of its fragment by design (LESSONS: label trimming).
const intendedWords = (seed) => words((seed.target?.texts ?? []).join(" ")
  .replace(/^\s*(?:(?:\[[^\]]{1,8}\]|\([^)]{1,6}\)|\d+(?:\.\d+)*[.)]?|[a-z][.)]|[ivxlc]{1,5}[.)])\s+)+/iu, ""));
// The intended words the paint left out (under) and the painted words it did not intend (over), by word, in order.
function difference(from, minus) {
  const left = new Map();
  for (const word of minus) left.set(word, (left.get(word) ?? 0) + 1);
  return from.filter((word) => left.get(word) ? (left.set(word, left.get(word) - 1), false) : true);
}
const VIEW = 900;
export function verdict(row) {
  if (!row) return "not gated";
  if (row.error) return /not in any local store/u.test(row.error) ? "no cached page"
    : /pdf page/u.test(row.error) ? "pdf page" : "error";
  if (!row.url.includes(":~:text=")) return "no fragment";
  const target = row.target;
  const inView = !!target && target.bottom > 0 && target.top < VIEW;
  if (!row.painted) return (target ? inView : row.pinpointInView) ? "anchor only" : "no paint";
  if (row.frontMatter) return "front matter";
  // Where the intended words' place on the page is not known (they occur several times and no anchor tells which, or
  // they were not found whole), the paint is judged by the words it covers: on the intended words or not.
  if (target?.ambiguous || row.paintInTarget === undefined || row.paintInTarget === null) {
    if (!seedOf(row)) return "painted, target unknown";
    const painted = words(row.paintedWords), intended = new Set(intendedWords(seedOf(row)));
    const on = painted.filter((word) => intended.has(word)).length;
    return !painted.length ? "painted, target unknown" : on >= 0.8 * painted.length ? "hit (placed by words)"
      : on >= 0.5 * painted.length ? "straddles" : "painted elsewhere";
  }
  return row.paintInTarget >= 0.9 ? "hit" : row.paintInTarget >= 0.5 ? "straddles" : "painted elsewhere";
}

const ORDER = ["hit", "hit (placed by words)", "straddles", "anchor only", "no paint", "painted elsewhere", "front matter",
  "painted, target unknown", "no fragment", "no cached page", "pdf page", "error", "not gated"];
const out = seeds.map((seed) => {
  const row = rows.get(seed.id);
  const intended = intendedWords(seed);
  const painted = words(row?.paintedWords);
  return { id: seed.id, group: by.map((field) => seed[field] ?? "").join(" | "), verdict: verdict(row),
    ambiguous: !!row?.target?.ambiguous,
    ...row?.painted && { under: difference(intended, painted).join(" "), over: difference(painted, intended).join(" ") } };
});
const groups = new Map();
for (const { group, verdict } of out) {
  const counts = groups.get(group) ?? new Map();
  counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  groups.set(group, counts);
}
const columns = ORDER.filter((name) => out.some(({ verdict }) => verdict === name));
const total = new Map(columns.map((name) => [name, out.filter(({ verdict }) => verdict === name).length]));
console.log(`| ${by.join(" | ")} | ${columns.join(" | ")} |`);
console.log(`|${by.map(() => "---").join("|")}|${columns.map(() => "---:").join("|")}|`);
for (const [group, counts] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
  console.log(`| ${group} | ${columns.map((name) => counts.get(name) ?? 0).join(" | ")} |`);
console.log(`| all${" |".repeat(by.length - 1)} | ${columns.map((name) => total.get(name)).join(" | ")} |`);
const ambiguous = out.filter(({ ambiguous }) => ambiguous).length;
if (ambiguous) console.log(`\n${ambiguous} rows located their intended words by occurrence order alone (no anchor).`);
const before = option("--before");
if (before) {
  const earlier = new Map(lines(before).map((line) => JSON.parse(line)).map((row) => [row.id, row.verdict]));
  const moves = new Map();
  for (const { id, verdict } of out) {
    const was = earlier.get(id);
    if (was !== undefined && was !== verdict) moves.set(`${was} -> ${verdict}`, (moves.get(`${was} -> ${verdict}`) ?? 0) + 1);
  }
  console.log("\nTransitions:");
  for (const [move, count] of [...moves].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${move}`);
}
const json = option("--json");
if (json) fs.writeFileSync(json, out.map((row) => JSON.stringify(row)).join("\n") + "\n");
