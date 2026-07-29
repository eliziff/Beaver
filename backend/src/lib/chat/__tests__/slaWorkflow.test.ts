import { describe, expect, it } from "vitest";

import { auditSlaDraft, type SlaLedger } from "../slaWorkflow";

const SOURCE = [
  "8.01 Financial Covenants.",
  "",
  "(a) The Borrower shall not permit the Total Net Leverage Ratio to exceed 4.50:1.00 at any time before December 31, 2024.",
  "",
  "(b) Minimum Liquidity of $5,000,000 must be maintained, tested as of March 15, 2025 under Section 6.02.",
].join("\n");

const ledger: SlaLedger = {
  documents: [{ name: "credit-agreement.docx", text: SOURCE }],
  promptSection: "",
};

describe("auditSlaDraft", () => {
  it("flags source anchors missing from the draft and unsourced draft anchors", () => {
    const draft =
      "The covenant requires Minimum Liquidity of $5,000,000 under Section 6.02, tested against a threshold of $7,250,000.";
    const audit = auditSlaDraft(ledger, draft);
    expect(audit.repairPrompt).toBeTruthy();
    // Missing from the draft: the date anchors and Section 8.01.
    expect(audit.repairPrompt).toContain("absent from your deliverable");
    expect(audit.repairPrompt).toContain("no match in any source document");
    expect(audit.repairPrompt).toContain("$7,250,000");
    expect(audit.receipt.source_only_total).toBeGreaterThan(0);
    expect(audit.receipt.draft_only_total).toBeGreaterThan(0);
    expect(audit.receipt.matched_total).toBeGreaterThan(0);
  });

  it("returns no repair prompt when the draft covers the anchors", () => {
    const audit = auditSlaDraft(ledger, SOURCE);
    expect(audit.repairPrompt).toBeNull();
    expect(audit.receipt.source_only_total).toBe(0);
    expect(audit.receipt.draft_only_total).toBe(0);
  });
});
