import { describe, expect, it } from "vitest";

import {
  FR_PROVISION_REF,
  PROVISION_REF,
  compactLabel,
  compactLabelFr,
  findProvisionReferences,
  isExternalReference,
  joinLocator,
} from "../legalReferenceGrammar";

/**
 * Fixtures are verbatim from the LegalBench-RAG mini corpus (maud:
 * Acacia_Communications_Cisco_Systems.txt) unless marked otherwise, so the
 * grammar is pinned against drafting that actually exists rather than
 * invented specimens.
 */
const ACACIA_EXTERNAL =
  "“Group” has the meaning ascribed to such term under Section 13(d) of the Exchange Act.";
const ACACIA_INTERNAL =
  "in fulfilling its obligations under this Agreement, including under Section 5.3.";
const ACACIA_LIST =
  "the representations and warranties contained in Section 2.3(b), Section 6.3(a) and Section 7.1(f)), (J) any actions taken";
const ACACIA_ROMAN =
  "satisfaction or waiver of each of the conditions set forth in Article VI (other than those conditions that by their terms";
const ACACIA_ORIGINAL_AGREEMENT =
  "B. Pursuant to Section 7.4 of the Original Agreement, Parent, Sub and the Company";

describe("anchored dialect (the amend-ops surface)", () => {
  it("keeps the shapes legalAmendOps addresses ops by", () => {
    const re = new RegExp(PROVISION_REF, "iu");
    expect(re.exec("Subsection 5(1)")?.[1]).toBe("5(1)");
    expect(re.exec("clause 5(1)(b)(ii)")?.[1]).toBe("5(1)(b)(ii)");
    expect(re.exec("Section 2.05 of the Credit Agreement")?.[1]).toBe("2.05");
    expect(re.exec("paragraph (b)")?.[1]).toBe("(b)");
  });

  it("keeps the French federal shapes", () => {
    const re = new RegExp(FR_PROVISION_REF, "iu");
    expect(re.exec("le paragraphe 193(2)")?.[1]).toBe("193(2)");
    expect(compactLabelFr("42a)(i)")).toBe("42(a)(i)");
    expect(compactLabel("5 (1)")).toBe("5(1)");
  });

  it("joins head and sub labels into the shared locator dialect", () => {
    expect(joinLocator("3", "(u)")).toBe("sec3(u)");
    expect(joinLocator("8.01", "(a)")).toBe("sec8.01(a)");
    expect(joinLocator("5")).toBe("sec5");
    expect(joinLocator("")).toBe("");
  });
});

describe("isExternalReference", () => {
  it("treats another named instrument as external and this one as internal", () => {
    expect(isExternalReference(" of the Income Tax Act")).toBe(true);
    expect(isExternalReference(" of the Exchange Act.")).toBe(true);
    expect(isExternalReference(" of this Agreement")).toBe(false);
    expect(isExternalReference(".")).toBe(false);
    // a subscript continuation is skipped before the test applies
    expect(isExternalReference("(d) of the Exchange Act")).toBe(true);
    expect(isExternalReference("(d) of this Agreement")).toBe(false);
  });
});

describe("findProvisionReferences", () => {
  it("requires a non-empty label (a bare provision word is not an edge)", () => {
    expect(findProvisionReferences("as provided in this section hereof")).toEqual(
      [],
    );
    expect(findProvisionReferences("each paragraph of this Agreement")).toEqual(
      [],
    );
    // the anchored dialect DOES match those (empty label), which is exactly
    // why it must not be used as a free-text detector
    expect(
      new RegExp(PROVISION_REF, "iu").exec("each paragraph of this Agreement")
        ?.[0],
    ).toBe("paragraph ");
  });

  it("reports spans, labels and locators for the real contract dialect", () => {
    const found = findProvisionReferences(ACACIA_INTERNAL);
    expect(found).toHaveLength(1);
    const [reference] = found;
    expect(reference.raw).toBe("Section 5.3");
    expect(ACACIA_INTERNAL.slice(reference.start, reference.end)).toBe(
      "Section 5.3",
    );
    expect(reference.word).toBe("section");
    expect(reference.label).toBe("5.3");
    expect(reference.locator).toBe("sec5.3");
    expect(reference.shape).toBe("numeric");
    expect(reference.external).toBe(false);
  });

  it("marks references to another instrument external", () => {
    const [reference] = findProvisionReferences(ACACIA_EXTERNAL);
    expect(reference.label).toBe("13(d)");
    expect(reference.external).toBe(true);
    const [original] = findProvisionReferences(ACACIA_ORIGINAL_AGREEMENT);
    expect(original.label).toBe("7.4");
    expect(original.external).toBe(true);
  });

  it("finds every member of an explicitly repeated list", () => {
    expect(findProvisionReferences(ACACIA_LIST).map((r) => r.locator)).toEqual([
      "sec2.3(b)",
      "sec6.3(a)",
      "sec7.1(f)",
    ]);
  });

  it("reads roman container numbering, which the anchored dialect cannot", () => {
    const [reference] = findProvisionReferences(ACACIA_ROMAN);
    expect(reference.raw).toBe("Article VI");
    expect(reference.shape).toBe("roman");
    // roman labels do not normalize; they resolve through skeleton aliases
    expect(reference.locator).toBe("");
    expect(reference.aliasKey).toBe("article vi");
    expect(new RegExp(PROVISION_REF, "iu").exec("Article VI")?.[1]).toBe("");
  });

  it("does not read a roman SECTION (measured: 5 spans corpus-wide vs 612 roman articles)", () => {
    expect(findProvisionReferences("Section IV of the deed")).toEqual([]);
  });

  it("carries sub-only labels but leaves them un-normalized", () => {
    const [reference] = findProvisionReferences(
      "as described in paragraph (b) above",
    );
    expect(reference.shape).toBe("sub-only");
    expect(reference.label).toBe("(b)");
    // "(b)" is meaningless without the section it sits in; resolution is
    // context-relative and belongs to the caller (joinLocator).
    expect(reference.locator).toBe("");
    expect(joinLocator("8.01", reference.label)).toBe("sec8.01(b)");
  });

  it("restricts the vocabulary on request", () => {
    const text = "Section 5.3 and Schedule 2.1 and paragraph (b)";
    expect(
      findProvisionReferences(text, { words: ["section"] }).map((r) => r.raw),
    ).toEqual(["Section 5.3"]);
  });

  it("returns source order with no duplicate spans across the two passes", () => {
    const text = `${ACACIA_ROMAN} ${ACACIA_LIST}`;
    const found = findProvisionReferences(text);
    const starts = found.map((r) => r.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(starts).size).toBe(starts.length);
  });
});
