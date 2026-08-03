import { describe, expect, it } from "vitest";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
} from "./legalOpinionBoundaries";

function structure(text: string, firstParagraphStart?: number) {
  return analyzeOpinionStructure({
    text,
    firstParagraphStart: firstParagraphStart ?? text.indexOf("[1]"),
  });
}

describe("analyzeOpinionStructure", () => {
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
