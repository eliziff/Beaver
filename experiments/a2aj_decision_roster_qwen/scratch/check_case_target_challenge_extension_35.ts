import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { a2ajLocalBulkPath, fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk";
import { citationLookupKey } from "../../../backend/src/lib/citationKey";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";

type Target = { document_id: number | null; citation: string; citation_aliases: string[]; name: string | null };
type CaseTargetOccurrence = { id: string; kind: "citation" | "case_name"; quote: string; start: number; end: number; citationKey: string; linkedContext: null };
type Occurrence = CaseTargetOccurrence & { context: { start: number; end_exclusive: number; quote: string; sha256: string } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "case-target-challenge-15.json";
const PARENT = "runs/case-target-budget-5000-seed-20260820.json";
const EXTENSION = "case-target-challenge-extension-35.json";
const COMBINED = "case-target-challenge-50.json";
const SEED = 20_260_821;
const MAX_CHECK_MS = 5_000;
const CONTEXT_BEFORE = 320;
const CONTEXT_AFTER = 420;
const EXPECTED_MISSING = ["CITT", "CMAC", "CT", "NSFC", "NSPC", "NSSC", "NSSM", "OHSTC", "OIC", "PSDPT", "RAD", "RLLR", "RPD", "SCT", "TATC"];
const EXPECTED_FEATURES = { multi_opinion: 4, direct_history_cue: 6, explicit_treatment_cue: 3, attribution_cue: 1, collective_tribunal: 2, short_decision: 2, long_decision: 2 };
const GENERIC_PARTY_WORDS = new Set(["applicant", "association", "board", "canada", "commission", "company", "corporation", "defendant", "director", "estate", "minister", "ontario", "plaintiff", "quebec", "respondent", "tribunal", "union"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rank(...parts: Array<string | number | null>) {
  return sha256([SEED, "challenge-extension", ...parts].join(":"));
}

function phraseWords(value: string) {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function targetNamePhrases(name: string | null) {
  if (!name?.trim()) return [];
  const full = name.trim();
  const sides = full.split(/\s+v(?:\.|ersus)?\s+/iu);
  const crown = sides.length > 1 && /^(?:r\.?|the\s+(?:king|queen)|(?:his|her)\s+majesty)/iu.test(sides[0].trim());
  const party = (crown ? sides[1] : sides[0]).replace(/^the\s+/iu, "").replace(/\s*\([^)]*\)\s*$/u, "").replace(/(?:,?\s+(?:incorporated|inc\.?|limited|ltd\.?|corporation|corp\.?))\s*$/iu, "").trim();
  const words = phraseWords(party);
  const first = words[0] ?? "";
  const short = sides.length === 1 ? words.slice(0, 2) : first.length >= 5 && !GENERIC_PARTY_WORDS.has(first.toLocaleLowerCase()) ? [first] : words.slice(0, 2);
  return [...new Set([full, party, short.join(" ")].map((value) => value.trim()).filter((value) => phraseWords(value).length > 0))];
}

function shortNameReferenceCue(text: string, start: number, end: number) {
  const before = text.slice(Math.max(0, start - 120), start);
  const after = text.slice(end, Math.min(text.length, end + 140));
  return /\b(?:in|see|cf\.?|following|appl(?:y|ied)|distinguish(?:ed|ing)?|consider(?:ed|ing)|discuss(?:ed|ing)|our\s+decision\s+in|as\s+(?:held|stated|explained)\s+in)\s*$/iu.test(before)
    || /^\s*,?\s*(?:supra|above|below|ibid\.?|at\s+paras?\.?|held\b|holds?\b|confirm(?:ed|s)?\b|establish(?:ed|es)?\b|requires?\b|stands?\s+for\b|makes?\s+clear\b)/iu.test(after);
}

function literalSpans(text: string, phrase: string) {
  const spans: Array<{ start: number; end: number }> = [];
  for (let start = text.indexOf(phrase); start >= 0; start = text.indexOf(phrase, start + 1)) {
    const end = start + phrase.length;
    if (/^[\p{L}\p{N}]$/u.test(text[start - 1] ?? "") || /^[\p{L}\p{N}]$/u.test(text[end] ?? "")) continue;
    spans.push({ start, end });
  }
  if (spans.length) return spans;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
    const start = match.index;
    const end = start + match[0].length;
    if (/^[\p{L}\p{N}]$/u.test(text[start - 1] ?? "") || /^[\p{L}\p{N}]$/u.test(text[end] ?? "")) continue;
    spans.push({ start, end });
  }
  return spans;
}

function lightweightOccurrences(text: string, target: Target): CaseTargetOccurrence[] {
  const citations: Array<{ quote: string; start: number; end: number }> = [];
  for (const surface of [target.citation, ...target.citation_aliases]) {
    for (const span of literalSpans(text, surface)) {
      if (!citations.some(({ start, end }) => start === span.start && end === span.end)) citations.push({ quote: text.slice(span.start, span.end), ...span });
    }
  }
  citations.sort((left, right) => left.start - right.start || left.end - right.end);
  const citationOccurrences = citations.map((match, index): CaseTargetOccurrence => ({ id: `tm${index + 1}`, kind: "citation", ...match, citationKey: citationLookupKey(match.quote), linkedContext: null }));
  const fullName = target.name?.trim() ?? "";
  const nameSpans = targetNamePhrases(target.name).flatMap((phrase) => literalSpans(text, phrase).map((span) => ({ ...span, phrase })))
    .filter(({ start, end, phrase }) => phrase === fullName || shortNameReferenceCue(text, start, end))
    .filter(({ start, end }) => !citations.some((citation) => start < citation.end && end > citation.start))
    .filter(({ end }) => !citations.some((citation) => citation.start >= end && citation.start - end <= 180 && !text.slice(end, citation.start).includes("\n") && !/[!?]/u.test(text.slice(end, citation.start))))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const names = [...new Map(nameSpans.map(({ start, end }) => [`${start}:${end}`, { start, end }])).values()]
    .filter((span, index, spans) => !spans.some((other, otherIndex) => otherIndex !== index && other.start === span.start && other.end > span.end))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  return [...citationOccurrences, ...names.map((span, index): CaseTargetOccurrence => ({ id: `tn${index + 1}`, kind: "case_name", quote: text.slice(span.start, span.end), ...span, citationKey: citationLookupKey(target.citation), linkedContext: null }))];
}

function expectedOccurrences(text: string, target: Target): Occurrence[] {
  return lightweightOccurrences(text, target).map((occurrence) => {
    const start = Math.max(0, occurrence.start - CONTEXT_BEFORE);
    const end = Math.min(text.length, occurrence.end + CONTEXT_AFTER);
    const quote = text.slice(start, end);
    return { ...occurrence, context: { start, end_exclusive: end, quote, sha256: sha256(quote) } };
  });
}

function evaluationStratum(pair: Record<string, any>) {
  const feature = pair.selection_receipt.hard_feature;
  if (feature === "multi_opinion") return "multi_opinion";
  if (feature === "attribution_cue") return "attribution_trap";
  if (feature) return feature;
  if (pair.challenge_category === "multi_opinion_or_partial_join") return "multi_opinion";
  return pair.challenge_category;
}

function countsBy<T>(values: T[], keys: string[], read: (value: T) => string) {
  return Object.fromEntries(keys.map((key) => [key, values.filter((value) => read(value) === key).length]));
}

function freezeKey(pair: Record<string, any>) {
  return [pair.challenge_id, pair.document_id, pair.target.document_id, pair.target.citation];
}

async function main() {
  const started = Date.now();
  const extensionFile = path.resolve(process.argv[2] ?? path.join(ROOT, EXTENSION));
  const combinedFile = path.resolve(process.argv[3] ?? path.join(ROOT, COMBINED));
  const [extensionRaw, combinedRaw, baseRaw, parentRaw] = await Promise.all([
    readFile(extensionFile, "utf8"),
    readFile(combinedFile, "utf8"),
    readFile(path.join(ROOT, BASE), "utf8"),
    readFile(path.join(ROOT, PARENT), "utf8"),
  ]);
  const manifest = JSON.parse(extensionRaw) as Record<string, any>;
  const combined = JSON.parse(combinedRaw) as Record<string, any>;
  const base = JSON.parse(baseRaw) as Record<string, any>;
  const parent = JSON.parse(parentRaw) as Record<string, any>;
  const pairs = manifest.pairs as Array<Record<string, any>>;
  assert(manifest.format === "a2aj-case-target-challenge-extension-v2", "wrong extension format");
  assert(combined.format === "a2aj-case-target-challenge-combined-v1", "wrong combined format");
  assert(pairs.length === 35 && manifest.requested_pairs === 35 && manifest.combined_with_base_pairs === 50, "extension must freeze 35 of 50 pairs");
  assert(manifest.extends.file === BASE && manifest.extends.file_sha256 === sha256(baseRaw), "base manifest receipt changed");
  assert(manifest.selection.parent_manifest === PARENT && manifest.selection.parent_manifest_sha256 === sha256(parentRaw), "parent manifest receipt changed");
  assert(manifest.selection.source_text_reads.strategy === "one_batched_read_after_selection" && manifest.selection.source_text_reads.requested_documents === 35, "builder no longer promises one bounded source batch");
  assert(manifest.selection.source_structure_engine_used === false && manifest.selection.semantic_gold_created === false, "extension must not run structure inference or claim semantic gold");

  const datasets = Object.keys(parent.dataset_counts).sort();
  const baseDatasets = new Set(base.pairs.map((pair: Record<string, any>) => pair.source.dataset));
  const missing = datasets.filter((dataset) => !baseDatasets.has(dataset));
  assert(JSON.stringify(missing) === JSON.stringify([...EXPECTED_MISSING].sort()), "missing-dataset inventory changed");
  const missingPairs = pairs.slice(0, 15);
  const hardPairs = pairs.slice(15);
  assert(missingPairs.every(({ selection_receipt }) => selection_receipt.selection_layer === "missing_dataset_fill"), "first 15 are not the missing-dataset layer");
  assert(hardPairs.length === 20 && hardPairs.every(({ selection_receipt }) => selection_receipt.selection_layer === "hard_coverage"), "last 20 are not the hard layer");
  assert(JSON.stringify(missingPairs.map(({ source }) => source.dataset).sort()) === JSON.stringify([...EXPECTED_MISSING].sort()), "missing layer does not cover each absent dataset exactly once");
  assert(new Set(pairs.map(({ document_id }) => document_id)).size === 35, "extension source decisions are not unique");
  assert(!pairs.some(({ document_id }) => base.pairs.some((pair: Record<string, any>) => pair.document_id === document_id)), "extension overlaps an original source decision");

  const development = pairs.filter(({ evaluation_partition }) => evaluation_partition === "development");
  const holdout = pairs.filter(({ evaluation_partition }) => evaluation_partition === "locked_holdout");
  assert(development.length === 15 && holdout.length === 20, "extension must freeze 15 development and 20 locked holdout cases");
  assert(manifest.evaluation_split.frozen_before_model_review === true, "evaluation split is not declared frozen before model review");
  assert(development.some(({ selection_receipt }) => selection_receipt.selection_layer === "missing_dataset_fill") && development.some(({ selection_receipt }) => selection_receipt.selection_layer === "hard_coverage"), "development split is layer-confounded");
  assert(holdout.some(({ selection_receipt }) => selection_receipt.selection_layer === "missing_dataset_fill") && holdout.some(({ selection_receipt }) => selection_receipt.selection_layer === "hard_coverage"), "holdout split is layer-confounded");
  for (const stratum of [...new Set(pairs.map(evaluationStratum))]) {
    const rows = pairs.filter((pair) => evaluationStratum(pair) === stratum);
    if (rows.length >= 2) assert(rows.some(({ evaluation_partition }) => evaluation_partition === "development") && rows.some(({ evaluation_partition }) => evaluation_partition === "locked_holdout"), `${stratum}: evaluation split lost one partition`);
  }
  const external = pairs.filter(({ selection_receipt }) => !selection_receipt.target_resolved_in_a2aj);
  assert(external.length === 2 && external.filter(({ evaluation_partition }) => evaluation_partition === "development").length === 1 && external.filter(({ evaluation_partition }) => evaluation_partition === "locked_holdout").length === 1, "external targets are not split 1/1");

  assert(JSON.stringify(manifest.layers.hard_coverage.feature_counts) === JSON.stringify(EXPECTED_FEATURES), "hard-feature freeze changed");
  assert(new Set(hardPairs.map(({ source }) => source.dataset)).size >= 12, "hard layer covers fewer than 12 datasets");
  const sameLitigation = pairs.filter(({ target }) => target.same_litigation_eligible === true);
  assert(sameLitigation.length >= 5 && sameLitigation.every(({ selection_receipt }) => selection_receipt.hard_feature === "direct_history_cue"), "same-litigation coverage is weak or leaks outside direct history");
  assert(sameLitigation.some(({ evaluation_partition }) => evaluation_partition === "development") && sameLitigation.some(({ evaluation_partition }) => evaluation_partition === "locked_holdout"), "same-litigation cases are confined to one partition");

  const documents = fetchLocalA2AJDocumentsByIds({ ids: pairs.map(({ document_id }) => Number(document_id)), maxChars: Number.MAX_SAFE_INTEGER });
  assert(documents.size === 35, "single source batch did not return every extension decision");
  const targetExists = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const exists = database.prepare("SELECT 1 FROM citation_lookup WHERE citation_key=? AND document_id=?");
    return new Map(pairs.flatMap(({ target }) => target.document_id === null ? [] : [[target.document_id, Boolean(exists.get(citationLookupKey(target.citation), target.document_id))] as const]));
  });
  assert(targetExists, `A2AJ database not found: ${a2ajLocalBulkPath()}`);

  for (const pair of pairs) {
    const label = `${pair.source.dataset}/${pair.document_id}`;
    const document = documents.get(Number(pair.document_id));
    assert(document, `${label}: source disappeared`);
    assert(document.dataset === pair.source.dataset && document.citation === pair.source.citation && document.name === pair.source.name, `${label}: source identity changed`);
    assert((document.date?.slice(0, 10) ?? null) === pair.source.date && document.language === pair.source.language && document.url === pair.source.url, `${label}: source metadata changed`);
    assert(document.text.length === pair.selection_receipt.source_chars && sha256(document.text) === pair.selection_receipt.source_text_sha256, `${label}: source bytes changed`);
    assert(pair.selection_receipt.occurrence_contract.detector === "lightweight-literal-citation-and-name-v1" && pair.selection_receipt.occurrence_contract.citation_and_case_name_offsets_frozen === true, `${label}: occurrence contract changed`);
    assert(pair.selection_receipt.classification.source_structure_engine_used === false && pair.selection_receipt.classification.semantic_gold === false, `${label}: receipt claims unperformed inference`);
    assert(pair.selection_receipt.evaluation_stratum === evaluationStratum(pair), `${label}: evaluation stratum changed`);
    assert(pair.selection_receipt.evaluation_split_rank_sha256 === rank("evaluation-pair", evaluationStratum(pair), pair.challenge_id, pair.document_id), `${label}: evaluation rank changed`);

    if (pair.target.document_id === null) {
      const gate = pair.selection_receipt.external_identity_gate;
      assert(pair.selection_receipt.requested_target_resolution === "external" && pair.target.name?.trim() && pair.target.citation?.trim(), `${label}: external identity is incomplete`);
      assert(gate?.curator_reviewed === true && gate.complete_citation === true && gate.source_supported_case_name === true && gate.intended_substantive_context === true, `${label}: external identity was not curator-gated`);
      const item = gate.evidence;
      assert(document.text.slice(item.start, item.end_exclusive) === item.quote && sha256(item.quote) === item.sha256, `${label}: external name evidence moved`);
    } else {
      assert(pair.selection_receipt.requested_target_resolution === "resolved" && pair.selection_receipt.target_resolved_in_a2aj === true && targetExists.get(pair.target.document_id), `${label}: resolved target no longer resolves`);
      assert(pair.selection_receipt.external_identity_gate === null, `${label}: resolved target has an external gate`);
    }

    const lineage = pair.selection_receipt.source_lineage;
    let expectedRank: string;
    if (lineage.kind === "seeded_pair_manifest_rerank") {
      assert(lineage.file === PARENT && lineage.file_sha256 === sha256(parentRaw) && lineage.seed === parent.seed, `${label}: seeded lineage header changed`);
      const parentPair = parent.pairs[lineage.zero_based_pair_index];
      assert(parentPair?.document_id === pair.document_id && parentPair.target.document_id === pair.target.document_id && parentPair.target.citation === pair.target.citation, `${label}: seeded parent pair moved`);
      expectedRank = pair.selection_receipt.selection_layer === "missing_dataset_fill"
        ? rank("missing_dataset_fill", pair.source.dataset, pair.document_id, pair.target.document_id, citationLookupKey(pair.target.citation))
        : rank("hard_coverage", pair.selection_receipt.hard_feature, pair.source.dataset, pair.document_id, pair.target.document_id, citationLookupKey(pair.target.citation));
    } else {
      assert(lineage.kind === "curated_local_a2aj_source_evidence" && lineage.curator_protocol === "gold50-extension-source-review-v1" && lineage.target_selected_from_exact_local_citation === true && lineage.selection_rationale, `${label}: curated provenance is incomplete`);
      expectedRank = rank(pair.selection_receipt.selection_layer, pair.selection_receipt.hard_feature ?? pair.challenge_category, pair.source.dataset, pair.document_id, pair.target.document_id, citationLookupKey(pair.target.citation));
    }
    assert(pair.selection_receipt.seeded_rank_sha256 === expectedRank, `${label}: selection rank changed`);

    const expected = expectedOccurrences(document.text, pair.target as Target);
    assert(expected.some(({ kind }) => kind === "citation"), `${label}: target citation disappeared`);
    assert(JSON.stringify(pair.selection_receipt.target_occurrences) === JSON.stringify(expected), `${label}: exact target occurrence receipt changed`);
    const categoryEvidence = pair.selection_receipt.category_evidence as Array<Record<string, any>>;
    assert(categoryEvidence.length > 0, `${label}: category evidence missing`);
    for (const item of [...categoryEvidence, ...(pair.selection_receipt.feature_evidence as Array<Record<string, any>>)]) {
      assert(document.text.slice(item.start, item.end_exclusive) === item.quote && sha256(item.quote) === item.sha256, `${label}: evidence span moved`);
    }
    if (pair.challenge_category === "multi_opinion_or_partial_join") assert(categoryEvidence.length >= 2 && categoryEvidence.every(({ kind }) => kind === "reviewed_opinion_boundary_cue"), `${label}: multi-opinion evidence is incomplete`);
    if (pair.challenge_category === "attribution_trap") assert(categoryEvidence.every(({ kind }) => kind === "attribution_cue_context"), `${label}: attribution evidence is incomplete`);
    if (pair.challenge_category === "ordinary_control") assert(categoryEvidence.every(({ kind }) => kind === "ordinary_target_context"), `${label}: ordinary-control evidence is incomplete`);
    if (pair.selection_receipt.selection_layer === "hard_coverage") assert(pair.selection_receipt.feature_evidence.length > 0, `${label}: hard-feature evidence missing`);
    if (pair.selection_receipt.hard_feature === "short_decision") assert(document.text.length <= 8_000, `${label}: short-decision stratum changed`);
    if (pair.selection_receipt.hard_feature === "long_decision") assert(document.text.length >= 120_000, `${label}: long-decision stratum changed`);
  }

  const categories = ["multi_opinion_or_partial_join", "attribution_trap", "ordinary_control"];
  assert(JSON.stringify(countsBy(pairs, categories, ({ challenge_category }) => challenge_category)) === JSON.stringify(manifest.category_counts), "category counts changed");
  assert(JSON.stringify(countsBy(pairs, datasets, ({ source }) => source.dataset)) === JSON.stringify(manifest.dataset_counts), "extension dataset counts changed");
  assert(JSON.stringify(countsBy(hardPairs, Object.keys(EXPECTED_FEATURES), ({ selection_receipt }) => selection_receipt.hard_feature)) === JSON.stringify(manifest.layers.hard_coverage.feature_counts), "hard feature counts do not match pairs");
  const freezeKeys = pairs.map(freezeKey);
  const developmentKeys = development.map(freezeKey);
  const holdoutKeys = holdout.map(freezeKey);
  assert(sha256(JSON.stringify(freezeKeys)) === manifest.selection.frozen_pair_keys_sha256, "extension pair freeze hash changed");
  assert(sha256(JSON.stringify(developmentKeys)) === manifest.evaluation_split.development_pair_keys_sha256, "development freeze hash changed");
  assert(sha256(JSON.stringify(holdoutKeys)) === manifest.evaluation_split.locked_holdout_pair_keys_sha256, "holdout freeze hash changed");
  assert(sha256(JSON.stringify(missingPairs.map(freezeKey))) === manifest.layers.missing_dataset_fill.frozen_pair_keys_sha256, "missing-layer freeze hash changed");
  assert(sha256(JSON.stringify(hardPairs.map(freezeKey))) === manifest.layers.hard_coverage.frozen_pair_keys_sha256, "hard-layer freeze hash changed");

  const expectedCombinedPairs = [...base.pairs.map((pair: Record<string, any>) => ({ ...pair, evaluation_partition: "development_audit" })), ...pairs];
  assert(combined.requested_pairs === 50 && combined.pairs.length === 50, "combined manifest is not 50 cases");
  assert(JSON.stringify(combined.pairs) === JSON.stringify(expectedCombinedPairs), "combined manifest is not the exact base+extension freeze");
  assert(combined.source_manifests[0].file === BASE && combined.source_manifests[0].file_sha256 === sha256(baseRaw), "combined base receipt changed");
  assert(combined.source_manifests[1].file === path.basename(extensionFile) && combined.source_manifests[1].file_sha256 === sha256(extensionRaw), "combined extension receipt changed");
  assert(new Set(combined.pairs.map(({ document_id }: Record<string, any>) => document_id)).size === 50, "combined source decisions are not unique");
  assert(datasets.every((dataset) => combined.pairs.some(({ source }: Record<string, any>) => source.dataset === dataset)), "combined manifest does not cover all 29 A2AJ datasets");
  assert(JSON.stringify(countsBy(combined.pairs, datasets, ({ source }) => source.dataset)) === JSON.stringify(combined.dataset_counts), "combined dataset counts changed");
  assert(sha256(JSON.stringify(combined.pairs.map(freezeKey))) === combined.selection.frozen_pair_keys_sha256, "combined freeze hash changed");
  assert(combined.evaluation_split.development_audit_pairs === 15 && combined.evaluation_split.development_pairs === 15 && combined.evaluation_split.locked_holdout_pairs === 20, "combined evaluation split changed");
  const elapsedMs = Date.now() - started;
  assert(elapsedMs <= MAX_CHECK_MS, `checker exceeded ${MAX_CHECK_MS} ms`);
  console.log(JSON.stringify({
    ok: true,
    extension: extensionFile,
    combined: combinedFile,
    elapsed_ms: elapsedMs,
    extension_pairs: pairs.length,
    combined_pairs: combined.pairs.length,
    datasets_covered: datasets.length,
    development_pairs: development.length,
    locked_holdout_pairs: holdout.length,
    hard_feature_counts: manifest.layers.hard_coverage.feature_counts,
    same_litigation_eligible: sameLitigation.length,
    external_targets: external.length,
    source_bytes: pairs.reduce((sum, pair) => sum + pair.selection_receipt.source_chars, 0),
    target_occurrences: pairs.reduce((sum, pair) => sum + pair.selection_receipt.target_occurrences.length, 0),
    frozen_pair_keys_sha256: manifest.selection.frozen_pair_keys_sha256,
    combined_frozen_pair_keys_sha256: combined.selection.frozen_pair_keys_sha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
