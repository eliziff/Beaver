import assert from "node:assert/strict";
import { it } from "vitest";
import type { CaseDecisionSubmission } from "./caseDecisionMvp";
import { compareDecisionMechanics, decisionSemanticJudgePrompt, decisionSemanticView } from "./caseDecisionBenchmark";

const submission = (): CaseDecisionSubmission => ({
  structure: {
    disposition_evidence: [{ start_line: 8, end_line: 8 }],
    opinions: [{
      boundary: { start_line: 2, end_line: 8 },
      authorship: { kind: "named", writers: [{ name: "Alpha J.", evidence_lines: { start_line: 2, end_line: 2 } }] },
      result_position: "supports_disposition",
      result_evidence: { start_line: 8, end_line: 8 },
      full_joiners: [{ name: "Beta J.", evidence_lines: { start_line: 1, end_line: 1 } }],
    }],
    other_panel_members: [],
    nonparticipants: [],
  },
  analysis: {
    issues: [{
      question: "Was the appeal timely?",
      answers: [{ answer: "Yes.", positions: [{ opinion_number: 1, answer_evidence: [{ start_line: 7, end_line: 8 }], issue_only_joiners: [] }] }],
    }],
    references: [{
      reference_id: "r1", detected_occurrence_id: "c1", reference_status: "decision_reference",
      exact_reference: "Example, 2020 SCC 1", evidence: { start_line: 7, end_line: 7 },
      text_source: "current_decision_words", proposition_attributed_to: "current_opinion",
    }],
    quoted_passages: [],
    treatments: [{
      reference_ids: ["r1"], quoted_passage_ids: [], issue_number: 1, containing_opinion_number: 1,
      operation: "applied", proposition: "Time ran from notice.", explanation: "The opinion applied that rule.",
      evidence: { start_line: 7, end_line: 7 }, other_operation: null,
    }],
    procedural_history: [],
  },
});

it("scores only mechanical fields deterministically", () => {
  const candidate = submission();
  candidate.analysis.issues[0].answers[0].answer = "Different semantic answer.";
  assert.equal(compareDecisionMechanics(submission(), candidate).exact, true);
  candidate.structure.opinions[0].boundary.start_line = 3;
  assert.equal(compareDecisionMechanics(submission(), candidate).categories.opinion_boundaries_exact, false);
});

it("separates voting agreement from writer attribution", () => {
  const candidate = submission();
  candidate.structure.opinions[0].authorship = { kind: "collective", name: "the Court", evidence_lines: { start_line: 2, end_line: 2 } };
  candidate.structure.opinions[0].full_joiners = [
    { name: "Alpha J.", evidence_lines: { start_line: 2, end_line: 2 } },
    { name: "Beta J.", evidence_lines: { start_line: 1, end_line: 1 } },
  ];
  const score = compareDecisionMechanics(submission(), candidate).categories;
  assert.equal(score.opinion_writers_exact, false);
  assert.equal(score.full_joins_exact, false);
  assert.equal(score.opinion_vote_blocs_exact, true);
  assert.equal(score.voting_pattern_exact, true);
});

it("reports matched-opinion accuracy even when another opinion is extra", () => {
  const candidate = submission();
  candidate.structure.opinions.push({
    boundary: { start_line: 9, end_line: 10 }, authorship: { kind: "unstated" },
    result_position: "unclear", result_evidence: null, full_joiners: [],
  });
  const score = compareDecisionMechanics(submission(), candidate);
  assert.equal(score.categories.opinion_writers_exact, false);
  assert.equal(score.metrics.exact_writers, 1);
  assert.equal(score.metrics.matched_opinions, 1);
});

it("shows the judge only semantic claims", () => {
  const view = JSON.stringify(decisionSemanticView(submission()));
  assert.doesNotMatch(view, /start_line|end_line|authorship|full_joiners|result_position/u);
  assert.match(view, /text_source|proposition_attributed_to|operation/u);
  const prompt = decisionSemanticJudgePrompt(submission(), submission());
  assert.match(prompt, /material legal issues and answers/u);
  assert.doesNotMatch(prompt, /checked separately|deterministic|pipeline|relation_to_disposition|treatment_scope/u);
  assert.doesNotMatch(prompt, /Alpha J\.|Beta J\./u);
});
