import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTnaEvidence,
  createLibraryEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidence,
  GROUNDED_QUOTATION_POLICY,
  GROUNDED_QUOTATION_POLICY_CLASSIC,
  GROUNDED_QUOTATION_POLICY_CURRENT,
  hasCaseNameInText,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  legalEvidenceReceiptEvent,
  legalEvidenceRequested,
  priorLegalEvidenceReceipts,
  registerLegalEvidence,
  registerPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  restorePriorLegalEvidence,
  selectGroundedQuotationPolicy,
  submitLegalEvidenceAnswer,
} from "../legalEvidence";
import { createLegalEvidenceCitations } from "../citations";
import { CODING_PRODUCTION_SYSTEM_PROMPT } from "../prompts";
import { a2ajLegalSourceProvider } from "../../legalSources/a2aj";
import { createTextSourceDoc } from "../../sourceDoc";

function passage(locatorLabel = "par12") {
  return createTnaEvidence({
    jurisdiction: "CA",
    sourceClass: "case",
    stableSourceId: "courtlistener:1",
    sourceText: "The appeal is allowed.",
    spanText: "The appeal is allowed.",
    citation: "2024 SCC 1",
    name: "Example v Example",
    dataset: "courtlistener",
    externalUrl: "https://example.test/case",
    locatorKind: "paragraph",
    locatorLabel,
  });
}

