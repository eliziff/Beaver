import fs from "node:fs";

const path = "experiments/text-fragment-fidelity/results/doctext.jsonl";
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
const out = lines.map((line) => {
    const row = JSON.parse(line);
    return JSON.stringify({
      ...row,
      key: String(row.citation).replace(/[^\w.-]+/gu, "_"),
    });
});
fs.writeFileSync(path, `${out.join("\n")}\n`);
console.log("keys added:", out.length);
