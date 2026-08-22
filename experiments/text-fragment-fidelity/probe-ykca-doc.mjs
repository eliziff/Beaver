import fs from "node:fs";
const rows = fs.readFileSync("experiments/text-fragment-fidelity/results/doctext.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const doc = rows.find((r) => r.key === "2019_YKCA_18");
console.log("doc found:", Boolean(doc), doc ? doc.text.length : 0);
if (!doc) process.exit(0);
const text = doc.text.replace(/\s+/gu, " ").toLowerCase();
for (const needle of [
  "court further noted at para. 33 that \"[t]he interests",
  "court further noted at para. 33 that “[t]he interests",
  "court further noted at para 33 that",
  "the interests of the child",
]) {
  console.log(JSON.stringify(needle), "->", text.includes(needle));
}
const at = text.indexOf("court further noted");
console.log("context:", at >= 0 ? JSON.stringify(text.slice(at, at + 120)) : "not found");
