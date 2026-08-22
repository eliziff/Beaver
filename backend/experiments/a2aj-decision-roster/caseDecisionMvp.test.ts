import assert from "node:assert/strict";
import { it } from "vitest";
import {
  caseDecisionOutputSchema,
  caseDecisionStructureOutputSchema,
  caseDecisionTreatmentOutputSchema,
  compileCaseDecisionSubmission,
  decisionCitationInventory,
  mergeCaseDecisionStages,
  type CaseDecisionSubmission,
} from "./caseDecisionMvp";
import { modelSourceLines } from "./caseTargetMvpReduced";

const sourceText = [
  "Before: Alpha J. and Beta J.",
  "Reasons for judgment of Alpha J.",
  "Housen v. Nikolaisen, 2002 SCC 33 supplies the standard of review.",
  "We apply Housen and dismiss the appeal.",
  "R. v. Jordan, 2016 SCC 27 is mentioned only for comparison.",
].join("\n");
const sourceLines = modelSourceLines(sourceText);
const inventory = decisionCitationInventory(sourceText, "2026 ONCA 1");

function submission(): CaseDecisionSubmission {
  return {
    structure: {
      disposition_evidence: [{ start_line: 4, end_line: 4 }],
      opinions: [{
        boundary: { start_line: 2, end_line: 5 },
        authorship: { kind: "named", writers: [{ name: "Alpha J.", evidence_lines: { start_line: 2, end_line: 2 } }] },
        result_position: "supports_disposition",
        result_evidence: { start_line: 4, end_line: 4 },
        full_joiners: [{ name: "Beta J.", evidence_lines: { start_line: 1, end_line: 1 } }],
      }],
      other_panel_members: [],
      nonparticipants: [],
    },
    analysis: {
      issues: [{
        question: "What standard of review governed the appeal?",
        answers: [{
          answer: "The Housen standard governed.",
          positions: [{ opinion_number: 1, answer_evidence: [{ start_line: 3, end_line: 4 }], issue_only_joiners: [] }],
        }],
      }],
      references: [{
        reference_id: "r1", detected_occurrence_id: "c1", reference_status: "decision_reference",
        exact_reference: "Housen v. Nikolaisen, 2002 SCC 33", evidence: { start_line: 3, end_line: 3 },
        text_source: "current_decision_words", proposition_attributed_to: "current_opinion",
      }, {
        reference_id: "r2", detected_occurrence_id: "c2", reference_status: "decision_reference",
        exact_reference: "R. v. Jordan, 2016 SCC 27", evidence: { start_line: 5, end_line: 5 },
        text_source: "current_decision_words", proposition_attributed_to: "current_opinion",
      }],
      quoted_passages: [],
      treatments: [{
        reference_ids: ["r1"], quoted_passage_ids: [], issue_number: 1, containing_opinion_number: 1,
        operation: "applied", proposition: "Housen supplies the standard of review.",
        explanation: "The opinion applies that standard and dismisses the appeal.",
        evidence: { start_line: 3, end_line: 4 }, other_operation: null,
      }],
      procedural_history: [],
    },
  };
}

function compile(value = submission(), coverageLineNumbers: number[] = []) {
  return compileCaseDecisionSubmission({ submission: value, sourceText, sourceLines, inventory, coverageLineNumbers });
}

it("detects citations and groups adjacent parallel citations", () => {
  assert.deepEqual(inventory.authorities.map((item) => item.display_citations), [["2002 SCC 33"], ["2016 SCC 27"]]);
  const parallel = decisionCitationInventory("Hillmount, 2021 ONCA 364, 462 D.L.R. (4th) 228, at para. 18.", "2026 ONCA 1");
  assert.equal(parallel.authorities.length, 1);
  assert.deepEqual(parallel.authorities[0].display_citations, ["2021 ONCA 364", "462 D.L.R. (4th) 228"]);
});

it("rejects date and cross-line metadata false positives", () => {
  const detected = decisionCitationInventory("Date 13 October 2013\nCitation\n2013 NSPC 111", "2026 ONCA 1");
  assert.deepEqual(detected.occurrences.map(({ quote }) => quote), ["2013 NSPC 111"]);
});

it("links a citation in a numbered footnote to its body marker", () => {
  const detected = decisionCitationInventory("[1] The court follows Example.[2]\n[2]2020 SCC 1.", "2026 ONCA 1", 33);
  assert.deepEqual(detected.occurrences[0].linkedContext, { kind: "footnote_reference", quote: "[2]", start: 30, end: 33 });
});

it("accepts a complete line-native decision account", () => {
  const result = compile();
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.coverage, { detected_occurrences: 2, detector_candidates_accounted_for: true, model_added_references: 0, completeness: "not_asserted" });
});

