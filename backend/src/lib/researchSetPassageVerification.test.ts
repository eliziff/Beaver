import { describe, expect, it, vi } from "vitest";
import { createResearchSetState, reduceResearchSet } from "./researchSet";
import { verifyPublicResearchPassageAction } from "./researchSetQuery";

vi.mock("./structureNative", () => ({ structureNative: () => ({
  documentRevision: () => `sha256:${"a".repeat(64)}`,
  documentText: (document: { text: string }) => document.text,
}) }));
const actor = { kind: "human" as const, id: "user-1" };

describe("research passage verification", () => {
  it("turns only a canonical quote into a server-authored evidence receipt", async () => {
    let state = createResearchSetState(actor, "Set");
    state = reduceResearchSet(state, { type: "source", reference: {
      provider: "a2aj", id: "case-1", kind: "case", citation: "2026 SCC 1" } }, actor);
    const sourceId = Object.keys(state.sources)[0];
    const application = { get: vi.fn(async () => ({ kind: "research-set" as const,
      revision: 1, state })) };
    const base = { type: "passage" as const, sourceId,
      locator: { kind: "paragraph" as const, value: "par1", endValue: "par2" } };
    const documentArtifact = { text: "Intro\nThe exact   governing passage." };
    const native = { citation: "2026 SCC 1", dataset: "scc", language: "en" };
    const reader = vi.fn(async () => ({ status: "found" as const, values: [{
      source: state.sources[sourceId].reference,
      locator: { requested: base.locator, label: "par1" },
      role: "selected" as const, text: "Intro", documentArtifact, native,
      blockArtifact: { kind: "paragraph", label: "par1", text: "Intro", start: 0, end: 5 },
    }, {
      source: state.sources[sourceId].reference,
      locator: { requested: base.locator, label: "par2" },
      role: "selected" as const, text: "The exact   governing passage.", documentArtifact, native,
      blockArtifact: { kind: "paragraph", label: "par2",
        text: "The exact   governing passage.", start: 6, end: documentArtifact.text.length },
    }] }));

    await expect(verifyPublicResearchPassageAction(application as never, { userId: actor.id },
      "set-1", 1, { ...base, quote: "fabricated words" }, reader as never))
      .rejects.toThrow("not contained");
    const action = await verifyPublicResearchPassageAction(application as never,
      { userId: actor.id }, "set-1", 1, { ...base, quote: "exact governing" }, reader as never);
    expect(action).toMatchObject({ type: "merge", evidence: [{
      span_text: "exact   governing", block_id: expect.stringContaining("par1-par2"),
      resolver_version: "a2aj-inline-v1",
    }] });
    expect(action.type === "merge" && action.evidence?.[0].source_reference)
      .toEqual({ id: "case-1" });
  });
});
