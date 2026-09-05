import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { productGoldErrors, type ProductGoldRecord } from "../productGold";

type Selection = { document_ids: number[] };
const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return path.resolve(index < 0 ? fallback : process.argv[index + 1] ?? fallback);
};
const readJsonl = async <T>(file: string) => (await readFile(file, "utf8"))
  .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);

async function main() {
  const selectionFile = argument("--selection", path.join(here, "selection-scaled-100.json"));
  const auditedFile = argument("--audited", path.join(here, "gold-product-30-v1.jsonl"));
  const additionsFiles = process.argv.includes("--additions")
    ? [argument("--additions", path.join(here, "gold-product-scale-additions-v1.jsonl"))]
    : ["v1", "v2"].map((version) => path.join(here, `gold-product-scale-additions-${version}.jsonl`));
  const destination = argument("--out", path.join(here, "gold-product-scale-current.jsonl"));
  if ([auditedFile, ...additionsFiles].includes(destination) || path.basename(destination).toLocaleLowerCase() === "gold-product-30-v1.jsonl") {
    throw new Error("refusing to overwrite an assembler input");
  }

  const selection = JSON.parse(await readFile(selectionFile, "utf8")) as Selection;
  const audited = await readJsonl<ProductGoldRecord>(auditedFile);
  const additions = (await Promise.all(additionsFiles.map((file) => readJsonl<ProductGoldRecord>(file)))).flat();
  if (selection.document_ids.length !== 100 || new Set(selection.document_ids).size !== 100) throw new Error("selection must contain 100 unique cases");
  if (audited.length !== 30 || audited.map(({ document_id }) => document_id).join(",") !== selection.document_ids.slice(0, 30).join(",")) {
    throw new Error("audited product gold must match the first 30 selected cases in order");
  }

  const recordsById = new Map<number, ProductGoldRecord>();
  for (const record of [...audited, ...additions]) {
    if (recordsById.has(record.document_id)) throw new Error(`duplicate assembled document ${record.document_id}`);
    if (!selection.document_ids.includes(record.document_id)) throw new Error(`document ${record.document_id} is outside the 100-case selection`);
    const errors = productGoldErrors(record);
    if (errors.length) throw new Error(`${record.document_id}: ${errors.join("; ")}`);
    recordsById.set(record.document_id, record);
  }

  const records = selection.document_ids.flatMap((documentId) => recordsById.get(documentId) ?? []);
  const missingDocumentIds = selection.document_ids.filter((documentId) => !recordsById.has(documentId));
  await writeFile(destination, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    destination,
    cases: records.length,
    audited_cases: audited.length,
    addition_cases: additions.length,
    remaining_cases: missingDocumentIds.length,
    treatments: records.reduce((sum, record) => sum + record.treatments.length, 0),
    direct_outcomes: records.reduce((sum, record) => sum + record.direct_outcomes.length, 0),
    reported_history: records.reduce((sum, record) => sum + record.reported_history.length, 0),
    missing_document_ids: missingDocumentIds,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
