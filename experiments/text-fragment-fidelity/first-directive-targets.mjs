import fs from "node:fs";
import path from "node:path";

const results = path.join(import.meta.dirname, "results");
const source = process.argv[2] ?? path.join(results, "targets.jsonl");
const destination = process.argv[3] ?? path.join(results, "first-directive-targets.jsonl");
const limit = Number(process.argv[4] ?? 0);
const rows = fs.readFileSync(source, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse).slice(0, limit || undefined);
for (const row of rows) {
  const [base, fragment = ""] = row.target.split("#", 2);
  const [anchor = "", payload = ""] = fragment.split(":~:", 2);
  const directive = payload.split("&").find((part) => part.startsWith("text="));
  row.target = directive ? `${base}#${anchor ? `${anchor}:~:` : ":~:"}${directive}` : row.target;
}
fs.writeFileSync(destination, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
console.log(JSON.stringify({source, destination, targets: rows.length}));
