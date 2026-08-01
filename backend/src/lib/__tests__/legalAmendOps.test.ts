import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyAmendOps,
  consolidateAmendment,
  deleteProvisionAndRenumberSiblings,
  parseAmendmentInstructions,
} from "../legalAmendOps";

const STATUTE = [
  "PART I",
  "INTERPRETATION",
  "",
  "1. In this Act, “Minister” means the Minister of Justice.",
  "",
  "5. (1) A person may apply to the Minister for a permit.",
  "",
  "(2) The Minister shall respond within sixty days after the application.",
  "",
  "8. This Act binds His Majesty in right of Canada.",
].join("\n");

const AGREEMENT = [
  "ARTICLE I",
  "COVENANTS",
  "",
  "Section 1.01 Payment Terms. The Borrower shall pay each invoice within " +
    "thirty days of demand by the Administrative Agent.",
  "",
  "Section 1.02 Notices. Notices shall be delivered to the Administrative " +
    "Agent at its Toronto office, with a copy to the Administrative Agent " +
    "at its New York office.",
].join("\n");

describe("parseAmendmentInstructions", () => {
  it("compiles US cut-and-bite substitute clauses", () => {
    const { ops, unparsed } = parseAmendmentInstructions(
      "Section 1.01 of the Credit Agreement is amended by striking " +
        "“thirty days” and inserting “sixty days”.",
    );
    expect(unparsed).toEqual([]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "substitute_text",
      target: "sec1.01",
      oldText: "thirty days",
      newText: "sixty days",
    });
  });

  it("threads in-subsection context across a dash list", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 5 of the Act is amended— (1) in subsection (1), by striking " +
        "“person” and inserting “corporation”; and (2) in subsection (2), " +
        "by striking “sixty” and inserting “ninety”.",
    );
    expect(ops.map((op) => [op.kind, op.target, op.oldText])).toEqual([
      ["substitute_text", "sec5(1)", "person"],
      ["substitute_text", "sec5(2)", "sixty"],
    ]);
  });

  it("compiles Canadian replace-style and repeal heads", () => {
    const { ops } = parseAmendmentInstructions(
      "Subsection 5(1) of the Act is replaced by the following:\n\n" +
        "“(1) A corporation may apply to the Minister for a licence.”\n\n" +
        "Section 8 of the Act is repealed.",
    );
    expect(ops.map((op) => [op.kind, op.target])).toEqual([
      ["replace_provision", "sec5(1)"],
      ["repeal_provision", "sec8"],
    ]);
    expect(ops[0].newText).toContain("apply to the Minister for a licence");
  });

  it("compiles striking-out/substituting (older Canadian) as substitute", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 1 of the Act is amended by striking out “Minister of " +
        "Justice” and substituting “Minister of Public Safety”.",
    );
    expect(ops[0]).toMatchObject({
      kind: "substitute_text",
      oldText: "Minister of Justice",
      newText: "Minister of Public Safety",
    });
  });

  it("compiles add-at-end, add-after, and every-occurrence flags", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 5 of the Act is amended by adding at the end the following: " +
        "“(3) A refusal must include reasons.”\n\n" +
        "Section 1.02 of the Agreement is amended by striking “Administrative " +
        "Agent” each place it appears and inserting “Collateral Agent”.",
    );
    expect(ops[0]).toMatchObject({ kind: "add_at_end", target: "sec5" });
    expect(ops[1]).toMatchObject({
      kind: "substitute_text",
      everyOccurrence: true,
    });
  });

  it("captures unquoted Canadian replacement blocks with furniture trimmed", () => {
    const { ops, unparsed } = parseAmendmentInstructions(
      [
        "2 Subparagraph 42(a)(i) of the Bills of Exchange Act is replaced " +
          "by the following:",
        "",
        "(i) Sundays, New Year's Day, Good Friday and Christmas Day,",
        "",
        "R.S., c. I-21Interpretation Act",
        "3 Subsection 27(5) of the Interpretation Act is replaced by the following:",
        "",
        "Marginal note:After specified day",
        "(5) Where anything is to be done within a time after a specified " +
          "day, the time does not include that day.",
      ].join("\n"),
    );
    expect(unparsed).toEqual([]);
    expect(ops.map((op) => [op.kind, op.target])).toEqual([
      ["replace_provision", "sec42(a)(i)"],
      ["replace_provision", "sec27(5)"],
    ]);
    // Block 1 stops at the chapter note; marginal-note furniture dropped.
    expect(ops[0].newText).toBe(
      "(i) Sundays, New Year's Day, Good Friday and Christmas Day,",
    );
    expect(ops[1].newText).toContain("the time does not include that day");
    expect(ops[1].newText).not.toContain("Marginal note");
  });

  it("keeps quoted blocks whole even when they contain ' by ' and seams", () => {
    const { ops, unparsed } = parseAmendmentInstructions(
      "Section 3 of the Act is amended by striking subsection (u) and " +
        "inserting the following:\n\n" +
        "“(u) Thrifty Plan.—\n\n" +
        "“(1) In general.—The term ‘plan’ means the diet established by " +
        "the Secretary in subsection (b).”\n\n" +
        "Section 8 of the Act is repealed.",
    );
    expect(unparsed).toEqual([]);
    expect(ops[0].kind).toBe("replace_provision");
    // The block's interior " by " must not split it into fake clauses,
    // and the capture must cross the “…“ paragraph seam to the final ”.
    expect(ops[0].newText).toContain("established by the Secretary");
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ kind: "repeal_provision", target: "sec8" });
  });

  it("refuses definition-scoped heads instead of replacing whole sections", () => {
    const { ops, unparsed } = parseAmendmentInstructions(
      "4 The definition general holiday in section 166 of the Canada " +
        "Labour Code is replaced by the following:\n\n" +
        "general holiday means New Year's Day and Christmas Day;",
    );
    expect(ops).toEqual([]);
    expect(unparsed[0].reason).toContain("scoped amendment");
  });

  it("refuses portion/heading-scoped heads instead of guessing", () => {
    const { ops, unparsed } = parseAmendmentInstructions(
      "The portion of subsection 5(1) of the Act before paragraph (a) is " +
        "replaced by the following:\n\n“(1) An applicant”",
    );
    expect(ops).toEqual([]);
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0].reason).toContain("scoped amendment");
  });

  it("parses redesignation with a new label", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 5 of the Act is amended by redesignating subsection (2) as " +
        "subsection (3).",
    );
    expect(ops[0]).toMatchObject({
      kind: "redesignate",
      target: "sec5(2)",
      newLabel: "(3)",
    });
  });
});

