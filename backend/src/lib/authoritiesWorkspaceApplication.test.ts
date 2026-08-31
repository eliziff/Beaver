import { describe, expect, it, vi } from "vitest";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { AuthoritiesBuildInput, AuthoritiesBuildResult } from "./authoritiesBuild";
import { createAuthoritiesDraft, reduceAuthoritiesDraft,
  type AuthoritiesDraft } from "./authoritiesDomain";
import { createAuthoritiesWorkspaceApplication } from "./authoritiesWorkspaceApplication";
import { createTnaEvidence } from "./chat/legalEvidence";
import type { DocumentFile, DocumentParseState, DocumentStore,
  DocumentVersion } from "./documentStore";
import { sha256 } from "./hash";
import type { WorkProduct } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

const scope: ApplicationScope = { userId: "lawyer" };
type Stored = { id: string; versions: Array<DocumentVersion & { bytes: Buffer;
  provenance?: unknown }> };

function harness(options: {
  draft?: AuthoritiesDraft;
  resolve?: (...args: unknown[]) => Promise<unknown>;
  download?: (...args: unknown[]) => Promise<{ bytes: Buffer; sourceSha256: string }>;
  builder?: (...args: never[]) => Promise<AuthoritiesBuildResult>;
  key?: (text: string) => string;
  occurrences?: (text: string) => unknown[];
  realImporter?: boolean;
  parseState?: DocumentParseState | ((id: string) => DocumentParseState);
} = {}) {
  const stored = new Map<string, Stored>();
  let sequence = 0, product: WorkProduct | null = null;
  const parseState = (id: string) => typeof options.parseState === "function"
    ? options.parseState(id) : options.parseState ?? { status: "ready" };
  const put = (file: DocumentFile & { provenance?: unknown }, id = `document-${++sequence}`) => {
    const bytes = "bytes" in file ? file.bytes : Buffer.alloc(file.sizeBytes);
    const version = { id: `version-${++sequence}`, version_number: 1, source: "upload",
      created_at: "2026-01-01T00:00:00.000Z", filename: file.filename,
      file_type: file.fileType, size_bytes: bytes.length, source_sha256: sha256(bytes),
      bytes, provenance: file.provenance };
    stored.set(id, { id, versions: [version] });
    return { id, filename: version.filename, file_type: version.file_type,
      current_version_id: version.id, active_version_number: 1,
      source_sha256: version.source_sha256 };
  };
  const documents = {
    read: vi.fn(async (_scope, id: string, versionId: string | null) => {
      const entry = stored.get(id), version = entry?.versions.find(({ id }) =>
        !versionId || id === versionId), state = parseState(id);
      return version ? { bytes: version.bytes, version, filename: version.filename,
        fileType: version.file_type, hasPdfRendition: version.file_type === "pdf",
        ...(version.file_type === "pdf" && ["ready", "degraded"].includes(state.status)
          ? { pdfProfile: {
            cacheKey: "c".repeat(64), profile: {},
            status: state.status,
          } } : {}) } : null;
    }),
    parseStates: vi.fn(async (_scope, ids: string[]) => ids.map((id) => ({ id,
      parse_state: parseState(id), page_count: 1 }))),
    projectionSource: vi.fn(async (_scope, id: string, versionId: string | null) => {
      const entry = stored.get(id), version = entry?.versions.find(({ id }) =>
        !versionId || id === versionId);
      return version ? { documentId: id, versionId: version.id,
        fileType: version.file_type, sourceSha256: version.source_sha256,
        readBytes: async () => version.bytes } : null;
    }),
    versions: vi.fn(async (_scope, id: string) => {
      const entry = stored.get(id);
      return entry ? { current_version_id: entry.versions[0]?.id ?? null,
        versions: entry.versions } : null;
    }),
    addVersion: vi.fn(async (_scope, id: string, file: DocumentFile & { provenance?: unknown }) => {
      const entry = stored.get(id);
      if (!entry) return null;
      const bytes = "bytes" in file ? file.bytes : Buffer.alloc(file.sizeBytes);
      const version = { id: `version-${++sequence}`, version_number: entry.versions.length + 1,
        source: "generated", created_at: "2026-01-01T00:00:00.000Z",
        filename: file.filename, file_type: file.fileType, size_bytes: bytes.length,
        source_sha256: sha256(bytes), bytes, provenance: file.provenance };
      entry.versions.unshift(version);
      return version;
    }),
    deleteDocument: vi.fn(async (_scope, id: string) => stored.delete(id)),
    deleteVersion: vi.fn(async (_scope, id: string, versionId: string) => {
      const entry = stored.get(id);
      if (!entry) return { status: "missing" };
      entry.versions = entry.versions.filter(({ id }) => id !== versionId);
      return { status: "deleted", currentVersionId: entry.versions[0]?.id ?? null };
    }),
  } as unknown as DocumentStore;
  const files = { create: vi.fn(async (_scope, _workflow, file) => put(file)) } as
    unknown as WorkflowFiles;
  const outputs = (refs: Record<string, { documentId: string; versionId: string }>) =>
    Object.fromEntries(Object.entries(refs).map(([role, ref]) => {
      const version = stored.get(ref.documentId)!.versions.find(({ id }) => id === ref.versionId)!;
      return [role, { ...ref, sha256: version.source_sha256, filename: version.filename,
        mimeType: version.file_type === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: null }];
    }));
  const workProducts = {
    list: vi.fn(async () => product ? [product] : []),
    get: vi.fn(async () => product ?? Promise.reject(new ApplicationError(404, "Draft not found"))),
    create: vi.fn(async (_scope, input) => product = { id: "draft-1", kind: input.kind,
      title: input.title, projectId: input.projectId ?? null, revision: 1,
      state: input.state, outputs: {}, createdAt: "now", updatedAt: "now" } as WorkProduct),
    save: vi.fn(async (_scope, _id, input) => {
      if (!product || product.revision !== input.revision) throw new ApplicationError(409, "stale");
      product = { ...product, revision: product.revision + 1,
        state: input.state ?? product.state,
        outputs: input.outputs ? outputs(input.outputs) : product.outputs };
      return product;
    }),
  } as unknown as WorkProductApplication;
  const importer = { draft: vi.fn(async () =>
    structuredClone(options.draft ?? createAuthoritiesDraft({ kind: "manual" }))) };
  const sources = {
    resolve: vi.fn(options.resolve ?? (async () => null)),
    download: vi.fn(options.download ?? (async () => Promise.reject(new Error("unused")))),
    key: vi.fn(options.key ?? (() => "canonical-key")),
    occurrences: vi.fn(options.occurrences ?? (() => [])),
    revision: vi.fn(() => "a".repeat(64)),
  };
  return { application: createAuthoritiesWorkspaceApplication(documents, workProducts, files,
    options.builder as never, options.realImporter ? undefined : importer, sources as never),
    documents, files, workProducts, importer, put,
    sources, stored,
    product: () => product! };
}

