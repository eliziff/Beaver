import type { CaseDecisionSubmission, DecisionStructure } from "./caseDecisionMvp";

const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function writers(opinion: DecisionStructure["opinions"][number]) {
  return opinion.authorship.kind === "named"
    ? opinion.authorship.writers.map(({ name }) => key(name)).sort()
    : opinion.authorship.kind === "collective"
      ? [`collective:${key(opinion.authorship.name)}`]
      : ["unstated"];
}

function opinionVoters(opinion: DecisionStructure["opinions"][number]) {
  const names = opinion.authorship.kind === "named" ? opinion.authorship.writers.map(({ name }) => key(name)) : [];
  names.push(...opinion.full_joiners.map(({ name }) => key(name)));
  return [...new Set(names)].sort();
}

function overlap(left: DecisionStructure["opinions"][number], right: DecisionStructure["opinions"][number]) {
  const start = Math.max(left.boundary.start_line, right.boundary.start_line);
  const end = Math.min(left.boundary.end_line, right.boundary.end_line);
  if (end < start) return 0;
  const intersection = end - start + 1;
  const union = Math.max(left.boundary.end_line, right.boundary.end_line) - Math.min(left.boundary.start_line, right.boundary.start_line) + 1;
  return intersection / union;
}

function opinionMatches(gold: DecisionStructure, candidate: DecisionStructure) {
  const candidates = gold.opinions.flatMap((expected, expectedIndex) => candidate.opinions.map((actual, actualIndex) => ({ expectedIndex, actualIndex, overlap: overlap(expected, actual) })))
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) => right.overlap - left.overlap);
  const expectedUsed = new Set<number>();
  const actualUsed = new Set<number>();
  return candidates.filter(({ expectedIndex, actualIndex }) => {
    if (expectedUsed.has(expectedIndex) || actualUsed.has(actualIndex)) return false;
    expectedUsed.add(expectedIndex); actualUsed.add(actualIndex); return true;
  });
}

function voteRows(structure: DecisionStructure) {
  const rows: Array<{ name: string; result: string }> = [];
  structure.opinions.forEach((opinion) => {
    if (opinion.authorship.kind === "named") for (const writer of opinion.authorship.writers) rows.push({ name: key(writer.name), result: opinion.result_position });
    for (const joiner of opinion.full_joiners) rows.push({ name: key(joiner.name), result: opinion.result_position });
  });
  for (const member of structure.other_panel_members) rows.push({ name: key(member.name), result: member.result_position });
  return rows.sort((left, right) => left.name.localeCompare(right.name) || left.result.localeCompare(right.result));
}

export function compareDecisionStructure(gold: DecisionStructure, candidate: DecisionStructure) {
  const matches = opinionMatches(gold, candidate);
  const paired = matches.map(({ expectedIndex, actualIndex, overlap }) => ({ expected: gold.opinions[expectedIndex], actual: candidate.opinions[actualIndex], overlap }));
  const exactBoundaries = paired.filter(({ expected, actual }) => same(expected.boundary, actual.boundary)).length;
  const exactStarts = paired.filter(({ expected, actual }) => expected.boundary.start_line === actual.boundary.start_line).length;
  const exactEnds = paired.filter(({ expected, actual }) => expected.boundary.end_line === actual.boundary.end_line).length;
  const exactWriters = paired.filter(({ expected, actual }) => same(writers(expected), writers(actual))).length;
  const exactResults = paired.filter(({ expected, actual }) => expected.result_position === actual.result_position).length;
  const exactJoiners = paired.filter(({ expected, actual }) => same(expected.full_joiners.map(({ name }) => key(name)).sort(), actual.full_joiners.map(({ name }) => key(name)).sort())).length;
  const exactVoteBlocs = paired.filter(({ expected, actual }) => same(opinionVoters(expected), opinionVoters(actual))).length;
  const opinionsComplete = matches.length === gold.opinions.length && matches.length === candidate.opinions.length;
  const categories = {
    disposition_exact: same(gold.disposition_evidence, candidate.disposition_evidence),
    opinion_boundaries_exact: opinionsComplete && exactBoundaries === matches.length,
    opinion_writers_exact: opinionsComplete && exactWriters === matches.length,
    opinion_results_exact: opinionsComplete && exactResults === matches.length,
    opinion_vote_blocs_exact: opinionsComplete && exactVoteBlocs === matches.length,
    voting_pattern_exact: same(voteRows(gold), voteRows(candidate)),
    full_joins_exact: opinionsComplete && exactJoiners === matches.length,
    other_decision_makers_exact: same(gold.other_panel_members.map(({ name, relationship, result_position }) => [key(name), relationship, result_position]).sort(), candidate.other_panel_members.map(({ name, relationship, result_position }) => [key(name), relationship, result_position]).sort()),
    nonparticipants_exact: same(gold.nonparticipants.map(({ name }) => key(name)).sort(), candidate.nonparticipants.map(({ name }) => key(name)).sort()),
  };
  return {
    exact: Object.values(categories).every(Boolean),
    categories,
    metrics: {
      gold_opinions: gold.opinions.length,
      candidate_opinions: candidate.opinions.length,
      matched_opinions: matches.length,
      exact_boundaries: exactBoundaries,
      exact_starts: exactStarts,
      exact_ends: exactEnds,
      exact_writers: exactWriters,
      exact_results: exactResults,
      exact_vote_blocs: exactVoteBlocs,
      exact_full_joiners: exactJoiners,
    },
  };
}

