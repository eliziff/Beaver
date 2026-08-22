
import { describe, expect, it } from "vitest";
import {
  analyzeOpinionStructure,
  deriveTextOpinionStructure,
  partitionOpinionStructure,
} from "./legalOpinionBoundaries";

function structure(text: string, firstParagraphStart?: number) {
  return analyzeOpinionStructure({
    text,
    firstParagraphStart: firstParagraphStart ?? text.indexOf("[1]"),
  });
}

describe("analyzeOpinionStructure", () => {
  it("does not turn a tribunal name in a panel description into a judge", () => {
    const result = structure(`Before: Nancy Rosenberg, a panel of the Federal Public Sector Labour Relations and Employment Board

[1] The grievance is allowed.`);
    expect(result.panel).toEqual(["Nancy Rosenberg"]);
  });

  it("keeps the named decision maker without creating a title-only panel member", () => {
    const result = structure(`Before: Richard Morneau, Prothonotary

[1] The motion is dismissed.`);
    expect(result.panel).toEqual(["Richard Morneau"]);
  });

  it("keeps a middle-initial adjudicator and discards the following office title", () => {
    const result = structure(`Before: Ian R. Mackenzie, Vice-Chairperson

[1] The application is allowed.`);
    expect(result.panel).toEqual(["Ian R. Mackenzie"]);
  });

  it("recognizes regional chief-justice suffixes without creating title-only judges", () => {
    const result = structure(`Before: Clarke C.J.N.S., MacDonald C.J.B.C., Board Member, Q.C.

[1] The appeal is dismissed.`);
    expect(result.panel).toEqual(["Clarke C.J.N.S.", "MacDonald C.J.B.C."]);
  });

  it("parses the BCCA front-matter dialect with role bindings and page/paragraph hints", () => {
    const result = structure(`Before:
The Honourable Madam Justice Rowles
The Honourable Mr. Justice Mackenzie
The Honourable Madam Justice Levine

Written Reasons by:
The Honourable Mr. Justice Mackenzie

Concurred in by:
The Honourable Madam Justice Rowles

Dissenting Reasons by:
The Honourable Madam Justice Levine (Page 17, Paragraph 19)

Reasons for Judgment of the Honourable Mr. Justice Mackenzie:

[1] The appellant was convicted of second degree murder.`);
    expect(result.panel).toEqual(["Rowles", "Mackenzie", "Levine"]);
    expect(result.bindings).toHaveLength(4);
    const written = result.bindings.find((b) => b.line === "Written Reasons by:");
    expect(written).toMatchObject({
      role: "majority",
      names: ["Mackenzie"],
      from: null,
      to: null,
    });
    const concurred = result.bindings.find((b) => b.line === "Concurred in by:");
    expect(concurred).toMatchObject({ role: "concurring", names: ["Rowles"] });
    const dissenting = result.bindings.find(
      (b) => b.line === "Dissenting Reasons by:",
    );
    expect(dissenting).toMatchObject({
      role: "minority",
      names: ["Levine"],
      from: 19,
      to: null,
      page: 17,
    });
    const body = result.bindings.find(
      (b) => b.bodyStart === true && b.names.includes("Mackenzie"),
    );
    expect(body).toMatchObject({ role: "majority", names: ["Mackenzie"] });
    expect(result.status).toBe("unresolved");
  });

  it("parses the SCC front-matter dialect with explicit paragraph ranges", () => {
    const result = structure(`Coram: Wagner C.J. and Abella, Moldaver, Karakatsanis, Côté, Brown, Rowe, Martin and Kasirer JJ.

Joint Reasons for Judgment: (paras. 1 to 83)
Brown and Martin JJ. (Wagner C.J. and Kasirer J. concurring)

Concurring Reasons: (paras. 84 to 101)
Moldaver J. (Côté J. concurring)

Concurring Reasons: (paras. 102 to 204)
Rowe J.

Dissenting Reasons: (paras. 205 to 253)
Karakatsanis J. (Abella J. concurring)

[1] This appeal concerns the availability of a stay.`);
    expect(result.panel).toHaveLength(9);
    expect(result.panel).toContain("Wagner C.J.");
    expect(result.panel).toContain("Kasirer JJ.");
    const joint = result.bindings.find(
      (b) => b.from === 1 && b.to === 83,
    );
    expect(joint).toMatchObject({
      role: "majority",
      names: ["Martin JJ.", "Brown"],
      concurred: ["Wagner C.J.", "Kasirer J."],
    });
    const firstConcurring = result.bindings.find(
      (b) => b.from === 84 && b.to === 101,
    );
    expect(firstConcurring).toMatchObject({
      role: "concurring",
      names: ["Moldaver J."],
      concurred: ["Côté J."],
    });
    const dissent = result.bindings.find(
      (b) => b.from === 205 && b.to === 253,
    );
    expect(dissent).toMatchObject({
      role: "minority",
      names: ["Karakatsanis J."],
      concurred: ["Abella J."],
    });
    expect(result.status).toBe("usable");
  });

  it("parses the FCA front-matter dialect with CORAM and body heading", () => {
    const result = structure(`CORAM: LINDEN J.A.
NADON J.A.
PELLETIER J.A.

REASONS FOR JUDGMENT BY: NADON J.A.
CONCURRED IN BY: LINDEN J.A.
CONCURRING REASONS BY: PELLETIER J.A.

REASONS FOR JUDGMENT
NADON J.A.

[1] The appellant was refused an employment insurance benefit.`);
    expect(result.panel).toEqual(["LINDEN J.A.", "NADON J.A.", "PELLETIER J.A."]);
    const by = result.bindings.find(
      (b) => b.line === "REASONS FOR JUDGMENT BY: NADON J.A.",
    );
    expect(by).toMatchObject({ role: "majority", names: ["NADON J.A."] });
    const concurred = result.bindings.find(
      (b) => b.line === "CONCURRED IN BY: LINDEN J.A.",
    );
    expect(concurred).toMatchObject({ role: "concurring", names: ["LINDEN J.A."] });
    const concurring = result.bindings.find(
      (b) => b.line === "CONCURRING REASONS BY: PELLETIER J.A.",
    );
    expect(concurring).toMatchObject({ role: "concurring", names: ["PELLETIER J.A."] });
    const body = result.bindings.find((b) => b.bodyStart === true);
    expect(body).toMatchObject({
      role: "majority",
      names: ["NADON J.A."],
      line: "REASONS FOR JUDGMENT",
    });
  });

  it("parses Per and Held attribution lines", () => {
    const result = structure(`Per Wagner C.J. and Brown, Martin and Kasirer JJ.: The sentencing regime for first degree murder does not violate section 7.

Held (Abella and Karakatsanis JJ. dissenting): The appeals are dismissed.

[1] This is an appeal as of right.`);
    const per = result.bindings.find((b) => b.role === "majority" && b.from === null);
    expect(per?.names).toEqual(
      expect.arrayContaining(["Wagner C.J.", "Kasirer JJ.", "Brown", "Martin"]),
    );
    const held = result.bindings.find((b) => b.role === "minority");
    expect(held?.names).toEqual(
      expect.arrayContaining(["Karakatsanis JJ.", "Abella"]),
    );
  });

  it("collects paragraph-start judge and court markers", () => {
    const result = structure(`[1] LOWRY J.A.: The question is whether the limitation period runs.
[26] GARSON J.A.: I agree.
[27] THE COURT: The appeal is dismissed.`);
    expect(result.bodyMarkers).toEqual([
      {
        kind: "para_start_judge",
        paragraph: 1,
        name: "LOWRY J.A.",
        role: null,
        line: "LOWRY J.A.",
      },
      {
        kind: "para_start_judge",
        paragraph: 26,
        name: "GARSON J.A.",
        role: null,
        line: "GARSON J.A.",
      },
      {
        kind: "court",
        paragraph: 27,
        name: null,
        role: "majority",
        line: "THE COURT",
      },
    ]);
  });

  it("refuses prose that only resembles a role heading", () => {
    const result = structure(`Reasons for judgment of the court below were delivered orally.
[1] This is an appeal.`);
    expect(result.bindings).toEqual([]);
    expect(result.status).toBe("unavailable");
    expect(result.refusals).toEqual(
      expect.arrayContaining([
        "no opinion role bindings found in the header",
        "no panel or coram roster found",
        "no judge paragraph-start markers found",
      ]),
    );
  });

  it("reports unavailable with typed refusals when nothing is present", () => {
    const result = structure(`R. v. Smith
[1] This is an appeal from a conviction.`);
    expect(result.status).toBe("unavailable");
    expect(result.refusals.length).toBeGreaterThanOrEqual(3);
  });

  it("flags a role heading whose names cannot be recognized", () => {
    const result = structure(`Dissenting Reasons by:
The learned trial judge was of the view that the appeal should fail.

[1] This is an appeal.`);
    const dissent = result.bindings.find((b) => b.role === "minority");
    expect(dissent).toBeDefined();
    expect(dissent!.names).toEqual([]);
    expect(result.refusals.some((r) => r.startsWith("role heading"))).toBe(true);
  });

  it("accepts a middle-initial name after a role heading", () => {
    const result = structure(`Before:
The Honourable Madam Justice Newbury
The Honourable Madam Justice D. Smith
The Honourable Madam Justice Stromberg-Stein

Written Reasons by:
The Honourable Madam Justice Newbury

Concurred in by:
The Honourable Madam Justice D. Smith

Dissenting Reasons by: (p. 18, para. 35)
The Honourable Madam Justice Stromberg-Stein

[1] The respondent applied for production of documents.`);
    expect(result.panel).toEqual(["Newbury", "D. Smith", "Stromberg-Stein"]);
    const concurred = result.bindings.find(
      (b) => b.line === "Concurred in by:",
    );
    expect(concurred).toMatchObject({
      role: "concurring",
      names: ["D. Smith"],
    });
    const dissenting = result.bindings.find(
      (b) => b.line === "Dissenting Reasons by: (p. 18, para. 35)",
    );
    expect(dissenting).toMatchObject({
      role: "minority",
      names: ["Stromberg-Stein"],
      from: 35,
      page: 18,
    });
  });

  it("ignores semicolon-separated metadata name lists as panel candidates", () => {
    const result = structure(`Wagner, Richard; Abella, Rosalie Silberman; Moldaver, Michael J.; Karakatsanis, Andromache

Coram: Wagner C.J. and Abella, Moldaver, Karakatsanis, Côté, Brown, Rowe, Martin and Kasirer JJ.

[1] This is an appeal.`);
    expect(result.panel).not.toContain("Michael J.");
    expect(result.panel).not.toContain("Nicholas");
    expect(result.panel).toContain("Karakatsanis");
  });

  it("keeps a panel with dotted initials and a mid-list chief justice", () => {
    const result = structure(`PRESENT:—Sir W.J. Ritchie, C.J., and Strong, Fournier, Henry, Taschereau and Gwynne, JJ.

[1] This is an appeal.`);
    expect(result.panel).toContain("Sir W.J. Ritchie C.J");
    expect(result.panel).toContain("Gwynne JJ");
    expect(result.panel).toHaveLength(6);
  });

  it("reads a spaced-dialect mid-list chief justice as a suffix", () => {
    const result = structure(`PRESENT.—Ritchie, C. J., and Strong, Fournier, Henry, Tasche-reau and Gwynne, JJ.

[1] This is an appeal.`);
    expect(result.panel).toContain("Ritchie C.J");
    expect(result.panel).not.toContain("C. J.");
    expect(result.panel).toHaveLength(6);
  });

  it("accepts a double-hyphen name line as a delivered-by continuation", () => {
    const result = structure(`Present: Lamer, Wilson, La Forest, L'Heureux‑Dubé, Sopinka, Gonthier and Cory JJ.

The judgment of the Court was delivered by
GONTHIER J. -- The present case is an appeal against a decision of the Federal Court of Appeal.

[1] The appeal should be allowed.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({ names: ["GONTHIER J."] });
    expect(result.refusals).toEqual([]);
  });

  it("skips long Per summary paragraphs without explicit ranges", () => {
    const result = structure(`Joint Reasons for Judgment: (paras. 1 to 83)
Wagner C.J. and Brown, Martin and Kasirer JJ.

Per Moldaver and Côté JJ.: The appeals should be dismissed. The sentences imposed by the sentencing judges in both cases were demonstrably unfit. They fall markedly below the range of sentences warranted in cases involving the directing minds of largescale fentanyl trafficking operations.

[1] This appeal concerns sentencing.`);
    const per = result.bindings.find((b) =>
      b.names.includes("Moldaver"),
    );
    expect(per).toBeUndefined();
    expect(result.status).toBe("usable");
  });

  it("treats an oral reasons heading as the body start", () => {
    const result = structure(`Before:
The Honourable Madam Justice Hall
The Honourable Madam Justice Saunders
The Honourable Mr. Justice Low

Oral Reasons for Judgment
A.C.D. Ross

[1] This is an appeal from conviction.`);
    const body = result.bindings.find((b) => b.bodyStart === true);
    expect(body).toMatchObject({ role: "majority", names: [] });
    expect(result.status).toBe("unresolved");
  });

  it("resolves a THE CHIEF JUSTICE em-dash continuation to the panel chief", () => {
    const result = structure(`Coram: Laskin C.J. and Estey, Martland, Ritchie and Dickson JJ.

The judgment of the Court was delivered orally by
THE CHIEF JUSTICE—We are all of the opinion that the appeal should be dismissed.

Judgment accordingly.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({ names: ["Laskin C.J."] });
    expect(result.panel).toContain("Laskin C.J.");
    expect(result.refusals).toEqual([]);
  });

  it("attributes a paragraph-marked author after a delivered-by heading", () => {
    const result = analyzeOpinionStructure({
      text: `The judgment of the Court was delivered orally by
[1] Abella J. — Applying R. v. Bradshaw, 2017 SCC 35, a majority of this panel would dismiss the appeal largely.`,
      firstParagraphStart: 0,
    });
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({ names: ["Abella J."] });
    expect(result.refusals).toEqual([]);
  });

  it("reads a judge name from a prose continuation with semicolons", () => {
    const result = structure(`Present: Sedgewick, Girouard, Davies and Mills, JJ.

The judgement of the court was delivered by—
SEDGEWICK J.—In the case of Coplen v. Callahan[22], in considering the effect that should be given to the following sections of the Mineral Act we held that every direction of sec. 16 was imperative ; that deviations from or irregularity in respect to such directions were fatal to the location ; and that section 28 did not include within its purview any area that had not been duly located.

[1] This is an appeal.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({ names: ["SEDGEWICK J."] });
    expect(result.status).toBe("unresolved");
  });

  it("parses a multi-judge judgment-of-the-Chief-Justice delivered-by heading", () => {
    const result = structure(`The judgment of the Chief Justice and Cartwright, Fauteux and Abbott JJ. was delivered by—
CARTWRIGHT J.:—This is an appeal from a judgment of the Court of Appeal for British Columbia.

[1] This is an appeal.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({
      names: [
        "The Chief Justice",
        "Cartwright J.",
        "Fauteux J.",
        "Abbott JJ.",
      ],
    });
    expect(result.refusals).toEqual([]);
  });

  it("keeps a range-only Dissenting Reasons heading without refusing it", () => {
    const result = structure(`Held (McLachlin C.J. and Bastarache J. dissenting): The appeal should be dismissed.

Dissenting Reasons: (paras. 43 to 74)

[1] This is an appeal.`);
    const dissent = result.bindings.find(
      (b) => b.from === 43 && b.to === 74,
    );
    expect(dissent).toMatchObject({ role: "minority", names: [] });
    const held = result.bindings.find((b) => b.line.startsWith("Held"));
    expect(held).toMatchObject({
      role: "minority",
      names: ["McLachlin C.J.", "Bastarache J."],
    });
    expect(
      result.refusals.some((refusal) =>
        refusal.includes("Dissenting Reasons:"),
      ),
    ).toBe(false);
  });

  it("does not let prose citations leak into a delivered-by continuation", () => {
    const result = structure(`The judgment of the Chief Justice and Cartwright, Fauteux and Abbott JJ. was delivered by
CARTWRIGHT J.:—This is an appeal from a judgment of the Court of Appeal for Ontario dismissing an appeal from the judgment of Barlow J. dated October 1, 1953.
The appellant suffered serious injuries in an automobile accident which occurred on May 22, 1952. He brought action against the respondents alleging that each of them had been guilty of acts of negligence which had caused the accident.

[1] This is an appeal.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({
      names: [
        "The Chief Justice",
        "Cartwright J.",
        "Fauteux J.",
        "Abbott JJ.",
      ],
    });
    expect(majority?.names).not.toContain("Barlow J.");
  });

  it("merges range parens from continuation lines and aligns trailing name lines", () => {
    const result = structure(`Reasons for Judgment:
(paras. 1 to 42)
Dissenting reasons:
(paras. 43 to 74)
Binnie J. (Major, LeBel, Deschamps, Fish, Abella and Charron JJ. concurring)
Bastarache J. (McLachlin C.J. concurring)

[1] This is an appeal.`);
    const majority = result.bindings.find((b) => b.role === "majority");
    expect(majority).toMatchObject({
      from: 1,
      to: 42,
      names: ["Binnie J."],
    });
    expect(majority?.concurred).toEqual(
      expect.arrayContaining([
        "Major",
        "LeBel",
        "Deschamps",
        "Fish",
        "Abella",
        "Charron JJ.",
      ]),
    );
    const dissent = result.bindings.find((b) => b.role === "minority");
    expect(dissent).toMatchObject({
      from: 43,
      to: 74,
      names: ["Bastarache J."],
      concurred: ["McLachlin C.J."],
    });
    expect(result.refusals).toEqual([]);
  });
});

describe("deriveTextOpinionStructure", () => {
  it("does not turn a post-judgment author credit into another opinion", () => {
    const text = `Before: Dussault J.
REASONS FOR JUDGMENT
Dussault J.
[1] The appeal is allowed because the worker remained independent under the governing test and the Minister's decision is vacated.
[2] The parties' agreement and their performance establish that no relationship of subordination existed.
Signed at Ottawa.
"P. R. Dussault"
Dussault J.
CITATION: 2005 TCC 703
REASONS FOR JUDGMENT BY: The Honourable Justice Pierre R. Dussault
APPEARANCES:
Counsel for the Respondent: A. Lawyer`;
    const result = deriveTextOpinionStructure({ text, minimumSubstantiveWords: 10 });
    expect(result.opinions).toHaveLength(1);
    expect(text.slice(result.opinions[0].start, result.opinions[0].end)).not.toContain("REASONS FOR JUDGMENT BY:");
  });

  const reasons = "This appeal requires the court to decide a focused legal issue from the record. The parties made competing submissions about the governing rule and its application. After reviewing the evidence, the legislation, and the authorities, I conclude that the appellant has not shown any reversible error. The appeal should therefore be dismissed with costs in the ordinary course.";

  it("treats BCCA I AGREE signatures as majority joins, not opinions", () => {
    const text = `Before:
The Honourable Madam Justice Alpha
The Honourable Mr. Justice Beta
The Honourable Madam Justice Gamma

Reasons for Judgment of the Honourable Madam Justice Alpha:
[1] ALPHA J.A.: ${reasons}
[2] I would dismiss the appeal.
"The Honourable Madam Justice Alpha"
I AGREE:
"The Honourable Mr. Justice Beta"
I AGREE:
"The Honourable Madam Justice Gamma"
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0]).toMatchObject({
      alignment: "lead",
    });
    expect(result.opinions[0].authors[0]).toMatch(/Alpha/iu);
    expect(text.slice(result.opinions[0].start, result.opinions[0].end)).not.toContain("I AGREE");
    expect(result.judges).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/^Alpha/iu), resultSide: "majority", relationship: "authors" }),
      expect.objectContaining({ name: "Beta", resultSide: "majority", relationship: "joins_reasons" }),
      expect.objectContaining({ name: "Gamma", resultSide: "majority", relationship: "joins_reasons" }),
    ]));
  });

  it("preserves same-surname panel members and routes their identity to review", () => {
    const text = `Before: Jane Smith J. and John Smith J.

Reasons for Judgment of the Honourable Justice Jane Smith:
[1] ${reasons}
[2] The application is dismissed.
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.panel).toEqual(expect.arrayContaining([
      expect.stringMatching(/Jane Smith/iu),
      expect.stringMatching(/John Smith/iu),
    ]));
    expect(result.status).toBe("unresolved");
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.stringMatching(/same surname/iu),
    ]));
  });

  it("separates a dissent from majority reasons and their joining judge", () => {
    const text = `Before:
The Honourable Madam Justice Alpha
The Honourable Mr. Justice Beta
The Honourable Madam Justice Gamma

Reasons for Judgment of the Honourable Madam Justice Alpha:
[1] ALPHA J.A.: ${reasons}
"The Honourable Madam Justice Alpha"
I AGREE:
"The Honourable Mr. Justice Beta"

Reasons for Judgment of the Honourable Madam Justice Gamma:
[2] With respect, I am unable to agree with my colleague. ${reasons} I would allow the appeal.
"The Honourable Madam Justice Gamma"
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions.map(({ alignment }) => alignment)).toEqual([
      "lead",
      "different_result",
    ]);
    expect(result.judges).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Beta", resultSide: "majority", relationship: "joins_reasons" }),
      expect.objectContaining({ name: "Gamma", resultSide: "minority", relationship: "authors" }),
    ]));
  });

  it("does not turn numbered agreement and order lines into short opinions", () => {
    const text = `Before:
The Honourable Madam Justice Alpha
The Honourable Mr. Justice Beta
The Honourable Madam Justice Gamma

Reasons for Judgment of the Honourable Madam Justice Alpha:
[1] ALPHA J.A.: ${reasons}
[62] BETA J.A.: I agree.
[63] GAMMA J.A.: I agree.
[64] BETA J.A.: The appeal is dismissed.
"The Honourable Madam Justice Alpha"
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.opinions).toHaveLength(1);
    expect(text.slice(result.opinions[0].end, text.indexOf("[62]")).trim()).toBe("");
    expect(result.judges).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/^Beta/iu), relationship: "joins_reasons" }),
      expect.objectContaining({ name: expect.stringMatching(/^Gamma/iu), relationship: "joins_reasons" }),
    ]));
  });

  it("ignores BCCA front-matter labels and a longer terminal order", () => {
    const order = "As directed when judgment was pronounced, the appeal is dismissed and the publication ban remains in force according to its terms. The registry will enter the disposition and provide the parties with a copy of these reasons.";
    const text = `Before:
The Honourable Madam Justice Alpha
The Honourable Mr. Justice Beta
The Honourable Madam Justice Gamma

Written Reasons by:
The Honourable Madam Justice Alpha
Concurred in by:
The Honourable Mr. Justice Beta
The Honourable Madam Justice Gamma

Reasons for Judgment of the Honourable Madam Justice Alpha:
[1] ALPHA J.A.: ${reasons}
[62] BETA J.A.: I agree.
[63] GAMMA J.A.: I agree.
[64] BETA J.A.: ${order}
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0].start).toBe(text.indexOf("Reasons for Judgment of"));
    expect(result.opinions[0].authors[0]).toMatch(/Alpha/iu);
    expect(result.judges).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/^Beta/iu), resultSide: "majority", relationship: "joins_reasons" }),
      expect.objectContaining({ name: expect.stringMatching(/^Gamma/iu), resultSide: "majority", relationship: "joins_reasons" }),
    ]));
  });

  it("returns source offsets when no paragraph structure exists", () => {
    const text = `Decision
Reasons for Judgment of the Honourable Madam Justice Alpha:
${reasons}
For those reasons, the application is dismissed.
"The Honourable Madam Justice Alpha"
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0].start).toBe(text.indexOf("Reasons for Judgment"));
    expect(text.slice(result.opinions[0].end, text.indexOf('"The Honourable')).trim()).toBe("");
    expect(result.opinions[0].startQuote.length).toBeGreaterThan(0);
    expect(result.opinions[0].endQuote.length).toBeGreaterThan(0);
  });

  it("stops a one-line delivered-by heading before judges mentioned in its reasons", () => {
    const text = `Present: Rinfret C.J. and Kellock, Estey and Cartwright JJ.

The judgment of the Court was delivered by Kellock J.:â€”${reasons} This appeal is from the judgment of the Exchequer Court, Cameron J., and must be dismissed.
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions[0].authors).toEqual(["Kellock J."]);
  });

  it("separates an SCC judgment bloc from the writer named on the next line", () => {
    const text = `The judgment of Alpha, Beta and Gamma JJ. was delivered by
1. Beta J. ‑‑ ${reasons}
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions[0].authors).toEqual(["Beta J."]);
    expect(result.judges).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/Beta/iu), relationship: "authors" }),
      expect.objectContaining({ name: expect.stringMatching(/Alpha/iu), relationship: "joins_reasons" }),
      expect.objectContaining({ name: expect.stringMatching(/Gamma/iu), relationship: "joins_reasons" }),
    ]));
  });

  it("routes a delivered-by writer who does not match the named judgment bloc", () => {
    const text = `The judgment of Alpha and Beta JJ. was delivered by
Gimma J.—${reasons}
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("unresolved");
    expect(result.opinions[0].authors).toEqual(["Gimma J."]);
  });

  it("does not turn a judge named in reported speech into the opinion author", () => {
    const text = `Before: Crawford J.

Reasons for Judgment
[1] ${reasons}
[14] At para. 22, Sopinka J. stated:
[15] ${reasons}
[16] In Sheppard, Binnie J. wrote, at para. 55:
[17] ${reasons}
[18] The judgment in Stern was delivered by Wright J., who said in part:
[19] ${reasons}
[20] The application is dismissed.
"R. Crawford, J."
`;
    const starts = [1, 14, 15, 16, 17, 18, 19, 20].map((number) => ({ number, start: text.indexOf(`[${number}]`) }));
    const paragraphs = starts.map(({ number, start }, index) => ({
      label: `par${number}`,
      start,
      end: starts[index + 1]?.start ?? text.length,
    }));
    const result = deriveTextOpinionStructure({ text, paragraphs, firstParagraphStart: starts[0].start });
    expect(result.opinions.flatMap(({ authors }) => authors)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/Sopinka/iu),
      expect.stringMatching(/Binnie/iu),
      expect.stringMatching(/Wright/iu),
    ]));
    expect(result.opinions.flatMap(({ authors }) => authors)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Crawford/iu),
    ]));
  });

  it("does not read a middle initial J as a judicial title", () => {
    const text = `[24] The Affidavit of Donna J. Harris: ${reasons}`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("unavailable");
    expect(result.opinions).toEqual([]);
  });

  it("does not turn a judge attribution in prose into an opinion byline", () => {
    const text = `[35] As Wilson J. expressed in her concurring judgment: ${reasons}`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("unavailable");
    expect(result.opinions).toEqual([]);
  });

  it("keeps a comma before a judicial title in a real opinion byline", () => {
    const text = `[1] BRAIDWOOD, J.A.: ${reasons}`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.opinions[0].authors).toEqual(["BRAIDWOOD J.A"]);
  });

  it("does not treat a reported judge in prose as an opinion author", () => {
    const text = `Coram: Alpha J.
[1] At 758, Cory J. provided a three-step instruction: ${reasons}`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("unavailable");
    expect(result.opinions).toEqual([]);
  });

  it("excludes nonparticipating judges and trims post-opinion court metadata", () => {
    const text = `Coram: Alpha, Beta and Gamma JJ.
Reasons for Judgment by: Alpha J.
[1] ${reasons}
[2] For these reasons, I would dismiss the appeal with costs.
Solicitors for the appellant: Example LLP, Vancouver.
[*] Beta and Gamma JJ. took no part in the judgment.
`;
    const result = deriveTextOpinionStructure({ text });
    expect(result.status).toBe("ready");
    expect(result.panel.map((name) => name.toLocaleLowerCase())).toEqual([expect.stringContaining("alpha")]);
    expect(result.nonparticipants).toHaveLength(2);
    expect(result.nonparticipants.map((name) => name.toLocaleLowerCase())).toEqual(expect.arrayContaining([
      expect.stringContaining("beta"),
      expect.stringContaining("gamma"),
    ]));
    expect(result.judges).toHaveLength(1);
    expect(result.judges[0]).toMatchObject({
      name: expect.stringMatching(/Alpha/iu),
      resultSide: "majority",
      relationship: "authors",
    });
    const opinionText = text.slice(result.opinions[0].start, result.opinions[0].end);
    expect(opinionText).not.toContain("Solicitors for");
    expect(opinionText).not.toContain("took no part");
  });

  it("does not promote a short front-matter block through the sole-panel fallback", () => {
    const text = `[1]
IN THE SUPREME COURT OF BRITISH COLUMBIA
Before: District Registrar Sainty
${Array.from({ length: 52 }, (_, index) => `caption${index}`).join(" ")}`;
    const result = deriveTextOpinionStructure({
      text,
      paragraphs: [{ label: "par1", start: 0, end: text.length }],
      firstParagraphStart: 0,
    });
    expect(result.status).toBe("unavailable");
    expect(result.opinions).toEqual([]);
    expect(result.refusals).toEqual(expect.arrayContaining([
      expect.stringMatching(/has only \d+ substantive words/iu),
    ]));
  });

  it("translates explicit oracle paragraph ranges into text offsets", () => {
    const header = `Coram: Alpha, Beta and Gamma JJ.
Joint Reasons for Judgment: (paras. 1 to 1)
Alpha J. (Beta J. concurring)
Dissenting Reasons: (paras. 2 to 2)
Gamma J.
`;
    const first = `[1] ${reasons}\n`;
    const second = `[2] With respect, I dissent. ${reasons}\n`;
    const text = `${header}${first}${second}`;
    const result = deriveTextOpinionStructure({
      text,
      paragraphs: [
        { label: "par1", start: header.length, end: header.length + first.length },
        { label: "par2", start: header.length + first.length, end: text.length },
      ],
      firstParagraphStart: header.length,
    });
    expect(result.status).toBe("ready");
    expect(result.opinions).toHaveLength(2);
    expect(result.opinions[0]).toMatchObject({ start: header.length, alignment: "lead" });
    expect(result.opinions[1]).toMatchObject({
      start: header.length + first.length,
      alignment: "different_result",
    });
  });
});