function built(id: string, revision: number,
  roles: Array<"table" | "book" | "annotated-document"> = ["table"]): AuthoritiesBuildResult {
  const builtAt = "2026-01-01T00:00:00.000Z";
  const artifacts = Object.fromEntries(roles.map((role) => {
    const pdf = role === "book", bytes = Buffer.from(`${pdf ? "%PDF-" : "PK\x03\x04"}${role}`);
    const filename = role === "table" ? "Authorities.table-of-authorities.docx"
      : role === "book" ? "Authorities.book-of-authorities.pdf"
        : "Authorities.with-table-of-authorities.docx";
    const mimeType = pdf ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const output = { role, filename, mimeType, pageCount: pdf ? 1 : null,
      sha256: sha256(bytes) };
    const receipt = { schemaVersion: "beaver.work-product-build.v2" as const, builtAt,
      workProduct: { id, kind: "authorities" as const, revision }, inputs: [],
      settings: { profileId: null, outputMode: roles.includes("book") ? "book" : "table",
        stateSha256: "e".repeat(64), settingsSha256: "f".repeat(64),
        sourceReceiptIds: [], audit: { effective: null, valuesJson: "{}" } },
      steps: ["Rendered"], output };
    return [role, { ...output, bytes, receipt }];
  })) as AuthoritiesBuildResult["artifacts"];
  return { artifacts,
    receipt: { schemaVersion: "beaver.authorities-build.v1", builtAt,
      workProduct: { id, kind: "authorities", revision }, inputs: [], draft: { schemaVersion:
        "beaver.authorities-draft.v1", outputMode: roles.includes("book") ? "book" : "table",
        insertIntoDocument: roles.includes("annotated-document"), document: null },
      authorities: [], outputs: Object.fromEntries(Object.entries(artifacts).map(
        ([role, artifact]) => [role, artifact && { filename: artifact.filename,
          mimeType: artifact.mimeType, sha256: artifact.sha256,
          pageCount: artifact.pageCount }])) } };
}

