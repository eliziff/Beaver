import assert from "node:assert/strict";
import { it } from "vitest";

import {
  CASE_TARGET_MVP_SCHEMA_EXTENSION,
  detectCaseTargetOccurrences,
  footnoteReferenceContext,
  resolveCaseTargetMvp,
  type ModelOpinionIssuePosition,
  type ModelTargetMention,
} from "./caseTargetMvp";

it("permits empty issue maps and case-level direct history without weakening opinion-linked fields", () => {
  assert.equal(CASE_TARGET_MVP_SCHEMA_EXTENSION.case_issues.minItems, 0);
  assert.equal(CASE_TARGET_MVP_SCHEMA_EXTENSION.opinion_issue_positions.minItems, 0);
  assert.deepEqual(CASE_TARGET_MVP_SCHEMA_EXTENSION.target_direct_history.items.properties.opinion_id.type, ["string", "null"]);
  assert.equal(CASE_TARGET_MVP_SCHEMA_EXTENSION.partial_issue_joins.items.properties.opinion_id.type, "string");
  assert.equal(CASE_TARGET_MVP_SCHEMA_EXTENSION.target_treatments.items.properties.opinion_id.type, "string");
  assert.deepEqual(CASE_TARGET_MVP_SCHEMA_EXTENSION.target_mentions.items.required, [
    "id", "occurrence_id", "opinion_id", "target_identity", "source_origin", "voice", "case_issue_ids",
  ]);
});

it("pre-registers conservative case-name mentions without duplicating a decorated citation", () => {
  const text = [
    "Cases Cited\nSattva Capital Corp. v. Creston Moly Corp., 2014 SCC 53.\n",
    "[1] The appellant relies on Sattva.\n",
    "[2] We follow Sattva Capital on contractual interpretation.\n",
  ].join("");
  const occurrences = detectCaseTargetOccurrences(text, {
    citation: "2014 SCC 53",
    citationAliases: [],
    name: "Sattva Capital Corp. v. Creston Moly Corp.",
  });
  assert.deepEqual(occurrences.map(({ id, kind, quote }) => ({ id, kind, quote })), [
    { id: "tm1", kind: "citation", quote: "2014 SCC 53" },
    { id: "tn1", kind: "case_name", quote: "Sattva" },
    { id: "tn2", kind: "case_name", quote: "Sattva Capital" },
  ]);
});

it("requires legal-reference syntax for short names while retaining a full style of cause", () => {
  const text = [
    "[1] Mr. Crocco filed an affidavit. Crocco then testified.\n",
    "[2] The ruling was indistinguishable from Crocco (para. 12).\n",
    "[3] That route would be an end run around Crocco (para. 26).\n",
    "[4] It had not been shown that Crocco was \u201cmanifestly wrong\u201d.\n",
    "[5] On the basis of Crocco, the claim was barred.\n",
    "[6] Crocco v Ontario at para. 15; Smith v Jones, 2008 FCA 2, concerned another issue.\n",
  ].join("");
  const occurrences = detectCaseTargetOccurrences(text, {
    citation: "2007 FCA 1",
    citationAliases: [],
    name: "Crocco v. Ontario",
  });
  assert.deepEqual(occurrences.map(({ id, kind, quote }) => ({ id, kind, quote })), [
    { id: "tn1", kind: "case_name", quote: "Crocco" },
    { id: "tn2", kind: "case_name", quote: "Crocco" },
    { id: "tn3", kind: "case_name", quote: "Crocco" },
    { id: "tn4", kind: "case_name", quote: "Crocco" },
    { id: "tn5", kind: "case_name", quote: "Crocco v Ontario" },
  ]);
});

it("retains an exact two-word case title without demanding a surrounding cue", () => {
  const occurrences = detectCaseTargetOccurrences("The result in Re Spectrum remains controversial.", {
    citation: "[2000] 1 SCR 1",
    citationAliases: [],
    name: "Re Spectrum",
  });
  assert.deepEqual(occurrences.map(({ kind, quote }) => ({ kind, quote })), [
    { kind: "case_name", quote: "Re Spectrum" },
  ]);
});

it("retains a supplied external reporter citation outside the Canadian citation grammar", () => {
  const occurrences = detectCaseTargetOccurrences("The court did not follow Fairclough, [1951] 2 All E.R. 834.", {
    citation: "[1951] 2 All E.R. 834",
    citationAliases: [],
    name: "Fairclough v. Whipp",
  });
  assert.deepEqual(occurrences.map(({ id, kind, quote }) => ({ id, kind, quote })), [
    { id: "tm1", kind: "citation", quote: "[1951] 2 All E.R. 834" },
  ]);
});

