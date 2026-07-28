import { describe, expect, it } from "vitest";

import {
  compileAgreementSkeleton,
  readSection,
  renderAgreementOutline,
} from "../legalTextSkeleton";

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
