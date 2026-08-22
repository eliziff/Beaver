import assert from "node:assert/strict";
import { it as test } from "vitest";

import { resolveCaseTargetMvp } from "./caseTargetMvp";
import {
  CASE_TARGET_MVP_REDUCED_JSON_SCHEMA,
  compileReducedCaseTargetSubmission,
  type GroundedCaseTargetContext,
  type ReducedCaseTargetSubmission,
  type SourceLineRef,
} from "./caseTargetMvpReduced";

const firstOpinion = [
  "A J.\n",
  "The issue is whether reasonable notice is required. Target v. Case, 2010 SCC 1 states that notice is required. We follow that rule and allow the appeal.\n",
  "Damages are unavailable on these facts.\n",
  "The target judgment was affirmed on appeal.\n",
].join("");
const partialJoin = [
  "B J. joins A J. on the notice issue only.\n",
  "B J. also joins A J. on damages.\n",
].join("");
const secondOpinion = [
  "C J.\n",
  "I agree that reasonable notice is required. Target v. Case, 2010 SCC 1 is useful background, but I would dismiss the appeal.\n",
  "I refer to the target only for that background.\n",
].join("");
const sourceText = firstOpinion + partialJoin + secondOpinion;
const sourceLines = [...sourceText].map((_, index) => ({
  line: index + 1,
  start: index,
  end: index + 1,
}));

const lineRange = (start: number, end: number): SourceLineRef => ({
  start_line: sourceLines[start].line,
  end_line: sourceLines[end - 1].line,
});

const linesFor = (quote: string, from = 0) => {
  const start = sourceText.indexOf(quote, from);
  assert.notEqual(start, -1, `missing fixture quote: ${quote}`);
  return lineRange(start, start + quote.length);
};

const occurrence = (id: string, from: number) => {
  const quote = "2010 SCC 1";
  const start = sourceText.indexOf(quote, from);
  return {
    id,
    kind: "citation" as const,
    quote,
    start,
    end: start + quote.length,
    citationKey: "2010scc1",
    linkedContext: null,
  };
};

const context: GroundedCaseTargetContext = {
  sourceText,
  sourceLines,
  directHistoryEligible: true,
  panelComplete: true,
  opinions: [
    { id: "o1", start: 0, end: firstOpinion.length, text: firstOpinion },
    {
      id: "o2",
      start: firstOpinion.length + partialJoin.length,
      end: sourceText.length,
      text: secondOpinion,
    },
  ],
  participants: [
    { name: "A J.", opinion_links: [{ opinion_id: "o1", relation: "authors" }], result_only: false },
    { name: "B J.", opinion_links: [], result_only: false },
    { name: "C J.", opinion_links: [{ opinion_id: "o2", relation: "authors" }], result_only: false },
  ],
  occurrences: [
    occurrence("tm1", 0),
    occurrence("tm2", firstOpinion.length),
  ],
};

const ref = (occurrence_id: string) => ({ occurrence_id });