it("does not turn a generic government party or an incompatible reporter citation into the target", () => {
  const generic = detectCaseTargetOccurrences("The claimant arrived in Canada yesterday.", {
    citation: "2022 FCA 105",
    citationAliases: [],
    name: "Canada v. Chu",
  });
  assert.deepEqual(generic, []);

  const incompatible = detectCaseTargetOccurrences([
    "Abbott Laboratories v. Canada, 2007 FCA 187, addressed a different patent.",
    "In Abbott, the court discussed the burden of proof.",
  ].join("\n"), {
    citation: "2007 FCA 153",
    citationAliases: [],
    name: "Abbott Laboratories v. Canada",
  });
  assert.deepEqual(incompatible.map(({ id, kind, quote }) => ({ id, kind, quote })), [
    { id: "tn1", kind: "case_name", quote: "Abbott" },
  ]);

  const reporterLabel = detectCaseTargetOccurrences("The earlier case was affirmed, 2007 FCA 153 [Abbott Laboratories 2005]. Abbott Laboratories 2005 was then discussed.", {
    citation: "2007 FCA 153",
    citationAliases: [],
    name: "Abbott Laboratories v. Canada",
  });
  assert.deepEqual(reporterLabel.map(({ id, kind, quote }) => ({ id, kind, quote })), [
    { id: "tm1", kind: "citation", quote: "2007 FCA 153" },
  ]);
});

const o1Text = [
  "A J.\n",
  "Issue one begins. Applying 2010 SCC 1, the target rule is followed on notice. On these facts, that rule resolves notice. Issue one ends.\n",
  "Issue two begins. Damages are unavailable. Issue two ends.\n",
  "The target decision's order is varied.\n",
  "B J. joins these reasons on the notice issue only.\n",
].join("");
const o2Text = [
  "C J.\n",
  "Issue one begins in dissent. I would distinguish 2010 SCC 1 on notice. Issue one dissent ends.\n",
].join("");
const sourceText = o1Text + o2Text;
const opinions = [
  { id: "o1", start: 0, end: o1Text.length, text: o1Text },
  { id: "o2", start: o1Text.length, end: sourceText.length, text: o2Text },
];

function position(args: {
  id: string;
  issue: string;
  opinion: string;
  answerGroup: string;
  answer: string;
  spanStart: string;
  spanEnd: string;
  evidence: string;
}): ModelOpinionIssuePosition {
  return {
    id: args.id,
    case_issue_id: args.issue,
    opinion_id: args.opinion,
    answer_group_id: args.answerGroup,
    answer: args.answer,
    relation_to_disposition: "dispositive",
    discussion_spans: [{ start_quote: args.spanStart, end_quote: args.spanEnd }],
    answer_evidence_ids: [`${args.id}e1`],
    basis_and_limits: [{
      id: `${args.id}b1`,
      kind: "application",
      text: args.answer,
      evidence_ids: [`${args.id}e1`],
    }],
    evidence: [{ id: `${args.id}e1`, quote: args.evidence, voice: "current_court" }],
  };
}

