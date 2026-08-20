import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

function increment(counts: Record<string, number>, key: string, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function errorClass(error: string) {
  if (/JSON parse|no output|empty final|transport|return code/iu.test(error)) return "transport_or_parse";
  if (/duplicate .*id|parent issue cycle|self-parent/iu.test(error)) return "issue_graph";
  if (/falls outside every discussion span|discussion \d+ .*quote/iu.test(error)) return "issue_evidence_outside_span";
  if (/quote is missing|quote is not unique|resolves \d+ times/iu.test(error)) return "quote_grounding";
  if (/answer lacks current-court evidence/iu.test(error)) return "issue_answer_voice";
  if (/^m\w* issue .*no position/iu.test(error)) return "mention_issue_link";
  if (/no accepted opinion position|has no position|unavailable position/u.test(error)) return "issue_position_dependency";
  if (/missing target occurrence/iu.test(error)) return "target_occurrence_coverage";
  if (/references unavailable mention|linked mentions do not belong|mention .*missing|mention .*unavailable|unavailable mention/iu.test(error)) return "treatment_mention_link";
  if (/issue .*absent from every linked mention/iu.test(error)) return "treatment_issue_link";
  if (/evidence contains none of its target mentions/iu.test(error)) return "treatment_evidence_link";
  if (/partial join|issue scope/u.test(error)) return "partial_joinder";
  if (/opinion|participant|judge|author|panel_|result_only/iu.test(error)) return "opinion_roster";
  if (/direct-history|history/u.test(error)) return "direct_history";
  return "other";
}

function lengthBucket(chars: number) {
  if (chars < 20_000) return "under_20k";
  if (chars < 50_000) return "20k_to_50k";
  if (chars < 100_000) return "50k_to_100k";
  if (chars < 200_000) return "100k_to_200k";
  return "200k_plus";
}

async function receipts(file: string) {
  const rows: Array<Record<string, any>> = [];
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, any>;
    if (event.kind === "case_receipt" && event.receipt) rows.push(event.receipt);
  }
  return rows;
}

