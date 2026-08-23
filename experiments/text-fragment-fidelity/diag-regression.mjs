import fs from "node:fs";
const oldPath = "experiments/text-fragment-fidelity/results/gate-full-final2.jsonl";
const newPath = "experiments/text-fragment-fidelity/results/gate-replay.jsonl";
const old = new Map(fs.readFileSync(oldPath,"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).map(r=>[r.label,r]));
const cur = new Map(fs.readFileSync(newPath,"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)).map(r=>[r.label,r]));
let regressions = [];
for (const [label, o] of old) {
  const n = cur.get(label);
  if (!n) continue;
  if (o.verdict==="matched-correct" && n.verdict==="no-highlight") regressions.push(label);
  if (regressions.length>=5) break;
}
console.log("regressions", regressions.length);
for (const label of regressions) {
  const o = old.get(label);
  const n = cur.get(label);
  console.log("\n===", label);
  console.log("old target:", o.target?.slice(0,160));
  console.log("new target:", n.target?.slice(0,160));
  console.log("old highlight", o.highlightPixels, "new", n.highlightPixels);
}
