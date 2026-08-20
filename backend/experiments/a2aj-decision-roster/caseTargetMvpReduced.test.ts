import assert from "node:assert/strict";
import test from "node:test";

import { resolveCaseTargetMvp } from "./caseTargetMvp";
import {
  CASE_TARGET_MVP_REDUCED_JSON_SCHEMA,
  compileReducedCaseTargetSubmission,
  type GroundedCaseTargetContext,
  type ReducedCaseTargetSubmission,
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

const ref = (occurrence_id: string) => ({ occurrence_id, mention_quote: null });

function validSubmission(): ReducedCaseTargetSubmission {
  return {
    disposition_quote: "We follow that rule and allow the appeal.",
    opinions: [
      {
        named_authors: [{ name: "A J.", evidence_quote: "A J." }],
        collective_author: null,
        collective_author_evidence_quote: null,
        result_position: "supports_disposition",
        position_evidence_quote: "We follow that rule and allow the appeal.",
        start_quote: "The issue is whether reasonable notice is required.",
        end_quote: "The target judgment was affirmed on appeal.",
        whole_opinion_joiners: [],
      },
      {
        named_authors: [{ name: "C J.", evidence_quote: "C J." }],
        collective_author: null,
        collective_author_evidence_quote: null,
        result_position: "opposes_disposition",
        position_evidence_quote: "I would dismiss the appeal.",
        start_quote: "I agree that reasonable notice is required.",
        end_quote: "I refer to the target only for that background.",
        whole_opinion_joiners: [],
      },
    ],
    participants: [
      {
        name: "A J.", panel_evidence_quote: "A J.", result_position: "supports_disposition",
        result_only: false, result_only_evidence_quote: null,
      },
      {
        name: "B J.", panel_evidence_quote: "B J. joins A J.", result_position: "supports_disposition",
        result_only: false, result_only_evidence_quote: null,
      },
      {
        name: "C J.", panel_evidence_quote: "C J.", result_position: "opposes_disposition",
        result_only: false, result_only_evidence_quote: null,
      },
    ],
    nonparticipants: [],
    target_mentions: [
      { ...ref("tm1"), voice: "current_court" },
      { ...ref("tm2"), voice: "current_court" },
    ],
    issues: [
      {
        question: "Is reasonable notice required?",
        answer_groups: [{
          answer: "Yes, reasonable notice is required.",
          positions: [
            {
              relation_to_disposition: "dispositive",
              answer_evidence: [{ quote: "We follow that rule and allow the appeal.", voice: "current_court" }],
              basis_and_limits: [{
                kind: "rule",
                text: "The target rule requires notice.",
                evidence: [{ quote: "2010 SCC 1 states that notice is required.", voice: "current_court" }],
              }],
              partial_joins: [{
                participant_name: "B J.",
                evidence_quote: "B J. joins A J. on the notice issue only.",
              }],
              target_mentions: [ref("tm1")],
              target_treatments: [{
                target_mentions: [ref("tm1")],
                attribution: "current_court",
                label: "followed",
                scope: "legal_test",
                evidence_quote: "We follow that rule and allow the appeal.",
                target_proposition_as_characterized: "Reasonable notice is required.",
              }],
            },
            {
              relation_to_disposition: "dispositive",
              answer_evidence: [{ quote: "I agree that reasonable notice is required.", voice: "current_court" }],
              basis_and_limits: [],
              partial_joins: [],
              target_mentions: [ref("tm2")],
              target_treatments: [],
            },
          ],
        }],
      },
      {
        question: "Are damages available on these facts?",
        answer_groups: [{
          answer: "No.",
          positions: [{
            relation_to_disposition: "non_dispositive",
            answer_evidence: [{ quote: "Damages are unavailable on these facts.", voice: "current_court" }],
            basis_and_limits: [],
            partial_joins: [{
              participant_name: "B J.",
              evidence_quote: "B J. also joins A J. on damages.",
            }],
            target_mentions: [ref("tm1")],
            target_treatments: [{
              target_mentions: [ref("tm1")],
              attribution: "current_court",
              label: "followed",
              scope: "legal_test",
              evidence_quote: "We follow that rule and allow the appeal.",
              target_proposition_as_characterized: "Reasonable notice is required.",
            }],
          }],
        }],
      },
    ],
    unscoped_target_treatments: [{
      target_mentions: [ref("tm2")],
      attribution: "current_court",
      label: "referred_to",
      scope: "unclear",
      evidence_quote: "I refer to the target only for that background.",
      target_proposition_as_characterized: null,
    }],
    direct_history: [{
      target_mentions: [ref("tm1")],
      label: "affirmed",
      evidence_quote: "The target judgment was affirmed on appeal.",
    }],
  };
}

test("compiles multi-opinion answers, silence, partial joins, and scoped/unscoped treatment", () => {
  const compiled = compileReducedCaseTargetSubmission(validSubmission(), context);
  assert.deepEqual(compiled.errors, []);
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
  ), [["o1", ["i1", "i2"]], ["o2", ["i1"]]]);
  assert.deepEqual(compiled.input.targetTreatments.map(({ opinion_id, case_issue_ids, label }) =>
    [opinion_id, case_issue_ids, label]
  ), [["o1", ["i1", "i2"], "followed"], ["o2", [], "referred_to"]]);
  assert.equal(compiled.input.targetDirectHistory[0].opinion_id, "o1");

  const resolved = resolveCaseTargetMvp(compiled.input);
  assert.equal(resolved.ok, true, resolved.errors.join("\n"));
  assert(!resolved.opinion_issue_positions.some((position) => "discussion_spans" in position));
  assert.equal(resolved.counts.accepted_opinion_positions, 3);
  assert.equal(resolved.counts.accepted_target_treatments, 2);
});

test("reports occurrence omissions and never falls back for cross-opinion treatment", () => {
  const submission = validSubmission();
  submission.target_mentions.pop();
  submission.unscoped_target_treatments[0].target_mentions = [ref("tm1"), ref("tm2")];
  const compiled = compileReducedCaseTargetSubmission(submission, context);
  assert.equal(compiled.ok, false);
  assert(compiled.errors.includes("missing target occurrence tm2"));
  assert(compiled.errors.some((error) => error.includes("not declared at the root")));
  assert(!compiled.input.targetTreatments.some(({ case_issue_ids }) => case_issue_ids.length === 0));
});

test("rejects direct history unless the pair is deterministically same-litigation eligible", () => {
  const compiled = compileReducedCaseTargetSubmission(validSubmission(), {
    ...context,
    directHistoryEligible: false,
  });
  assert.match(compiled.errors.join("\n"), /not deterministically eligible as the same litigation/u);
  assert.deepEqual(compiled.input.targetDirectHistory, []);
});

test("full schema recursively forbids generated IDs, ordinals, hierarchy, and discussion boundaries", () => {
  const propertyNames: string[] = [];
  const visit = (schema: unknown, path = "root") => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    const row = schema as Record<string, unknown>;
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
    !/(^id$|_id$|_ids$|_number$|_numbers$)/u.test(name) || name === "occurrence_id"
  ));
  for (const forbidden of ["parent_issue_id", "discussion_spans"]) {
    assert(!propertyNames.includes(forbidden));
  }
  assert(propertyNames.includes("opinions"));
  assert(propertyNames.includes("participants"));
  assert(propertyNames.includes("whole_opinion_joiners"));
});