describe("partitionOpinionStructure", () => {
  it("partitions an SCC front matter into ready spans and judges", () => {
    const result = structure(`Coram: Wagner C.J. and Abella, Moldaver, Karakatsanis, Côté, Brown, Rowe, Martin and Kasirer JJ.

Joint Reasons for Judgment: (paras. 1 to 83)
Brown and Martin JJ. (Wagner C.J. and Kasirer J. concurring)

Concurring Reasons: (paras. 84 to 101)
Moldaver J. (Côté J. concurring)

Concurring Reasons: (paras. 102 to 204)
Rowe J.

Dissenting Reasons: (paras. 205 to 253)
Karakatsanis J. (Abella J. concurring)

[1] This appeal concerns the availability of a stay.`);
    const partition = partitionOpinionStructure(
      result,
      Array.from({ length: 253 }, (_, i) => i + 1),
    );
    expect(partition.status).toBe("ready");
    expect(partition.spans.majority).toEqual([{ from: 1, to: 83 }]);
    expect(partition.spans.concurring).toEqual([{ from: 84, to: 204 }]);
    expect(partition.spans.minority).toEqual([{ from: 205, to: 253 }]);
    const keys = partition.judges.map((judge) => judge.name);
    expect(partition.judges).toHaveLength(9);
    for (const judge of partition.judges) {
      const expected =
        judge.name === "Karakatsanis J." || judge.name === "Abella J."
          ? "minority"
          : judge.name === "Rowe J." || judge.name === "Moldaver J." || judge.name === "Côté J."
            ? "concurring"
            : "majority";
      expect(judge.role).toBe(expected);
    }
    expect(keys).toContain("Wagner C.J.");
    expect(keys).toContain("Kasirer J.");
  });

  it("stays unresolved when explicit ranges do not cover the spine", () => {
    const result = structure(`Dissenting Reasons by: The Honourable Madam Justice Levine (Page 17, Paragraph 19)
[1] The appellant was convicted.`);
    const partition = partitionOpinionStructure(
      result,
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(partition.status).toBe("unresolved");
    expect(partition.note).toMatch(/cover \d+ of 30 paragraphs/u);
    expect(partition.judges).toEqual([]);
  });

  it("stays unresolved when explicit ranges overlap", () => {
    const result = structure(`Concurring Reasons: (paras. 1 to 10)
X J.

Concurring Reasons: (paras. 5 to 20)
Y J.

[1] First paragraph.`);
    const partition = partitionOpinionStructure(
      result,
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(partition.status).toBe("unresolved");
    expect(partition.note).toBe("explicit opinion ranges overlap");
  });
});
