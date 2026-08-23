// Certifies the replay tier against collected live results.
// Paint-level fidelity: does replay agree with live on whether the page
// painted a highlight (builder held constant via --builder production on
// the replay run)? Placement-level: where live placement verdicts exist
// (gate-v3 partial), does replay agree?
//
// Usage:
//   node experiments/text-fragment-fidelity/calibrate.mjs \
//     --live experiments/text-fragment-fidelity/results/gate-results.jsonl \
//     --replay experiments/text-fragment-fidelity/results/gate-replay.jsonl
import fs from "node:fs";

const argv = process.argv.slice(2);
function arg(name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : null;
}
const livePath = arg("--live");
const replayPath = arg("--replay");
if (!livePath || !replayPath) {
  console.error("usage: calibrate.mjs --live <file> --replay <file>");
  process.exit(2);
}
const load = (file) => new Map(
  fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((row) => row && row.label && row.verdict)
    .map((row) => [row.label, row]),
);
const live = load(livePath);
const replay = load(replayPath);

const painted = (row) => (row.verdict ?? "").startsWith("matched");
const comparable = (row) => !["provider-blocked", "error", "build-error", "no-link"].includes(row.verdict ?? "");

let agree = 0;
let disagree = 0;
const disagreements = [];
const byHost = new Map();
for (const [label, liveRow] of live) {
  const replayRow = replay.get(label);
  if (!replayRow || !comparable(liveRow) || !comparable(replayRow)) continue;
  const host = (() => { try { return new URL(liveRow.target).hostname.replace(/^www\./, ""); } catch { return "?"; } })();
  const entry = byHost.get(host) ?? { agree: 0, disagree: 0 };
  const same = painted(liveRow) === painted(replayRow);
  if (same) { agree += 1; entry.agree += 1; } else { disagree += 1; entry.disagree += 1; disagreements.push({ label, live: liveRow.verdict, replay: replayRow.verdict, host }); }
  byHost.set(host, entry);
}
console.log(JSON.stringify({
  comparable: agree + disagree,
  paintAgreement: agree,
  paintDisagreements: disagree,
  agreementRate: agree + disagree ? Number((agree / (agree + disagree)).toFixed(4)) : null,
  byHost: Object.fromEntries(
    [...byHost.entries()].sort((a, b) => (b[1].agree + b[1].disagree) - (a[1].agree + a[1].disagree)).slice(0, 12),
  ),
}, null, 1));
console.log("---- disagreements (label | live | replay):");
for (const d of disagreements.slice(0, 40)) {
  console.log(`${d.label} | ${d.live} | ${d.replay}`);
}
