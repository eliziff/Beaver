import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditSlaDraft,
  greenfieldReviewPayload,
  greenfieldReviewRepairPrompt,
  normalizeGreenfieldFindings,
  requestsOperativeDrafting,
  type SlaLedger,
} from "../slaWorkflow";

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
  it("records lexical anchor differences without spending a repair pass", () => {
    const draft =
      "The covenant requires Minimum Liquidity of $5,000,000 under Section 6.02, tested against a threshold of $7,250,000.";
    const audit = auditSlaDraft(ledger, draft);
    expect(audit.repairPrompt).toBeNull();
    expect(audit.receipt.source_only_total).toBeGreaterThan(0);
    expect(audit.receipt.draft_only_total).toBeGreaterThan(0);
    expect(audit.receipt.matched_total).toBeGreaterThan(0);
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
    const audit = auditSlaDraft(ledger, "The Borrower must shall comply.", {
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

  it("records a source-vs-source disagreement without forcing it into the draft", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "note.docx",
        text: "Borrower prepaid $300,000 of the $1,000,000 principal, a 25% reduction.",
      }),
      "The prepayment is described in the loan file.",
    );
    expect(audit.repairPrompt).toBeNull();
    expect(audit.receipt.conflict.finding_details[0]).toMatch(/^sources: /u);
  });

  it("records memo term drift without spending a repair pass", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "credit.docx",
        text: '"Business Day" means a day on which banks are open in Toronto.',
      }),
      '"Business Day" means a day on which banks are open in Calgary.',
    );
    expect(audit.receipt.term_drift.divergent).toBe(1);
    expect(audit.receipt.term_drift.terms).toEqual(["Business Day"]);
    expect(audit.receipt.term_drift.repair_eligible).toBe(false);
    expect(audit.repairPrompt).toBeNull();
  });

  it("repairs term drift for a blindly recognized operative drafting task", () => {
    const audit = auditSlaDraft(
      ledgerOf({
        name: "credit.docx",
        text: '"Business Day" means a day on which banks are open in Toronto.',
      }),
      '"Business Day" means a day on which banks are open in Calgary.',
      { requestContext: "Please redline the credit agreement." },
    );
    expect(audit.receipt.term_drift.repair_eligible).toBe(true);
    expect(audit.repairPrompt).toContain("Defined terms redefined by your deliverable");
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
    expect(audit.receipt.term_drift).toEqual({
      divergent: 0,
      terms: [],
      repair_eligible: false,
    });
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
    delete process.env.MIKE_SLA_STRATEGY;
    delete process.env.MIKE_SLA_WORKFLOW;
    delete process.env.MIKE_NAV_SHAPE;
    delete process.env.MIKE_TOOL_SHAPE;
    delete process.env.MIKE_RETRIEVAL_EXPERIMENT;
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
    expect(liveLedger.promptSection).toContain("Gated deterministic checks");
    expect(liveLedger.promptSection).not.toContain("library_outline");
    expect(liveLedger.promptSection).not.toContain("credit-agreement.docx");

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
    expect(withArtifact.text).not.toContain("I've created");
    const audit = workflow.auditSlaDraft(liveLedger, withArtifact.text, {
      artifactDeliverable: true,
    });
    expect(audit.receipt.source_only_total).toBe(0);
    expect(audit.receipt.matched_total).toBeGreaterThan(0);
  });

  it("expresses the full SLA strategy without legacy retrieval vocabulary", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-sla-strategy-"));
    process.env.MIKE_LOCAL_DATA_DIR = home;
    process.env.OPEN_LEGAL_DATA_HOME = home;
    process.env.MIKE_SLA_STRATEGY = "full";
    vi.resetModules();
    const store = await import("../../localDocumentStore");
    const workflow = await import("../slaWorkflow");
    await store.createLocalDocument({
      userId,
      kind: "file",
      filename: "source.docx",
      bytes: await docxFrom(["1. Source clause."]),
    });
    const built = await workflow.buildSlaLedger(userId, null);
    expect(built?.promptSection).toContain("Spec → Ledger → Draft → Audit → Grounding");
    expect(built?.promptSection).toContain("source-addressed working ledger");
    expect(built?.promptSection).toContain("revise the actual artifact");
    expect(built?.promptSection).not.toContain("library_outline");
    expect(built?.promptSection).not.toContain("library_read");

    process.env.MIKE_SLA_STRATEGY = "working_set_first";
    const workingSet = await workflow.buildSlaLedger(userId, null);
    expect(workingSet?.promptSection).toContain(
      'first source-content retrieval must be Grep with output_mode="working_set"',
    );
    expect(workingSet?.promptSection).toContain("Glob may enumerate filenames first");
    expect(workingSet?.promptSection).toContain("result contains the newly added evidence");
    expect(workingSet?.promptSection).toContain('never "." or ".*"');
  });

  it("removes host-run quality checks from the callable surface", async () => {
    process.env.MIKE_SLA_WORKFLOW = "1";
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h9-accretive-union";
    vi.resetModules();
    const tools = await import("../localAssistantTools");
    const names = tools.LOCAL_ASSISTANT_TOOLS.map((entry) => entry.function.name);
    expect(names).toContain("Grep");
    expect(names).not.toContain("library_anchor_coverage");
    expect(names).not.toContain("library_conflict_scan");
    expect(names).not.toContain("library_term_drift");
    expect(names).not.toContain("library_drafting_lint");
    expect(names).not.toContain("library_lint_docx_structure");
  });
});

