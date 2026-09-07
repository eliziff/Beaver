import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, FootnoteReferenceRun, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument } from "pdf-lib";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { AuthoritiesBuildInput, AuthoritiesBuildResult,
  AuthoritiesOutputRole } from "./authoritiesBuild";
import { createAuthoritiesDraft, reduceAuthoritiesDraft,
  type AuthoritiesDraft } from "./authoritiesDomain";
import type { AuthoritiesDiscrepancy } from "./authoritiesDiscrepancy";
import { applyAuthoritiesUserAction } from "./authoritiesActions";
import { createAuthoritiesWorkspaceApplication } from "./authoritiesWorkspaceApplication";
import { createTnaEvidence } from "./chat/legalEvidence";
import type { DocumentFile, DocumentParseState, DocumentStore,
  DocumentVersion } from "./documentStore";
import { sha256 } from "./hash";
import type { WorkProduct } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

const pdfText = vi.hoisted(() => vi.fn(async () => ({
  pageTextByPage: [] as string[], ocrTextByPage: [] as string[],
})));
vi.mock("./authorityPdfText", () => ({ authorityPdfText: pdfText }));

const scope: ApplicationScope = { userId: "lawyer" };
type Stored = { id: string; projectId: string | null; folderId: string | null;
  versions: Array<DocumentVersion & { bytes: Buffer; provenance?: unknown }> };

function harness(options: {
  draft?: AuthoritiesDraft;
  resolve?: (...args: unknown[]) => Promise<unknown>;
  download?: (...args: unknown[]) => Promise<{
    bytes: Buffer; sourceSha256: string; url?: string } | null>;
  builder?: (...args: never[]) => Promise<AuthoritiesBuildResult>;
  key?: (text: string) => string;
  occurrences?: (text: string) => unknown[];
  realImporter?: boolean;
  reviewer?: (draft: AuthoritiesDraft, signal?: AbortSignal) => Promise<AuthoritiesDiscrepancy[]>;
  parseState?: DocumentParseState | ((id: string) => DocumentParseState);
} = {}) {
  const stored = new Map<string, Stored>();
  let sequence = 0, product: WorkProduct | null = null;
  const parseState = (id: string) => typeof options.parseState === "function"
    ? options.parseState(id) : options.parseState ?? { status: "ready" };
  const put = (file: DocumentFile & { provenance?: unknown }, id = `document-${++sequence}`,
    projectId: string | null = null, folderId: string | null = null) => {
    const bytes = "bytes" in file ? file.bytes : Buffer.alloc(file.sizeBytes);
    const version = { id: `version-${++sequence}`, version_number: 1, source: "upload",
      created_at: "2026-01-01T00:00:00.000Z", filename: file.filename,
      file_type: file.fileType, size_bytes: bytes.length, source_sha256: sha256(bytes),
      working_revision: 0, bytes, provenance: file.provenance };
    stored.set(id, { id, projectId, folderId, versions: [version] });
    return { id, filename: version.filename, file_type: version.file_type,
      current_version_id: version.id, active_version_number: 1,
      current_working_revision: 0, source_sha256: version.source_sha256,
      project_id: projectId, folder_id: folderId };
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
    metadata: vi.fn(async (_scope, id: string) => {
      const entry = stored.get(id), version = entry?.versions[0];
      return version ? { id, filename: version.filename, file_type: version.file_type,
        size_bytes: version.size_bytes, source_sha256: version.source_sha256,
        current_version_id: version.id, active_version_number: version.version_number,
        current_working_revision: version.working_revision,
        project_id: entry.projectId, folder_id: entry.folderId } : null;
    }),
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
        source_sha256: sha256(bytes), working_revision: 0,
        bytes, provenance: file.provenance };
      entry.versions.unshift(version);
      return { ...version, project_id: entry.projectId, folder_id: entry.folderId };
    }),
    deleteDocument: vi.fn(async (_scope, id: string, _owner = true,
      expected?: { versionId: string; workingRevision: number;
        projectId: string | null; folderId: string | null }) => {
      const entry = stored.get(id), current = entry?.versions[0];
      return !!entry && (!expected || current?.id === expected.versionId &&
        current.working_revision === expected.workingRevision &&
        entry.projectId === expected.projectId && entry.folderId === expected.folderId) &&
        stored.delete(id);
    }),
    deleteVersion: vi.fn(async (_scope, id: string, versionId: string,
      expected?: { versionId: string; workingRevision: number;
        projectId: string | null; folderId: string | null }) => {
      const entry = stored.get(id);
      if (!entry) return { status: "missing" };
      const current = entry.versions[0];
      if (expected && (current?.id !== expected.versionId ||
          current.working_revision !== expected.workingRevision ||
          entry.projectId !== expected.projectId || entry.folderId !== expected.folderId))
        return { status: "missing" };
      entry.versions = entry.versions.filter(({ id }) => id !== versionId);
      return { status: "deleted", currentVersionId: entry.versions[0]?.id ?? null };
    }),
  } as unknown as DocumentStore;
  const files = { create: vi.fn(async (_scope, _workflow, file, context) =>
    put(file, undefined, context?.projectId ?? null, "output-folder")) } as
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
    options.builder as never, options.realImporter ? undefined : importer, sources as never,
    options.reviewer),
    documents, files, workProducts, importer, put,
    sources, stored,
    product: () => product! };
}

function built(id: string, revision: number,
  roles: AuthoritiesOutputRole[] = ["table"],
  pdfFiling = false): AuthoritiesBuildResult {
  const builtAt = "2026-01-01T00:00:00.000Z";
  const artifacts = Object.fromEntries(roles.map((role) => {
    const pdf = role.startsWith("book") || role === "annotated-document" && pdfFiling;
    const bytes = Buffer.from(`${pdf ? "%PDF-" : "PK\x03\x04"}${role}`);
    const filename = role === "table" ? "Authorities.table-of-authorities.docx"
      : role.startsWith("book") ? `Authorities.${role}.pdf`
        : `Authorities.with-table-of-authorities.${pdf ? "pdf" : "docx"}`;
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
        settings: createAuthoritiesDraft({ kind: "manual" }).settings,
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
    language: "en",
    file: { filename: "Smith.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nSmith\n%%EOF") },
  });
}

const prepareSources = (runtime: ReturnType<typeof harness>, product: WorkProduct) =>
  runtime.application.prepareSources(scope, product.id, product.revision);

