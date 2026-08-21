import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASE_TARGET_OCCURRENCE_VERSION,
  detectCaseTargetOccurrences,
} from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvp.ts";
import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentsByIds,
} from "../../../backend/src/lib/a2ajLocalBulk";
import { citationLookupKey } from "../../../backend/src/lib/citationKey";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";
import { createTextSourceDoc } from "../../../backend/src/lib/sourceDoc.ts";

type Category = "multi_opinion_or_partial_join" | "attribution_trap" | "ordinary_control";
type EvidenceKind = "opinion_boundary" | "party_or_reported_voice" | "current_decision_voice" | "current_decision_treatment";

type Spec = {
  id: string;
  category: Category;
  documentId: number;
  targetDocumentId: number;
  targetCitation: string;
  sameLitigationEligible?: boolean;
  lineage: Record<string, unknown>;
  evidence: Array<{ kind: EvidenceKind; quote: string }>;
  note: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNS = path.join(ROOT, "runs");
const SEED = 20_260_820;
const FROZEN_UTC = "2026-08-20T15:05:00.000Z";
const BUDGET_MANIFEST = "case-target-budget-5000-seed-20260820.json";
const AUDIT = "stress-random15k-deterministic-v6b-seed20260819.results.jsonl";

const auditLineage = (documentId: number) => ({
  kind: "seeded_deterministic_audit",
  file: `runs/${AUDIT}`,
  seed: 20_260_819,
  document_id: documentId,
});
const budgetLineage = (index: number) => ({
  kind: "seeded_pair_manifest",
  file: `runs/${BUDGET_MANIFEST}`,
  seed: SEED,
  zero_based_pair_index: index,
});

const SPECS: Spec[] = [
  {
    id: "multi-01", category: "multi_opinion_or_partial_join", documentId: 190426,
    targetDocumentId: 196690, targetCitation: "[1991] 1 S.C.R. 509",
    lineage: auditLineage(190426),
    evidence: [
      { kind: "opinion_boundary", quote: "Joint Reasons for Judgment: (paras. 1 to 104)" },
      { kind: "opinion_boundary", quote: "Concurring Reasons: (paras. 105 to 123)" },
      { kind: "opinion_boundary", quote: "Concurring Reasons: (paras. 124 to 147)" },
      { kind: "opinion_boundary", quote: "Dissenting Reasons: (paras. 221 to 317)" },
    ],
    note: "Four substantive opinion blocks; Sherratt is discussed in the lead, concurring, and dissenting reasons.",
  },
  {
    id: "multi-02", category: "multi_opinion_or_partial_join", documentId: 193954,
    targetDocumentId: 191310, targetCitation: "[1985] 1 S.C.R. 295",
    lineage: auditLineage(193954),
    evidence: [
      { kind: "opinion_boundary", quote: "Joint Reasons for Judgment: (paras. 1 to 48)" },
      { kind: "opinion_boundary", quote: "Concurring Reasons: (paras. 49 to 137)" },
      { kind: "opinion_boundary", quote: "Concurring Reasons: (paras. 138 to 142)" },
    ],
    note: "Three same-result opinions with issue-specific joinders; Big M appears in the lead and concurring reasons.",
  },
  {
    id: "multi-03", category: "multi_opinion_or_partial_join", documentId: 7330,
    targetDocumentId: 189816, targetCitation: "[1982] 1 S.C.R. 41",
    lineage: auditLineage(7330),
    evidence: [
      { kind: "opinion_boundary", quote: "Reasons for Judgment of the Honourable Madam Justice Saunders:" },
      { kind: "opinion_boundary", quote: "Dissenting Reasons for Judgment of the Honourable Mr. Justice Willcock:" },
    ],
    note: "Express majority and dissent; each opinion discusses Korponay.",
  },
  {
    id: "multi-04", category: "multi_opinion_or_partial_join", documentId: 112050,
    targetDocumentId: 190532, targetCitation: "[2002] 1 S.C.R. 84",
    lineage: {
      kind: "seeded_full_corpus_keyword_scan",
      seed: SEED,
      query: "dataset=FCA AND text contains DISSENTING REASONS",
      document_id: 112050,
    },
    evidence: [
      { kind: "opinion_boundary", quote: "REASONS FOR JUDGMENT BY: DÉCARY J.A." },
      { kind: "opinion_boundary", quote: "DISSENTING REASONS BY: DESJARDINS J.A." },
    ],
    note: "Express majority and dissent that each characterize Chieu while disagreeing on review and disposition.",
  },
  {
    id: "multi-05", category: "multi_opinion_or_partial_join", documentId: 225088,
    targetDocumentId: 196235, targetCitation: "2010 SCC 6",
    lineage: auditLineage(225088),
    evidence: [
      { kind: "opinion_boundary", quote: "Reasons for Judgment of the Honourable Madam Justice Fenlon:" },
      { kind: "opinion_boundary", quote: "Reasons for Judgment of the Honourable Madam Justice D. Smith:" },
    ],
    note: "Lead and separate reasons; both use Nasogaluak in resolving the sentencing issue.",
  },
  {
    id: "attribution-01", category: "attribution_trap", documentId: 109485,
    targetDocumentId: 113763, targetCitation: "2007 FCA 153",
    lineage: budgetLineage(1454),
    evidence: [
      { kind: "current_decision_voice", quote: "The issue of burden of proof and presumption of validity was recently dealt with by the Court of Appeal in Abbott Laboratories v. Canada (Minister of Health), 2007 FCA 153" },
      { kind: "party_or_reported_voice", quote: "2007 FCA 153 at paras. 11-14 [Abbott Laboratories 2005]" },
    ],
    note: "The court uses the target for one proposition while a party invokes it for a different patent proposition.",
  },
  {
    id: "attribution-02", category: "attribution_trap", documentId: 123916,
    targetDocumentId: 192670, targetCitation: "2014 SCC 53",
    lineage: budgetLineage(1700),
    evidence: [
      { kind: "party_or_reported_voice", quote: "Referring to the law set out in Sattva Capital Corp. v. Creston Moly Corp., 2014 SCC 53, it was put this way in her factum:" },
      { kind: "current_decision_voice", quote: "I note that Sattva does not apply to determine whether a contract exists" },
    ],
    note: "A party's quoted characterization is immediately limited by the current court.",
  },
  {
    id: "attribution-03", category: "attribution_trap", documentId: 67832,
    targetDocumentId: 68517, targetCitation: "2014 CHRT 3",
    sameLitigationEligible: true,
    lineage: budgetLineage(4537),
    evidence: [
      { kind: "party_or_reported_voice", quote: "Member Luftig issued four interim rulings: 2014 CHRT 3" },
      { kind: "party_or_reported_voice", quote: "Mr. Carter’s main objection has been the disclosure of certain medical information in Tribunal ruling 2014 CHRT 3" },
      { kind: "current_decision_voice", quote: "I concur that the Medical Information contained in 2014 CHRT 3 is not necessary" },
    ],
    note: "The same prior ruling appears as procedural history, a party objection, and the deciding member's conclusion.",
  },
  {
    id: "attribution-04", category: "attribution_trap", documentId: 68919,
    targetDocumentId: 68923, targetCitation: "1998 CAPPRT 028",
    lineage: budgetLineage(2179),
    evidence: [
      { kind: "party_or_reported_voice", quote: "The Tribunal has commented on this provision in The Writers Union of Canada, 1998 CAPPRT 028 at paragraph 62:" },
      { kind: "party_or_reported_voice", quote: "The relationship has always been viewed as a complementary one, as set out in The Writers Union of Canada, 1998 CAPPRT 028:" },
      { kind: "current_decision_voice", quote: "In the instant case, the Tribunal finds the dispute" },
    ],
    note: "Prior reasons are quoted twice around party submissions before the Tribunal states its own application.",
  },
  {
    id: "attribution-05", category: "attribution_trap", documentId: 220204,
    targetDocumentId: 111733, targetCitation: "2002 FCA 394",
    lineage: budgetLineage(346),
    evidence: [
      { kind: "party_or_reported_voice", quote: "followed in Jaillet v. Canada (Minister of National Revenue - M.N.R.), 2002 FCA 394" },
      { kind: "current_decision_voice", quote: "I find that in this case, there is no serious indication that there was a control on the worker." },
    ],
    note: "The target is nested inside a quotation from another appellate judgment, followed by the current court's finding.",
  },
  {
    id: "control-01", category: "ordinary_control", documentId: 18750,
    targetDocumentId: 191307, targetCitation: "[1976] 1 SCR 319",
    lineage: budgetLineage(378),
    evidence: [{ kind: "current_decision_treatment", quote: "A liquidated damages clause is enforceable provided it is a genuine pre-estimate of damage and not a penalty: see HF Clarke Ltd. v Thermidaire Corp. Ltd., [1976] 1 SCR 319 at 327." }],
    note: "Single-judge, direct statement and application of the target rule.",
  },
  {
    id: "control-02", category: "ordinary_control", documentId: 66893,
    targetDocumentId: 117159, targetCitation: "2022 FCA 105",
    lineage: budgetLineage(60),
    evidence: [{ kind: "current_decision_treatment", quote: "In Canada (Attorney General) v Chu, 2022 FCA 105 at para 7" }],
    note: "Short tribunal decision applying a binding limit on its remedial authority.",
  },
  {
    id: "control-03", category: "ordinary_control", documentId: 202094,
    targetDocumentId: 112500, targetCitation: "2001 FCA 248",
    lineage: budgetLineage(112),
    evidence: [{ kind: "current_decision_treatment", quote: "The severe criterion must be assessed in a real world context (Villani v. Canada (A.G.), 2001 FCA 248)." }],
    note: "Routine tribunal use of the standard Villani real-world test.",
  },
  {
    id: "control-04", category: "ordinary_control", documentId: 121168,
    targetDocumentId: 121892, targetCitation: "2014 PSST 5",
    lineage: budgetLineage(2266),
    evidence: [{ kind: "current_decision_treatment", quote: "Whether an error constitutes an abuse of authority depends on its nature and seriousness; see Makoundi v. Deputy Minister of Transport, Infrastructure and Communities, 2014 PSST 5 at para. 22." }],
    note: "Single adjudicator states the target rule and applies it in the next sentence.",
  },
  {
    id: "control-05", category: "ordinary_control", documentId: 153903,
    targetDocumentId: 164379, targetCitation: "2021 ONCA 364",
    lineage: budgetLineage(2328),
    evidence: [{ kind: "current_decision_treatment", quote: "A panel may only interfere if the judge failed to identify the applicable principles, erred in principle or reached an unreasonable result: Hillmount Capital Inc. v. Pizale, 2021 ONCA 364" }],
    note: "Short unanimous panel decision applying an ordinary deferential review rule.",
  },
];

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  const outAt = process.argv.indexOf("--out");
  const output = path.resolve(outAt >= 0 ? process.argv[outAt + 1] : path.join(ROOT, "case-target-challenge-15.json"));
  const documents = fetchLocalA2AJDocumentsByIds({
    ids: SPECS.map(({ documentId }) => documentId),
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  const targets = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const get = database.prepare(`
      SELECT id, name_en, citation_en, citation2_en, citation_fr, citation2_fr
      FROM document WHERE id=? AND doc_type='cases'
    `);
    return new Map(SPECS.map(({ targetDocumentId }) => [targetDocumentId, get.get(targetDocumentId) as Record<string, unknown>]));
  });
  if (!targets) throw new Error(`A2AJ database not found: ${a2ajLocalBulkPath()}`);

  const budget = JSON.parse(await readFile(path.join(RUNS, BUDGET_MANIFEST), "utf8")) as { pairs: Array<Record<string, any>> };
  const pairs = SPECS.map((spec) => {
    const document = documents.get(spec.documentId);
    const targetRow = targets.get(spec.targetDocumentId);
    if (!document || !targetRow) throw new Error(`${spec.id}: source or target is absent from A2AJ`);
    if (spec.lineage.kind === "seeded_pair_manifest") {
      const index = Number(spec.lineage.zero_based_pair_index);
      const parent = budget.pairs[index];
      if (Number(parent?.document_id) !== spec.documentId || Number(parent?.target?.document_id) !== spec.targetDocumentId || citationLookupKey(parent?.target?.citation) !== citationLookupKey(spec.targetCitation)) {
        throw new Error(`${spec.id}: frozen parent-manifest receipt changed at index ${index}`);
      }
    }
    const aliases = [...new Set([
      targetRow.citation_en,
      targetRow.citation2_en,
      targetRow.citation_fr,
      targetRow.citation2_fr,
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "" && value !== spec.targetCitation))];
    const targetName = typeof targetRow.name_en === "string" ? targetRow.name_en : null;
    const targetOccurrences = detectCaseTargetOccurrences(createTextSourceDoc(document.text), {
      citation: spec.targetCitation,
      citationAliases: aliases,
      name: targetName,
    }).map((occurrence) => {
      const contextStart = Math.max(0, occurrence.start - 320);
      const contextEnd = Math.min(document.text.length, occurrence.end + 420);
      const context = document.text.slice(contextStart, contextEnd);
      return {
        ...occurrence,
        context: { start: contextStart, end_exclusive: contextEnd, quote: context, sha256: sha256(context) },
      };
    });
    if (!targetOccurrences.some(({ kind }) => kind === "citation")) {
      throw new Error(`${spec.id}: target citation is absent from the source decision`);
    }
    const categoryEvidence = spec.evidence.map((evidence) => {
      const start = document.text.indexOf(evidence.quote);
      if (start < 0) throw new Error(`${spec.id}: missing category evidence: ${evidence.quote}`);
      return { ...evidence, start, end_exclusive: start + evidence.quote.length, sha256: sha256(evidence.quote) };
    });
    return {
      challenge_id: spec.id,
      challenge_category: spec.category,
      document_id: spec.documentId,
      source: {
        dataset: document.dataset,
        citation: document.citation,
        name: document.name,
        date: document.date?.slice(0, 10) ?? null,
        language: document.language,
        url: document.url,
      },
      target: {
        document_id: spec.targetDocumentId,
        citation: spec.targetCitation,
        citation_aliases: aliases,
        name: targetName,
        ...(spec.sameLitigationEligible ? { same_litigation_eligible: true } : {}),
      },
      selection_receipt: {
        challenge_seed: SEED,
        seeded_rank_sha256: sha256(`${SEED}:${spec.category}:${spec.documentId}:${citationLookupKey(spec.targetCitation)}`),
        source_lineage: spec.lineage,
        source_chars: document.text.length,
        source_text_sha256: sha256(document.text),
        target_resolved_in_a2aj: true,
        occurrence_contract: {
          detector: CASE_TARGET_OCCURRENCE_VERSION,
          source_view: "byte-identical-source-text",
          citation_and_case_name_offsets_frozen: true,
          linked_footnote_context_frozen: true,
        },
        target_occurrences: targetOccurrences,
        category_evidence: categoryEvidence,
        source_text_review_note: spec.note,
      },
    };
  });
  const categoryCounts = Object.fromEntries([...new Set(pairs.map(({ challenge_category }) => challenge_category))]
    .map((category) => [category, pairs.filter(({ challenge_category }) => challenge_category === category).length]));
  const datasetCounts = Object.fromEntries([...new Set(pairs.map(({ source }) => source.dataset))].sort()
    .map((dataset) => [dataset, pairs.filter(({ source }) => source.dataset === dataset).length]));
  const freezeKeys = pairs.map(({ challenge_id, document_id, target }) => [challenge_id, document_id, target.document_id, target.citation]);
  const manifest = {
    format: "a2aj-case-target-challenge-v2",
    created_utc: FROZEN_UTC,
    seed: SEED,
    requested_pairs: pairs.length,
    selection: {
      algorithm: "seed-lineage-plus-source-evidence-freeze-v2",
      purpose: "case-target legal-quality challenge cell; no validator-stage scoring",
      occurrence_contract_version: CASE_TARGET_OCCURRENCE_VERSION,
      one_full_citing_decision_per_call: true,
      one_target_per_call: true,
      target_decision_text_included: false,
      source_audit_seed: 20_260_819,
      source_pair_seed: SEED,
      frozen_pair_keys_sha256: sha256(JSON.stringify(freezeKeys)),
    },
    category_counts: categoryCounts,
    dataset_counts: datasetCounts,
    pairs,
  };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, pairs: pairs.length, category_counts: categoryCounts, dataset_counts: datasetCounts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
