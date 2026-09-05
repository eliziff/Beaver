import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SelectionCase = {
  document_id: number;
  dataset: string;
  citation: string;
  name: string | null;
  date?: string | null;
  [key: string]: unknown;
};

type Selection = {
  format: string;
  seed?: number;
  court_only: boolean;
  court_datasets?: string[] | null;
  document_ids: number[];
  cases: SelectionCase[];
};

const here = path.resolve("backend/experiments/a2aj-case-treatment/gold");
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return path.resolve(index < 0 ? fallback : process.argv[index + 1] ?? fallback);
};

async function main() {
  const auditedFile = argument("--audited-selection", path.join(here, "selection-scaled-30.json"));
  const sourceFile = argument("--source-selection", path.join(here, "selection-100.json"));
  const destination = argument("--out", path.join(here, "selection-scaled-100.json"));
  const audited = JSON.parse(await readFile(auditedFile, "utf8")) as Selection;
  const source = JSON.parse(await readFile(sourceFile, "utf8")) as Selection;

  if (audited.document_ids.length !== 30 || audited.cases.length !== 30) throw new Error("audited selection must contain 30 cases");
  if (source.document_ids.length !== 100 || source.cases.length !== 100) throw new Error("source selection must contain 100 cases");
  if (!audited.court_only || !source.court_only) throw new Error("both source selections must be court-only");
  const auditedIds = new Set(audited.document_ids);
  if (auditedIds.size !== 30) throw new Error("audited selection contains duplicate document IDs");
  if (new Set(source.document_ids).size !== 100 || source.document_ids.join(",") !== source.cases.map(({ document_id }) => document_id).join(",")) {
    throw new Error("source selection IDs and cases must be unique and aligned");
  }

  const datasets = source.court_datasets ?? [...new Set(source.cases.map(({ dataset }) => dataset))].sort();
  if (datasets.length !== 14 || new Set(datasets).size !== datasets.length) throw new Error("source selection must cover 14 unique court datasets");
  const buckets = new Map(datasets.map((dataset) => [dataset, [] as SelectionCase[]]));
  for (const item of source.cases) {
    if (auditedIds.has(item.document_id)) continue;
    const bucket = buckets.get(item.dataset);
    if (!bucket) throw new Error(`unexpected source dataset ${item.dataset}`);
    bucket.push(item);
  }

  const quotas = new Map(datasets.map((dataset) => [dataset, Math.min(5, buckets.get(dataset)!.length)]));
  let selected = [...quotas.values()].reduce((sum, count) => sum + count, 0);
  while (selected < 70) {
    let added = 0;
    for (const dataset of datasets) {
      const quota = quotas.get(dataset)!;
      if (quota >= buckets.get(dataset)!.length) continue;
      quotas.set(dataset, quota + 1);
      selected += 1;
      added += 1;
      if (selected === 70) break;
    }
    if (!added) throw new Error(`only ${selected} non-overlapping source cases are available`);
  }

  const selectedNewIds = new Set(datasets.flatMap((dataset) =>
    buckets.get(dataset)!.slice(0, quotas.get(dataset)!).map(({ document_id }) => document_id)));
  const newCases = source.cases.filter(({ document_id }) => selectedNewIds.has(document_id));
  if (newCases.length !== 70 || selectedNewIds.size !== 70) throw new Error("expected 70 unique new cases");
  const cases = [
    ...audited.cases.map((item) => ({ ...item, gold_status: "audited" })),
    ...newCases.map((item) => ({ ...item, gold_status: "legacy_projection_draft" })),
  ];
  const documentIds = cases.map(({ document_id }) => document_id);
  if (new Set(documentIds).size !== 100) throw new Error("scaled selection contains duplicate document IDs");

  const newDatasetCounts = Object.fromEntries(datasets.map((dataset) => [dataset, quotas.get(dataset)]));
  await writeFile(destination, `${JSON.stringify({
    format: audited.format,
    requested: 100,
    selected: 100,
    court_only: true,
    court_datasets: datasets,
    sampling: "audited selection-scaled-30 followed by capped water-filling of non-overlapping selection-100 cases in source order",
    source_selection_seed: source.seed ?? null,
    source_selections: {
      audited: path.basename(auditedFile),
      candidates: path.basename(sourceFile),
    },
    new_case_dataset_counts: newDatasetCounts,
    document_ids: documentIds,
    cases,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ destination, cases: documentIds.length, audited_cases: 30, new_cases: 70, new_case_dataset_counts: newDatasetCounts }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