export function compareDecisionMechanics(gold: CaseDecisionSubmission, candidate: CaseDecisionSubmission) {
  const structure = compareDecisionStructure(gold.structure, candidate.structure);
  const citationCoverageExact = same(
    gold.analysis.references.flatMap(({ detected_occurrence_id }) => detected_occurrence_id ? [detected_occurrence_id] : []).sort(),
    candidate.analysis.references.flatMap(({ detected_occurrence_id }) => detected_occurrence_id ? [detected_occurrence_id] : []).sort(),
  );
  return {
    ...structure,
    exact: structure.exact && citationCoverageExact,
    categories: { ...structure.categories, citation_coverage_exact: citationCoverageExact },
  };
}

export function decisionSemanticView(value: CaseDecisionSubmission) {
  return {
    issues: value.analysis.issues.map((issue, index) => ({
      issue_number: index + 1,
      question: issue.question,
      answers: issue.answers.map((answer) => ({
        answer: answer.answer,
        positions: answer.positions.map(({ opinion_number }) => ({ opinion_number })),
      })),
    })),
    references: value.analysis.references.map(({ evidence: _evidence, ...reference }) => reference),
    quoted_passages: value.analysis.quoted_passages.map(({ evidence: _evidence, ...quote }) => quote),
    treatments: value.analysis.treatments.map(({ evidence: _evidence, ...treatment }) => treatment),
    procedural_history: value.analysis.procedural_history.map(({ evidence: _evidence, ...history }) => history),
  };
}

export const DECISION_SEMANTIC_JUDGE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    verdict: { enum: ["pass", "minor_error", "major_error"] },
    errors: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          severity: { enum: ["minor", "major"] },
          aspect: { enum: ["issue_or_answer", "treatment_operation", "attributed_proposition", "issue_linkage", "procedural_history"] },
          authority_ids: { type: "array", items: { type: "string" } },
          occurrence_ids: { type: "array", items: { type: "string" } },
          explanation: { type: "string", minLength: 1 },
        },
        required: ["severity", "aspect", "authority_ids", "occurrence_ids", "explanation"],
      },
    },
  },
  required: ["verdict", "errors"],
} as const;

export function decisionSemanticJudgePrompt(gold: CaseDecisionSubmission, candidate: CaseDecisionSubmission) {
  return `Compare the candidate legal analysis with the verified analysis of the same decision.

Judge only whether the candidate accurately states the material legal issues and answers, whose position each citation reports, what each authority was said to stand for, how it was treated on the linked issue, which judicial opinion performed that treatment, and any procedural relationship between the decisions. Accept different wording, issue ordering, or organization when the legal meaning is equivalent.

pass: no semantic error.
minor_error: a localized imprecision that would not materially mislead legal research.
major_error: an omission or mistake that could materially mislead legal research.

List only actual candidate errors. Do not judge line locations, opinion boundaries, writers, panel membership, voting, identifier style, or fields absent from these views. The verdict must reflect the most serious listed error. Return only schema JSON.

[VERIFIED ANALYSIS]
${JSON.stringify(decisionSemanticView(gold), null, 2)}

[CANDIDATE ANALYSIS]
${JSON.stringify(decisionSemanticView(candidate), null, 2)}`;
}
