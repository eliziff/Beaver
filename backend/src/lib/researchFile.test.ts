import { describe, expect, it, vi } from "vitest";
import { createA2AJPassageEvidence } from "./chat/legalEvidence";
import { createResearchFileState, decodeResearchFileState, parseResearchFile,
  reduceResearchFile, researchFileMarkdown, researchQueryReceipt,
  researchQuerySources } from "./researchFile";
import { runResearchFileQuery } from "./researchFileQuery";
import { resourceReference } from "./resourceReferences";

vi.mock("./structureNative", () => ({ structureNative: () => ({
  documentRevision: () => `sha256:${"a".repeat(64)}`,
  documentText: (document: { text: string }) => document.text,
  documentAnchors: (document: { blocks: unknown[] }) => document.blocks,
  legalSourceViewer: () => ({ slices: [] }),
}) }));

describe("research files", () => {
  it("round-trips labels, notes, and verified receipts in ordinary Markdown", () => {
    let state = reduceResearchFile(createResearchFileState(),
      { type: "label", name: "Fairness", color: "#1d4ed8", order: 7, scope: "source" });
    const labelId = Object.keys(state.labels)[0];
    state = reduceResearchFile(state, { type: "label", name: "Procedure",
      parentId: labelId });
    const childId = Object.keys(state.labels)[1];
    state = reduceResearchFile(state, { type: "label", name: "Merits", parentId: labelId });
    const siblingId = Object.keys(state.labels)[2];
    state = reduceResearchFile(state, { type: "label", id: siblingId, name: "Merits", order: -0.5 });
    expect([state.labels[siblingId].order, state.labels[childId].order]).toEqual([0, 1]);
    state = reduceResearchFile(state, { type: "label", name: "Notice",
      parentId: childId });
    const grandchildId = Object.keys(state.labels)[3];
    expect(() => reduceResearchFile(state, { type: "label", name: "Too deep",
      parentId: grandchildId })).toThrow("three levels");
    let moved = reduceResearchFile(createResearchFileState(),
      { type: "label", name: "Root", scope: "source" });
    const root = Object.keys(moved.labels)[0];
    moved = reduceResearchFile(moved, { type: "label", name: "Child", parentId: root });
    const child = Object.keys(moved.labels)[1];
    moved = reduceResearchFile(moved, { type: "label", name: "Grandchild", parentId: child });
    moved = reduceResearchFile(moved, { type: "label", name: "Other root" });
    const other = Object.keys(moved.labels)[3];
    expect(() => reduceResearchFile(moved, { type: "label", id: root, name: "Root",
      parentId: other })).toThrow("three levels");
    state = reduceResearchFile(state, { type: "source", reference: {
      provider: "a2aj", id: "2026 SCC 1", kind: "case", citation: "2026 SCC 1" } });
    const sourceId = Object.keys(state.sources)[0];
    state = reduceResearchFile(state, { type: "annotate", kind: "source", id: sourceId,
      labelIds: [grandchildId, childId, labelId], badge: "Leading", badgeColor: "#7c3aed",
      note: "**Leading case**" });
    state = reduceResearchFile(state, { type: "label", name: "Holding", scope: "highlight" });
    const highlightId = Object.keys(state.labels).at(-1)!;
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "The holding.", spanText: "The holding.",
      start: 0, end: 12, externalUrl: null, sourceClass: "case",
      sourceReference: { id: "2026 SCC 1" } });
    state = reduceResearchFile(state, { type: "merge", evidence: [receipt] });
    const evidenceId = Object.keys(state.evidence)[0];
    expect(() => reduceResearchFile(state, { type: "annotate", kind: "evidence", id: evidenceId,
      badge: "Invalid" })).toThrow("Evidence annotations cannot have badges");
    state = reduceResearchFile(state, { type: "annotate", kind: "evidence", id: evidenceId,
      labelIds: [highlightId] });
    const markdown = researchFileMarkdown("Fairness", state);
    expect(parseResearchFile(markdown)).toEqual(state);
    expect(markdown).toContain("[Leading]");
    expect(state.labels[labelId]).toMatchObject({ order: 0, scope: "source" });
    expect(state.sources[sourceId].labelIds[0]).toBe(grandchildId);
    expect(state.sources[sourceId].badgeColor).toBe("#7c3aed");
    state = parseResearchFile(markdown)!;
    state = reduceResearchFile(state, { type: "remove", kind: "label", id: labelId });
    expect(Object.keys(state.labels)).toEqual([highlightId]);
    expect(state.sources[sourceId].labelIds).toEqual([]);
    expect(state.evidence[evidenceId].labelIds).toEqual([highlightId]);
    state = reduceResearchFile(state, { type: "remove", kind: "label", id: highlightId });
    expect(state.labels).toEqual({});
    expect(parseResearchFile(researchFileMarkdown("Fairness", state))).toEqual(state);
    const forged = structuredClone(state) as unknown as Record<string, unknown>;
    (Object.values((forged.evidence as Record<string, { receipt: { evidence_id: string } }>))[0]
      .receipt.evidence_id) = "not-evidence";
    expect(decodeResearchFileState(forged)).toBeNull();
  });

  it("keeps query receipts after their saved evidence and source are removed", () => {
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "The holding.", spanText: "The holding.",
      start: 0, end: 12, externalUrl: null, sourceClass: "case",
      sourceReference: { id: "2026 SCC 1" } });
    let state = reduceResearchFile(createResearchFileState(), { type: "merge", evidence: [receipt] });
    const sourceId = Object.keys(state.sources)[0], query = researchQueryReceipt({
      query_id: "q_saved", call_id: "call", tool: "Read",
      executed_at: "2026-09-01T00:00:00.000Z", model: "human",
      executor_version: "legal-source-pattern-v1", input: { pattern: "holding" },
      results: [{ rank: 1, evidence_id: receipt.evidence_id }],
    });
    query.sourceIds = [sourceId]; query.evidenceIds = [receipt.evidence_id];
    query.slots = { [receipt.evidence_id]: ["Holding"] };
    state = reduceResearchFile(state, { type: "merge", queries: [query] });
    state = reduceResearchFile(state, { type: "remove", kind: "evidence",
      id: receipt.evidence_id });
    expect(parseResearchFile(researchFileMarkdown("Cases", state))).toEqual(state);
    state = reduceResearchFile(state, { type: "remove", kind: "source", id: sourceId });
    expect(state.queries.q_saved).toEqual(query);
    expect(parseResearchFile(researchFileMarkdown("Cases", state))).toEqual(state);
  });

  it("turns saved search resources into ordinary research sources", () => {
    const query = researchQueryReceipt({ query_id: "q_sources", call_id: "search",
      tool: "search_sources", executed_at: "2026-09-01T00:00:00.000Z", model: "model",
      executor_version: "legal-source-search-v1", input: { query: "fairness" },
      results: [{ rank: 1, resource: resourceReference.source("a2aj",
        JSON.stringify(["2026 SCC 1", "cases", "scc"])) }],
    });
    const state = reduceResearchFile(createResearchFileState(), { type: "merge", queries: [query] });
    const source = Object.values(state.sources)[0];
    expect(source.reference).toMatchObject({ provider: "a2aj", id: "2026 SCC 1",
      kind: "case", collection: "scc" });
    expect(state.queries.q_sources.sourceIds).toEqual([source.id]);
    const withoutLedger = reduceResearchFile(createResearchFileState(),
      { type: "merge", sources: researchQuerySources([query]) });
    expect(Object.keys(withoutLedger.sources)).toHaveLength(1);
    expect(withoutLedger.queries).toEqual({});
  });

  it("captures adjacent text into a label with evidence and query receipts", async () => {
    let state = reduceResearchFile(createResearchFileState(), { type: "source", reference: {
      provider: "courtlistener", id: "case-1", kind: "case", citation: "Example" } });
    state = reduceResearchFile(state, { type: "label", name: "Holding", scope: "highlight" });
    const sourceId = Object.keys(state.sources)[0], slot = Object.keys(state.labels)[0],
      sourceText = "Holding: good faith applies. Costs follow.";
    let bytes = Buffer.from(researchFileMarkdown("Cases", state));
    const documents = {
      metadata: vi.fn(async () => ({ id: "doc-1", filename: "Cases.research.md",
        project_id: null })),
      read: vi.fn(async () => ({ bytes, fileType: "md", version: { id: "v1" } })),
      replaceVersion: vi.fn(async (_scope, _id, _version, input: { bytes: Buffer }) => {
        bytes = input.bytes; state = parseResearchFile(bytes)!; return { status: "replaced", version: { id: "v1" } };
      }),
    };
    const reader = vi.fn(async ({ source }: { source: unknown }) => ({ status: "found" as const,
      values: [{ role: "document" as const, source, text: sourceText,
        documentArtifact: { text: sourceText, blocks: [
          { kind: "paragraph", label: "1", start: 0, end: sourceText.length },
        ] } }] }));
    const queried = await runResearchFileQuery(documents as never, { userId: "user-1" },
      "doc-1", { versionId: "v1", syntax: "literal", target: "sources",
        sourceIds: [sourceId], limit: 20, rules: [{ phrase: "Holding:", direction: "after",
          unit: "sentence", slot }], conflict: "first" }, { reader: reader as never });
    expect(queried.counts.matches).toBe(1);
    const evidence = Object.values(state.evidence)[0], query = state.queries[queried.queryId];
    expect(evidence).toMatchObject({ labelIds: [slot], receipt: {
      span_text: "good faith applies.", locator: { kind: "paragraph", label: "1" } } });
    expect(query.input).toMatchObject({ source_ids: [sourceId], limit: 20,
      rules: [{ phrase: "Holding:", direction: "after", unit: "sentence", chars: 100, slot }] });
    expect(query.slots[evidence.receipt.evidence_id]).toEqual([slot]);
    expect(Object.keys(state.queries)).toEqual([queried.queryId]);
    expect(bytes.toString()).not.toContain("## Search history");
  });
});
