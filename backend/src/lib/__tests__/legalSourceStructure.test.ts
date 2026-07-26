import { describe, expect, it } from "vitest";
import {
  buildLegalSourceStructure,
  buildTnaStructure,
  lookupLegalSourceStructure,
} from "../legalSourceStructure";

describe("provider-neutral legal source structure", () => {
  it("preserves TNA paragraph and nested section eIds", () => {
    const xml = `
      <akomaNtoso>
        <judgment>
          <section eId="section_2">
            <num>2.</num>
            <subsection eId="section_2__subsection_1">
              <num>(1)</num>
              <paragraph eId="para_24">
                <num>24.</num>
                <content>The native paragraph has distinctive exact words.</content>
              </paragraph>
            </subsection>
          </section>
        </judgment>
      </akomaNtoso>`;
    const structure = buildTnaStructure(xml);
    const paragraph = lookupLegalSourceStructure(structure, "paragraph", "24");
    const subsection = lookupLegalSourceStructure(structure, "section", "2(1)");

    expect(paragraph.status).toBe("found");
    expect(paragraph.block?.anchor).toBe("para_24");
    expect(paragraph.block?.origin).toBe("native");
    expect(paragraph.block?.text).toContain("distinctive exact words");
    expect(subsection.status).toBe("found");
    expect(subsection.block?.anchor).toBe("section_2__subsection_1");
  });

  it("uses native CourtListener pages but not arbitrary HTML p IDs", () => {
    const markup = `
      <article>
        <p id="Auq">Opening unnumbered opinion text.</p>
        <page-number label="410" citation-index="1"></page-number>
        <p id="Bxr">Distinctive reporter page passage.</p>
        <page-number label="411" citation-index="1"></page-number>
        <p id="Cys">Following reporter page passage.</p>
      </article>`;
    const structure = buildLegalSourceStructure({
      provider: "courtlistener",
      text: "",
      markup,
      docType: "cases",
    });

    expect(structure.counts.paragraph).toBe(0);
    expect(structure.counts.page).toBe(2);
    expect(
      lookupLegalSourceStructure(structure, "page", "410").block?.text,
    ).toContain("Distinctive reporter page passage");
  });

  it("reconstructs numbered paragraphs when markup has no native locators", () => {
    const markup = Array.from(
      { length: 5 },
      (_, index) =>
        `<p>[${index + 1}] Paragraph ${index + 1} contains enough substantive judicial words for reliable structural reconstruction.</p>`,
    ).join("");
    const structure = buildLegalSourceStructure({
      provider: "courtlistener",
      text: "",
      markup,
      docType: "cases",
    });
    const lookup = lookupLegalSourceStructure(
      structure,
      "paragraph",
      "paragraph 4",
    );

    expect(lookup.status).toBe("found");
    expect(lookup.block?.origin).toBe("heuristic");
    expect(lookup.block?.text).toContain("Paragraph 4");
    expect(structure.counts.section).toBe(0);
  });

  it("does not invent PDF pages from page-count metadata", () => {
    const structure = buildLegalSourceStructure({
      provider: "govinfo",
      text: "A decision with no embedded page markers.",
      docType: "cases",
    });

    expect(structure.counts.page).toBe(0);
  });

  it("materializes mapped legislation sections from the mapped text", () => {
    const structure = buildLegalSourceStructure({
      provider: "a2aj",
      text: "unstructured fallback",
      docType: "laws",
      sectionMap: {
        "34": "34 (1) A requested thing may be ordered.\n(a) The first condition applies.",
        "35": "35 The next section follows.",
      },
    });
    const lookup = lookupLegalSourceStructure(structure, "section", "34(1)(a)");

    expect(structure.source).toBe("section_map");
    expect(structure.text).toContain("The first condition applies");
    expect(structure.counts.paragraph).toBe(0);
    expect(lookup.status).toBe("found");
    expect(lookup.block?.text).toContain("The first condition applies");
  });
});