describe("parseAmendmentInstructions (français)", () => {
  // Verbatim from L.C. 2021, ch. 11 (laws-lois.justice.gc.ca, TexteComplet),
  // the French twin of the English act the EN grammar was verified on.
  const SC_2021_C11_FR = [
    "L.R., ch. B-4Loi sur les lettres de change",
    "2 Le sous-alinéa 42a)(i) de la Loi sur les lettres de change est " +
      "remplacé par ce qui suit :",
    "",
    "(i) les dimanches, le jour de l’an, le vendredi saint, la fête de " +
      "Victoria, la fête du Canada, la fête du Travail, la Journée nationale " +
      "de la vérité et de la réconciliation, qui a lieu le 30 septembre, le " +
      "jour du Souvenir et le jour de Noël,",
    "",
    "L.R., ch. I-21Loi d’interprétation",
    "3 Le passage de la définition de jour férié précédant l’alinéa a), au " +
      "paragraphe 35(1) de la Loi d’interprétation, est remplacé par ce qui " +
      "suit :",
    "jour fériéjour férié Outre les dimanches, le 1er janvier, le vendredi " +
      "saint, le lundi de Pâques, le jour de Noël, l’anniversaire du " +
      "souverain régnant ou le jour fixé par proclamation pour sa " +
      "célébration, la fête de Victoria, la fête du Canada, le premier lundi " +
      "de septembre, désigné comme fête du Travail, la Journée nationale de " +
      "la vérité et de la réconciliation, qui a lieu le 30 septembre, le 11 " +
      "novembre ou jour du Souvenir, tout jour fixé par proclamation comme " +
      "jour de prière ou de deuil national ou jour de réjouissances ou " +
      "d’action de grâces publiques :",
    "",
    "L.R., ch. L-2Code canadien du travail",
    "4 La définition de jours fériés, à l’article 166 du Code canadien du " +
      "travail, est remplacée par ce qui suit :",
    "jours fériésjours fériés Le 1er janvier, le vendredi saint, la fête de " +
      "Victoria, la fête du Canada, la fête du Travail, la Journée nationale " +
      "de la vérité et de la réconciliation, qui a lieu le 30 septembre, le " +
      "jour de l’Action de grâces, le jour du Souvenir, le jour de Noël et " +
      "le lendemain de Noël; s’entend également de tout jour de substitution " +
      "fixé dans le cadre de l’article 195. (general holiday)",
    "",
    "5 Le paragraphe 193(2) de la même loi est remplacé par ce qui suit :",
    "Note marginale :Jours fériés tombant un samedi ou un dimanche",
    "(2) Sous réserve des autres dispositions de la présente section, " +
      "l’employé a droit à un congé payé le jour ouvrable précédant ou " +
      "suivant le 1er janvier, la fête du Canada, la Journée nationale de la " +
      "vérité et de la réconciliation, le jour du Souvenir, le jour de Noël " +
      "ou le lendemain de Noël quand ces jours fériés tombent un dimanche ou " +
      "un samedi chômé.",
    "",
    "Entrée en vigueur",
    "Note marginale :Deux mois après la sanction",
    "6 La présente loi entre en vigueur le jour qui, dans le deuxième mois " +
      "suivant le mois de sa sanction, porte le même quantième que le jour " +
      "de sa sanction.",
  ].join("\n");

  it("compiles French replace heads and refuses scoped ones (L.C. 2021, ch. 11)", () => {
    const { ops, unparsed } = parseAmendmentInstructions(SC_2021_C11_FR);
    expect(ops.map((op) => [op.kind, op.target])).toEqual([
      ["replace_provision", "sec42(a)(i)"],
      ["replace_provision", "sec193(2)"],
    ]);
    // Portion-scoped (art. 3) and definition-scoped (art. 4) must refuse.
    expect(unparsed).toHaveLength(2);
    for (const refusal of unparsed) {
      expect(refusal.reason).toContain("scoped amendment");
    }
    // Block 1 stops at the "L.R., ch. I-21" chapter note.
    expect(ops[0].newText).toBe(
      "(i) les dimanches, le jour de l’an, le vendredi saint, la fête de " +
        "Victoria, la fête du Canada, la fête du Travail, la Journée " +
        "nationale de la vérité et de la réconciliation, qui a lieu le 30 " +
        "septembre, le jour du Souvenir et le jour de Noël,",
    );
    // Block 5 drops "Note marginale :" furniture and stops at the
    // "Entrée en vigueur" heading.
    expect(ops[1].newText).toContain("Sous réserve des autres dispositions");
    expect(ops[1].newText).not.toContain("Note marginale");
    expect(ops[1].newText).not.toContain("Entrée en vigueur");
  });

  it("compiles French repeal heads", () => {
    const { ops } = parseAmendmentInstructions(
      "7 L’article 8 de la même loi est abrogé.",
    );
    expect(ops).toEqual([
      expect.objectContaining({ kind: "repeal_provision", target: "sec8" }),
    ]);
  });
});

