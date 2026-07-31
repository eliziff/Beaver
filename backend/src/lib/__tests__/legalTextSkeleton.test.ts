import { describe, expect, it } from "vitest";

import {
  compileAgreementSkeleton,
  readSection,
  renderAgreementOutline,
} from "../legalTextSkeleton";
import { compileA2AJSourceDoc } from "../sourceDocA2AJ";

const AGREEMENT = [
  "CREDIT AGREEMENT",
  "",
  "ARTICLE I — DEFINITIONS",
  "Section 1.01 Defined Terms.",
  '"Borrower" means Acme Manufacturing Corp.',
  '"Business Day" means any day other than a Saturday or Sunday.',
  "ARTICLE VIII — EVENTS OF DEFAULT",
  "Section 8.01 Events of Default.",
  "(a) Payment Default. Failure to pay principal when due;",
  "(b) Interest Default. Failure to pay interest within five (5) Business Days;",
  "(c) Covenant Default. Breach of any covenant;",
  "(d) Representation Default. Any representation proves untrue;",
  "(e) Cross-Default. Default under other Indebtedness;",
  "(f) Insolvency. Any insolvency proceeding;",
  "(g) Judgment Default. Entry of judgments;",
  "(h) ERISA Default. Any ERISA Event;",
  "(i) Change of Control. A Change of Control occurs;",
  "Section 8.02 Remedies.",
  "Upon any Event of Default under Section 8.01(a), and subject to Section 85 of the Income Tax Act, the Administrative Agent may act. See also Section 9.99 for notices.",
  "SCHEDULE 7.01 — EXISTING INDEBTEDNESS",
  "The following Indebtedness exists.",
].join("\n");

describe("compileAgreementSkeleton: agreement style", () => {
  const skeleton = compileAgreementSkeleton(AGREEMENT);
  const labels = skeleton.nodes.map((node) => node.label);

  it("builds containers, sections, ladders, and schedules", () => {
    expect(labels).toContain("art1");
    expect(labels).toContain("sec1.01");
    expect(labels).toContain("art8");
    expect(labels).toContain("sec8.01");
    expect(labels).toContain("sec8.01(a)");
    expect(labels).toContain("sec8.01(h)");
    expect(labels).toContain("sec8.02");
    expect(labels).toContain("sched7.01");
  });

  it("reads (i) after (h) as alphabetic, not roman", () => {
    expect(labels).toContain("sec8.01(i)");
    expect(labels).not.toContain("sec8.01(h)(i)");
  });

  it("does not invent sections from cross-reference prose", () => {
    expect(labels).not.toContain("sec9.99");
  });

  it("serves section spans including their children", () => {
    const section = readSection(skeleton, "8.01");
    expect(section.status).toBe("found");
    expect(section.block?.text).toContain("Payment Default");
    expect(section.block?.text).toContain("Change of Control");
    expect(section.block?.text).not.toContain("Remedies");

    const subsection = readSection(skeleton, "Section 8.01(b)");
    expect(subsection.status).toBe("found");
    expect(subsection.block?.text).toContain("Interest Default");
    expect(subsection.block?.text).not.toContain("Covenant Default");
  });

  it("resolves containers and schedules through aliases", () => {
    const article = readSection(skeleton, "Article VIII");
    expect(article.status).toBe("found");
    expect(article.block?.text).toContain("Events of Default");
    expect(article.block?.text).not.toContain("EXISTING INDEBTEDNESS");

    const schedule = readSection(skeleton, "Schedule 7.01");
    expect(schedule.status).toBe("found");
    expect(schedule.block?.text).toContain("following Indebtedness");
  });

  it("indexes defined terms with their defining section", () => {
    const borrower = skeleton.definedTerms.find(
      (entry) => entry.term === "Borrower",
    );
    expect(borrower?.sectionLabel).toBe("sec1.01");
    expect(
      skeleton.definedTerms.some((entry) => entry.term === "Business Day"),
    ).toBe(true);
  });

  it("classifies cross-references and flags unresolved targets", () => {
    expect(skeleton.crossReferences.internal).toBeGreaterThanOrEqual(2);
    expect(skeleton.crossReferences.external).toBeGreaterThanOrEqual(1);
    expect(skeleton.crossReferences.unresolved).toContain("9.99");
    expect(skeleton.crossReferences.unresolved).not.toContain("8.01(a)");
  });

  it("renders a complete outline with handles", () => {
    const outline = renderAgreementOutline(skeleton);
    expect(outline).toContain("[sec8.01(i)]");
    expect(outline).toContain("Defined terms (2)");
    expect(outline).toContain("Schedules/Exhibits: SCHEDULE 7.01");
  });
});

