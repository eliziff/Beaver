import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GoldRecord } from "../contract";
import { productGoldErrors, projectProductGold } from "../productGold";

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main() {
  const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
  const source = path.resolve(argument("--source", path.join(here, "gold-fresh-10-v2.jsonl")));
  const destination = path.resolve(argument("--out", path.join(here, "gold-product-10-v1.jsonl")));
  const rows = (await readFile(source, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => projectProductGold(JSON.parse(line) as GoldRecord));

  const failures = rows.flatMap((row) => productGoldErrors(row).map((error) => `${row.document_id}: ${error}`));
  if (failures.length) throw new Error(failures.join("\n"));

  await writeFile(destination, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const treatments = rows.reduce((total, row) => total + row.treatments.length, 0);
  const directOutcomes = rows.reduce((total, row) => total + row.direct_outcomes.length, 0);
  const reportedHistory = rows.reduce((total, row) => total + row.reported_history.length, 0);
  console.log(JSON.stringify({ destination, cases: rows.length, treatments, direct_outcomes: directOutcomes, reported_history: reportedHistory }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
