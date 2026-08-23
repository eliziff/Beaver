import fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: node profile-timings.mjs <result.jsonl>");
const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const names = new Set(rows.flatMap((row) => Object.keys(row.timings ?? {})).filter((name) => name !== "polls"));
const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
const phases = [...names].map((name) => {
  const values = rows.map((row) => row.timings?.[name] ?? 0).sort((a, b) => a - b);
  return {
    phase: name,
    totalMs: Math.round(values.reduce((sum, value) => sum + value, 0)),
    meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: Math.round(percentile(values, 0.5)),
    p90Ms: Math.round(percentile(values, 0.9)),
  };
}).sort((a, b) => b.totalMs - a.totalMs);
const elapsed = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
console.log(JSON.stringify({
  rows: rows.length,
  elapsed: {
    totalMs: elapsed.reduce((sum, value) => sum + value, 0),
    meanMs: Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length),
    p50Ms: percentile(elapsed, 0.5),
    p90Ms: percentile(elapsed, 0.9),
  },
  phases,
}, null, 2));
