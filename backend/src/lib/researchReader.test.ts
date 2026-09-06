import { afterEach, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentStore } from "./documentStore";
import { structureNative } from "./structureNative";
import { sha256 } from "./hash";
import { researchSourceResource } from "./researchFile";
import { readLibraryResearchWindow, readResearchResource, restoreResearchEvidence,
  readResearchContext, researchReadCursors, researchReadContextSchema, childResearchReadContext,
  type ResearchRead, type ResearchReadContext } from "./researchReader";

afterEach(() => vi.restoreAllMocks());

it("keeps reader jurisdiction, collection and source-kind boundaries on scoped reads", async () => {
  const reference = { provider: "tna", kind: "case" as const, id: "ewca/civ/2024/1", collection: "EWCA" },
    resource = researchSourceResource(reference), context: ResearchReadContext = { restricted: true,
      subjects: [{ sourceId: "case", resource, reference, evidence: [] }] },
    read = (reader: Parameters<typeof readResearchResource>[2]["reader"]) => readResearchContext(
      {} as DocumentStore, { userId: "owner" }, context, { resource, reader });
  await expect(read({ task: "Read", scope: "Selected cases", jurisdiction: "CA" })).rejects.toThrow("CA boundary");
  await expect(read({ task: "Read", scope: "Selected cases", jurisdiction: "UK", collections: ["UKSC"] }))
    .rejects.toThrow("collection boundary");
  await expect(read({ task: "Read", scope: "Selected cases", jurisdiction: "UK", source_types: ["legislation"] }))
    .rejects.toThrow("source-type boundary");
});

it("continues every exact Library span across long Unicode lines and distinguishes invalid windows", async () => {
  const native = structureNative(), document = await native.deriveDocumentStructure({
    kind: "instrument", id: "long-read", text: `${'é😀"\\'.repeat(15_000)}\nFinal line.`, reconstruct_lineation: false }),
    original = native.documentText(document), spans: string[] = [];
  let pending: ResearchRead["coverage"]["next"] = [{ resource: "document://document/version/v1", offset: 1 }];
  for (let page = 0; pending.length && page < 100; page++) {
    const cursor = pending.shift()!, output = readLibraryResearchWindow({ documentId: "document", versionId: "v1",
      filename: "Long.txt", document, ...cursor, limit: 2_000 });
    expect(output.result.isError).not.toBe(true);
    expect(JSON.stringify(output.result).length).toBeLessThan(40_000);
    for (const receipt of output.evidence ?? []) {
      expect(receipt.span_text).toBe(original.slice(receipt.span!.start, receipt.span!.end));
      expect(receipt.exact_span_sha256).toBe(`sha256:${sha256(receipt.span_text!)}`);
      spans.push(receipt.span_text!);
    }
    expect(output.coverage.complete).toBe(output.coverage.next.length === 0);
    pending.push(...output.coverage.next);
  }
  expect(pending).toEqual([]);
  expect(spans.join("")).toBe(original.replace(/[\r\n]/gu, ""));
  const invalid = readLibraryResearchWindow({ documentId: "document", versionId: "v1",
    filename: "Long.txt", document, offset: 10_000 });
  expect(invalid.result.isError).toBe(true);
  expect(invalid.coverage.complete).toBe(false);
});