function validInput() {
  const firstCitation = sourceText.indexOf("2010 SCC 1");
  const secondCitation = sourceText.indexOf("2010 SCC 1", firstCitation + 1);
  return {
    sourceText,
    panelComplete: true,
    opinions,
    participants: [
      { name: "A J.", opinion_links: [{ opinion_id: "o1", relation: "authors" as const }], result_only: false },
      { name: "B J.", opinion_links: [{ opinion_id: "o1", relation: "joins_in_part" as const }], result_only: false },
      { name: "C J.", opinion_links: [{ opinion_id: "o2", relation: "authors" as const }], result_only: false },
    ],
    occurrences: [
      { id: "tm1", kind: "citation" as const, quote: "2010 SCC 1", start: firstCitation, end: firstCitation + 10, citationKey: "2010scc1", linkedContext: null },
      { id: "tm2", kind: "citation" as const, quote: "2010 SCC 1", start: secondCitation, end: secondCitation + 10, citationKey: "2010scc1", linkedContext: null },
    ],
    caseIssues: [
      { id: "i1", question: "Does the target rule govern notice?", parent_issue_id: null },
      { id: "i2", question: "Are damages available as a remedy?", parent_issue_id: null },
    ],
    opinionPositions: [
      position({
        id: "p1", issue: "i1", opinion: "o1", answerGroup: "a1", answer: "Yes.",
        spanStart: "Issue one begins.", spanEnd: "Issue one ends.",
        evidence: "the target rule is followed on notice.",
      }),
      position({
        id: "p2", issue: "i2", opinion: "o1", answerGroup: "a1", answer: "No.",
        spanStart: "Issue two begins.", spanEnd: "Issue two ends.",
        evidence: "Damages are unavailable.",
      }),
      position({
        id: "p3", issue: "i1", opinion: "o2", answerGroup: "a2", answer: "No.",
        spanStart: "Issue one begins in dissent.", spanEnd: "Issue one dissent ends.",
        evidence: "I would distinguish 2010 SCC 1 on notice.",
      }),
    ],
    partialIssueJoins: [{
      participant_name: "B J.",
      opinion_id: "o1",
      case_issue_ids: ["i1"],
      evidence_quotes: ["B J. joins these reasons on the notice issue only."],
    }],
    targetMentions: [
      {
        id: "m1", occurrence_id: "tm1", opinion_id: "o1", target_identity: "target" as ModelTargetMention["target_identity"],
        source_origin: "court_words" as const, voice: "current_court" as const, case_issue_ids: ["i1"],
      },
      {
        id: "m2", occurrence_id: "tm2", opinion_id: "o2", target_identity: "target" as ModelTargetMention["target_identity"],
        source_origin: "court_words" as const, voice: "current_court" as const, case_issue_ids: ["i1"],
      },
    ],
    targetTreatments: [
      {
        id: "t1", mention_ids: ["m1"], opinion_id: "o1", case_issue_ids: ["i1"],
        attribution: "current_court" as const, label: "followed" as const, scope: "specific_proposition" as const,
        evidence_quote: "Applying 2010 SCC 1, the target rule is followed on notice.",
        target_proposition_as_characterized: "the target rule",
      },
      {
        id: "t2", mention_ids: ["m2"], opinion_id: "o2", case_issue_ids: ["i1"],
        attribution: "current_court" as const, label: "distinguished" as const, scope: "specific_proposition" as const,
        evidence_quote: "I would distinguish 2010 SCC 1 on notice.",
        target_proposition_as_characterized: null,
      },
    ],
    targetDirectHistory: [],
  };
}

it("keeps silence, partial joins, and competing issue answers distinct", () => {
  const result = resolveCaseTargetMvp(validInput());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert(result.judge_issue_positions.some((row) => row.participant_name === "B J." && row.case_issue_id === "i1"));
  assert(!result.judge_issue_positions.some((row) => row.participant_name === "B J." && row.case_issue_id === "i2"));
  assert(!result.judge_issue_positions.some((row) => row.participant_name === "C J." && row.case_issue_id === "i2"));
  assert.equal(result.issue_authority.find((row) => row.case_issue_id === "i1")?.status, "majority_supported");
  assert.equal(result.issue_authority.find((row) => row.case_issue_id === "i2")?.status, "plurality_supported");
  assert.deepEqual(result.flat_treatment.controlling_labels, ["followed"]);
  assert.equal(result.flat_treatment.status, "complete");
  assert.equal(result.flat_treatment.flags.aggregation_safe, true);
  assert.equal(result.flat_treatment.flags.target_occurrences_complete, true);
  assert.deepEqual(result.flat_treatment.other_judicial_labels, ["distinguished"]);
  assert.equal(result.flat_treatment.flags.controlling_relied_on, true);
  assert.equal(result.flat_treatment.flags.controlling_adverse, false);
  assert.equal(result.flat_treatment.flags.noncontrolling_judicial_adverse, true);
});

it("does not promote treatment to controlling when panel completeness is unproved", () => {
  const input = validInput();
  input.panelComplete = false;
  const result = resolveCaseTargetMvp(input);
  assert(result.issue_authority.every(({ status }) => status === "authority_ambiguous"));
  assert.deepEqual(result.flat_treatment.controlling_labels, []);
  assert.equal(result.flat_treatment.flags.aggregation_safe, false);
});

it("rejects an omitted deterministic target occurrence", () => {
  const input = validInput();
  input.targetMentions.pop();
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error === "missing target occurrence tm2"));
});

it("rejects a target mention whose host-owned occurrence ID is unknown", () => {
  const input = validInput();
  input.targetMentions[0].occurrence_id = "missing";
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("references unknown occurrence missing")));
  assert(!result.target_mentions.some(({ id }) => id === "m1"));
});