describe("production legal evidence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recognizes named cases even when the model omits their citations", () => {
    expect(hasCaseNameInText("My favourite is *R. v. Oakes*.")).toBe(true);
    expect(hasCaseNameInText("I prefer Baker v. Canada for this point.")).toBe(true);
    expect(hasCaseNameInText("The answer is a general explanation.")).toBe(false);

    const state = createLegalEvidenceTurnState();
    expect(finalizeLegalEvidence(state, "My favourite is *R. v. Oakes*.")).toBe(false);
    expect(state.failure).toContain("without verified passages");
    expect(renderLegalEvidenceAnswer(state)).toBeNull();
  });

  it("accepts registered passages and emits durable receipts", () => {
    const state = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    const event = legalEvidenceReceiptEvent(state)!;
    expect(event.status).toBe("passed");
    expect(priorLegalEvidenceReceipts([event])).toEqual([evidence]);
  });

  it("strips DOCX citation-handle markers that leak into chat claims", () => {
    // The model sometimes over-applies the Write.citations "[@id]" marker
    // convention to submit_grounded_answer prose. Pills come from
    // evidence_ids at render time, so the inline token is dropped rather
    // than leaking a raw handle into the answer.
    const state = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: 'Every parent has an obligation [@id1] to provide support.',
      evidence_ids: [evidence.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
    expect(renderLegalEvidenceAnswer(state)).toBe(
      "Every parent has an obligation to provide support. [1]",
    );
  });

  it("uses the approved quotation and paraphrase instruction everywhere", () => {
    expect(GROUNDED_QUOTATION_POLICY_CURRENT).toBe(
      "Prefer direct quotation when the source itself states the proposition. Quote the shortest passage that preserves the source's meaning and necessary context. Paraphrase only when combining sources, explaining their effect, or expressing the point more clearly. Keep each claim to one proposition, and attach only the evidence that supports that proposition. Split the claim when different propositions require different evidence. Avoid long quotations unless their full wording is necessary.",
    );
    expect(selectGroundedQuotationPolicy()).toBe(GROUNDED_QUOTATION_POLICY_CURRENT);
    expect(selectGroundedQuotationPolicy("classic")).toBe(
      GROUNDED_QUOTATION_POLICY_CLASSIC,
    );
    expect(CODING_PRODUCTION_SYSTEM_PROMPT).toContain(GROUNDED_QUOTATION_POLICY);
    expect(LEGAL_EVIDENCE_SUBMIT_TOOL.description).toContain(GROUNDED_QUOTATION_POLICY);
    expect(CODING_PRODUCTION_SYSTEM_PROMPT).toContain(
      "paragraph range (locator plus end_locator)",
    );
    expect(CODING_PRODUCTION_SYSTEM_PROMPT).toContain(
      "Never cite its headnote unless the user specifically requests the headnote.",
    );
    expect(CODING_PRODUCTION_SYSTEM_PROMPT).not.toContain(
      "A successful final Write call ends the turn.",
    );
    expect(CODING_PRODUCTION_SYSTEM_PROMPT).toContain(
      "Use submit_grounded_answer for evidence-dependent prose returned in chat.",
    );
  });

  it("carries an immediate citation correction across the follow-up", () => {
    expect(legalEvidenceRequested([
      { role: "user", content: "Give me a cite." },
      { role: "assistant", content: "Here is one." },
      { role: "user", content: "to the PDF" },
    ])).toBe(true);
    expect(legalEvidenceRequested([
      { role: "user", content: "Read the PDF." },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Tell me more." },
    ])).toBe(false);
  });

  it("persists newly read passages for later turns without grounding the answer", () => {
    const firstTurn = createLegalEvidenceTurnState();
    const evidence = passage();
    registerLegalEvidence(firstTurn, evidence);
    const event = legalEvidenceReceiptEvent(firstTurn)!;
    expect(event).toMatchObject({ mode: null, status: "passed", claims: [] });
    expect(event.evidence).toEqual([evidence]);

    const followUp = createLegalEvidenceTurnState();
    registerPriorLegalEvidence(followUp, priorLegalEvidenceReceipts([event]));
    expect(legalEvidenceReceiptEvent(followUp)).toBeNull();
    expect(followUp.evidence.get(evidence.evidence_id)?.receipt).toEqual(evidence);
  });

  it("restores a prior A2AJ receipt against its unchanged full source", async () => {
    const text = [
      "Delay in seeking child support may arise for unrelated reasons.",
      "Delay in seeking child support requires a distinct final proposition.",
    ].join("\n");
    const source = createTextSourceDoc(text);
    const receipt = {
      ...passage("par101"),
      provider: "a2aj" as const,
      stable_source_id: "a2aj:en:scc:2006 scc 37",
      source_sha256: `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`,
      citation: "2006 SCC 37",
      dataset: "SCC",
      external_url:
        "https://www.canlii.org/en/ca/scc/doc/2006/2006scc37/2006scc37.html",
      resolver_version: "a2aj-inline-v1" as const,
    };
    const document = {
      docType: "cases" as const,
      dataset: "SCC",
      citation: "2006 SCC 37",
      alternateCitation: null,
      name: "D.B.S. v S.R.G.",
      date: "2006-07-31",
      url: receipt.external_url,
      text,
      language: "en" as const,
      upstreamLicense: null,
      structure: {
        status: "unavailable" as const,
        source: "flat_text" as const,
        counts: { paragraph: 0, page: 0, section: 0 },
      },
    };
    vi.spyOn(a2ajLegalSourceProvider, "document").mockResolvedValue(document);
    vi.spyOn(a2ajLegalSourceProvider, "source").mockReturnValue(source);

    expect(await restorePriorLegalEvidence([receipt])).toEqual([{
      receipt,
      document,
      source,
    }]);
  });

  it("emits typed public-source citations from provider receipts", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createTnaEvidence({
      jurisdiction: "UK",
      sourceClass: "case",
      stableSourceId: "uksc/2026/1:page-3",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      citation: "Example v State",
      dataset: "tna",
      externalUrl: "https://example.test/judgment.pdf#page=3",
      locatorKind: "page",
      locatorLabel: "page=3",
    });
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({
        kind: "public_legal",
        ref: 1,
        provider: "tna",
        identifier: "uksc/2026/1:page-3",
        url: expect.stringContaining("judgment.pdf#page=3:~:text="),
      }),
    ]);
  });

  it("emits document citations for attached PDF passages", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createLibraryEvidence({
      documentId: "document-1",
      versionId: "version-1",
      filename: "record.pdf",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      start: 0,
      end: 22,
      blockId: "pdf:page-5",
      locator: { kind: "page", label: "page 5" },
    });
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);

    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({
        kind: "document",
        ref: 1,
        document_id: "document-1",
        version_id: "version-1",
        filename: "record.pdf",
        quotes: [{ quote: "The appeal is allowed." }],
      }),
    ]);
  });

  it("rejects unknown evidence and keeps citation presentation out of prose", () => {
    const rejected = createLegalEvidenceTurnState();
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "Unsupported.",
      evidence_ids: ["e_missing"],
    }] }, rejected).ok).toBe(false);

    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = passage();
    registerLegalEvidence(state, evidence);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The appeal is allowed.",
      evidence_ids: [evidence.evidence_id],
    }] }, state);
    expect(renderLegalEvidenceAnswer(state)).toBe("The appeal is allowed. [1]");
  });

  it("rejects paragraph-sized claims and broad evidence bundles", () => {
    const state = createLegalEvidenceTurnState();
    const evidence = ["par1", "par2", "par3", "par4", "par5"].map(passage);
    evidence.forEach((receipt) => registerLegalEvidence(state, receipt));

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "x".repeat(1_201),
      evidence_ids: [evidence[0].evidence_id],
    }] }, state).errors).toContain("claims[0].text is invalid");
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "One proposition.",
      evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
    }] }, state).errors).toContain(
      "claims[0].evidence_ids must contain 1 to 4 unique handles",
    );
  });

  it("attaches each verified passage without synthesizing citation text or URLs", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const first = passage();
    const second = passage("par13");
    registerLegalEvidence(state, first);
    registerLegalEvidence(state, second);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The court allowed the appeal.",
      evidence_ids: [first.evidence_id, second.evidence_id],
    }] }, state);

    const rendered = renderLegalEvidenceAnswer(state)!;
    expect(rendered).toBe("The court allowed the appeal. [1][2]");
    expect(rendered).not.toContain("http");
    expect(rendered.match(/\[\d+\]/gu)).toHaveLength(
      createLegalEvidenceCitations(state).length,
    );
  });

  it("rejects an unstructured legal draft", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    registerLegalEvidence(state, passage());
    expect(finalizeLegalEvidence(state, "Example v Example allowed the appeal.")).toBe(false);
    expect(state.failure).toBe("The model did not submit a grounded answer.");
  });

  it("runs quote and unmarked-copy gates at grounded submission", () => {
    const quoteSource = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:quote",
      sourceText: "The busybody must decide 12 motions, promptly, before the hearing continues.",
      spanText: "The busybody must decide 12 motions, promptly, before the hearing continues.",
      citation: "2024 SCC 2",
      name: "Quote v Example",
      dataset: "fixture",
      externalUrl: "https://example.test/quote",
      locatorKind: "paragraph",
      locatorLabel: "par9",
    });
    const copiedSource = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:copy",
      sourceText: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      spanText: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      citation: "2024 SCC 3",
      name: "Copy v Example",
      dataset: "fixture",
      externalUrl: "https://example.test/copy",
      locatorKind: "paragraph",
      locatorLabel: "par10",
    });
    const state = createLegalEvidenceTurnState();
    registerLegalEvidence(state, quoteSource);
    registerLegalEvidence(state, copiedSource);

    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The court wrote, \u201cThe busybody may decide 12 motions, promptly, before the hearing continues.\u201d",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state).errors?.[0]).toContain("does not match");
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "Courts should not decide constitutional issues in a factual vacuum without evidence.",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state).errors?.[0]).toContain(copiedSource.evidence_id);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The court wrote, \u201c[T]he busybod[ies] must decide 12 motions, promptly, before the hearing continues.\u201d",
      evidence_ids: [quoteSource.evidence_id],
    }] }, state)).toEqual({ ok: true, terminal: true });
  });
});
