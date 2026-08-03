import { DatabaseSync } from "node:sqlite";
import { standsForProfile } from "../src/lib/caselawCitator";
const db = new DatabaseSync(
  `${process.env.LOCALAPPDATA}/ALR Quote Verifier/citator/noteup.sqlite`,
  { readOnly: true },
);
// Sample real citations spanning the citer-count distribution.
const rows = db.prepare(
  `SELECT cited_citation AS c, COUNT(DISTINCT case_id) AS n FROM edge
   GROUP BY cited_key ORDER BY n DESC LIMIT 40`,
).all() as Array<{ c: string; n: number }>;
const mid = db.prepare(
  `SELECT cited_citation AS c, COUNT(DISTINCT case_id) AS n FROM edge
   GROUP BY cited_key HAVING n BETWEEN 2 AND 12 LIMIT 40`,
).all() as Array<{ c: string; n: number }>;
db.close();
for (const [label, set] of [["top-cited", rows], ["thin (2-12 citers)", mid]] as const) {
  const times: number[] = [];
  for (const r of set) {
    const a = performance.now();
    standsForProfile({ citation: r.c, size: 8 });
    times.push(performance.now() - a);
  }
  times.sort((x, y) => x - y);
  const sum = times.reduce((x, y) => x + y, 0);
  console.log(
    `${label.padEnd(20)} n=${set.length} total ${sum.toFixed(0)}ms | ` +
    `median ${times[Math.floor(times.length / 2)].toFixed(0)}ms | ` +
    `p90 ${times[Math.floor(times.length * 0.9)].toFixed(0)}ms | ` +
    `max ${times[times.length - 1].toFixed(0)}ms`,
  );
}
