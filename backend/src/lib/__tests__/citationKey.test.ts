/**
 * The shared in-text citation detector. `citationLookupKey` itself is
 * arbitrated by the differential oracle test in retrievalGate.test.ts;
 * this file pins the scanner that was promoted out of citatorExcerpts'
 * CITE_TOKEN so a2ajPassageSearch and the excerpt classifier share one
 * surface.
 *
 * Pure string work: no databases, no network, no model calls.
 */
import { describe, expect, it } from "vitest";

import {
  citationsInText,
  hasCitationInText,
  type CitationMatch,
} from "../citationKey";

const texts = (value: string) =>
  citationsInText(value).map((match: CitationMatch) => match.text);

describe("citationsInText", () => {
  it("finds neutral citations, including the French twin", () => {
    expect(texts("what did 2016 SCC 27 say about delay")).toEqual([
      "2016 SCC 27",
    ]);
    expect(texts("l'arrêt 2015 CSC 5 sur la question")).toEqual(["2015 CSC 5"]);
    expect(texts("compare 2023 ONCA 9 and 2024 BCSC 118")).toEqual([
      "2023 ONCA 9",
      "2024 BCSC 118",
    ]);
  });

  it("finds [year] reporter cites written with periods", () => {
    expect(texts("cited as [2019] 4 S.C.R. 653 in the factum")).toEqual([
      "[2019] 4 S.C.R. 653",
    ]);
    expect(texts("see [1990] 3 SCR 1385")).toEqual(["[1990] 3 SCR 1385"]);
  });

  it("finds CanLII ids", () => {
    expect(texts("the decision at CanLII 123 is short")).toEqual(["CanLII 123"]);
  });

  it("keeps the reporter shapes the excerpt classifier depends on", () => {
    // Regression pin for the detector promoted out of citatorExcerpts:
    // volume-reporter-page and "(1985), 48 C.R. (3d) 226" first-instance
    // reporters must still be spotted, or authority lists read as prose.
    expect(texts("R. v. Ward, 2012 ONCA 660, 112 O.R. (3d) 321")).toEqual([
      "2012 ONCA 660",
      "112 O.R. (3d) 321",
    ]);
    expect(texts("R. v. Guiller (1985), 48 C.R. (3d) 226; and more")).toEqual([
      "(1985), 48 C.R.",
    ]);
  });

  it("prefers the unambiguous shapes over the loose reporter shape", () => {
    // Alternation order matters: a neutral cite must not be split by the
    // volume-reporter alternative.
    const [match] = citationsInText("Applying 2024 SCC 6, notice is required");
    expect(match).toEqual({ text: "2024 SCC 6", start: 9, end: 19 });
  });

  it("reports offsets that slice the verbatim match back out", () => {
    const value = "In 2016 SCC 27 the Court held, per [2019] 4 S.C.R. 653.";
    for (const match of citationsInText(value)) {
      expect(value.slice(match.start, match.end)).toBe(match.text);
    }
  });

  it("returns nothing for plain text with no citations", () => {
    expect(citationsInText("notice served on every party")).toEqual([]);
    expect(citationsInText("")).toEqual([]);
    expect(
      citationsInText("the tribunal considered section 7 of the Charter"),
    ).toEqual([]);
  });
});

describe("hasCitationInText", () => {
  it("agrees with the scanner and is not stateful across calls", () => {
    for (const _ of [0, 1, 2]) {
      expect(hasCitationInText("R. v. Jordan, 2016 SCC 27")).toBe(true);
      expect(hasCitationInText("no citation here at all")).toBe(false);
    }
  });
});
