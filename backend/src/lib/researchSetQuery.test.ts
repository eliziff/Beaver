import { describe, expect, it, vi } from "vitest";
import { createResearchSetState, reduceResearchSet, type ResearchSetAction } from "./researchSet";
import { createResearchSetQueryService } from "./researchSetQuery";

vi.mock("./structureNative", () => ({ structureNative: () => ({
  documentRevision: () => `sha256:${"a".repeat(64)}`,
  documentText: (document: { text: string }) => document.text,
  documentAnchors: (document: { blocks: unknown[] }) => document.blocks,
  legalSourceViewer: (document: { slices?: unknown[] }) => ({ slices: document.slices ?? [] }),
}) }));
const actor = { kind: "human" as const, id: "user-1" };

describe("research set query", () => {
  it("keeps descendant-label, concurrency, failure, and full-ledger semantics", async () => {
    let state = createResearchSetState(actor, "Good faith");
    state = reduceResearchSet(state, { type: "label", name: "Contracts" }, actor);
    const parentId = Object.keys(state.labels)[0];
    state = reduceResearchSet(state, { type: "label", name: "Performance", parentId }, actor);
    const childId = Object.keys(state.labels)[1];
    for (let index = 1; index <= 5; index += 1) {
      state = reduceResearchSet(state, { type: "source", reference: {
        provider: "courtlistener", id: `case-${index}`, kind: "case" } }, actor);
      const sourceId = Object.values(state.sources).find(({ reference }) =>
        reference.id === `case-${index}`)!.id;
      state = reduceResearchSet(state,
        { type: "annotate", kind: "source", id: sourceId, labelIds: [childId] }, actor);
    }
    let product = { id: "10000000-0000-4000-8000-000000000001",
      kind: "research-set" as const, title: "Good faith", projectId: null, revision: 1,
      state, outputs: {}, createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z" };
    const application = { get: vi.fn(async () => product),
      applyResearchSetAction: vi.fn(async (_scope: unknown, _id: string, input: {
        revision: number; action: ResearchSetAction }) => {
        product = { ...product, revision: product.revision + 1,
          state: reduceResearchSet(product.state, input.action, actor) };
        return product;
      }) };
    let active = 0, peak = 0;
    const reader = vi.fn(async ({ source }: { source: { id: string } }) => {
      active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1;
      if (source.id === "case-5") return { status: "unsupported" as const, providers: [] };
      const parts = Array.from({ length: 30 }, (_, index) =>
        index ? `good faith ${index}` : "good   faith 0");
      let start = 0;
      const blocks = parts.map((text, index) => { const block = { kind: "paragraph",
        label: `par${index}`, start, end: start + text.length }; start += text.length + 1; return block; });
      blocks.splice(1, 0, { ...blocks[0], kind: "section", label: "duplicate" });
      if (source.id === "case-1") {
        const text = `good faith ${"x".repeat(1_000_000)}`;
        blocks.push({ kind: "section", label: "oversized", start, end: start + text.length });
        parts.push(text);
      }
      const documentArtifact = { text: parts.join("\n"),
        blocks: source.id === "case-4" ? [] : blocks,
        slices: source.id === "case-4" ? blocks.map(({ start, end }) => ({ start, end })) : [] };
      return { status: "found" as const, values: [{ role: "document" as const,
        source, text: documentArtifact.text, documentArtifact }] };
    });

    const service = createResearchSetQueryService(application, reader as never);
    const request = { revision: 1, syntax: "terms" as const, target: "sources" as const,
      labelIds: [parentId] };
    await expect(service.run({ userId: actor.id }, product.id,
      { ...request, text: Array.from({ length: 101 }, (_, index) => `term${index}`).join(" ") }))
      .rejects.toThrow("too many terms");
    const sample = Object.values(state.sources)[0];
    application.get.mockResolvedValueOnce({ ...product, state: { ...state, sources: Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`source-${index}`, sample])) } });
    await expect(service.run({ userId: actor.id }, product.id, { ...request, text: "good" }))
      .rejects.toThrow("Too many sources");
    const result = await service.run(
      { userId: actor.id }, product.id, { ...request,
        text: `${Array(101).fill("good").join(" ")} faith` });
    const saved = product.state.queries[result.queryId];

    expect(result.counts).toEqual({ attemptedSources: 5, matchedSources: 4,
      matches: 120, failures: 1 });
    expect(peak).toBe(4);
    expect(saved.failures).toMatchObject([{ code: "unsupported" }]);
    expect(saved.sourceIds).toHaveLength(5);
    expect(saved.evidenceIds).toHaveLength(120);
    expect(saved.results).toHaveLength(100);
    expect(Object.values(product.state.evidence).some(({ receipt }) =>
      receipt.span_text === "good   faith 0")).toBe(true);
  });
});