async function attachBookSource(runtime: ReturnType<typeof harness>) {
  let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
  product = await runtime.application.act(scope, product.id, product.revision, {
    type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith v Jones",
  });
  return runtime.application.attachPdf(scope, product.id, {
    revision: product.revision, authorityId: "canonical-key",
    file: { filename: "Smith.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nSmith\n%%EOF") },
  });
}

describe("Authorities workspace application", () => {
  it("resolves A2AJ metadata and promotes only its verified publisher PDF", async () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "scan-key", key: "scan-key", kind: "case",
        citation: "2024 FCA 1", name: null, displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const pdf = Buffer.from("%PDF-1.7\nverified\n%%EOF");
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "FCA",
      citation: "Law v Canada, 2024 FCA 1", alternateCitation: null, name: "Law v Canada",
      date: "2024-01-02", url: "https://decisions.fca-caf.gc.ca/item/1/index.do",
      verifiedPdf: { url: "https://decisions.fca-caf.gc.ca/item/1/1/document.do",
        pdfOnly: false }, language: "en", upstreamLicense: null, searchText: "text",
      native: {} as never, searchNative: {} as never }),
      download: async () => ({ bytes: pdf, sourceSha256: sha256(pdf) }) });

    const product = await runtime.application.importDraft(scope, {
      source: { kind: "manual" }, projectId: "project-1",
    });
    expect((product.state as AuthoritiesDraft).authorities["scan-key"]).toMatchObject({
      citation: "Law v Canada, 2024 FCA 1", name: "Law v Canada",
      source: { kind: "attached", sourceSha256: sha256(pdf) },
      sourceIdentity: { provider: "a2aj", stableSourceId: expect.any(String),
        sourceSha256: "a".repeat(64) },
    });
    expect(runtime.sources.download).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://decisions.fca-caf.gc.ca/item/1/1/document.do",
    }));
    expect(runtime.files.create).toHaveBeenCalledWith(scope, "authorities",
      expect.objectContaining({ filename: "Law v Canada.pdf" }),
      { projectId: "project-1" });
  });

  it.each([
    ["canonical", "www.canlii.org"],
    ["trailing-dot", "www.canlii.org."],
  ])("never downloads a %s CanLII URL and leaves its exact manual slot pending",
    async (_variant, providerHost) => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "grant", key: "grant", kind: "case",
        citation: "2009 SCC 32", name: "R v Grant", displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const pdfUrl = "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf";
    const providerPdfUrl = pdfUrl.replace("www.canlii.org", providerHost);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("CanLII requests are forbidden"));
    try {
      const runtime = harness({ draft, resolve: async () => ({ docType: "cases",
        dataset: "SCC", citation: "R v Grant, 2009 SCC 32", alternateCitation: null,
        name: "R v Grant", date: "2009-07-17",
        url: providerPdfUrl.replace(/\.pdf$/u, ".html"),
        verifiedPdf: { url: providerPdfUrl, pdfOnly: true }, language: "en",
        upstreamLicense: null, searchText: "text", native: {} as never,
        searchNative: {} as never }),
      });

      const product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

      expect((product.state as AuthoritiesDraft).authorities.grant.source).toEqual({
        kind: "pending-canlii", authorityKey: "grant",
        pageUrl: pdfUrl.replace(/\.pdf$/u, ".html"), pdfUrl,
      });
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(runtime.files.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("bounds independent provider work without changing authority order", async () => {
    let draft = createAuthoritiesDraft({ kind: "manual" });
    for (const [id, citation] of [["first", "2024 ABKB 1"], ["second", "2024 FCA 2"]]) {
      draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
        id, key: id, kind: "case", citation, name: null, displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" },
      } });
    }
    let active = 0, maximum = 0;
    const runtime = harness({ draft, resolve: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return null;
    } });
    const product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    expect(maximum).toBe(2);
    expect((product.state as AuthoritiesDraft).authorityOrder).toEqual(["first", "second"]);
  });

  it("supports a manual draft, canonical add, CanLII handoff, and manual attachment", async () => {
    const runtime = harness();
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith v Jones",
    });
    expect(runtime.sources.key).toHaveBeenCalledWith("2024 ABKB 123");
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source)
      .toMatchObject({ kind: "pending-canlii",
        pdfUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf" });
    product = await runtime.application.attachPdf(scope, product.id, {
      revision: product.revision, authorityId: "canonical-key",
      file: { filename: "smith.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nmanual\n%%EOF") },
    });
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source.kind)
      .toBe("attached");
    await expect(runtime.application.attachPdf(scope, product.id, {
      revision: product.revision - 1, authorityId: "canonical-key",
      file: { filename: "late.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-") },
    })).rejects.toMatchObject({ status: 409 });
  });

  it("adds exact grounded receipts without replacing or reparsing the draft", async () => {
    const runtime = harness({ realImporter: true, key: () => "existing" });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 1",
    });
    const sourceText = "First holding. Second holding.";
    const receipt = (spanText: string, locatorLabel: string) => createTnaEvidence({
      jurisdiction: "CA", sourceClass: "case", stableSourceId: "2016-scc-27",
      sourceText, spanText, citation: "2016 SCC 27", name: "R v Jordan",
      dataset: "fixture", version: "2016-07-08", locatorKind: "paragraph",
      locatorLabel,
    });
    const receipts = [receipt("First holding.", "par1"),
      receipt("Second holding.", "par2")];
    vi.mocked(runtime.documents.read).mockClear();
    runtime.sources.key.mockClear();

    product = await runtime.application.addReceipts(scope, product.id, product.revision, [{
      authorityKey: "2016scc27", receipts,
    }]);

    let state = product.state as AuthoritiesDraft;
    expect(state.authorityOrder).toEqual(["existing", "2016scc27"]);
    expect(state.authorities["2016scc27"]).toMatchObject({
      citation: "2016 SCC 27",
      evidenceIds: receipts.map(({ evidence_id }) => evidence_id).sort(),
      locators: [{ kind: "paragraph", label: "par1" },
        { kind: "paragraph", label: "par2" }],
      source: { kind: "resolved" }, sourceIdentity: { provider: "tna",
        stableSourceId: "2016-scc-27", sourceSha256: receipts[0].source_sha256,
        version: "2016-07-08" },
    });
    product = await runtime.application.attachPdf(scope, product.id, {
      revision: product.revision, authorityId: "2016scc27",
      file: { filename: "Jordan.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nJordan\n%%EOF") },
    });
    const additional = receipt("First holding.", "par3");
    product = await runtime.application.addReceipts(scope, product.id, product.revision, [{
      authorityKey: "2016scc27", receipts: [additional],
    }]);
    state = product.state as AuthoritiesDraft;
    expect(state.authorityOrder).toEqual(["existing", "2016scc27"]);
    expect(state.authorities["2016scc27"].evidenceIds)
      .toEqual([...receipts.map(({ evidence_id }) => evidence_id), additional.evidence_id].sort());
    expect(state.authorities["2016scc27"]).toMatchObject({
      source: { kind: "attached", filename: "Jordan.pdf" },
      sourceIdentity: { provider: "tna", stableSourceId: "2016-scc-27",
        sourceSha256: receipts[0].source_sha256, version: "2016-07-08" },
    });
    expect(runtime.documents.read).not.toHaveBeenCalled();
    expect(runtime.sources.key).not.toHaveBeenCalled();
    await expect(runtime.application.addReceipts(scope, product.id, product.revision - 1, [{
      authorityKey: "2016scc27", receipts,
    }])).rejects.toMatchObject({ status: 409 });
  });

  it("derives split and merge replacements from one footnote and a cursor", async () => {
    const text = "2024 ABKB 1; 2024 FCA 2", sourceTextSha256 = sha256(Buffer.from(text));
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "ab-key", key: "ab-key", kind: "case",
        citation: "2024 ABKB 1", name: null, displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    draft = { ...draft, units: [{ id: "footnote:1", kind: "footnote", ordinal: 0,
      footnoteId: 1, footnoteRefs: [], pageNumbers: [], text,
      occurrenceIds: ["original"] }],
    occurrences: { original: { id: "original", unitId: "footnote:1", start: 0,
      end: text.length, text, kind: "case", citation: "2024 ABKB 1",
      authorityId: "ab-key", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256, localOrdinal: 0, reviewed: false } } };
    const occurrence = (value: string) => ({ text: value, start: 0, end: value.length,
      styledCitation: { text: value, start: 0, end: value.length },
      coreCitation: { text: value, start: 0, end: value.length },
      pinpoints: [], kind: "case" as const, reasons: [] });
    const runtime = harness({ draft,
      key: (value) => value.includes("FCA") ? "fca-key" : "ab-key",
      occurrences: (value) => value.includes(";")
        ? value.split(";").map((item) => occurrence(item.trim())) : [occurrence(value)] });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "split-occurrence", occurrenceId: "original", cursor: text.indexOf(";") + 1,
    });
    let state = product.state as AuthoritiesDraft;
    expect(state.units[0].occurrenceIds.map((id) => state.occurrences[id].text))
      .toEqual(["2024 ABKB 1;", "2024 FCA 2"]);
    expect(state.authorities["fca-key"].citation).toBe("2024 FCA 2");
    const right = state.units[0].occurrenceIds[1];
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "merge-occurrence", occurrenceId: right,
    });
    state = product.state as AuthoritiesDraft;
    expect(state.units[0].occurrenceIds).toHaveLength(1);
    expect(state.occurrences[state.units[0].occurrenceIds[0]])
      .toMatchObject({ start: 0, end: text.length, text, authorityId: null });
  });

  it("replaces obsolete output roles after output-mode changes", async () => {
    const builder = vi.fn(async ({ draft: state, workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, [
        ...(state.outputMode !== "book" ? ["table" as const] : []),
        ...(state.outputMode !== "table" ? ["book" as const] : []),
        ...(state.insertIntoDocument ? ["annotated-document" as const] : []),
      ]));
    const runtime = harness({ builder: builder as never });
    const bytes = Buffer.from("PK\x03\x04brief"), source = runtime.put({
      filename: "brief.docx", fileType: "docx", bytes,
    }, "source-document");
    const snapshot = { documentId: source.id, versionId: source.current_version_id,
      sha256: source.source_sha256 };
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "document",
      bindingRole: "source", filename: source.filename, fileType: "docx", snapshot }, {
      source: { kind: "document", documentId: source.id,
        version: { versionId: snapshot.versionId, sha256: snapshot.sha256 } },
    }), { type: "set-document-output", enabled: true });
    runtime.importer.draft.mockResolvedValue(draft);
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const first = await runtime.application.build(scope, product.id, product.revision);
    expect(Object.keys(first.product.outputs).sort()).toEqual([
      "annotated-document", "book", "table",
    ]);
    const firstTable = first.product.outputs.table;
    product = await runtime.application.act(scope, product.id, first.product.revision, {
      type: "set-output-mode", outputMode: "table",
    });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "set-document-output", enabled: false,
    });
    expect(Object.keys(product.outputs).sort()).toEqual([
      "annotated-document", "book", "table",
    ]);

    const rebuilt = await runtime.application.build(scope, product.id, product.revision);

    expect(Object.keys(rebuilt.product.outputs)).toEqual(["table"]);
    expect(rebuilt.product.outputs.table.documentId).toBe(firstTable.documentId);
    expect(rebuilt.product.outputs.table.versionId).not.toBe(firstTable.versionId);
    const saved = vi.mocked(runtime.workProducts.save).mock.calls.at(-1)?.[2];
    expect(Object.keys(saved?.outputs ?? {})).toEqual(["table"]);
    expect(runtime.stored.get(firstTable.documentId)?.versions[0].provenance)
      .toMatchObject({ receipt: { workProduct: { revision: product.revision },
        output: { role: "table" } } });
  });

  it("keeps a Book pending while its attached PDF job is doing OCR", async () => {
    const builder = vi.fn(async ({ workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, ["book"]));
    const runtime = harness({
      draft: createAuthoritiesDraft({ kind: "manual" }, {}, "book"),
      parseState: { status: "parsing", phase: "ocr", pages: [2, 4] },
      builder: builder as never,
    });
    const product = await attachBookSource(runtime);

    await expect(runtime.application.build(scope, product.id, product.revision))
      .rejects.toMatchObject({ status: 409, message: "Smith.pdf is still being prepared.",
        details: { pdf_status: "parsing", pdf_phase: "ocr", pdf_pages: "2,4" } });
    expect(builder).not.toHaveBeenCalled();
  });

  it("returns the existing actionable password failure before Book assembly", async () => {
    const builder = vi.fn(async ({ workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, ["book"]));
    const runtime = harness({
      draft: createAuthoritiesDraft({ kind: "manual" }, {}, "book"),
      parseState: { status: "failed",
        error: "PDF is password-protected. Remove its password, then upload it again." },
      builder: builder as never,
    });
    const product = await attachBookSource(runtime);

    await expect(runtime.application.build(scope, product.id, product.revision))
      .rejects.toMatchObject({ status: 409,
        message: "Smith.pdf: PDF is password-protected. Remove its password, then upload it again.",
        details: { pdf_status: "failed" } });
    expect(builder).not.toHaveBeenCalled();
  });

  it("prepares only included Book PDFs and keeps table-only attachments receipt-only", async () => {
    let blockedId = "", tableOnly = false;
    const builder = vi.fn(async ({ draft, workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, [draft.outputMode === "book" ? "book" : "table"]));
    const runtime = harness({
      parseState: (id) => id === blockedId || tableOnly
        ? { status: "failed",
          error: "PDF is password-protected. Remove its password, then upload it again." }
        : { status: "ready" },
      builder: builder as never,
    });
    const includedBytes = Buffer.from("%PDF-1.7\nincluded\n%%EOF");
    const included = runtime.put({ filename: "Included.pdf", fileType: "pdf",
      bytes: includedBytes }, "included-document");
    const excluded = runtime.put({ filename: "Excluded.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nexcluded\n%%EOF") }, "excluded-document");
    blockedId = excluded.id;
    let draft = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
    for (const [id, file, isExcluded] of [
      ["included", included, false], ["excluded", excluded, true],
    ] as const) {
      draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
        id, key: id, kind: "case", citation: id, name: null, displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" },
      } });
      draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: id,
        bindingRole: `authority:${id}`, binding: { kind: "document", documentId: file.id,
          version: { versionId: file.current_version_id, sha256: file.source_sha256 } },
        filename: file.filename, sourceSha256: file.source_sha256, sourceUrl: null });
      if (isExcluded) draft = reduceAuthoritiesDraft(draft,
        { type: "exclude-authority", authorityId: id, excluded: true });
    }
    runtime.importer.draft.mockResolvedValue(draft);
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

    const book = await runtime.application.build(scope, product.id, product.revision);

    expect(Object.keys(book.product.outputs)).toEqual(["book"]);
    expect(runtime.documents.parseStates).toHaveBeenCalledWith(scope, [included.id]);
    const bookSources = builder.mock.calls[0][0].sources!;
    expect(bookSources["authority:included"]?.bytes).toEqual(includedBytes);
    expect(bookSources["authority:excluded"]).toMatchObject({ resolved: {
      kind: "document", documentId: excluded.id, versionId: excluded.current_version_id,
    } });
    expect(bookSources["authority:excluded"]).not.toHaveProperty("bytes");

    product = await runtime.application.act(scope, product.id, book.product.revision,
      { type: "set-output-mode", outputMode: "table" });
    tableOnly = true;
    vi.mocked(runtime.documents.parseStates).mockClear();
    const table = await runtime.application.build(scope, product.id, product.revision);

    expect(Object.keys(table.product.outputs)).toEqual(["table"]);
    expect(runtime.documents.parseStates).not.toHaveBeenCalled();
    const tableSources = builder.mock.calls.at(-1)![0].sources!;
    expect(tableSources["authority:included"]).not.toHaveProperty("bytes");
    expect(tableSources["authority:excluded"]).not.toHaveProperty("bytes");
  });

  it("silently uses an exact prepared PDF and keeps immutable Book rebuilds", async () => {
    const builder = vi.fn(async ({ workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, ["book"]));
    const runtime = harness({
      draft: createAuthoritiesDraft({ kind: "manual" }, {}, "book"),
      parseState: { status: "ready", page_count: 1 }, builder: builder as never,
    });
    const product = await attachBookSource(runtime);
    const bindingRole = Object.values((product.state as AuthoritiesDraft).authorities)
      .find(({ source }) => source.kind === "attached")!.source;
    if (bindingRole.kind !== "attached") throw new Error("fixture source was not attached");

    const first = await runtime.application.build(scope, product.id, product.revision);
    const second = await runtime.application.build(scope, product.id, first.product.revision);

    expect(runtime.documents.parseStates).toHaveBeenCalled();
    expect(builder).toHaveBeenCalledWith(expect.objectContaining({ sources:
      expect.objectContaining({ [bindingRole.bindingRole]: expect.objectContaining({
        bytes: Buffer.from("%PDF-1.7\nSmith\n%%EOF"), resolved: expect.objectContaining({
          sha256: bindingRole.sourceSha256,
        }) }) }) }));
    expect(second.product.outputs.book.documentId).toBe(first.product.outputs.book.documentId);
    expect(second.product.outputs.book.versionId).not.toBe(first.product.outputs.book.versionId);
    expect(runtime.stored.get(first.product.outputs.book.documentId)?.versions).toHaveLength(2);
  });

  it("persists stable output documents, exact provenance, and immutable rebuild versions", async () => {
    const builder = vi.fn(async ({ workProduct }) => built(workProduct.id, workProduct.revision));
    const runtime = harness({ builder: builder as never });
    let product = await runtime.application.importDraft(scope, {
      source: { kind: "manual" }, projectId: "project-1",
    });
    const first = await runtime.application.build(scope, product.id, product.revision);
    const firstOutput = first.product.outputs.table;
    const second = await runtime.application.build(scope, product.id, first.product.revision);
    expect(second.product.outputs.table.documentId).toBe(firstOutput.documentId);
    expect(second.product.outputs.table.versionId).not.toBe(firstOutput.versionId);
    const versions = runtime.stored.get(firstOutput.documentId)!.versions;
    expect(versions).toHaveLength(2);
    expect(versions[0].provenance).toMatchObject({ actor: "work-product", action: "built",
      receipt: { output: { role: "table", sha256: second.product.outputs.table.sha256 } } });
    expect(runtime.files.create).toHaveBeenCalledWith(scope, "authorities",
      expect.objectContaining({ filename: "Authorities.table-of-authorities.docx" }),
      { projectId: "project-1" });
    expect(first).not.toHaveProperty("build");
  });
});