async function main() {
  const receiptFile = process.argv[2];
  const manifestFile = process.argv[3];
  if (!receiptFile || !manifestFile) {
    throw new Error("usage: analyze_case_target_run.ts <receipts.jsonl> <pairs.json> [--out report.json] [--retry-no-model-out pairs.json] [--model-only-out pairs.json]");
  }
  const manifest = JSON.parse(await readFile(path.resolve(manifestFile), "utf8")) as Record<string, any> & { pairs?: Array<Record<string, any>> };
  const pairByDocument = new Map((manifest.pairs ?? []).map((pair) => [Number(pair.document_id), pair]));
  const cases = await receipts(path.resolve(receiptFile));
  const receiptByDocument = new Map(cases.map((receipt) => [Number(receipt.source?.document_id), receipt]));
  const statuses: Record<string, number> = {};
  const errorClasses: Record<string, number> = {};
  const labels = {
    controlling: {} as Record<string, number>,
    other_judicial: {} as Record<string, number>,
    attributed: {} as Record<string, number>,
    direct_history: {} as Record<string, number>,
  };
  const components = {
    opinion_positions: { submitted: 0, accepted: 0 },
    partial_joins: { submitted: 0, accepted: 0 },
    target_mentions: { submitted: 0, accepted: 0 },
    target_treatments: { submitted: 0, accepted: 0 },
    target_direct_history: { submitted: 0, accepted: 0 },
  };
  const datasets: Record<string, { cases: number; opinion_ok: number; target_ok: number }> = {};
  const targetResolution = {
    resolved: { cases: 0, target_ok: 0 },
    unresolved: { cases: 0, target_ok: 0 },
  };
  const lengthBuckets: Record<string, { cases: number; opinion_ok: number; target_ok: number }> = {};
  const occurrenceBuckets: Record<string, { cases: number; target_ok: number }> = {};
  const mentionVoices: Record<string, number> = {};
  const treatmentAttributions: Record<string, number> = {};
  const flatStatuses: Record<string, number> = {};
  const failureSurfaces: Record<string, number> = {};
  const usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  const elapsed: number[] = [];
  const caseRows = cases.map((receipt) => {
    const documentId = Number(receipt.source?.document_id);
    const pair = pairByDocument.get(documentId);
    const dataset = String(receipt.source?.dataset ?? pair?.selection_receipt?.source_dataset ?? "unknown");
    const opinionOk = receipt.validation?.ok === true;
    const targetOk = receipt.case_target_mvp?.ok === true;
    const status = String(receipt.status ?? "unknown");
    increment(statuses, status);
    datasets[dataset] ??= { cases: 0, opinion_ok: 0, target_ok: 0 };
    datasets[dataset].cases += 1;
    if (opinionOk) datasets[dataset].opinion_ok += 1;
    if (targetOk) datasets[dataset].target_ok += 1;
    const resolution = pair?.selection_receipt?.target_resolved_in_a2aj === true || pair?.target?.document_id != null
      ? "resolved"
      : "unresolved";
    targetResolution[resolution].cases += 1;
    if (targetOk) targetResolution[resolution].target_ok += 1;
    const sourceChars = Number(receipt.structure?.source_chars ?? pair?.selection_receipt?.source_chars ?? 0);
    const sourceBucket = lengthBucket(sourceChars);
    lengthBuckets[sourceBucket] ??= { cases: 0, opinion_ok: 0, target_ok: 0 };
    lengthBuckets[sourceBucket].cases += 1;
    if (opinionOk) lengthBuckets[sourceBucket].opinion_ok += 1;
    if (targetOk) lengthBuckets[sourceBucket].target_ok += 1;
    const occurrenceCount = Array.isArray(receipt.target?.occurrences)
      ? receipt.target.occurrences.length
      : Number(pair?.selection_receipt?.deterministic_occurrences ?? 0);
    const occurrenceBucket = occurrenceCount >= 4 ? "4_plus" : String(occurrenceCount);
    occurrenceBuckets[occurrenceBucket] ??= { cases: 0, target_ok: 0 };
    occurrenceBuckets[occurrenceBucket].cases += 1;
    if (targetOk) occurrenceBuckets[occurrenceBucket].target_ok += 1;

    const counts = receipt.case_target_mvp?.counts ?? {};
    components.opinion_positions.submitted += Number(counts.submitted_opinion_positions ?? 0);
    components.opinion_positions.accepted += Number(counts.accepted_opinion_positions ?? 0);
    components.partial_joins.submitted += Number(counts.submitted_partial_issue_joins ?? 0);
    components.partial_joins.accepted += Number(counts.accepted_partial_issue_joins ?? 0);
    components.target_mentions.submitted += Number(counts.submitted_target_mentions ?? 0);
    components.target_mentions.accepted += Number(counts.accepted_target_mentions ?? 0);
    components.target_treatments.submitted += Number(counts.submitted_target_treatments ?? 0);
    components.target_treatments.accepted += Number(counts.accepted_target_treatments ?? 0);
    components.target_direct_history.submitted += Number(counts.submitted_target_direct_history ?? 0);
    components.target_direct_history.accepted += Number(counts.accepted_target_direct_history ?? 0);

    for (const error of receipt.case_target_mvp?.errors ?? receipt.validation?.errors ?? []) increment(errorClasses, errorClass(String(error)));
    const flat = receipt.case_target_mvp?.flat_treatment;
    increment(flatStatuses, String(flat?.status ?? "unavailable"));
    for (const label of flat?.controlling_labels ?? []) increment(labels.controlling, label);
    for (const label of flat?.other_judicial_labels ?? []) increment(labels.other_judicial, label);
    for (const label of flat?.attributed_labels ?? []) increment(labels.attributed, label);
    for (const label of flat?.direct_history_labels ?? []) increment(labels.direct_history, label);
    for (const mention of receipt.case_target_mvp?.target_mentions ?? []) {
      increment(mentionVoices, String(mention.voice ?? "unknown"));
    }
    for (const treatment of receipt.case_target_mvp?.target_treatments ?? []) {
      increment(treatmentAttributions, String(treatment.attribution ?? "unknown"));
    }
    const modelUsage = receipt.model_receipt?.usage ?? {};
    usage.input_tokens += Number(modelUsage.input_tokens ?? 0);
    usage.output_tokens += Number(modelUsage.output_tokens ?? 0);
    usage.reasoning_tokens += Number(
      modelUsage.reasoning_tokens ??
      modelUsage.reasoning_output_tokens ??
      modelUsage.output_tokens_details?.reasoning_tokens ??
      0,
    );
    if (!receipt.model_receipt) increment(failureSurfaces, "no_model_receipt");
    else if (receipt.model_receipt.error || Number(receipt.model_receipt.return_code ?? 0) !== 0) increment(failureSurfaces, "transport_or_model_error");
    else if (!opinionOk) increment(failureSurfaces, "opinion_validation");
    else if (!targetOk) increment(failureSurfaces, "target_validation");
    else increment(failureSurfaces, "accepted");
    if (Number.isFinite(receipt.model_receipt?.elapsed_seconds)) elapsed.push(Number(receipt.model_receipt.elapsed_seconds));
    return {
      document_id: documentId,
      citation: receipt.source?.citation ?? null,
      dataset,
      target: pair?.target ?? receipt.target ?? null,
      status,
      opinion_ok: opinionOk,
      target_ok: targetOk,
      errors: receipt.case_target_mvp?.errors ?? receipt.validation?.errors ?? [],
      counts,
      flat_treatment: flat ?? null,
    };
  });
  elapsed.sort((left, right) => left - right);
  const report = {
    receipt_file: path.resolve(receiptFile),
    manifest_file: path.resolve(manifestFile),
    completed_cases: cases.length,
    opinion_ok: caseRows.filter(({ opinion_ok }) => opinion_ok).length,
    target_ok: caseRows.filter(({ target_ok }) => target_ok).length,
    statuses,
    components,
    error_classes: errorClasses,
    treatment_labels: labels,
    target_resolution: targetResolution,
    length_buckets: lengthBuckets,
    occurrence_buckets: occurrenceBuckets,
    datasets,
    mention_voices: mentionVoices,
    treatment_attributions: treatmentAttributions,
    flat_statuses: flatStatuses,
    failure_surfaces: failureSurfaces,
    usage,
    elapsed_seconds: elapsed.length ? {
      min: elapsed[0],
      median: elapsed[Math.floor(elapsed.length / 2)],
      max: elapsed.at(-1),
      mean: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
    } : null,
    cases: caseRows,
  };
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0) {
    const output = process.argv[outIndex + 1];
    if (!output) throw new Error("--out requires a path");
    await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  const retryIndex = process.argv.indexOf("--retry-no-model-out");
  if (retryIndex >= 0) {
    const output = process.argv[retryIndex + 1];
    if (!output) throw new Error("--retry-no-model-out requires a path");
    const pairs = (manifest.pairs ?? []).filter((pair) => {
      const receipt = receiptByDocument.get(Number(pair.document_id));
      return !receipt?.model_receipt;
    });
    const datasetCounts: Record<string, number> = {};
    for (const pair of pairs) increment(datasetCounts, String(pair.selection_receipt?.source_dataset ?? "unknown"));
    const retryManifest = {
      ...manifest,
      created_utc: new Date().toISOString(),
      requested_pairs: pairs.length,
      pairs,
      dataset_counts: datasetCounts,
      parent_manifest: path.resolve(manifestFile),
      budget_partition: { kind: "retry_no_model_receipt", pairs: pairs.length },
    };
    await writeFile(path.resolve(output), `${JSON.stringify(retryManifest, null, 2)}\n`, "utf8");
  }
  const modelOnlyIndex = process.argv.indexOf("--model-only-out");
  if (modelOnlyIndex >= 0) {
    const output = process.argv[modelOnlyIndex + 1];
    if (!output) throw new Error("--model-only-out requires a path");
    const pairs = (manifest.pairs ?? []).filter((pair) => receiptByDocument.get(Number(pair.document_id))?.model_receipt);
    const datasetCounts: Record<string, number> = {};
    for (const pair of pairs) increment(datasetCounts, String(pair.selection_receipt?.source_dataset ?? "unknown"));
    await writeFile(path.resolve(output), `${JSON.stringify({
      ...manifest,
      created_utc: new Date().toISOString(),
      requested_pairs: pairs.length,
      pairs,
      dataset_counts: datasetCounts,
      parent_manifest: path.resolve(manifestFile),
      budget_partition: { kind: "model_receipt", pairs: pairs.length },
    }, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