function validSubmission(): ReducedCaseTargetSubmission {
  return {
    disposition_lines: [linesFor("We follow that rule and allow the appeal.")],
    opinions: [
      {
        authorship: { kind: "named", authors: [{ name: "A J.", evidence_lines: linesFor("A J.") }] },
        result_position: "supports_disposition",
        position_evidence_lines: linesFor("We follow that rule and allow the appeal."),
        ...lineRange(0, firstOpinion.length),
        full_joiners: [],
      },
      {
        authorship: {
          kind: "named",
          authors: [{ name: "C J.", evidence_lines: linesFor("C J.", firstOpinion.length) }],
        },
        result_position: "opposes_disposition",
        position_evidence_lines: linesFor("I would dismiss the appeal."),
        ...lineRange(firstOpinion.length + partialJoin.length, sourceText.length),
        full_joiners: [],
      },
    ],
    other_decision_makers: [
      {
        name: "B J.", panel_evidence_lines: linesFor("B J. joins A J."), result_position: "supports_disposition",
        result_only_evidence_lines: null,
      },
    ],
    nonparticipants: [],
    occurrence_assessments: [
      {
        ...ref("tm1"), target_identity: "target", source_origin: "court_words",
        legal_actor: "current_court",
      },
      {
        ...ref("tm2"), target_identity: "target", source_origin: "court_words",
        legal_actor: "current_court",
      },
    ],
    issues: [
      {
        question: "Is reasonable notice required?",
        answers: [{
          answer: "Yes, reasonable notice is required because the target rule requires it.",
          positions: [
            {
              relation_to_disposition: "dispositive",
              answer_evidence: [{ ...linesFor("We follow that rule and allow the appeal."), origin: "court_words" }],
              issue_only_joiners: [{
                participant_name: "B J.",
                evidence_lines: linesFor("B J. joins A J. on the notice issue only."),
              }],
              target_treatments: [{
                target_mentions: [ref("tm1")],
                treated_by: "current_court",
                label: "followed",
                scope: "rule_or_proposition",
                evidence_lines: linesFor("We follow that rule and allow the appeal."),
                target_proposition_as_characterized: "Reasonable notice is required.",
              }],
            },
            {
              relation_to_disposition: "dispositive",
              answer_evidence: [{ ...linesFor("I agree that reasonable notice is required."), origin: "court_words" }],
              issue_only_joiners: [],
              target_treatments: [],
            },
          ],
        }],
      },
      {
        question: "Are damages available on these facts?",
        answers: [{
          answer: "No.",
          positions: [{
            relation_to_disposition: "non_dispositive",
            answer_evidence: [{ ...linesFor("Damages are unavailable on these facts."), origin: "court_words" }],
            issue_only_joiners: [{
              participant_name: "B J.",
              evidence_lines: linesFor("B J. also joins A J. on damages."),
            }],
            target_treatments: [{
              target_mentions: [ref("tm1")],
              treated_by: "current_court",
              label: "followed",
              scope: "rule_or_proposition",
              evidence_lines: linesFor("We follow that rule and allow the appeal."),
              target_proposition_as_characterized: "Reasonable notice is required.",
            }],
          }],
        }],
      },
    ],
    unscoped_target_treatments: [{
      target_mentions: [ref("tm2")],
      treated_by: "current_court",
      label: "referred_to",
      scope: "unclear",
      evidence_lines: linesFor("I refer to the target only for that background."),
      target_proposition_as_characterized: null,
    }],
    case_history: [{
      target_mentions: [ref("tm1")],
      label: "affirmed",
      evidence_lines: linesFor("The target judgment was affirmed on appeal."),
    }],
  };
}

test("compiles multi-opinion answers, silence, partial joins, and scoped/unscoped treatment", () => {
  const compiled = compileReducedCaseTargetSubmission(validSubmission(), context);
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(compiled.warnings, []);
  assert.deepEqual(
    compiled.input.opinionPositions.map(({ opinion_id, case_issue_id, answer_group_id }) =>
      [opinion_id, case_issue_id, answer_group_id]
    ),
    [["o1", "i1", "a1"], ["o2", "i1", "a1"], ["o1", "i2", "a2"]],
  );
  assert(!compiled.input.opinionPositions.some(({ opinion_id, case_issue_id }) =>
    opinion_id === "o2" && case_issue_id === "i2"
  ));
  assert.deepEqual(compiled.input.partialIssueJoins, [{
    participant_name: "B J.",
    opinion_id: "o1",
    case_issue_ids: ["i1", "i2"],
    evidence_quotes: [
      "B J. joins A J. on the notice issue only.",
      "B J. also joins A J. on damages.",
    ],
  }]);
  assert.deepEqual(compiled.input.participants[1].opinion_links, [{
    opinion_id: "o1",
    relation: "joins_in_part",
  }]);
  assert.deepEqual(compiled.input.targetMentions.map(({ opinion_id, case_issue_ids }) =>
    [opinion_id, case_issue_ids]
  ), [["o1", ["i1", "i2"]], ["o2", []]]);
  assert.deepEqual(compiled.input.targetTreatments.map(({ opinion_id, case_issue_ids, label }) =>
    [opinion_id, case_issue_ids, label]
  ), [["o1", ["i1", "i2"], "followed"], ["o2", [], "referred_to"]]);
  assert.equal(compiled.input.targetDirectHistory[0].opinion_id, "o1");
  assert.equal(compiled.input.targetDirectHistory[0].evidence_quote, "The target judgment was affirmed on appeal.");
  assert.equal(compiled.input.opinionPositions[0].evidence[0].quote, "We follow that rule and allow the appeal.");

  const resolved = resolveCaseTargetMvp(compiled.input);
  assert.equal(resolved.ok, true, resolved.errors.join("\n"));
  assert(!resolved.opinion_issue_positions.some((position) => "discussion_spans" in position));
  assert.equal(resolved.counts.accepted_opinion_positions, 3);
  assert.equal(resolved.counts.accepted_target_treatments, 2);
});