it("does not require evidence text to be unique", () => {
  const repeated = "Reasons for judgment.\nThe same words.\nThe same words.";
  const lines = modelSourceLines(repeated);
  const value = submission();
  value.structure.opinions[0].boundary = { start_line: 1, end_line: 3 };
  value.structure.opinions[0].authorship = { kind: "unstated" };
  value.structure.opinions[0].full_joiners = [];
  value.structure.disposition_evidence = [{ start_line: 2, end_line: 2 }];
  value.structure.opinions[0].result_evidence = { start_line: 2, end_line: 2 };
  value.analysis.issues[0].answers[0].positions[0].answer_evidence = [{ start_line: 2, end_line: 2 }];
  value.analysis.references = [];
  value.analysis.treatments = [];
  const result = compileCaseDecisionSubmission({ submission: value, sourceText: repeated, sourceLines: lines, inventory: { authorities: [], occurrences: [] } });
  assert.equal(result.ok, true, result.errors.join("; "));
});

it("treats detector output as a required seed while allowing grounded additions", () => {
  const missing = submission();
  missing.analysis.references = missing.analysis.references.slice(1);
  assert.match(compile(missing).errors.join("; "), /missing detector candidate c1/u);

  const added = submission();
  added.analysis.references.push({
    reference_id: "r3", detected_occurrence_id: null, reference_status: "decision_reference",
    exact_reference: "Housen", evidence: { start_line: 4, end_line: 4 },
    text_source: "current_decision_words", proposition_attributed_to: "current_opinion",
  });
  added.analysis.treatments[0].reference_ids.push("r3");
  const result = compile(added);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.coverage.model_added_references, 1);
});

it("rejects treatment evidence outside its stated opinion", () => {
  const value = submission();
  value.analysis.treatments[0].evidence = { start_line: 1, end_line: 1 };
  assert.match(compile(value).errors.join("; "), /outside the containing opinion/u);
});

it("validates disposition, nonparticipant, and procedural-history evidence", () => {
  const badDisposition = submission();
  badDisposition.structure.disposition_evidence = [{ start_line: 99, end_line: 99 }];
  assert.match(compile(badDisposition).errors.join("; "), /disposition_evidence/u);

  const badRoster = submission();
  badRoster.structure.nonparticipants = [{ name: "Alpha J.", evidence_lines: { start_line: 1, end_line: 1 } }];
  assert.match(compile(badRoster).errors.join("; "), /participating judge/u);

  const badHistory = submission();
  badHistory.analysis.procedural_history = [{
    reference_ids: ["r1"], containing_opinion_number: 1, relationship: "affirmed", evidence: { start_line: 1, end_line: 1 },
  }];
  assert.match(compile(badHistory).errors.join("; "), /procedural_history.*outside the containing opinion/u);
});

it("rejects substantive lines left outside every opinion", () => {
  const value = submission();
  value.structure.opinions[0].boundary.end_line = 4;
  assert.match(compile(value, [2, 3, 4, 5]).errors.join("; "), /source line 5/u);
});

it("requires a description only for operation=other", () => {
  const value = submission();
  value.analysis.treatments[0].operation = "other";
  assert.match(compile(value).errors.join("; "), /other_operation/u);
  value.analysis.treatments[0].other_operation = "treated as persuasive but not binding";
  assert.equal(compile(value).ok, true);
});

it("binds opinions but leaves the reference ledger open", () => {
  const structureSchema = JSON.stringify(caseDecisionStructureOutputSchema(sourceLines.length));
  assert.doesNotMatch(structureSchema, /issues|authorities|treatments/u);
  const analysisSchema = caseDecisionTreatmentOutputSchema(submission().structure, inventory, sourceLines.length) as any;
  assert.equal(analysisSchema.properties.issues.items.properties.answers.items.properties.positions.items.properties.opinion_number.maximum, 1);
  assert.equal(analysisSchema.properties.references.minItems, 2);
  assert.deepEqual(analysisSchema.properties.references.items.properties.detected_occurrence_id.anyOf[0].enum, ["c1", "c2"]);
  assert.equal(analysisSchema.properties.references.maxItems, 500);
  assert.deepEqual((caseDecisionOutputSchema(inventory, sourceLines.length) as any).required, ["structure", "analysis"]);
});

it("stores exact linked quotations and rejects invented quote text", () => {
  const value = submission();
  value.analysis.quoted_passages = [{
    quote_id: "q1", reference_ids: ["r1"], exact_quote: "supplies the standard of review",
    evidence: { start_line: 3, end_line: 3 },
  }];
  value.analysis.treatments[0].quoted_passage_ids = ["q1"];
  const accepted = compile(value);
  assert.equal(accepted.ok, true, accepted.errors.join("; "));
  assert.equal(accepted.grounding.quoted_passages[0].exact_quote, "supplies the standard of review");

  value.analysis.quoted_passages[0].exact_quote = "invented quotation";
  assert.match(compile(value).errors.join("; "), /does not occur verbatim/u);
});

it("merges the two stages without rewriting either", () => {
  const complete = submission();
  assert.deepEqual(mergeCaseDecisionStages(complete.structure, complete.analysis), { submission: complete, errors: [] });
});
