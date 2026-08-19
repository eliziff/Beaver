import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    parsed[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

async function readJsonl(file, visit) {
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) visit(JSON.parse(line));
  }
}

function validationErrors(validation) {
  return Array.isArray(validation?.errors) ? validation.errors.map(String) : [];
}

function errorFamily(error) {
  if (/start_quote resolves 0 times/iu.test(error)) return "start_anchor_not_found";
  if (/end_quote resolves 0 times/iu.test(error)) return "end_anchor_not_found";
  if (/(?:start|end)_quote resolves \d+ times/iu.test(error)) return "anchor_not_unique";
  if (/only \d+ substantive words/iu.test(error)) return "opinion_below_length_floor";
  if (/(?:author|judge name) not found in source: unknown/iu.test(error)) return "unknown_placeholder";
  if (/author not found in source:/iu.test(error)) return "author_not_source_grounded";
  if (/judge name not found in source:/iu.test(error)) return "judge_not_source_grounded";
  if (/duplicate or empty judge:/iu.test(error)) return "duplicate_or_empty_judge";
  if (/panel member missing from judges:/iu.test(error)) return "panel_member_omitted";
  if (/is marked authors but is not an opinion author/iu.test(error)) return "authors_relationship_mismatch";
  if (/author .+ must have an authors voting record/iu.test(error)) return "opinion_author_vote_missing";
  if (/at least one opinion must be the lead reasons/iu.test(error)) return "lead_opinion_missing";
  if (/opinion_ids|opinion id|unknown opinion/iu.test(error)) return "opinion_reference_invalid";
  if (/result_side|relationship|vote|majority|minority|concurring|dissent/iu.test(error)) return "vote_coherence";
  if (/overlap|order|boundary|start.*end/iu.test(error)) return "opinion_boundary_invalid";
  if (/opinion/iu.test(error)) return "other_opinion_contract";
  if (/judge|panel/iu.test(error)) return "other_judge_contract";
  return "other";
}

