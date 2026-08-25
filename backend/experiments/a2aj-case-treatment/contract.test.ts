import { describe, expect, it } from "vitest";

import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import {
  analysisOutputSchema,
  authorityInventoryOutputSchema,
  authorityInventoryPrompt,
  compareStructureMechanics,
  compileSubmission,
  compileAuthorityInventory,
  deterministicQuoteCandidates,
  oneStagePrompt,
  paragraphCoverageEnd,
  propositionSupport,
  SEMANTIC_JUDGE_SCHEMA,
  semanticJudgePrompt,
  semanticJudgeResultErrors,
  semanticJudgeScore,
  semanticView,
  submissionOutputSchema,
  type AnchoredSpan,
  type CaseMaterial,
  type CaseTreatmentSubmission,
  type DecisionCitationInventory,
  type GoldRecord,
} from "./contract";

const TEXT = [
  "Before: Alpha J., Beta J., Gamma J.",
  "Reasons of The Court",
  "[1] Alpha J.: This appeal concerns the legal requirements for electronic notice.",
  "[2] In Prior v. Example, 2020 SCC 1, the Court held that \u201ca valid notice must identify the legal basis.\u201d",
  "[3] I approve that rule and extend it to electronic notices because recipients need the same protection.",
  "ORDER",
  "[4] The appeal is dismissed.",
  "Beta J.: I agree with Alpha J.'s reasons.",
  "Gamma J.: I agree in the result only.",
  "\"Alpha J.\"",
].join("\n");

const sourceLines = modelSourceLines(TEXT);

