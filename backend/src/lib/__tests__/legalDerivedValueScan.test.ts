/**
 * Tests for legalDerivedValueScan — the percent-of-base carry-through
 * omission organ. Fixtures are representative real legal sentences (memo
 * + agreement), not benchmark text.
 */
import { describe, expect, it } from "vitest";
import {
  derivedValueScan,
  type DerivedValueDocument,
} from "../legalDerivedValueScan";

// The memo sentences that stated the $22.1M / 25.3% / $87.3M identity
// (real deal-overview memo, FY2024 revenue).
const MEMO_SOURCE: DerivedValueDocument = {
  name: "overview-memo",
  text: `Aldersgate reported total revenue of $87,300,000 for fiscal year 2024. As of March 31, 2025, annualized recurring revenue was $91,600,000. This demand forecasting module generates approximately $22.1 million in annual revenue, representing 25.3% of the Company's total 2024 revenue. The Pinnacle license covers Patent Nos. US 10,892,441; US 11,234,567. The table below summarizes revenue composition: Pinnacle-Licensed Demand Forecasting Module $22,100,000 25.3% Revenue attributable across the customer base to demand forecasting functionality.`,
};

describe("legalDerivedValueScan", () => {
  it("flags a percent carried without its stated amount (percent_without_amount)", () => {
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The Pinnacle license powers the demand forecasting module, supporting approximately 25.3% of total revenue. Loss of exclusivity is a severe value impairment.",
    };
    const findings = derivedValueScan([MEMO_SOURCE], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe("percent_without_amount");
    expect(findings[0].base).toBe("revenue");
    expect(findings[0].part.display).toContain("22.1");
    expect(findings[0].percent.value).toBeCloseTo(25.3, 1);
    expect(findings[0].whole.value).toBeCloseTo(87_300_000, 0);
  });

  it("flags an amount carried without its stated percent (amount_without_percent)", () => {
    const source: DerivedValueDocument = {
      name: "overview-memo",
      text: "Aldersgate reported total revenue of $87,300,000 for fiscal year 2024. Apex Manufacturing and Orion Logistics together account for 27.4% of 2024 revenue ($23,900,000 in combined annual contract value).",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "Apex Manufacturing and Orion Logistics represent $23,900,000 in combined annual contract value, the company's most concentrated relationships.",
    };
    const findings = derivedValueScan([source], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe("amount_without_percent");
    expect(findings[0].percent.value).toBeCloseTo(27.4, 1);
    expect(findings[0].part.value).toBeCloseTo(23_900_000, 0);
  });

  it("stays silent when the draft carries both halves", () => {
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The demand forecasting module generates approximately $22.1 million in annual revenue, representing 25.3% of total revenue.",
    };
    expect(derivedValueScan([MEMO_SOURCE], draft)).toHaveLength(0);
  });

  it("stays silent when the draft carries neither half (coverage gap, not carry-through)", () => {
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The Pinnacle license is exclusive within the supply chain field of use and materially important to operations.",
    };
    expect(derivedValueScan([MEMO_SOURCE], draft)).toHaveLength(0);
  });

  it("never binds threshold percents ('more than fifty percent')", () => {
    const source: DerivedValueDocument = {
      name: "agreement",
      text: "Change of control means the direct or indirect acquisition of more than fifty percent of the outstanding voting securities of the Company, valued at $10,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "A change of control includes acquisition of more than fifty percent of voting securities.",
    };
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("never binds rate / escalation / fee-point percents", () => {
    const source: DerivedValueDocument = {
      name: "agreement",
      text: "The Purchase Commitment escalates at a rate of three percent annually. The Distribution Fee is fourteen percent of Net Revenue. The minimum purchase commitment is $24,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The Purchase Commitment escalates at three percent annually; the Distribution Fee is fourteen percent; the minimum commitment is $24,000,000.",
    };
    // 14% of Net Revenue is a rate (no money pair), 3% is an escalation,
    // "14%" near "$24,000,000" must not bind ($24M/14% has no stated whole).
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("dedupes a pair restated in prose and table", () => {
    const source: DerivedValueDocument = {
      name: "memo",
      text: "The module generates $22.1 million, representing 25.3% of total revenue. Total revenue was $87,300,000. Table: Demand Forecasting Module $22,100,000 25.3%.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The module supports 25.3% of total revenue.",
    };
    expect(derivedValueScan([source], draft)).toHaveLength(1);
  });

  it("does not bind a draft percent that is a different claim (value-only collision)", () => {
    const source: DerivedValueDocument = {
      name: "market-report",
      text: "Specialty coatings industry revenue was $1,620 million; Lakeshore's revenue of approximately $120 million represented approximately 7% of industry revenue.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "Meridian pricing was 4%–7% below Lakeshore's initial bid in three of five head-to-head situations, and a deck projected 8%–12% price increases.",
    };
    // The draft's 7% and 12% anchors are pricing comparisons, not "of
    // <base>" claims — a bare percent is a different claim, never the engaged
    // half of the source identity (measured: 8 such cross-family false
    // findings on the antitrust + indenture stacks).
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("does not bind a draft percent naming a different base", () => {
    const source: DerivedValueDocument = {
      name: "acquisition-agreement",
      text: "Fundamental Representations are subject to an indemnification cap of $30,000,000 (5% of the purchase price of $580,000,000).",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "A Significant Subsidiary is defined using a 5% threshold under Regulation S-X; the Issuer may repurchase Notes at 101% of principal amount.",
    };
    // The draft's "5%" is a significance threshold, not a 5% of purchase
    // price claim — base mismatch means no engagement.
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("never binds totality percents ('100% of the Equity Interests')", () => {
    const source: DerivedValueDocument = {
      name: "credit-agreement",
      text: "The Lender holds a security interest in 100% of the Equity Interests of each Domestic Subsidiary, valued at $15,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The collateral package includes the Equity Interests of each Domestic Subsidiary, valued at $15,000,000.",
    };
    // 100% is a totality statement, not a share of a pool: there is no
    // derived value for the reader to size.
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("requires the whole to close the identity (part/whole ≈ percent)", () => {
    const source: DerivedValueDocument = {
      name: "memo",
      text: "The module generates $22.1 million, representing 25.3% of total revenue. The credit facility is $15,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The module supports 25.3% of total revenue.",
    };
    // No whole ≈ $87.3M stated, so no closed identity — stay silent rather
    // than guess (refusal beats guessing).
    expect(derivedValueScan([source], draft)).toHaveLength(0);
  });

  it("closes an identity whose whole lives in a different source (C2 percent_without_amount)", () => {
    const dealMemo: DerivedValueDocument = {
      name: "deal-memo",
      text: "The transaction consideration of $22.1 million represents 25.3% of total revenue.",
    };
    const exhibit: DerivedValueDocument = {
      name: "financial-exhibit",
      text: "For the fiscal year ended December 31, 2024, total revenue was $87,300,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The transaction consideration represents 25.3% of total revenue.",
    };
    const findings = derivedValueScan([dealMemo, exhibit], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe("percent_without_amount");
    expect(findings[0].part.display).toContain("22.1");
    expect(findings[0].whole.value).toBeCloseTo(87_300_000, 0);
    expect(findings[0].whole.document).toBe("financial-exhibit");
    expect(findings[0].detail).toContain("whole from financial-exhibit");
  });

  it("closes an amount-without-percent identity whose whole lives in another source (C2)", () => {
    const termSheet: DerivedValueDocument = {
      name: "term-sheet",
      text: "The purchase price is $63,000,000, which equals 15% of enterprise value.",
    };
    const valuation: DerivedValueDocument = {
      name: "valuation-report",
      text: "Based on the latest round, enterprise value is $420,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The purchase price is $63,000,000.",
    };
    const findings = derivedValueScan([termSheet, valuation], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].direction).toBe("amount_without_percent");
    expect(findings[0].percent.value).toBeCloseTo(15, 0);
    expect(findings[0].whole.value).toBeCloseTo(420_000_000, 0);
    expect(findings[0].whole.document).toBe("valuation-report");
    expect(findings[0].detail).toContain("whole from valuation-report");
  });

  it("does not bind a cross-document money that fails arithmetic closure (C2)", () => {
    const dealMemo: DerivedValueDocument = {
      name: "deal-memo",
      text: "The transaction consideration of $22.1 million represents 25.3% of total revenue.",
    };
    const exhibit: DerivedValueDocument = {
      name: "financial-exhibit",
      text: "For the fiscal year ended December 31, 2024, total revenue was $87,300,000, while total cost of sales was $41,000,000.",
    };
    const draft: DerivedValueDocument = {
      name: "draft",
      text: "The transaction consideration represents 25.3% of total revenue.",
    };
    // $22.1M / $41.0M = 53.9% — fails closure against 25.3%, so the exhibit's
    // cost-of-sales figure must not bind as the whole. The identity closes only
    // against $87.3M.
    const findings = derivedValueScan([dealMemo, exhibit], draft);
    expect(findings).toHaveLength(1);
    expect(findings[0].whole.value).toBeCloseTo(87_300_000, 0);
    expect(findings[0].whole.document).toBe("financial-exhibit");
  });
});
