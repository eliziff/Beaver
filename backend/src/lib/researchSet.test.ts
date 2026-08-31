import { describe, expect, it, vi } from "vitest";
import { createA2AJPassageEvidence } from "./chat/legalEvidence";
import { promoteChatResearchSet } from "./chat/researchSetChat";
import { createResearchSetState, decodeResearchSetState, reduceResearchSet } from "./researchSet";

const human = { kind: "human" as const, id: "user-1" };

describe("research sets", () => {
  it("stores only source references, annotations, one memo, and an audit trail", () => {
    let state = createResearchSetState(human, "Fairness");
    state = reduceResearchSet(state, { type: "label", name: "Fairness",
      color: "#991b1b" }, human);
    const labelId = Object.keys(state.labels)[0];
    state = reduceResearchSet(state, { type: "source", reference: {
      provider: "a2aj", id: "case-1", kind: "case", title: "Example v Example",
      citation: "2026 SCC 1" } }, human);
    const sourceId = Object.keys(state.sources)[0];
    state = reduceResearchSet(state, { type: "annotate", kind: "source", id: sourceId,
      labelIds: [labelId], note: "Leading case" }, human);
    state = reduceResearchSet(state, { type: "memo",
      markdown: `The test is summarized at [e_123].` }, human);

    expect(decodeResearchSetState(state)?.sources[sourceId]).toMatchObject({
      labelIds: [labelId], note: "Leading case",
      reference: { provider: "a2aj", id: "case-1" },
    });
    expect(state.memo).toBe("The test is summarized at [e_123].");
    expect(state.audit.map(({ action }) => action)).toEqual([
      "create", "label", "source", "annotate", "memo",
    ]);
    expect(JSON.stringify(state)).not.toContain("fullText");
  });

  it("records model chat provenance on mutations", () => {
    const actor = { kind: "model" as const, id: "gpt-test",
      origin: { type: "chat" as const, chatId: "chat-1", callId: "call-1" } };
    const state = reduceResearchSet(createResearchSetState(human, "Set"),
      { type: "memo", markdown: "# Memo" }, actor);
    expect(state.audit.at(-1)?.actor).toEqual(actor);
  });

  it("does not erase passage annotations when evidence is saved again", () => {
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "The holding.", spanText: "The holding.",
      start: 0, end: 12, externalUrl: null, sourceClass: "case",
      sourceReference: { id: "2026 SCC 1" } });
    let state = reduceResearchSet(createResearchSetState(human, "Set"),
      { type: "merge", evidence: [receipt] }, human);
    state = reduceResearchSet(state, { type: "annotate", kind: "evidence",
      id: receipt.evidence_id, note: "Keep me" }, human);
    state = reduceResearchSet(state, { type: "merge", evidence: [receipt] }, human);
    expect(state.evidence[receipt.evidence_id].note).toBe("Keep me");
  });

  it("attributes chat promotion only to messages that supplied receipts", async () => {
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "Holding.", spanText: "Holding.",
      start: 0, end: 8, externalUrl: null, sourceClass: "case" });
    const product = { id: "10000000-0000-4000-8000-000000000001",
      kind: "research-set" as const, title: "Set", projectId: null, revision: 1,
      state: createResearchSetState(human, "Set"), outputs: {}, createdAt: "now", updatedAt: "now" };
    const applyResearchSetAction = vi.fn(async () => product);
    const chats = { get: vi.fn(async () => ({ id: "chat-1", model: "test", project_id: null })),
      transcript: vi.fn(async () => [{ id: "noise", role: "assistant", content: [] },
        { id: "evidence", role: "assistant",
          content: [{ type: "legal_evidence_receipt", status: "passed", evidence: [receipt] }] }]) };

    await promoteChatResearchSet(chats as never, { get: vi.fn(async () => product),
      applyResearchSetAction } as never, { userId: human.id }, { chatId: "chat-1",
      researchSetId: product.id, revision: 1, includeQueries: false });

    expect(applyResearchSetAction.mock.calls[0][3].origin.messageIds).toEqual(["evidence"]);
  });
});