describe("requestsOperativeDrafting", () => {
  it.each([
    "Draft a loan agreement.",
    "Please revise the confidentiality clause.",
    "Mark up the lease for the tenant.",
    "Conform the policy to the new regulation.",
    "The parties are revising several covenants.",
    "Prepare amendments to the leases.",
  ])("recognizes operative work: %s", (request) => {
    expect(requestsOperativeDrafting(request)).toBe(true);
  });

  it.each([
    "Draft a memo analyzing this agreement.",
    "Prepare a diligence report on the lease.",
    "Summarize the definitions in the contract.",
    "Research whether this clause is enforceable.",
    "Prepare a review of the amendments to the leases.",
  ])("does not turn analytical work into drafting: %s", (request) => {
    expect(requestsOperativeDrafting(request)).toBe(false);
  });

  it("uses artifact semantics without benchmark-specific wording", () => {
    expect(requestsOperativeDrafting("Please handle this.", ["lease-amendment.docx"])).toBe(true);
    expect(requestsOperativeDrafting("Please handle this.", ["lease-analysis-memo.docx"])).toBe(false);
    expect(requestsOperativeDrafting("Please handle this.", ["lease-review.docx"])).toBe(false);
  });
});

describe("greenfield stimulus review contract", () => {
  it("contains only the request, sources, and candidate deliverable", () => {
    const payload = greenfieldReviewPayload(
      ledgerOf({ name: "source.docx", text: "Source fact." }),
      "Prepare the requested work product.",
      "Candidate text.",
    );
    expect(Object.keys(payload).sort()).toEqual([
      "candidate_deliverable",
      "request",
      "source_documents",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/rubric|expected answer|tool trace/iu);
  });

  it("caps and validates terse source-grounded findings", () => {
    const findings = normalizeGreenfieldFindings({
      findings: Array.from({ length: 8 }, (_, index) => ({
        issue: `Issue ${index}`,
        source_document: "source.docx",
        source_excerpt: "Exact support.",
        correction: "Correct it.",
      })),
    });
    expect(findings).toHaveLength(6);
    expect(
      greenfieldReviewRepairPrompt(findings.slice(0, 1), true),
    ).toContain("Revise the deliverable itself with the library tools");
    expect(greenfieldReviewRepairPrompt([], false)).toBeNull();
  });
});

describe("auditSlaDraft temporal organ", () => {
  const ledgerOf = (text: string) => ({
    documents: [{ name: "engagement.txt", text }],
    promptSection: "",
    baseline: new Map<string, string>(),
  });

  it("records source-only deadline conflicts without spending the pass", () => {
    const audit = auditSlaDraft(
      ledgerOf(
        "The review period runs forty-five (45) days after the Start Date of March 1, 2025, that is, until April 20, 2025.",
      ),
      "A summary that restates nothing numeric.",
    );
    expect(audit.receipt.temporal.findings).toBe(1);
    expect(audit.receipt.temporal.finding_details[0]).toContain("sources:");
    expect(audit.repairPrompt).toBeNull();
  });

  it("stays silent when the stated date closes exactly", () => {
    const audit = auditSlaDraft(
      ledgerOf(
        "The review period runs forty-five (45) days after the Start Date of March 1, 2025, that is, April 15, 2025.",
      ),
      "A summary that restates nothing numeric.",
    );
    expect(audit.receipt.temporal.findings).toBe(0);
    expect(audit.receipt.temporal.consistent).toBeGreaterThanOrEqual(1);
  });
});
