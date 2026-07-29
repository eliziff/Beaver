import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { auditSlaDraft, type SlaLedger } from "../slaWorkflow";

const SOURCE = [
  "8.01 Financial Covenants.",
  "",
  "(a) The Borrower shall not permit the Total Net Leverage Ratio to exceed 4.50:1.00 at any time before December 31, 2024.",
  "",
  "(b) Minimum Liquidity of $5,000,000 must be maintained, tested as of March 15, 2025 under Section 6.02.",
].join("\n");

/** Mirrors MAX_FINDING_ROWS_PER_CLASS in slaWorkflow. */
const MAX_ROWS = 12;

const ledger: SlaLedger = {
  documents: [{ name: "credit-agreement.docx", text: SOURCE }],
  promptSection: "",
  baseline: new Map(),
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
    // Chat-text deliverable: repair asks for the full revised text.
    expect(audit.repairPrompt).toContain("COMPLETE revised deliverable");
  });

  it("names the anchors in the receipt so totals can be checked", () => {
    const draft =
      "The covenant requires Minimum Liquidity of $5,000,000 under Section 6.02, tested against a threshold of $7,250,000.";
    const audit = auditSlaDraft(ledger, draft);
    expect(audit.receipt.classes.money.draft_only_rows).toContain("$7,250,000");
    expect(audit.receipt.classes.date.source_only_rows).toContain(
      "December 31, 2024",
    );
    // Every counted anchor is accounted for by a named row (up to the cap).
    for (const coverage of Object.values(audit.receipt.classes)) {
      expect(coverage.source_only_rows.length).toBe(
        Math.min(coverage.source_only, MAX_ROWS),
      );
      expect(coverage.draft_only_rows.length).toBe(
        Math.min(coverage.draft_only, MAX_ROWS),
      );
    }
  });

  it("returns no repair prompt when the draft covers the anchors", () => {
    const audit = auditSlaDraft(ledger, SOURCE);
    expect(audit.repairPrompt).toBeNull();
    expect(audit.receipt.source_only_total).toBe(0);
    expect(audit.receipt.draft_only_total).toBe(0);
  });

  it("directs artifact deliverables to tool-based revision", () => {
    const audit = auditSlaDraft(ledger, "Deliverable created.", {
      artifactDeliverable: true,
    });
    expect(audit.repairPrompt).toContain("library tools");
    expect(audit.repairPrompt).not.toContain("COMPLETE revised deliverable");
  });
});

const ledgerOf = (...documents: { name: string; text: string }[]): SlaLedger => ({
  documents,
  promptSection: "",
  baseline: new Map(),
});

/** No anchors, no definitions, one modal register: every organ silent. */
const CLEAN =
  "The Supplier must provide the services with reasonable skill and care.";

