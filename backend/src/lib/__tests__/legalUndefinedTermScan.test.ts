/**
 * Tests for legalUndefinedTermScan — the undefined defined-term
 * forward-reference organ. Fixtures are realistic legal sentences (memo,
 * credit agreement, indenture, LLC agreement), not benchmark gold text.
 */
import { describe, expect, it } from "vitest";
import {
  undefinedTermScan,
  type UndefinedTermDocument,
} from "../legalUndefinedTermScan";

describe("legalUndefinedTermScan", () => {
  it("fires when the draft uses a capitalized term with no definition anywhere", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "The Company may make Permitted Tax Distributions each year, and Permitted Tax Distributions are excluded from any annual cap.",
    };
    const findings = undefinedTermScan([], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].term).toBe("Permitted Tax Distributions");
    expect(findings[0].occurrences).toBe(2);
    expect(findings[0].kind).toBe("undefined_defined_term");
  });

  it("stays silent when the term is defined in a source", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: '"Permitted Tax Distributions" means distributions in an amount necessary to fund the equityholders\' tax obligations.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "The Company may make Permitted Tax Distributions under the credit agreement.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("stays silent when the term is defined in the draft itself", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: '"Permitted Tax Distributions" means distributions necessary to fund the owners\' tax obligations. The Company may make Permitted Tax Distributions freely.',
    };
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("stays silent when the term appears only as a quotation/description of the counterparty's text (markup boundary)", () => {
    // A markup-analysis deliverable legitimately QUOTES the counterparty's
    // terms without using them as defined terms.
    const draft: UndefinedTermDocument = {
      name: "markup-analysis",
      text: 'The counterparty\'s agreement defines "Permitted Tax Distributions" as distributions for tax obligations. The scope of that "Permitted Tax Distributions" provision is unclear, and the counterparty left it undefined in the marked-up draft.',
    };
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("stays silent on party names, entity names, captions, titles and jurisdictions", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: [
        "Ridgeline Infrastructure Holdings, Inc. and Cascadia Trust Company, N.A. entered into the indenture.",
        "Definitions and Interpretation",
        "This Indenture is governed by the laws of the State of New York, and the Notes are traded in the United States.",
        "The certificate was signed by the Vice President of the Issuer.",
      ].join("\n"),
    };
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("stays silent on an all-caps legend and a coupon-titled instrument descriptor", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "DRAFT — SUBJECT TO COMPLETION AND FURTHER REVIEW\nThis document is the 8.250% Senior Secured Notes due February 15, 2032 offering.",
    };
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("stays silent when the definition sits in a source the draft is analyzing", () => {
    const source: UndefinedTermDocument = {
      name: "precedent-indenture",
      text: '"Permitted Tax Distributions" means any distribution to equityholders of the Issuer in an amount not exceeding their tax obligations.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "Following the precedent, the Issuer may make Permitted Tax Distributions, and such Permitted Tax Distributions are not counted against the basket.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("fires when the draft uses a term as if defined and the source also leaves it undefined", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: "The Credit Agreement provides a basket for distributions to owners but is silent on any Permitted Tax Distributions.",
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "The Company may make Permitted Tax Distributions under the basket.",
    };
    const findings = undefinedTermScan([source], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].term).toBe("Permitted Tax Distributions");
  });

  it("handles the y/ies plural of a defined term (Restricted Subsidiaries)", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: '"Restricted Subsidiary" means any Subsidiary of the Issuer other than an Unrestricted Subsidiary.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "The Issuer shall not permit any Restricted Subsidiaries to incur Indebtedness.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("dedupes a term that recurs in the draft", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "The Company may make Permitted Tax Distributions in January, Permitted Tax Distributions in July, and further Permitted Tax Distributions in December.",
    };
    const findings = undefinedTermScan([], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(3);
  });

  it("stays silent when the term is used only inside another term's definition body (an enumeration, not a use)", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: '"ABL Priority Collateral" means Accounts, Inventory, Deposit Accounts, Securities Accounts, cash and Cash Equivalents therein, and related Chattel Paper.',
    };
    // "Deposit Accounts" and "Chattel Paper" are capitalized but only appear
    // enumerated inside the ABL Priority Collateral definition, never used
    // operatively — the enumeration boundary, not a forward reference.
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("stays silent when a possessive-prefixed use resolves to a defined head (Issuer's Voting Stock)", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: '"Voting Stock" means capital stock of any class or classes the holders of which are ordinarily entitled to vote.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "A person becomes the beneficial owner of more than 50% of the Issuer's Voting Stock.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("stays silent on the singular of a defined plural term (Credit Facility vs Credit Facilities)", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: '"Credit Facilities" means one or more debt facilities providing for revolving credit loans or term loans.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "Liens securing the Credit Facility basket shall be permitted.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("stays silent when a sentence-initial conjunction precedes a defined term (If Excess Proceeds)", () => {
    const source: UndefinedTermDocument = {
      name: "credit-agreement",
      text: '"Excess Proceeds" means the aggregate Net Cash Proceeds of an Asset Sale less amounts applied to repay Indebtedness.',
    };
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "If Excess Proceeds exceed $30,000,000, the Issuer shall offer to repurchase the Notes.",
    };
    expect(undefinedTermScan([source], draft)).toHaveLength(0);
  });

  it("stays silent when a capitalized phrase appears only as a numbered caption ('8.01 Financial Covenants.')", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "8.01 Financial Covenants.\nThe Borrower must maintain the ratio.",
    };
    expect(undefinedTermScan([], draft)).toHaveLength(0);
  });

  it("still fires when a caption phrase is ALSO used in operative prose", () => {
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: "8.01 Financial Covenants.\nThe Financial Covenants are set forth in this section and the Issuer shall comply with each of them.",
    };
    const findings = undefinedTermScan([], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].term).toBe("Financial Covenants");
  });

  it("caps the number of findings", () => {
    const terms = [
      "Alpha Basket", "Beta Basket", "Gamma Basket", "Delta Basket",
      "Epsilon Basket", "Zeta Basket", "Eta Basket", "Theta Basket",
      "Iota Basket", "Kappa Basket", "Lambda Basket", "Mu Basket",
      "Nu Basket", "Xi Basket",
    ];
    const draft: UndefinedTermDocument = {
      name: "draft",
      text: terms.map((term) => `${term} shall be governed by the policy.`).join(" "),
    };
    const findings = undefinedTermScan([], draft);
    expect(findings.length).toBeLessThanOrEqual(12);
    expect(findings.length).toBe(12);
    expect(new Set(findings.map((f) => f.term)).size).toBe(12);
  });
});