test("reports occurrence omissions and never falls back for cross-opinion treatment", () => {
  const submission = validSubmission();
  submission.occurrence_assessments.pop();
  submission.unscoped_target_treatments[0].target_mentions = [ref("tm1"), ref("tm2")];
  const compiled = compileReducedCaseTargetSubmission(submission, context);
  assert.equal(compiled.ok, false);
  assert(compiled.errors.includes("missing target occurrence tm2"));
  assert(compiled.errors.some((error) => error.includes("assessment is not declared at the root")));
  assert(!compiled.input.targetTreatments.some(({ case_issue_ids }) => case_issue_ids.length === 0));
});

test("receipts non-target and unclear candidates without allowing them into treatment or history", () => {
  for (const targetIdentity of ["not_target", "unclear"] as const) {
    const submission = validSubmission();
    submission.occurrence_assessments[0].target_identity = targetIdentity;
    const compiled = compileReducedCaseTargetSubmission(submission, context);
    assert.equal(compiled.ok, false);
    assert.match(compiled.errors.join("\n"), new RegExp(`assessment is ${targetIdentity}, not target`, "u"));
    assert.equal(compiled.input.targetMentions[0].target_identity, targetIdentity);
    assert.equal(compiled.input.targetMentions[0].source_origin, "court_words");
    assert(!compiled.input.targetTreatments.some(({ mention_ids }) => mention_ids.includes("m1")));
    assert(!compiled.input.targetDirectHistory.some(({ mention_ids }) => mention_ids.includes("m1")));
  }
});

test("omits a partial join when the participant already has a position on that issue", () => {
  const submission = validSubmission();
  const compiled = compileReducedCaseTargetSubmission(submission, {
    ...context,
    participants: context.participants.map((participant) => participant.name === "B J."
      ? { ...participant, opinion_links: [{ opinion_id: "o1", relation: "authors" as const }] }
      : participant),
  });
  assert.equal(compiled.ok, false);
  assert.match(compiled.errors.join("\n"), /redundant partial join/u);
  assert.deepEqual(compiled.input.partialIssueJoins, []);
});

test("rejects direct history unless the pair is deterministically same-litigation eligible", () => {
  const compiled = compileReducedCaseTargetSubmission(validSubmission(), {
    ...context,
    directHistoryEligible: false,
  });
  assert.match(compiled.errors.join("\n"), /not deterministically eligible as the same litigation/u);
  assert.deepEqual(compiled.input.targetDirectHistory, []);
});

test("maps the reduced ontology into canonical compiler values", () => {
  const submission = validSubmission();
  submission.occurrence_assessments[1].legal_actor = "other_source";
  submission.occurrence_assessments[1].source_origin = "quoted_material";
  submission.unscoped_target_treatments[0].treated_by = "party_or_counsel";
  submission.unscoped_target_treatments[0].label = "questioned";

  const compiled = compileReducedCaseTargetSubmission(submission, context);
  assert.equal(compiled.ok, true, compiled.errors.join("\n"));
  assert.equal(compiled.input.targetMentions[1].voice, "quoted_authority");
  assert.equal(compiled.input.targetMentions[1].target_identity, "target");
  assert.equal(compiled.input.targetMentions[1].source_origin, "quoted_material");
  assert.deepEqual(compiled.input.opinionPositions[0].basis_and_limits, []);
  assert.equal(compiled.input.opinionPositions[0].answer, "Yes, reasonable notice is required because the target rule requires it.");
  assert.equal(compiled.input.targetTreatments[0].scope, "specific_proposition");
  assert.equal(compiled.input.targetTreatments[1].attribution, "party_submission");
  assert.equal(compiled.input.targetTreatments[1].label, "questioned");
});

test("rejects reversed source-line ranges", () => {
  const submission = validSubmission();
  const evidence = submission.issues[0].answers[0].positions[0].answer_evidence[0];
  [evidence.start_line, evidence.end_line] = [evidence.end_line, evidence.start_line];
  const compiled = compileReducedCaseTargetSubmission(submission, context);
  assert.equal(compiled.ok, false);
  assert.match(compiled.errors.join("\n"), /source lines are out of order/u);
});

test("rejects non-positive and unknown source lines", () => {
  const submission = validSubmission();
  submission.disposition_lines[0].start_line = 0;
  submission.case_history[0].evidence_lines.end_line = sourceLines.length + 1;
  const compiled = compileReducedCaseTargetSubmission(submission, context);
  assert.match(compiled.errors.join("\n"), /line numbers must be positive integers/u);
  assert.match(compiled.errors.join("\n"), /unknown source line/u);
});