describe("compileAgreementSkeleton: nested roman ladders", () => {
  const text = [
    "Section 9.01 Baskets.",
    "(a) General Basket. The Borrower may:",
    "(i) incur unsecured Indebtedness;",
    "(ii) incur secured Indebtedness;",
    "(b) Ratio Basket. Subject to pro forma compliance.",
  ].join("\n");
  const skeleton = compileAgreementSkeleton(text);
  const labels = skeleton.nodes.map((node) => node.label);

  it("opens a roman level under (a) and pops back for (b)", () => {
    expect(labels).toEqual([
      "sec9.01",
      "sec9.01(a)",
      "sec9.01(a)(i)",
      "sec9.01(a)(ii)",
      "sec9.01(b)",
    ]);
  });
});

describe("compileAgreementSkeleton: ladder edge grammar", () => {
  it("suffixes restarted enumerators instead of dropping them", () => {
    const text = [
      "Section 4.01 Lists.",
      "(a) first item;",
      "(b) second item;",
      "(a) restarted first;",
      "(b) restarted second;",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toEqual([
      "sec4.01",
      "sec4.01(a)",
      "sec4.01(b)",
      "sec4.01(a)@2",
      "sec4.01(b)@2",
    ]);
    expect(skeleton.ladder.restarts).toBe(1);
    expect(readSection(skeleton, "4.01(a)").block?.text).toContain(
      "first item",
    );
  });

  it("marks backward enumerators as violations without corrupting the ladder", () => {
    const text = [
      "Section 5.01 Disorder.",
      "(a) alpha;",
      "(c) skip ahead;",
      "(b) backwards;",
      "(d) resumes;",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    expect(skeleton.ladder.forwardJumps).toBe(1);
    expect(skeleton.ladder.violations).toBe(1);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toContain("sec5.01(c)");
    expect(labels).toContain("sec5.01(b)");
    expect(labels).toContain("sec5.01(d)");
  });

  it("continues a roman ladder across a mid-line opener (open_midcounter)", () => {
    const text = [
      "Section 2.05 Prepayments.",
      "(a) Voluntary Prepayments. The Borrower may prepay.",
      "(b) Mandatory Prepayments. (i) Asset Sales. Prepay within five days.",
      "(ii) Excess Cash Flow. Prepay within ninety days.",
      "(iii) Insurance. Prepay on receipt.",
      "(c) Application of Prepayments.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toContain("sec2.05(b)(ii)");
    expect(labels).toContain("sec2.05(b)(iii)");
    expect(labels).toContain("sec2.05(c)");
    expect(skeleton.ladder.midcounterOpens).toBe(1);
  });
});

// Contract drafting's unbracketed enumerator dialects. Measured over 6,122
// documents (69 LegalBench-RAG agreements + 6,053 A2AJ laws): +8,249 enumerator
// nodes, and the non-subsection projection of every skeleton — container,
// section and schedule labels, depths, spans and headings — byte-identical on
// all 6,122, as is every compileA2AJSourceDoc block. The false-positive hunt
// over all 8,249 new lines, using the shared detectors (citationsInText,
// extractAnchors, isExternalReference), flagged none.
describe("compileAgreementSkeleton: unbracketed enumerator dialects", () => {
  it("reads a closing-paren tail ladder", () => {
    const text = [
      "Section 3.01 Confidential Information.",
      "a) all technical and commercial information disclosed by either party;",
      "b) all analyses, compilations and notes prepared by the Advisors;",
      "c) the fact that discussions are taking place concerning the Purpose.",
    ].join("\n");
    const labels = compileAgreementSkeleton(text).nodes.map((n) => n.label);
    expect(labels).toEqual([
      "sec3.01",
      "sec3.01(a)",
      "sec3.01(b)",
      "sec3.01(c)",
    ]);
  });

  it("reads a dotted alpha ladder and a dotted roman ladder", () => {
    const text = [
      "Section 5.01 Obligations.",
      "a. In general. Subject to the other terms of this agreement:",
      "i. keep the Confidential Information secret and confidential;",
      "ii. not use or exploit the Confidential Information in any way;",
      "iii. establish and maintain adequate security measures.",
      "b. Security precautions. Each of us agrees to the following.",
    ].join("\n");
    const labels = compileAgreementSkeleton(text).nodes.map((n) => n.label);
    expect(labels).toContain("sec5.01(a)");
    expect(labels).toContain("sec5.01(a)(i)");
    expect(labels).toContain("sec5.01(a)(iii)");
    expect(labels).toContain("sec5.01(b)");
  });

  // The ladder IS the filter. `Inc.`, `No.`, `v.` and `s. 231` are the same
  // surface shape as a dotted enumerator; what they cannot do is run. No
  // token blacklist exists or is needed.
  it("never opens a ladder on isolated abbreviations or citations", () => {
    const text = [
      "Section 7.01 Notices.",
      "v. Smith, the arbitrator named below, shall preside.",
      "s. 231 of the Income Tax Act applies to this Agreement.",
      "c. 1985 was the year the predecessor agreement was signed.",
      "ss. 3 to 5 of the Schedule are incorporated by reference.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    expect(skeleton.nodes.map((n) => n.label)).toEqual(["sec7.01"]);
    expect(skeleton.ladder.levelOpens).toBe(0);
  });

  it("requires the run to open at value 1", () => {
    const text = [
      "Section 8.01 Fragments.",
      "d. a fragment quoted out of a longer instrument;",
      "e. another fragment quoted from the same instrument;",
      "f. a third fragment, still with no opening item.",
    ].join("\n");
    expect(compileAgreementSkeleton(text).nodes.map((n) => n.label)).toEqual([
      "sec8.01",
    ]);
  });

  it("leaves a properly bracketed document to the canonical form", () => {
    const text = [
      "Section 9.01 Baskets.",
      "(a) General Basket. The Borrower may incur Indebtedness.",
      "(b) Ratio Basket. Subject to pro forma compliance.",
      "(c) Acquisition Basket. Subject to the Acquisition Conditions.",
    ].join("\n");
    const labels = compileAgreementSkeleton(text).nodes.map((n) => n.label);
    expect(labels).toEqual([
      "sec9.01",
      "sec9.01(a)",
      "sec9.01(b)",
      "sec9.01(c)",
    ]);
  });

  // Both dialects carry only lowercase alpha/roman, so no dialect line can
  // also match a section grammar (all of which need a digit or a
  // container/schedule word). Sections cannot move; only subsections appear.
  it("adds only subsections: the section projection is unchanged", () => {
    const base = [
      "ARTICLE I — DEFINITIONS",
      "Section 1.01 Defined Terms.",
      "Section 1.02 Interpretation.",
      "SCHEDULE 2.01 — EXISTING INDEBTEDNESS",
    ];
    const withLadder = [
      base[0],
      base[1],
      "a. the first interpretive rule stated in this agreement;",
      "b. the second interpretive rule stated in this agreement;",
      "c. the third interpretive rule stated in this agreement.",
      base[2],
      base[3],
    ];
    const projection = (lines: string[]) =>
      compileAgreementSkeleton(lines.join("\n"))
        .nodes.filter((n) => n.kind !== "subsection")
        .map((n) => `${n.kind}|${n.label}|${n.depth}|${n.heading}`);
    expect(projection(withLadder)).toEqual(projection(base));
    expect(
      compileAgreementSkeleton(withLadder.join("\n")).nodes.filter(
        (n) => n.kind === "subsection",
      ),
    ).toHaveLength(3);
  });
});

// The structural gate. sourceDocA2AJ imports sourceDoc and statuteSpine and
// nothing else, so the A2AJ laws-and-cases compiler — the path the 225k-case
// bulk corpus and the skeleton oracle gate travel — cannot reach the dialects
// above. This pins that boundary behaviourally as well as by import graph.
describe("enumerator dialects are unreachable from the A2AJ compiler", () => {
  it("leaves compileA2AJSourceDoc's blocks free of dialect enumerators", () => {
    const text = [
      "1 In this Act, “plan” means the pension plan.",
      "a. the first item of an unbracketed ladder;",
      "b. the second item of an unbracketed ladder;",
      "c. the third item of an unbracketed ladder.",
      "2 The plan continues under this Act.",
      "3 The board administers the plan.",
    ].join("\n");
    const doc = compileA2AJSourceDoc({
      citation: "SO 2000, c 1",
      dataset: "LEGISLATION-ON",
      docType: "laws",
      name: "Example Act",
      text,
    });
    expect(doc.blocks.map((block) => block.label)).toEqual([
      "sec1",
      "sec2",
      "sec3",
    ]);
  });
});

describe("compileAgreementSkeleton: statute style", () => {
  const text = [
    "PART I — GENERAL",
    "1. Short title",
    "This Act may be cited as the Example Act.",
    "2. Definitions",
    'In this Act, "court" means a superior court.',
    "8. (1) A judge may make an order.",
    "(2) An order under subsection (1) takes effect immediately.",
    "PART II — PROCEDURE",
    "9. Applications",
    "An application shall be made in writing.",
  ].join("\n");
  const skeleton = compileAgreementSkeleton(text);
  const labels = skeleton.nodes.map((node) => node.label);

  it("parses Parts, integer sections, and inline first subsections", () => {
    expect(labels).toContain("part1");
    expect(labels).toContain("sec1");
    expect(labels).toContain("sec2");
    expect(labels).toContain("sec8");
    expect(labels).toContain("sec8(1)");
    expect(labels).toContain("sec8(2)");
    expect(labels).toContain("part2");
    expect(labels).toContain("sec9");
  });

  it("keeps a lone page number out of the tree", () => {
    const withPageNumber = compileAgreementSkeleton("23.\nSome text.");
    expect(withPageNumber.nodes).toEqual([]);
  });

  it("serves statute subsections", () => {
    const subsection = readSection(skeleton, "s. 8(2)");
    expect(subsection.status).toBe("found");
    expect(subsection.block?.text).toContain("takes effect immediately");
  });
});

// Corpus statute families (measured by scripts/skeleton-oracle-probe.py +
// skeleton-oracle-diff.ts against the a2aj_structure reference grammar:
// 296/296 structured sample texts exact, 100% label recall).
describe("compileAgreementSkeleton: corpus statute styles", () => {
  it("indexes dotless federal heads through the spine", () => {
    const text = [
      "1 This Act may be cited as the Example Act.",
      "2 The following definitions apply in this Act.",
      "5 The purpose of this Act is to benefit all persons.",
      "5.1 (1) The area of communication is provided for.",
      "7 (1) This Act applies to the following entities:",
      "(a) a department named in Schedule I;",
      "(b) a Crown corporation;",
      "8 Nothing in this Act applies to the Yukon Government.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toContain("sec1");
    expect(labels).toContain("sec5.1");
    expect(labels).toContain("sec5.1(1)");
    expect(labels).toContain("sec7");
    expect(labels).toContain("sec7(1)");
    expect(labels).toContain("sec7(1)(a)");
    expect(labels).toContain("sec7(1)(b)");
    expect(labels).toContain("sec8");
    const served = readSection(skeleton, "s. 7(1)(a)");
    expect(served.status).toBe("found");
    expect(served.block?.text).toContain("Schedule I");
  });

  it("indexes dot-terminated NT/PE heads where no bare marks exist", () => {
    const text = [
      "1. In this Act, “Registrar General” means the registrar.",
      "2. (1) A person who has adopted a child may apply.",
      "(2) The application shall be filed with the court.",
      "3. A certificate filed in the Supreme Court is proof.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toContain("sec1");
    expect(labels).toContain("sec2");
    expect(labels).toContain("sec2(1)");
    expect(labels).toContain("sec2(2)");
    expect(labels).toContain("sec3");
  });

  it("ignores Section-N print running heads when a spine exists", () => {
    const text = [
      "1 In this Act, “plan” means the pension plan.",
      "Section 1",
      "2 The plan continues under this Act.",
      "Section 2",
      "3 The board administers the plan.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const sections = skeleton.nodes.filter((node) => node.kind === "section");
    expect(sections.map((node) => node.label)).toEqual(["sec1", "sec2", "sec3"]);
  });

  it("indexes a lone dotless provision excerpt via the subsection guard", () => {
    const text = [
      "164 (1) A judge may issue a warrant if satisfied that",
      "(a) the recording is obscene; or",
      "(b) the recording is an advertisement.",
    ].join("\n");
    const skeleton = compileAgreementSkeleton(text);
    const labels = skeleton.nodes.map((node) => node.label);
    expect(labels).toContain("sec164");
    expect(labels).toContain("sec164(1)");
    expect(labels).toContain("sec164(1)(a)");
    expect(labels).toContain("sec164(1)(b)");
  });
});

describe("compileAgreementSkeleton: segmentation competition", () => {
  // Every heading below sits mid-line behind a run of spaces, which is what
  // a PDF-to-text extractor leaves when it joins a page into one line.
  const COLLAPSED =
    "MERGER AGREEMENT   ARTICLE I DEFINITIONS   " +
    "1.01 Defined Terms.  Capitalized terms have the meanings given.   " +
    "1.02 Interpretation.  References to Articles are to this Agreement.   " +
    "ARTICLE II THE MERGER   " +
    "2.01 The Merger.  Merger Sub shall merge into the Company as set forth in Section 1.01.   " +
    "2.02 Closing.  The Closing shall occur as provided in Section 2.01 and Section 1.02.   " +
    "2.03 Effective Time.  Subject to Section 2.02, the Effective Time occurs at filing.";

  it("recovers headings the extractor buried mid-line", () => {
    const labels = compileAgreementSkeleton(COLLAPSED).nodes.map((n) => n.label);
    expect(labels).toContain("sec1.01");
    expect(labels).toContain("sec2.03");
    expect(labels).toContain("art2");
  });

  it("keeps offsets valid in the ORIGINAL text, not the recovered one", () => {
    const skeleton = compileAgreementSkeleton(COLLAPSED);
    for (const node of skeleton.nodes) {
      expect(COLLAPSED.slice(node.start, node.end)).not.toMatch(/^\s/u);
    }
    const found = readSection(skeleton, "2.01");
    expect(found.status).toBe("found");
    expect(found.block?.text).toContain("Merger Sub shall merge");
  });

  it("leaves a well-lineated document exactly as it read it", () => {
    const lineated = COLLAPSED.replace(/ {2,}/gu, "\n");
    const recovered = compileAgreementSkeleton(COLLAPSED).nodes.map((n) => n.label);
    expect(compileAgreementSkeleton(lineated).nodes.map((n) => n.label)).toEqual(
      recovered,
    );
  });

  it("refuses to let a reference endorse a provision minted out of itself", () => {
    // "Section 9.99" exists only in prose. A segmentation that turns that
    // prose into a heading must not score for resolving the very reference
    // it was minted from.
    const prose =
      "AGREEMENT   1.01 Term.  This is the term.   " +
      "1.02 Notices.  Notice is given as described.   " +
      "1.03 Remedies.  The Agent may act.  See also Section 9.99 for notices.";
    const labels = compileAgreementSkeleton(prose).nodes.map((n) => n.label);
    expect(labels).not.toContain("sec9.99");
  });

  it("will not adopt a contents page as the document's structure", () => {
    // A contents block whose entries are space-padded, then a body whose
    // headings are not: recovery reveals only the contents, and 12 heads
    // packed into the first 1% of the document are not a structure.
    const body = Array.from(
      { length: 12 },
      (_, i) => `Section ${i + 1}.01 is discussed at length. ${"Filler text. ".repeat(40)}`,
    ).join(" ");
    const contents =
      "TABLE OF CONTENTS   " +
      Array.from({ length: 12 }, (_, i) => `${i + 1}.01 Heading ${i + 1}   `).join("");
    const labels = compileAgreementSkeleton(`${contents}${body}`).nodes.map(
      (n) => n.label,
    );
    expect(labels).not.toContain("sec12.01");
  });
});

describe("compileAgreementSkeleton: single-space line joins", () => {
  const body = (n: number) =>
    `${n}.01 Heading ${n}. The parties agree at length about topic ${n}. ` +
    `This is governed by Section 1.01 and Section 2.01.`;
  // One 'page' per line, lines joined with a single space — no run to split.
  const JOINED = `AGREEMENT DATED TODAY. ${[1, 2, 3, 4, 5].map(body).join(" ")}`;

  it("recovers heads that follow a sentence terminator", () => {
    const labels = compileAgreementSkeleton(JOINED).nodes.map((n) => n.label);
    expect(labels).toContain("sec1.01");
    expect(labels).toContain("sec5.01");
  });

  it("does not mint heads out of a definitions index", () => {
    // Every entry cites a section mid-sentence. None of those citations is a
    // heading, and the ones cited are real heads elsewhere — precisely the
    // shape that made the unguarded version score itself higher.
    const index = [
      '"Balance Sheet Date" has the meaning set forth in Section 6.16.',
      '"Bring-Down Date" has the meaning set forth in Section 3.11.',
      '"Burdensome Condition" has the meaning set forth in Section 6.17.',
    ].join(" ");
    const doc = `AGREEMENT DATED TODAY. 1.01 Definitions. ${index} ${[6, 3].map(body).join(" ")}`;
    const labels = compileAgreementSkeleton(doc).nodes.map((n) => n.label);
    expect(labels).not.toContain("sec6.16");
    expect(labels).not.toContain("sec6.17");
    expect(labels).not.toContain("sec3.11");
  });
});
