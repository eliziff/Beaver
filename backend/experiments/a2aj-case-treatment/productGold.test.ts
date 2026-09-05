import { describe, expect, it } from "vitest";
import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import type { CaseMaterial, GoldRecord } from "./contract";
import {
  PRODUCT_GOLD_VERSION,
  compileProductDecisionStructure,
  productGoldErrors,
  productJudgeErrors,
  mergeProductJudgeRepair,
  normalizeProductJudgeResult,
  productJudgePrompt,
  productJudgeRepairPrompt,
  productJudgeScore,
  productReferenceView,
  projectProductGold,
} from "./productGold";

const span = { start_line: 1, end_line: 1, start_quote: "Reasons", end_quote: "Reasons" };

function record(): GoldRecord {
  return {
    contract_version: "a2aj-proposition-treatment-v6",
    document_id: 1,
    citation: "Example v Example, 2026 ABCA 1",
    source_sha256: "a".repeat(64),
    annotation: {
      structure: {
        disposition_spans: [],
        opinions: [{ opinion_id: "o1", boundary: span, collective_author: null, result_position: "supports_disposition", result_evidence: span }],
        participants: [{
          name: "Example J.A.", panel_evidence: span, result_position: "supports_disposition", result_evidence: span,
          opinion_links: [{ opinion_id: "o1", relation: "wrote", evidence: span }],
        }],
        nonparticipants: [],
      },
      analysis: {
        decision_mentions: [{ cited_decision: "Authority", identifying_block: "p1" }],
        procedural_relationships: [{
          cited_decision: "Decision below", identifying_block: "p1", description: "under appeal", evidence_blocks: ["p1"],
          actions: [{ action: "reversed", affected_part: "liability", evidence_blocks: ["p1"] }],
        }],
        reported_history: [{
          cited_decision: "Earlier decision", action: "affirmed", later_decision: "Later decision",
          affected_part: null, evidence_blocks: ["p1"], opinion_id: "o1",
        }],
        treatments: [{
          cited_decision: "Authority", identifying_block: "p1", opinion_id: "o1", signals: ["applied"], other_signal: null,
          proposition: "The rule", treatment: "The opinion applies the rule.", evidence_blocks: ["p1"], supporting_passages: [], quoted_passages: [],
        }],
      },
    },
  };
}

const JOINT_TEXT = [
  "Before: Alpha J.A. and Beta J.A.",
  "Joint reasons for judgment",
  "[1] This appeal concerns the governing rule.",
  "[2] The appeal is dismissed.",
].join("\n");
const jointBoundary = {
  start_line: 3,
  end_line: 4,
  start_quote: "[1] This appeal concerns the governing rule.",
  end_quote: "[2] The appeal is dismissed.",
};
const jointMaterial: CaseMaterial = {
  document_id: 2,
  citation: "Joint v Example, 2026 ABCA 2",
  name: "Joint v Example",
  date: "2026-01-01",
  dataset: "ABCA",
  language: "en",
  url: null,
  text: JOINT_TEXT,
  source_lines: modelSourceLines(JOINT_TEXT),
  citation_inventory: { authorities: [], occurrences: [] },
  coverage: { status: "not_asserted", spans: [] },
};

function jointRecord() {
  const value = projectProductGold(record());
  value.document_id = jointMaterial.document_id;
  value.citation = jointMaterial.citation;
  value.structure.opinions[0] = {
    opinion_id: "o1",
    boundary: jointBoundary,
    writer: "Alpha J.A.",
    collective_author: null,
    result_position: "supports_disposition",
  };
  value.structure.participants = ["Alpha J.A.", "Beta J.A."].map((name) => ({
    name,
    result_position: "supports_disposition",
    opinion_links: [{ opinion_id: "o1", relation: "wrote" as const }],
  }));
  return value;
}