it("receipts non-target assessments without admitting them to treatment or flat authority", () => {
  const input = validInput();
  input.targetMentions[0].target_identity = "not_target";
  input.targetMentions[0].case_issue_ids = [];
  input.targetDirectHistory.push({
    id: "h1",
    mention_ids: ["m1"],
    opinion_id: "o1",
    label: "varied",
    evidence_quote: "The target decision's order is varied.",
  });
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert.equal(result.target_mentions.find(({ id }) => id === "m1")?.target_identity, "not_target");
  assert.equal(result.target_mentions.find(({ id }) => id === "m1")?.source_origin, "court_words");
  assert(!result.target_treatments.some(({ id }) => id === "t1"));
  assert(!result.target_direct_history.some(({ id }) => id === "h1"));
  assert(!result.flat_treatment.controlling_labels.includes("followed"));
  assert.equal(result.flat_treatment.flags.target_occurrences_complete, true);
  assert(result.rejections.target_treatments.some(({ treatment_id, errors }) =>
    treatment_id === "t1" && errors.some((error) => error.includes("not_target assessment"))
  ));
  assert(result.rejections.target_direct_history.some(({ history_id, errors }) =>
    history_id === "h1" && errors.some((error) => error.includes("not_target assessment"))
  ));
});

it("drops unused evidence and recovers a uniquely defined cross-position evidence ID", () => {
  const input = validInput();
  const secondEvidence = input.opinionPositions[1].evidence[0];
  input.opinionPositions[0].evidence.push(secondEvidence);
  input.opinionPositions[1].evidence = [];
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.deterministic_normalization, {
    dropped_unreferenced: 1,
    recovered_cross_position: 1,
    corrected_mention_opinion_ids: 0,
    corrected_treatment_opinion_ids: 0,
    corrected_history_opinion_ids: 0,
  });
  assert.equal(result.opinion_issue_positions.find(({ id }) => id === "p2")?.evidence[0].id, "p2e1");
});

it("does not let a rejected mention or its treatment leak into the accepted graph", () => {
  const input = validInput();
  input.targetMentions[0].case_issue_ids = ["missing"];
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(!result.target_mentions.some(({ id }) => id === "m1"));
  assert(!result.target_treatments.some(({ id }) => id === "t1"));
  assert(!result.flat_treatment.controlling_labels.includes("followed"));
  assert.equal(result.flat_treatment.status, "partial");
  assert.equal(result.flat_treatment.flags.aggregation_safe, false);
  assert.equal(result.flat_treatment.flags.target_occurrences_complete, false);
  assert.equal(result.flat_treatment.flags.mention_only, false);
  assert(result.rejections.target_mentions.some(({ mention_id }) => mention_id === "m1"));
  assert(result.rejections.target_treatments.some(({ treatment_id }) => treatment_id === "t1"));
});

it("replaces model-supplied mention and treatment opinion IDs with exact containment", () => {
  const input = validInput();
  input.targetMentions[0].opinion_id = "o2";
  input.targetTreatments[0].opinion_id = "o2";
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, true);
  assert.equal(result.target_mentions.find(({ id }) => id === "m1")?.opinion_id, "o1");
  assert.equal(result.target_treatments.find(({ id }) => id === "t1")?.opinion_id, "o1");
  assert.equal(result.deterministic_normalization.corrected_mention_opinion_ids, 1);
  assert.equal(result.deterministic_normalization.corrected_treatment_opinion_ids, 1);
});

it("does not use an invalid partial joinder to count judicial support", () => {
  const input = validInput();
  input.partialIssueJoins[0].evidence_quotes = ["B J. joins everything."];
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(!result.judge_issue_positions.some(({ participant_name }) => participant_name === "B J."));
  assert.equal(result.issue_authority.find(({ case_issue_id }) => case_issue_id === "i1")?.status, "authority_ambiguous");
  assert.equal(result.counts.accepted_partial_issue_joins, 0);
});

it("retains a proved panel majority despite one unresolved participant", () => {
  const input = validInput();
  input.participants[2].opinion_links = [];
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.issue_authority.find(({ case_issue_id }) => case_issue_id === "i1")?.status, "majority_supported");
  assert.equal(result.issue_authority.find(({ case_issue_id }) => case_issue_id === "i1")?.controlling_answer_group_id, "a1");
});