it("resumes a frozen source scope with its unread cursors and rejects wider passage assignments", async () => {
  let bytes = Buffer.from("First source sentence.\nSecond source sentence.\nThird source sentence.");
  const resource = "document://selected/version/v1", documents = {
    metadata: async () => ({ filename: "Notes.txt" }),
    projectionSource: async () => ({ documentId: "selected", versionId: "v1", fileType: "txt",
      sourceSha256: sha256(bytes), readBytes: () => bytes }),
  } as unknown as DocumentStore, scope = { userId: "owner" },
    context: ResearchReadContext = { restricted: true, workspace: { documentId: "workspace", versionId: "w1", workingRevision: 7 },
      subjects: [{ sourceId: "saved", resource,
        reference: { provider: "library", kind: "document", id: "selected", versionId: "v1" } }] };
  await readResearchContext(documents, scope, context, { resource, offset: 3, limit: 1 });
  expect(researchReadCursors(context)).toEqual([{ resource, offset: 1, start_char: 0 }]);
  const first = await readResearchContext(documents, scope, context, { resource, limit: 1, remainingOnly: true }),
    restored = researchReadContextSchema.parse(JSON.parse(JSON.stringify(context))),
    pending = researchReadCursors(restored);
  expect(pending).toEqual([{ resource, offset: 2, start_char: 0 }]);
  const second = await readResearchContext(documents, scope, restored, { ...pending[0], limit: 1, remainingOnly: true });
  expect(second.evidence?.map(({ span_text }) => span_text)).toEqual(["Second source sentence."]);
  const selected = childResearchReadContext(context, { resources: [resource],
    evidence_ids: [first.evidence![0].evidence_id] }, first.evidence!)!;
  expect((await readResearchContext(documents, scope, selected, { resource })).evidence).toEqual(first.evidence);
  expect(researchReadCursors(selected)).toEqual([]);
  expect(() => childResearchReadContext(selected, { evidence_ids: [second.evidence![0].evidence_id] },
    [...first.evidence!, ...second.evidence!])).toThrow("outside the selected workspace scope");
  await expect(readResearchContext(documents, scope, selected, { resource: "document://other/version/v1" }))
    .rejects.toThrow("outside the selected research scope");
  bytes = Buffer.from("First source sentence.\nSecond source sentence.\nChanged final sentence.");
  await expect(readResearchContext(documents, scope, restored, { ...researchReadCursors(restored)[0], limit: 1 }))
    .rejects.toThrow("Source changed during reading");
});

it("keeps spreadsheet cell identity and reads selected Library evidence without widening its scope", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Rate", 25], ["Other", 900]]), "Terms");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer,
    source = { documentId: "sheet", versionId: "v1", fileType: "xlsx", sourceSha256: sha256(bytes), readBytes: () => bytes },
    document = await documentProjectionService.read(source),
    initial = readLibraryResearchWindow({ documentId: "sheet", versionId: "v1", filename: "Terms.xlsx", document }),
    receipt = initial.evidence!.find(({ locator }) => locator.cells === "B1")!;
  expect(receipt).toMatchObject({ span_text: "25", locator: {
    kind: "cell", label: "Terms!B1", sheet: "Terms", cells: "B1" } });
  const documents = { metadata: async () => ({ filename: "Terms.xlsx", size_bytes: 1 }),
    projectionSource: async () => source,
    versions: async () => ({ versions: [{ id: "v1", size_bytes: bytes.length }] }),
  } as unknown as DocumentStore;
  const selected = await readResearchResource(documents, { userId: "owner" }, {
    resource: "document://sheet/version/v1", evidence: [receipt], maxBytes: bytes.length,
  });
  expect(selected.evidence).toEqual([receipt]);
  expect((await restoreResearchEvidence(documents, { userId: "owner" }, [receipt]))
    .map(({ receipt }) => receipt)).toEqual([receipt]);
  expect(await restoreResearchEvidence({ ...documents, projectionSource: async () => null },
    { userId: "other" }, [receipt])).toEqual([]);
  expect(selected.coverage).toEqual({ complete: true, next: [] });
  expect(JSON.stringify(selected.result)).not.toContain("900");
  await expect(readResearchResource(documents, { userId: "owner" }, {
    resource: "document://sheet/version/v1", evidence: [{ ...receipt, span: { start: 0, end: 2 } }],
  })).rejects.toThrow("Selected passage is unavailable");
  await expect(readResearchResource(documents, { userId: "owner" }, {
    resource: "document://sheet/version/v1", maxBytes: bytes.length - 1,
  })).rejects.toThrow("too large");
  await expect(readResearchResource(documents, { userId: "owner" }, {
    resource: "document://sheet/version/v1", expectedSourceSha256: "outdated-source",
  })).rejects.toThrow("Source changed");
  await expect(readResearchResource({ ...documents, metadata: async () => null }, { userId: "other" }, {
    resource: "document://sheet/version/v1", evidence: [receipt],
  })).rejects.toThrow("Document not found");
});
