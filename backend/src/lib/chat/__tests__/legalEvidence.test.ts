import { describe, expect, it } from "vitest";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidence,
  hasCaseNameInText,
  legalEvidenceReceiptEvent,
  priorLegalEvidenceReceipts,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
} from "../legalEvidence";
import { createLegalEvidenceCitations } from "../citations";

function passage(locatorLabel = "par12") {
  return createBenchmarkEvidence({
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

  it("emits typed public-source citations from provider receipts", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const evidence = createBenchmarkEvidence({
      jurisdiction: "UK",
      sourceClass: "case",
      stableSourceId: "tna:uksc/2026/1:page-3",
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

    expect(createLegalEvidenceCitations(state)).toEqual([
      expect.objectContaining({
        kind: "public_legal",
        provider: "tna",
        identifier: "uksc/2026/1:page-3",
        url: expect.stringContaining("judgment.pdf#page=3:~:text="),
      }),
    ]);
  });

  it("rejects unknown evidence and renders linked citation structure", () => {
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
    expect(renderLegalEvidenceAnswer(state)).toContain("[Example v Example, 2024 SCC 1 at para 12](https://example.test/case#par12:~:text=");
  });

  it("does not rewrite a citation pill when one claim cites several passages", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    const first = passage();
    const second = passage("par13");
    registerLegalEvidence(state, first);
    registerLegalEvidence(state, second);
    submitLegalEvidenceAnswer({ claims: [{
      text: "The court in 2024 SCC 1 allowed the appeal.",
      evidence_ids: [first.evidence_id, second.evidence_id],
    }] }, state);

    const rendered = renderLegalEvidenceAnswer(state)!;
    expect(rendered).toContain("[Example v Example, 2024 SCC 1 at para 12](https://example.test/case#par12:~:text=");
    expect(rendered).toContain("[Example v Example, 2024 SCC 1 at para 13](https://example.test/case#par13:~:text=");
    expect(rendered).not.toContain("[[");
  });

  it("rejects an unstructured legal draft", () => {
    const state = createLegalEvidenceTurnState("citation_structure");
    registerLegalEvidence(state, passage());
    expect(finalizeLegalEvidence(state, "Example v Example allowed the appeal.")).toBe(false);
    expect(state.failure).toBe("The model did not submit a grounded answer.");
  });

  it("runs quote and unmarked-copy gates at grounded submission", () => {
    const quoteSource = createBenchmarkEvidence({
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
    const copiedSource = createBenchmarkEvidence({
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
