import { describe, expect, it } from "vitest";
import {
  lookupSourceDoc,
  sliceSourceDocBlocks,
  type SourceDoc,
} from "../sourceDoc";
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

  it("chooses a contiguous candidate when repeated starts conflict", () => {
    // A repeated opening marker must not fracture the spine: the chain
    // continues from whichever [1] the rest of the ladder follows, and the
    // advertised range stays gapless.
    const paragraph = (number: number, ordinal: string) =>
      `[${number}] The ${ordinal} substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.`;
    const text = [
      paragraph(1, "first"),
      paragraph(1, "repeated"),
      paragraph(2, "second"),
      paragraph(3, "third"),
      paragraph(4, "fourth"),
      paragraph(5, "fifth"),
      paragraph(6, "sixth"),
      paragraph(7, "seventh"),
      paragraph(8, "eighth"),
    ].join("\n");

    const doc = compile({ text, docType: "cases" });
    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual([
      "par1",
      "par2",
      "par3",
      "par4",
      "par5",
      "par6",
      "par7",
      "par8",
    ]);
    expect(doc.ranges.paragraph.missing).toEqual([]);
  });

  it("refuses an out-of-order ladder rather than advertising a late start", () => {
    // `[3]` printed before `[2]` leaves no chain rooted at 1 that reaches the
    // tail. The previous selector answered par3..par8 — a paragraph range the
    // decision never had, opening three paragraphs into a document that must
    // begin at 1.
    const paragraph = (number: number, ordinal: string) =>
      `[${number}] The ${ordinal} substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.`;
    const text = [
      paragraph(1, "first"),
      paragraph(3, "third"),
      paragraph(2, "second"),
      paragraph(4, "fourth"),
      paragraph(5, "fifth"),
      paragraph(6, "sixth"),
      paragraph(7, "seventh"),
      paragraph(8, "eighth"),
    ].join("\n");

    const doc = compile({ text, docType: "cases" });
    expect(doc.blocks.filter((block) => block.kind === "paragraph")).toEqual(
      [],
    );
  });

  it("recovers a numbered paragraph joined to its preceding heading", () => {
    // Real A2AJ shape from 2024 ONCA 468: "Qualified Privilege [63] ...".
    // The heading must not make the local reader lose the pinpoint target.
    const text = [
      "[1] First substantive judgment paragraph contains enough ordinary words for reliable structural validation.",
      "[2] Second substantive judgment paragraph contains enough ordinary words for reliable structural validation.",
      "(a) Qualified Privilege [3] The court begins by setting out the governing legal principles and their application to the record.",
      "[4] The primary judgment resumes with enough ordinary substantive words for structural validation.",
      "[5] The primary judgment continues with enough ordinary substantive words for structural validation.",
      "[6] The disposition follows from the preceding analysis and resolves the remaining issues between the parties.",
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3", "par4", "par5", "par6"]);
    expect(lookupSourceDoc(doc, "paragraph", "3").block?.text).toMatch(
      /^\[3\] The court begins/u,
    );
  });

  it("recovers a sentence heading joined to a bracketed CITT paragraph", () => {
    const body =
      "This substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.";
    const text = [
      `[1] ${body}`,
      `[2] ${body}`,
      "The complaint relating to setting aside the contract is premature [3] In the email accompanying the complaint, the party explained why the requested relief remained unavailable.",
      `[4] ${body}`,
      `[5] ${body}`,
      `[6] ${body}`,
    ].join("\n");
    const doc = compile({ text, docType: "cases", dataset: "CITT" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3", "par4", "par5", "par6"]);
    expect(doc.ranges.paragraph.missing).toEqual([]);
    expect(lookupSourceDoc(doc, "paragraph", "3").block?.text).toMatch(
      /^\[3\] In the email/u,
    );
  });

  it("recovers formal dot-numbered headings", () => {
    const body =
      "The Tribunal applies the governing legal framework to the record and explains the resulting disposition in sufficient substantive detail.";
    const paragraph = (number: number) => `${number}. ${body}`;
    const text = [
      ...Array.from({ length: 5 }, (_, index) => paragraph(index + 1)),
      `PROCUREMENT PROCESS 6. ${body}`,
      ...Array.from({ length: 5 }, (_, index) => paragraph(index + 7)),
      `Costs 12. ${body}`,
      ...Array.from({ length: 13 }, (_, index) => paragraph(index + 13)),
      `Costs 26. ${body}`,
      `DETERMINATION OF THE TRIBUNAL 27. ${body}`,
      paragraph(28),
    ].join("\n");
    const doc = compile({ text, docType: "cases", dataset: "CITT" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(Array.from({ length: 28 }, (_, index) => `par${index + 1}`));
    expect(doc.ranges.paragraph.missing).toEqual([]);
    expect(lookupSourceDoc(doc, "paragraph", "27").block?.text).toMatch(
      /^27\. The Tribunal/u,
    );
  });

  it("refuses a fractured short source instead of promoting an inline pinpoint", () => {
    const body =
      "This substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.";
    const text = [
      `[1] ${body}`,
      `[2] ${body}`,
      "The court relied on its earlier decision [3] in reaching the result after considering the parties' submissions.",
      `[4] ${body}`,
      `[5] ${body}`,
      `[6] ${body}`,
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(doc.ranges.paragraph.count).toBe(0);
    expect(lookupSourceDoc(doc, "paragraph", "3").status).toBe(
      "unavailable",
    );
  });

  it("refuses a fractured dot source instead of promoting a case citation", () => {
    const body =
      "This substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.";
    const text = [
      `1. ${body}`,
      `2. ${body}`,
      "R. v. Example 3. The court relied on the earlier reasons when resolving the present dispute.",
      `4. ${body}`,
      `5. ${body}`,
      `6. ${body}`,
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(doc.ranges.paragraph.count).toBe(0);
    expect(lookupSourceDoc(doc, "paragraph", "3").status).toBe(
      "unavailable",
    );
  });

  it("does not promote a quoted dot-numbered statutory provision", () => {
    const body =
      "The court explains the record, the governing submissions, and the resulting disposition in enough detail to identify ordinary judicial reasons.";
    const text = [
      `1. ${body}`,
      `2. ${body}`,
      "3. (1) A person shall comply with the Act and the Regulations when the provision applies.",
      ...Array.from({ length: 5 }, (_, index) => `${index + 4}. ${body}`),
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    // Excluding the quoted provision leaves no `3.` for the chain to reach, so
    // the numbering is refused outright rather than resurfacing as a spine
    // that opens at `4.` — which is what "does not promote" has to mean when
    // the provision list is the only dot numbering the document carries.
    expect(doc.ranges.paragraph.count).toBe(0);
    expect(lookupSourceDoc(doc, "paragraph", "3").status).toBe("unavailable");
    expect(doc.ranges.paragraph.missing).toEqual([]);
  });

  it("recovers a missing leading paragraph joined to its heading", () => {
    const body =
      "This substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.";
    const text = [
      `Overview [1] ${body}`,
      ...Array.from({ length: 5 }, (_, index) => `[${index + 2}] ${body}`),
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3", "par4", "par5", "par6"]);
    expect(lookupSourceDoc(doc, "paragraph", "1").block?.text).toMatch(
      /^\[1\] This substantive/u,
    );
  });

  it.each([
    ["duplicate", 2],
    ["decreasing", 3],
  ] as const)(
    "does not recover a %s marker before the leading spine paragraph",
    (_shape, candidate) => {
      // A heading-joined label sitting above paragraph 1 cannot belong to a
      // chain rooted there — it precedes the root. It must not displace the
      // real line-start marker that carries the same number.
      const body =
        "This substantive judgment paragraph contains enough ordinary words for reliable structural validation throughout these reasons.";
      const text = [
        `Overview [${candidate}] ${body}`,
        ...Array.from({ length: 5 }, (_, index) => `[${index + 1}] ${body}`),
      ].join("\n");
      const doc = compile({ text, docType: "cases" });

      expect(
        doc.blocks
          .filter((block) => block.kind === "paragraph")
          .map((block) => block.label),
      ).toEqual(["par1", "par2", "par3", "par4", "par5"]);
      expect(
        lookupSourceDoc(doc, "paragraph", String(candidate)).block?.text,
      ).toMatch(new RegExp(`^\\[${candidate}\\] This substantive`, "u"));
    },
  );

  it("accepts a complete short [1]..[N] ladder in a short order", () => {
    // Short orders / oral reasons / costs rulings: 17/29 of the
    // full-sweep none-queue sample were exactly this shape, killed by
    // the minimum-run rule (structure_ref.py parity, commit dbb7b355).
    const text = [
      "COURT OF APPEAL — Costs ruling. Registry 12345.",
      "[1] The appellant seeks costs of the application on an elevated scale, arguing the respondent's conduct through the proceeding unnecessarily lengthened the hearing and multiplied expense for every party involved.",
      "[2] We do not agree that the conduct described rises to the level required for elevated costs under the governing authorities.",
      "[3] The application is dismissed with costs in the ordinary course.",
    ].join("\n");
    const doc = compile({ text, docType: "cases" });
    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3"]);
  });

  it("rejects a short complete ladder that is only a tail fragment", () => {
    const prose = "Reasons continue at considerable length here. ".repeat(500);
    const text = `${prose}\n[1] Tail list item one with enough words to look superficially substantive across the line.\n[2] Tail list item two with enough words to look superficially substantive across the line.`;
    expect(text.length).toBeGreaterThan(6000);
    const doc = compile({ text, docType: "cases" });
    expect(doc.ranges.paragraph.count).toBe(0);
  });

  it("skips a late sparse footnote ladder and keeps the decision spine", () => {
    const decision = Array.from(
      { length: 5 },
      (_, index) =>
        `${index + 1}. This substantive decision paragraph contains enough ordinary words to identify the court's reasons and preserve its reliable pinpoint structure.`,
    );
    const filler = "Unnumbered reasons and procedural history continue. ".repeat(
      170,
    );
    const footnotes = Array.from({ length: 12 }, (_, index) =>
      index === 5
        ? `[${index + 1}] ${"One unusually long reference entry supplies isolated words but does not turn the sparse endnote ladder into judgment paragraphs. ".repeat(4)}`
        : `[${index + 1}] Short citation.`,
    );
    const text = [...decision, filler, ...footnotes].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(text.length).toBeGreaterThan(6000);
    expect(text.indexOf("[1] Short citation.") / text.length).toBeGreaterThan(
      0.7,
    );
    expect(
      doc.blocks
        .filter((block) => block.kind === "paragraph")
        .map((block) => block.label),
    ).toEqual(["par1", "par2", "par3", "par4", "par5"]);
    expect(doc.ranges.paragraph.missing).toEqual([]);
    expect(lookupSourceDoc(doc, "paragraph", "1").block?.text).toContain(
      "substantive decision paragraph",
    );
  });

  it("keeps concise reasons that begin late in a short decision", () => {
    const header = "Case history and disposition summary. ".repeat(55);
    const text = [
      header,
      `[1] ${"The court resolves the appeal on the narrow issue argued by the parties. ".repeat(4)}`,
      "[2] The appeal is dismissed.",
      "[3] SMITH J.A.: I agree.",
      "[4] JONES J.A.: I agree.",
      "[5] The appeal is dismissed.",
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text.indexOf("[1]") / text.length).toBeGreaterThan(0.7);
    expect(doc.ranges.paragraph.count).toBe(5);
  });

  it("keeps substantive reasons that begin late in a long decision", () => {
    const header = "Lengthy case history and party submissions. ".repeat(190);
    const paragraph =
      "This numbered paragraph contains substantial judicial reasoning about the record, the governing law, and the disposition reached after considering the parties' arguments in full.";
    const text = [
      header,
      ...Array.from(
        { length: 5 },
        (_, index) => `[${index + 1}] ${paragraph}`,
      ),
    ].join("\n");
    const doc = compile({ text, docType: "cases" });

    expect(text.length).toBeGreaterThan(6000);
    expect(text.indexOf("[1]") / text.length).toBeGreaterThan(0.7);
    expect(doc.ranges.paragraph.count).toBe(5);
  });

  it("keeps a ladder whose tail is short concurrence lines", () => {
    // "ROWLES, J.A.: I agree." tails sink the median; the max-words arm
    // of the substance guard keeps the ladder (dbb7b355).
    const text = [
      "[1] The trial judge erred in principle by treating the limitation defence as dispositive without first resolving the discoverability question that both parties squarely raised on the evidence presented at trial in this matter before the court.",
      "[2] I would allow the appeal.",
      "[3] SMITH J.A.: I agree.",
      "[4] JONES J.A.: I agree.",
      "[5] LOW J.A.: I agree.",
      "[6] Disposition accordingly.",
    ].join("\n");
    const doc = compile({ text, docType: "cases" });
    expect(doc.ranges.paragraph.count).toBe(6);
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

  it("falls back to the dot-form section grammar when the plain one finds nothing", () => {
    // NT/PE drafting convention ("1. There is established...",
    // "2.(1) In this section") — structure_ref.py SECTION_MARK_RE_EXT,
    // commit 6ae6d330. The extended grammar must only run when the plain
    // grammar yields no spine: Ontario enumerates paragraphs inside
    // sections in the same shape (pinned by a2aj-regs-on-oreg267-03).
    const body =
      "This section provides for the administration of the enactment in force across the territory. ";
    const text = [
      `1. There is established a board to administer this Act. ${body}`,
      `2.(1) In this section, a term has the meaning given by regulation. ${body}`,
      `2.1. This inserted provision also governs administration. ${body}`,
      `3. The Minister may make regulations for carrying out this Act. ${body}`,
      `4. This Act comes into force on assent. ${body}`,
    ].join("\n");
    const doc = compile({ text, docType: "laws" });
    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(["sec1", "sec2", "sec2.1", "sec3", "sec4"]);
    expect(labels(doc)).toContain("sec2(1)");
    expect(lookupSourceDoc(doc, "section", "2.1").block?.text).toContain(
      "inserted provision",
    );
  });

  it("keeps later numeric sections after bold formula variables", () => {
    const text = [
      "**1** First provision.",
      "**2** Second provision.",
      "**3** Formula follows.",
      "**D.1** A formula variable, not a section.",
      "**E.1** Another formula variable, not a section.",
      "**4** Fourth provision.",
      "**5** Fifth provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(["sec1", "sec2", "sec3", "sec4", "sec5"]);
    expect(lookupSourceDoc(doc, "section", "4").block?.text).toContain(
      "Fourth provision",
    );
  });

  it("fills plain sections around an emphasized section in one rendition", () => {
    const text = [
      "1 First plain provision.",
      "**2** Emphasized middle provision.",
      "3 Final plain provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(["sec1", "sec2", "sec3"]);
    expect(lookupSourceDoc(doc, "section", "2").block?.text).toMatch(
      /^\*\*2\*\* Emphasized/u,
    );
    const top = doc.blocks.filter(
      (block) => block.kind === "section" && !block.parentLabel,
    );
    expect(top.filter(({ label }) => label === "sec2")).toHaveLength(1);
    expect(top.map(({ start, end }) => [start, end])).toEqual([
      [text.indexOf("1"), text.indexOf("**2**")],
      [text.indexOf("**2**"), text.indexOf("3 Final")],
      [text.indexOf("3 Final"), text.length],
    ]);
  });

  it("fills an emphasized repeal stub inside a plain spine", () => {
    const text = [
      "1 First plain provision.",
      "**2** [Repealed]",
      "3 Third plain provision.",
      "4 Fourth plain provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(["sec1", "sec2", "sec3", "sec4"]);
  });

  it("preserves alpha-leading federal regulation sections", () => {
    const text = [
      "**A.01.001** First provision.",
      "**A.01.002** Second provision.",
      "**A.01.003** Third provision.",
    ].join("\n");

    expect(labels(compile({ text, docType: "laws" }))).toEqual([
      "secA.01.001",
      "secA.01.002",
      "secA.01.003",
    ]);
  });

  it("keeps a single emphasized repeal provision", () => {
    const doc = compile({
      text: "**2** [Repealed]",
      docType: "laws",
    });

    expect(labels(doc)).toEqual(["sec2"]);
  });

  it("represents a collapsed status range as one block with locator aliases", () => {
    const text = [
      "1 First provision.",
      "2 Second provision.",
      "3 Third provision.",
      "4 Fourth provision.",
      "**5 to 18** [Repealed]",
      "19 Nineteenth provision.",
      "20 Twentieth provision.",
      "21 Final provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });
    const range = lookupSourceDoc(doc, "section", "12");

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(["sec1", "sec2", "sec3", "sec4", "sec5", "sec19", "sec20", "sec21"]);
    expect(range).toMatchObject({
      status: "found",
      block: {
        label: "sec5",
        aliases: expect.arrayContaining(["sec6", "sec12", "sec18"]),
      },
    });
    expect(range.block?.text).toContain("5 to 18");
    expect(sliceSourceDocBlocks(doc, "section", "10", "12")).toHaveLength(1);
    expect(doc.ranges.section.missing).not.toContain("sec12");
    expect(doc.ranges.section.count).toBe(21);
  });

  it("does not expand a dash range in a hyphen-numbered regulation", () => {
    const text = [
      "1-1 First rule.",
      "1-2 Second rule.",
      "1-3 [Repealed]",
    ].join("\n");
    const doc = compile({
      text,
      docType: "laws",
      name: "Water Regulations",
    });

    expect(labels(doc)).toEqual(["sec1-1", "sec1-2", "sec1-3"]);
    expect(lookupSourceDoc(doc, "section", "2").status).toBe("not_found");
  });

  it("refuses equal-strength emphasized dotted dialects", () => {
    const text = [
      "**17.26** First provision.",
      "**17.261** First inserted provision.",
      "**17.27** Later provision.",
      "**17.262** Ambiguous reordered provision.",
    ].join("\n");

    expect(compile({ text, docType: "laws" }).status).toBe("unavailable");
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

  it("indexes and bounds a two-section instrument", () => {
    const text = [
      "1 This Act may be cited as the Short Act.",
      "2 Distinctive commencement provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(labels(doc)).toEqual(["sec1", "sec2"]);
    expect(lookupSourceDoc(doc, "section", "1").block?.text).not.toContain(
      "Distinctive commencement",
    );
    expect(lookupSourceDoc(doc, "section", "2").block?.text).toContain(
      "Distinctive commencement",
    );
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
      text,
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

  it("keeps provider section-map text, offsets and lookups in legislative order", () => {
    // Real A2AJ shape from Alberta's ABC Benefits Corporation Act:
    // JSON says 1,2,3,4,4.1,4.2,5; Object.entries says 1,2,3,4,5,4.1,4.2.
    const sectionMap = {
      "1": "First provision.",
      "2": "Second provision.",
      "3": "Third provision.",
      "4": "Fourth provision.",
      "4.1": "First added provision.",
      "4.2": "Second added provision.",
      "5": "Fifth provision.",
      "Schedule 2": "Provider's second schedule.",
      "Schedule 1": "Provider's first schedule.",
    };
    const ordered = [
      ["1", sectionMap["1"]],
      ["2", sectionMap["2"]],
      ["3", sectionMap["3"]],
      ["4", sectionMap["4"]],
      ["4.1", sectionMap["4.1"]],
      ["4.2", sectionMap["4.2"]],
      ["5", sectionMap["5"]],
    ] as const;
    const providerTail = [
      ["Schedule 2", sectionMap["Schedule 2"]],
      ["Schedule 1", sectionMap["Schedule 1"]],
    ] as const;
    const assembled = [...ordered, ...providerTail];
    const text = assembled.map(([, value]) => value).join("\n");
    const doc = compile({
      text: "",
      docType: "laws",
      sectionMap,
    });
    let start = 0;
    const expectedBlocks = assembled.map(([label, value]) => {
      const block = {
        label: `sec${label}`,
        start,
        end: start + value.length,
      };
      start = block.end + 1;
      return block;
    });

    expect(doc.text).toBe(text);
    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map(({ label, start, end }) => ({ label, start, end })),
    ).toEqual(expectedBlocks);
    expect(lookupSourceDoc(doc, "section", "4.1").block).toMatchObject({
      ...expectedBlocks[4],
      text: sectionMap["4.1"],
    });
  });

  it("preserves whole text while native map entries replace matching sections", () => {
    const text = [
      "1 First full-text provision.",
      "2 Second full-text provision.",
      "3 Third full-text provision.",
    ].join("\n");
    const doc = compile({
      text,
      docType: "laws",
      sectionMap: { "2": "Second full-text provision." },
    });

    expect(doc.text).toBe(text);
    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map(({ label, origin }) => ({ label, origin })),
    ).toEqual([
      { label: "sec1", origin: "heuristic" },
      { label: "sec2", origin: "native" },
      { label: "sec3", origin: "heuristic" },
    ]);
    expect(lookupSourceDoc(doc, "section", "2").block?.text).toBe(
      "2 Second full-text provision.",
    );
  });

  it("fails closed on ambiguous content and locator conflicts", () => {
    const repeatedText = [
      "1 Repeated provision.",
      "2 Repeated provision.",
      "3 Distinct provision.",
    ].join("\n");
    const repeated = compile({
      text: repeatedText,
      docType: "laws",
      sectionMap: { "1": "Repeated provision." },
    });
    expect(
      lookupSourceDoc(repeated, "section", "1").block?.origin,
    ).toBe("heuristic");

    const conflictingText = [
      "1 First unique provision.",
      "2 Second unique provision.",
      "3 Third unique provision.",
    ].join("\n");
    const conflicting = compile({
      text: conflictingText,
      docType: "laws",
      sectionMap: { "1": "Second unique provision." },
    });
    expect(
      lookupSourceDoc(conflicting, "section", "1").block?.origin,
    ).toBe("heuristic");
  });

  it("adds an exact provider section missed by reconstruction", () => {
    const text = [
      "1 First reconstructed provision.",
      "Second provider-only provision.",
      "3 Third reconstructed provision.",
      "4 Fourth reconstructed provision.",
    ].join("\n");
    const doc = compile({
      text,
      docType: "laws",
      sectionMap: { "2": "Second provider-only provision." },
    });

    expect(doc.text).toBe(text);
    expect(lookupSourceDoc(doc, "section", "1").status).toBe("found");
    expect(lookupSourceDoc(doc, "section", "2")).toMatchObject({
      status: "found",
      block: {
        label: "sec2",
        origin: "native",
        text: "Second provider-only provision.",
      },
    });
    expect(lookupSourceDoc(doc, "section", "3").status).toBe("found");
  });

  it("preserves one provider section rendition byte-for-byte", () => {
    const text = "\n  Provider spacing is evidence, not decoration.  \n";
    const doc = compile({
      text: "",
      docType: "laws",
      sectionMap: { "8": "[blank]", "9": text },
    });

    expect(doc.text).toBe(text);
    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map(({ label, start, end, origin }) => ({
          label,
          start,
          end,
          origin,
        })),
    ).toEqual([
      {
        label: "sec9",
        start: 0,
        end: text.length,
        origin: "native",
      },
    ]);
  });

  it("places provider preambles and suffixed sections without sorting named tails", () => {
    const doc = compile({
      text: "",
      docType: "laws",
      sectionMap: {
        Preamble: "Whereas the Legislature recognizes these principles.",
        "1": "First provision.",
        "2": "Second provision.",
        "2A": "First suffixed provision.",
        "2Z": "Last single-letter provision.",
        "2AA": "First double-letter provision.",
        "2DI": "Later double-letter provision.",
        "3": "Third provision.",
        "3 and 3.1": "Provider-combined provision.",
        "Schedule B": "Provider schedule B.",
        "Schedule A": "Provider schedule A.",
      },
    });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map(({ label, origin }) => ({ label, origin })),
    ).toEqual(
      [
        "secPreamble",
        "sec1",
        "sec2",
        "sec2A",
        "sec2Z",
        "sec2AA",
        "sec2DI",
        "sec3",
        "sec3 and 3.1",
        "secSchedule B",
        "secSchedule A",
      ].map((label) => ({ label, origin: "native" })),
    );
    expect(doc.text).toMatch(
      /^Whereas the Legislature[\s\S]+Provider schedule B\.\nProvider schedule A\.$/u,
    );
  });

  it.each([
    [
      "component",
      ["11.9", "11.10", "11.11"],
    ],
    [
      "fractional",
      ["17.26", "17.261", "17.262", "17.27"],
    ],
  ] as const)("preserves provider %s dotted ordering", (_dialect, ordered) => {
    const sectionMap = Object.fromEntries(
      ordered.map((label) => [label, `Provision ${label}.`]),
    );
    const doc = compile({
      text: "",
      docType: "laws",
      sectionMap,
    });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(ordered.map((label) => `sec${label}`));
  });

  it("preserves provider order when dotted dialect evidence is tied", () => {
    const ordered = ["17.26", "17.261", "17.27", "17.262"];
    const doc = compile({
      text: "",
      docType: "laws",
      sectionMap: Object.fromEntries(
        ordered.map((label) => [label, `Provision ${label}.`]),
      ),
    });

    expect(
      doc.blocks
        .filter((block) => block.kind === "section" && !block.parentLabel)
        .map((block) => block.label),
    ).toEqual(ordered.map((label) => `sec${label}`));
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
      text,
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
      const text = `1 Parent\n(${token}) Direct item.`;
      const doc = compile({
        text,
        docType: "laws",
        sectionMap: { "1": text },
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

  it("looks up uppercase-suffixed provisions", () => {
    const text = [
      "5A Distinctive suffixed provision.",
      "6 Ordinary provision.",
      "17W Final suffixed provision.",
    ].join("\n");
    const doc = compile({ text, docType: "laws" });

    expect(lookupSourceDoc(doc, "section", "5A").block?.text).toContain(
      "Distinctive suffixed",
    );
    expect(lookupSourceDoc(doc, "section", "17W").status).toBe("found");
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

  it.each(["Water Regulations", "Règlement sur les eaux"])(
    "admits hyphenated numbering for %s",
    (name) => {
      const text = [
        "1-1 First provision.",
        "1-2 Second provision.",
        "1-10 Tenth provision.",
      ].join("\n");

      expect(labels(compile({ text, docType: "laws", name }))).toEqual([
        "sec1-1",
        "sec1-2",
        "sec1-10",
      ]);
    },
  );

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
