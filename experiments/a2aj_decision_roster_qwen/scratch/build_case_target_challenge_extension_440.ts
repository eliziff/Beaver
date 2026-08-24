import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASE_TARGET_OCCURRENCE_VERSION,
  detectCaseTargetOccurrences,
} from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvp.ts";
import { fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk.ts";

type Json = Record<string, any>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARENT_FILE = "runs/case-target-budget-5000-seed-20260820.json";
const BASE_FILE = "case-target-challenge-60.json";
const EXTENSION_FILE = "case-target-challenge-extension-440-courts.json";
const COMBINED_FILE = "case-target-challenge-500.json";
const CREATED_UTC = "2026-08-21T00:00:00.000Z";
const REQUESTED = 440;
const MAX_SOURCE_CHARS = 150_000;
const COURT_DATASETS = [
  "BCCA", "BCSC", "CMAC", "FC", "FCA", "NSCA", "NSFC", "NSPC", "NSSC", "NSSM",
  "ONCA", "SCC", "TCC", "YKCA",
] as const;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nameKey(value: unknown) {
  return String(value ?? "").normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function counts(rows: Json[]) {
  return Object.fromEntries([...new Set(rows.map(({ source }) => String(source.dataset)))].sort()
    .map((dataset) => [dataset, rows.filter(({ source }) => source.dataset === dataset).length]));
}

function freezeKey(pair: Json) {
  return [pair.challenge_id, pair.document_id, pair.target.document_id, pair.target.citation];
}

function occurrences(sourceText: string, target: Json) {
  return detectCaseTargetOccurrences(sourceText, {
    citation: String(target.citation),
    citationAliases: Array.isArray(target.citation_aliases) ? target.citation_aliases : [],
    name: typeof target.name === "string" ? target.name : null,
  }).map((item) => {
    const start = Math.max(0, item.start - 320);
    const end = Math.min(sourceText.length, item.end + 420);
    const quote = sourceText.slice(start, end);
    return {
      ...item,
      context: { start, end_exclusive: end, quote, sha256: sha256(quote) },
    };
  });
}

async function build() {
  const [parentRaw, baseRaw] = await Promise.all([
    readFile(path.join(ROOT, PARENT_FILE), "utf8"),
    readFile(path.join(ROOT, BASE_FILE), "utf8"),
  ]);
  const parent = JSON.parse(parentRaw) as Json;
  const base = JSON.parse(baseRaw) as Json;
  const existing = new Set<number>(base.pairs.map(({ document_id }: Json) => Number(document_id)));
  const selected = (parent.pairs as Json[]).map((pair, parentIndex) => ({ pair, parentIndex })).filter(({ pair }) => {
    const dataset = String(pair.selection_receipt?.source_dataset ?? "");
    return COURT_DATASETS.includes(dataset as (typeof COURT_DATASETS)[number])
      && !existing.has(Number(pair.document_id))
      && pair.selection_receipt?.target_resolved_in_a2aj === true
      && Number(pair.selection_receipt?.source_chars) <= MAX_SOURCE_CHARS;
  }).slice(0, REQUESTED);
  assert(selected.length === REQUESTED, `found only ${selected.length}/${REQUESTED} eligible court cases`);

  const ids = selected.flatMap(({ pair }) => [Number(pair.document_id), Number(pair.target.document_id)]);
  const documents = fetchLocalA2AJDocumentsByIds({ ids, language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  const pairs = selected.map(({ pair, parentIndex }, index) => {
    const source = documents.get(Number(pair.document_id));
    const target = documents.get(Number(pair.target.document_id));
    assert(source, `${pair.document_id}: source missing`);
    assert(target, `${pair.document_id}: target missing`);
    assert(source.dataset === pair.selection_receipt.source_dataset, `${pair.document_id}: dataset changed`);
    assert(source.text.length === pair.selection_receipt.source_chars, `${pair.document_id}: source length changed`);
    const targetOccurrences = occurrences(source.text, pair.target);
    assert(targetOccurrences.some(({ kind }) => kind === "citation"), `${pair.document_id}: target citation missing`);
    return {
      challenge_id: `court-440-${String(index + 1).padStart(3, "0")}`,
      challenge_category: "seeded_court_control",
      document_id: Number(pair.document_id),
      source: {
        dataset: source.dataset,
        citation: source.citation,
        name: source.name ?? null,
        date: source.date?.slice(0, 10) ?? null,
        language: source.language,
        url: source.url ?? null,
      },
      target: {
        document_id: Number(pair.target.document_id),
        citation: pair.target.citation,
        citation_aliases: pair.target.citation_aliases ?? [],
        name: pair.target.name ?? target.name ?? null,
        same_litigation_eligible: !!nameKey(source.name)
          && nameKey(source.name) === nameKey(pair.target.name ?? target.name),
      },
      selection_receipt: {
        source_lineage: {
          kind: "seeded_parent_manifest_order",
          file: PARENT_FILE,
          file_sha256: sha256(parentRaw),
          seed: parent.seed,
          zero_based_pair_index: parentIndex,
        },
        eligibility: {
          court_dataset: true,
          resolved_target: true,
          source_chars_at_most: MAX_SOURCE_CHARS,
          excluded_existing_gold60_document_ids: true,
        },
        source_chars: source.text.length,
        source_text_sha256: sha256(source.text),
        target_resolved_in_a2aj: true,
        occurrence_contract: {
          detector: CASE_TARGET_OCCURRENCE_VERSION,
          source_view: "byte-identical-source-text",
          citation_and_case_name_offsets_frozen: true,
          linked_footnote_context_frozen: true,
        },
        target_occurrences: targetOccurrences,
      },
      evaluation_partition: "gold500_court_extension",
    };
  });

  const extension = {
    format: "a2aj-case-target-court-extension-440-v1",
    created_utc: CREATED_UTC,
    requested_pairs: REQUESTED,
    source_manifests: [
      { file: PARENT_FILE, file_sha256: sha256(parentRaw) },
      { file: BASE_FILE, file_sha256: sha256(baseRaw) },
    ],
    selection: {
      algorithm: "first-eligible-seeded-parent-order-court-only-v1",
      parent_seed: parent.seed,
      court_datasets: COURT_DATASETS,
      maximum_source_chars: MAX_SOURCE_CHARS,
      frozen_pair_keys_sha256: sha256(JSON.stringify(pairs.map(freezeKey))),
    },
    dataset_counts: counts(pairs),
    pairs,
  };
  const extensionBytes = `${JSON.stringify(extension, null, 2)}\n`;
  const combinedPairs = [...base.pairs, ...pairs];
  const combined = {
    format: "a2aj-case-target-challenge-500-v1",
    created_utc: CREATED_UTC,
    requested_pairs: 500,
    source_manifests: [
      { file: BASE_FILE, file_sha256: sha256(baseRaw) },
      { file: EXTENSION_FILE, file_sha256: sha256(extensionBytes) },
    ],
    selection: { frozen_pair_keys_sha256: sha256(JSON.stringify(combinedPairs.map(freezeKey))) },
    dataset_counts: counts(combinedPairs),
    pairs: combinedPairs,
  };
  const combinedBytes = `${JSON.stringify(combined, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(ROOT, EXTENSION_FILE), extensionBytes, "utf8"),
    writeFile(path.join(ROOT, COMBINED_FILE), combinedBytes, "utf8"),
  ]);
  console.log(JSON.stringify({
    extension_pairs: pairs.length,
    combined_pairs: combinedPairs.length,
    court_pairs: combinedPairs.filter(({ source }: Json) => COURT_DATASETS.includes(source.dataset)).length,
    tribunal_pairs: combinedPairs.filter(({ source }: Json) => !COURT_DATASETS.includes(source.dataset)).length,
    datasets: counts(pairs),
    extension_sha256: sha256(extensionBytes),
    combined_sha256: sha256(combinedBytes),
  }, null, 2));
}

void build().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
