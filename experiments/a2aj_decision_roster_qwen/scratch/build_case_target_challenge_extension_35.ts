import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASE_TARGET_OCCURRENCE_VERSION,
  detectCaseTargetOccurrences,
  type CaseTargetOccurrence,
} from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvp.ts";
import { a2ajLocalBulkPath, fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk";
import { citationLookupKey } from "../../../backend/src/lib/citationKey";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";
import type { A2AJDocument } from "../../../backend/src/lib/legalSources/a2aj";
import { createTextSourceDoc } from "../../../backend/src/lib/sourceDoc.ts";

type Category = "multi_opinion_or_partial_join" | "attribution_trap" | "ordinary_control";
type HardFeature = "multi_opinion" | "attribution_cue" | "collective_tribunal" | "direct_history_cue" | "explicit_treatment_cue" | "short_decision" | "long_decision";
type Layer = "missing_dataset_fill" | "hard_coverage";
type FixedSpec = {
  layer: Layer;
  dataset: string;
  documentId: number;
  targetDocumentId: number | null;
  targetCitation: string;
  targetName?: string;
  sameLitigationEligible?: boolean;
  category: Category;
  feature?: HardFeature;
  note: string;
};
type ParentPair = {
  document_id: number;
  target: { document_id: number | null; citation: string; citation_aliases: string[]; name: string | null };
  selection_receipt: {
    source_dataset: string;
    source_chars: number;
    target_resolved_in_a2aj: boolean;
    deterministic_occurrences: number;
    context_kinds: string[];
    first_occurrence_start: number;
  };
};
type Occurrence = CaseTargetOccurrence & {
  context: { start: number; end_exclusive: number; quote: string; sha256: string };
};
type Selected = {
  layer: Layer;
  category: Category;
  feature?: HardFeature;
  requestedTarget: "resolved" | "external";
  spec?: FixedSpec;
  parentIndex: number;
  parent: ParentPair;
  rank: string;
  scanRank: number | null;
};
type Candidate = Selected & {
  document: A2AJDocument;
  occurrences: Occurrence[];
  cues: Array<{ occurrence: Occurrence; rule: string }>;
  directHistoryCues: Array<{ occurrence: Occurrence; rule: string }>;
  multiEvidence: Array<Record<string, unknown>>;
  collectiveEvidence: Array<Record<string, unknown>>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "case-target-challenge-15.json";
const PARENT = "runs/case-target-budget-5000-seed-20260820.json";
const OUTPUT = "case-target-challenge-extension-35.json";
const COMBINED_OUTPUT = "case-target-challenge-50.json";
const SEED = 20_260_821;
const FROZEN_UTC = "2026-08-20T22:30:00.000Z";
const MAX_BUILD_MS = 5_000;
const CONTEXT_BEFORE = 320;
const CONTEXT_AFTER = 420;
const DEVELOPMENT_PAIRS = 15;

// Selected from parent-manifest metadata before any source bytes are read.
const HARD_SLOTS: Array<{ feature: HardFeature; target: "resolved"; count: number }> = [
  { feature: "short_decision", target: "resolved", count: 2 },
  { feature: "long_decision", target: "resolved", count: 2 },
];

const FIXED_SPECS: FixedSpec[] = [
  { layer: "missing_dataset_fill", dataset: "CMAC", documentId: 75090, targetDocumentId: 193459, targetCitation: "[1995] 4 S.C.R. 411", category: "multi_opinion_or_partial_join", note: "True lead plus separately authored concurrences; target appears three times across the reasons." },
  { layer: "missing_dataset_fill", dataset: "NSFC", documentId: 127807, targetDocumentId: 124645, targetCitation: "[2005] N.S.C.A. 101", category: "ordinary_control", note: "Private family-court format with a resolved appellate authority." },
  { layer: "missing_dataset_fill", dataset: "NSPC", documentId: 128664, targetDocumentId: 129187, targetCitation: "2012 NSPC 110", category: "attribution_trap", note: "Target is confined to a footnote tail after a courtroom transcript; metadata/footnote abstention control." },
  { layer: "missing_dataset_fill", dataset: "NSSC", documentId: 135892, targetDocumentId: null, targetCitation: "53 O.R. (3d) 137", targetName: "McIntyre Estate v. Ontario (Attorney General)", category: "ordinary_control", note: "Genuine external reported decision, retained as unresolved rather than force-linked." },
  { layer: "missing_dataset_fill", dataset: "NSSM", documentId: 139389, targetDocumentId: 192569, targetCitation: "[1996] 3 SCR 727", category: "ordinary_control", note: "Provincial small-claims format with a resolved Supreme Court authority." },
  { layer: "missing_dataset_fill", dataset: "OHSTC", documentId: 141017, targetDocumentId: 193091, targetCitation: "[1994] 1 S.C.R. 311", category: "attribution_trap", note: "Counsel invokes the target and a linked source footnote supports the current officer's stay analysis." },
  { layer: "missing_dataset_fill", dataset: "OIC", documentId: 141319, targetDocumentId: 101853, targetCitation: "2011 FC 983", category: "ordinary_control", note: "Information Commissioner decision with an ordinary resolved authority." },
  { layer: "missing_dataset_fill", dataset: "PSDPT", documentId: 165639, targetDocumentId: 165643, targetCitation: "2011 PSDPT 8", category: "attribution_trap", note: "Provider See-also metadata that must not become treatment or direct history." },
  { layer: "missing_dataset_fill", dataset: "RAD", documentId: 169514, targetDocumentId: 115160, targetCitation: "2016 FCA 93", category: "ordinary_control", note: "Refugee Appeal Division format using a resolved appellate authority." },
  { layer: "missing_dataset_fill", dataset: "RLLR", documentId: 180671, targetDocumentId: 193078, targetCitation: "[1993] 2 S.C.R. 689", category: "attribution_trap", note: "Target appears only as a final footnote/short-form link." },
  { layer: "missing_dataset_fill", dataset: "RPD", documentId: 182794, targetDocumentId: 78991, targetCitation: "2003 FC 1434", category: "ordinary_control", note: "Refugee Protection Division private-decision format with a resolved Federal Court authority." },
  { layer: "missing_dataset_fill", dataset: "SCT", documentId: 198390, targetDocumentId: 198365, targetCitation: "2016 SCTC 7", category: "attribution_trap", note: "Same-proceeding phase-order cue that the current direct-history enum cannot safely express." },

  { layer: "hard_coverage", dataset: "SCC", documentId: 198059, targetDocumentId: 191031, targetCitation: "[1988] 2 S.C.R. 345", category: "multi_opinion_or_partial_join", feature: "multi_opinion", note: "Two true opposing opinions; Morin occurs four times." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 189668, targetDocumentId: 190651, targetCitation: "2005 SCC 54", category: "multi_opinion_or_partial_join", feature: "multi_opinion", note: "Three substantive opinions in Lipson; Canada Trustco recurs across the reasons." },
  { layer: "hard_coverage", dataset: "BCCA", documentId: 9633, targetDocumentId: 13709, targetCitation: "2001 BCCA 450", category: "multi_opinion_or_partial_join", feature: "multi_opinion", note: "True majority and dissent with repeated Kowalewich discussion." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 193531, targetDocumentId: 188340, targetCitation: "[1992] 1 S.C.R. 595", category: "multi_opinion_or_partial_join", feature: "multi_opinion", note: "True majority and dissent; Clunas appears twice." },
  { layer: "hard_coverage", dataset: "CITT", documentId: 69897, targetDocumentId: 113962, targetCitation: "2008 FCA 36", category: "ordinary_control", feature: "direct_history_cue", note: "Systemes Equinox appellate/remand lineage candidate with exact source passage; semantic gold remains pending." },
  { layer: "hard_coverage", dataset: "CT", documentId: 75502, targetDocumentId: 114943, targetCitation: "2015 FCA 149", sameLitigationEligible: true, category: "ordinary_control", feature: "direct_history_cue", note: "The source expressly recounts the FCA dismissing Kobo's appeal in the same proceeding." },
  { layer: "hard_coverage", dataset: "TATC", documentId: 216447, targetDocumentId: 216281, targetCitation: "2022 TATCE 29", sameLitigationEligible: true, category: "ordinary_control", feature: "direct_history_cue", note: "Three-member appeal panel reviews the identified decision and ends with exact author/joiner cues." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 196170, targetDocumentId: 114486, targetCitation: "2005 FCA 348", category: "ordinary_control", feature: "explicit_treatment_cue", note: "Source expressly labels Grenier overruled." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 190708, targetDocumentId: null, targetCitation: "[1951] 2 All E.R. 834", targetName: "Fairclough v. Whipp", category: "ordinary_control", feature: "explicit_treatment_cue", note: "Short decision expressly says Fairclough was not followed; target is genuinely external." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 193973, targetDocumentId: 193101, targetCitation: "[1994] 1 S.C.R. 701", category: "ordinary_control", feature: "explicit_treatment_cue", note: "Source expressly distinguishes Finta in repeated discussion." },
  { layer: "hard_coverage", dataset: "SCC", documentId: 193620, targetDocumentId: 189614, targetCitation: "[1981] 1 S.C.R. 111", category: "attribution_trap", feature: "attribution_cue", note: "Journal criticism of Ron Engineering is quoted before the court declines to revisit it; not automatic current-court criticism." },
  { layer: "hard_coverage", dataset: "FPSLREB", documentId: 122844, targetDocumentId: 122706, targetCitation: "2016 PSLREB 90", category: "ordinary_control", feature: "collective_tribunal", note: "Three-member federal labour board panel; collective body and author attribution are independently visible." },
  { layer: "hard_coverage", dataset: "CT", documentId: 75548, targetDocumentId: 114555, targetCitation: "2003 FCA 53", category: "ordinary_control", feature: "collective_tribunal", note: "Two-member Competition Tribunal panel in a long decision with a resolved appellate authority." },
  { layer: "hard_coverage", dataset: "NSCA", documentId: 124598, targetDocumentId: 133611, targetCitation: "2007 NSSC 291", sameLitigationEligible: true, category: "ordinary_control", feature: "direct_history_cue", note: "Appeal from the identified trial decision in the same Silver Sands matter." },
  { layer: "hard_coverage", dataset: "FCA", documentId: 117893, targetDocumentId: 99370, targetCitation: "2013 FC 291", sameLitigationEligible: true, category: "ordinary_control", feature: "direct_history_cue", note: "Appeal dismissing the identified Federal Court decision in the same Soft-Moc matter." },
  { layer: "hard_coverage", dataset: "FCA", documentId: 116912, targetDocumentId: 76838, targetCitation: "2020 FC 624", sameLitigationEligible: true, category: "ordinary_control", feature: "direct_history_cue", note: "Appeal from the identified Federal Court judgment in the same Bauer Hockey matter." },
];

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rank(...parts: Array<string | number | null>) {
  return sha256([SEED, "challenge-extension", ...parts].join(":"));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contextOccurrence(document: A2AJDocument, occurrence: CaseTargetOccurrence): Occurrence {
  const start = Math.max(0, occurrence.start - CONTEXT_BEFORE);
  const end = Math.min(document.text.length, occurrence.end + CONTEXT_AFTER);
  const quote = document.text.slice(start, end);
  return { ...occurrence, context: { start, end_exclusive: end, quote, sha256: sha256(quote) } };
}

function attributionCue(text: string, occurrence: Occurrence) {
  const before = text.slice(Math.max(0, occurrence.start - 280), occurrence.start);
  const after = text.slice(occurrence.end, Math.min(text.length, occurrence.end + 140));
  if (/\b(?:applicant|appellant|complainant|claimant|respondent|minister|counsel|party|union|employer)s?'?\s+(?:argu(?:e[sd]?|ment)|submit(?:s|ted)?|contend(?:s|ed)?|position|rel(?:y|ies|ied))\b|\b(?:argu(?:e[sd]?|ment)|submit(?:s|ted)?|contend(?:s|ed)?|rel(?:y|ies|ied))\s+(?:that|on|upon|principally)\b/iu.test(before)) return "party_attribution_cue";
  if (/\b(?:held|stated|wrote|observed|said|explained|concluded|noted|commented|described)\b[^\n]{0,180}$/iu.test(before) || /^\s*(?:at\s+para(?:graph)?s?\.?\s+\d+[^:]{0,50})?:/iu.test(after)) return "reported_decision_voice_cue";
  return /:\s*$/u.test(before) || /^\s*:\s*(?:\r?\n)/u.test(after) ? "quotation_boundary_cue" : null;
}

function directHistoryCue(text: string, occurrence: Occurrence) {
  const value = text.slice(Math.max(0, occurrence.start - 340), Math.min(text.length, occurrence.end + 300));
  if (/\b(?:decision\s+under\s+review|appeal(?:ed|s)?\s+from|judicial\s+review\s+of|remit(?:ted)?|returned\s+to|affirmed|reversed|varied|quashed)\b/iu.test(value)) return "prior_stage_relation";
  if (/\b(?:procedural\s+history|history\s+of\s+(?:this|the)\s+(?:matter|proceeding|case))\b/iu.test(value)) return "procedural_history_context";
  return null;
}

function evidence(text: string, start: number, end: number, kind: string, rule: string, extra: Record<string, unknown> = {}) {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(text.length, end);
  const quote = text.slice(boundedStart, boundedEnd);
  return { kind, rule, ...extra, start: boundedStart, end_exclusive: boundedEnd, quote, sha256: sha256(quote) };
}

function matchingLineEvidence(text: string, pattern: RegExp, kind: string, rule: string, limit: number, end = text.length) {
  const rows: Array<Record<string, unknown>> = [];
  let start = 0;
  while (start < end && rows.length < limit) {
    const nextNewline = text.indexOf("\n", start);
    const lineEnd = Math.min(end, nextNewline < 0 ? end : nextNewline);
    const line = text.slice(start, lineEnd).trim();
    if (line.length > 0 && line.length <= 500 && pattern.test(line)) rows.push(evidence(text, start, lineEnd, kind, rule));
    start = lineEnd + 1;
  }
  return rows;
}

function multiOpinionEvidence(text: string) {
  return matchingLineEvidence(
    text,
    /^(?:\[\d+\]\s*)?(?:reasons?\s+(?:for|of)\s+(?:judgment|decision|[A-Z])|the\s+(?:judgment|reasons)\s+of\b|concurring\s+reasons\s+by\b|dissenting\s+reasons\s+by\b|.*\bJ(?:\.|\.A\.)?\s*\((?:dissenting|concurring)\)\s*[\u2014:-])/iu,
    "reviewed_opinion_boundary_cue",
    "curated_exact_source_heading_span",
    4,
  );
}

function collectiveEvidence(text: string) {
  return matchingLineEvidence(
    text,
    /\b(?:panel|board|tribunal|before\s*:|for\s+the\s+tribunal|decision\s+of\s+the\s+tribunal)\b/iu,
    "reviewed_collective_tribunal_cue",
    "curated_exact_source_header_span",
    2,
    Math.min(text.length, 16_000),
  );
}

function externalNameEvidence(text: string, name: string) {
  const phrases = [name, name.split(/\s+v(?:\.|ersus)?\s+/iu)[0]?.trim()].filter((value): value is string => Boolean(value));
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
    const match = new RegExp(escaped, "iu").exec(text);
    if (match) return evidence(text, match.index, match.index + match[0].length, "external_target_identity", "curator_verified_source_name_span");
  }
  return null;
}

function categoryEvidence(candidate: Candidate) {
  const text = candidate.document.text;
  if (candidate.category === "multi_opinion_or_partial_join") return candidate.multiEvidence;
  if (candidate.category === "attribution_trap") {
    const cues = candidate.cues.length ? candidate.cues : [{ occurrence: candidate.occurrences[0], rule: "curated_attribution_or_metadata_trap" }];
    return cues.slice(0, 2).map(({ occurrence, rule }) => evidence(text, occurrence.context.start, occurrence.context.end_exclusive, "attribution_cue_context", rule, { occurrence_id: occurrence.id }));
  }
  const occurrence = candidate.occurrences[0];
  return [evidence(text, occurrence.context.start, occurrence.context.end_exclusive, "ordinary_target_context", "selected_target_context", { occurrence_id: occurrence.id })];
}

function featureEvidence(candidate: Candidate) {
  const text = candidate.document.text;
  if (candidate.feature === "multi_opinion") return candidate.multiEvidence;
  if (candidate.feature === "attribution_cue") return categoryEvidence(candidate);
  if (candidate.feature === "collective_tribunal") return candidate.collectiveEvidence;
  if (candidate.feature === "direct_history_cue") {
    const cues = candidate.directHistoryCues.length ? candidate.directHistoryCues : [{ occurrence: candidate.occurrences[0], rule: "curated_procedural_relation_context" }];
    return cues.slice(0, 2).map(({ occurrence, rule }) => evidence(text, occurrence.context.start, occurrence.context.end_exclusive, "direct_history_cue_context", rule, { occurrence_id: occurrence.id }));
  }
  if (candidate.feature === "explicit_treatment_cue") {
    const occurrence = candidate.occurrences.find(({ context }) => /\b(?:overruled|not\s+followed|distinguish(?:ed|es|ing)?)\b/iu.test(context.quote)) ?? candidate.occurrences[0];
    return [evidence(text, occurrence.context.start, occurrence.context.end_exclusive, "explicit_treatment_context", "curated_treatment_label_context", { occurrence_id: occurrence.id })];
  }
  if (candidate.feature === "short_decision" || candidate.feature === "long_decision") {
    return [evidence(text, 0, Math.min(text.length, 500), "source_length_sample", candidate.feature === "short_decision" ? "source_chars<=8000" : "source_chars>=120000", { source_chars: text.length })];
  }
  return [];
}

function evaluationStratum(pair: Record<string, any>) {
  const feature = pair.selection_receipt.hard_feature as HardFeature | null;
  if (feature === "multi_opinion") return "multi_opinion";
  if (feature === "attribution_cue") return "attribution_trap";
  if (feature) return feature;
  if (pair.challenge_category === "multi_opinion_or_partial_join") return "multi_opinion";
  return pair.challenge_category as Category;
}

function freezeEvaluationSplit(pairs: Array<Record<string, any>>) {
  const external = pairs.filter((pair) => !pair.selection_receipt.target_resolved_in_a2aj)
    .sort((left, right) => rank("evaluation-external", left.challenge_id, left.document_id).localeCompare(rank("evaluation-external", right.challenge_id, right.document_id)));
  assert(external.length >= 2, "evaluation split requires at least two curator-gated external targets");
  const forcedDevelopment = new Set([external[0].challenge_id]);
  const forcedHoldout = new Set(external.slice(1).map(({ challenge_id }) => challenge_id));
  const resolved = pairs.filter((pair) => pair.selection_receipt.target_resolved_in_a2aj);
  const groups = new Map<string, Array<Record<string, any>>>();
  for (const pair of resolved) {
    const stratum = evaluationStratum(pair);
    groups.set(stratum, [...(groups.get(stratum) ?? []), pair]);
  }
  const target = DEVELOPMENT_PAIRS - forcedDevelopment.size;
  const quotas = new Map<string, number>();
  const ratio = target / resolved.length;
  for (const [stratum, group] of groups) {
    const floor = Math.floor(group.length * ratio);
    quotas.set(stratum, group.length >= 2 ? Math.max(1, Math.min(group.length - 1, floor)) : floor);
  }
  const quotaTotal = () => [...quotas.values()].reduce((sum, value) => sum + value, 0);
  while (quotaTotal() < target) {
    const choice = [...groups].filter(([stratum, group]) => (quotas.get(stratum) ?? 0) < group.length - (group.length >= 2 ? 1 : 0))
      .sort(([left, leftGroup], [right, rightGroup]) => {
        const difference = rightGroup.length * ratio - (quotas.get(right) ?? 0) - (leftGroup.length * ratio - (quotas.get(left) ?? 0));
        return difference || rank("evaluation-quota", left).localeCompare(rank("evaluation-quota", right));
      })[0];
    assert(choice, "cannot fill deterministic development quota");
    quotas.set(choice[0], (quotas.get(choice[0]) ?? 0) + 1);
  }
  while (quotaTotal() > target) {
    const choice = [...groups].filter(([stratum, group]) => (quotas.get(stratum) ?? 0) > (group.length >= 2 ? 1 : 0))
      .sort(([left, leftGroup], [right, rightGroup]) => {
        const difference = (quotas.get(right) ?? 0) - rightGroup.length * ratio - ((quotas.get(left) ?? 0) - leftGroup.length * ratio);
        return difference || rank("evaluation-quota", left).localeCompare(rank("evaluation-quota", right));
      })[0];
    assert(choice, "cannot reduce deterministic development quota");
    quotas.set(choice[0], (quotas.get(choice[0]) ?? 0) - 1);
  }
  for (const [stratum, group] of groups) {
    group.sort((left, right) => rank("evaluation-pair", stratum, left.challenge_id, left.document_id).localeCompare(rank("evaluation-pair", stratum, right.challenge_id, right.document_id)));
    for (const pair of group.slice(0, quotas.get(stratum))) forcedDevelopment.add(pair.challenge_id);
  }
  for (const pair of pairs) {
    pair.evaluation_partition = forcedDevelopment.has(pair.challenge_id) ? "development" : "locked_holdout";
    assert(!forcedHoldout.has(pair.challenge_id) || pair.evaluation_partition === "locked_holdout", `${pair.challenge_id}: external holdout assignment moved`);
    pair.selection_receipt.evaluation_stratum = evaluationStratum(pair);
    pair.selection_receipt.evaluation_split_rank_sha256 = rank("evaluation-pair", evaluationStratum(pair), pair.challenge_id, pair.document_id);
  }
  assert(pairs.filter(({ evaluation_partition }) => evaluation_partition === "development").length === DEVELOPMENT_PAIRS, "development split is not 15 cases");
}

async function main() {
  const started = Date.now();
  const outAt = process.argv.indexOf("--out");
  const output = path.resolve(outAt >= 0 ? process.argv[outAt + 1] : path.join(ROOT, OUTPUT));
  const combinedAt = process.argv.indexOf("--combined-out");
  const combinedOutput = path.resolve(combinedAt >= 0 ? process.argv[combinedAt + 1] : path.join(ROOT, COMBINED_OUTPUT));
  const [baseRaw, parentRaw] = await Promise.all([readFile(path.join(ROOT, BASE), "utf8"), readFile(path.join(ROOT, PARENT), "utf8")]);
  const base = JSON.parse(baseRaw) as { pairs: Array<Record<string, any>> };
  const parent = JSON.parse(parentRaw) as { seed: number; dataset_counts: Record<string, number>; pairs: ParentPair[] };
  const datasets = Object.keys(parent.dataset_counts).sort();
  const baseIds = new Set(base.pairs.map(({ document_id }) => Number(document_id)));
  const represented = new Set(base.pairs.map(({ source }) => String(source.dataset)));
  const missing = datasets.filter((dataset) => !represented.has(dataset));
  assert(missing.length === 15, `expected 15 unrepresented datasets, found ${missing.length}`);

  const fixedIds = new Set(FIXED_SPECS.map(({ documentId }) => documentId));
  const selected: Selected[] = FIXED_SPECS.map((spec, index) => ({
    layer: spec.layer,
    category: spec.category,
    feature: spec.feature,
    requestedTarget: spec.targetDocumentId === null ? "external" : "resolved",
    spec,
    parentIndex: -(index + 1),
    parent: {
      document_id: spec.documentId,
      target: { document_id: spec.targetDocumentId, citation: spec.targetCitation, citation_aliases: [], name: spec.targetName ?? null },
      selection_receipt: {
        source_dataset: spec.dataset,
        source_chars: 0,
        target_resolved_in_a2aj: spec.targetDocumentId !== null,
        deterministic_occurrences: 0,
        context_kinds: [],
        first_occurrence_start: -1,
      },
    },
    rank: rank(spec.layer, spec.feature ?? spec.category, spec.dataset, spec.documentId, spec.targetDocumentId, citationLookupKey(spec.targetCitation)),
    scanRank: null,
  }));

  const rows = parent.pairs.map((pair, parentIndex) => ({ pair, parentIndex }));
  for (const dataset of missing.filter((value) => !selected.some((item) => item.layer === "missing_dataset_fill" && item.parent.selection_receipt.source_dataset === value))) {
    const choices = rows.filter(({ pair }) => pair.selection_receipt.source_dataset === dataset && pair.selection_receipt.target_resolved_in_a2aj && pair.target.document_id !== null && !baseIds.has(pair.document_id) && !fixedIds.has(pair.document_id))
      .map(({ pair, parentIndex }) => ({ pair, parentIndex, rank: rank("missing_dataset_fill", dataset, pair.document_id, pair.target.document_id, citationLookupKey(pair.target.citation)) }))
      .sort((left, right) => left.rank.localeCompare(right.rank));
    assert(choices.length > 0, `${dataset}: no resolved seeded candidate`);
    const choice = choices[0];
    selected.push({ layer: "missing_dataset_fill", category: "ordinary_control", requestedTarget: "resolved", parent: choice.pair, parentIndex: choice.parentIndex, rank: choice.rank, scanRank: 0 });
  }

  const usedIds = new Set([...baseIds, ...selected.map(({ parent }) => parent.document_id)]);
  const usedHardDatasets = new Set(selected.filter(({ layer }) => layer === "hard_coverage").map(({ parent }) => parent.selection_receipt.source_dataset));
  for (const slot of HARD_SLOTS) {
    for (let ordinal = 0; ordinal < slot.count; ordinal += 1) {
      const choices = rows.filter(({ pair }) => pair.selection_receipt.target_resolved_in_a2aj && pair.target.document_id !== null && !usedIds.has(pair.document_id))
        .filter(({ pair }) => slot.feature === "short_decision" ? pair.selection_receipt.source_chars <= 8_000 : pair.selection_receipt.source_chars >= 120_000)
        .map(({ pair, parentIndex }) => ({ pair, parentIndex, rank: rank("hard_coverage", slot.feature, pair.selection_receipt.source_dataset, pair.document_id, pair.target.document_id, citationLookupKey(pair.target.citation)) }))
        .sort((left, right) => Number(usedHardDatasets.has(left.pair.selection_receipt.source_dataset)) - Number(usedHardDatasets.has(right.pair.selection_receipt.source_dataset)) || left.rank.localeCompare(right.rank));
      assert(choices.length > 0, `no seeded ${slot.feature} candidate`);
      const choice = choices[0];
      const scanRank = choices.filter(({ pair }) => pair.selection_receipt.source_dataset === choice.pair.selection_receipt.source_dataset).findIndex(({ parentIndex }) => parentIndex === choice.parentIndex);
      selected.push({ layer: "hard_coverage", category: "ordinary_control", feature: slot.feature, requestedTarget: slot.target, parent: choice.pair, parentIndex: choice.parentIndex, rank: choice.rank, scanRank });
      usedIds.add(choice.pair.document_id);
      usedHardDatasets.add(choice.pair.selection_receipt.source_dataset);
    }
  }
  assert(selected.filter(({ layer }) => layer === "missing_dataset_fill").length === 15, "missing layer must contain 15 cases");
  assert(selected.filter(({ layer }) => layer === "hard_coverage").length === 20, "hard layer must contain 20 cases");
  assert(new Set(selected.map(({ parent }) => parent.document_id)).size === 35, "extension sources must be unique");
  console.error(JSON.stringify({ phase: "selection", elapsed_ms: Date.now() - started, selected: selected.length }));

  const targetIds = [...new Set(selected.flatMap(({ parent }) => parent.target.document_id === null ? [] : [parent.target.document_id]))];
  const targetRows = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const get = database.prepare("SELECT id, name_en, citation_en, citation2_en, citation_fr, citation2_fr FROM document WHERE id=? AND doc_type='cases'");
    return new Map(targetIds.map((id) => [id, get.get(id) as Record<string, unknown>]));
  });
  assert(targetRows, `A2AJ database not found: ${a2ajLocalBulkPath()}`);
  for (const item of selected) {
    const id = item.parent.target.document_id;
    if (id === null) continue;
    const row = targetRows.get(id);
    assert(row, `${item.parent.selection_receipt.source_dataset}/${item.parent.document_id}: resolved target disappeared`);
    const aliases = [...new Set([row.citation_en, row.citation2_en, row.citation_fr, row.citation2_fr]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "" && citationLookupKey(value) !== citationLookupKey(item.parent.target.citation)))];
    item.parent.target.citation_aliases = [...new Set([...item.parent.target.citation_aliases, ...aliases])];
    item.parent.target.name = typeof row.name_en === "string" ? row.name_en : item.parent.target.name;
  }

  // The only source-text read: exactly the frozen 35 selected decisions.
  const documents = fetchLocalA2AJDocumentsByIds({ ids: selected.map(({ parent }) => parent.document_id), maxChars: Number.MAX_SAFE_INTEGER });
  console.error(JSON.stringify({ phase: "source_read", elapsed_ms: Date.now() - started, documents: documents.size }));
  const candidates = selected.map((item): Candidate => {
    const document = documents.get(item.parent.document_id);
    assert(document, `${item.parent.selection_receipt.source_dataset}/${item.parent.document_id}: source disappeared`);
    assert(document.dataset === item.parent.selection_receipt.source_dataset, `${item.parent.document_id}: source dataset changed`);
    const occurrences = detectCaseTargetOccurrences(createTextSourceDoc(document.text), {
      citation: item.parent.target.citation,
      citationAliases: item.parent.target.citation_aliases,
      name: item.parent.target.name,
    }).map((occurrence) => contextOccurrence(document, occurrence));
    assert(occurrences.some(({ kind }) => kind === "citation"), `${document.dataset}/${item.parent.document_id}: exact target citation not found`);
    const cues = occurrences.flatMap((occurrence) => {
      const rule = attributionCue(document.text, occurrence);
      return rule ? [{ occurrence, rule }] : [];
    });
    const directHistoryCues = occurrences.flatMap((occurrence) => {
      const rule = directHistoryCue(document.text, occurrence);
      return rule ? [{ occurrence, rule }] : [];
    });
    const multiEvidence = item.category === "multi_opinion_or_partial_join" || item.feature === "multi_opinion" ? multiOpinionEvidence(document.text) : [];
    assert(!(item.spec && (item.category === "multi_opinion_or_partial_join" || item.feature === "multi_opinion")) || multiEvidence.length >= 2, `${document.dataset}/${item.parent.document_id}: reviewed multi-opinion headings were not preserved`);
    const collective = item.feature === "collective_tribunal" ? collectiveEvidence(document.text) : [];
    assert(item.feature !== "collective_tribunal" || collective.length > 0, `${document.dataset}/${item.parent.document_id}: reviewed collective-body cue was not preserved`);
    return { ...item, document, occurrences, cues, directHistoryCues, multiEvidence, collectiveEvidence: collective };
  });
  console.error(JSON.stringify({ phase: "occurrences", elapsed_ms: Date.now() - started, candidates: candidates.length }));

  const makePair = (candidate: Candidate, challengeId: string) => {
    const text = candidate.document.text;
    const externalIdentity = candidate.parent.target.document_id === null ? externalNameEvidence(text, candidate.parent.target.name ?? "") : null;
    assert(candidate.parent.target.document_id !== null || externalIdentity, `${candidate.document.dataset}/${candidate.parent.document_id}: external target lacks an exact source-supported name`);
    return {
      challenge_id: challengeId,
      challenge_category: candidate.category,
      document_id: candidate.parent.document_id,
      source: {
        dataset: candidate.document.dataset,
        citation: candidate.document.citation,
        name: candidate.document.name,
        date: candidate.document.date?.slice(0, 10) ?? null,
        language: candidate.document.language,
        url: candidate.document.url,
      },
      target: {
        document_id: candidate.parent.target.document_id,
        citation: candidate.parent.target.citation,
        citation_aliases: candidate.parent.target.citation_aliases,
        name: candidate.parent.target.name,
        same_litigation_eligible: candidate.spec?.sameLitigationEligible === true,
      },
      selection_receipt: {
        selection_layer: candidate.layer,
        hard_feature: candidate.feature ?? null,
        requested_target_resolution: candidate.requestedTarget,
        challenge_seed: SEED,
        seeded_rank_sha256: candidate.rank,
        source_lineage: candidate.parentIndex >= 0 ? {
          kind: "seeded_pair_manifest_rerank",
          file: PARENT,
          file_sha256: sha256(parentRaw),
          seed: parent.seed,
          zero_based_pair_index: candidate.parentIndex,
          extension_scan_rank: candidate.scanRank,
        } : {
          kind: "curated_local_a2aj_source_evidence",
          curator_protocol: "gold50-extension-source-review-v1",
          corpus: "local A2AJ case database",
          deterministic_query_or_stratum: candidate.spec?.feature ?? candidate.spec?.category ?? null,
          target_selected_from_exact_local_citation: true,
          selection_rationale: candidate.spec?.note ?? null,
        },
        classification: {
          rule: "lightweight-exact-evidence-v2",
          source_structure_engine_used: false,
          semantic_gold: false,
          attribution_cue_rules: [...new Set(candidate.cues.map(({ rule }) => rule))],
          direct_history_cue_rules: [...new Set(candidate.directHistoryCues.map(({ rule }) => rule))],
          reviewed_multi_opinion_evidence_spans: candidate.multiEvidence.length,
          reviewed_collective_evidence_spans: candidate.collectiveEvidence.length,
        },
        occurrence_contract: {
          detector: CASE_TARGET_OCCURRENCE_VERSION,
          source_view: "byte-identical-source-text",
          citation_and_case_name_offsets_frozen: true,
          linked_footnote_context_deferred: true,
        },
        source_chars: text.length,
        source_text_sha256: sha256(text),
        target_resolved_in_a2aj: candidate.parent.target.document_id !== null,
        external_identity_gate: externalIdentity ? {
          curator_reviewed: true,
          complete_citation: true,
          source_supported_case_name: true,
          intended_substantive_context: true,
          evidence: externalIdentity,
        } : null,
        target_occurrences: candidate.occurrences,
        category_evidence: categoryEvidence(candidate),
        feature_evidence: featureEvidence(candidate),
      },
    };
  };

  const missingCandidates = candidates.filter(({ layer }) => layer === "missing_dataset_fill").sort((left, right) => left.document.dataset.localeCompare(right.document.dataset));
  const missingPairs = missingCandidates.map((candidate) => makePair(candidate, `missing-${candidate.document.dataset.toLocaleLowerCase()}`));
  const ordinals = new Map<HardFeature, number>();
  const hardPairs = candidates.filter(({ layer }) => layer === "hard_coverage").map((candidate) => {
    const ordinal = (ordinals.get(candidate.feature!) ?? 0) + 1;
    ordinals.set(candidate.feature!, ordinal);
    return makePair(candidate, `hard-${candidate.feature!.replaceAll("_", "-")}-${String(ordinal).padStart(2, "0")}`);
  });
  const pairs: Array<Record<string, any>> = [...missingPairs, ...hardPairs];
  freezeEvaluationSplit(pairs);

  const categories: Category[] = ["multi_opinion_or_partial_join", "attribution_trap", "ordinary_control"];
  const freezeKey = (pair: Record<string, any>) => [pair.challenge_id, pair.document_id, pair.target.document_id, pair.target.citation];
  const freezeKeys = pairs.map(freezeKey);
  const developmentKeys = pairs.filter(({ evaluation_partition }) => evaluation_partition === "development").map(freezeKey);
  const holdoutKeys = pairs.filter(({ evaluation_partition }) => evaluation_partition === "locked_holdout").map(freezeKey);
  const partitionCounts = (items: Array<Record<string, any>>) => ({
    development: items.filter(({ evaluation_partition }) => evaluation_partition === "development").length,
    locked_holdout: items.filter(({ evaluation_partition }) => evaluation_partition === "locked_holdout").length,
  });
  const hardFeatureCounts = Object.fromEntries([...ordinals]);
  const targetResolutionCounts = {
    resolved: hardPairs.filter(({ selection_receipt }) => selection_receipt.target_resolved_in_a2aj).length,
    external: hardPairs.filter(({ selection_receipt }) => !selection_receipt.target_resolved_in_a2aj).length,
  };
  const manifest = {
    format: "a2aj-case-target-challenge-extension-v2",
    created_utc: FROZEN_UTC,
    seed: SEED,
    requested_pairs: pairs.length,
    combined_with_base_pairs: base.pairs.length + pairs.length,
    combined_manifest: path.basename(combinedOutput),
    extends: { file: BASE, file_sha256: sha256(baseRaw) },
    selection: {
      algorithm: "curated-plus-seeded-metadata-strata-v3",
      parent_manifest: PARENT,
      parent_manifest_sha256: sha256(parentRaw),
      source_text_reads: { strategy: "one_batched_read_after_selection", requested_documents: pairs.length },
      source_structure_engine_used: false,
      one_full_citing_decision_per_call: true,
      one_target_per_call: true,
      target_decision_text_included: false,
      semantic_gold_created: false,
      frozen_pair_keys_sha256: sha256(JSON.stringify(freezeKeys)),
    },
    evaluation_split: {
      algorithm: "seeded-stratified-after-selection-v1",
      frozen_before_model_review: true,
      development_pairs: developmentKeys.length,
      locked_holdout_pairs: holdoutKeys.length,
      development_pair_keys_sha256: sha256(JSON.stringify(developmentKeys)),
      locked_holdout_pair_keys_sha256: sha256(JSON.stringify(holdoutKeys)),
      external_targets_split: partitionCounts(pairs.filter(({ selection_receipt }) => !selection_receipt.target_resolved_in_a2aj)),
      strata: Object.fromEntries([...new Set(pairs.map(evaluationStratum))].sort().map((stratum) => [stratum, partitionCounts(pairs.filter((pair) => evaluationStratum(pair) === stratum))])),
    },
    layers: {
      missing_dataset_fill: {
        pairs: missingPairs.length,
        datasets: missing,
        target_resolution_counts: {
          resolved: missingPairs.filter(({ selection_receipt }) => selection_receipt.target_resolved_in_a2aj).length,
          external: missingPairs.filter(({ selection_receipt }) => !selection_receipt.target_resolved_in_a2aj).length,
        },
        evaluation_partition_counts: partitionCounts(missingPairs),
        frozen_pair_keys_sha256: sha256(JSON.stringify(missingPairs.map(freezeKey))),
      },
      hard_coverage: {
        pairs: hardPairs.length,
        candidate_frame_datasets: datasets,
        selected_datasets: [...new Set(hardPairs.map(({ source }) => source.dataset))].sort(),
        feature_counts: hardFeatureCounts,
        target_resolution_counts: targetResolutionCounts,
        evaluation_partition_counts: partitionCounts(hardPairs),
        frozen_pair_keys_sha256: sha256(JSON.stringify(hardPairs.map(freezeKey))),
      },
    },
    category_counts: Object.fromEntries(categories.map((category) => [category, pairs.filter(({ challenge_category }) => challenge_category === category).length])),
    dataset_counts: Object.fromEntries(datasets.map((dataset) => [dataset, pairs.filter(({ source }) => source.dataset === dataset).length])),
    pairs,
  };
  const extensionJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const combinedPairs: Array<Record<string, any>> = [...base.pairs.map((pair) => ({ ...pair, evaluation_partition: "development_audit" })), ...pairs];
  const combinedFreezeKeys = combinedPairs.map(freezeKey);
  const combined = {
    format: "a2aj-case-target-challenge-combined-v1",
    created_utc: FROZEN_UTC,
    seeds: [20_260_820, SEED],
    requested_pairs: combinedPairs.length,
    source_manifests: [
      { file: BASE, file_sha256: sha256(baseRaw), pairs: base.pairs.length },
      { file: path.basename(output), file_sha256: sha256(extensionJson), pairs: pairs.length },
    ],
    layers: { original_challenge: { pairs: base.pairs.length }, ...manifest.layers },
    evaluation_split: {
      development_audit_pairs: base.pairs.length,
      development_pairs: developmentKeys.length,
      locked_holdout_pairs: holdoutKeys.length,
      development_pair_keys_sha256: manifest.evaluation_split.development_pair_keys_sha256,
      locked_holdout_pair_keys_sha256: manifest.evaluation_split.locked_holdout_pair_keys_sha256,
    },
    selection: { algorithm: "frozen-base-plus-gold50-extension-v1", semantic_gold_created: false, frozen_pair_keys_sha256: sha256(JSON.stringify(combinedFreezeKeys)) },
    category_counts: Object.fromEntries(categories.map((category) => [category, combinedPairs.filter(({ challenge_category }) => challenge_category === category).length])),
    dataset_counts: Object.fromEntries(datasets.map((dataset) => [dataset, combinedPairs.filter(({ source }) => source.dataset === dataset).length])),
    pairs: combinedPairs,
  };
  assert(Date.now() - started <= MAX_BUILD_MS, `selection/read/receipt build exceeded ${MAX_BUILD_MS} ms`);
  await Promise.all([writeFile(output, extensionJson, "utf8"), writeFile(combinedOutput, `${JSON.stringify(combined, null, 2)}\n`, "utf8")]);
  const elapsedMs = Date.now() - started;
  assert(elapsedMs <= MAX_BUILD_MS, `full build exceeded ${MAX_BUILD_MS} ms`);
  console.log(JSON.stringify({ ok: true, output, combined_output: combinedOutput, elapsed_ms: elapsedMs, max_build_ms: MAX_BUILD_MS, source_reads: 1, source_documents: documents.size, seed: SEED, extension_pairs: pairs.length, combined_pairs: combinedPairs.length, development_pairs: developmentKeys.length, locked_holdout_pairs: holdoutKeys.length, frozen_pair_keys_sha256: manifest.selection.frozen_pair_keys_sha256, combined_frozen_pair_keys_sha256: combined.selection.frozen_pair_keys_sha256 }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
