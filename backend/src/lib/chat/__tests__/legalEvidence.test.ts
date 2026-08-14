import { describe, expect, it } from "vitest";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  legalEvidenceReceiptEvent,
  priorLegalEvidenceReceipts,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
} from "../legalEvidence";

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
    expect(renderLegalEvidenceAnswer(state)).toContain("[2024 SCC 1 at para. 12](https://example.test/case)");
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
    expect(rendered).toContain("[2024 SCC 1 at para. 12](https://example.test/case)");
    expect(rendered).toContain("[2024 SCC 1 at para. 13](https://example.test/case)");
    expect(rendered).not.toContain("[[");
  });
});