describe("Authorities workspace application", () => {
  it("keeps manual-PDF drafts book-only across profile and output changes", () => {
    const manual = createAuthoritiesDraft({ kind: "manual" });
    expect(applyAuthoritiesUserAction(manual,
      { type: "set-profile", profileId: "federal-court" }).outputMode).toBe("book");
    expect(() => applyAuthoritiesUserAction(manual,
      { type: "set-output-mode", outputMode: "table" })).toThrow(ApplicationError);
    expect(() => applyAuthoritiesUserAction(manual,
      { type: "set-profile", profileId: "ab-court-of-appeal" })).toThrow(ApplicationError);
  });

  it("marks a user-added authority so its identity remains editable in an imported draft", () => {
    const source = { kind: "document" as const, bindingRole: "source" as const,
      filename: "Factum.docx", fileType: "docx" as const, snapshot: null };
    const bindings = { source: { kind: "document" as const, documentId: "factum",
      version: "latest" as const } };
    const added = applyAuthoritiesUserAction(createAuthoritiesDraft(source, bindings),
      { type: "add-authority", kind: "case", citation: "2024 ABKB 12",
        name: "Smith v Jones" }, { key: () => "2024abkb12", occurrences: () => [] });
    expect(added.authorities["2024abkb12"].userAdded).toBe(true);

    expect(applyAuthoritiesUserAction(added, { type: "edit-authority",
      authorityId: "2024abkb12", kind: "case", citation: "2024 ABKB 13",
      name: "Jones v Smith" }).authorities["2024abkb12"]).toMatchObject({
        citation: "2024 ABKB 13", name: "Jones v Smith", userAdded: true,
      });
  });

  it("persists an ignored recomputed discrepancy without touching the source", async () => {
    const id = "d".repeat(64), finding: AuthoritiesDiscrepancy = {
      id, kind: "quote_mismatch", actions: ["ignore"], occurrenceId: "cite",
      authorityId: "case", footnoteId: 1, citation: "2020 SCC 1",
      proposition: "The court wrote a quotation.", authoredQuote: "a quotation",
      authoredPinpoint: { kind: "paragraph", text: "7" },
      cited: { locator: { kind: "paragraph", label: "7" }, text: "different" },
      found: null,
    };
    const runtime = harness({ reviewer: async () => [finding] });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    await expect(runtime.application.discrepancies(scope, product.id)).resolves.toEqual([finding]);
    await expect(runtime.application.resolveDiscrepancy(scope, product.id,
      { revision: product.revision, id: "f".repeat(64), action: "ignore" }))
      .rejects.toMatchObject({ status: 409 });
    product = await runtime.application.resolveDiscrepancy(scope, product.id,
      { revision: product.revision, id, action: "ignore" });
    expect((product.state as AuthoritiesDraft).discrepancyDecisions).toEqual({ [id]: "ignore" });
    await expect(runtime.application.discrepancies(scope, product.id)).resolves.toEqual([]);
    expect(runtime.documents.addVersion).not.toHaveBeenCalled();
  });

  it("versions one accepted footnote correction and refreshes the pinned draft atomically",
    async () => {
    const quote = "The deadline is seven business days.";
    const body = `The court wrote “${quote}”`, note = "2020 SCC 1 at para 19";
    const bytes = await Packer.toBuffer(new Document({
      footnotes: { 7: { children: [new Paragraph({ children: [new TextRun(note)] })] } },
      sections: [{ children: [new Paragraph({ children: [
        new TextRun(body), new FootnoteReferenceRun(7),
      ] })] }],
    }));
    const id = "e".repeat(64), pinpoint = note.indexOf("19");
    const finding: AuthoritiesDiscrepancy = { id, kind: "wrong_pinpoint",
      actions: ["ignore", "pinpoint"], occurrenceId: "cite", authorityId: "case",
      footnoteId: 1, citation: "2020 SCC 1", proposition: body, authoredQuote: quote,
      authoredPinpoint: { kind: "paragraph", text: "19" },
      cited: { locator: { kind: "paragraph", label: "19" }, text: "Different." },
      found: { locator: { kind: "paragraph", label: "20" }, text: quote } };
    const runtime = harness({ reviewer: async () => [finding] });
    const source = runtime.put({ filename: "Factum.docx", fileType: "docx", bytes }, "factum");
    const snapshot = { documentId: source.id, versionId: source.current_version_id,
      sha256: source.source_sha256 };
    let draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
      filename: source.filename, fileType: "docx", snapshot }, { source: {
        kind: "document", documentId: source.id, version: { versionId: snapshot.versionId,
          sha256: snapshot.sha256 },
      } });
    draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
      id: "case", key: "case", kind: "case", citation: "2020 SCC 1", name: "Example",
      displayName: null, excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" },
    } });
    const occurrence = { id: "cite", unitId: "footnote:7", start: 0, end: note.length,
      text: note, authoritySpan: { start: 0, end: 10, text: "2020 SCC 1" },
      coreSpan: { start: 0, end: 10, text: "2020 SCC 1" },
      pinpointSpan: { start: pinpoint, end: pinpoint + 2, text: "19" }, kind: "case" as const,
      citation: "2020 SCC 1", authorityId: "case", reference: null,
      pinpoints: [{ kind: "paragraph" as const, text: "19" }], evidenceIds: [],
      sourceTextSha256: sha256(note), localOrdinal: 0, reviewed: true };
    draft.units = [
      { id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [[1, body.length]], pageNumbers: [], text: body, occurrenceIds: [] },
      { id: "footnote:7", kind: "footnote", ordinal: 1, footnoteId: 1,
        footnoteRefs: [], pageNumbers: [], text: note, occurrenceIds: [occurrence.id] },
    ];
    draft.occurrences = { [occurrence.id]: occurrence };
    draft.stage = "sources";
    runtime.importer.draft.mockResolvedValueOnce(draft).mockImplementation(async (_scope, input) => {
      const next = structuredClone(draft), version = (input as { version: {
        versionId: string; sha256: string } }).version;
      next.import.snapshot = { documentId: source.id, ...version };
      next.bindings.source = { kind: "document", documentId: source.id, version };
      next.units[1].text = note.replace("19", "20");
      Object.assign(next.occurrences.cite, { text: next.units[1].text,
        pinpointSpan: { start: pinpoint, end: pinpoint + 2, text: "20" },
        pinpoints: [{ kind: "paragraph", text: "20" }],
        sourceTextSha256: sha256(next.units[1].text) });
      return next;
    });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    vi.mocked(runtime.workProducts.save).mockRejectedValueOnce(new Error("save failed"));
    await expect(runtime.application.resolveDiscrepancy(scope, product.id,
      { revision: product.revision, id, action: "pinpoint" })).rejects.toThrow("save failed");
    expect(runtime.stored.get(source.id)!.versions).toHaveLength(1);
    product = await runtime.application.resolveDiscrepancy(scope, product.id,
      { revision: product.revision, id, action: "pinpoint" });

    const versions = runtime.stored.get(source.id)!.versions;
    expect(versions).toHaveLength(2);
    const [current, original] = versions;
    expect(await (await JSZip.loadAsync(current.bytes)).file("word/footnotes.xml")!.async("string"))
      .toContain("at para 20");
    expect(await (await JSZip.loadAsync(original.bytes)).file("word/footnotes.xml")!.async("string"))
      .toContain("at para 19");
    expect(product.state).toMatchObject({ stage: "sources", import: { snapshot: { versionId: current.id,
      sha256: current.source_sha256 } }, discrepancyDecisions: { [id]: "pinpoint" } });
    await expect(runtime.application.discrepancies(scope, product.id)).resolves.toEqual([]);
  });

  it.each(["automatic", "manual-originals"] as const)(
    "promotes an A2AJ publisher's discovered original PDF in %s mode", async (sourceMode) => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "scan-key", key: "scan-key", kind: "case",
        citation: "2024 FCA 1", name: null, displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const pdf = Buffer.from("%PDF-1.7\nverified\n%%EOF");
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "FCA",
      citation: "Law v Canada, 2024 FCA 1", alternateCitation: null, name: "Law v Canada",
      date: "2024-01-02", url: "https://publisher.example/decision/1",
      verifiedPdf: null, language: "en", upstreamLicense: null, searchText: "text",
      native: {} as never, searchNative: {} as never }),
      download: async () => ({ bytes: pdf, sourceSha256: sha256(pdf),
        url: "https://publisher.example/decision/1.pdf" }) });

    const imported = await runtime.application.importDraft(scope, {
      source: { kind: "manual" }, projectId: "project-1", settings: { sourceMode },
    });
    expect(runtime.sources.resolve).not.toHaveBeenCalled();
    const product = await prepareSources(runtime, imported);
    expect((product.state as AuthoritiesDraft).authorities["scan-key"]).toMatchObject({
      citation: "Law v Canada, 2024 FCA 1", name: "Law v Canada",
      source: { kind: "attached", sources: [{ sourceSha256: sha256(pdf), origin: "original",
        sourceUrl: "https://publisher.example/decision/1.pdf", language: "en" }] },
      sourceIdentity: { provider: "a2aj", stableSourceId: expect.any(String),
        sourceSha256: "a".repeat(64) },
    });
    expect(runtime.files.create).toHaveBeenCalledWith(scope, "authorities",
      expect.objectContaining({ filename: "Law v Canada.pdf" }),
      { projectId: "project-1", pdfOcrProvider: null });
  });

  it("rebuilds every source from text without downloading an available original", async () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "case", key: "case", kind: "case",
        citation: "2024 FCA 1", name: null, displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "FCA",
      citation: "2024 FCA 1", alternateCitation: null, name: "Law v Canada",
      date: "2024-01-02", url: "https://publisher.example/decision/1",
      verifiedPdf: { url: "https://publisher.example/decision/1.pdf", pdfOnly: false },
      language: "en", upstreamLicense: null, searchText: "[1] Rebuilt reasons.",
      native: {} as never, searchNative: {} as never }),
      download: async () => { throw new Error("render mode must not download"); } });

    const imported = await runtime.application.importDraft(scope, {
      source: { kind: "manual" }, settings: { sourceMode: "render" },
    });
    const product = await prepareSources(runtime, imported);
    expect(runtime.sources.download).not.toHaveBeenCalled();
    const state = product.state as AuthoritiesDraft;
    expect(state.authorities.case.source).toMatchObject({
      kind: "attached", sources: [{ origin: "reconstructed",
        sourceUrl: "https://publisher.example/decision/1", language: "en" }],
    });
    const source = state.authorities.case.source;
    if (source.kind !== "attached") throw new Error("reconstructed source was not attached");
    const binding = state.bindings[source.sources[0].bindingRole];
    if (binding.kind !== "document") throw new Error("source binding is not a document");
    const file = await runtime.documents.read(scope, binding.documentId, null, false);
    expect((await PDFDocument.load(file!.bytes)).getTitle()).toBe("Law v Canada");
  });

  it("resolves table citations without preparing source PDFs", async () => {
    const sourceSha = "f".repeat(64);
    const draft = reduceAuthoritiesDraft(
      createAuthoritiesDraft({ kind: "document", bindingRole: "source",
        filename: "Factum.docx", fileType: "docx", snapshot: { documentId: "filing",
          versionId: "filing-v1", sha256: sourceSha } }, { source: { kind: "document",
          documentId: "filing", version: { versionId: "filing-v1", sha256: sourceSha } } },
      "table"),
      { type: "add-authority", authority: { id: "case", key: "case", kind: "case",
        citation: "2024 FCA 1", name: null, displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } } },
    );
    const sourceUrl = "https://publisher.example/decision/1";
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "FCA",
      citation: "Law v Canada, 2024 FCA 1", alternateCitation: null, name: "Law v Canada",
      date: "2024-01-02", url: sourceUrl,
      verifiedPdf: { url: `${sourceUrl}.pdf`, pdfOnly: false }, language: "en",
      upstreamLicense: null, searchText: "Reasons", native: {} as never,
      searchNative: {} as never }) });

    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const product = await prepareSources(runtime, imported);

    expect((product.state as AuthoritiesDraft).authorities.case).toMatchObject({
      citation: "Law v Canada, 2024 FCA 1", source: { kind: "resolved" },
      sourceIdentity: { provider: "a2aj", externalUrl: sourceUrl },
    });
    expect(runtime.sources.download).not.toHaveBeenCalled();
    expect(runtime.files.create).not.toHaveBeenCalled();
  });

  it("prepares an unlinked source PDF required by the selected filing profile", async () => {
    const filingSha = "f".repeat(64), pdf = Buffer.from("%PDF-1.7\nsource\n%%EOF");
    let draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
      filename: "Factum.pdf", fileType: "pdf", snapshot: { documentId: "filing",
        versionId: "filing-v1", sha256: filingSha } }, { source: { kind: "document",
        documentId: "filing", version: { versionId: "filing-v1", sha256: filingSha } } },
    "table");
    draft = reduceAuthoritiesDraft(draft,
      { type: "set-profile", profileId: "ab-court-of-appeal" });
    draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
      id: "case", key: "case", kind: "case", citation: "2024 ABCA 1", name: null,
      displayName: null, excluded: false, evidenceIds: [], locators: [],
      sourceIdentity: null, source: { kind: "unresolved" },
    } });
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases",
      dataset: "ABCA", citation: "2024 ABCA 1", alternateCitation: null,
      name: "Smith v Jones", date: "2024-01-01", url: null,
      verifiedPdf: { url: "https://publisher.example/decision.pdf", pdfOnly: true },
      language: "en", upstreamLicense: null, searchText: "Reasons",
      native: {} as never, searchNative: {} as never }), download: async () => ({
        bytes: pdf, sourceSha256: sha256(pdf),
        url: "https://publisher.example/decision.pdf",
      }) });

    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const product = await prepareSources(runtime, imported);

    expect((product.state as AuthoritiesDraft).authorities.case.source).toMatchObject({
      kind: "attached", sources: [{ origin: "original", sourceSha256: sha256(pdf),
        language: "en" }],
    });
    expect(runtime.sources.download).toHaveBeenCalledTimes(1);
    expect(runtime.files.create).toHaveBeenCalledTimes(1);
  });

  it("expands a parser-missed style of cause from the provider's observed name", async () => {
    const text = "See R. v. Que\u0301bec, 2024 SCC 1 at para 4.", name = "R v Qu\u00e9bec",
      styleStart = text.indexOf("R."), core = "2024 SCC 1", coreStart = text.indexOf(core),
      coreEnd = coreStart + core.length;
    const draft = createAuthoritiesDraft({ kind: "manual" });
    Object.assign(draft, {
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["cite"] }],
      occurrences: { cite: { id: "cite", unitId: "body:0", start: styleStart, end: coreEnd,
        text: text.slice(styleStart, coreEnd),
        authoritySpan: { start: coreStart, end: coreEnd, text: core },
        coreSpan: { start: coreStart, end: coreEnd, text: core }, pinpointSpan: null,
        kind: "case", citation: core, authorityId: "case", reference: null, pinpoints: [],
        evidenceIds: [], sourceTextSha256: "unit-hash", localOrdinal: 0, reviewed: false } },
      authorities: { case: { id: "case", key: "case", kind: "case", citation: core,
        name: null, displayName: null, excluded: false, evidenceIds: [],
        locators: [], sourceIdentity: null, source: { kind: "unresolved" } } },
      authorityOrder: ["case"],
    });
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "SCC",
      citation: core, alternateCitation: null, name, date: "2024-01-01",
      url: "https://publisher.example/decision/1", verifiedPdf: null, language: "en",
      upstreamLicense: null, searchText: "Reasons", native: {} as never,
      searchNative: {} as never }) });

    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const product = await prepareSources(runtime, imported);
    const occurrence = (product.state as AuthoritiesDraft).occurrences.cite;

    expect(occurrence.authoritySpan).toEqual({ start: styleStart, end: coreEnd,
      text: text.slice(styleStart, coreEnd) });
    expect(occurrence.coreSpan).toEqual({ start: coreStart, end: coreEnd, text: core });
    expect((product.state as AuthoritiesDraft).authorities.case.name).toBe(name);
  });

  it("prepares one PDF after parallel citations resolve to one grounded authority", async () => {
    const neutral = "2015 SCC 5", reporter = "[2015] 1 SCR 331";
    let draft = createAuthoritiesDraft({ kind: "manual" });
    draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
      id: "carter", key: "carter", kind: "case", citation: neutral,
      name: null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" },
    } });
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: `${neutral}; ${reporter}`,
      occurrenceIds: ["neutral", "reporter"] }];
    const occurrence = (id: string, citation: string, start: number) => ({ id,
      unitId: "body:0", start, end: start + citation.length, text: citation,
      authoritySpan: { start, end: start + citation.length, text: citation },
      coreSpan: { start, end: start + citation.length, text: citation }, pinpointSpan: null,
      kind: "case" as const, citation, authorityId: "carter", reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: start,
      reviewed: true });
    draft.occurrences = { neutral: occurrence("neutral", neutral, 0),
      reporter: occurrence("reporter", reporter, neutral.length + 2) };
    const pdf = Buffer.from("%PDF-1.7\nCarter\n%%EOF");
    const runtime = harness({ draft, resolve: async (citation) => citation === neutral ? null : ({ docType: "cases", dataset: "SCC",
      citation: "2015 SCC 5", alternateCitation: "[2015] 1 SCR 331",
      name: "Carter v Canada (Attorney General)", date: "2015-02-06",
      url: "https://publisher.example/carter", verifiedPdf: null, language: "en",
      upstreamLicense: null, searchText: "[1] Reasons for judgment.",
      native: {} as never, searchNative: {} as never }),
      download: async () => ({ bytes: pdf, sourceSha256: sha256(pdf) }) });

    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const product = await prepareSources(runtime, imported);
    const state = product.state as AuthoritiesDraft;

    expect(runtime.sources.resolve.mock.calls.map(([citation]) => citation))
      .toEqual([neutral, reporter]);
    expect(state.authorityOrder).toEqual(["carter"]);
    expect(state.authorities.carter).toMatchObject({ citation: "2015 SCC 5",
      source: { kind: "attached", sources: [{ origin: "original", language: "en" }] },
      sourceIdentity: { stableSourceId: "a2aj:en:scc:2015 scc 5" } });
    expect(runtime.sources.download).toHaveBeenCalledTimes(1);
    expect(runtime.files.create).toHaveBeenCalledTimes(1);
    expect(Object.keys(state.bindings)).toHaveLength(1);
  });

  it("removes a rejected scan source but retains a relinked manual authority", async () => {
    const text = "2024 ABKB 1", digest = "b".repeat(64);
    let draft = createAuthoritiesDraft({ kind: "manual" });
    for (const id of ["detected", "manual"]) draft = reduceAuthoritiesDraft(draft, {
      type: "add-authority", authority: { id, key: id, kind: "case", citation: text,
        name: null, displayName: null, excluded: false, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "unresolved" },
        ...(id === "detected" ? { scanOnly: true as const } : {}) },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "detected",
      citation: text, name: "Smith v Jones", source: { provider: "a2aj",
        stableSourceId: "2024-abkb-1", sourceSha256: digest, version: "2024",
        externalUrl: null } });
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: "detected",
      bindingRole: "authority:detected", binding: { kind: "local-file", handleId: "generated",
        lastSeen: { name: "Smith v Jones.pdf", size: 10, modified: 1, sha256: digest } },
      filename: "Smith v Jones.pdf", sourceSha256: digest, sourceUrl: null,
      origin: "original", language: "en" });
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["cite"] }];
    draft.occurrences.cite = { id: "cite", unitId: "body:0", start: 0, end: text.length,
      text, authoritySpan: { start: 0, end: text.length, text },
      coreSpan: { start: 0, end: text.length, text }, pinpointSpan: null, kind: "case",
      citation: text, authorityId: "detected", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "unit", localOrdinal: 0, reviewed: false };
    draft.units.push({ ...draft.units[0], id: "body:1", ordinal: 1,
      occurrenceIds: ["manual-cite"] });
    draft.occurrences["manual-cite"] = { ...draft.occurrences.cite,
      id: "manual-cite", unitId: "body:1", localOrdinal: 1 };
    draft = reduceAuthoritiesDraft(draft, { type: "relink-occurrence",
      occurrenceId: "manual-cite", authorityId: "manual" });
    const runtime = harness({ draft });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "remove-occurrence", occurrenceId: "cite" });
    const state = product.state as AuthoritiesDraft;
    expect(state.authorityOrder).toEqual(["manual"]);
    expect(state.authorities.detected).toBeUndefined();
    expect(state.bindings).not.toHaveProperty("authority:detected");
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "remove-occurrence", occurrenceId: "manual-cite" });
    expect((product.state as AuthoritiesDraft).authorities.manual).toBeDefined();
  });

  it("reconstructs a searchable local PDF without requesting CanLII and accepts a manual override",
    async () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "grant", key: "grant", kind: "case",
        citation: "2009 SCC 32", name: "R v Grant", displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const pageUrl = "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html";
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("CanLII requests are forbidden"));
    try {
      const runtime = harness({ draft, resolve: async () => ({ docType: "cases",
        dataset: "SCC", citation: "R v Grant, 2009 SCC 32", alternateCitation: null,
        name: "R v Grant", date: "2009-07-17", url: pageUrl,
        verifiedPdf: { url: pageUrl.replace(/\.html$/u, ".pdf"), pdfOnly: true },
        language: "en", upstreamLicense: null,
        searchText: "Reasons for judgment\n\n[1] A searchable source-text rendition.",
        native: {} as never, searchNative: {} as never }) });
      let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
      expect(runtime.sources.resolve).not.toHaveBeenCalled();
      product = await prepareSources(runtime, product);
      let source = (product.state as AuthoritiesDraft).authorities.grant.source;
      expect(source).toMatchObject({ kind: "attached", sources: [{ origin: "reconstructed",
        sourceUrl: pageUrl, language: "en" }] });
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      if (source.kind !== "attached") throw new Error("reconstructed source was not attached");
      const binding = (product.state as AuthoritiesDraft).bindings[source.sources[0].bindingRole];
      if (binding.kind !== "document") throw new Error("source binding is not a document");
      const file = await runtime.documents.read(scope, binding.documentId, null, false);
      const rendered = await PDFDocument.load(file!.bytes);
      expect(rendered.getTitle()).toBe("R v Grant");
      expect(rendered.getPageCount()).toBeGreaterThan(0);

      const manual = Buffer.from("%PDF-1.7\nmanual original\n%%EOF");
      product = await runtime.application.attachPdf(scope, product.id, {
        revision: product.revision, authorityId: "grant", language: "en",
        file: { filename: "Grant original.pdf", fileType: "pdf", bytes: manual },
      });
      source = (product.state as AuthoritiesDraft).authorities.grant.source;
      expect(source).toMatchObject({ kind: "attached", sources: [{ origin: "manual",
        filename: "Grant original.pdf", sourceSha256: sha256(manual), language: "en" }] });
    } finally { fetch.mockRestore(); }
  });

  it("prepares both official-language enactments for a Federal filing", async () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "act", key: "act", kind: "legislation",
        citation: "RSC 1985, c F-7", name: "Federal Courts Act", displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const runtime = harness({ draft, resolve: async (_citation, _kind, _signal, requested) => ({ docType: "laws",
      dataset: "STATUTES-CA", citation: "RSC 1985, c F-7", alternateCitation: null,
      name: requested === "fr" ? "Loi sur les Cours fédérales" : "Federal Courts Act",
      date: "2026-01-01", url: `https://laws-lois.justice.gc.ca/${requested === "fr"
        ? "fra" : "eng"}/acts/F-7/FullText.html`, verifiedPdf: null,
      language: requested === "fr" ? "fr" : "en", upstreamLicense: null,
      searchText: requested === "fr" ? "Loi sur les Cours fédérales" : "Federal Courts Act",
      native: {} as never,
      searchNative: {} as never }) });
    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" },
      settings: { profileId: "federal-court" } });
    const product = await prepareSources(runtime, imported);
    expect((product.state as AuthoritiesDraft).authorities.act.source).toMatchObject({
      kind: "attached", sources: [{ language: "en", origin: "reconstructed" },
        { language: "fr", origin: "reconstructed" }],
    });
    expect(runtime.files.create).toHaveBeenCalledTimes(2);
  });

  it("offers an exact CanLII handoff when A2AJ is unavailable", async () => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "grant", key: "grant", kind: "case",
        citation: "2009 SCC 32", name: "R v Grant", displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    try {
      const runtime = harness({ draft, resolve: async () => {
        throw new Error("A2AJ unavailable");
      } });
      const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
      const product = await prepareSources(runtime, imported);
      expect((product.state as AuthoritiesDraft).authorities.grant.source).toMatchObject({
        kind: "pending-canlii",
        pdfUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf",
      });
      expect(runtime.sources.resolve).toHaveBeenCalledOnce();
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("uses A2AJ's exact CanLII page for a reporter-only manual handoff", async () => {
    const reporter = "[1986] 1 SCR 103";
    const pageUrl = "https://www.canlii.org/en/ca/scc/doc/1986/1986canlii46/1986canlii46.html";
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "case", key: "case", kind: "case",
        citation: reporter, name: "R v Oakes", displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" } },
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("CanLII requests are forbidden"));
    try {
      const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "SCC",
        citation: reporter, alternateCitation: null, name: "R v Oakes", date: "1986-02-28",
        url: pageUrl, verifiedPdf: { url: pageUrl.replace(/\.html$/u, ".pdf"), pdfOnly: true },
        language: "en", upstreamLicense: null, searchText: "",
        native: {} as never, searchNative: {} as never }) });
      const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

      const product = await prepareSources(runtime, imported);

      expect((product.state as AuthoritiesDraft).authorities.case.source).toEqual({
        kind: "pending-canlii", authorityKey: "case", pageUrl,
        pdfUrl: pageUrl.replace(/\.html$/u, ".pdf"),
      });
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("reports A2AJ revision drift and accepts the existing manual-PDF recovery", async () => {
    const citation = "2009 SCC 32", savedRevision = "b".repeat(64),
      currentRevision = "a".repeat(64);
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "grant", key: "grant", kind: "case",
        citation, name: "R v Grant", displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" } },
    });
    draft = reduceAuthoritiesDraft(draft, { type: "resolve-authority", authorityId: "grant",
      citation, name: "R v Grant", source: { provider: "a2aj",
        stableSourceId: "a2aj:en:scc:2009 scc 32", sourceSha256: savedRevision,
        version: "2009-07-17", externalUrl: null } });
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "SCC",
      citation, alternateCitation: null, name: "R v Grant", date: "2009-07-17", url: null,
      verifiedPdf: null, language: "en", upstreamLicense: null, searchText: "Current reasons",
      native: {} as never, searchNative: {} as never }) });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

    await expect(prepareSources(runtime, product)).rejects.toMatchObject({ status: 409,
      details: { authority_id: "grant", source_issue: "changed", source_provider: "a2aj",
        saved_source_sha256: savedRevision, current_source_sha256: currentRevision } });
    expect(runtime.files.create).not.toHaveBeenCalled();
    expect(runtime.sources.resolve).toHaveBeenCalledTimes(1);

    product = await runtime.application.attachPdf(scope, product.id, {
      revision: product.revision, authorityId: "grant", language: "en",
      file: { filename: "Grant current.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\ncurrent\n%%EOF") },
    });
    await expect(prepareSources(runtime, product)).resolves.toBe(product);
    expect(runtime.sources.resolve).toHaveBeenCalledTimes(1);
  });

  it.each(["exception", "hash mismatch"] as const)(
    "offers CanLII in the same preparation call after an original-PDF %s", async (failure) => {
    const draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }), {
      type: "add-authority", authority: { id: "grant", key: "grant", kind: "case",
        citation: "2009 SCC 32", name: "R v Grant", displayName: null,
        excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
        source: { kind: "unresolved" } },
    });
    const corrupt = Buffer.from("not the claimed source");
    const runtime = harness({ draft, resolve: async () => ({ docType: "cases", dataset: "SCC",
      citation: "2009 SCC 32", alternateCitation: null, name: "R v Grant", date: "2009-07-17",
       url: "https://publisher.example/grant",
       verifiedPdf: { url: "https://publisher.example/grant.pdf", pdfOnly: false }, language: "en",
       upstreamLicense: null, searchText: "", native: {} as never, searchNative: {} as never }),
      download: async () => {
        if (failure === "exception") throw new Error("publisher unavailable");
        return { bytes: corrupt, sourceSha256: "a".repeat(64) };
      } });
    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });

    const product = await prepareSources(runtime, imported);
    expect((product.state as AuthoritiesDraft).authorities.grant.source).toMatchObject({
      kind: "pending-canlii",
      pdfUrl: "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf",
    });
    expect(runtime.sources.download).toHaveBeenCalledTimes(1);
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

      const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" },
        settings: { sourceMode: "manual-originals" } });
      const product = await prepareSources(runtime, imported);

      expect((product.state as AuthoritiesDraft).authorities.grant.source).toEqual({
        kind: "pending-canlii", authorityKey: "grant",
        pageUrl: pdfUrl.replace(/\.pdf$/u, ".html"), pdfUrl,
      });
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(runtime.files.create).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const changed = await runtime.application.act(scope, product.id, product.revision,
        { type: "set-settings", settings: { sourceMode: "automatic" } });
      const automatic = await prepareSources(runtime, changed);
      expect((automatic.state as AuthoritiesDraft).authorities.grant.source)
        .toMatchObject({ kind: "attached", sources: [{ origin: "reconstructed" }] });
      expect(runtime.sources.download).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([["book", false], ["Alberta appeal filing table", true]] as const)(
    "offers a grounded CanLII case for manual download in a %s", async (_label, filingTable) => {
      const pageUrl = "https://www.canlii.org/en/ca/scc/doc/2016/2016scc27/2016scc27.html";
      const identity = { provider: "tna", stableSourceId: "2016-scc-27",
        sourceSha256: "a".repeat(64), version: "2016-07-08", externalUrl: pageUrl };
      const digest = "f".repeat(64);
      let initial = filingTable ? createAuthoritiesDraft({ kind: "document",
        bindingRole: "source", filename: "Factum.pdf", fileType: "pdf",
        snapshot: { documentId: "filing", versionId: "v1", sha256: digest } },
      { source: { kind: "document", documentId: "filing",
        version: { versionId: "v1", sha256: digest } } }, "table")
        : createAuthoritiesDraft({ kind: "manual" });
      if (filingTable) initial = reduceAuthoritiesDraft(initial,
        { type: "set-profile", profileId: "ab-court-of-appeal" });
      const draft = reduceAuthoritiesDraft(initial, {
        type: "add-authority", authority: { id: "jordan", key: "jordan", kind: "case",
          citation: "2016 SCC 27", name: "R v Jordan", displayName: null, excluded: false,
          evidenceIds: [], locators: [], sourceIdentity: identity,
          source: { kind: "resolved" } },
      });
      const runtime = harness({ draft });

      const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
      const product = await prepareSources(runtime, imported);
      const authority = (product.state as AuthoritiesDraft).authorities.jordan;

      expect(authority.sourceIdentity).toEqual(identity);
      expect(authority.source).toEqual({ kind: "pending-canlii", authorityKey: "jordan",
        pageUrl, pdfUrl: pageUrl.replace(/\.html$/u, ".pdf") });
      expect(runtime.sources.resolve).not.toHaveBeenCalled();
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
    const imported = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const product = await prepareSources(runtime, imported);
    expect(maximum).toBe(2);
    expect((product.state as AuthoritiesDraft).authorityOrder).toEqual(["first", "second"]);
  });

  it("supports a manual draft, canonical add, CanLII handoff, and manual attachment", async () => {
    const runtime = harness();
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" },
      settings: { sourceMode: "manual-originals" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123", name: "Smith v Jones",
    });
    expect(runtime.sources.key).toHaveBeenCalledWith("2024 ABKB 123");
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source)
      .toEqual({ kind: "unresolved" });
    product = await prepareSources(runtime, product);
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source)
      .toMatchObject({ kind: "pending-canlii",
        pdfUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf" });
    product = await runtime.application.attachPdf(scope, product.id, {
      revision: product.revision, authorityId: "canonical-key", language: "en",
      file: { filename: "smith.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nmanual\n%%EOF") },
    });
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source.kind)
      .toBe("attached");
    await expect(runtime.application.attachPdf(scope, product.id, {
      revision: product.revision - 1, authorityId: "canonical-key", language: "en",
      file: { filename: "late.pdf", fileType: "pdf", bytes: Buffer.from("%PDF-") },
    })).rejects.toMatchObject({ status: 409 });
  });

  it("does not invent a CanLII action when no exact neutral-citation link is derivable",
    async () => {
    const runtime = harness({ key: () => "uncited" });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" },
      settings: { sourceMode: "manual-originals" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "case", citation: "Dominion example report",
    });
    expect((product.state as AuthoritiesDraft).authorities.uncited.source)
      .toEqual({ kind: "unresolved" });
    await expect(runtime.application.act(scope, product.id, product.revision, {
      type: "begin-canlii-handoff", authorityId: "uncited",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("uses an observed parallel neutral citation for the CanLII handoff", async () => {
    const reporter = "[2015] 1 SCR 331", neutral = "2015 SCC 5";
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "manual" }),
      { type: "add-authority", authority: { id: "carter", key: "carter", kind: "case",
        citation: reporter, name: "Carter v Canada", displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" } } });
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: neutral, occurrenceIds: ["neutral"] }];
    draft.occurrences.neutral = { id: "neutral", unitId: "body:0", start: 0,
      end: neutral.length, text: neutral,
      authoritySpan: { start: 0, end: neutral.length, text: neutral },
      coreSpan: { start: 0, end: neutral.length, text: neutral }, pinpointSpan: null,
      kind: "case", citation: neutral, authorityId: "carter", reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: 0,
      reviewed: true };
    const runtime = harness({ draft });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "begin-canlii-handoff", authorityId: "carter" });
    expect((product.state as AuthoritiesDraft).authorities.carter.source).toMatchObject({
      kind: "pending-canlii",
      pageUrl: "https://www.canlii.org/en/ca/scc/doc/2015/2015scc5/2015scc5.html",
    });
  });

  it("binds only the current Library PDF without copying it", async () => {
    const runtime = harness();
    let product = await runtime.application.importDraft(scope,
      { source: { kind: "manual" }, projectId: "project-1",
        settings: { sourceMode: "manual-originals" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "case", citation: "2024 ABKB 123",
    });
    const pdf = runtime.put({ filename: "Smith.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nLibrary\n%%EOF") });
    const attach = (documentId: string, versionId: string, revision = product.revision) =>
      runtime.application.attachLibraryPdf(scope, product.id, {
        revision, documentId, versionId,
        target: { kind: "authority", authorityId: "canonical-key", language: "en" },
      });
    await expect(attach(pdf.id, "unknown-version")).rejects.toMatchObject({ status: 409 });
    const current = (await runtime.documents.addVersion(scope, pdf.id, {
      filename: "Smith updated.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nUpdated\n%%EOF"),
    }))!;
    await expect(attach(pdf.id, pdf.current_version_id)).rejects.toMatchObject({ status: 409 });
    const word = runtime.put({ filename: "Smith.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04") });
    await expect(attach(word.id, word.current_version_id)).rejects.toMatchObject({ status: 409 });
    const revision = product.revision;
    product = await attach(pdf.id, current.id);

    const draft = product.state as AuthoritiesDraft;
    expect(draft.authorities["canonical-key"].source).toEqual({
      kind: "attached", sources: [{ bindingRole: expect.any(String),
        filename: "Smith updated.pdf", sourceSha256: current.source_sha256,
        sourceUrl: null, origin: "manual", language: "en" }],
    });
    const attached = draft.authorities["canonical-key"].source;
    if (attached.kind !== "attached") throw new Error("expected attached source");
    const role = attached.sources[0].bindingRole;
    expect(draft.bindings[role]).toEqual({ kind: "document", documentId: pdf.id,
      version: "latest" });
    expect(runtime.files.create).not.toHaveBeenCalled();
    await expect(attach(pdf.id, current.id, revision)).rejects.toMatchObject({ status: 409 });
  });

  it("binds current Library PDFs to generated and supplemental book slots without copying", async () => {
    const runtime = harness();
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const pdf = runtime.put({ filename: "Front matter.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nLibrary\n%%EOF") });
    const attach = (target: { kind: "book"; slot: "cover" | "supplemental" }) =>
      runtime.application.attachLibraryPdf(scope, product.id, { revision: product.revision,
        documentId: pdf.id, versionId: pdf.current_version_id, target });

    product = await attach({ kind: "book", slot: "cover" });
    product = await attach({ kind: "book", slot: "supplemental" });

    const state = product.state as AuthoritiesDraft;
    expect([state.bookParts.cover, state.bookParts.supplements[0]]).toEqual([
      expect.objectContaining({ filename: "Front matter.pdf", sourceSha256: pdf.source_sha256 }),
      expect.objectContaining({ filename: "Front matter.pdf", sourceSha256: pdf.source_sha256 }),
    ]);
    expect(Object.values(state.bindings)).toEqual([
      { kind: "document", documentId: pdf.id, version: "latest" },
      { kind: "document", documentId: pdf.id, version: "latest" },
    ]);
    expect(runtime.files.create).not.toHaveBeenCalled();
  });

  it("automatically rescans a changed latest Library source before preparing", async () => {
    const runtime = harness();
    const source = runtime.put({ filename: "Factum.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04first") });
    runtime.importer.draft.mockImplementation(async (_scope, input) => {
      if (input.kind !== "document") throw new Error("expected document source");
      const current = runtime.stored.get(input.documentId)!.versions[0];
      const draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
        filename: current.filename, fileType: "docx", snapshot: {
          documentId: input.documentId, versionId: current.id, sha256: current.source_sha256,
        } }, { source: input });
      draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [], text: `scan:${current.id}`, occurrenceIds: [] }];
      return draft;
    });
    let product = await runtime.application.importDraft(scope, { source: { kind: "document",
      documentId: source.id, version: "latest" } });
    const current = (await runtime.documents.addVersion(scope, source.id, {
      filename: "Factum revised.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04second"),
    }))!;

    product = await prepareSources(runtime, product);

    expect(product.state).toMatchObject({ import: { filename: "Factum revised.docx",
      snapshot: { documentId: source.id, versionId: current.id,
        sha256: current.source_sha256 } }, units: [{ text: `scan:${current.id}` }],
      bindings: { source: { kind: "document", documentId: source.id, version: "latest" } } });
    expect(runtime.importer.draft).toHaveBeenLastCalledWith(scope,
      { kind: "document", documentId: source.id, version: "latest" });
  });

  it("atomically follows latest Library authority and book PDFs and flags deletion", async () => {
    const builder = vi.fn(async ({ workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, ["book"]));
    const runtime = harness({ builder: builder as never });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "other", citation: "Filed decision",
    });
    const authority = runtime.put({ filename: "Decision.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nfirst decision\n%%EOF") });
    const cover = runtime.put({ filename: "Cover.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nfirst cover\n%%EOF") });
    product = await runtime.application.attachLibraryPdf(scope, product.id, {
      revision: product.revision, documentId: authority.id,
      versionId: authority.current_version_id, target: { kind: "authority",
        authorityId: "canonical-key", language: "en" },
    });
    product = await runtime.application.attachLibraryPdf(scope, product.id, {
      revision: product.revision, documentId: cover.id, versionId: cover.current_version_id,
      target: { kind: "book", slot: "cover" },
    });
    const pinnedBytes = Buffer.from("%PDF-1.7\npinned index\n%%EOF");
    product = await runtime.application.attachBookPdf(scope, product.id, {
      revision: product.revision, slot: "index",
      file: { filename: "Index.pdf", fileType: "pdf", bytes: pinnedBytes },
    });
    const pinned = (product.state as AuthoritiesDraft).bookParts.index!;
    const pinnedBinding = (product.state as AuthoritiesDraft).bindings[pinned.bindingRole];
    if (pinnedBinding.kind !== "document" || pinnedBinding.version === "latest") {
      throw new Error("expected pinned book source");
    }
    await runtime.documents.addVersion(scope, pinnedBinding.documentId, {
      filename: "Index revised.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nnew index\n%%EOF"),
    });
    const currentAuthority = (await runtime.documents.addVersion(scope, authority.id, {
      filename: "Decision revised.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\ncurrent decision\n%%EOF"),
    }))!;
    const currentCover = (await runtime.documents.addVersion(scope, cover.id, {
      filename: "Cover revised.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\ncurrent cover\n%%EOF"),
    }))!;

    const result = await runtime.application.build(scope, product.id, product.revision);
    const draft = result.product.state as AuthoritiesDraft;
    const attached = draft.authorities["canonical-key"].source;
    if (attached.kind !== "attached") throw new Error("expected attached source");
    const authorityRole = attached.sources[0].bindingRole;
    expect(attached.sources[0]).toMatchObject({ filename: "Decision revised.pdf",
      sourceSha256: currentAuthority.source_sha256 });
    expect(draft.bookParts.cover).toMatchObject({ filename: "Cover revised.pdf",
      sourceSha256: currentCover.source_sha256 });
    expect(builder.mock.calls[0]![0].sources).toMatchObject({
      [authorityRole]: { bytes: currentAuthority.bytes },
      [draft.bookParts.cover!.bindingRole]: { bytes: currentCover.bytes },
      [pinned.bindingRole]: { bytes: pinnedBytes },
    });
    expect(draft.bindings[pinned.bindingRole]).toEqual(pinnedBinding);
    expect(draft.bookParts.index).toEqual(pinned);
    expect(runtime.workProducts.save).toHaveBeenLastCalledWith(scope, product.id,
      expect.objectContaining({ revision: product.revision, state: draft,
        outputs: expect.any(Object) }));

    await runtime.documents.deleteDocument(scope, cover.id);
    await expect(runtime.application.build(scope, product.id, result.product.revision))
      .rejects.toMatchObject({ status: 409,
        message: "This Library file is no longer available. Add it again." });
  });

  it("accepts the current Library versions without losing imported review edits", async () => {
    const runtime = harness();
    const source = runtime.put({ filename: "factum.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04first") });
    const imported = (versionId: string, digest: string) => reduceAuthoritiesDraft(
      createAuthoritiesDraft({ kind: "document", bindingRole: "source",
        filename: "factum.docx", fileType: "docx",
        snapshot: { documentId: source.id, versionId, sha256: digest } }, {
        source: { kind: "document", documentId: source.id, version: "latest" },
      }), { type: "add-authority", authority: { id: "article", key: "article",
        kind: "commentary", citation: "Useful article", name: null, displayName: null,
        excluded: false, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "unresolved" } } });
    runtime.importer.draft.mockResolvedValueOnce(imported(
      source.current_version_id, source.source_sha256));
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "rename-authority", authorityId: "article", displayName: "My reviewed title",
    });
    const current = (await runtime.documents.addVersion(scope, source.id, {
      filename: "factum revised.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04second"),
    }))!;
    runtime.importer.draft.mockResolvedValueOnce(imported(current.id, current.source_sha256));

    product = await runtime.application.refreshInput(scope, product.id, {
      revision: product.revision, role: "source",
    });

    expect((product.state as AuthoritiesDraft).import).toMatchObject({
      filename: "factum.docx",
      snapshot: { documentId: source.id, versionId: current.id,
        sha256: current.source_sha256 },
    });
    expect((product.state as AuthoritiesDraft).authorities.article.displayName)
      .toBe("My reviewed title");
  });

  it("accepts replaced Library PDFs and reports a deleted Library file", async () => {
    const runtime = harness();
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision, {
      type: "add-authority", kind: "other", citation: "Filed decision",
    });
    product = await runtime.application.attachPdf(scope, product.id, {
      revision: product.revision, authorityId: "canonical-key", language: "en",
      file: { filename: "Decision.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nfirst\n%%EOF") },
    });
    const attached = (product.state as AuthoritiesDraft).authorities["canonical-key"].source;
    if (attached.kind !== "attached") throw new Error("expected attached source");
    const role = attached.sources[0].bindingRole;
    const original = (product.state as AuthoritiesDraft).bindings[role];
    if (original.kind !== "document" || original.version === "latest") {
      throw new Error("expected a pinned Library PDF");
    }
    const current = (await runtime.documents.addVersion(scope, original.documentId, {
      filename: "Decision revised.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nsecond\n%%EOF"),
    }))!;
    await runtime.documents.deleteVersion(scope, original.documentId, original.version.versionId);

    product = await runtime.application.refreshInput(scope, product.id, {
      revision: product.revision, role,
    });
    expect((product.state as AuthoritiesDraft).authorities["canonical-key"].source)
      .toMatchObject({ sources: [{ filename: "Decision revised.pdf",
        sourceSha256: current.source_sha256 }] });
    expect((product.state as AuthoritiesDraft).bindings[role]).toEqual({
      kind: "document", documentId: original.documentId, version: "latest",
    });

    product = await runtime.application.attachBookPdf(scope, product.id, {
      revision: product.revision, slot: "supplemental",
      file: { filename: "Order.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\norder\n%%EOF") },
    });
    const supplement = (product.state as AuthoritiesDraft).bookParts.supplements[0];
    const replacementFile = { filename: "Order replacement.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nreplacement\n%%EOF") };
    product = await runtime.application.attachBookPdf(scope, product.id, {
      revision: product.revision, slot: "supplemental", supplementId: supplement.id,
      file: replacementFile,
    });
    expect((product.state as AuthoritiesDraft).bookParts.supplements).toEqual([
      expect.objectContaining({ id: supplement.id, bindingRole: supplement.bindingRole,
        filename: replacementFile.filename, sourceSha256: sha256(replacementFile.bytes) }),
    ]);
    const supplementBinding = (product.state as AuthoritiesDraft).bindings[supplement.bindingRole];
    if (supplementBinding.kind !== "document") throw new Error("expected document binding");
    const revisedOrder = (await runtime.documents.addVersion(scope,
      supplementBinding.documentId, { filename: "Order revised.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nrevised order\n%%EOF") }))!;
    product = await runtime.application.refreshInput(scope, product.id, {
      revision: product.revision, role: supplement.bindingRole,
    });
    expect((product.state as AuthoritiesDraft).bookParts.supplements[0]).toMatchObject({
      id: supplement.id, filename: "Order revised.pdf",
      sourceSha256: revisedOrder.source_sha256,
    });

    await runtime.documents.deleteDocument(scope, original.documentId);
    await expect(runtime.application.refreshInput(scope, product.id, {
      revision: product.revision, role,
    })).rejects.toMatchObject({ status: 409,
      message: "This Library file is no longer available. Add it again." });
  });

  it("keeps arbitrary duplicate PDF labels as distinct manual authorities", async () => {
    const runtime = harness({ key: () => "" });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    for (let index = 0; index < 2; index += 1) product = await runtime.application.act(
      scope, product.id, product.revision,
      { type: "add-authority", kind: "other", citation: "Interview Notes" });
    const state = product.state as AuthoritiesDraft;
    expect(state.authorityOrder).toHaveLength(2);
    expect(new Set(state.authorityOrder).size).toBe(2);
    expect(state.authorityOrder.every(Boolean)).toBe(true);
    expect(state.authorityOrder.map((id) => state.authorities[id].citation))
      .toEqual(["Interview Notes", "Interview Notes"]);
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
      revision: product.revision, authorityId: "2016scc27", language: "en",
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
      source: { kind: "attached", sources: [{ filename: "Jordan.pdf", language: "en" }] },
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
      authoritySpan: { start: 0, end: text.length, text },
      coreSpan: { start: 0, end: text.length, text }, pinpointSpan: null,
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

  it("persists exact UTF-16 authority and pinpoint selections without losing provenance",
    async () => {
    const unitText = "\u{1f9ab} See Smith v Jones, 2024 ABKB 123 (Alta.) at paras 7-9.",
      authorityText = "Smith v Jones, 2024 ABKB 123 (Alta.)", core = "2024 ABKB 123",
      pinpoint = "paras 7-9", authorityStart = unitText.indexOf(authorityText),
      authorityEnd = authorityStart + authorityText.length,
      pinpointStart = unitText.indexOf(pinpoint), pinpointEnd = pinpointStart + pinpoint.length;
    const oldCoreStart = unitText.indexOf(core), oldCoreEnd = oldCoreStart + core.length;
    const draft = createAuthoritiesDraft({ kind: "manual" });
    Object.assign(draft, {
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [2], text: unitText, occurrenceIds: ["cite"] }],
      occurrences: { cite: { id: "cite", unitId: "body:0", start: oldCoreStart,
        end: pinpointEnd, text: unitText.slice(oldCoreStart, pinpointEnd),
        authoritySpan: { start: oldCoreStart, end: oldCoreEnd, text: core },
        coreSpan: { start: oldCoreStart, end: oldCoreEnd, text: core },
        pinpointSpan: { start: pinpointStart, end: pinpointEnd, text: pinpoint },
        kind: "case", citation: core, authorityId: "canonical", reference: null,
        pinpoints: [{ kind: "paragraph", text: "7-9" }], evidenceIds: ["evidence-1"], sourceTextSha256: "unit-hash",
        localOrdinal: 4, reviewed: false } },
      authorities: { canonical: { id: "canonical", key: "canonical", kind: "case", citation: core,
        name: null, displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" } } },
      authorityOrder: ["canonical"],
    });
    const matches = (value: string) => {
      const styledEnd = value.indexOf(core) + core.length;
      const at = value.indexOf(pinpoint);
      return [{ text: value, start: 0, end: value.length,
        styledCitation: { text: value.slice(0, styledEnd), start: 0, end: styledEnd },
        coreCitation: { text: core, start: value.indexOf(core), end: styledEnd },
        pinpoints: at < 0 ? [] : [{ text: "7-9", start: at, end: at + pinpoint.length,
          kind: "paragraph" as const }], kind: "case" as const,
        shortForm: "Smith v Jones", reasons: ["same_text_style"] }];
    };
    const runtime = harness({ draft, key: () => "canonical", occurrences: matches });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    await expect(runtime.application.act(scope, product.id, product.revision,
      { type: "set-authority-span", occurrenceId: "cite",
        start: authorityStart, end: pinpointEnd })).rejects.toMatchObject({ status: 400 });
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "set-authority-span", occurrenceId: "cite",
        start: authorityStart, end: authorityEnd });
    expect((product.state as AuthoritiesDraft).occurrences.cite).toMatchObject({
      pinpointSpan: { start: pinpointStart, end: pinpointEnd, text: pinpoint },
      pinpoints: [{ kind: "paragraph", text: "7-9" }],
    });
    await expect(runtime.application.act(scope, product.id, product.revision,
      { type: "set-pinpoint-span", occurrenceId: "cite",
        start: oldCoreStart, end: pinpointEnd })).rejects.toMatchObject({ status: 400 });
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "set-pinpoint-span", occurrenceId: "cite",
        start: pinpointStart, end: pinpointEnd });
    const occurrence = (product.state as AuthoritiesDraft).occurrences.cite;
    expect(unitText.slice(occurrence.authoritySpan.start, occurrence.authoritySpan.end))
      .toBe(authorityText);
    expect(unitText.slice(occurrence.coreSpan.start, occurrence.coreSpan.end)).toBe(core);
    expect(occurrence.pinpointSpan).toEqual({ start: pinpointStart, end: pinpointEnd,
      text: pinpoint });
    expect(occurrence).toMatchObject({ authorityId: "canonical", reviewed: true,
      evidenceIds: ["evidence-1"], sourceTextSha256: "unit-hash", localOrdinal: 4,
      pinpoints: [{ kind: "paragraph", text: "7-9" }] });
    expect((product.state as AuthoritiesDraft).authorities.canonical.displayName)
      .toBe("Smith v Jones");
    expect((product.state as AuthoritiesDraft).authorityOrder).toEqual(["canonical"]);
  });

  it("uses the exact lawyer-selected parallel citation and absorbs its detections", async () => {
    const text = "R v Oakes, [1986] 1 SCR 103, 1986 CanLII 46 (SCC)",
      reporter = "[1986] 1 SCR 103", neutral = "1986 CanLII 46",
      reporterStart = text.indexOf(reporter), neutralStart = text.indexOf(neutral);
    const item = (id: string, start: number, value: string, authorityId: string,
      evidenceId: string) => ({ id, unitId: "body:0", start, end: start + value.length,
      text: value, authoritySpan: { start, end: start + value.length, text: value },
      coreSpan: { start, end: start + value.length, text: value }, pinpointSpan: null,
      kind: "case" as const, citation: value, authorityId, reference: null, pinpoints: [],
      evidenceIds: [evidenceId], sourceTextSha256: "unit-hash", localOrdinal: start,
      reviewed: false });
    const identity = (id: string, citation: string) => ({ id, key: id, kind: "case" as const,
      citation, name: null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" as const }, scanOnly: true as const });
    const draft = createAuthoritiesDraft({ kind: "manual" });
    Object.assign(draft, {
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["reporter", "neutral"] }],
      occurrences: { reporter: item("reporter", reporterStart, reporter, "reporter-key", "e1"),
        neutral: item("neutral", neutralStart, neutral, "neutral-key", "e2") },
      authorities: { "reporter-key": identity("reporter-key", reporter),
        "neutral-key": identity("neutral-key", neutral) },
      authorityOrder: ["reporter-key", "neutral-key"],
    });
    const match = (value: string, start: number, kind: "case" | "other", reasons: string[]) =>
      ({ text: value, start, end: start + value.length,
        styledCitation: { text: value, start, end: start + value.length },
        coreCitation: { text: value, start, end: start + value.length },
        pinpoints: [], kind, shortForm: kind === "case" ? "R v Oakes" : null, reasons });
    const runtime = harness({ draft,
      key: (value) => value === neutral ? "neutral-key" : "reporter-key",
      occurrences: () => [
        match(reporter, reporterStart, "other", ["citation_grammar", "kind_unclassified"]),
        match(neutral, neutralStart, "case", ["provider_routing", "same_text_style"]),
      ] });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "set-authority-span", occurrenceId: "neutral", start: 0, end: text.length });
    const state = product.state as AuthoritiesDraft, corrected = state.occurrences.neutral;
    expect(state.units[0].occurrenceIds).toEqual(["neutral"]);
    expect(corrected.authoritySpan).toEqual({ start: 0, end: text.length, text });
    expect(corrected.coreSpan.text).toBe(neutral);
    expect(corrected.evidenceIds).toEqual(["e1", "e2"]);
    expect(state.authorities["reporter-key"]).toBeUndefined();
    expect(state.authorities["neutral-key"].displayName).toBe("R v Oakes");
  });

  it("absorbs a split pinpoint and permits an exact manual citation boundary", async () => {
    const text = "R v Grant, 2009 SCC 32 at para 29", authority = "R v Grant, 2009 SCC 32",
      core = "2009 SCC 32", pinpoint = "para 29", pinpointStart = text.indexOf(pinpoint);
    const draft = createAuthoritiesDraft({ kind: "manual" });
    Object.assign(draft, {
      units: [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
        footnoteRefs: [], pageNumbers: [], text, occurrenceIds: ["main", "split"] }],
      occurrences: {
        main: { id: "main", unitId: "body:0", start: 0, end: authority.length, text: authority,
          authoritySpan: { start: 0, end: authority.length, text: authority },
          coreSpan: { start: text.indexOf(core), end: text.indexOf(core) + core.length, text: core },
          pinpointSpan: null, kind: "case", citation: core, authorityId: "grant", reference: null,
          pinpoints: [], evidenceIds: ["e1"], sourceTextSha256: "hash", localOrdinal: 0,
          reviewed: false },
        split: { id: "split", unitId: "body:0", start: pinpointStart, end: text.length,
          text: pinpoint, authoritySpan: { start: pinpointStart, end: text.length, text: pinpoint },
          coreSpan: { start: pinpointStart, end: text.length, text: pinpoint },
          pinpointSpan: null, kind: "other", citation: pinpoint, authorityId: null,
          reference: null, pinpoints: [], evidenceIds: ["e2"], sourceTextSha256: "hash",
          localOrdinal: pinpointStart, reviewed: false },
      },
      authorities: { grant: { id: "grant", key: "grant", kind: "case", citation: core,
        name: "R v Grant", displayName: null, excluded: false,
        evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "unresolved" } } },
      authorityOrder: ["grant"],
    });
    const runtime = harness({ draft, key: () => "grant", occurrences: () => [{ text,
      start: 0, end: text.length, styledCitation: { text: authority, start: 0, end: authority.length },
      coreCitation: { text: core, start: text.indexOf(core), end: text.indexOf(core) + core.length },
      pinpoints: [{ text: "29", start: text.indexOf("29"), end: text.length,
        kind: "paragraph" }], kind: "case", shortForm: "R v Grant",
      reasons: ["provider_routing", "same_text_style", "pinpoint_grammar"] }] });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await runtime.application.act(scope, product.id, product.revision,
      { type: "set-pinpoint-span", occurrenceId: "main", start: pinpointStart, end: text.length });
    let state = product.state as AuthoritiesDraft;
    expect(state.units[0].occurrenceIds).toEqual(["main"]);
    expect(state.occurrences.main).toMatchObject({ evidenceIds: ["e1", "e2"],
      pinpointSpan: { start: pinpointStart, end: text.length, text: pinpoint },
      pinpoints: [{ kind: "paragraph", text: "29" }] });

    const manualText = "R v Oddity, unreported", manualStart = manualText.indexOf("unreported"),
      manual = createAuthoritiesDraft({ kind: "manual" });
    Object.assign(manual, { units: [{ id: "body:1", kind: "body", ordinal: 0,
      footnoteId: null, footnoteRefs: [], pageNumbers: [], text: manualText,
      occurrenceIds: ["odd"] }], occurrences: { odd: { id: "odd", unitId: "body:1",
      start: manualStart, end: manualText.length, text: "unreported",
      authoritySpan: { start: manualStart, end: manualText.length, text: "unreported" },
      coreSpan: { start: manualStart, end: manualText.length, text: "unreported" }, pinpointSpan: null,
      kind: "other", citation: "unreported", authorityId: null, reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "hash", localOrdinal: manualStart,
      reviewed: false } } });
    const manualRuntime = harness({ draft: manual, key: () => "", occurrences: () => [] });
    product = await manualRuntime.application.importDraft(scope, { source: { kind: "manual" } });
    product = await manualRuntime.application.act(scope, product.id, product.revision,
      { type: "set-authority-span", occurrenceId: "odd", start: 0, end: manualText.length });
    state = product.state as AuthoritiesDraft;
    expect(state.occurrences.odd).toMatchObject({ reviewed: true,
      authoritySpan: { start: 0, end: manualText.length, text: manualText } });
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
    let draft = reduceAuthoritiesDraft(createAuthoritiesDraft({ kind: "document",
      bindingRole: "source", filename: source.filename, fileType: "docx", snapshot }, {
      source: { kind: "document", documentId: source.id,
        version: { versionId: snapshot.versionId, sha256: snapshot.sha256 } },
    }), { type: "set-output-mode", outputMode: "both" });
    draft = reduceAuthoritiesDraft(draft, { type: "set-document-output", enabled: true });
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

  it("loads and stores an Alberta appeal filing and its unlinked authority as PDFs", async () => {
    const runtime = harness();
    const filing = runtime.put({ filename: "Factum.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\nfiling\n%%EOF") }, "factum");
    const authority = runtime.put({ filename: "Case.pdf", fileType: "pdf",
      bytes: Buffer.from("%PDF-1.7\ncase\n%%EOF") }, "case");
    const snapshot = { documentId: filing.id, versionId: filing.current_version_id,
      sha256: filing.source_sha256 };
    let draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
      filename: filing.filename, fileType: "pdf", snapshot }, { source: { kind: "document",
        documentId: filing.id, version: { versionId: snapshot.versionId,
          sha256: snapshot.sha256 } } });
    draft = reduceAuthoritiesDraft(draft, { type: "set-profile",
      profileId: "ab-court-of-appeal" });
    draft.authorities.case = { id: "case", key: "case", kind: "case", citation: "2024 ABCA 1",
      name: "Example v Example", displayName: null, evidenceIds: [], locators: [],
      sourceIdentity: null, excluded: false, source: { kind: "attached",
        sources: [{ bindingRole: "authority:case", filename: authority.filename,
          sourceSha256: authority.source_sha256, sourceUrl: null, origin: "manual",
          language: "en" }] } };
    draft.authorityOrder = ["case"];
    draft.bindings["authority:case"] = { kind: "document", documentId: authority.id,
      version: { versionId: authority.current_version_id, sha256: authority.source_sha256 } };
    runtime.importer.draft.mockResolvedValue(draft);
    const builder = vi.fn(async (input: AuthoritiesBuildInput) => {
      expect(Buffer.from(input.sources?.source?.bytes ?? []).toString()).toContain("filing");
      expect(Buffer.from(input.sources?.["authority:case"]?.bytes ?? []).toString())
        .toContain("case");
      return built(input.workProduct.id, input.workProduct.revision,
        ["table", "annotated-document"], true);
    });
    const application = createAuthoritiesWorkspaceApplication(runtime.documents,
      runtime.workProducts, runtime.files, builder as never, runtime.importer, runtime.sources as never);
    const product = await application.importDraft(scope, { source: { kind: "manual" } });

    const result = await application.build(scope, product.id, product.revision);

    expect(result.product.outputs["annotated-document"]).toMatchObject({
      filename: "Authorities.with-table-of-authorities.pdf", mimeType: "application/pdf",
    });
  });

  it("contains and resolves exact custom Book PDFs, rejecting changed files", async () => {
    const builder = vi.fn(async ({ draft, workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision,
        [draft.outputMode === "table" ? "table" : "book"]));
    const runtime = harness({ builder: builder as never });
    const filing = runtime.put({ filename: "Factum.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04factum") }, "book-factum");
    const filingSnapshot = { documentId: filing.id, versionId: filing.current_version_id,
      sha256: filing.source_sha256 };
    runtime.importer.draft.mockResolvedValue(createAuthoritiesDraft({ kind: "document",
      bindingRole: "source", filename: filing.filename, fileType: "docx",
      snapshot: filingSnapshot }, { source: { kind: "document", documentId: filing.id,
        version: { versionId: filingSnapshot.versionId, sha256: filingSnapshot.sha256 } } }));
    const uploads = [
      ["cover", { filename: "Cover.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\ncover\n%%EOF") }],
      ["index", { filename: "Index.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nindex\n%%EOF") }],
      ["supplemental", { filename: "Chart.pdf", fileType: "pdf",
        bytes: Buffer.from("%PDF-1.7\nchart\n%%EOF") }],
    ] as const;
    let product = await runtime.application.importDraft(scope,
      { source: { kind: "manual" }, projectId: "project-1" });
    for (const [slot, file] of uploads) {
      product = await runtime.application.attachBookPdf(scope, product.id,
        { revision: product.revision, slot, file });
      expect(runtime.files.create).toHaveBeenLastCalledWith(scope, "authorities", file,
        { projectId: "project-1", pdfOcrProvider: null });
    }

    const draft = product.state as AuthoritiesDraft;
    const parts = [draft.bookParts.cover!, draft.bookParts.index!,
      draft.bookParts.supplements[0]!];
    const result = await runtime.application.build(scope, product.id, product.revision);
    const sources = builder.mock.calls[0]![0].sources!;
    for (const [index, part] of parts.entries()) {
      const file = uploads[index]![1], binding = draft.bindings[part.bindingRole];
      if (binding?.kind !== "document" || binding.version === "latest") {
        throw new Error("Book PDF was not pinned to a contained document version");
      }
      expect(part).toMatchObject({ filename: file.filename, sourceSha256: sha256(file.bytes) });
      expect(binding.version.sha256).toBe(part.sourceSha256);
      expect(runtime.stored.get(binding.documentId)?.versions[0]?.bytes).toEqual(file.bytes);
      expect(sources[part.bindingRole]).toEqual({ bytes: file.bytes, resolved: {
        kind: "document", documentId: binding.documentId,
        versionId: binding.version.versionId, filename: file.filename,
        sha256: part.sourceSha256,
      } });
    }

    const coverBinding = draft.bindings[parts[0].bindingRole];
    const indexBinding = draft.bindings[parts[1].bindingRole];
    if (coverBinding.kind !== "document" || coverBinding.version === "latest" ||
        indexBinding.kind !== "document" || indexBinding.version === "latest") {
      throw new Error("Book PDF binding fixture is invalid");
    }
    const coverVersion = runtime.stored.get(coverBinding.documentId)!.versions[0];
    coverVersion.file_type = "docx";
    await expect(runtime.application.build(scope, product.id, result.product.revision))
      .rejects.toMatchObject({ status: 409, message: "Book PDF changed: Cover.pdf" });
    coverVersion.file_type = "pdf";
    runtime.stored.get(indexBinding.documentId)!.versions[0].bytes = Buffer.from("changed");
    await expect(runtime.application.build(scope, product.id, result.product.revision))
      .rejects.toMatchObject({ status: 409, message: "Book PDF changed: Index.pdf" });
    product = await runtime.application.act(scope, product.id, result.product.revision,
      { type: "set-output-mode", outputMode: "table" });
    await expect(runtime.application.build(scope, product.id, product.revision)).resolves.toBeTruthy();
    const tableSources = builder.mock.calls.at(-1)![0].sources!;
    expect(parts.some(({ bindingRole }) => bindingRole in tableSources)).toBe(false);
    expect(builder).toHaveBeenCalledTimes(2);
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
    pdfText.mockClear();
    const passageGeometry = { schemaVersion: "legalpdf.passage-geometry.v1",
      sourceSha256: "a".repeat(64), parserVersion: "test",
      coordinateSpace: "visible_crop_box", coordinateOrigin: "top_left",
      rotationApplied: true, targets: [] } as const;
    pdfText.mockResolvedValueOnce({ pageTextByPage: [""],
      ocrTextByPage: ["Recognized included source"], passageGeometry });
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
    const filing = runtime.put({ filename: "Factum.docx", fileType: "docx",
      bytes: Buffer.from("PK\x03\x04factum") }, "source-document");
    const filingSnapshot = { documentId: filing.id, versionId: filing.current_version_id,
      sha256: filing.source_sha256 };
    let draft = createAuthoritiesDraft({ kind: "document", bindingRole: "source",
      filename: filing.filename, fileType: "docx", snapshot: filingSnapshot }, { source: {
        kind: "document", documentId: filing.id,
        version: { versionId: filingSnapshot.versionId, sha256: filingSnapshot.sha256 },
      } }, "book");
    for (const [id, file, isExcluded] of [
      ["included", included, false], ["excluded", excluded, true],
    ] as const) {
      draft = reduceAuthoritiesDraft(draft, { type: "add-authority", authority: {
        id, key: id, kind: "case", citation: id, name: null, displayName: null,
        excluded: false, evidenceIds: [],
        locators: id === "included" ? [{ kind: "paragraph", label: "1" }] : [],
        sourceIdentity: null,
        source: { kind: "unresolved" },
      } });
      draft = reduceAuthoritiesDraft(draft, { type: "attach-source", authorityId: id,
        bindingRole: `authority:${id}`, binding: { kind: "document", documentId: file.id,
          version: { versionId: file.current_version_id, sha256: file.source_sha256 } },
        filename: file.filename, sourceSha256: file.source_sha256, sourceUrl: null,
        language: "en" });
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
    expect(bookSources["authority:included"]?.pageTextByPage)
      .toEqual([""]);
    expect(bookSources["authority:included"]?.ocrTextByPage)
      .toEqual(["Recognized included source"]);
    expect(bookSources["authority:included"]?.passageGeometry).toBe(passageGeometry);
    expect(pdfText).toHaveBeenCalledWith(expect.objectContaining({
      passageTargets: [{ id: "passage:1", locatorKind: "paragraph", locator: "1",
        exactQuotes: [] }],
    }));
    expect(pdfText).toHaveBeenCalledOnce();
    expect(bookSources["authority:excluded"]).toMatchObject({ resolved: {
      kind: "document", documentId: excluded.id, versionId: excluded.current_version_id,
    } });
    expect(bookSources["authority:excluded"]).not.toHaveProperty("bytes");

    product = await runtime.application.act(scope, product.id, book.product.revision, {
      type: "set-settings", settings: { passageMarking: "none",
        scannedPdfPolicy: "page-margin" },
    });
    vi.mocked(runtime.documents.parseStates).mockClear(); pdfText.mockClear();
    const unmarked = await runtime.application.build(scope, product.id, product.revision);
    expect(runtime.documents.parseStates).toHaveBeenCalledWith(scope, [included.id]);
    expect(pdfText).not.toHaveBeenCalled();
    expect(builder.mock.calls.at(-1)![0].sources!["authority:included"]?.bytes)
      .toEqual(includedBytes);

    product = await runtime.application.act(scope, product.id, unmarked.product.revision,
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
    const source = bindingRole.sources[0];

    const first = await runtime.application.build(scope, product.id, product.revision);
    const second = await runtime.application.build(scope, product.id, first.product.revision);

    expect(runtime.documents.parseStates).toHaveBeenCalled();
    expect(builder).toHaveBeenCalledWith(expect.objectContaining({ sources:
      expect.objectContaining({ [source.bindingRole]: expect.objectContaining({
        bytes: Buffer.from("%PDF-1.7\nSmith\n%%EOF"), resolved: expect.objectContaining({
          sha256: source.sourceSha256,
        }) }) }) }));
    expect(second.product.outputs.book.documentId).toBe(first.product.outputs.book.documentId);
    expect(second.product.outputs.book.versionId).not.toBe(first.product.outputs.book.versionId);
    expect(runtime.stored.get(first.product.outputs.book.documentId)?.versions).toHaveLength(2);
  });

  it("persists every filing volume under its stable output role", async () => {
    const builder = vi.fn(async ({ workProduct }: AuthoritiesBuildInput) =>
      built(workProduct.id, workProduct.revision, ["book", "book-2"]));
    const runtime = harness({ draft: createAuthoritiesDraft({ kind: "manual" }, {}, "book"),
      builder: builder as never });
    const product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const result = await runtime.application.build(scope, product.id, product.revision);

    expect(Object.keys(result.product.outputs).sort()).toEqual(["book", "book-2"]);
    expect(result.product.outputs.book.documentId)
      .not.toBe(result.product.outputs["book-2"].documentId);
    expect(runtime.files.create).toHaveBeenCalledTimes(2);
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

  it("preserves a rebuilt output changed before failed WorkProduct compensation", async () => {
    const runtime = harness({ builder: vi.fn(async ({ workProduct }) =>
      built(workProduct.id, workProduct.revision)) as never });
    let product = await runtime.application.importDraft(scope, { source: { kind: "manual" } });
    const first = await runtime.application.build(scope, product.id, product.revision);
    product = first.product;
    const output = product.outputs.table, stored = runtime.stored.get(output.documentId)!;
    vi.mocked(runtime.workProducts.save).mockImplementationOnce(async () => {
      stored.versions[0].filename = "User renamed.docx";
      stored.versions[0].working_revision++;
      throw new ApplicationError(409, "Draft changed");
    });

    await expect(runtime.application.build(scope, product.id, product.revision))
      .rejects.toBeInstanceOf(AggregateError);
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions[0]).toMatchObject({
      filename: "User renamed.docx", working_revision: 1,
    });
  });
});