it("detects parent issue cycles", () => {
  const input = validInput();
  input.caseIssues[0].parent_issue_id = "i2";
  input.caseIssues[1].parent_issue_id = "i1";
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("parent issue cycle")));
  assert.equal(result.flat_treatment.flags.aggregation_safe, false);
});

it("accepts direct-history evidence elsewhere in the same opinion", () => {
  const input = validInput();
  input.targetDirectHistory.push({
    id: "h1",
    mention_ids: ["m1"],
    opinion_id: "o1",
    label: "varied",
    evidence_quote: "The target decision's order is varied.",
  });
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.flat_treatment.direct_history_labels, ["varied"]);
  assert.equal(result.counts.accepted_target_direct_history, 1);
});

it("accepts normalized propositions and nonlocal treatment evidence in the linked opinion", () => {
  const input = validInput();
  input.targetTreatments[0].evidence_quote = "On these facts, that rule resolves notice.";
  input.targetTreatments[0].target_proposition_as_characterized =
    "The target's notice rule resolves the issue on these facts.";
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, true);
  const treatment = result.target_treatments.find(({ id }) => id === "t1");
  assert.equal(treatment?.proposition, "The target's notice rule resolves the issue on these facts.");
  assert.equal(treatment?.evidence_contains_linked_mention, false);
});

it("links a citation-only endnote to one unambiguous inline footnote marker", () => {
  const text = "[8] Numbered paragraph.\nThe court adopts the rule.[8]\n[8] Target v. Case, 2010 SCC 1";
  const bodyEnd = text.indexOf("\n[8] Target");
  const citationStart = text.indexOf("2010 SCC 1");
  assert.deepEqual(footnoteReferenceContext(text, citationStart, bodyEnd), {
    kind: "footnote_reference",
    quote: "[8]",
    start: text.indexOf("[8]", text.indexOf("adopts")),
    end: text.indexOf("[8]", text.indexOf("adopts")) + 3,
  });
  const ambiguous = "[8] Numbered paragraph.\nThe court adopts the rule.[8] The court repeats it.[8]\n[8] Target v. Case, 2010 SCC 1";
  assert.equal(footnoteReferenceContext(
    ambiguous,
    ambiguous.indexOf("2010 SCC 1"),
    ambiguous.indexOf("\n[8] Target"),
  ), null);
});

it("still rejects treatment evidence from outside the linked opinion", () => {
  const input = validInput();
  input.targetTreatments[0].evidence_quote = "I would distinguish 2010 SCC 1 on notice.";
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, false);
  assert(result.rejections.target_treatments.some(({ treatment_id, errors }) =>
    treatment_id === "t1" && errors.some((error) => error.includes("missing"))
  ));
});

it("accepts case-level direct history proved in provider metadata", () => {
  const input = validInput();
  const header = "Judicial review note: 2010 SCC 1 was reversed.\n";
  input.sourceText = header + input.sourceText;
  input.opinions = input.opinions.map((opinion) => ({
    ...opinion,
    start: opinion.start + header.length,
    end: opinion.end + header.length,
  }));
  input.occurrences = [
    {
      id: "tm0",
      kind: "citation",
      quote: "2010 SCC 1",
      start: header.indexOf("2010 SCC 1"),
      end: header.indexOf("2010 SCC 1") + 10,
      citationKey: "2010scc1",
      linkedContext: null,
    },
    ...input.occurrences.map((occurrence) => ({
      ...occurrence,
      start: occurrence.start + header.length,
      end: occurrence.end + header.length,
    })),
  ];
  (input.targetMentions as ModelTargetMention[]).unshift({
    id: "m0",
    occurrence_id: "tm0",
    opinion_id: null,
    target_identity: "target",
    source_origin: "metadata",
    voice: "procedural_recounting",
    case_issue_ids: [],
  });
  input.targetDirectHistory.push({
    id: "h1",
    mention_ids: ["m0"],
    opinion_id: null,
    label: "reversed",
    evidence_quote: "Judicial review note: 2010 SCC 1 was reversed.",
  });
  const result = resolveCaseTargetMvp(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.flat_treatment.direct_history_labels, ["reversed"]);
  assert.equal(result.target_direct_history[0].opinion_id, null);
  input.targetDirectHistory[0].opinion_id = "o1";
  const normalized = resolveCaseTargetMvp(input);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.target_direct_history[0].opinion_id, null);
  assert.equal(normalized.deterministic_normalization.corrected_history_opinion_ids, 1);
});