function primaryFamilies(errors) {
  const families = new Set(errors.map(errorFamily));
  const opinionRejected = [
    "start_anchor_not_found",
    "end_anchor_not_found",
    "anchor_not_unique",
    "opinion_below_length_floor",
    "unknown_placeholder",
    "author_not_source_grounded",
    "other_opinion_contract",
    "opinion_boundary_invalid",
  ].some((family) => families.has(family));
  if (opinionRejected) {
    families.delete("authors_relationship_mismatch");
    families.delete("opinion_author_vote_missing");
    families.delete("lead_opinion_missing");
  }
  if (families.has("unknown_placeholder")) {
    families.delete("author_not_source_grounded");
    families.delete("judge_not_source_grounded");
  }
  return families;
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function sortedCounts(object) {
  return Object.entries(object)
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

const options = args(process.argv.slice(2));
if (!options.receipts || !options.revalidation) {
  throw new Error("usage: node analyze_revalidation.mjs --receipts run.receipts.jsonl --revalidation revalidated.results.jsonl [--out analysis.json]");
}

const receipts = new Map();
const runCounts = { total: 0, accepted: 0, rejected: 0, other: 0 };
await readJsonl(options.receipts, (event) => {
  if (event.kind !== "case_receipt" || !event.receipt) return;
  const document = Number(event.receipt.source?.document_id ?? event.document);
  if (!Number.isSafeInteger(document)) return;
  receipts.set(document, event);
  runCounts.total += 1;
  increment(runCounts, ["accepted", "rejected"].includes(event.receipt.status) ? event.receipt.status : "other");
});

const statusCounts = {};
const oldFamilies = {};
const residualFamilies = {};
const primaryResidualFamilies = {};
const residualErrors = {};
const datasets = {};
const representatives = {};
const lengthFloorWords = {};
const primaryIntersections = {};
const omittedPanelMembers = {};
let residualErrorInstances = 0;

await readJsonl(options.revalidation, (event) => {
  if (event.kind !== "revalidation_result") return;
  const document = Number(event.document);
  const receiptEvent = receipts.get(document);
  const receipt = receiptEvent?.receipt ?? {};
  const dataset = String(receipt.source?.dataset ?? "unknown");
  const status = String(event.result?.status ?? "unknown");
  increment(statusCounts, status);
  const datasetRow = datasets[dataset] ??= {
    run_total: 0,
    v3_rejected: 0,
    salvaged: 0,
    still_rejected: 0,
    raw_submission_unavailable: 0,
    other: 0,
    residual_families: {},
  };
  increment(datasetRow, status in datasetRow ? status : "other");

  for (const family of new Set(validationErrors(event.old_validation).map(errorFamily))) increment(oldFamilies, family);
  const errors = validationErrors(event.result?.validation);
  const families = new Set(errors.map(errorFamily));
  const primary = primaryFamilies(errors);
  for (const error of errors) {
    increment(residualErrors, error);
    residualErrorInstances += 1;
    const lengthMatch = /only (\d+) substantive words/iu.exec(error);
    if (lengthMatch) increment(lengthFloorWords, lengthMatch[1]);
    const panelMatch = /^panel member missing from judges: (.+)$/iu.exec(error);
    if (panelMatch) increment(omittedPanelMembers, panelMatch[1]);
  }
  for (const family of families) {
    increment(residualFamilies, family);
    increment(datasetRow.residual_families, family);
    const samples = representatives[family] ??= [];
    if (samples.length < 5) {
      samples.push({
        document,
        dataset,
        citation: event.citation ?? receipt.source?.citation ?? null,
        source_chars: receipt.structure?.source_chars ?? null,
        deterministic_status: receipt.deterministic?.status ?? null,
        errors,
        submission: event.submission ?? null,
      });
    }
  }
  for (const family of primary) increment(primaryResidualFamilies, family);
  const primaryList = [...primary].sort();
  for (let left = 0; left < primaryList.length; left += 1) {
    for (let right = left + 1; right < primaryList.length; right += 1) {
      increment(primaryIntersections, `${primaryList[left]} + ${primaryList[right]}`);
    }
  }
});

for (const event of receipts.values()) {
  const dataset = String(event.receipt.source?.dataset ?? "unknown");
  const row = datasets[dataset] ??= {
    run_total: 0,
    v3_rejected: 0,
    salvaged: 0,
    still_rejected: 0,
    raw_submission_unavailable: 0,
    other: 0,
    residual_families: {},
  };
  row.run_total += 1;
  if (event.receipt.status === "rejected") row.v3_rejected += 1;
}

const byDataset = Object.entries(datasets)
  .map(([dataset, counts]) => ({
    dataset,
    ...counts,
    v3_rejection_rate: counts.run_total ? counts.v3_rejected / counts.run_total : null,
    residual_rate_of_replayable: counts.v3_rejected > counts.raw_submission_unavailable
      ? counts.still_rejected / (counts.v3_rejected - counts.raw_submission_unavailable)
      : null,
  }))
  .sort((left, right) => right.still_rejected - left.still_rejected || right.v3_rejected - left.v3_rejected || left.dataset.localeCompare(right.dataset));

const analysis = {
  format: "a2aj-opinion-revalidation-analysis-v1",
  receipts: options.receipts,
  revalidation: options.revalidation,
  run: runCounts,
  revalidation_status: statusCounts,
  replayable: (statusCounts.salvaged ?? 0) + (statusCounts.still_rejected ?? 0),
  salvage_rate_of_replayable: (statusCounts.salvaged ?? 0) / ((statusCounts.salvaged ?? 0) + (statusCounts.still_rejected ?? 0)),
  residual_case_families: sortedCounts(residualFamilies),
  primary_residual_case_families: sortedCounts(primaryResidualFamilies),
  original_rejection_case_families: sortedCounts(oldFamilies),
  length_floor_word_counts: sortedCounts(lengthFloorWords).sort((left, right) => Number(left.name) - Number(right.name)),
  primary_family_intersections: sortedCounts(primaryIntersections),
  omitted_panel_members: sortedCounts(omittedPanelMembers),
  residual_error_instances: residualErrorInstances,
  top_residual_errors: sortedCounts(residualErrors).slice(0, 100),
  by_dataset: byDataset,
  representatives,
};

const output = `${JSON.stringify(analysis, null, 2)}\n`;
if (options.out) {
  await writeFile(options.out, output, "utf8");
  process.stdout.write(`wrote ${options.out}\n`);
} else {
  process.stdout.write(output);
}