describe("applyAmendOps", () => {
  it("applies a substitute inside the addressed provision only", () => {
    const { ops } = parseAmendmentInstructions(
      "Subsection 5(2) of the Act is amended by striking out “sixty days” " +
        "and substituting “ninety days”.",
    );
    const result = applyAmendOps(STATUTE, ops);
    expect(result.failures).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.text).toContain("respond within ninety days");
    expect(result.verification.oldTextGone).toBe(1);
    expect(result.verification.newTextPresent).toBe(1);
  });

  it("replaces a whole provision Canadian-style", () => {
    const { ops } = parseAmendmentInstructions(
      "Subsection 5(1) of the Act is replaced by the following:\n\n" +
        "“(1) A corporation may apply to the Minister for a licence.”",
    );
    const result = applyAmendOps(STATUTE, ops);
    expect(result.failures).toEqual([]);
    expect(result.text).toContain("corporation may apply to the Minister for a licence");
    expect(result.text).not.toContain("A person may apply");
    // (2) must survive the replacement of (1).
    expect(result.text).toContain("respond within sixty days");
  });

  it("fails loudly when the quoted text is not in the target", () => {
    const { ops } = parseAmendmentInstructions(
      "Subsection 5(1) of the Act is amended by striking out “ninety days” " +
        "and substituting “thirty days”.",
    );
    const result = applyAmendOps(STATUTE, ops);
    expect(result.applied).toEqual([]);
    expect(result.failures[0].code).toBe("old_text_not_found");
  });

  it("fails loudly on a target the skeleton cannot resolve", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 99 of the Act is repealed.",
    );
    const result = applyAmendOps(STATUTE, ops);
    expect(result.failures[0].code).toBe("target_not_found");
  });

  it("flags ambiguity instead of picking an occurrence", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 1.02 of the Agreement is amended by striking “Agent” and " +
        "inserting “Trustee”.",
    );
    const result = applyAmendOps(AGREEMENT, ops);
    expect(result.applied).toEqual([]);
    expect(result.failures[0].code).toBe("old_text_ambiguous");
  });

  it("applies every-occurrence substitutions across the target", () => {
    const { ops } = parseAmendmentInstructions(
      "Section 1.02 of the Agreement is amended by striking “Administrative " +
        "Agent” each place it appears and inserting “Collateral Agent”.",
    );
    const result = applyAmendOps(AGREEMENT, ops);
    expect(result.failures).toEqual([]);
    expect(result.applied).toHaveLength(2);
    expect(result.text.match(/Collateral Agent/gu)).toHaveLength(2);
    // Section 1.01's occurrence is outside the addressed provision.
    expect(result.text.match(/Administrative Agent/gu)).toHaveLength(1);
  });

  it("repeals a provision without touching its neighbours", () => {
    const { ops } = parseAmendmentInstructions("Section 8 of the Act is repealed.");
    const result = applyAmendOps(STATUTE, ops);
    expect(result.failures).toEqual([]);
    expect(result.text).not.toContain("binds His Majesty");
    expect(result.text).toContain("A person may apply");
  });
});