describe("auditSlaDraft composed organs", () => {
  it("flags arithmetic in the draft that does not close", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "lease.docx",
        text: "Tenant leases 30,000 SF of the 120,000 SF premises (25% of the premises).",
      }),
      "Tenant leases 30,000 SF of the 120,000 SF premises (30% of the premises).",
    );
    expect(audit.receipt.conflict.findings).toBeGreaterThanOrEqual(1);
    expect(audit.repairPrompt).toContain("Arithmetic in your deliverable");
    expect(audit.receipt.conflict.finding_details[0]).toMatch(/^draft: /u);
  });

  it("separates a source-vs-source disagreement from the drafter's own", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "note.docx",
        text: "Borrower prepaid $300,000 of the $1,000,000 principal, a 25% reduction.",
      }),
      "The prepayment is described in the loan file.",
    );
    expect(audit.repairPrompt).toContain("source documents disagree on");
    expect(audit.repairPrompt).not.toContain("Arithmetic in your deliverable");
    expect(audit.receipt.conflict.finding_details[0]).toMatch(/^sources: /u);
  });

  it("flags a defined term the draft redefines", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "credit.docx",
        text: '"Business Day" means a day on which banks are open in Toronto.',
      }),
      '"Business Day" means a day on which banks are open in Calgary.',
    );
    expect(audit.receipt.term_drift.divergent).toBe(1);
    expect(audit.receipt.term_drift.terms).toEqual(["Business Day"]);
    expect(audit.repairPrompt).toContain("Defined terms whose definitions differ");
    expect(audit.repairPrompt).toContain("Calgary");
  });

  it("counts lint warnings without spending a revision pass on them", () => {
    const audit = auditSlaDraft(
      ledgerOf({ name: "msa.docx", text: CLEAN }),
      `${CLEAN} The Supplier and/or the Customer must give notice of termination.`,
    );
    expect(audit.receipt.drafting_lint.errors).toBe(0);
    expect(audit.receipt.drafting_lint.warnings).toBe(1);
    expect(audit.repairPrompt).toBeNull();
  });

  it("spends the revision pass on a lint error", () => {
    const audit = auditSlaDraft(
      ledgerOf({ name: "msa.docx", text: CLEAN }),
      `${CLEAN} The Supplier must shall give notice of termination.`,
    );
    expect(audit.receipt.drafting_lint.errors).toBe(1);
    expect(audit.repairPrompt).toContain("Drafting lint");
    expect(audit.repairPrompt).toContain("stacked-modals");
  });

  it("reports the new receipt fields zeroed on a clean draft", () => {
    const audit = auditSlaDraft(ledgerOf({ name: "msa.docx", text: CLEAN }), CLEAN);
    expect(audit.repairPrompt).toBeNull();
    expect(audit.receipt.conflict).toEqual({
      findings: 0,
      consistent: 0,
      finding_details: [],
    });
    expect(audit.receipt.term_drift).toEqual({ divergent: 0, terms: [] });
    expect(audit.receipt.drafting_lint).toEqual({
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });
});

describe("collectSlaDeliverable", () => {
  let home: string | null = null;
  const userId = "00000000-0000-0000-0000-000000000001";

  afterEach(async () => {
    delete process.env.MIKE_LOCAL_DATA_DIR;
    delete process.env.OPEN_LEGAL_DATA_HOME;
    vi.resetModules();
    if (home) {
      await rm(home, { recursive: true, force: true });
      home = null;
    }
  });

  const docxFrom = (paragraphs: string[]) =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            children: paragraphs.map(
              (text) => new Paragraph({ children: [new TextRun(text)] }),
            ),
          },
        ],
      }),
    );

  it("folds documents created or revised after the ledger snapshot into the audit", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-sla-deliverable-"));
    process.env.MIKE_LOCAL_DATA_DIR = home;
    process.env.OPEN_LEGAL_DATA_HOME = home;
    // The static imports above bound the store graph to the default data
    // home; rebind it to the temp home before touching the store.
    vi.resetModules();
    const store = await import("../../localDocumentStore");
    const workflow = await import("../slaWorkflow");

    await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "credit-agreement.docx",
      bytes: await docxFrom(SOURCE.split("\n").filter(Boolean)),
    });
    const built = await workflow.buildSlaLedger(userId, null);
    expect(built).not.toBeNull();
    const liveLedger = built!;
    expect(liveLedger.baseline.size).toBe(1);

    // The smoke-run shape: chat text alone carries no anchors.
    const chatOnly = await workflow.collectSlaDeliverable(
      userId,
      liveLedger,
      "I've created the intake summary document.",
    );
    expect(chatOnly.artifacts).toEqual([]);
    expect(
      workflow.auditSlaDraft(liveLedger, chatOnly.text).receipt.matched_total,
    ).toBe(0);

    // A document created after the snapshot is the deliverable.
    await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "intake-summary.docx",
      bytes: await docxFrom(SOURCE.split("\n").filter(Boolean)),
    });
    const listed = await store.listLocalLibrary(userId, "file");
    expect(listed.documents.map((doc) => doc.filename).sort()).toEqual([
      "credit-agreement.docx",
      "intake-summary.docx",
    ]);
    const withArtifact = await workflow.collectSlaDeliverable(
      userId,
      liveLedger,
      "I've created the intake summary document.",
    );
    expect(withArtifact.artifacts).toEqual(["intake-summary.docx"]);
    const audit = workflow.auditSlaDraft(liveLedger, withArtifact.text, {
      artifactDeliverable: true,
    });
    expect(audit.receipt.source_only_total).toBe(0);
    expect(audit.receipt.matched_total).toBeGreaterThan(0);
  });
});
