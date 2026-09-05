import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "./applicationError";
import { createA2AJPassageEvidence, createPublicJournalPassageEvidence } from "./chat/legalEvidence";
import { sha256 } from "./hash";
import { commitResearchFile, createResearchFileState, pageResearchItems, parseResearchFile,
  readResearchFile, researchFileActionSchema, researchFileMarkdown, researchQueryReceipt,
  researchSourceFromResource, researchSourceResource, type ResearchFileAction } from "./researchFile";
import { runResearchFileQuery, verifyResearchPassage } from "./researchFileQuery";

vi.mock("./structureNative", () => ({ structureNative: () => ({
  documentRevision: (document: { revision?: string }) => document.revision ?? "a".repeat(64),
  documentText: (document: { text: string }) => document.text,
  documentAnchors: (document: { blocks: unknown[] }) => document.blocks,
  smallestContainingDocumentBlock: (document: { blocks: Array<{ start: number; end: number }> },
    start: number, end: number) => document.blocks.find((block) =>
      block.start <= start && block.end >= end) ?? null,
  legalSourceViewer: () => ({ slices: [] }),
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
    replaceVersion: vi.fn(async (_scope, _id, _version, _revision, input) => write(input, false)),
    commitAssistantVersion: vi.fn(async (_scope, _id, input) =>
      write(input, true, input.turnVersionId)),
  };
  return { documents, parts, root: () => root,
    limitPartReads: (limit: number) => { partReadLimit = limit; } };
}

async function act(f: ReturnType<typeof fixture>, action: ResearchFileAction,
  assistant?: { turnVersionId?: string; turnId?: string }) {
  const current = await readResearchFile(f.documents as never, { userId: "user-1" }, "doc-1");
  expect(current).not.toBeNull();
  const result = await commitResearchFile(f.documents as never, { userId: "user-1" },
    current!, action, assistant);
  expect(result).not.toBeNull(); return result!;
}

const receipt = (id: string, text = `holding ${id}`) => createA2AJPassageEvidence({
  citation: id, name: id, dataset: "scc", language: "en", sourceText: text, spanText: text,
  start: 0, end: text.length, externalUrl: null, sourceClass: "case",
  sourceReference: { id }, sourceSha256: id.repeat(64).slice(0, 64).replace(/[^a-f0-9]/gu, "a") });

describe("Research v2 parts", () => {
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
      "passages", 0, 20);
    expect(page.items[0]).toMatchObject({ kind: "passage",
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
    expect(f.parts.has(partName)).toBe(false);
  });

  it("indexes labels beyond the first passage page and prunes them from the source part", async () => {
    const f = fixture();
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: Array.from({ length: 51 }, (_, index) =>
      receipt("case-page", `holding ${index}`)) }), sourceId = Object.keys(saved.state.sources)[0],
      partName = `source.${sourceId}.json`, secondPage = await pageResearchItems(
        f.documents as never, { userId: "user-1" }, saved, "passages", 50, 1);
    saved = await act(f, { type: "annotate", kind: "evidence", sourceId,
      id: secondPage.items[0].value.receipt.evidence_id, labelIds: [highlightLabel] });
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 51,
      labelCounts: { [highlightLabel]: 1 }, unlabelledCount: 50 });
    const previous = f.parts.get(partName);
    saved = await act(f, { type: "remove", kind: "label", id: highlightLabel });
    expect(saved.state.sources[sourceId].passages).toMatchObject({ count: 51,
      labelCounts: {}, unlabelledCount: 51 });
    expect(f.parts.get(partName)).not.toBe(previous);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "passages", 50, 1)).items[0]).toMatchObject({ value: { labelIds: [] } });
  });

  it("enforces three-level label nesting and rejects cycles", async () => {
    const f = fixture(), root = "30000000-0000-4000-8000-000000000001",
      child = "30000000-0000-4000-8000-000000000002",
      grandchild = "30000000-0000-4000-8000-000000000003";
    await act(f, { type: "label", id: root, name: "Root", scope: "source" });
    await act(f, { type: "label", id: child, name: "Child", parentId: root, scope: "source" });
    const saved = await act(f, { type: "label", id: grandchild, name: "Grandchild",
      parentId: child, scope: "source" });
    await expect(commitResearchFile(f.documents as never, { userId: "user-1" }, saved,
      { type: "label", name: "Too deep", parentId: grandchild, scope: "source" }))
      .rejects.toThrow("three levels");
    await expect(commitResearchFile(f.documents as never, { userId: "user-1" }, saved,
      { type: "label", id: root, name: "Root", parentId: grandchild, scope: "source" }))
      .rejects.toThrow();
  });

  it("keeps query receipts after labels and sources are removed without reading source parts", async () => {
    const f = fixture();
    await act(f, { type: "label", id: sourceLabel, name: "Filed", scope: "source" });
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: [receipt("case-b")] });
    const sourceId = Object.keys(saved.state.sources)[0], evidence = (await pageResearchItems(
      f.documents as never, { userId: "user-1" }, saved, "passages")).items[0].value.receipt,
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
    expect(f.documents.readParts.mock.calls.flatMap((call) => call[3])).toEqual(["queries.json"]);
    expect(f.parts.has(`source.${sourceId}.json`)).toBe(false);
    const ledger = await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "queries", 0, 20);
    expect(ledger.items.map(({ value }) => value.query_id)).toEqual(["q_new", "q_saved"]);
    expect(ledger.items[1]).toMatchObject({ value: { labelPaths: {
      [sourceLabel]: "Filed", [highlightLabel]: "Holding" }, sourceReferences: {
        [sourceId]: { id: "case-b" } } } });
  });

  it("queries literal or terms in caller source order and respects saved label scope", async () => {
    const f = fixture();
    await act(f, { type: "label", id: sourceLabel, name: "Filed", scope: "source" });
    await act(f, { type: "label", id: highlightLabel, name: "Holding", scope: "highlight" });
    let saved = await act(f, { type: "merge", evidence: [receipt("case-a", "alpha x beta"),
      receipt("case-b", "alpha beta labelled"), receipt("case-c", "alpha beta")] });
    const byReference = Object.fromEntries(Object.values(saved.state.sources)
      .map((source) => [source.reference.id, source.id])), passages = (await pageResearchItems(
        f.documents as never, { userId: "user-1" }, saved, "passages")).items;
    saved = await act(f, { type: "annotate", kind: "source", id: byReference["case-a"],
      labelIds: [sourceLabel] });
    saved = await act(f, { type: "annotate", kind: "evidence", sourceId: byReference["case-b"],
      id: passages.find(({ value }) => value.receipt.source_reference?.id === "case-b")!.value
        .receipt.evidence_id, labelIds: [highlightLabel] });
    const ordered = [byReference["case-c"], byReference["case-a"], byReference["case-b"]],
      run = async (input: Partial<Parameters<typeof runResearchFileQuery>[3]>) => {
        const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
          "doc-1", { versionId: saved.versionId, workingRevision: saved.workingRevision,
            text: "alpha beta", syntax: "terms", target: "passages", sourceIds: ordered,
            limit: 10, ...input });
        saved = result.file; return result;
      }, ids = (result: Awaited<ReturnType<typeof run>>) => result.evidence.map((item) =>
        item.source_reference?.id);
    expect(ids(await run({}))).toEqual(["case-c", "case-a", "case-b"]);
    expect(ids(await run({ syntax: "literal" }))).toEqual(["case-c", "case-b"]);
    expect(ids(await run({ unlabelled: true }))).toEqual(["case-c", "case-a"]);
    expect(ids(await run({ labelIds: [highlightLabel] }))).toEqual(["case-b"]);
    expect(ids(await run({ labelIds: [sourceLabel] }))).toEqual(["case-a"]);
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
      run = async (conflict: "first" | "append") => {
        const result = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
          "doc-1", { versionId: saved.versionId, workingRevision: saved.workingRevision,
            syntax: "literal", target: "sources", sourceIds: [sourceId], rules, conflict },
          { reader: reader as never });
        saved = result.file; return result;
      };
    expect((await run("first")).evidence.map(({ span_text }) => span_text))
      .toEqual(["abcdefghij", "kl"]);
    const appended = await run("append"), slots = Object.fromEntries(appended.evidence.map(
      (item) => [item.span_text, appended.receipt.slots[item.evidence_id]]));
    expect(slots).toEqual({ abcdefghij: [labels[0]], fghij: [labels[1]], kl: [labels[2]] });
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
          direction: "after" as const, unit: "chars" as const, chars: 8, slot: "Unclassified" }] };
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

  it("continues bounded rule capture without duplicate passages or lost overlapping label assignments", async () => {
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
    expect(next.coverage).toMatchObject({ complete: true, next_after: null });
    for (const labels of [...Object.values(result.receipt.slots), ...Object.values(next.receipt.slots)])
      expect(labels).toEqual([sourceLabel, highlightLabel]);
  });

  it("accepts only a quote verified against the selected canonical passage", async () => {
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
      .rejects.toThrow("not contained");
    const action = await verifyResearchPassage(saved, { ...base, quote: "verified holding" },
      reader as never), updated = await act(f, action);
    expect((await pageResearchItems(f.documents as never, { userId: "user-1" }, updated,
      "passages")).items[0]).toMatchObject({ value: { receipt: {
        span_text: "verified holding", locator: { kind: "paragraph", label: "1" } } } });
  });

  it("adaptively pages source parts when an aggregate read is too large", async () => {
    const f = fixture(), receipts = Array.from({ length: 205 }, (_, index) =>
      receipt(`case-${index}`));
    const saved = await act(f, { type: "merge", evidence: receipts });
    f.limitPartReads(50);
    f.documents.readParts.mockClear();
    const page = await pageResearchItems(f.documents as never, { userId: "user-1" }, saved,
      "passages", 0, 200);
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
      "passages")).items.find(({ value }) => value.sourceId === sourceIds[0])!.value;
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
          chars: 50_000, slot: "Unclassified" }] }, { reader: reader as never });
    expect(result.evidence).toHaveLength(20);
    expect(result.receipt.failures.filter(({ code }) => code === "result_limit")).toHaveLength(4);
    expect(reader).toHaveBeenCalledTimes(24);
    const continued = await runResearchFileQuery(f.documents as never, { userId: "user-1" }, "doc-1",
      { versionId: result.file.versionId, workingRevision: result.file.workingRevision,
        after: result.coverage.next_after!, syntax: "literal", target: "sources",
        rules: [{ phrase: "needle", direction: "after", unit: "chars", chars: 50_000,
          slot: "Unclassified" }] }, { reader: reader as never });
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

  it("continues unsaved assistant queries only through a trusted turn receipt", async () => {
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
    expect(first.file.state.queries).toBeNull();
    const continuation = { ...input, after: first.coverage.next_after! };
    await expect(runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", continuation, { reader, assistant: {} })).rejects.toMatchObject({ status: 409 });
    const second = await runResearchFileQuery(f.documents as never, { userId: "user-1" },
      "doc-1", continuation, { reader, assistant: {}, priorQueries: [first.receipt] });
    expect(second.evidence.map(({ span_text }) => span_text)).toEqual(["needle two"]);
    expect(second.file.state.queries).toBeNull();
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
});
