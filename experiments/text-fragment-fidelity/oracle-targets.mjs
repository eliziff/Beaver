import fs from "node:fs";
import path from "node:path";

const results = path.join(import.meta.dirname, "results");
const source = process.argv[2] ?? path.join(results, "webdriver-exact-oracle-mined.jsonl");
const destination = process.argv[3] ?? path.join(results, "oracle-targets.jsonl");
const read = (file) => fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const targets = new Map(read(path.join(results, "targets.jsonl")).map((row) => [row.label, row]));
const encoded = [];

for (const result of read(source)) {
  const seed = targets.get(result.label);
  const directive = result.oracleDirective;
  if (!seed || (!directive?.exact && (!directive?.start || !directive?.end))) continue;
  const [base, fragment = ""] = seed.target.split("#", 2);
  const anchor = fragment.split(":~:", 1)[0];
  const prefix = anchor ? `${anchor}:~:` : ":~:";
  const contextPrefix = directive.prefix ? `${encodeURIComponent(directive.prefix)}-,` : "";
  const contextSuffix = directive.suffix ? `,-${encodeURIComponent(directive.suffix)}` : "";
  const text = directive.exact
    ? encodeURIComponent(directive.exact)
    : `${contextPrefix}${encodeURIComponent(directive.start)},${encodeURIComponent(directive.end)}${contextSuffix}`;
  encoded.push({
    ...seed,
    target: `${base}#${prefix}text=${text}`,
    oracleForVerdict: result.verdict,
  });
}

fs.writeFileSync(destination, encoded.map((row) => JSON.stringify(row)).join("\n") + (encoded.length ? "\n" : ""));
console.log(JSON.stringify({ source, destination, targets: encoded.length }));
