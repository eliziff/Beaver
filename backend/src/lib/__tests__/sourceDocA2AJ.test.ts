import { describe, expect, it } from "vitest";
import { lookupSourceDoc, type SourceDoc } from "../sourceDoc";
import { compileA2AJSourceDoc } from "../sourceDocA2AJ";

/**
 * Spine behaviour of the A2AJ compiler on synthetic shapes. The equivalent
 * assertions over real captured payloads live in sourceDocFixtures.test.ts.
 */

function compile(args: {
  text: string;
  docType: "cases" | "laws";
  citation?: string;
  dataset?: string;
  name?: string;
  sectionMap?: Record<string, string>;
}): SourceDoc {
  return compileA2AJSourceDoc({
    citation: args.citation ?? "synthetic",
    docType: args.docType,
    text: args.text,
    dataset: args.dataset,
    name: args.name,
    sectionMap: args.sectionMap,
  });
}

function labels(doc: SourceDoc) {
  return doc.blocks.map((block) => block.label);
}

describe("A2AJ compiler spine", () => {
  it("selects the primary monotone decision paragraph sequence", () => {
    const text = [
      "[1] First substantive judgment paragraph contains enough ordinary words for reliable structural validation.",
      "[2] Second substantive judgment paragraph contains enough ordinary words for reliable structural validation.",
      "[3] The court quotes another numbered decision with sufficient surrounding judicial context.",
      "[25] Quoted paragraph contains enough words to look superficially like judgment text.",
      "[26] Another quoted paragraph contains enough words to look superficially like judgment text.",
      "[4] The primary judgment resumes with enough ordinary substantive words for structural validation.",
      "[5] The primary judgment continues with enough ordinary substantive words for structural validation.",
    ].join("\n");
    const doc = compile({
      text,
      docType: "cases",
      citation: "2099 SCC 1",
      dataset: "SCC",
    });

    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3", "par4", "par5"]);
    expect(
      lookupSourceDoc(doc, "paragraph", "paragraph 4").block?.text,
    ).toContain("primary judgment resumes");
  });

  it("rejects an embedded numbered list borrowing an unnumbered tail", () => {
    const prefix = "Reasons before the quoted list. ".repeat(100);
    const list = Array.from(
      { length: 5 },
      (_, index) =>
        `${index + 1}. List condition ${index + 1} contains enough explanatory words to resemble prose.`,
    ).join("\n");
    const tail = "Unnumbered reasons continue at length. ".repeat(1000);
    const doc = compile({
      text: prefix + list + tail,
      docType: "cases",
    });
    expect(doc.ranges.paragraph.count).toBe(0);
  });

  it("recognizes ALR's observed reporter-page variants", () => {
    const text = [
      "Opening reporter material.",
      "[Page 514]",
      "Opening reporter-page text ends here [Page515]",
      "The distinctive reporter quotation appears here.",
      "Page 516]",
      "Closing reporter-page text.",
    ].join("\n");
    const doc = compile({
      text,
      docType: "cases",
      citation: "[2099] 1 SCR 513",
      dataset: "SCC",
    });
    const result = lookupSourceDoc(doc, "page", "page 515");

    expect(result.status).toBe("found");
    expect(result.block?.text).toContain("distinctive reporter quotation");
  });

  it("indexes sections through Roman subparagraphs", () => {
    const text = [
      "1 Short title and introductory words governing this enactment.",
      "2 Definitions and interpretive provisions used throughout this enactment.",
      "3 Duties of the Minister under this enactment.",
      "(1) The Minister must prepare an annual report.",
      "(2) The Minister must publish reports as follows.",
      "(a) A public report must include prescribed information.",
      "(i) The distinctive annual report must be published every year.",
      "4 Regulations may prescribe further procedural requirements under this enactment.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });
    const result = lookupSourceDoc(doc, "section", "3(2)(a)(i)");

    expect(result.status).toBe("found");
    expect(result.block?.label).toBe("sec3(2)(a)(i)");
    expect(result.block?.text).toContain("distinctive annual report");
  });

  it("preserves flat lowercase children and added decimal paragraphs", () => {
    const text = [
      "34(2) Parent provision.",
      "(a) First paragraph.",
      "(b) Second paragraph.",
      "(c) Third paragraph.",
      "(d) Fourth paragraph.",
      "(f) Sixth paragraph.",
      "(f.1) Added paragraph.",
      "(g) Seventh paragraph.",
    ].join("\n");
    const doc = compile({
      text: "unstructured fallback",
      docType: "laws",
      sectionMap: { "34": text },
    });

    expect(labels(doc)).toEqual([
      "sec34",
      "sec34(2)",
      "sec34(2)(a)",
      "sec34(2)(b)",
      "sec34(2)(c)",
      "sec34(2)(d)",
      "sec34(2)(f)",
      "sec34(2)(f.1)",
      "sec34(2)(g)",
    ]);
  });

  it("keeps a real Roman run nested under its paragraph", () => {
    const text = [
      "34(2) Parent provision.",
      "(a) Paragraph.",
      "(i) Item.",
      "(ii) Item.",
      "(iii) Item.",
      "(iv) Item.",
      "(v) Item.",
    ].join("\n");
    const doc = compile({
      text: "unstructured fallback",
      docType: "laws",
      sectionMap: { "34": text },
    });

    expect(labels(doc)).toEqual([
      "sec34",
      "sec34(2)",
      "sec34(2)(a)",
      "sec34(2)(a)(i)",
      "sec34(2)(a)(ii)",
      "sec34(2)(a)(iii)",
      "sec34(2)(a)(iv)",
      "sec34(2)(a)(v)",
    ]);
  });

  it.each(["ii", "iv", "IV"])(
    "handles direct multi-character Roman child %s",
    (token) => {
      const doc = compile({
        text: "unstructured fallback",
        docType: "laws",
        sectionMap: { "1": `1 Parent\n(${token}) Direct item.` },
      });
      expect(labels(doc)).toContain(
        `sec1(${token})`,
      );
    },
  );

  it("preserves dotted top-level provisions inside an integer spine", () => {
    const quote = "significant threat to the safety of the public";
    const text = [
      "669 Introductory provision.",
      "670 Another provision.",
      "671 Another provision.",
      "672 Parent provision.",
      "672.1 First dotted provision.",
      "672.53 Prior dotted provision.",
      `672.54 A person is not a ${quote}.`,
      "672.5401 A later provision must remain outside section 672.54.",
      "673 Another provision.",
      "674 Concluding provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });
    const result = lookupSourceDoc(doc, "section", "672.54");

    expect(result.block?.text).toContain(quote);
    expect(result.block?.text).not.toContain("later provision");
    expect(
      lookupSourceDoc(doc, "section", "672").block?.text,
    ).not.toContain(quote);
  });

  it("gates hyphenated rule numbering by the instrument name", () => {
    const text = [
      "1-1 First rule text.",
      "1-2 Second rule text.",
      "1-3 Distinctive third rule text.",
      "2-1 Fourth rule text.",
    ].join("\n");
    const rules = compile({
      text,
      docType: "laws",
      name: "Supreme Court Civil Rules",
    });
    const ordinary = compile({
      text,
      docType: "laws",
      name: "Drinking Water Systems",
    });

    expect(labels(rules)).toEqual([
      "sec1-1",
      "sec1-2",
      "sec1-3",
      "sec2-1",
    ]);
    expect(ordinary.status).toBe("unavailable");
  });

  it("indexes an inline first subrule and its sibling", () => {
    const text = [
      "11.9 First rule text.",
      "11.10(1) Distinctive first subrule text.",
      "(2) Distinctive second subrule text.",
      "11.11 Next rule text.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(labels(doc)).toContain(
      "sec11.10(1)",
    );
    expect(labels(doc)).toContain(
      "sec11.10(2)",
    );
  });
});
