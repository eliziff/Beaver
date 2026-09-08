import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "./applicationError";
import { createA2AJPassageEvidence, createPublicJournalPassageEvidence, createLibraryEvidence,
  createLegalEvidenceTurnState, legalEvidenceReceiptEvent, registerLegalEvidence,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { GroundedAnswer } from "./groundedAnswer";
import { createSourceWorkspaceApplication } from "./sourceWorkspaceApplication";
import { resolveChatFindings } from "./researchChat";
import { sha256 } from "./hash";
import { commitResearchFile, createResearchFileState, pageResearchItems, parseResearchFile,
  readResearchFile, researchFileActionSchema, researchFileMarkdown, researchQueryReceipt,
  readResearchHistory, saveResearchFile, researchHighlightCount,
  researchSourceFromResource, researchSourceResource, type ResearchFileAction } from "./researchFile";
import { runResearchFileQuery, verifyResearchPassage } from "./researchFileQuery";
import type { ResearchOperationContext } from "./researchProvenance";
import { resolveResearchSelection } from "./researchSelection";
import { readResearchWorkspace, type ResearchReadContext } from "./researchReader";

vi.mock("./documentProjectionService", () => ({ documentProjectionService: {
  read: async (projection: { document: unknown }) => projection.document,
} }));

vi.mock("./structureNative", () => ({ structureNative: () => ({
  documentRevision: (document: { revision?: string }) => document.revision ?? "a".repeat(64),
  documentText: (document: { text: string }) => document.text,
  documentAnchors: (document: { blocks: unknown[] }) => document.blocks,
  smallestContainingDocumentBlock: (document: { blocks: Array<{ start: number; end: number }> },
    start: number, end: number) => document.blocks.find((block) =>
      block.start <= start && block.end >= end) ?? null,
  legalSourceViewer: () => ({ slices: [] }),
  providerCitationsInText: () => [],
}) }));

const sourceLabel = "11111111-1111-4111-8111-111111111111";
const highlightLabel = "22222222-2222-4222-8222-222222222222";

function fixture() {
  let root = Buffer.from(researchFileMarkdown("Cases", createResearchFileState())),
    versionId = "v1", workingRevision = 0, versionNumber = 1, partReadLimit = Infinity;
  const parts = new Map<string, Buffer>(), version = () => ({ id: versionId,
    working_revision: workingRevision, version_number: versionNumber,
    filename: "Cases.research.md", file_type: "md", size_bytes: root.length,
    source_sha256: sha256(root) });
  const write = (input: { bytes: Buffer; parts?: { put?: Array<{ name: string; bytes: Buffer }>;
    remove?: string[] } }, assistant: boolean, turnVersionId?: string) => {
    input.parts?.remove?.forEach((name) => parts.delete(name));
    input.parts?.put?.forEach(({ name, bytes }) => parts.set(name, bytes));
    root = input.bytes;
    if (assistant && !turnVersionId) { versionId = `v${++versionNumber}`; workingRevision = 0; }
    else workingRevision++;
    return { status: assistant ? "committed" : "replaced", version: version() };
  };
  const documents = {
    metadata: vi.fn(async () => ({ id: "doc-1", filename: "Cases.research.md",
      project_id: null, current_version_id: versionId, current_working_revision: workingRevision })),
    read: vi.fn(async () => ({ bytes: root, fileType: "md", version: version() })),
    readParts: vi.fn(async (_scope, _id, _version, names: string[]) => {
      if (names.length > partReadLimit) throw new ApplicationError(413, "Parts exceed limit");
      return names.flatMap((name) => {
        const bytes = parts.get(name); return bytes ? [{ name, bytes, sha256: sha256(bytes) }] : [];
      }); }),
    replaceVersion: vi.fn(async (_scope, _id, expectedVersion, expectedRevision, input) =>
      expectedVersion !== versionId || expectedRevision !== workingRevision ? { status: "conflict" }
        : write(input, false)),
    commitAssistantVersion: vi.fn(async (_scope, _id, input) =>
      write(input, true, input.turnVersionId)),
  };
  return { documents, parts, root: () => root,
    limitPartReads: (limit: number) => { partReadLimit = limit; } };
}

async function act(f: ReturnType<typeof fixture>, action: ResearchFileAction,
  assistant?: { turnVersionId?: string; turnId?: string }, context?: ResearchOperationContext) {
  const current = await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1");
  expect(current).not.toBeNull();
  const result = await commitResearchFile(f.documents as never, { userId: "user-1" },
    current!, action, assistant, context);
  expect(result).not.toBeNull(); return result!;
}

const receipt = (id: string, text = `holding ${id}`) => createA2AJPassageEvidence({
  citation: id, name: id, dataset: "scc", language: "en", sourceText: text, spanText: text,
  start: 0, end: text.length, externalUrl: null, sourceClass: "case",
  sourceReference: { id }, sourceSha256: id.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a") });

describe("Research v2 parts", () => {
  it("keeps workspace passage pages and exact section reads within the current selection", async () => {
    const f = fixture(), passages = ["First", "Second"].map((text, index) => createLibraryEvidence({
      documentId: "library-doc", versionId: "revision-1", filename: "Notes.txt", sourceText: "FirstSecond",
      spanText: text, start: index ? 5 : 0, end: index ? 11 : 5 })),
      saved = await act(f, { type: "merge", evidence: passages, labels: Object.fromEntries(passages.map((item) => [item.evidence_id, []])) }),
      source = Object.values(saved.state.sources)[0], context: ResearchReadContext = { restricted: true, subjects: [{
        sourceId: source.id, reference: source.reference, resource: researchSourceResource(source.reference), evidence: [passages[1]] }] },
      documents = { ...f.documents, projectionSource: async () => null },
      read = (args: Record<string, unknown>) => readResearchWorkspace(documents as never, { userId: "user-1" },
        saved, args, new AbortController().signal, undefined, context),
      payload = (output: Awaited<ReturnType<typeof read>>) => JSON.parse(output.result.content
        .filter((item) => item.type === "text").map((item) => item.text).join(""));
    const page = await read({});
    expect(payload(page).items.filter((item: { kind: string }) => item.kind === "unavailable_passage"))
      .toMatchObject([{ evidence_id: passages[1].evidence_id }]);
    expect(JSON.stringify(payload(page))).not.toContain(passages[0].evidence_id);
    expect(page.evidence).toEqual([]);
    const excluded = await read({ section: "passage:1" });
    expect(excluded.result.isError).toBe(true);
    expect(payload(excluded).error).toContain("outside the current selection");
  });

  it("audits human and assistant collection and labelling with the same canonical passage ID", async () => {
    const f = fixture(), audit = vi.fn(async () => {}), passage = receipt("case-a"),
      human = { audit, executor: "human" as const };
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    const collected = await act(f, { type: "merge", evidence: [passage] }, undefined, human),
      sourceId = Object.keys(collected.state.sources)[0],
      assistant = { audit, executor: "assistant" as const, model: "model-a", turnId: "turn-1", callId: "call-1", subagentId: "child-1" };
    const observed = await act(f, { type: "merge", evidence: [passage] }, undefined, assistant);
    expect(observed.versionId).toBe(collected.versionId);
    expect(observed.workingRevision).toBe(collected.workingRevision);
    await act(f, { type: "annotate", kind: "evidence", sourceId,
      id: passage.evidence_id, labelIds: [highlightLabel] }, { turnId: "turn-1" }, assistant);
    const events = audit.mock.calls.map((args) => (args as unknown[])[0]) as Array<{
      userId: string; model?: string; detail: Record<string, unknown> }>;
    expect(events).toHaveLength(3);
    expect(events.map(({ userId, model, detail }) => ({ userId, model, executor: detail.executor })))
      .toEqual([{ userId: "user-1", model: undefined, executor: "human" },
        { userId: "user-1", model: "model-a", executor: "assistant" },
        { userId: "user-1", model: "model-a", executor: "assistant" }]);
    expect(events[0].detail.observed_passages).toEqual(events[1].detail.observed_passages);
    expect(events[1].detail.passages).toEqual([]);
    expect(events[0].detail).toMatchObject({ sources: [{ id: sourceId, created: true, removed: false }],
      observed_passages: [{ evidence_id: passage.evidence_id, source_id: sourceId,
        source_sha256: passage.source_sha256 }] });
    expect(events[1].detail.changes).toEqual([]);
    expect(events[2].detail).toMatchObject({ turn_id: "turn-1", call_id: "call-1", subagent_id: "child-1",
      changes: [{ target: "source", id: sourceId, field: "collected", before: false, after: true },
        { target: "passage", id: passage.evidence_id, sourceId, field: "labelIds", before: [], after: [highlightLabel] }],
      passages: [{ evidence_id: passage.evidence_id, labelIds: [highlightLabel], source_sha256: passage.source_sha256 }] });
    const page = await pageResearchItems(f.documents as never, { userId: "user-1" },
      (await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1"))!, "passages", 0, 10);
    expect(page.items).toMatchObject([{ kind: "passage", value: { receipt: { evidence_id: passage.evidence_id } } }]);
  });

  it("uses the same pinned Library passages for collection, search, and selection labels", async () => {
    const f = fixture(), text = "The governing law is Alberta.", scope = { userId: "user-1" },
      block = { kind: "paragraph", label: "1", start: 0, end: text.length, text },
      library = { provider: "library" as const, kind: "document" as const, id: "library-doc", versionId: "revision-1", title: "Lease.txt" },
      documents = Object.assign(f.documents, { projectionSource: vi.fn(async () => ({
        document: { text, blocks: [block] }, sourceSha256: "b".repeat(64) })) });
    await act(f, { type: "label", id: highlightLabel, name: "Law", scope: "highlight" });
    await act(f, { type: "source", reference: library });
    const original = createLibraryEvidence({ documentId: library.id, versionId: library.versionId,
      filename: library.title, sourceSha256: "a".repeat(64), start: 0, end: text.length, spanText: text });
    const collected = await act(f, { type: "merge", evidence: [original] });
    expect(Object.values(collected.state.sources)).toHaveLength(1);
    const searched = await runResearchFileQuery(documents as never, scope, "doc-1", {
      versionId: collected.versionId, workingRevision: collected.workingRevision,
      text: "Alberta", syntax: "literal", target: "sources" });
    expect(searched.evidence.map(({ evidence_id }) => evidence_id)).toEqual([original.evidence_id]);
    const labelled = await act(f, { type: "label-selection", target: "passages", assign: [highlightLabel],
      evidenceIds: [original.evidence_id], mode: "add" });
    const selected = await resolveResearchSelection(documents as never, scope, {
      researchFileId: "doc-1", target: "passages", labelIds: [highlightLabel] }, labelled);
    expect(selected.subjects).toMatchObject([{ resource: researchSourceResource(library),
      sourceSha256: "b".repeat(64), evidence: [{ evidence_id: original.evidence_id }] }]);
    await act(f, { type: "label-selection", target: "passages", labelIds: [highlightLabel],
      assign: [highlightLabel], mode: "remove" });
    expect((await resolveResearchSelection(documents as never, scope, {
      researchFileId: "doc-1", target: "passages", labelIds: [highlightLabel] })).subjects).toEqual([]);
    expect((await resolveResearchSelection(documents as never, scope, {
      researchFileId: "doc-1", target: "sources", sourceIds: [] })).subjects).toEqual([]);
  });
  it("keeps memo edits in the same file and rejects overwriting a newer memo", async () => {
    const f = fixture();
    const collected = await act(f, { type: "merge", evidence: [receipt("case-a")] });
    const parts = new Map(f.parts);
    const markdown = "## Analysis\n\n**Holding** and ++emphasis++.\n\n| Case | Result |\n| --- | --- |\n| A | Allowed |";
    const saved = await act(f, { type: "note", markdown, expectedMarkdown: "" });
    expect(saved.document.id).toBe(collected.document.id);
    expect(saved.state.sources).toEqual(collected.state.sources);
    expect(saved.state.note).toBe(markdown);
    expect(new Map([...f.parts].filter(([name]) => name !== "history.json"))).toEqual(parts);
    await expect(act(f, { type: "note", markdown: "stale edit", expectedMarkdown: "" }))
      .rejects.toMatchObject({ status: 409, details: { code: "memo_conflict" } });
    expect((await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1"))?.state.note).toBe(markdown);
  });

  it("keeps the root small and reads or changes only the selected source part", async () => {
    const f = fixture();
    const initial = await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1");
    expect(await commitResearchFile(f.documents as never, { userId: "user-1" }, initial!,
      { type: "note", markdown: "" })).toBe(initial);
    expect(f.documents.replaceVersion).not.toHaveBeenCalled();
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    const saved = await act(f, { type: "merge", evidence: [receipt("case-a")] }),
      sourceId = Object.keys(saved.state.sources)[0], partName = `source.${sourceId}.json`;
    expect(saved.document.current_working_revision).toBe(saved.workingRevision);
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 1,
      labelCounts: {}, unlabelledCount: 1 });
    expect(f.parts.has(partName)).toBe(true);
    expect(f.root().toString()).not.toContain("span_text");

    f.documents.readParts.mockClear();
    expect((await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1"))?.state)
      .toEqual(saved.state);
    expect(f.documents.readParts).not.toHaveBeenCalled();
    const page = await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "evidence", 0, 20);
    expect(page.items[0]).toMatchObject({ kind: "evidence",
      value: { receipt: { span_text: "holding case-a" } } });
    expect(f.documents.readParts).toHaveBeenLastCalledWith(expect.anything(), "doc-1",
      saved.versionId, [partName]);

    expect(() => researchFileActionSchema.parse({ type: "annotate", kind: "evidence",
      id: page.items[0].value.receipt.evidence_id, labelIds: [highlightLabel] })).toThrow();
    const annotated = await act(f, { type: "annotate", kind: "evidence", sourceId,
      id: page.items[0].value.receipt.evidence_id, labelIds: [highlightLabel] });
    expect(annotated.state.sources[sourceId].passages).toMatchObject({
      labelCounts: { [highlightLabel]: 1 }, unlabelledCount: 0 });
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, annotated,
      "passages")).items[0]).toMatchObject({ value: { labelIds: [highlightLabel] } });
    const removed = await act(f, { type: "remove", kind: "evidence", sourceId,
      id: page.items[0].value.receipt.evidence_id });
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, removed,
      "passages")).total).toBe(0);
    expect(f.parts.has(partName)).toBe(true);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, removed, "evidence")).items[0])
      .toMatchObject({ value: { receipt: page.items[0].value.receipt, labelIds: [] } });
  });

  it("indexes highlights beyond a read page and preserves them when their type is deleted", async () => {
    const f = fixture();
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: Array.from({ length: 51 }, (_, index) =>
      receipt("case-page", `holding ${index}`)) }), sourceId = Object.keys(saved.state.sources)[0],
      partName = `source.${sourceId}.json`, secondPage = await pageResearchItems(
        f.documents as never, { userId: "user-1" }, saved, "evidence", 50, 1);
    saved = await act(f, { type: "annotate", kind: "evidence", sourceId,
      id: secondPage.items[0].value.receipt.evidence_id, labelIds: [highlightLabel] });
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 51,
      labelCounts: { [highlightLabel]: 1 }, unlabelledCount: 50 });
    const previous = f.parts.get(partName);
    saved = await act(f, { type: "remove", kind: "label", id: highlightLabel });
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 51,
      unlabelledCount: 50 });
    const fallback = Object.values(saved.state.labels).find(({ name }) => name === "Highlight")!;
    expect(saved.state.sources[sourceId].passages!.labelCounts).toEqual({ [fallback.id]: 1 });
    expect(f.parts.get(partName)).not.toBe(previous);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "evidence", 50, 1)).items[0]).toMatchObject({ value: { labelIds: [fallback.id] } });
  });

  it("allows arbitrary label nesting and rejects cycles", async () => {
    const f = fixture(), root = "30000000-0000-4000-8000-000000000001",
      child = "30000000-0000-4000-8000-000000000002",
      grandchild = "30000000-0000-4000-8000-000000000003";
    await act(f, { type: "label", id: root, name: "Root", scope: "source" });
    await act(f, { type: "label", id: child, name: "Child", parentId: root, scope: "source" });
    await act(f, { type: "label", id: grandchild, name: "Grandchild",
      parentId: child, scope: "source" });
    const saved = await act(f, { type: "label", name: "Fourth level", parentId: grandchild, scope: "source" });
    expect(Object.values(saved.state.labels).map(({ name }) => name)).toContain("Fourth level");
    await expect(commitResearchFile(f.documents as never, { userId: "user-1" }, saved,
      { type: "label", id: root, name: "Root", parentId: grandchild, scope: "source" }))
      .rejects.toThrow();
  });

  it("keeps query receipts after labels and sources are removed", async () => {
    const f = fixture();
    await act(f, { type: "label", id: sourceLabel, name: "Filed", scope: "source" });
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: [receipt("case-b")] });
    const sourceId = Object.keys(saved.state.sources)[0], evidence = (await pageResearchItems(
      f.documents as never, { userId: "user-1" }, saved, "evidence")).items[0].value.receipt,
      query = researchQueryReceipt({ query_id: "q_saved", call_id: "call", tool: "Read",
        executed_at: "2026-09-04T00:00:00.000Z", model: "human",
        executor_version: "legal-source-pattern-v1", input: { pattern: "holding",
          label_ids: [sourceLabel], rules: [{ phrase: "holding", direction: "after",
            unit: "sentence", slot: highlightLabel }] },
        results: [{ rank: 1, evidence_id: evidence.evidence_id }] });
    query.sourceIds = [sourceId]; query.evidenceIds = [evidence.evidence_id];
    query.slots = { [evidence.evidence_id]: [highlightLabel] };
    saved = await act(f, { type: "merge", queries: [query] });
    saved = await act(f, { type: "merge", queries: [{ ...query, query_id: "q_new" }] });
    saved = await act(f, { type: "remove", kind: "label", id: sourceLabel });
    f.documents.readParts.mockClear();
    saved = await act(f, { type: "remove", kind: "source", id: sourceId });
    expect(f.parts.has(`source.${sourceId}.json`)).toBe(true);
    expect(saved.state.sources[sourceId].collected).toBe(false);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, saved, "evidence")).items[0])
      .toMatchObject({ value: { receipt: evidence } });
    const ledger = await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "queries", 0, 20);
    expect(ledger.items.map(({ value }) => value.query_id)).toEqual(["q_new", "q_saved"]);
    expect(ledger.items[1]).toMatchObject({ value: { labelPaths: {
      [sourceLabel]: "Filed", [highlightLabel]: "Holding" }, sourceReferences: {
        [sourceId]: { id: "case-b" } } } });
  });

  it("queries explicitly selected read receipts in caller order without promoting them to highlights", async () => {
    const f = fixture();
    await act(f, { type: "label", id: sourceLabel, name: "Filed", scope: "source" });
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: [receipt("case-a", "alpha x beta"),
      receipt("case-b", "alpha beta labelled"), receipt("case-c", "alpha beta")] });
    const byReference = Object.fromEntries(Object.values(saved.state.sources)
      .map((source) => [source.reference.id, source.id])), passages = (await pageResearchItems(
        f.documents as never, { userId: "user-1" }, saved, "evidence")).items;
    saved = await act(f, { type: "annotate", kind: "source", id: byReference["case-a"],
      labelIds: [sourceLabel] });
    saved = await act(f, { type: "annotate", kind: "evidence", sourceId: byReference["case-b"],
      id: passages.find(({ value }) => value.receipt.source_reference?.id === "case-b")!.value
        .receipt.evidence_id, labelIds: [highlightLabel] });
    const ordered = [byReference["case-c"], byReference["case-a"], byReference["case-b"]],
      run = async (input: Partial<Parameters<typeof runResearchFileQuery>[3]>) => {
        const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
          "doc-1", { versionId: saved.versionId, workingRevision: saved.workingRevision,
            text: "alpha beta", syntax: "terms", target: "passages", sourceIds: ordered, evidenceIds: passages.map(({ value }) => value.receipt.evidence_id),
            limit: 10, ...input });
        saved = result.file; return result;
      }, ids = (result: Awaited<ReturnType<typeof run>>) => result.evidence.map((item) =>
        item.source_reference?.id);
    expect(ids(await run({}))).toEqual(["case-c", "case-a", "case-b"]);
    expect(ids(await run({ syntax: "literal" }))).toEqual(["case-c", "case-b"]);
    expect(ids(await run({ unlabelled: true }))).toEqual(["case-c", "case-a"]);
    expect(ids(await run({ labelIds: [highlightLabel] }))).toEqual(["case-b"]);
    expect(ids(await run({ labelIds: [sourceLabel] }))).toEqual(["case-a"]);
    expect(ids(await run({ text: "alpha NOT labelled" }))).toEqual(["case-c", "case-a"]);
    expect(ids(await run({ text: '"alpha beta" | labelled' }))).toEqual(["case-c", "case-b"]);
    await expect(run({ text: "alpha and (beta" })).rejects.toThrow("Check the search");
  });

  it("resolves overlapping capture rules and assigns their slots", async () => {
    const f = fixture(), labels = ["40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002", "40000000-0000-4000-8000-000000000003"];
    for (const [index, id] of labels.entries()) await act(f,
      { type: "label", id, name: `Slot ${index + 1}`, scope: "highlight" });
    let saved = await act(f, { type: "source", reference: { provider: "courtlistener",
      id: "1", kind: "case", citation: "Example" } }), sourceId = Object.keys(saved.state.sources)[0];
    const text = "0123456789XabcdefghijYklmnopqrst", block = { kind: "paragraph",
      label: "1", start: 0, end: text.length, origin: "native", text },
      reader = vi.fn(async ({ source }: { source: unknown }) => ({ status: "found" as const,
        values: [{ source, locator: { requested: null, label: "document" }, role: "document" as const,
          text, documentArtifact: { text, blocks: [block] }, blockArtifact: block }] })),
      rules = [{ phrase: "X", direction: "after" as const, unit: "chars" as const,
        chars: 10, slot: labels[0] }, { phrase: "Y", direction: "before" as const,
        unit: "chars" as const, chars: 5, slot: labels[1] }, { phrase: "Y",
        direction: "after" as const, unit: "chars" as const, chars: 2, slot: labels[2] }],
      run = async (conflict: "first" | "append", applied = rules) => {
        const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
          "doc-1", { versionId: saved.versionId, workingRevision: saved.workingRevision,
            syntax: "literal", target: "sources", sourceIds: [sourceId], rules: applied, conflict },
          { reader: reader as never });
        saved = result.file; return result;
      };
    expect((await run("first")).evidence.map(({ span_text }) => span_text))
      .toEqual(["abcdefghij", "kl"]);
    const appended = await run("append"), slots = Object.fromEntries(appended.evidence.map(
      (item) => [item.span_text, appended.receipt.slots[item.evidence_id]]));
    expect(slots).toEqual({ abcdefghij: [labels[0]], fghij: [labels[1]], kl: [labels[2]] });
    expect((await run("append", [{ phrase: "X | Y", direction: "after", unit: "chars",
      chars: 2, slot: labels[0] }])).evidence.map(({ span_text }) => span_text)).toEqual(["ab", "kl"]);
    await expect(run("append", [{ phrase: '"X', direction: "after", unit: "chars", chars: 2 }]))
      .rejects.toThrow("Check the search");
  });

  it("queries exact and mixed subjects without widening an active reading scope", async () => {
    const f = fixture(), texts = { a: "needle outside\nneedle selected", b: "needle whole", c: "needle excluded" },
      evidence = Object.entries(texts).flatMap(([id, text]) => {
        const starts = id === "a" ? [0, text.indexOf("\n") + 1] : [0];
        return starts.map((start) => createLibraryEvidence({ documentId: id, versionId: "v1", filename: `${id}.txt`,
          sourceSha256: "a".repeat(64), start, end: start ? text.length : text.split("\n")[0].length,
          spanText: text.slice(start).split("\n")[0] }));
      }), documents = { ...f.documents, projectionSource: async (_scope: unknown, id: keyof typeof texts) => ({
        sourceSha256: "a".repeat(64), document: { text: texts[id], blocks: [{ kind: "paragraph", label: "1",
          start: 0, end: texts[id].length }] } }) };
    let saved = await act(f, { type: "merge", evidence });
    const byId = Object.fromEntries(Object.values(saved.state.sources).map((source) => [source.reference.id, source])),
      members = [{ sourceId: byId.a.id, evidenceIds: [evidence[1].evidence_id] }, { sourceId: byId.b.id }],
      context: ResearchReadContext = { restricted: true, subjects: ["a", "b"].map((id) => ({
        sourceId: byId[id].id, resource: researchSourceResource(byId[id].reference), reference: byId[id].reference,
        ...(id === "a" ? { evidence: [evidence[1]] } : {}) })) },
      run = async (selection: Partial<Parameters<typeof runResearchFileQuery>[3]>, bounded?: ResearchReadContext) => {
        const result = await runResearchFileQuery(documents as never, { userId: "user-1" }, "doc-1", {
          versionId: saved.versionId, workingRevision: saved.workingRevision, syntax: "literal",
          text: "needle", target: "sources", ...selection }, { context: bounded });
        saved = result.file; return result;
      };
    expect((await run({ members, target: "passages" })).evidence.map(({ span_text }) => span_text))
      .toEqual(["needle selected", "needle whole"]);
    const bounded = await run({}, context);
    expect(bounded.evidence.map(({ span_text }) => span_text)).toEqual(["needle selected", "needle whole"]);
    expect(bounded.evidence[0]).toEqual(evidence[1]);
    const exact = await run({ target: "passages", evidenceIds: [evidence[1].evidence_id, evidence[2].evidence_id] });
    expect(exact.evidence.map(({ evidence_id }) => evidence_id)).toEqual([evidence[1].evidence_id, evidence[2].evidence_id]);
    expect((await run({ members: [{ sourceId: byId.c.id }] }, context)).evidence).toEqual([]);
  });

  it("applies Boolean capture rules to each passage and captures its paragraph once", async () => {
    const f = fixture(), paragraphs = ["Arbitrary detention can be psychological or physical.",
      "Physical restraint alone.", "Arbitrary detention is physical but justified."], text = paragraphs.join("\n\n");
    const documents = { ...f.documents, projectionSource: async () => ({ sourceSha256: "a".repeat(64),
      document: { text, blocks: paragraphs.map((value, index) => ({ kind: "paragraph", label: String(index + 1),
        start: text.indexOf(value), end: text.indexOf(value) + value.length })) } }) };
    const saved = await act(f, { type: "merge", evidence: [createLibraryEvidence({ documentId: "selected",
      versionId: "v1", filename: "Notes.txt", sourceSha256: "a".repeat(64), start: 0, end: text.length, spanText: text })] });
    const result = await runResearchFileQuery(documents as never, { userId: "user-1" }, "doc-1", {
      versionId: saved.versionId, workingRevision: saved.workingRevision, syntax: "terms", target: "sources",
      sourceIds: Object.keys(saved.state.sources),
      rules: [{ phrase: '"arbitrary detention" AND (psychological OR physical) NOT justified',
        direction: "around", unit: "paragraph" }] });
    expect(result.evidence.map(({ span_text }) => span_text)).toEqual([paragraphs[0]]);
  });

  it("keeps the phrase inside its unit when a rule captures around it", async () => {
    const f = fixture(), text = "Outside line\nAlpha needle Beta\nneedle Gamma. Delta needle Epsilon. Trailing",
      selected = createLibraryEvidence({ documentId: "selected", versionId: "v1", filename: "Notes.txt",
        sourceSha256: "a".repeat(64), start: 0, end: text.length, spanText: text }),
      documents = { ...f.documents, projectionSource: async () => ({ sourceSha256: "a".repeat(64),
        document: { text, blocks: [{ kind: "paragraph", label: "1", start: 0, end: text.length }] } }) };
    let saved = await act(f, { type: "merge", evidence: [selected] });
    const sourceId = Object.keys(saved.state.sources)[0];
    const capture = async (unit: "line" | "sentence") => {
      const result = await runResearchFileQuery(documents as never, { userId: "user-1" }, "doc-1", {
        versionId: saved.versionId, workingRevision: saved.workingRevision, syntax: "literal", target: "passages",
        members: [{ sourceId, evidenceIds: [selected.evidence_id] }], conflict: "append",
        rules: [{ phrase: "needle", direction: "around", unit }] });
      saved = result.file;
      return result.evidence.map(({ span_text }) => span_text);
    };
    expect(await capture("line")).toEqual(["Alpha needle Beta", "needle Gamma. Delta needle Epsilon. Trailing"]);
    expect(await capture("sentence")).toEqual(["Outside line\nAlpha needle Beta\nneedle Gamma.", "Delta needle Epsilon."]);
  });

  it("captures and continues inside exact native passage bounds with original offsets", async () => {
    const f = fixture(), text = "İ outside needle Carol\nneedle Alice\nneedle Bob TRAILING OUTSIDE",
      start = text.indexOf("needle Alice"), end = text.indexOf(" TRAILING"), selected = createLibraryEvidence({
        documentId: "selected", versionId: "v1", filename: "Notes.txt", sourceSha256: "a".repeat(64),
        start, end, spanText: text.slice(start, end) }),
      documents = { ...f.documents, projectionSource: async () => ({ sourceSha256: "a".repeat(64),
        document: { text, blocks: [{ kind: "paragraph", label: "1", start: 0, end: text.length }] } }) };
    let saved = await act(f, { type: "merge", evidence: [selected] });
    const sourceId = Object.keys(saved.state.sources)[0], input = { syntax: "literal" as const,
      target: "passages" as const, members: [{ sourceId, evidenceIds: [selected.evidence_id] }], limit: 1,
      rules: [{ phrase: "needle", direction: "after" as const, unit: "line" as const }] },
      run = async (after?: string) => {
        const result = await runResearchFileQuery(documents as never, { userId: "user-1" }, "doc-1", {
          versionId: saved.versionId, workingRevision: saved.workingRevision, ...input, after });
        saved = result.file; return result;
      }, first = await run(), second = await run(first.coverage.next_after!);
    expect(first.evidence.map(({ span_text }) => span_text)).toEqual(["Alice"]);
    expect(second.evidence.map(({ span_text }) => span_text)).toEqual(["Bob"]);
    expect((await run(second.coverage.next_after!)).coverage).toMatchObject({ complete: true, next_after: null });
    for (const receipt of [...first.evidence, ...second.evidence]) {
      expect(receipt.span!.start).toBeGreaterThan(start);
      expect(receipt.span!.end).toBeLessThanOrEqual(end);
      expect(text.slice(receipt.span!.start, receipt.span!.end)).toBe(receipt.span_text);
    }
    await expect(runResearchFileQuery(documents as never, { userId: "user-1" }, "doc-1", {
      versionId: saved.versionId, workingRevision: saved.workingRevision, ...input,
      members: [{ sourceId }], after: first.coverage.next_after! })).rejects.toMatchObject({ status: 409 });
  });

  it("keeps capture offsets on the original Unicode text and rejects ambiguous searches", async () => {
    const f = fixture(); let saved = await act(f, { type: "source", reference: {
      provider: "courtlistener", id: "1", kind: "case" } });
    const sourceId = Object.keys(saved.state.sources)[0], text = "İ NEEDLEcaptured", block = {
      kind: "paragraph", label: "1", start: 0, end: text.length, origin: "native", text },
      reader = vi.fn(async ({ source }: { source: unknown }) => ({ status: "found" as const,
        values: [{ source, locator: { requested: null, label: "document" }, role: "document" as const,
          text, documentArtifact: { text, blocks: [block] }, blockArtifact: block }] })), base = {
        versionId: saved.versionId, workingRevision: saved.workingRevision, syntax: "literal" as const,
        target: "sources" as const, sourceIds: [sourceId], rules: [{ phrase: "needle",
          direction: "after" as const, unit: "chars" as const, chars: 8 }] };
    const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", base, { reader: reader as never }); saved = result.file;
    expect(result.evidence[0].span_text).toBe("captured");
    await expect(runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1",
      { ...base, versionId: saved.versionId, workingRevision: saved.workingRevision,
        text: "needle" }, { reader: reader as never })).rejects.toThrow("invalid");
  });

  it("searches every document returned for a saved source", async () => {
    const f = fixture(), saved = await act(f, { type: "source", reference: {
      provider: "courtlistener", id: "1", kind: "case" } }), sourceId = Object.keys(saved.state.sources)[0],
      source = saved.state.sources[sourceId].reference, values = ["first needle", "second needle"].map(
        (text, index) => { const block = { kind: "paragraph", label: String(index + 1), start: 0,
          end: text.length, origin: "native", text }; return { source,
          locator: { requested: null, label: "document" }, role: "document" as const, text,
          documentArtifact: { text, blocks: [block], revision: `${index ? "b" : "a"}`.repeat(64) },
          blockArtifact: block }; }), reader = vi.fn(async () => ({ status: "found" as const, values }));
    const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1",
      { versionId: saved.versionId, workingRevision: saved.workingRevision, text: "needle",
        syntax: "literal", target: "sources" }, { reader: reader as never });
    expect(result.evidence.map(({ span_text }) => span_text)).toEqual(["first needle", "second needle"]);
    expect(result.receipt.sourceFingerprints[sourceId]).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("continues beyond a result page across sources without omissions or duplicates", async () => {
    const f = fixture();
    for (const id of ["1", "2", "3"]) await act(f, { type: "source", reference: {
      provider: "courtlistener", id, kind: "case" } });
    let revision = "a".repeat(64), missing = false;
    const reader = async ({ source }: { source: { id: string } }) => {
      if (missing && source.id === "1") return { status: "not_found" as const };
      let text = "";
      const blocks = Array.from({ length: source.id === "2" ? 31 : 1 }, (_, index) => {
        const value = `needle ${source.id}.${index + 1}`, start = text.length;
        text += `${value}\n`; return { kind: "paragraph", label: String(index + 1),
          start, end: text.length - 1, text: value, origin: "native" };
      });
      return { status: "found" as const, values: [{ source, role: "document" as const,
        locator: { requested: null, label: "document" }, text,
        documentArtifact: { text, blocks, revision }, blockArtifact: blocks[0] }] };
    };
    const run = async (after?: string, target: "sources" | "passages" = "sources", text = "needle") => {
      const file = (await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1"))!;
      return runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1", {
        versionId: file.versionId, workingRevision: file.workingRevision,
        text, syntax: "literal", target, limit: 10, after }, { reader: reader as never });
    };
    const first = await run(), ids = first.evidence.map(({ evidence_id }) => evidence_id);
    expect(Object.keys(first.file.state.sources)).toHaveLength(3);
    expect(first.coverage).toMatchObject({ complete: false, next_after: expect.any(String) });
    let after = first.coverage.next_after;
    for (let page = 0; after && page < 10; page++) {
      const result = await run(after); ids.push(...result.evidence.map(({ evidence_id }) => evidence_id));
      after = result.coverage.next_after;
      if (!after) expect(result.coverage.complete).toBe(true);
    }
    expect(after).toBeNull(); expect(ids).toHaveLength(33); expect(new Set(ids).size).toBe(33);
    expect((await run(undefined, "passages")).evidence).toEqual([]);
    await act(f, { type: "label", id: highlightLabel, name: "Matches", scope: "highlight" });
    await act(f, { type: "label-selection", target: "passages", evidenceIds: ids, assign: [highlightLabel], mode: "replace" });
    const savedIds: string[] = []; after = null;
    do { const result = await run(after ?? undefined, "passages");
      savedIds.push(...result.evidence.map(({ evidence_id }) => evidence_id));
      after = result.coverage.next_after;
    } while (after);
    expect(savedIds).toEqual(ids);
    await expect(run(first.coverage.next_after!, "sources", "other"))
      .rejects.toMatchObject({ status: 409 });
    revision = "b".repeat(64);
    await expect(run(first.coverage.next_after!)).rejects.toMatchObject({ status: 409 });
    missing = true;
    let partial = await run();
    const forged = JSON.parse(Buffer.from(partial.coverage.next_after!, "base64url").toString());
    forged[4] = false;
    await expect(run(Buffer.from(JSON.stringify(forged)).toString("base64url")))
      .rejects.toMatchObject({ status: 409 });
    for (let page = 0; partial.coverage.next_after && page < 10; page++)
      partial = await run(partial.coverage.next_after);
    expect(partial.coverage).toMatchObject({ next_after: null, complete: false });
  });

  it("retains conflicting capture candidates without assigning two types to one highlight", async () => {
    const f = fixture();
    for (const id of [sourceLabel, highlightLabel]) await act(f,
      { type: "label", id, name: id, scope: "highlight" });
    const file = await act(f, { type: "source", reference: {
      provider: "courtlistener", id: "1", kind: "case", collection: "courtlistener" } }),
      source = Object.values(file.state.sources)[0].reference,
      text = "Panel Members: Alice\nPanel Members: Bob\nPanel Members: Carol\n",
      block = { kind: "paragraph", label: "1", start: 0, end: text.length, origin: "native", text },
      rules = [sourceLabel, highlightLabel].map((slot) => ({ phrase: "Panel Members:",
        direction: "after" as const, unit: "line" as const, slot }));
    const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1", {
      versionId: file.versionId, workingRevision: file.workingRevision, syntax: "literal",
      target: "sources", limit: 2, rules, conflict: "append" }, { reader: (async () => ({ status: "found",
        values: [{ source, role: "document", locator: { requested: null, label: "document" },
          text, documentArtifact: { text, blocks: [block] }, blockArtifact: block }] })) as never });
    expect(result.evidence.map(({ span_text }) => span_text)).toEqual(["Alice", "Bob"]);
    expect(result.coverage).toMatchObject({ complete: false, next_after: expect.any(String) });
    expect(result.receipt.failures).toContainEqual(expect.objectContaining({ code: "result_limit" }));
    expect(result.receipt.input.coverage).toEqual(result.coverage);
    const next = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1", {
      versionId: result.file.versionId, workingRevision: result.file.workingRevision, syntax: "literal",
      target: "sources", limit: 2, after: result.coverage.next_after!, rules, conflict: "append" },
      { reader: (async () => ({ status: "found", values: [{ source, role: "document",
        locator: { requested: null, label: "document" }, text,
        documentArtifact: { text, blocks: [block] }, blockArtifact: block }] })) as never });
    expect(next.evidence.map(({ span_text }) => span_text)).toEqual(["Carol"]);
    expect(next.coverage).toMatchObject({ complete: false, next_after: null });
    expect(next.receipt.failures).toContainEqual(expect.objectContaining({ code: "highlight_type_conflict" }));
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, next.file, "passages")).total).toBe(0);
    for (const labels of [...Object.values(result.receipt.slots), ...Object.values(next.receipt.slots)])
      expect(labels).toEqual([sourceLabel, highlightLabel]);
  });

  it("saves a Library highlight with its pen in one write and locates it by what the page prints", async () => {
    const f = fixture(), scope = { userId: "user-1" },
      text = "Recitals follow.\n\nThe governing law is Alberta.",
      blocks = [{ kind: "paragraph", label: "1", start: 0, end: 16, text: "Recitals follow." },
        { kind: "paragraph", label: "2", start: 18, end: text.length, text: "The governing law is Alberta." }],
      library = { provider: "library" as const, kind: "document" as const, id: "library-doc",
        versionId: "revision-1", title: "Lease.docx" },
      documents = Object.assign(f.documents, { projectionSource: vi.fn(async () => ({
        document: { text, blocks }, sourceSha256: "b".repeat(64) })) });
    await act(f, { type: "label", id: highlightLabel, name: "Key", scope: "highlight" });
    const prepared = await act(f, { type: "source", reference: library }),
      sourceId = Object.keys(prepared.state.sources)[0];
    const action = await verifyResearchPassage(prepared, { type: "passage", sourceId,
      locator: { kind: "document", value: "document" }, quote: "governing law is Alberta",
      labelIds: [highlightLabel] }, undefined, { documents: documents as never, scope });
    const saved = await act(f, action);
    expect(f.documents.replaceVersion).toHaveBeenCalledTimes(3);
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 1,
      labelCounts: { [highlightLabel]: 1 }, unlabelledCount: 0 });
    expect((await pageResearchItems(f.documents as never, scope, saved, "passages")).items[0])
      .toMatchObject({ value: { labelIds: [highlightLabel], receipt: {
        span_text: "governing law is Alberta", locator: { kind: "document", label: "document" } } } });
  });

  it("anchors a captured quote to its run of letters in the canonical text", async () => {
    const f = fixture();
    const saved = await act(f, { type: "source", reference: { provider: "courtlistener",
      id: "1", kind: "case", citation: "Example" } }), sourceId = Object.keys(saved.state.sources)[0],
      text = "The verified holding.", block = { kind: "paragraph", label: "1", start: 0,
        end: text.length, origin: "native", text }, source = saved.state.sources[sourceId].reference,
      reader = vi.fn(async () => ({ status: "found" as const, values: [{ source,
        locator: { requested: { kind: "paragraph" as const, value: "1" }, label: "1" },
        role: "selected" as const, text, blockArtifact: block,
        documentArtifact: { text, blocks: [block] } }] })), base = { type: "passage" as const,
        sourceId, locator: { kind: "paragraph" as const, value: "1" } };
    await expect(verifyResearchPassage(saved, { ...base, quote: "missing" }, reader as never))
      .rejects.toThrow("Select some text to highlight");
    const action = await verifyResearchPassage(saved, { ...base, quote: "verified holding" },
      reader as never), updated = await act(f, action);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, updated,
      "passages")).items[0]).toMatchObject({ value: { receipt: {
        span_text: "verified holding", locator: { kind: "document", label: "characters 5–20" } } } });
  });

  it("adaptively pages source parts when an aggregate read is too large", async () => {
    const f = fixture(), receipts = Array.from({ length: 205 }, (_, index) =>
      receipt(`case-${index}`));
    const saved = await act(f, { type: "merge", evidence: receipts });
    f.limitPartReads(50);
    f.documents.readParts.mockClear();
    const page = await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "evidence", 0, 200);
    expect(page.items).toHaveLength(200);
    expect(f.documents.readParts).toHaveBeenCalledTimes(6);
    expect(f.documents.readParts.mock.calls.every((call) => call[3].length <= 100)).toBe(true);
  });

  it("streams only selected saved-source parts and records attempted versus matched sources", async () => {
    const f = fixture(), receipts = [receipt("case-c"), receipt("case-d"),
      receipt("case-e", "no match")],
      initial = await act(f, { type: "merge", evidence: receipts }), sourceIds =
        Object.keys(initial.state.sources);
    let saved = await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    const first = (await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "evidence")).items.find(({ value }) => value.sourceId === sourceIds[0])!.value;
    saved = await act(f, { type: "annotate", kind: "evidence", sourceId: sourceIds[0],
      id: first.receipt.evidence_id, labelIds: [highlightLabel] });
    f.documents.readParts.mockClear();
    const queried = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", { versionId: saved.versionId, workingRevision: saved.workingRevision,
        text: "holding", syntax: "literal", target: "passages",
        sourceIds: [sourceIds[2], sourceIds[0]], labelIds: [highlightLabel], limit: 10 });
    expect(queried.receipt).toMatchObject({ sourceIds: [sourceIds[2], sourceIds[0]],
      matchedSourceIds: [sourceIds[0]], evidenceIds: [expect.any(String)] });
    expect(queried.receipt.sourceIds).toEqual([sourceIds[2], sourceIds[0]]);
    expect(queried.receipt.matchedSourceIds).toEqual([sourceIds[0]]);
    expect(f.documents.readParts.mock.calls.every((call) =>
      call[3].every((name: string) => name === "queries.json" ||
        name === `source.${sourceIds[2]}.json` || name === `source.${sourceIds[0]}.json`))).toBe(true);
  });

  it("maps imported query sources to this file", async () => {
    const f = fixture(), evidence = receipt("case-imported"), foreignSourceId =
      "30000000-0000-4000-8000-000000000001", resultSource = { provider: "courtlistener",
        id: "42", kind: "case" as const }, query = researchQueryReceipt({ query_id: "q_imported",
        call_id: "call", tool: "search_sources", executed_at: "2026-09-04T00:00:00.000Z",
        model: "human", executor_version: "legal-source-search-v1", input: {}, results: [
          { rank: 1, evidence_id: evidence.evidence_id },
          { rank: 2, resource: researchSourceResource(resultSource) }] });
    query.sourceIds = [foreignSourceId]; query.matchedSourceIds = [foreignSourceId];
    query.sourceReferences = { [foreignSourceId]: resultSource };
    for (const matchedSourceIds of [["bad"], ["30000000-0000-4000-8000-000000000002"]])
      await expect(act(f, { type: "merge", evidence: [evidence], queries: [
        { ...query, matchedSourceIds }] })).rejects.toThrow("invalid");
    const saved = await act(f, { type: "merge", evidence: [evidence], queries: [query] }),
      byReference = Object.fromEntries(Object.values(saved.state.sources).map((source) =>
        [source.reference.id, source.id])), imported = (await pageResearchItems(f.documents as never,
          { userId: "user-1" }, saved, "queries")).items[0].value;
    expect(imported).toMatchObject({ sourceIds: [byReference["42"], byReference["case-imported"]],
      matchedSourceIds: [byReference["42"], byReference["case-imported"]], sourceReferences: {
        [byReference["42"]]: resultSource } });
    expect(imported.sourceIds).not.toContain(foreignSourceId);
  });

  it("stops opening saved sources when captured text reaches the aggregate limit", async () => {
    const f = fixture(), references = Array.from({ length: 25 }, (_, index) => ({
      provider: "courtlistener", id: String(index + 1), kind: "case" as const })),
      saved = await act(f, { type: "merge", sources: references }), reader = vi.fn(async ({ source }:
        { source: { id: string } }) => { const id = Number(source.id), length = id < 20 ? 50_000
          : id === 20 ? 49_990 : id === 21 ? 20 : 10, text = `needle${"x".repeat(length)}`,
          block = { kind: "paragraph", label: "1", start: 0, end: text.length, origin: "native", text };
        return { status: "found" as const, values: [{ source,
          locator: { requested: null, label: "document" }, role: "document" as const,
          text, documentArtifact: { text, blocks: [block] }, blockArtifact: block }] }; });
    const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1",
      { versionId: saved.versionId, workingRevision: saved.workingRevision, syntax: "literal",
        target: "sources", rules: [{ phrase: "needle", direction: "after", unit: "chars",
          chars: 50_000 }] }, { reader: reader as never });
    expect(result.evidence).toHaveLength(20);
    expect(result.receipt.failures.filter(({ code }) => code === "result_limit")).toHaveLength(4);
    expect(reader).toHaveBeenCalledTimes(24);
    const continued = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1",
      { versionId: result.file.versionId, workingRevision: result.file.workingRevision,
        after: result.coverage.next_after!, syntax: "literal", target: "sources",
        rules: [{ phrase: "needle", direction: "after", unit: "chars", chars: 50_000 }] }, { reader: reader as never });
    expect(continued.evidence).toHaveLength(5);
    expect(new Set([...result.evidence, ...continued.evidence].map(({ evidence_id }) => evidence_id)).size)
      .toBe(25);
    expect(continued.coverage).toMatchObject({ complete: true, next_after: null });
  });

  it("keeps every source identity field distinct", async () => {
    const f = fixture(), base = { provider: "provider-a", family: "family-a", id: "1", part: "1",
      kind: "case" as const, collection: "collection-a", language: "en" as const }, sources = [base,
      { ...base, provider: "provider-b" }, { ...base, family: "family-b" }, { ...base, id: "2" },
      { ...base, part: "2" }, { ...base, kind: "legislation" as const },
      { ...base, collection: "collection-b" }, { ...base, language: "fr" as const }];
    const saved = await act(f, { type: "merge", sources });
    expect(Object.values(saved.state.sources).map(({ reference }) => reference)).toHaveLength(8);
  });

  it("keeps all overlapping labels on the last passage at the captured-byte boundary", async () => {
    const f = fixture();
    for (const id of [sourceLabel, highlightLabel]) await act(f,
      { type: "label", id, name: id, scope: "highlight" });
    const file = await act(f, { type: "source", reference: {
      provider: "courtlistener", id: "1", kind: "case" } }),
      source = Object.values(file.state.sources)[0].reference,
      text = Array.from({ length: 20 }, (_, index) =>
        `needle${String(index).padStart(2, "0")}${"x".repeat(49_998)}`).join("\n"),
      block = { kind: "paragraph", label: "1", start: 0, end: text.length, origin: "native", text };
    const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1", {
      versionId: file.versionId, workingRevision: file.workingRevision, syntax: "literal",
      target: "sources", conflict: "append", rules: [sourceLabel, highlightLabel].map((slot) => ({
        phrase: "needle", direction: "after", unit: "chars", chars: 50_000, slot })) },
      { reader: (async () => ({ status: "found", values: [{ source, role: "document",
        locator: { requested: null, label: "document" }, text,
        documentArtifact: { text, blocks: [block] }, blockArtifact: block }] })) as never });
    expect(result.evidence).toHaveLength(20);
    expect(result.evidence.reduce((sum, receipt) => sum + receipt.span_text!.length, 0)).toBe(1_000_000);
    const saved = await pageResearchItems(f.documents as never, { userId: "user-1" },
      result.file, "passages", 0, 20);
    for (const item of saved.items) expect(item.value.labelIds).toEqual([sourceLabel, highlightLabel]);
  });

  it("persists assistant queries and continues through the saved receipt", async () => {
    const f = fixture(), file = await act(f, { type: "source", reference: {
      provider: "courtlistener", id: "1", kind: "case" } }),
      source = Object.values(file.state.sources)[0].reference, text = "needle one\nneedle two",
      blocks = [0, 11].map((start, index) => ({ start, end: index ? text.length : 10,
        kind: "paragraph", label: String(index + 1), origin: "native", text: text.slice(start) })),
      reader = (async () => ({ status: "found", values: [{ source, role: "document",
        locator: { requested: null, label: "document" }, text,
        documentArtifact: { text, blocks }, blockArtifact: blocks[0] }] })) as never,
      input = { versionId: file.versionId, workingRevision: file.workingRevision,
        text: "needle", syntax: "literal" as const, target: "sources" as const, limit: 1 };
    const first = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", input, { reader, assistant: {} });
    expect(first.file.state.queries?.count).toBe(1);
    const continuation = { ...input, versionId: first.file.versionId,
      workingRevision: first.file.workingRevision, after: first.coverage.next_after! };
    await expect(runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", { ...continuation, workingRevision: -1 }, { reader, assistant: {} })).rejects.toMatchObject({ status: 409 });
    const second = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", continuation, { reader, assistant: {} });
    expect(second.evidence.map(({ span_text }) => span_text)).toEqual(["needle two"]);
    expect(second.file.state.queries?.count).toBe(2);
  });

  it("keeps a non-A2AJ search result and its evidence under one source", async () => {
    const f = fixture(), reference = { provider: "journal", family: "commentary",
      id: "article-1", kind: "journal" as const,
      collection: "Appeal Review" }, restored = researchSourceFromResource(
        researchSourceResource(reference));
    expect(restored).toEqual({ ...reference, language: "en" });
    const evidence = createPublicJournalPassageEvidence({ articleId: reference.id,
      collection: reference.collection, family: reference.family, citation: "Appeal Review 1",
      name: "Fairness", date: "2026", url: null, text: "The holding.",
      locatorKind: "page", locatorLabel: "4" });
    const saved = await act(f, { type: "merge", sources: [restored!], evidence: [evidence] });
    expect(Object.values(saved.state.sources)).toHaveLength(1);
    expect(Object.values(saved.state.sources)[0].reference).toMatchObject({
      title: "Fairness", citation: "Appeal Review 1", date: "2026" });
  });

  it("round-trips only the v2 index", () => {
    const state = createResearchFileState(); state.note = "Portable note";
    const markdown = researchFileMarkdown("Cases", state);
    expect(parseResearchFile(markdown)).toEqual(state);
    expect(parseResearchFile(markdown.replace("beaver-research:v2", "beaver-research:v1"))).toBeNull();
  });

  it("holds an explicit grouped proposal, accepts it atomically, and undoes only its affected fields", async () => {
    const f = fixture(), scope = { userId: "user-1" }, model = { executor: "assistant" as const, model: "model-a" },
      added = "40000000-0000-4000-8000-000000000001", later = "40000000-0000-4000-8000-000000000002";
    await act(f, { type: "label", id: sourceLabel, name: "Reviewed", definition: "Documents reviewed by the user" });
    const collected = await act(f, { type: "merge", evidence: [receipt("note")] }), sourceId = Object.keys(collected.state.sources)[0];
    await act(f, { type: "annotate", kind: "source", id: sourceId, labelIds: [sourceLabel] });
    const proposed = await act(f, { type: "batch", title: "Organize project material", propose: true, actions: [
      { type: "label", id: sourceLabel, name: "Read" }, { type: "label", id: added, name: "Follow up" },
      { type: "annotate", kind: "source", id: sourceId, labelIds: [added] },
    ] }, undefined, model), id = proposed.state.proposals![0].id;
    expect(proposed.state.labels[sourceLabel].name).toBe("Reviewed");
    expect(proposed.state.labels[added]).toBeUndefined();
    expect(proposed.state.sources[sourceId].labelIds).toEqual([sourceLabel]);
    await act(f, { type: "note", markdown: "Independent memo edit" });
    expect(await saveResearchFile(f.documents as never, scope, "doc-1", proposed.versionId, proposed.workingRevision,
      { type: "accept", changeId: id })).toBeNull();
    const accepted = await act(f, { type: "accept", changeId: id });
    expect(accepted.state.proposals).toEqual([]);
    expect(accepted.state.labels[sourceLabel].name).toBe("Read");
    expect(accepted.state.sources[sourceId].labelIds).toEqual([added]);
    await act(f, { type: "label", id: later, name: "Independent label" });
    await act(f, { type: "annotate", kind: "source", id: sourceId, labelIds: [added, later], note: "Keep this note" });
    const undone = await act(f, { type: "undo", changeId: id });
    expect(undone.state.labels[sourceLabel].name).toBe("Reviewed");
    expect(undone.state.labels[added]).toBeUndefined();
    expect(undone.state.labels[later].name).toBe("Independent label");
    expect(undone.state.sources[sourceId]).toMatchObject({ labelIds: [later, sourceLabel], note: "Keep this note" });
    expect(undone.state.note).toBe("Independent memo edit");
    const history = await readResearchHistory(f.documents as never, scope, undone);
    expect(history.find((change) => change.id === id)).toMatchObject({ status: "applied", executor: "assistant", resolvedBy: scope.userId });
    expect(history.at(-1)).toMatchObject({ status: "applied", undoOf: id, executor: "human" });
  });

  it("applies reversible model edits by default and rejects stale proposals without overwriting later changes", async () => {
    const f = fixture(), scope = { userId: "user-1" }, model = { executor: "assistant" as const };
    const original = await act(f, { type: "label", id: sourceLabel, name: "Original" });
    const changed = await act(f, { type: "label", ...original.state.labels[sourceLabel], name: "Model choice" }, undefined, model);
    const edit = (await readResearchHistory(f.documents as never, scope, changed)).at(-1)!;
    expect(changed.state.labels[sourceLabel].name).toBe("Model choice");
    expect(edit).toMatchObject({ executor: "assistant", userId: scope.userId, status: "applied" });
    expect(changed.state.proposals).toEqual([]);
    const proposed = await act(f, { type: "batch", title: "Suggested organization", propose: true,
      actions: [{ type: "label", id: sourceLabel, name: "Suggestion" }] }, undefined, model), id = proposed.state.proposals![0].id;
    const latest = await act(f, { type: "label", id: sourceLabel, name: "Later human choice" });
    await expect(commitResearchFile(f.documents as never, scope, latest, { type: "accept", changeId: id }))
      .rejects.toMatchObject({ status: 409 });
    await expect(commitResearchFile(f.documents as never, scope, latest, { type: "undo", changeId: edit.id }))
      .rejects.toMatchObject({ status: 409 });
    const rejected = await act(f, { type: "reject", changeId: id });
    expect(rejected.state.labels[sourceLabel].name).toBe("Later human choice");
    expect(rejected.state.proposals).toEqual([]);
    expect((await readResearchHistory(f.documents as never, scope, rejected)).find((entry) => entry.id === id)?.status).toBe("rejected");
  });

  it("uses earlier classification edits in the same batch and undoes the group together", async () => {
    const f = fixture(), scope = { userId: "user-1" }, passage = receipt("a"),
      model = { executor: "assistant" as const, model: "model-a" };
    await act(f, { type: "merge", evidence: [passage] });
    const classified = await act(f, { type: "batch", title: "Organize selected passages", actions: [
      { type: "label", id: sourceLabel, name: "Facts", scope: "highlight" },
      { type: "label", id: highlightLabel, name: "Relevant", scope: "highlight" },
      { type: "label-selection", target: "passages", evidenceIds: [passage.evidence_id], assign: [sourceLabel], mode: "add" },
      { type: "label-selection", target: "passages", labelIds: [sourceLabel], assign: [highlightLabel], mode: "add" },
    ] }, undefined, model), history = await readResearchHistory(f.documents as never, scope, classified);
    expect(classified.state.proposals).toEqual([]);
    expect((await pageResearchItems(f.documents as never, scope, classified, "passages")).items)
      .toMatchObject([{ value: { receipt: passage, labelIds: [highlightLabel] } }]);
    expect(history.at(-1)).toMatchObject({ title: "Organize selected passages", status: "applied",
      counts: { labels: 2, sources: 1, passages: 1 }, executor: "assistant", model: "model-a" });
    const undone = await act(f, { type: "undo", changeId: history.at(-1)!.id });
    expect(undone.state.labels).toEqual({});
    expect((await pageResearchItems(f.documents as never, scope, undone, "evidence")).items)
      .toMatchObject([{ value: { receipt: passage, labelIds: [] } }]);
  });

  it("preserves grounded main and reader answers without turning uncited reads into findings or highlights", async () => {
    const f = fixture(), scope = { userId: "user-1" }, first = receipt("a", "First holding"),
      reader = receipt("a", "Reader holding"), extra = receipt("a", "Additional passage"),
      second = receipt("b", "Second source"), uncited = receipt("c", "Uncited source"),
      event = (evidence: LegalEvidenceReceipt[], claims: GroundedAnswer["claims"]) => {
        const state = createLegalEvidenceTurnState(); evidence.forEach((item) => registerLegalEvidence(state, item));
        state.answer = claims; return legalEvidenceReceiptEvent(state)!;
      }, mainClaims = [{ text: "Combined answer", evidence_ids: [first.evidence_id, second.evidence_id] }],
      readerClaims = [{ text: "Reader finding", evidence_ids: [reader.evidence_id] }],
      chats = { get: async () => ({ id: "chat-1", research_file_id: "doc-1" }), transcript: async () => [
        { id: "user-1", role: "user", content: "Compare the cases" },
        { id: "message-1", role: "assistant", content: [event([first, second, extra, uncited], mainClaims),
          { type: "subagent_run", id: "reader-1", task: "Examine the first case", status: "completed",
            grounding: event([reader], readerClaims) }] },
      ] };
    await act(f, { type: "merge", evidence: [first, second, extra, uncited, reader], chats: ["chat-1"] });
    const file = (await readResearchFile(f.documents as never, scope, "doc-1"))!,
      findings = resolveChatFindings(file, "chat-1", await chats.transcript() as never);
    const main = findings.filter(({ question }) => question.id === "message-1:answer:0"),
      child = findings.find(({ question }) => question.id === "message-1:reader:reader-1"),
      passages = findings.filter(({ kind }) => kind === "passages");
    expect(main).toHaveLength(2);
    for (const finding of main) {
      expect(finding.answer.claims).toEqual(mainClaims);
      expect(finding.evidence).toEqual([first, second]);
      expect(finding.question.prompt).toBe("Compare the cases");
    }
    expect(child).toMatchObject({ kind: "answer", answer: { claims: readerClaims }, evidence: [reader],
      question: { prompt: "Examine the first case" }, origin: { messageId: "message-1", subagentId: "reader-1" } });
    expect(passages).toEqual([]);
    expect(new Set(findings.flatMap(({ evidence }) => evidence.map(({ evidence_id }) => evidence_id))).size).toBe(3);
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).total).toBe(0);
    expect((await pageResearchItems(f.documents as never, scope, file, "evidence")).total).toBe(5);
    expect(resolveChatFindings(file, "chat-1", await chats.transcript() as never)).toEqual(findings);
  });

  it("undoes passage classification and deletion with the exact original receipt", async () => {
    const f = fixture(), scope = { userId: "user-1" }, passage = createLibraryEvidence({
      documentId: "notes", versionId: "notes-v1", filename: "project notes.txt", sourceSha256: "a".repeat(64),
      start: 0, end: 17, spanText: "Deliver on Friday" });
    await act(f, { type: "label", id: highlightLabel, name: "Delivery", scope: "highlight" });
    const collected = await act(f, { type: "merge", evidence: [passage] }), sourceId = Object.keys(collected.state.sources)[0];
    const classified = await act(f, { type: "annotate", kind: "evidence", sourceId, id: passage.evidence_id,
      labelIds: [highlightLabel] }), classification = (await readResearchHistory(f.documents as never, scope, classified)).at(-1)!;
    const removed = await act(f, { type: "remove", kind: "source", id: sourceId }),
      deletion = (await readResearchHistory(f.documents as never, scope, removed)).at(-1)!;
    const restored = await act(f, { type: "undo", changeId: deletion.id });
    expect((await pageResearchItems(f.documents as never, scope, restored, "passages")).items).toMatchObject([
      { value: { receipt: passage, labelIds: [highlightLabel] } },
    ]);
    const unclassified = await act(f, { type: "undo", changeId: classification.id });
    expect((await pageResearchItems(f.documents as never, scope, unclassified, "evidence")).items).toMatchObject([
      { value: { receipt: passage, labelIds: [] } },
    ]);
  });

  it("keeps automatic reads and grounded support distinct from deliberate highlights", async () => {
    const f = fixture(), scope = { userId: "user-1" }, first = receipt("a"), second = receipt("b"),
      application = createSourceWorkspaceApplication(f.documents as never, { chats: {} as never, tables: {} as never,
        tabular: async () => { throw new Error("No table work in this test"); } }), turn = createLegalEvidenceTurnState();
    [first, second].forEach((item) => registerLegalEvidence(turn, item));
    let file = await application.observe(scope, "doc-1", legalEvidenceReceiptEvent(turn)!);
    expect(Object.values(file.state.sources).filter((source) => source.collected)).toEqual([]);
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).total).toBe(0);
    expect((await pageResearchItems(f.documents as never, scope, file, "evidence")).total).toBe(2);
    turn.answer = [{ text: "A grounded finding", evidence_ids: [first.evidence_id] }];
    file = await application.observe(scope, "doc-1", legalEvidenceReceiptEvent(turn)!);
    expect(Object.values(file.state.sources).filter((source) => source.collected).map(({ reference }) => reference.id)).toEqual(["a"]);
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).total).toBe(0);
    const source = Object.values(file.state.sources).find(({ reference }) => reference.id === "a")!;
    file = await act(f, { type: "merge", evidence: [first], labels: { [first.evidence_id]: [] } });
    const type = Object.values(file.state.labels).find(({ name }) => name === "Highlight")!;
    expect(type).toMatchObject({ scope: "highlight", color: "#d6b85a", parentId: null });
    expect(researchHighlightCount(file.state.sources[source.id])).toBe(1);
    file = await application.observe(scope, "doc-1", legalEvidenceReceiptEvent(turn)!);
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).items)
      .toMatchObject([{ value: { receipt: first, labelIds: [type.id] } }]);
    expect((await pageResearchItems(f.documents as never, scope, file, "evidence")).total).toBe(2);
  });

  it("changes one highlight type atomically without changing its evidence or source labels", async () => {
    const f = fixture(), scope = { userId: "user-1" }, passage = receipt("a"), other = "33333333-3333-4333-8333-333333333333";
    await act(f, { type: "label", id: sourceLabel, name: "Relevant", scope: "source" });
    await act(f, { type: "label", id: highlightLabel, name: "Test", scope: "highlight", color: "#d6b85a" });
    await act(f, { type: "label", id: other, name: "Application", scope: "highlight", color: "#86a5b6" });
    const initial = await act(f, { type: "merge", evidence: [passage], labels: { [passage.evidence_id]: [highlightLabel] } }),
      sourceId = Object.keys(initial.state.sources)[0];
    await act(f, { type: "annotate", kind: "source", id: sourceId, labelIds: [sourceLabel] });
    let file = await act(f, { type: "label-selection", target: "passages", evidenceIds: [passage.evidence_id],
      assign: [other], mode: "add" });
    const change = (await readResearchHistory(f.documents as never, scope, file)).at(-1)!;
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).items)
      .toMatchObject([{ value: { receipt: passage, labelIds: [other] } }]);
    expect(file.state.sources[sourceId].labelIds).toEqual([sourceLabel]);
    await expect(act(f, { type: "annotate", kind: "evidence", sourceId, id: passage.evidence_id,
      labelIds: [highlightLabel, other] })).rejects.toMatchObject({ status: 400 });
    file = await act(f, { type: "label", id: other, name: "Applied test", scope: "highlight", parentId: highlightLabel, color: "#93ab87" });
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).items[0])
      .toMatchObject({ value: { receipt: passage, labelIds: [other] } });
    file = await act(f, { type: "undo", changeId: change.id });
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).items[0])
      .toMatchObject({ value: { receipt: passage, labelIds: [highlightLabel] } });
    expect(file.state.labels[other]).toMatchObject({ name: "Applied test", parentId: highlightLabel, color: "#93ab87" });
  });

  it("keeps a citation resolvable after its highlight is removed and prevents a reread from resurrecting it", async () => {
    const f = fixture(), scope = { userId: "user-1" }, passage = receipt("a"),
      saved = await act(f, { type: "merge", evidence: [passage], labels: { [passage.evidence_id]: [] } }),
      sourceId = Object.keys(saved.state.sources)[0],
      application = createSourceWorkspaceApplication(f.documents as never, { chats: {} as never, tables: {} as never,
        tabular: async () => { throw new Error("No table work in this test"); } });
    const before = await application.citation(scope, "doc-1", sourceId, passage.evidence_id);
    await act(f, { type: "remove", kind: "evidence", sourceId, id: passage.evidence_id });
    const file = await act(f, { type: "merge", evidence: [passage] });
    expect((await pageResearchItems(f.documents as never, scope, file, "passages")).items).toEqual([]);
    expect(await application.citation(scope, "doc-1", sourceId, passage.evidence_id)).toEqual(before);
  });

});