test("allows byline and full-joinder evidence outside the substantive opinion boundary", () => {
  const submission = validSubmission();
  const substantiveStart = "A J.\n".length;
  Object.assign(submission.opinions[0], lineRange(substantiveStart, firstOpinion.length), {
    full_joiners: [{ name: "B J.", evidence_lines: linesFor("B J. joins A J. on the notice issue only.") }],
  });
  const compiled = compileReducedCaseTargetSubmission(submission, {
    ...context,
    opinions: [
      {
        id: "o1",
        start: substantiveStart,
        end: firstOpinion.length,
        text: sourceText.slice(substantiveStart, firstOpinion.length),
      },
      context.opinions[1],
    ],
  });
  assert.equal(compiled.ok, true, compiled.errors.join("\n"));
});

test("full schema recursively forbids generated IDs, ordinals, hierarchy, and discussion boundaries", () => {
  const propertyNames: string[] = [];
  const visit = (schema: unknown, path = "root") => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    const row = schema as Record<string, unknown>;
    if (Array.isArray(row.anyOf)) {
      row.anyOf.forEach((branch, index) => visit(branch, `${path}.anyOf[${index}]`));
      return;
    }
    if (row.type === "object") {
      assert.equal(row.additionalProperties, false, `${path} must be closed`);
      const properties = row.properties as Record<string, unknown>;
      assert.deepEqual(
        [...row.required as string[]].sort(),
        Object.keys(properties).sort(),
        `${path} must require every field`,
      );
      for (const [name, child] of Object.entries(properties)) {
        propertyNames.push(name);
        visit(child, `${path}.${name}`);
      }
    } else if (row.type === "array") {
      assert.equal(typeof row.maxItems, "number", `${path} must be bounded`);
      visit(row.items, `${path}[]`);
    }
  };
  visit(CASE_TARGET_MVP_REDUCED_JSON_SCHEMA);
  assert(propertyNames.every((name) =>
    !/(^id$|_id$|_ids$|_number$|_numbers$)/u.test(name)
      || name === "occurrence_id"
  ));
  for (const forbidden of [
    "parent_issue_id",
    "discussion_spans",
    "voice",
    "attribution",
    "answer_groups",
    "basis_and_limits",
    "reasoning",
    "partial_joins",
    "direct_history",
    "participants",
    "whole_opinion_joiners",
    "named_authors",
    "collective_author",
    "collective_author_evidence_quote",
    "disposition_quote",
    "evidence_quote",
    "panel_evidence_quote",
    "position_evidence_quote",
    "result_only_evidence_quote",
    "start_quote",
    "end_quote",
  ]) {
    assert(!propertyNames.includes(forbidden));
  }
  assert(!propertyNames.some((name) => name === "quote" || name.endsWith("_quote")));
  assert(!propertyNames.some((name) => name.includes("span")));
  assert(!propertyNames.includes("result_only"));
  assert(propertyNames.includes("result_only_evidence_lines"));
  assert.deepEqual(
    (CASE_TARGET_MVP_REDUCED_JSON_SCHEMA.properties.occurrence_assessments as any).items.required,
    ["occurrence_id", "target_identity", "source_origin", "legal_actor"],
  );
  assert(propertyNames.includes("occurrence_assessments"));
  assert(!("target_mentions" in CASE_TARGET_MVP_REDUCED_JSON_SCHEMA.properties));
  assert(propertyNames.includes("opinions"));
  assert(propertyNames.includes("other_decision_makers"));
  assert(propertyNames.includes("full_joiners"));
  assert(propertyNames.includes("issue_only_joiners"));
  assert(propertyNames.includes("case_history"));

  const opinions = CASE_TARGET_MVP_REDUCED_JSON_SCHEMA.properties.opinions as any;
  const lineRef = (CASE_TARGET_MVP_REDUCED_JSON_SCHEMA.properties.disposition_lines as any).items;
  assert.deepEqual(lineRef.properties, {
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
  });
  const authorship = opinions.items.properties.authorship;
  assert.deepEqual(authorship.anyOf.map((branch: any) => branch.properties.kind.const), [
    "named", "collective", "unstated",
  ]);
  assert.deepEqual(authorship.anyOf.map((branch: any) => Object.keys(branch.properties).sort()), [
    ["authors", "kind"],
    ["evidence_lines", "kind", "name"],
    ["kind"],
  ]);
});