describe("consolidateAmendment", () => {
  it("runs parse + apply + verification as one gate", () => {
    const result = consolidateAmendment(
      STATUTE,
      "Section 5 of the Act is amended— (1) in subsection (2), by striking " +
        "“sixty” and inserting “ninety”; and (2) by adding at the end the " +
        "following: “(3) A refusal must include reasons.”",
    );
    expect(result.parse.unparsed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.text).toContain("within ninety days");
    expect(result.text).toContain("(3) A refusal must include reasons.");
    expect(result.verification.newTextMissing).toBe(0);
  });
});

// SC 2021, c. 24, s. 1(1) — the bare-conjunction-token shape that rides in
// most list-extending amendments (audit: 23.3% of instructions are
// add-provision family; this clause was its dominant refusal). Gold: the
// pre-amendment list reconstructed from today's CLC s. 164(1) consolidation.
describe("bare-token list re-punctuation (SC 2021, c. 24, s. 1(1))", () => {
  // Dotless head, exactly as the A2AJ consolidation prints it (the dotted
  // "164. (1)" variant is covered by the statute-style skeleton tests).
  const CHAPEAU =
    "164 (1) A judge may issue a warrant authorizing seizure of copies of a recording, a publication, a representation or any written material, if the judge is satisfied by information on oath that there are reasonable grounds to believe that";
  const PARA = (label: string, tail: string) =>
    `(${label}) the representation, written material or recording, copies of which are kept in premises within the jurisdiction of the court, ${tail}`;
  const PRE = [
    CHAPEAU,
    "",
    "(c) the publication, copies of which are kept for sale or distribution in premises within the jurisdiction of the court, is obscene, within the meaning of subsection 163(8);",
    "",
    PARA("d", "is child sexual abuse and exploitation material as defined in section 163.1; or"),
    "",
    PARA("e", "is an advertisement of sexual services."),
  ].join("\n");
  const GOLD = [
    CHAPEAU,
    "",
    "(c) the publication, copies of which are kept for sale or distribution in premises within the jurisdiction of the court, is obscene, within the meaning of subsection 163(8);",
    "",
    PARA("d", "is child sexual abuse and exploitation material as defined in section 163.1;"),
    "",
    PARA("e", "is an advertisement of sexual services; or"),
    "",
    PARA("f", "is an advertisement for conversion therapy."),
  ].join("\n");
  const INSTRUCTION = [
    "Subsection 164(1) of the Criminal Code is amended by striking out “or” at the end of paragraph (d), by adding “or” at the end of paragraph (e) and by adding the following after paragraph (e):",
    "",
    PARA("f", "is an advertisement for conversion therapy."),
  ].join("\n");

  it("compiles all three clauses without refusals", () => {
    const { ops, unparsed } = parseAmendmentInstructions(INSTRUCTION);
    expect(unparsed).toHaveLength(0);
    expect(ops.map((op) => op.kind)).toEqual([
      "strike_text",
      "append_text",
      "add_provision",
    ]);
    expect(ops[0]).toMatchObject({
      target: "sec164(1)(d)",
      oldText: "or",
      anchorLast: true,
      wholeWord: true,
    });
    expect(ops[1]).toMatchObject({ target: "sec164(1)(e)", newText: "or" });
    expect(ops[2]).toMatchObject({
      target: "sec164(1)",
      afterChild: "sec164(1)(e)",
    });
  });

  it("reproduces today's consolidation from the pre-amendment text", () => {
    const { ops } = parseAmendmentInstructions(INSTRUCTION);
    const result = applyAmendOps(PRE, ops);
    expect(result.failures).toEqual([]);
    const normalize = (t: string) => t.replace(/\s+/gu, " ").trim();
    expect(normalize(result.text)).toBe(normalize(GOLD));
  });

  it("refuses append_text on a terminal it has no rule for", () => {
    const { ops } = parseAmendmentInstructions(
      "Subsection 164(1) of the Criminal Code is amended by adding “or” at the end of paragraph (c)",
    );
    const source = [CHAPEAU, "", "(c) an unpunctuated line"].join("\n");
    const result = applyAmendOps(source, ops);
    expect(result.failures.map((f) => f.code)).toEqual(["unsupported_apply"]);
  });
});

