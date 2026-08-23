import fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: node score-find-probe.mjs <webdriver-result.jsonl>");
const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const point = (rect, end = false) => rect && ({ y: rect.y, x: rect.x + (end ? rect.width : 0) });
const order = (left, right) => Math.abs(left.y - right.y) > 2 ? left.y - right.y : left.x - right.x;
const same = (left, right) => Math.abs(left.y - right.y) <= 2 && Math.abs(left.x - right.x) <= 6;
const tally = {};
const agreement = {};

for (const row of rows) {
  const intended = row.quotes?.[0]?.documentRects ?? [];
  const expectedStart = point(intended[0]);
  const expectedEnd = point(intended.at(-1), true);
  const matched = (row.findRanges ?? []).filter((range) => range.status === "matched" && range.first && range.last);
  let verdict;
  if (!expectedStart || !expectedEnd) verdict = "intended-not-located";
  else if (!matched.length) verdict = "no-match";
  else if (matched.some((range) => order(point(range.first), expectedStart) < -6 || order(point(range.last, true), expectedEnd) > 6)) verdict = "stray-range";
  else if (!matched.some((range) => same(point(range.first), expectedStart)) || !matched.some((range) => same(point(range.last, true), expectedEnd))) verdict = "partial-range";
  else verdict = "exact-range";
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  const heavyExact = row.verdict === "exact-match";
  const lightExact = verdict === "exact-range";
  const key = `${heavyExact ? "heavy-pass" : "heavy-fail"}/${lightExact ? "light-pass" : "light-fail"}`;
  agreement[key] = (agreement[key] ?? 0) + 1;
  row.findVerdict = verdict;
}

console.log(JSON.stringify({rows: rows.length, tally, agreement}, null, 2));
for (const row of rows.filter((candidate) => (candidate.verdict === "exact-match") !== (candidate.findVerdict === "exact-range"))) {
  console.log(JSON.stringify({label: row.label, heavy: row.verdict, light: row.findVerdict}));
}
