import { describe, expect, it } from "vitest";

import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import {
  analysisOutputSchema,
  analysisPrompt,
  CASE_TREATMENT_CONTRACT_VERSION,
  compareStructureMechanics,
  compileReferenceSubmission,
  compileSubmission,
  deterministicQuoteCandidates,
  oneStagePrompt,
  noOracleCitationCheck,
  paragraphCoverageEnd,
  opinionSupportBounds,
  SEMANTIC_JUDGE_SCHEMA,
  semanticDraftView,
  semanticJudgePrompt,
  semanticJudgeResultErrors,
  semanticJudgeScore,
  semanticView,
  submissionReviewFlags,
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
  "Alpha J.",
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

function block(text: string) {
  const index = TEXT.indexOf(text);
  const line = sourceLines.find(({ start, end }) => index >= start && index < end)?.line;
  if (!line) throw new Error(`missing fixture block: ${text}`);
  return `p${line}` as const;
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
      decision_mentions: [{
        cited_decision: "Prior v. Example, 2020 SCC 1",
        identifying_block: block("Prior v. Example, 2020 SCC 1"),
      }],
      procedural_relationships: [],
      treatments: [{
        cited_decision: "Prior v. Example, 2020 SCC 1",
        identifying_block: block("Prior v. Example, 2020 SCC 1"),
        opinion_id: "o1",
        signals: ["approved", "extended"],
        other_signal: null,
        proposition: "Prior establishes that \u201ca valid notice must identify the legal basis.\u201d",
        treatment: "The opinion endorses that notice rule and applies it beyond its earlier setting to electronic notices.",
        evidence_blocks: [block("I approve that rule")],
        supporting_passages: [{
          block_ids: [block("I approve that rule")],
          text: "I approve that rule and extend it to electronic notices because recipients need the same protection.",
        }],
        quoted_passages: [{
          block_ids: [block("a valid notice must identify the legal basis.")],
          text: "a valid notice must identify the legal basis.",
        }],
      }],
    },
  };
}