describe("applyAmendOps: who says whether line breaks were lost", () => {
  // One physical line with the headings behind space runs — the Library
  // extraction dialect. Recovery finds 1.01-1.03; publisher-lineated text has
  // no such damage and must not be re-segmented.
  const COLLAPSED =
    "AMENDING AGREEMENT   " +
    "1.01 Term.  The term is one year, as set out in Section 1.01.   " +
    "1.02 Notices.  Notice is given as described in Section 1.02.   " +
    "1.03 Remedies.  The Agent may act under Section 1.03.";
  const instruction =
    "Section 1.02 of the Agreement is amended by striking out “as described”.";

  it("addresses the recovered reading by default", () => {
    const { ops } = parseAmendmentInstructions(instruction);
    const result = applyAmendOps(COLLAPSED, ops);
    expect(result.failures).toEqual([]);
    expect(result.text).not.toContain("as described");
  });

  it("refuses the same op when the caller says the breaks are the publisher's", () => {
    const { ops } = parseAmendmentInstructions(instruction);
    const result = applyAmendOps(COLLAPSED, ops, { recoverExtraction: false });
    expect(result.failures.map((f) => f.code)).toEqual(["target_not_found"]);
    expect(result.text).toBe(COLLAPSED);
  });
});

describe("deleteProvisionAndRenumberSiblings", () => {
  const AGREEMENT_WITH_POINTERS = [
    "ARTICLE VIII",
    "INDEMNITIES",
    "",
    "8.01 Vendor Indemnity. Recovery is subject to the limitations in Section 8.05.",
    "",
    "8.02 Purchaser Indemnity. The Purchaser shall indemnify the Vendor.",
    "",
    "8.03 Notice of Claim. The Vendor shall give notice promptly.",
    "",
    "8.04 Defence of Third Party Claims. A party notified under Section 8.03 may defend.",
    "",
    "8.05 Limitations. Aggregate liability is capped.",
    "",
    "8.06 Survival. Section 8.01 survives Closing.",
    "",
    "ARTICLE XI",
    "TAX",
    "",
    "11.01 Tax Indemnity. Recovery is subject to Section 8.05.",
    "",
    "11.02 Tax Contests. Notice shall be prompt.",
    "",
    "11.03 Cooperation. Each party shall cooperate.",
  ].join("\n");

  it("deletes a clause, closes its sibling gap, and updates pointers atomically", () => {
    const result = deleteProvisionAndRenumberSiblings(
      AGREEMENT_WITH_POINTERS,
      "8.02",
    );

    expect(result.failures).toEqual([]);
    expect(result.mapping).toEqual([
      { from: "sec8.03", to: "sec8.02" },
      { from: "sec8.04", to: "sec8.03" },
      { from: "sec8.05", to: "sec8.04" },
      { from: "sec8.06", to: "sec8.05" },
    ]);
    expect(result.text).not.toContain("Purchaser Indemnity");
    expect(result.text).toContain("8.02 Notice of Claim.");
    expect(result.text).toContain("notified under Section 8.02");
    expect(result.text.match(/subject to (?:the limitations in )?Section 8\.04/gu)).toHaveLength(2);
    expect(result.text).not.toContain("8.06");
    expect(result.verification).toEqual({
      headingsRenumbered: 4,
      referencesUpdated: 3,
    });
    expect(result.applied).toContainEqual(
      expect.objectContaining({
        kind: "delete_provision",
        from: "sec8.02",
        to: null,
      }),
    );
  });

  it("satisfies the frozen Sunrise delete-and-renumber benchmark fixture", () => {
    const source = readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "benchmarks",
        "docx_edit",
        "fixtures",
        "prose",
        "sunrise-spa.md",
      ),
      "utf8",
    );
    const result = deleteProvisionAndRenumberSiblings(source, "8.02");

    expect(result.failures).toEqual([]);
    expect(result.mapping).toEqual([
      { from: "sec8.03", to: "sec8.02" },
      { from: "sec8.04", to: "sec8.03" },
      { from: "sec8.05", to: "sec8.04" },
      { from: "sec8.06", to: "sec8.05" },
    ]);
    expect(result.text).not.toContain("Purchaser Indemnity");
    expect(result.text).toContain("8.02 Notice of Claim.");
    expect(result.text).toContain("8.03 Defence of Third Party Claims.");
    expect(result.text).toContain("8.04 Limitations.");
    expect(result.text).toContain("8.05 Survival.");
    expect(result.text).not.toContain("8.06");
    expect(result.text.match(/Section 8\.02/gu)).toHaveLength(2);
    expect(result.text.match(/Section 8\.04/gu)).toHaveLength(3);
    expect(result.verification).toEqual({
      headingsRenumbered: 4,
      referencesUpdated: 5,
    });
  });

  it.each([
    [
      "reference_to_deleted_target",
      "\nSection 11.03 is subject to Section 8.02.",
    ],
    [
      "unresolved_reference",
      "\nSection 11.03 is subject to Section 8.99.",
    ],
    [
      "external_reference",
      "\nSection 11.03 is subject to Section 8.05 of the Income Tax Act.",
    ],
    [
      "ambiguous_reference",
      "\nSection 11.03 is subject to Sections 8.03 and 8.05.",
    ],
  ])("refuses %s without applying a partial edit", (code, extra) => {
    const source = AGREEMENT_WITH_POINTERS + extra;
    const result = deleteProvisionAndRenumberSiblings(source, "8.02");

    expect(result.failures.map((failure) => failure.code)).toContain(code);
    expect(result.text).toBe(source);
    expect(result.applied).toEqual([]);
  });

  it("refuses an ambiguous target without choosing an occurrence", () => {
    const source = [
      "ARTICLE I",
      "COVENANTS",
      "",
      "Section 1.01 First Covenant. The Borrower shall pay.",
      "",
      "Section 1.01 Duplicate Covenant. The Borrower shall report.",
      "",
      "Section 1.02 Second Covenant. The Borrower shall notify.",
    ].join("\n");
    const result = deleteProvisionAndRenumberSiblings(source, "1.01");

    expect(result.failures).toEqual([
      expect.objectContaining({ code: "target_ambiguous" }),
    ]);
    expect(result.text).toBe(source);
  });

  it("refuses to compress a pre-existing sibling gap", () => {
    const source = [
      "ARTICLE I",
      "COVENANTS",
      "",
      "Section 1.01 First Covenant. The Borrower shall pay.",
      "",
      "Section 1.02 Obsolete Covenant. This provision is deleted.",
      "",
      "Section 1.04 Reserved Sequence. The numbering gap is intentional.",
    ].join("\n");
    const result = deleteProvisionAndRenumberSiblings(source, "1.02");

    expect(result.failures).toEqual([
      expect.objectContaining({ code: "sibling_sequence_unsupported" }),
    ]);
    expect(result.text).toBe(source);
    expect(result.applied).toEqual([]);
  });
});