function anchored(startText: string, endText = startText): AnchoredSpan {
  const startIndex = TEXT.indexOf(startText);
  const endIndex = TEXT.indexOf(endText, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing fixture text: ${startText} / ${endText}`);
  const startLine = sourceLines.find(({ start, end }) => startIndex >= start && startIndex < end)!.line;
  const endLine = sourceLines.find(({ start, end }) => endIndex >= start && endIndex < end)!.line;
  return { start_line: startLine, end_line: endLine, start_quote: startText, end_quote: endText };
}

const citationStart = TEXT.indexOf("2020 SCC 1");
const inventory: DecisionCitationInventory = {
  authorities: [{
    id: "a1",
    citation_key: "2020scc1",
    display_citations: ["2020 SCC 1"],
    occurrence_ids: ["c1"],
    document_id: null,
  }],
  occurrences: [{
    id: "c1",
    kind: "citation",
    quote: "2020 SCC 1",
    start: citationStart,
    end: citationStart + "2020 SCC 1".length,
    citationKey: "2020scc1",
    linkedContext: null,
    authority_id: "a1",
    citation_key: "2020scc1",
  }],
};

const material: CaseMaterial = {
  document_id: 99,
  citation: "2024 SCC 99",
  name: "Current v. Example",
  date: "2024-01-01",
  dataset: "SCC",
  language: "en",
  url: "https://example.test/current",
  text: TEXT,
  source_lines: sourceLines,
  citation_inventory: inventory,
  coverage: {
    status: "asserted",
    spans: ["[1]", "[2]", "[3]", "[4]"].map((label) => {
      const line = sourceLines.find(({ start, end }) => TEXT.slice(start, end).startsWith(label))!;
      return { start: line.start, end: line.end, label };
    }),
  },
};

function submission(): CaseTreatmentSubmission {
  return {
    structure: {
      disposition_spans: [anchored("The appeal is dismissed.")],
      opinions: [{
        opinion_id: "o1",
        boundary: anchored("[1] Alpha J.:", "The appeal is dismissed."),
        collective_author: null,
        result_position: "supports_disposition",
        result_evidence: anchored("The appeal is dismissed."),
      }],
      participants: [
        {
          name: "Alpha J.",
          panel_evidence: anchored("Alpha J., Beta J., Gamma J."),
          result_position: "supports_disposition",
          result_evidence: anchored("The appeal is dismissed."),
          opinion_links: [{
            opinion_id: "o1",
            relation: "wrote",
            scope: null,
            evidence: anchored("Alpha J.:")
          }],
        },
        {
          name: "Beta J.",
          panel_evidence: anchored("Alpha J., Beta J., Gamma J."),
          result_position: "supports_disposition",
          result_evidence: anchored("I agree with Alpha J.'s reasons."),
          opinion_links: [{
            opinion_id: "o1",
            relation: "joined",
            scope: null,
            evidence: anchored("Beta J.: I agree with Alpha J.'s reasons."),
          }],
        },
        {
          name: "Gamma J.",
          panel_evidence: anchored("Alpha J., Beta J., Gamma J."),
          result_position: "supports_disposition",
          result_evidence: anchored("I agree in the result only."),
          opinion_links: [],
        },
      ],
      nonparticipants: [],
    },
    analysis: {
      references: [{
        reference_id: "r1",
        detected_occurrence_id: "c1",
        reference_status: "decision_reference",
        voice: "current_opinion",
        span: anchored("Prior v. Example, 2020 SCC 1"),
      }],
      attributed_passages: [{
        passage_id: "q1",
        reference_ids: ["r1"],
        span: anchored("a valid notice must identify the legal basis."),
      }],
      treatments: [{
        treatment_id: "t1",
        reference_ids: ["r1"],
        opinion_id: "o1",
        signals: ["approved", "extended"],
        other_signal: null,
        cited_proposition: "Prior establishes that \u201ca valid notice must identify the legal basis.\u201d",
        treatment_summary: "The opinion endorses that notice rule and applies it beyond its earlier setting to electronic notices.",
        evidence_spans: [
          anchored("the Court held", "a valid notice must identify the legal basis."),
          anchored("I approve that rule", "recipients need the same protection."),
        ],
        attributed_passage_ids: ["q1"],
        partial_adopters: [],
      }],
      procedural_history: [],
      reference_uses: [{
        reference_id: "r1",
        treatment_ids: ["t1"],
        procedural_history_ids: [],
      }],
    },
  };
}

describe("proposition-first case treatment contract", () => {
  it("compiles exact source spans and derives proposition-level majority support", () => {
    const compiled = compileSubmission(submission(), material);
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(compiled.structure.coverage).toEqual({ status: "asserted", required: 4, covered: 4 });
    const treatment = compiled.analysis!.compiled!.treatments[0];
    expect(propositionSupport(compiled.structure.compiled!, treatment)).toEqual({
      supporters: 2,
      panel_size: 3,
      status: "majority",
    });
    expect(treatment.evidence_spans[0].exact_text).toContain("a valid notice must identify the legal basis");
  });

  it("keeps machine-detected quotations alongside analyst-delimited passages", () => {
    const candidates = deterministicQuoteCandidates(material);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toBe("a valid notice must identify the legal basis.");
    const compiled = compileSubmission(submission(), material);
    expect(compiled.analysis!.compiled!.attributed_passages[0].deterministic_quote_ids).toEqual(["dq1"]);
    expect(compiled.analysis!.deterministic_quote_candidates[0].text).toBe(candidates[0].text);
  });

  it("rejects missing detector accounting and substantive text outside every opinion", () => {
    const missingReference = submission();
    missingReference.analysis.references = [];
    expect(compileSubmission(missingReference, material).errors).toContain("analysis.references: missing detector occurrence c1");

    const missingBoundary = submission();
    missingBoundary.structure.opinions[0].boundary = anchored("[1] Alpha J.:", "recipients need the same protection.");
    expect(compileSubmission(missingBoundary, material).errors).toContain("structure coverage: substantive [4] is inside 0 opinion boundaries");
  });

  it("requires every reference occurrence to declare its treatment and history uses", () => {
    const missingUse = submission();
    missingUse.analysis.reference_uses = [];
    expect(compileSubmission(missingUse, material).errors).toContain(
      "analysis.references[0]: reference r1 is missing its reference_uses entry",
    );

    const missingTreatment = submission();
    missingTreatment.analysis.reference_uses[0].treatment_ids = [];
    expect(compileSubmission(missingTreatment, material).errors).toContain(
      "analysis.references[0]: reference r1 has incomplete treatment_ids in reference_uses",
    );
  });

  it("rejects treatment evidence assigned to the wrong opinion and invented quotations", () => {
    const outside = submission();
    outside.analysis.treatments[0].evidence_spans = [anchored("I agree with Alpha J.'s reasons.")];
    expect(compileSubmission(outside, material).errors.some((error) => error.includes("evidence is outside o1"))).toBe(true);

    const invented = submission();
    invented.analysis.treatments[0].treatment_summary =
      "The opinion adopted \u201ca completely invented proposition that does not appear anywhere in this decision.\u201d";
    expect(compileSubmission(invented, material).errors.some((error) =>
      error.includes("analysis.treatments[0].treatment_summary") && error.includes("does not match its cited evidence")
    )).toBe(true);
  });

  it("rejects a bare joinder masquerading as an opinion", () => {
    const invalid = submission();
    invalid.structure.opinions.push({
      opinion_id: "o2",
      boundary: anchored("Gamma J.: I agree in the result only."),
      collective_author: null,
      result_position: "supports_disposition",
      result_evidence: anchored("I agree in the result only."),
    });
    expect(compileSubmission(invalid, material).errors).toContain(
      "structure.opinions[1].boundary: fewer than 40 substantive words",
    );
  });

  it("derives majority support for sole collectively authored reasons without counting a result-only judge", () => {
    const collective = submission();
    collective.structure.opinions[0].collective_author = {
      name: "The Court",
      evidence: anchored("Reasons of The Court"),
    };
    collective.structure.participants[0].opinion_links = [];
    collective.structure.participants[1].opinion_links = [];
    const compiled = compileSubmission(collective, material);
    expect(compiled.ok).toBe(true);
    expect(propositionSupport(
      compiled.structure.compiled!,
      compiled.analysis!.compiled!.treatments[0],
    )).toEqual({ supporters: 2, panel_size: 3, status: "majority" });
  });

  it("grounds participants whose evidence uses courtroom short forms", () => {
    const registryStyle = submission();
    registryStyle.structure.participants[0].name = "Alpha, Adrian B., (Honourable Justice)";
    expect(compileSubmission(registryStyle, material).ok).toBe(true);

    const unidentified = submission();
    unidentified.structure.participants[0].opinion_links[0].evidence = anchored("This appeal concerns");
    const errors = compileSubmission(unidentified, material).errors;
    expect(errors.some((error) => error.includes("evidence does not identify Alpha J."))).toBe(true);
  });

  it("scores opinion structure mechanically without treating judicial title formatting as a different writer", () => {
    const expected = compileSubmission(submission(), material).structure;
    const candidate = compileSubmission(submission(), material).structure;
    candidate.compiled!.opinions[0].writers = ["The Honourable Justice A. Alpha"];
    candidate.compiled!.participants[0].name = "The Honourable Justice A. Alpha";
    const comparison = compareStructureMechanics(expected, candidate, material)!;
    expect(comparison.categories.writers_exact).toBe(true);
    expect(comparison.categories.participant_votes_exact).toBe(true);
    expect(comparison.category_score).toEqual({ passed: 8, total: 8, score: 1 });
  });

  it("accepts a harmless boundary heading variant and canonicalizes a judicial signature", () => {
    const expected = compileSubmission(submission(), material).structure;
    const withHeading = submission();
    withHeading.structure.opinions[0].boundary = anchored("Reasons of The Court", "The appeal is dismissed.");
    const candidate = compileSubmission(withHeading, material).structure;
    const comparison = compareStructureMechanics(expected, candidate, material)!;
    expect(comparison.categories.boundaries_acceptable).toBe(true);
    expect(comparison.metrics.exact_boundaries).toBe(0);

    const withSignature = submission();
    withSignature.structure.opinions[0].boundary = anchored("[1] Alpha J.:", "\"Alpha J.\"");
    const canonicalized = compileSubmission(withSignature, material);
    expect(canonicalized.ok).toBe(true);
    expect(canonicalized.value!.structure.opinions[0].boundary.end_quote).toBe("\"Alpha J.\"");
    expect(canonicalized.structure.compiled!.opinions[0].boundary.exact_text).not.toContain("\"Alpha J.\"");
    expect(canonicalized.structure.boundary_adjustments).toMatchObject([{
      opinion_id: "o1",
      rule: "trim_trailing_judicial_signature",
      removed_text: "\"Alpha J.\"",
    }]);
    expect(paragraphCoverageEnd("[4] Reasons end.\nORDER\nAppeal dismissed.")).toBe("[4] Reasons end.".length);
  });

  it("accepts a gold disposition edge variant but not omitted substantive reasoning", () => {
    const substantive = material.coverage.spans.slice(0, 3);
    const gradingMaterial = { ...material, coverage: { status: "asserted" as const, spans: substantive } };
    const expected = compileSubmission(submission(), gradingMaterial).structure;

    const withoutBareOrder = submission();
    withoutBareOrder.structure.opinions[0].boundary = anchored("[1] Alpha J.:", "recipients need the same protection.");
    const orderVariant = compileSubmission(withoutBareOrder, gradingMaterial).structure;
    expect(compareStructureMechanics(expected, orderVariant, gradingMaterial)!.categories.boundaries_acceptable).toBe(true);

    const reasoningOmission = structuredClone(expected);
    const omittedReasoningStart = TEXT.indexOf("[3] I approve that rule");
    reasoningOmission.compiled!.opinions[0].boundary.end = omittedReasoningStart;
    reasoningOmission.compiled!.opinions[0].boundary.exact_text = TEXT.slice(
      reasoningOmission.compiled!.opinions[0].boundary.start,
      omittedReasoningStart,
    ).trimEnd();
    expect(compareStructureMechanics(expected, reasoningOmission, gradingMaterial)!.categories.boundaries_acceptable).toBe(false);
  });

  it("requires the complete JSON surface even when an omitted array would otherwise be empty", () => {
    const incomplete = submission() as unknown as Record<string, unknown>;
    delete (incomplete.analysis as Record<string, unknown>).procedural_history;
    expect(compileSubmission(incomplete, material).errors).toContain("analysis.procedural_history: expected an array");
  });

  it("grounds a case-wide authority inventory without turning it into treatment output", () => {
    const draft = {
      authorities: [{
        authority_id: "a1",
        identifying_text: "Prior v. Example, 2020 SCC 1",
        occurrences: [anchored("Prior v. Example, 2020 SCC 1")],
      }],
    };
    expect(compileAuthorityInventory(draft, material)).toMatchObject({ ok: true, value: draft });
    expect(authorityInventoryOutputSchema(sourceLines.length)).toMatchObject({ type: "object" });
    expect(authorityInventoryPrompt(material)).toContain("list every judicial decision");
  });

  it("has no issue-number layer in schemas, extraction prompts, gold, or semantic judgment", () => {
    const compiled = compileSubmission(submission(), material);
    const gold: GoldRecord = {
      document_id: material.document_id,
      citation: material.citation,
      source_sha256: "fixture",
      annotation: submission(),
    };
    const surfaces = [
      JSON.stringify(submissionOutputSchema(inventory, sourceLines.length)),
      JSON.stringify(analysisOutputSchema(inventory, sourceLines.length)),
      JSON.stringify(gold),
      oneStagePrompt(material),
      JSON.stringify(semanticView(compiled)),
      semanticJudgePrompt(compiled, compiled),
    ];
    for (const surface of surfaces) expect(surface).not.toMatch(/\bissue(?:s|_number)?\b/iu);
  });

  it("emits structured-output schemas accepted by the Codex Responses API", () => {
    const schemas = [
      submissionOutputSchema(inventory, sourceLines.length),
      analysisOutputSchema(inventory, sourceLines.length),
      authorityInventoryOutputSchema(sourceLines.length),
    ];
    for (const schema of schemas) expect(JSON.stringify(schema)).not.toContain('"uniqueItems"');
  });

  it("keeps semantic judgment on legal treatment rather than mechanical structure", () => {
    const compiled = compileSubmission(submission(), material);
    const view = semanticView(compiled);
    const prompt = semanticJudgePrompt(compiled, compiled);
    expect(Object.keys(view!)).toEqual(["treatments", "procedural_history"]);
    expect(view!.treatments[0].treatment_id).toBe("t1");
    expect(view!.treatments[0].cited_references).toEqual([{
      reference: "Prior v. Example, 2020 SCC 1",
      voice: "current_opinion",
    }]);
    expect(view!.treatments[0].majority_support).toBe("majority");
    expect(JSON.stringify(view)).not.toMatch(/boundary|panel_evidence|opinion_links/u);
    expect(prompt).not.toMatch(/deterministic|source anchors|panel rosters|vote arithmetic/u);
    expect(Object.keys(SEMANTIC_JUDGE_SCHEMA.properties)).toEqual([
      "treatment_grades",
      "extra_candidate_treatments",
      "procedural_history_grades",
      "extra_candidate_history",
    ]);
    const grade = {
      treatment_grades: [{
        reference_treatment_id: "gt1",
        candidate_treatment_ids: ["ct1"],
        verdict: "pass",
        aspects: [],
        explanation: null,
      }],
      extra_candidate_treatments: [],
      procedural_history_grades: [],
      extra_candidate_history: [],
    };
    expect(semanticJudgeResultErrors(compiled, compiled, grade)).toEqual([]);
    expect(semanticJudgeScore(grade)).toMatchObject({
      treatment: { items: 1, earned: 1, score: 1 },
      overall: { items: 1, earned: 1, score: 1 },
      passed: true,
      passing_threshold: 0.8,
    });
  });
});