describe("proposition-first case treatment contract", () => {
  it("compiles exact source spans and proves when one opinion has majority support", () => {
    const compiled = compileSubmission(submission(), material);
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(compiled.structure.coverage).toEqual({ status: "asserted", required: 4, covered: 4 });
    const treatment = compiled.analysis!.compiled!.treatments[0];
    expect(opinionSupportBounds(compiled.structure.compiled!, treatment)).toEqual({
      confirmed_supporters: 2,
      possible_supporters: 2,
      panel_size: 3,
      status: "majority",
    });
    expect(treatment.evidence_blocks[0].exact_text).toContain("I approve that rule");
  });

  it("assigns treatment IDs in the host instead of asking the model", () => {
    const draft = submission();
    (draft.analysis.treatments[0] as unknown as Record<string, unknown>).treatment_id = "t99";
    const compiled = compileSubmission(draft, material);
    expect(compiled.analysis!.compiled!.treatments[0].treatment_id).toBe("t1");
    expect(JSON.stringify(analysisOutputSchema(sourceLines.length, ["o1"]))).not.toContain("treatment_id");
  });

  it("requires every cited-decision label to be copied from its identifying block", () => {
    const draft = submission();
    draft.analysis.decision_mentions[0].cited_decision = "Invented v. Authority";
    expect(compileSubmission(draft, material).errors).toContain(
      "analysis.decision_mentions[0].cited_decision: copy one contiguous exact name or citation from the identifying block",
    );
  });

  it("offers simple and self-check analysis contracts with one compiled result", () => {
    const simple = submission();
    delete simple.analysis.treatments[0].opinion_id;
    delete simple.analysis.treatments[0].supporting_passages;
    const compiled = compileSubmission(simple, material, "simple");
    expect(compiled.ok).toBe(true);
    expect(compiled.analysis!.compiled!.treatments[0]).toMatchObject({
      opinion_id: "o1",
      model_opinion_id: null,
      supporting_passages: [],
    });

    const simpleSchema = JSON.stringify(analysisOutputSchema(sourceLines.length, ["o1"], "simple"));
    const checkedSchema = JSON.stringify(analysisOutputSchema(sourceLines.length, ["o1"], "self-check"));
    expect(simpleSchema).not.toContain('"opinion_id"');
    expect(simpleSchema).not.toContain('"supporting_passages"');
    expect(checkedSchema).toContain('"opinion_id"');
    expect(checkedSchema).toContain('"supporting_passages"');
    expect(analysisPrompt(material, simple.structure, false, "simple")).not.toContain("supporting_passages");
    expect(analysisPrompt(material, simple.structure, false, "self-check")).toContain("supporting_passages");
  });

  it("compiles reference truth without candidate-only self-check passages", () => {
    const reference = submission();
    delete reference.analysis.treatments[0].supporting_passages;
    expect(compileReferenceSubmission(reference, material).ok).toBe(true);

    delete reference.analysis.treatments[0].opinion_id;
    expect(compileReferenceSubmission(reference, material).errors).toContain(
      "analysis.treatments[0].opinion_id: reference opinion_id is required",
    );

    reference.analysis.treatments[0].opinion_id = "o2";
    expect(compileReferenceSubmission(reference, material).errors).toContain(
      "analysis.treatments[0].opinion_id: o2 conflicts with evidence in o1",
    );
  });

  it("checks the self-reported opinion and aligns copied support to exact offsets", () => {
    const checked = submission();
    checked.analysis.treatments[0].supporting_passages![0].text =
      "I approve  that rule and extend it to electronic notices because recipients need the same protection.";
    const compiled = compileSubmission(checked, material, "self-check");
    expect(compiled.ok).toBe(true);
    expect(compiled.analysis!.compiled!.treatments[0]).toMatchObject({
      opinion_id: "o1",
      model_opinion_id: "o1",
      supporting_passages: [expect.objectContaining({ alignment: "normalized" })],
    });

    const wrong = submission();
    wrong.analysis.treatments[0].opinion_id = "o2";
    expect(compileSubmission(wrong, material, "self-check").errors).toContain(
      "analysis.treatments[0]: unknown opinion_id o2",
    );
  });

  it("records source-exact prose as a receipt instead of rejecting it", () => {
    const draft = submission();
    draft.analysis.treatments[0].treatment =
      "The opinion says I approve that rule and extend it to electronic notices.";
    const compiled = compileSubmission(draft, material);
    expect(compiled.ok).toBe(true);
    expect(compiled.analysis!.prose_copy_receipts).toEqual([expect.objectContaining({
      path: "analysis.treatments[0].treatment",
      exact_text: "I approve that rule and extend it to electronic notices",
      source: expect.objectContaining({ evidence_id: "e1" }),
    })]);
  });

  it("flags treatment prose copied across different cited decisions for semantic review", () => {
    const compiled = structuredClone(compileSubmission(submission(), material));
    const original = compiled.analysis!.compiled!.treatments[0];
    compiled.analysis!.compiled!.treatments.push({
      ...structuredClone(original), decision_id: "d2", treatment_id: "t2",
    });
    expect(submissionReviewFlags(compiled)).toEqual([expect.objectContaining({
      kind: "shared_treatment_wording",
      opinion_id: "o1",
      decision_ids: ["d1", "d2"],
      treatment_ids: ["t1", "t2"],
    })]);
  });

  it("leaves point-level support unresolved when a qualified agreement could change the count", () => {
    const draft = submission();
    draft.structure.participants[1].opinion_links[0].relation = "joined_in_part";
    const compiled = compileSubmission(draft, material);
    expect(compiled.ok).toBe(true);
    const treatment = compiled.analysis!.compiled!.treatments[0];
    expect(opinionSupportBounds(compiled.structure.compiled!, treatment)).toEqual({
      confirmed_supporters: 1,
      possible_supporters: 2,
      panel_size: 3,
      status: "unresolved",
    });
    expect(compiled.structure.compiled!.opinions[0].qualified_joiners[0].evidence.exact_text)
      .toBe("Beta J.: I agree with Alpha J.'s reasons.");
  });

  it("keeps machine-detected quotations alongside analyst-delimited passages", () => {
    const candidates = deterministicQuoteCandidates(material);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toBe("a valid notice must identify the legal basis.");
    const compiled = compileSubmission(submission(), material);
    expect(compiled.analysis!.compiled!.treatments[0].quoted_passages[0].deterministic_quote_ids).toEqual(["dq1"]);
    expect(compiled.analysis!.deterministic_quote_candidates[0].text).toBe(candidates[0].text);
  });

  it("stores a procedural relationship separately from precedential treatment", () => {
    const draft = submission();
    draft.analysis.procedural_relationships.push({
      cited_decision: "Prior v. Example, 2020 SCC 1",
      identifying_block: block("Prior v. Example, 2020 SCC 1"),
      description: "The appeal is dismissed.",
      evidence_blocks: [block("The appeal is dismissed.")],
      actions: [{
        action: "affirmed",
        affected_part: null,
        evidence_blocks: [block("The appeal is dismissed.")],
      }],
    });
    const compiled = compileSubmission(draft, material);
    expect(compiled.ok).toBe(true);
    expect(semanticView(compiled)?.procedural_relationships[0]).toMatchObject({
      cited_decision: "Prior v. Example, 2020 SCC 1",
      actions: [{ action: "affirmed", affected_part: null }],
    });
  });

  it("flags an obvious citation omission only after reading the draft", () => {
    const missingReference = submission();
    missingReference.analysis.decision_mentions = [];
    missingReference.analysis.treatments = [];
    const compiled = compileSubmission(missingReference, material);
    expect(compiled.analysis?.no_oracle_citation_check).toMatchObject({ checked: 1, covered: 0 });
    expect(compiled.errors).toContain(
      'analysis.decision_mentions: source block p5 contains an unmistakable decision citation "2020 SCC 1" that is not represented',
    );
  });

  it("rejects substantive text outside every opinion", () => {
    const missingBoundary = submission();
    missingBoundary.structure.opinions[0].boundary = anchored("[1] Alpha J.:", "recipients need the same protection.");
    expect(compileSubmission(missingBoundary, material).errors.some((error) =>
      error.startsWith("structure coverage: substantive [4]") && error.endsWith("inside 0 opinion boundaries"),
    )).toBe(true);
  });

  it("requires a treatment's reproduced passage to occur in its opinion", () => {
    const wrongSpeaker = submission();
    wrongSpeaker.analysis.treatments[0].quoted_passages = [
      { block_ids: [block("Beta J.: I agree with Alpha J.'s reasons.")], text: "Beta J.: I agree with Alpha J.'s reasons." },
    ];
    expect(compileSubmission(wrongSpeaker, material).errors).toContain(
      "analysis.treatments[0].quoted_passages[0]: quoted passage is outside o1",
    );
  });

  it("does not make a valid answer depend on detector identities", () => {
    const changedDetector = structuredClone(material);
    changedDetector.citation_inventory = { authorities: [], occurrences: [] };
    expect(compileSubmission(submission(), changedDetector).ok).toBe(true);
    const normal = compileSubmission(submission(), material);
    expect(noOracleCitationCheck(material, normal.structure.compiled!, normal.analysis!.compiled!)).toEqual({
      checked: 1,
      covered: 1,
      omissions: [],
      unresolved: [],
    });
  });

  it("uses a source footnote link to avoid a false citation omission", () => {
    const text = "Prior supplies the governing rule.[1]\n[1] Prior v. Example, 2020 SCC 1.";
    const lines = modelSourceLines(text);
    const citationStart = text.indexOf("2020 SCC 1");
    const nameStart = text.indexOf("Prior");
    const footnoteMaterial: CaseMaterial = {
      ...material,
      text,
      source_lines: lines,
      coverage: { status: "not_asserted", spans: [] },
      citation_inventory: {
        authorities: [{
          id: "a1", citation_key: "2020scc1", display_citations: ["2020 SCC 1"],
          occurrence_ids: ["c1"], document_id: null,
        }],
        occurrences: [{
          id: "c1", kind: "citation", quote: "2020 SCC 1", start: citationStart,
          end: citationStart + 10, citationKey: "2020scc1", authority_id: "a1",
          citation_key: "2020scc1",
          linkedContext: { kind: "footnote_reference", quote: "Prior", start: nameStart, end: nameStart + 5 },
        }],
      },
    };
    const resolved = (start: number, end: number, exactText: string) => ({
      start_line: 1, end_line: 1, start_quote: exactText, end_quote: exactText,
      start, end, exact_text: exactText, text_sha256: "fixture",
    });
    expect(noOracleCitationCheck(footnoteMaterial, {
      opinions: [{
        opinion_id: "o1", boundary: resolved(0, lines[0].end, text.slice(0, lines[0].end)),
        collective_author: null, result_position: "supports_disposition",
        writers: [], full_joiners: [], qualified_joiners: [],
      }],
      participants: [], nonparticipants: [], disposition_spans: [],
    }, {
      decision_mentions: [{
        decision_id: "d1",
        cited_decision: "Prior",
        identifying_block: resolved(nameStart, nameStart + 5, "Prior"),
      }],
      procedural_relationships: [], treatments: [],
    })).toEqual({ checked: 1, covered: 1, omissions: [], unresolved: [] });
  });

  it("does not reject an unmatched citation form when it could be an alias", () => {
    const text = "Alpha J.\nPrior v. Example, 2020 SCC 1, governs.\nPrior v. Example, 2020 CanLII 10, is the same judgment.";
    const lines = modelSourceLines(text);
    const first = text.indexOf("2020 SCC 1");
    const second = text.indexOf("2020 CanLII 10");
    const name = text.indexOf("Prior v. Example");
    const resolved = (start: number, end: number, exactText: string) => ({
      start_line: 1, end_line: 1, start_quote: exactText, end_quote: exactText,
      start, end, exact_text: exactText, text_sha256: "fixture",
    });
    const aliasMaterial: CaseMaterial = {
      ...material,
      text,
      source_lines: lines,
      coverage: { status: "not_asserted", spans: [] },
      citation_inventory: {
        authorities: [],
        occurrences: [
          { id: "c1", kind: "citation", quote: "2020 SCC 1", start: first, end: first + 10, citationKey: "2020scc1", authority_id: "a1", citation_key: "2020scc1", linkedContext: null },
          { id: "c2", kind: "citation", quote: "2020 CanLII 10", start: second, end: second + 14, citationKey: "2020canlii10", authority_id: "a2", citation_key: "2020canlii10", linkedContext: null },
        ],
      },
    };
    const check = noOracleCitationCheck(aliasMaterial, {
      opinions: [{
        opinion_id: "o1", boundary: resolved(0, text.length, text), collective_author: null,
        result_position: "supports_disposition", writers: ["Alpha J."], full_joiners: [], qualified_joiners: [],
      }],
      participants: [], nonparticipants: [], disposition_spans: [],
    }, {
      decision_mentions: [{
        decision_id: "d1", cited_decision: "Prior v. Example, 2020 SCC 1",
        identifying_block: resolved(name, first + 10, "Prior v. Example, 2020 SCC 1"),
      }],
      procedural_relationships: [], treatments: [],
    });
    expect(check.omissions).toEqual([]);
    expect(check.unresolved).toMatchObject([{ exact_text: "2020 CanLII 10" }]);
  });

  it("requires every treatment to identify a known judicial opinion", () => {
    const invalid = submission();
    invalid.analysis.treatments[0].opinion_id = "o2";
    expect(compileSubmission(invalid, material).errors).toContain(
      "analysis.treatments[0]: unknown opinion_id o2",
    );
  });

  it("rejects treatment evidence assigned to the wrong opinion and invented quotations", () => {
    const outside = submission();
    outside.analysis.treatments[0].evidence_blocks = [block("I agree with Alpha J.'s reasons.")];
    expect(compileSubmission(outside, material).errors.some((error) => error.includes("evidence blocks must identify exactly one judicial opinion"))).toBe(true);

    const invented = submission();
    invented.analysis.treatments[0].treatment =
      "The opinion adopted \u201ca completely invented proposition that does not appear anywhere in this decision.\u201d";
    expect(compileSubmission(invented, material).errors.some((error) =>
      error.includes("analysis.treatments[0].treatment") && error.includes("does not match its cited evidence")
    )).toBe(true);
  });

  it("does not use length alone to reject a proposed opinion", () => {
    const short = submission();
    short.structure.opinions.push({
      opinion_id: "o2",
      boundary: anchored("Gamma J.: I agree in the result only."),
      collective_author: null,
      result_position: "supports_disposition",
      result_evidence: anchored("I agree in the result only."),
    });
    expect(compileSubmission(short, material).errors.some((error) => error.includes("substantive words"))).toBe(false);
  });

  it("derives majority opinion support for sole collectively authored reasons without counting a result-only judge", () => {
    const collective = submission();
    collective.structure.opinions[0].collective_author = {
      name: "The Court",
      evidence: anchored("Reasons of The Court"),
    };
    collective.structure.participants[0].opinion_links = [];
    collective.structure.participants[1].opinion_links = [];
    const compiled = compileSubmission(collective, material);
    expect(compiled.ok).toBe(true);
    expect(opinionSupportBounds(
      compiled.structure.compiled!,
      compiled.analysis!.compiled!.treatments[0],
    )).toEqual({
      confirmed_supporters: 2,
      possible_supporters: 2,
      panel_size: 3,
      status: "majority",
    });
  });

  it("grounds participants whose evidence uses courtroom short forms", () => {
    const registryStyle = submission();
    registryStyle.structure.participants[0].name = "Alpha, Adrian B., (Honourable Justice)";
    expect(compileSubmission(registryStyle, material).ok).toBe(true);

    const unidentified = submission();
    unidentified.structure.participants[0].opinion_links[0].evidence = anchored("This appeal concerns");
    const errors = compileSubmission(unidentified, material).errors;
    expect(errors.some((error) => error.includes("evidence does not identify Alpha J."))).toBe(true);

    const typoText = `${TEXT}\nAlpppha J.`;
    const typoLines = modelSourceLines(typoText);
    const typoLine = typoLines.at(-1)!;
    const repeatedLetterTypo = submission();
    repeatedLetterTypo.structure.participants[0].name = "Alppha J.";
    repeatedLetterTypo.structure.participants[0].panel_evidence = {
      start_line: typoLine.line,
      end_line: typoLine.line,
      start_quote: "Alpppha J.",
      end_quote: "Alpppha J.",
    };
    repeatedLetterTypo.structure.participants[0].opinion_links[0].evidence =
      repeatedLetterTypo.structure.participants[0].panel_evidence;
    expect(compileSubmission(repeatedLetterTypo, {
      ...material,
      text: typoText,
      source_lines: typoLines,
    }).ok).toBe(true);
  });

  it("scores opinion structure mechanically without treating judicial title formatting as a different writer", () => {
    const expected = compileSubmission(submission(), material).structure;
    const candidate = compileSubmission(submission(), material).structure;
    candidate.compiled!.opinions[0].writers = ["Alpha, Adrian B."];
    candidate.compiled!.opinions[0].full_joiners = ["Bianca Beta"];
    candidate.compiled!.participants[0].name = "Alpha, Adrian B.";
    candidate.compiled!.participants[1].name = "Bianca Beta";
    candidate.compiled!.participants[2].name = "Gamma, Greta";
    const comparison = compareStructureMechanics(expected, candidate, material)!;
    expect(comparison.categories.writers_exact).toBe(true);
    expect(comparison.categories.full_joiners_exact).toBe(true);
    expect(comparison.categories.participant_votes_exact).toBe(true);
    expect(comparison.categories.result_only_participants_exact).toBe(true);
    expect(comparison.category_score).toEqual({ passed: 9, total: 9, score: 1 });

    const missedResultOnly = compileSubmission(submission(), material).structure;
    missedResultOnly.compiled!.participants[2].result_only = false;
    expect(compareStructureMechanics(expected, missedResultOnly, material)!.categories.result_only_participants_exact)
      .toBe(false);
  });

  it("accepts a harmless boundary heading variant and canonicalizes a judicial signature", () => {
    const expected = compileSubmission(submission(), material).structure;
    const withHeading = submission();
    withHeading.structure.opinions[0].boundary = anchored("Reasons of The Court", "The appeal is dismissed.");
    const candidate = compileSubmission(withHeading, material).structure;
    const comparison = compareStructureMechanics(expected, candidate, material)!;
    expect(comparison.categories.boundaries_acceptable).toBe(true);
    expect(comparison.metrics.exact_boundaries).toBe(0);

    const bylineText = [
      "//Alpha J.//",
      "The judgment of Beta and Alpha JJ. was delivered by",
      "A. introduction",
      "[1] Alpha J.: This is substantive reasoning.",
    ].join("\n");
    const bylineMaterial = {
      ...material,
      text: bylineText,
      source_lines: modelSourceLines(bylineText),
      coverage: { status: "not_asserted" as const, spans: [] },
    };
    const bylineExpected = structuredClone(expected);
    const bylineCandidate = structuredClone(expected);
    const reasonStart = bylineText.indexOf("[1]");
    bylineExpected.compiled!.opinions[0].boundary = {
      ...bylineExpected.compiled!.opinions[0].boundary,
      start: 0,
      end: bylineText.length,
      exact_text: bylineText,
    };
    bylineCandidate.compiled!.opinions[0].boundary = {
      ...bylineCandidate.compiled!.opinions[0].boundary,
      start: reasonStart,
      end: bylineText.length - 1,
      exact_text: bylineText.slice(reasonStart, -1),
    };
    expect(compareStructureMechanics(bylineExpected, bylineCandidate, bylineMaterial)!.categories.boundaries_acceptable)
      .toBe(true);

    const officerText = [
      "REASONS FOR ORDER",
      "RICHARD MORNEAU, PROTHONOTARY",
      "[1] Substantive reasoning.",
      "Summary of Dispositions",
      "[2] The motion is dismissed.",
    ].join("\n");
    const officerMaterial = {
      ...material,
      text: officerText,
      source_lines: modelSourceLines(officerText),
      coverage: { status: "not_asserted" as const, spans: [] },
    };
    const officerExpected = structuredClone(expected);
    const officerCandidate = structuredClone(expected);
    const reasonsStart = officerText.indexOf("[1]");
    const summaryStart = officerText.indexOf("Summary of Dispositions");
    const dispositionStart = officerText.indexOf("[2]");
    const resolved = (start: number, end: number) => ({
      ...officerExpected.compiled!.opinions[0].boundary,
      start,
      end,
      exact_text: officerText.slice(start, end),
    });
    officerExpected.compiled!.opinions[0].boundary = resolved(reasonsStart, summaryStart);
    officerCandidate.compiled!.opinions[0].boundary = resolved(0, officerText.length);
    officerExpected.compiled!.opinions[0].writers = ["Richard Morneau, Prothonotary"];
    officerCandidate.compiled!.opinions[0].writers = ["Richard Morneau"];
    officerExpected.compiled!.participants[0].name = "Richard Morneau, Prothonotary";
    officerCandidate.compiled!.participants[0].name = "Richard Morneau";
    officerExpected.compiled!.disposition_spans = [resolved(dispositionStart, officerText.length)];
    officerCandidate.compiled!.disposition_spans = officerExpected.compiled!.disposition_spans;
    const officerComparison = compareStructureMechanics(officerExpected, officerCandidate, officerMaterial)!;
    expect(officerComparison.categories.boundaries_acceptable).toBe(true);
    expect(officerComparison.categories.writers_exact).toBe(true);
    expect(officerComparison.categories.participant_votes_exact).toBe(true);

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
    expect(paragraphCoverageEnd("[29] Appeal dismissed.\nSigned at Ottawa, Canada, this 12th day of August 2003.\nJudge"))
      .toBe("[29] Appeal dismissed.".length);
    expect(paragraphCoverageEnd("[54] Special costs ordered.\n\"P. Walker J.\"\n________________\nThe Honourable Mr. Justice Paul Walker"))
      .toBe("[54] Special costs ordered.".length);
    expect(paragraphCoverageEnd("73 The appeal is allowed.\nThe following are the reasons delivered by"))
      .toBe("73 The appeal is allowed.".length);
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

  it("requires the case-wide procedural relationship list", () => {
    const incomplete = submission() as unknown as Record<string, unknown>;
    delete (incomplete.analysis as Record<string, unknown>).procedural_relationships;
    expect(compileSubmission(incomplete, material).errors).toContain(
      "analysis.procedural_relationships: expected an array",
    );
  });

  it("asks for one case-wide analysis without exposing detector candidates", () => {
    const prompt = analysisPrompt(material, submission().structure);
    expect(prompt).toContain("list one clear mention of every other decision");
    expect(prompt).toContain("Do not list decisions appearing only in editorial metadata, headnotes");
    expect(prompt).toContain("short contiguous exact name or citation copied from identifying_block");
    expect(prompt).not.toContain("POSSIBLE DECISION REFERENCES");
    expect(prompt).not.toContain("detected_occurrence_id");
    expect(prompt).not.toContain('"c1"');
    expect(prompt).not.toContain("partial_adopters");
    expect(prompt).not.toContain("EXAMPLE");
    expect(analysisPrompt(material, submission().structure, true)).toContain("EXAMPLE");
  });

  it("keeps qualified agreements as source evidence rather than interpreted treatment fields", () => {
    const schema = JSON.stringify(submissionOutputSchema(sourceLines.length));
    expect(schema).toContain('"joined_in_part"');
    expect(schema).not.toContain('"scope"');
    expect(schema).not.toContain('"partial_adopters"');
  });

  it("rejects contradictory relationships between one participant and one opinion", () => {
    const draft = submission();
    draft.structure.participants[0].opinion_links.push({
      opinion_id: "o1",
      relation: "joined_in_part",
      evidence: anchored("Alpha J.:", "recipients need the same protection."),
    });
    expect(compileSubmission(draft, material).errors).toContain(
      "structure.participants[0].opinion_links[1]: participant has more than one relationship to o1",
    );
  });

  it("has no issue-number layer in schemas, extraction prompts, gold, or semantic judgment", () => {
    const compiled = compileSubmission(submission(), material);
    const gold: GoldRecord = {
      contract_version: CASE_TREATMENT_CONTRACT_VERSION,
      document_id: material.document_id,
      citation: material.citation,
      source_sha256: "fixture",
      annotation: submission(),
    };
    const surfaces = [
      JSON.stringify(submissionOutputSchema(sourceLines.length)),
      JSON.stringify(analysisOutputSchema(sourceLines.length)),
      JSON.stringify(gold),
      oneStagePrompt(material),
      JSON.stringify(semanticView(compiled)),
      semanticJudgePrompt(compiled, compiled),
    ];
    for (const surface of surfaces) expect(surface).not.toMatch(/\bissue(?:s|_number)?\b/iu);
  });

  it("emits structured-output schemas accepted by the Codex Responses API", () => {
    const schemas = [
      submissionOutputSchema(sourceLines.length),
      analysisOutputSchema(sourceLines.length),
    ];
    for (const schema of schemas) expect(JSON.stringify(schema)).not.toContain('"uniqueItems"');
  });

  it("keeps semantic judgment on legal treatment rather than mechanical structure", () => {
    const compiled = compileSubmission(submission(), material);
    const view = semanticView(compiled);
    const prompt = semanticJudgePrompt(compiled, compiled);
    expect(Object.keys(view!)).toEqual(["procedural_relationships", "treatments"]);
    expect(view!.treatments[0].treatment_id).toBe("t1");
    expect(view!.treatments[0].cited_decision).toBe("Prior v. Example, 2020 SCC 1");
    expect(view!.treatments[0]).not.toHaveProperty("majority_support");
    expect(JSON.stringify(view)).not.toMatch(/boundary|panel_evidence|opinion_links/u);
    expect(prompt).not.toMatch(/deterministic|source anchors|panel rosters|vote arithmetic/u);
    expect(Object.keys(SEMANTIC_JUDGE_SCHEMA.properties)).toEqual([
      "treatment_grades",
      "extra_candidate_treatments",
      "procedural_relationship_grades",
      "extra_candidate_relationships",
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
      procedural_relationship_grades: [],
      extra_candidate_relationships: [],
    };
    expect(semanticJudgeResultErrors(compiled, compiled, grade)).toEqual([]);
    expect(semanticJudgeScore(grade)).toMatchObject({
      treatment: { items: 1, earned: 1, score: 1 },
      overall: { items: 1, earned: 1, score: 1 },
      passed: true,
      major_errors: 0,
      passing_threshold: 0.8,
    });
    expect(semanticJudgeScore({
      ...grade,
      treatment_grades: [
        ...Array.from({ length: 9 }, (_, index) => ({
          reference_treatment_id: `gt${index + 1}`,
          candidate_treatment_ids: [`ct${index + 1}`],
          verdict: "pass",
          aspects: [],
          explanation: null,
        })),
        {
          reference_treatment_id: "gt10",
          candidate_treatment_ids: [],
          verdict: "major_error",
          aspects: ["coverage"],
          explanation: "Missing treatment.",
        },
      ],
    })).toMatchObject({ overall: { score: 0.9 }, major_errors: 1, passed: false });
  });

  it("grades procedural relationships with the same pass, minor, and major contract", () => {
    const draft = submission();
    draft.analysis.procedural_relationships.push({
      cited_decision: "Prior v. Example, 2020 SCC 1",
      identifying_block: block("Prior v. Example, 2020 SCC 1"),
      description: "The appeal is dismissed.",
      evidence_blocks: [block("The appeal is dismissed.")],
      actions: [{
        action: "affirmed",
        affected_part: null,
        evidence_blocks: [block("The appeal is dismissed.")],
      }],
    });
    const compiled = compileSubmission(draft, material);
    const pass = {
      treatment_grades: [{
        reference_treatment_id: "gt1", candidate_treatment_ids: ["ct1"],
        verdict: "pass", aspects: [], explanation: null,
      }],
      extra_candidate_treatments: [],
      procedural_relationship_grades: [{
        reference_relationship_id: "gr1", candidate_relationship_ids: ["cr1"],
        verdict: "pass", aspects: [], explanation: null,
      }],
      extra_candidate_relationships: [],
    };
    expect(semanticJudgeResultErrors(compiled, compiled, pass)).toEqual([]);
    expect(semanticJudgeScore(pass)).toMatchObject({
      treatment: { score: 1 }, procedural_relationship: { score: 1 }, overall: { score: 1 }, passed: true,
    });
    expect(semanticJudgeScore({
      ...pass,
      procedural_relationship_grades: [{
        reference_relationship_id: "gr1", candidate_relationship_ids: ["cr1"],
        verdict: "minor_error", aspects: ["affected_part"], explanation: "The affected part is imprecise.",
      }],
    })).toMatchObject({ procedural_relationship: { score: 0.5 }, overall: { score: 0.75 }, passed: false });
    expect(semanticJudgeScore({
      ...pass,
      procedural_relationship_grades: [{
        reference_relationship_id: "gr1", candidate_relationship_ids: [],
        verdict: "major_error", aspects: ["coverage"], explanation: "The relationship is missing.",
      }],
    })).toMatchObject({ procedural_relationship: { score: 0 }, major_errors: 1, passed: false });
  });

  it("can judge preserved legal content despite mechanical locator errors", () => {
    const reference = compileSubmission(submission(), material);
    const draft = submission();
    draft.analysis.treatments[0].evidence_blocks[0] = "p99";
    const invalid = compileSubmission(draft, material);
    expect(invalid.ok).toBe(false);
    expect(semanticView(invalid)).toBeNull();
    expect(semanticDraftView(invalid, "c")?.treatments[0]).toMatchObject({
      treatment_id: "ct1",
      proposition: draft.analysis.treatments[0].proposition,
      treatment: draft.analysis.treatments[0].treatment,
    });
    expect(semanticJudgePrompt(reference, invalid, true)).toContain("[CANDIDATE ANSWER]");
    const grade = {
      treatment_grades: [{
        reference_treatment_id: "gt1",
        candidate_treatment_ids: ["ct1"],
        verdict: "pass",
        aspects: [],
        explanation: null,
      }],
      extra_candidate_treatments: [],
      procedural_relationship_grades: [],
      extra_candidate_relationships: [],
    };
    expect(semanticJudgeResultErrors(reference, invalid, grade, true)).toEqual([]);
  });

  it("retains host-derived opinion attribution when another draft item is invalid", () => {
    const draft = submission();
    delete draft.analysis.treatments[0].opinion_id;
    delete draft.analysis.treatments[0].supporting_passages;
    (draft.analysis.decision_mentions as unknown[]).push({});
    const invalid = compileSubmission(draft, material, "simple");
    expect(invalid.ok).toBe(false);
    expect(invalid.analysis?.compiled).not.toBeNull();
    expect(semanticDraftView(invalid, "c")?.treatments[0].treating_opinion).toBe("Alpha J.");
  });
});