describe("product gold", () => {
  it("keeps only scored structure, outcome, and treatment fields", () => {
    const value = projectProductGold(record());
    expect(value.contract_version).toBe(PRODUCT_GOLD_VERSION);
    expect(value.structure.opinions[0]?.writer).toBe("Example J.A.");
    expect(value.direct_outcomes[0]?.actions[0]).toEqual({ action: "reversed", affected_part: "liability" });
    expect(value.reported_history[0]).toEqual({
      cited_decision: "Earlier decision", action: "affirmed", later_decision: "Later decision",
      affected_part: null, opinion_id: "o1",
    });
    expect(value.treatments[0]).toEqual({
      cited_decision: "Authority", opinion_id: "o1", signals: ["applied"], other_signal: null,
      proposition: "The rule", treatment: "The opinion applies the rule.",
    });
    expect(value).not.toHaveProperty("decision_mentions");
    expect(value.treatments[0]).not.toHaveProperty("evidence_blocks");
    expect(productGoldErrors(value)).toEqual([]);
  });

  it("names every joint author in semantic references", () => {
    const reference = productReferenceView(jointRecord());
    expect(reference.reported_history[0]?.treating_opinion).toBe("Alpha J.A. and Beta J.A.");
    expect(reference.treatments[0]?.treating_opinion).toBe("Alpha J.A. and Beta J.A.");
  });

  it("compiles mechanical product structure without author evidence inside the opinion", () => {
    const result = compileProductDecisionStructure(jointRecord(), jointMaterial);
    expect(jointBoundary.start_quote).not.toContain("Alpha J.A.");
    expect(result.errors).toEqual([]);
    expect(result.compiled?.opinions[0]).toMatchObject({
      opinion_id: "o1",
      writers: ["Alpha J.A.", "Beta J.A."],
      result_position: "supports_disposition",
    });
    expect(result.compiled?.participants.map(({ name, links }) => ({
      name,
      relations: links.map(({ relation }) => relation),
    }))).toEqual([
      { name: "Alpha J.A.", relations: ["wrote"] },
      { name: "Beta J.A.", relations: ["wrote"] },
    ]);
  });

  it("grades only product claims and requires every item exactly once", () => {
    const reference = productReferenceView(projectProductGold(record()));
    const candidate = {
      direct_outcomes: [{ ...reference.direct_outcomes[0]!, id: "cd1", evidence: ["The appeal is allowed."] }],
      reported_history: [{ ...reference.reported_history[0]!, id: "ch1", evidence: ["The earlier decision was affirmed."] }],
      treatments: [{ ...reference.treatments[0]!, id: "ct1", evidence: ["I apply Authority."] }],
    };
    const grade = {
      grades: [
        { kind: "direct_outcome", reference_id: "gd1", candidate_ids: ["cd1"], verdict: "pass", explanation: null },
        { kind: "reported_history", reference_id: "gh1", candidate_ids: ["ch1"], verdict: "pass", explanation: null },
        { kind: "treatment", reference_id: "gt1", candidate_ids: ["ct1"], verdict: "pass", explanation: null },
      ],
      extras: [],
    };
    expect(productJudgeErrors(reference, candidate, grade)).toEqual([]);
    expect(productJudgeScore(grade)).toMatchObject({
      overall: { score: 1 },
      extras: { items: 0, score: 1 },
      treatment: { items: 1 }, direct_outcome: { items: 1 }, reported_history: { items: 1 },
    });
    expect(productJudgePrompt(reference, candidate)).toContain("what the judicial opinions say");
    expect(productJudgePrompt(reference, candidate)).toContain("whole-versus-part scope");
    expect(productJudgeErrors(reference, candidate, {
      ...grade,
      grades: [{ ...grade.grades[0], kind: "treatment" }, grade.grades[1]],
    })).toContain("wrong kind for gd1");
  });

  it("repairs unmatched candidates by attaching or grading them as extras", () => {
    const reference = productReferenceView(projectProductGold(record()));
    const candidate = {
      direct_outcomes: [{ ...reference.direct_outcomes[0]!, id: "cd1" }],
      reported_history: [{ ...reference.reported_history[0]!, id: "ch1" }],
      treatments: [
        { ...reference.treatments[0]!, id: "ct1" },
        { ...reference.treatments[0]!, id: "ct2", proposition: "An accurate omitted point" },
      ],
    };
    const grade = {
      grades: [
        { kind: "direct_outcome", reference_id: "gd1", candidate_ids: ["cd1"], verdict: "pass", explanation: null },
        { kind: "reported_history", reference_id: "gh1", candidate_ids: ["ch1"], verdict: "pass", explanation: null },
        { kind: "treatment", reference_id: "gt1", candidate_ids: ["ct1"], verdict: "pass", explanation: null },
      ],
      extras: [],
    };
    const repaired = mergeProductJudgeRepair(grade, candidate, {
      assignments: [
        { candidate_id: "ct2", reference_id: "gt1", verdict: null, explanation: null },
      ],
    });
    expect(productJudgeErrors(reference, candidate, repaired)).toEqual([]);
    expect((repaired as { grades: Array<{ candidate_ids: string[] }> }).grades[2]?.candidate_ids).toEqual(["ct1", "ct2"]);

    const extra = mergeProductJudgeRepair(grade, candidate, {
      assignments: [{ candidate_id: "ct2", reference_id: null, verdict: "pass", explanation: "Accurate omitted point." }],
    });
    expect(productJudgeErrors(reference, candidate, extra)).toEqual([]);
    expect((extra as { extras: Array<Record<string, unknown>> }).extras).toEqual([{
      kind: "treatment", candidate_id: "ct2", verdict: "pass", explanation: "Accurate omitted point.",
    }]);
    expect(productJudgeRepairPrompt(reference, candidate, grade, ["unmatched candidate ct2"])).toContain("ct2");
  });

  it("accepts one merged candidate as support for several reference propositions", () => {
    const reference = productReferenceView(projectProductGold(record()));
    reference.treatments.push({ ...reference.treatments[0]!, id: "gt2", proposition: "The related rule" });
    const candidate = {
      direct_outcomes: [],
      reported_history: [],
      treatments: [{ ...reference.treatments[0]!, id: "ct1", evidence: ["Both rules are applied."] }],
    };
    const grade = {
      grades: [
        { kind: "direct_outcome", reference_id: "gd1", candidate_ids: [], verdict: "major_error", explanation: "Missing." },
        { kind: "reported_history", reference_id: "gh1", candidate_ids: [], verdict: "major_error", explanation: "Missing." },
        { kind: "treatment", reference_id: "gt1", candidate_ids: ["ct1"], verdict: "pass", explanation: null },
        { kind: "treatment", reference_id: "gt2", candidate_ids: ["ct1"], verdict: "pass", explanation: null },
      ],
      extras: [],
    };
    expect(productJudgeErrors(reference, candidate, grade)).toEqual([]);
    expect(normalizeProductJudgeResult({
      ...grade,
      extras: [{ kind: "treatment", candidate_id: "ct1", verdict: "pass", explanation: "Duplicate." }],
    })).toEqual(grade);
  });

  it("does not let valid extra discoveries compensate for missing gold", () => {
    const reference = productReferenceView(projectProductGold(record()));
    const candidate = {
      direct_outcomes: [],
      reported_history: [],
      treatments: [{ ...reference.treatments[0]!, id: "ct1", proposition: "Another accurate proposition" }],
    };
    const grade = {
      grades: [
        { kind: "direct_outcome", reference_id: "gd1", candidate_ids: [], verdict: "major_error", explanation: "Missing." },
        { kind: "reported_history", reference_id: "gh1", candidate_ids: [], verdict: "major_error", explanation: "Missing." },
        { kind: "treatment", reference_id: "gt1", candidate_ids: [], verdict: "major_error", explanation: "Missing." },
      ],
      extras: [{ kind: "treatment", candidate_id: "ct1", verdict: "pass", explanation: "Accurate omitted treatment." }],
    };
    expect(productJudgeErrors(reference, candidate, grade)).toEqual([]);
    expect(productJudgeScore(grade)).toMatchObject({ overall: { score: 0 }, extras: { score: 1 } });
    expect(productJudgeErrors(reference, candidate, {
      ...grade,
      grades: [{ ...grade.grades[0], verdict: "pass", explanation: null }, grade.grades[1]],
    })).toContain("missing reference gd1 must be a major_error");
  });

  it("rejects unknown verdicts and blank extra explanations", () => {
    const reference = productReferenceView(projectProductGold(record()));
    const candidate = {
      direct_outcomes: [{ ...reference.direct_outcomes[0]!, id: "cd1" }],
      reported_history: [{ ...reference.reported_history[0]!, id: "ch1" }],
      treatments: [
        { ...reference.treatments[0]!, id: "ct1" },
        { ...reference.treatments[0]!, id: "ct2", proposition: "An extra proposition" },
      ],
    };
    expect(productJudgeErrors(reference, candidate, {
      grades: [
        { kind: "direct_outcome", reference_id: "gd1", candidate_ids: ["cd1"], verdict: "unknown", explanation: "Invalid." },
        { kind: "reported_history", reference_id: "gh1", candidate_ids: ["ch1"], verdict: "pass", explanation: null },
        { kind: "treatment", reference_id: "gt1", candidate_ids: ["ct1"], verdict: "pass", explanation: null },
      ],
      extras: [{ kind: "treatment", candidate_id: "ct2", verdict: "unknown", explanation: "" }],
    })).toEqual([
      "invalid verdict for gd1",
      "invalid verdict for ct2",
      "extra ct2 requires an explanation",
    ]);
  });
});
