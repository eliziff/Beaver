import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Paragraph,
} from "docx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docxBytes } from "./support/docxFixtures";
import { resourceReference } from "mike/shared/runtime/resourceReferences.mjs";
import { availableDocumentsPrompt, globPattern } from "../chat/resourceTools";

vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

let temporaryDirectory: string | null = null;

beforeEach(() => { process.env.AUTH_MODE = "local"; });

async function seedResearch(
  store: typeof import("./support/localDocumentFixtures"),
  filename: string,
  actions: import("../researchFile").ResearchFileAction[],
) {
  const research = await import("../researchFile"), document = await store.createLocalDocument({
    userId: "local-user", kind: "file", filename,
    bytes: Buffer.from(research.researchFileMarkdown(filename.replace(/\.research\.md$/u, ""),
      research.createResearchFileState())),
  });
  let file = await research.readResearchFile(store.localDocuments,
    { userId: "local-user" }, document.id);
  for (const action of actions) file = await research.commitResearchFile(store.localDocuments,
    { userId: "local-user" }, file!, action);
  return { document, file: file!, resource: resourceReference.document(document.id, file!.versionId) };
}

afterEach(async () => {
  try {
    await (await import("../relationalDatabase")).closeRelationalDatabase();
  } catch {}
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.AUTH_MODE;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {

  it("reads saved evidence without fetching and pages historical search receipts", async () => {
    const { createTnaEvidence, createLegalEvidenceTurnState, registerPriorLegalEvidence,
      registerLegalResearchQueries, priorLegalEvidencePrompt } = await import("../chat/legalEvidence"),
      { runLocalAssistantTools } = await import("./support/localAssistantTools"),
      state = createLegalEvidenceTurnState(), receipt = createTnaEvidence({
        jurisdiction: "CA", sourceClass: "case", stableSourceId: "saved-case",
        sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.",
        citation: "2024 SCC 1", dataset: "SCC", locatorKind: "paragraph", locatorLabel: "12",
      });
    registerPriorLegalEvidence(state, [receipt, { ...receipt, evidence_id: "e_corrupted", span_text: "Altered" }]);
    registerLegalResearchQueries(state, Array.from({ length: 30 }, (_, index) => ({
      call_id: `search-${index}`, tool: "search_sources" as const, executed_at: "2026-09-04T00:00:00Z",
      executor_version: "legal-source-search-v1" as const, input: { query: `Search ${index}` },
      results: Array.from({ length: 3 }, (_, rank) => ({ rank, resource: `source-${index}-${rank}` })),
    })), "test");
    const queries = [...state.queries.values()];
    expect(priorLegalEvidencePrompt([receipt], queries)).not.toContain(queries[0].query_id);
    vi.stubGlobal("fetch", () => { throw new Error("Saved receipt must not fetch"); });
    const calls = [receipt.evidence_id, "e_corrupted", "e_missing", "queries", "queries", queries[0].query_id]
      .map((file_path, index) => ({ id: `read-${index}`, name: "Read", input: { file_path,
        ...(index >= 3 ? { offset: index === 4 ? 3 : 1, limit: 2 } : {}) } }));
    const [read, corrupted, missing, first, second, query] = await runLocalAssistantTools(
      "local-user", calls, { legalEvidence: state });
    expect(JSON.parse(read.content)).toMatchObject({ evidence_id: receipt.evidence_id,
      exact_passage: receipt.span_text });
    expect(JSON.parse(corrupted.content)).toMatchObject({ ok: false });
    expect(JSON.parse(missing.content)).toMatchObject({ ok: false });
    expect(JSON.parse(first.content)).toMatchObject({ total: 30, next_offset: 3,
      items: queries.slice(0, 2).map(({ query_id }) => ({ query_id })) });
    expect(JSON.parse(second.content)).toMatchObject({ next_offset: 5,
      items: queries.slice(2, 4).map(({ query_id }) => ({ query_id })) });
    expect(JSON.parse(query.content)).toMatchObject({ query_id: queries[0].query_id,
      executed_at: queries[0].executed_at, tool: queries[0].tool, input: queries[0].input,
      results: queries[0].results.slice(0, 2), total: 3, next_offset: 3 });
  });

  it.each([
    {
      mode: "manual" as const,
      status: "pending" as const,
      revisionCount: 2,
    },
    {
      mode: "auto" as const,
      status: "accepted" as const,
      revisionCount: 0,
    },
  ])("enforces $mode editing through the chat runner", async ({
    mode,
    status,
    revisionCount,
  }) => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-edit-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await docxBytes([new Paragraph("Original provision.")]);
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes,
    });
    const [
      { createChatToolRunner },
      { createLegalEvidenceTurnState },
      { createSourceWorkspaceApplication },
      { localDocuments, localLibraryStore, localProjects },
    ] =
      await Promise.all([
        import("../chat/chatToolRunner"),
        import("../chat/legalEvidence"),
        import("../sourceWorkspaceApplication"),
        import("./support/localDocumentFixtures"),
      ]);
    const committed = vi.fn();
    const chat = createChatToolRunner({
      userId: "local-user",
      documents: localDocuments,
      sources: createSourceWorkspaceApplication(localDocuments, { chats: {} as never, tables: {} as never,
        tabular: async () => { throw new Error("No table view in this fixture"); } }),
      library: localLibraryStore,
      projects: localProjects,
      matterId: null,
      allowedDocumentIds: new Set([document.id]),
      documentNames: new Map([[document.id, "draft.docx"]]),
      editMode: mode,
      onMutationCommitted: committed,
    });
    const evidence = createLegalEvidenceTurnState();
    const events: unknown[] = [];
    const entries = chat.createTools(
      evidence,
      "main",
      { evidence, operation: { executor: "assistant" }, emit: vi.fn(), addEvent: (event) => events.push(event) },
    );
    expect(entries.find(({ name }) => name === "Read")?.activity?.({
      file_path: `document://${document.id}/version/${document.current_version_id}`,
    })).toBe("Reading draft.docx");
    const edit = entries.find(({ name }) => name === "Edit")!;
    const call = {
      id: "coding-edit",
      name: "Edit",
      input: {
        file_path: `document://${document.id}/version/${document.current_version_id}`,
        old_string: "Original",
        new_string: "Revised",
      },
    };
    const edited = await edit.execute(
      call.input,
      { evidence, emit: vi.fn(), addEvent: (event) => events.push(event) },
      new AbortController().signal,
      call,
    );
    events.push(...(edited.events ?? []));
    expect(events).toMatchObject([{
      type: "document_artifact",
      action: "edited",
      document_id: document.id,
      edit_mode: mode,
      annotations: [{
        deleted_text: "Original",
        inserted_text: "Revised",
        diff: [
          { kind: "delete", text: "Original" },
          { kind: "insert", text: "Revised" },
        ],
        status,
      }],
    }]);
    expect(JSON.parse(edited.result.content[0].type === "text"
      ? edited.result.content[0].text
      : "{}")).toMatchObject({ artifact: "draft-1", resource: expect.stringContaining(`document://${document.id}/version/`) });
    const { TurnToolRegistry } = await import("../chat/toolRegistry");
    const registry = new TurnToolRegistry(entries);
    const run = async (name: string, input: Record<string, unknown>) => {
      const [result] = await registry.run([{ id: name, name, input }],
        { evidence, operation: { executor: "assistant" }, emit: vi.fn(), addEvent: vi.fn() });
      expect(result.status, result.content).toBe("ok");
      return result.content;
    };
    await run("load_tools", { names: ["document_operation", "lint_document", "compare_versions"] });
    await run("document_operation", { action: "metadata", kind: "file", document_id: "draft-1", notes: "Reviewed" });
    const followUp = {
      id: "artifact-edit",
      name: "Edit",
      input: {
        file_path: "draft-1",
        old_string: "provision",
        new_string: "clause",
      },
    };
    await edit.execute(
      followUp.input,
      { evidence, emit: vi.fn(), addEvent: (event) => events.push(event) },
      new AbortController().signal,
      followUp,
    );
    const saved = await store.localDocuments.read(
      { userId: "local-user" }, document.id, null, false);
    expect(saved).not.toBeNull();
    const { extractDocxBodyText, extractTrackedChangeIds } = await import(
      "../docxTrackedChanges"
    );
    const savedBytes = saved!.bytes;
    expect(await extractDocxBodyText(savedBytes)).toContain("Revised clause.");
    expect(await extractTrackedChangeIds(savedBytes)).toHaveLength(revisionCount * 2);
    expect(committed).toHaveBeenCalledOnce();
    expect(await run("Grep", { path: "draft-1", pattern: "Revised clause", output_mode: "content" })).toContain("Revised clause");
    expect(JSON.parse(await run("lint_document", { document_id: "draft-1" }))).toMatchObject({ ok: true });
    expect(JSON.parse(await run("compare_versions", { document_id: "draft-1",
      baseline: resourceReference.document(document.id, document.current_version_id) })).changes_total).toBeGreaterThan(0);
  }, 30_000);

  it("rejects unmarked evidence copying before Write persists a DOCX", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-grounded-write-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const {
      createTnaEvidence,
      createLegalEvidenceTurnState,
      registerLegalEvidence,
    } = await import("../chat/legalEvidence");
    const state = createLegalEvidenceTurnState();
    const passage =
      "Charter decisions should not and must not be made in a factual vacuum.";
    const evidence = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "standing-case",
      sourceText: passage,
      spanText: passage,
      citation: "Example v Canada, 2026 SCC 1",
      dataset: "fixture",
      locatorKind: "paragraph",
      locatorLabel: "par49",
    });
    registerLegalEvidence(state, evidence);
    const { runLocalAssistantTools } = await import("./support/localAssistantTools");
    const [rejected] = await runLocalAssistantTools("local-user", [{
      id: "grounded-copy",
      name: "Write",
      input: {
        filename: "Standing memo.docx",
        content: `# Standing\n\n${passage} [@standing]`,
        citations: { standing: [evidence.evidence_id] },
      },
    }], { legalEvidence: state });

    expect(JSON.parse(rejected.content)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Draft integrity check failed"),
    });
    expect(rejected.mutated).not.toBe(true);

    // The corrected retry of a rejected draft, same filename, same registry.
    const [corrected] = await runLocalAssistantTools("local-user", [{
      id: "grounded-retry",
      name: "Write",
      input: {
        filename: "Standing memo.docx",
        content: `# Standing\n\n"${passage}" [@standing]`,
        citations: { standing: [evidence.evidence_id] },
      },
    }], { legalEvidence: state });
    expect(JSON.parse(corrected.content), corrected.content).toMatchObject({ ok: true });
    expect(corrected.mutated).toBe(true);
  });

  it("source-qualifies multi-document coding reads by canonical resource", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-evidence-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const first = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "first.txt",
      bytes: Buffer.from("shared needle in first", "utf8"),
    });
    const second = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "second.txt",
      bytes: Buffer.from("shared needle in second", "utf8"),
    });
    const tools = await import("./support/localAssistantTools");
    const [grep, firstRead, secondRead] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "grep-both",
          name: "Grep",
          input: { pattern: "needle", output_mode: "content" },
        },
        {
          id: "read-first",
          name: "Read",
          input: {
            file_path: `document://${first.id}/version/${first.current_version_id}`,
          },
        },
        {
          id: "read-second",
          name: "Read",
          input: {
            file_path: `document://${second.id}/version/${second.current_version_id}`,
          },
        },
      ],
    );

    expect(grep.content).toContain(resourceReference.document(first.id, first.current_version_id));
    expect(grep.content).toContain(resourceReference.document(second.id, second.current_version_id));
    expect(firstRead.evidence?.[0]).toMatchObject({
      stable_source_id: first.id,
      version: first.current_version_id,
      span_text: "shared needle in first",
    });
    expect(secondRead.evidence?.[0]).toMatchObject({
      stable_source_id: second.id,
      version: second.current_version_id,
      span_text: "shared needle in second",
    });
    for (const read of [firstRead, secondRead]) {
      for (const receipt of read.evidence ?? []) {
        expect(read.content.split("\n").find((line) => line.includes(receipt.evidence_id)))
          .toContain(receipt.span_text);
      }
    }
  });

  it("returns broad Grep context as navigation without citation receipts", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-grep-focus-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const text = ["zero", "one", "two", "NEEDLE", "four", "five", "six"].join("\n");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "focus.txt",
      bytes: Buffer.from(text, "utf8"),
    });
    const tools = await import("./support/localAssistantTools");
    const [grep] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "grep-focus",
        name: "Grep",
        input: {
          pattern: "NEEDLE",
          path: `document://${document.id}/version/${document.current_version_id}`,
          output_mode: "content",
          "-C": 3,
        },
      },
    ]);
    const resource =
      `document://${document.id}/version/${document.current_version_id}`;
    expect(grep.content).toContain(`${resource}-1-zero`);
    expect(grep.content).toContain(`${resource}-7-six`);
    expect(grep.evidence).toBeUndefined();
  });

  it("lists duplicate filenames and resumes same-turn edits by canonical resource", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-turn-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const makeDoc = async (text: string) =>
      store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "shared.docx",
        bytes: await docxBytes([new Paragraph(text)]),
      });
    const intended = await makeDoc("Alpha Beta.");
    const other = await makeDoc("Other document.");
    const intendedResource =
      `document://${intended.id}/version/${intended.current_version_id}`;
    const tools = await import("./support/localAssistantTools");
    const [listed, recovered] = await tools.runLocalAssistantTools(
      "local-user",
      [
        { id: "glob-duplicates", name: "Glob", input: { pattern: "shared.docx" } },
        { id: "id-read", name: "Read", input: { file_path: intendedResource } },
      ],
    );
    expect(listed.content).toContain(
      `document://${intended.id}/version/${intended.current_version_id}\tfilename=shared.docx`,
    );
    expect(listed.content).toContain(
      `document://${other.id}/version/${other.current_version_id}\tfilename=shared.docx`,
    );
    expect(recovered.content).toContain("Alpha Beta.");

    const turnId = "same-turn";
    const [firstEdit] = await tools.runLocalAssistantTools(
        "local-user",
        [{
          id: "edit-alpha",
          name: "Edit",
          input: {
            file_path: intendedResource,
            old_string: "Alpha",
            new_string: "Gamma",
          },
        }],
        { edits: new Map(), turnId },
      );
    const [secondEdit] = await tools.runLocalAssistantTools(
        "local-user",
        [{
          id: "edit-beta",
          name: "Edit",
          input: {
            file_path: resourceReference.document(intended.id,
              firstEdit.events!.find((event) => event.type === "document_artifact")!.version_id),
            old_string: "Beta",
            new_string: "Delta",
          },
        }],
        { edits: new Map(), turnId },
      );
    const edits = [firstEdit, secondEdit];
    expect(edits.every((edit) =>
      edit.events?.some((event) => event.type === "document_artifact" && event.action === "edited"))).toBe(true);
    const history = await store.listLocalVersions("local-user", intended.id);
    expect(history?.versions).toHaveLength(2);
    expect((await store.listLocalVersions("local-user", other.id))?.versions)
      .toHaveLength(1);
    const revised = secondEdit.events!.find((event) => event.type === "document_artifact")!;
    const [read] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-edited-duplicate",
      name: "Read",
      input: { file_path: resourceReference.document(revised.document_id, revised.version_id) },
    }]);
    expect(read.content).toContain("Gamma Delta.");
  }, 45_000);

  it("resolves an indexed alias to its exact document version", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-indexed-read-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const original = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "factum.txt", bytes: Buffer.from("Original filing text.") });
    const other = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "other-authority.pdf", bytes: Buffer.from("%PDF-1.7") });
    await store.addLocalVersion({ userId: "local-user", documentId: original.id,
      filename: "factum.txt", bytes: Buffer.from("Later filing text.") });
    const resource = resourceReference.document(original.id, original.current_version_id);
    const tools = await import("./support/localAssistantTools");
    const [listed, read] = await tools.runLocalAssistantTools("local-user", [
      { id: "glob-index", name: "Glob", input: { pattern: "*" } },
      { id: "read-index", name: "Read", input: { file_path: resource } },
    ], { docIndex: { "doc-1": { document_id: original.id, filename: "factum.txt",
      version_id: original.current_version_id, version_number: 1 } } });

    expect(listed.content).toContain(`${resource}\talias=doc-1\tfilename=factum.txt`);
    expect(listed.content).toContain(`document://${other.id}/version/${other.current_version_id}` +
      "\tfilename=other-authority.pdf");
    expect(read.content).toContain("Original filing text.");
    expect(read.content).not.toContain("Later filing text.");
  });

  it("bounds large document inventories while retaining attachments, later pages, and project isolation", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-inventory-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures"),
      tools = await import("./support/localAssistantTools"), scope = { userId: "local-user" },
      project = await store.localProjects.create(scope, { name: "Matter", cmNumber: null,
        practice: null, sharedWith: [] }),
      source = await store.localDocuments.create(scope, { filename: "Selected.txt", fileType: "txt",
        bytes: Buffer.from("The selected document remains readable."), projectId: project.id, libraryKind: "file" }),
      foreign = await store.createLocalDocument({ userId: "local-user", kind: "file",
        filename: "Outside.txt", bytes: Buffer.from("Outside this project") }),
      docIndex = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`doc-${index}`, {
        document_id: index === 1_000 ? source.id : `document-${index}`,
        version_id: index === 1_000 ? source.current_version_id : "version-1",
        version_number: 1, filename: index === 1_000 ? "Selected.txt" : `File-${index}.txt`,
      }])), records = new Map(Object.values(docIndex).map((document) =>
        [document.document_id, { folder_path: "Nested folder / ".repeat(1_000) }])),
      inventory = availableDocumentsPrompt(docIndex, records, [source.id]);
    expect(inventory.length).toBeLessThanOrEqual(8_000);
    expect(inventory.indexOf("doc-1000:")).toBeLessThan(inventory.indexOf("doc-0:"));
    expect(inventory).toContain("Selected.txt");
    expect(inventory).not.toContain("File-999.txt");
    const selected = Object.values(docIndex).slice(-50).map(({ document_id }) => document_id),
      manyAttachments = availableDocumentsPrompt(docIndex, records, selected);
    expect(manyAttachments.length).toBeLessThanOrEqual(8_000);
    for (let index = 951; index <= 1_000; index++) expect(manyAttachments).toContain(`- doc-${index}:`);
    const [first, later, read, rejected] = await tools.runLocalAssistantTools("local-user", [
      { id: "first", name: "Glob", input: { pattern: "*", limit: 50 } },
      { id: "later", name: "Glob", input: { pattern: "*", offset: 1_001, limit: 50 } },
      { id: "read", name: "Read", input: { file_path: resourceReference.document(source.id, source.current_version_id) } },
      { id: "foreign", name: "Read", input: { file_path: resourceReference.document(foreign.id, foreign.current_version_id) } },
    ], { matterId: project.id, docIndex });
    expect(first.content.length).toBeLessThanOrEqual(12_100);
    expect(first.content).toContain("next_offset=51");
    expect(first.content).not.toContain("Selected.txt");
    expect(later.content).toContain(`${resourceReference.document(source.id, source.current_version_id)}\talias=doc-1000`);
    expect(later.content).not.toContain("next_offset=");
    expect(read.content).toContain("The selected document remains readable.");
    expect(rejected.status).toBe("error");
  });

  it("does not expose an unverified saved passage as citable evidence", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-read-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createA2AJPassageEvidence, createLegalEvidenceTurnState } =
      await import("../chat/legalEvidence");
    const { commitResearchFile, researchQueryReceipt } = await import("../researchFile");
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "Bounded holding.",
      spanText: "Bounded holding.", start: 0, end: 16, externalUrl: null,
      sourceClass: "case", sourceReference: { id: "2026 SCC 1" } });
    const seeded = await seedResearch(store, "holding.research.md",
      [{ type: "merge", evidence: [receipt], labels: { [receipt.evidence_id]: [] } }]), sourceId = Object.keys(seeded.file.state.sources)[0],
      removedLabelId = "11111111-1111-4111-8111-111111111111",
      query = researchQueryReceipt({
      query_id: "q_saved", call_id: "call-saved", tool: "Read",
      executed_at: "2026-09-01T00:00:00.000Z", model: "saved-model",
      executor_version: "legal-source-pattern-v1",
      input: { rules: [{ phrase: "Holding:", direction: "after", unit: "sentence",
        chars: 100, slot: removedLabelId }], source_ids: [sourceId],
        label_ids: [removedLabelId], unlabelled: true, limit: 25 },
      results: [{ rank: 1, evidence_id: receipt.evidence_id }],
    });
    query.sourceIds = [sourceId]; query.evidenceIds = [receipt.evidence_id];
    query.failures = [{ sourceId, code: "not_found" }]; query.slots = {
      [receipt.evidence_id]: [removedLabelId] };
    query.sourceFingerprints = { [sourceId]: ["a".repeat(64)] };
    query.sourceReferences = { [sourceId]: seeded.file.state.sources[sourceId].reference };
    query.labelPaths = { [removedLabelId]: "Issues / Holding" };
    const file = await commitResearchFile(store.localDocuments, { userId: "local-user" },
      seeded.file, { type: "merge", queries: [query] }), document = seeded.document;
    const tools = await import("./support/localAssistantTools"), evidence = createLegalEvidenceTurnState(),
      edits = new Map();
    const filePath = resourceReference.document(document.id, file!.versionId);
    const [source, search, response, queried] = await tools.runLocalAssistantTools("local-user", [{ id: "read-source",
      name: "Read", input: { file_path: filePath, offset: 2, limit: 1 } }, { id: "read-search",
      name: "Read", input: { file_path: filePath, offset: 3, limit: 1 } },
    { id: "read-research", name: "Read", input: { file_path: filePath, offset: 4, limit: 1 } },
    { id: "query-research", name: "document_operation", input: { action: "research",
      document_id: filePath, research_action: { type: "query", text: "Bounded",
        syntax: "literal", target: "passages" } } }], {
      documentNames: new Map([[document.id, document.filename]]), legalEvidence: evidence, edits });
    expect(JSON.parse(source.content)).toMatchObject({ items: [{ kind: "source",
      resource: resourceReference.source("a2aj",
        JSON.stringify(["2026 SCC 1", "cases", "scc", "en"])) }] });
    expect(JSON.parse(search.content)).toMatchObject({ total: 5, items: [{ kind: "search",
      query_id: "q_saved", executed_at: query.executed_at, input: query.input, results: query.results,
      attempted_source_ids: [sourceId], evidence_ids: [receipt.evidence_id],
      source_references: { [sourceId]: expect.objectContaining({ id: "2026 SCC 1" }) },
      label_paths: { [removedLabelId]: "Issues / Holding" },
      slots: { [receipt.evidence_id]: [removedLabelId] },
      failures: [{ sourceId, code: "not_found" }] }] });
    expect(evidence.queries.get("q_saved")).toMatchObject({ call_id: "call-saved",
      sourceFingerprints: query.sourceFingerprints });
    const payload = JSON.parse(response.content);
    expect(payload).toMatchObject({ total: 5, items: [{ kind: "unavailable_passage",
      evidence_id: receipt.evidence_id }] });
    expect(response.evidence).toBeUndefined();
    expect(JSON.parse(queried.content)).toMatchObject({ match_count: 0, matches: [] });
    expect(queried.evidence).toBeUndefined();
  });

  it("omits research operations where the chat does not support them", async () => {
    const tools = await import("./support/localAssistantTools"), operation =
      tools.localAssistantToolRegistry("local-user", { includeResearchTools: false }).all()
        .find(({ name }) => name === "document_operation");
    expect(operation).toMatchObject({ inputSchema: { properties: {
      action: { enum: ["metadata", "fix_supras"] } } } });
    expect(JSON.stringify(operation)).not.toContain("research_action");
  });

  it("rejects a first research write after a human autosave", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-race-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { commitResearchFile, createResearchFileState, readResearchFile,
      researchFileMarkdown } = await import("../researchFile");
    const document = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "Cases.research.md",
      bytes: Buffer.from(researchFileMarkdown("Cases", createResearchFileState())) });
    const resource = resourceReference.document(document.id, document.current_version_id),
      edits = new Map(), documentNames = new Map([[document.id, document.filename]]),
      tools = await import("./support/localAssistantTools");
    await tools.runLocalAssistantTools("local-user",
      [{ id: "read", name: "Read", input: { file_path: resource } }],
      { documentNames, edits });
    const read = await readResearchFile(store.localDocuments, { userId: "local-user" }, document.id);
    await commitResearchFile(store.localDocuments, { userId: "local-user" }, read!,
      { type: "note", markdown: "Human note" });
    const [attempt] = await tools.runLocalAssistantTools("local-user", [{ id: "assistant-write",
      name: "document_operation", input: { action: "research", document_id: resource,
        research_action: { type: "label", name: "Assistant label", scope: "source" } } }],
    { documentNames, edits });
    expect(JSON.parse(attempt.content)).toMatchObject({ ok: false, error: expect.stringMatching(/changed|conflict/iu) });
    const after = await readResearchFile(store.localDocuments, { userId: "local-user" }, document.id);
    expect(after?.state.note).toBe("Human note");
    expect(Object.keys(after?.state.labels ?? {})).toHaveLength(0);
  });

  it("bounds model passage queries to one verified result page", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-query-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createA2AJPassageEvidence, createLegalEvidenceTurnState } =
      await import("../chat/legalEvidence");
    const { a2ajLegalSourceProvider } = await import("../legalSources/a2aj"),
      { structureNative } = await import("../structureNative");
    const lines = Array.from({ length: 30 }, (_, index) => `Match passage ${index}.`),
      sourceText = lines.join("\n"), native = await structureNative().deriveDocumentStructure({
        kind: "provider_text", input: { provider: "a2aj", citation: "2026 SCC 1",
          source_kind: "cases", text: sourceText, dataset: "scc", require_report_start: true,
          url: null } }), sourceSha256 = structureNative().documentRevision(native);
    const receipts = lines.map((spanText) => { const start = sourceText.indexOf(spanText);
      return createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
        dataset: "scc", language: "en", sourceSha256, spanText, start,
        end: start + spanText.length, externalUrl: null, sourceClass: "case",
        sourceReference: { id: "2026 SCC 1" } }); });
    vi.spyOn(a2ajLegalSourceProvider, "document").mockResolvedValue({ docType: "cases",
      dataset: "scc", citation: "2026 SCC 1", alternateCitation: null, name: "Example",
      date: null, url: null, verifiedPdf: null, language: "en", upstreamLicense: null, native });
    const seeded = await seedResearch(store, "matches.research.md",
      [{ type: "merge", evidence: receipts, labels: Object.fromEntries(receipts.map((item) => [item.evidence_id, []])) }]), research = seeded.document;
    const tools = await import("./support/localAssistantTools"), edits = new Map(),
      legalEvidence = createLegalEvidenceTurnState(),
      documentNames = new Map([[research.id, research.filename]]);
    const resource = seeded.resource;
    const [, queried] = await tools.runLocalAssistantTools("local-user", [{ id: "read-research",
      name: "Read", input: { file_path: resource } }, { id: "query",
      name: "document_operation", input: { action: "research",
        document_id: resource,
        research_action: { type: "query", text: "match", syntax: "literal",
          target: "passages", limit: 100 } } }], {
      documentNames, edits, legalEvidence });
    const output = JSON.parse(queried.content);
    expect(output).toMatchObject({ ok: true, match_count: 25,
      counts: { searches: 1 } });
    expect(output.matches_truncated).toBeUndefined();
    expect(output.matches).toHaveLength(25);
    expect(queried.evidence).toHaveLength(25);
    expect(queried.queryReceipts).toEqual([expect.objectContaining({ call_id: "query",
      input: expect.objectContaining({ target: "passages" }) })]);
    expect(queried.mutated).toBe(true);
    const queryId = queried.queryReceipts![0].query_id;
    legalEvidence.queries.set(queryId, queried.queryReceipts![0]);
    const [saved] =
      await tools.runLocalAssistantTools("local-user", [{ id: "save-query",
        name: "document_operation", input: { action: "research", document_id: resource,
          query_ids: [queryId], research_action: { type: "save" } } }], {
        documentNames, edits, legalEvidence });
    expect(JSON.parse(saved.content)).toMatchObject({ ok: true, counts: {
      passages: 30, searches: 1 } });
    expect(saved.mutated).toBe(true);
  });

  it("bounds adversarial search patterns", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-search-bounds-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const tools = await import("./support/localAssistantTools");
    const results = await tools.runLocalAssistantTools("local-user",
      ["(a+)+$", "(a|aa)+$", "((a|aa)b)+$"].map((pattern, index) => ({
        id: `unsafe-grep-${index}`, name: "Grep", input: { pattern },
      })));
    results.forEach((grep) =>
      expect(grep.content).toContain("unsafe backtracking pattern"));
    expect(() => globPattern("{a,b}".repeat(20))).not.toThrow();
    expect(() => globPattern("x".repeat(257))).toThrow("256");
  });

  it("reports a missing PDF page before starting structural analysis", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-library-chat-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "test.pdf",
      bytes: await readFile(path.resolve(process.cwd(), "../e2e/fixtures/test.pdf")),
    });
    const tools = await import("./support/localAssistantTools");
    const resource = resourceReference.document(
      document.id,
      document.current_version_id,
    );
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-missing-page",
      name: "Read",
      input: { file_path: resource, locator_kind: "page", locator: "5" },
    }]);

    expect(JSON.parse(response.content)).toEqual({
      ok: false,
      error: "Page 5 does not exist in test.pdf; the PDF has 1 page.",
    });
  });

  it("shares exact PDF receipt identity across structural Read, highlights, and selected extraction", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-evidence-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const { PDFDocument, StandardFonts } = await import("pdf-lib"), pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica), firstPage = "The first page gives background context.",
      footnoteText = "Supporting authority appears in the original footnote.";
    for (const text of [firstPage, "The second page states the governing rule."])
      pdf.addPage([612, 792]).drawText(text, { x: 50, y: 650, size: 14, font });
    pdf.getPage(0).drawText("1", { x: 50 + font.widthOfTextAtSize(firstPage, 14), y: 654, size: 8, font });
    pdf.getPage(0).drawLine({ start: { x: 50, y: 120 }, end: { x: 210, y: 120 }, thickness: 0.5 });
    pdf.getPage(0).drawText(`1 ${footnoteText}`, { x: 50, y: 105, size: 9, font });
    const store = await import("./support/localDocumentFixtures"), scope = { userId: "local-user" },
      document = await store.createLocalDocument({ userId: scope.userId, kind: "file",
        filename: "Canonical.pdf", bytes: Buffer.from(await pdf.save()) }),
      resource = resourceReference.document(document.id, document.current_version_id),
      tools = await import("./support/localAssistantTools"),
      { documentProjectionService } = await import("../documentProjectionService"),
      source = (await store.localDocuments.projectionSource(scope, document.id, document.current_version_id))!;
    const partial = await documentProjectionService.lookupPdf(source.readBytes,
      { locatorKind: "paragraph", locator: "1" }, { ...source, pages: [2] });
    expect(partial.status).toBe("found");
    const [exact] = await tools.runLocalAssistantTools(scope.userId, [{ id: "page-2", name: "Read",
        input: { file_path: resource, locator_kind: "page", locator: "2" } }]),
      receipt = exact.evidence?.[0];
    expect(receipt, exact.content).toBeDefined();
    expect(receipt!.span!.start).toBeGreaterThan(0);
    expect(receipt!.span_text).toBe("The second page states the governing rule.");
    const [rehydrated, plain, paragraph, footnote, preparedHandle] = await tools.runLocalAssistantTools(scope.userId, [
      { id: "handle", name: "Read", input: { file_path: resource, handle: JSON.parse(exact.content).handle } },
      { id: "plain", name: "Read", input: { file_path: resource } },
      { id: "paragraph", name: "Read", input: { file_path: resource, locator_kind: "paragraph", locator: "2" } },
      { id: "footnote", name: "Read", input: { file_path: resource, locator_kind: "footnote", locator: "1" } },
      { id: "partial-handle", name: "Read", input: { file_path: resource,
        handle: partial.status === "found" ? partial.evidence.handle : "" } },
    ]);
    expect(rehydrated.evidence).toEqual(exact.evidence);
    expect(plain.evidence!.map(({ evidence_id }) => evidence_id)).toContain(receipt!.evidence_id);
    expect(paragraph.evidence![0].evidence_id).toBe(receipt!.evidence_id);
    expect(footnote.evidence![0].span_text).toBe(`1 ${footnoteText}`);
    expect(plain.evidence!.map(({ evidence_id }) => evidence_id)).toContain(footnote.evidence![0].evidence_id);
    expect(JSON.parse(footnote.content).passages[0]).toMatchObject({ note: { label: "1" },
      proposition: { sentence: firstPage } });
    expect(preparedHandle.evidence![0].source_sha256).toBe(receipt!.source_sha256);
    expect(plain.evidence!.map(({ evidence_id }) => evidence_id)).toContain(preparedHandle.evidence![0].evidence_id);
    const { readResearchResource, restoreResearchEvidence } = await import("../researchReader"),
      selected = await readResearchResource(store.localDocuments, scope, { resource, evidence: [receipt!] });
    expect(selected.evidence).toEqual([receipt]);
    expect(JSON.stringify(selected.result)).not.toContain("background context");
    expect((await restoreResearchEvidence(store.localDocuments, scope, [receipt!, ...footnote.evidence!]))
      .map(({ receipt }) => receipt)).toEqual([receipt, ...footnote.evidence!]);
    const { file } = await seedResearch(store, "PDF workspace.research.md", [{ type: "source", reference: {
      provider: "library", kind: "document", id: document.id,
      versionId: document.current_version_id!, title: document.filename } }]),
      { verifyResearchPassage } = await import("../researchFileQuery"),
      highlight = await verifyResearchPassage(file, { type: "passage", sourceId: Object.keys(file.state.sources)[0],
        revision: receipt!.source_sha256!, start: receipt!.span!.start, end: receipt!.span!.end }, undefined,
      { documents: store.localDocuments, scope });
    expect(highlight.type === "merge" && highlight.evidence?.[0].evidence_id).toBe(receipt!.evidence_id);
  });

  it("does not expose local paths for a missing PDF resource", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-evidence",
        name: "Read",
        input: {
          file_path: "document://missing/version/missing",
          handle: `mike-evidence:v1:${"a".repeat(64)}`,
        },
      },
    ]);

    expect(JSON.parse(response.content)).toEqual({
      ok: false,
      error: "Document resource does not exist: document://missing/version/missing",
    });
    expect(response.content).not.toContain(temporaryDirectory);
    expect(response.content).not.toContain("ENOENT");
  });

  it("uses the bound Authorities focus without loading or repeating citation coordinates", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const draft = createAuthoritiesDraft({ kind: "manual" });
    const text = "😀 R v Example, 2024 ABKB 1", occurrenceId = "occurrence-1";
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: [occurrenceId] }];
    draft.occurrences[occurrenceId] = { id: occurrenceId, unitId: "body:0",
      start: 3, end: text.length, text: text.slice(3), kind: "case", citation: "2024 ABKB 1",
      authoritySpan: { start: 3, end: text.length, text: text.slice(3) },
      coreSpan: { start: 16, end: text.length, text: "2024 ABKB 1" }, pinpointSpan: null,
      authorityId: "example", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };
    draft.authorities.example = { id: "example", key: "example", kind: "case",
      citation: "2024 ABKB 1", name: "R v Example", displayName: null, evidenceIds: [],
      locators: [], sourceIdentity: null, excluded: false, source: { kind: "unresolved" } };
    draft.authorityOrder = ["example"];
    const current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 5, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = vi.fn(async (_scope, _id, revision) => ({ ...current, revision: revision + 1 }));
    const options = { authoritiesId: current.id, authoritiesRevision: current.revision,
      workProductFocus: { itemId: occurrenceId, selection: { start: 3, end: 16 } },
      authorities: { act } as never,
      workProducts: { get: vi.fn(async () => current), resolve: vi.fn(async () => ({
        product: current, freshness: "unbuilt", inputs: {}, dependencies: [],
      })) } as never };
    const tools = await import("./support/localAssistantTools");
    const registry = tools.localAssistantToolRegistry("local-user", options);
    expect(registry.visible().map(({ name }) => name)).toContain("update_work_product");
    expect(registry.specialists()).not.toContain("update_work_product");
    expect(registry.specialists()).toContain("manage_work_products");

    const responses = await tools.runLocalAssistantTools("local-user", [
      { id: "read-focus", name: "update_work_product",
        input: { action: "read" } },
      { id: "span-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "set-authority-span" } } },
      { id: "split-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "split-occurrence" } } },
      { id: "merge-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "merge-occurrence" } } },
      { id: "remove-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "remove-occurrence" } } },
      { id: "relink-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "relink-occurrence",
          authorityId: "example" } } },
      { id: "reference-focus", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "set-reference",
          reference: { kind: "ibid", targetAuthorityId: "example" } } } },
      { id: "clear-reference", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "set-reference", reference: null } } },
      { id: "clear-pinpoint", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "clear-pinpoint" } } },
      { id: "quoted-span", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "set-authority-span", span_text: "2024 ABKB 1" } } },
      { id: "add-missed", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "add-occurrence", unitId: "body:0",
          span_text: "R v Example, 2024 ABKB 1" } } },
      { id: "add-unquoted", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "add-occurrence", unitId: "body:0",
          span_text: "not in this unit" } } },
    ], options);

    expect(JSON.parse(responses[0].content)).toMatchObject({ draft: {
      occurrence: { id: occurrenceId, unit_id: "body:0" },
      focus: { occurrence_id: occurrenceId, selection: { start: 3, end: 16 } },
    } });
    expect(act.mock.calls.map((call) => call[3])).toEqual([
      { type: "set-authority-span", occurrenceId, start: 3, end: 16 },
      { type: "split-occurrence", occurrenceId, cursor: 3 },
      { type: "merge-occurrence", occurrenceId },
      { type: "remove-occurrence", occurrenceId },
      { type: "relink-occurrence", occurrenceId, authorityId: "example" },
      { type: "set-reference", occurrenceId,
        reference: { kind: "ibid", targetAuthorityId: "example" } },
      { type: "set-reference", occurrenceId, reference: null },
      { type: "clear-pinpoint", occurrenceId },
      { type: "set-authority-span", occurrenceId, start: 16, end: 27 },
      { type: "add-occurrence", unitId: "body:0", start: 3, end: 27 },
    ]);
    expect(JSON.parse(responses.at(-1)!.content)).toMatchObject({ ok: false,
      error: expect.stringContaining("not in unit body:0") });
  });

  it("reports compact discrepancies and stale inputs, then refreshes one role", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const draft = createAuthoritiesDraft({ kind: "manual" });
    const current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 3, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const changed = { kind: "document" as const, documentId: "document-1",
      versionId: "version-2", filename: "new.pdf", sha256: "b".repeat(64) };
    const resolve = vi.fn(async () => ({ product: current, freshness: "stale" as const,
      dependencies: [], inputs: { source: { status: "changed" as const,
        input: { kind: "document" as const, documentId: "document-1", version: "latest" as const },
        previous: { ...changed, versionId: "version-1" }, current: changed },
      missing: { status: "missing" as const,
        input: { kind: "document" as const, documentId: "gone", version: "latest" as const },
        reason: "deleted" as const, resource: "document" as const, id: "gone" } } }));
    const discrepancies = vi.fn(async () => [{ kind: "wrong_pinpoint" as const,
      occurrenceId: "occ-1", authorityId: "case-1", footnoteId: 2, citation: "2026 SCC 1",
      proposition: "p".repeat(20_000), authoredQuote: "The quoted words", authoredPinpoint: {
        kind: "paragraph" as const, text: "para 9" }, cited: { locator: {
          kind: "paragraph" as const, label: "para 9" }, text: "x".repeat(20_000) },
      found: { locator: { kind: "paragraph" as const, label: "para 10" }, text: "match" } }]);
    const refreshInput = vi.fn(async (_scope, _id, { revision }) =>
      ({ ...current, revision: revision + 1 }));
    const tools = await import("./support/localAssistantTools");
    const { createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const legalEvidence = createLegalEvidenceTurnState();
    const [review, refreshed] = await tools.runLocalAssistantTools("local-user", [
      { id: "review", name: "update_work_product", input: { action: "review",
        occurrence_limit: 100 } },
      { id: "refresh", name: "update_work_product", input: { action: "refresh",
        input_role: "source" } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision, legalEvidence,
      authorities: { discrepancies, refreshInput } as never,
      workProducts: { get: vi.fn(async () => current), resolve } as never });

    expect(JSON.parse(review.content)).toMatchObject({ output_freshness: "stale", input_issue_count: 2,
      input_issues: [{ role: "source", status: "changed", refreshable: true },
        { role: "missing", status: "missing", refreshable: false }],
      discrepancy_count: 1, discrepancies: [{ occurrence_id: "occ-1",
        cited_locator: { label: "para 9" }, suggested_locator: { label: "para 10" } }] });
    expect(review.content.length).toBeLessThan(64_000);
    expect(JSON.parse(review.content).discrepancies[0].proposition.length).toBeLessThanOrEqual(701);
    expect([...legalEvidence.reportedCitations ?? []]).toContain("2026 SCC 1");
    expect(refreshed.mutated).toBe(true);
  });

  it("lists scoped drafts and rejects general operations on the active draft tool", async () => {
    const choice = { id: "choice", kind: "authorities" as const, title: "Motion authorities",
      projectId: null, revision: 4, createdAt: "yesterday", updatedAt: "today" };
    const tools = await import("./support/localAssistantTools");
    const [listed] = await tools.runLocalAssistantTools("local-user", [{ id: "list",
      name: "update_work_product", input: { action: "read", kind: "authorities" } }], {
      workProducts: { list: vi.fn(async () => [choice]) } as never,
    });
    expect(JSON.parse(listed.content)).toEqual({ ok: true, drafts: [{ id: choice.id,
      title: choice.title, revision: 4, updated_at: "today" }], has_more: false,
      requested_action: "choose" });

    const [create, select] = await tools.runLocalAssistantTools("local-user", [
      { id: "create", name: "update_work_product", input: { action: "create",
        kind: "authorities" } },
      { id: "select", name: "update_work_product", input: { action: "select",
        kind: "authorities", draft_id: "other" } },
    ], { authoritiesId: "bound", authoritiesRevision: 1,
      workProducts: { get: vi.fn() } as never });
    expect(JSON.parse(create.content)).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(JSON.parse(select.content)).toMatchObject({ ok: false, error: "invalid_arguments" });
  });

  it("manages other workspaces without inheriting the active Authorities focus or crossing projects", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const { applyAuthoritiesUserAction } = await import("../authoritiesActions");
    let other = { id: "other", kind: "authorities" as const, title: "Other authorities",
      projectId: null, revision: 1, state: createAuthoritiesDraft({ kind: "manual" }),
      outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = vi.fn(async (_scope, _id, revision, action) => {
      other = { ...other, revision: revision + 1,
        state: applyAuthoritiesUserAction(other.state, action) };
      return other;
    });
    const tools = await import("./support/localAssistantTools");
    const responses = await tools.runLocalAssistantTools("local-user", [
      { id: "list", name: "manage_work_products", input: { action: "read", kind: "authorities" } },
      { id: "read-other", name: "manage_work_products", input: {
        action: "read", kind: "authorities", draft_id: other.id } },
      { id: "edit-other", name: "manage_work_products", input: {
        action: "update", kind: "authorities", draft_id: other.id,
        authorities_action: { type: "add-authority", kind: "case", citation: "2024 ABKB 1" } } },
      { id: "no-focus", name: "manage_work_products", input: {
        action: "update", kind: "authorities", draft_id: other.id,
        authorities_action: { type: "remove-occurrence" } } },
      { id: "select-other", name: "manage_work_products", input: {
        action: "select", kind: "authorities", draft_id: other.id } },
      { id: "out-of-scope", name: "manage_work_products", input: {
        action: "read", kind: "authorities", draft_id: "foreign" } },
    ], { authoritiesId: "active", authoritiesRevision: 7,
      workProductFocus: { itemId: "active-occurrence", selection: { start: 3, end: 16 } },
      authorities: { act } as never, workProducts: {
        get: async (_scope, id) => id === "foreign" ? { ...other, projectId: "another-project" } : other,
        list: async () => [other, { ...other, id: "foreign", projectId: "another-project" }],
        resolve: async () => ({ product: other, freshness: "unbuilt", inputs: {}, dependencies: [] }),
      } as never });
    expect(JSON.parse(responses[0].content).drafts).toEqual([
      expect.objectContaining({ id: other.id })]);
    expect(JSON.parse(responses[1].content)).toMatchObject({ ok: true,
      draft: { occurrence_index: [], counts: { authorities: 0 } } });
    expect(JSON.parse(responses[1].content).draft).not.toHaveProperty("focus");
    expect(Object.values(other.state.authorities)).toEqual([
      expect.objectContaining({ kind: "case", citation: "2024 ABKB 1" })]);
    expect(JSON.parse(responses[3].content).ok).toBe(false);
    expect(JSON.parse(responses[4].content)).toMatchObject({ ok: true,
      work_product: { id: other.id, revision: 2 }, requested_action: "open" });
    expect(JSON.parse(responses[5].content)).toMatchObject({ ok: false,
      error: "Draft is outside this chat's work-product scope" });
  });

  it("rejects empty and unknown grounded evidence IDs", async () => {
    const { createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const importDraft = vi.fn();
    const tools = await import("./support/localAssistantTools");
    const responses = await tools.runLocalAssistantTools("local-user", [{
      id: "empty-authorities",
      name: "update_work_product",
      input: { action: "create", kind: "authorities", evidence_ids: [" "] },
    }, {
      id: "unknown-authorities",
      name: "update_work_product",
      input: { action: "create", kind: "authorities", evidence_ids: ["e_missing"] },
    }], {
      legalEvidence: createLegalEvidenceTurnState(),
      authorities: { importDraft } as never,
      documents: {} as never,
    });

    expect(responses.map(({ content }) => JSON.parse(content).error)).toEqual([
      "At least one evidence ID is required",
      "Unknown evidence ID: e_missing",
    ]);
    expect(importDraft).not.toHaveBeenCalled();
  });

  it("keeps A2AJ link provenance private while returning evidence receipts", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence.`,
    ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 1",
              source_url_en: "https://example.test/case",
              unofficial_text_en: text,
            },
          ],
        }),
      }),
    );
    const tools = await import("./support/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: "Read",
          input: {
            file_path: `source://a2aj/${encodeURIComponent(JSON.stringify([
              "2099 SCC 1",
              "cases",
              "SCC",
            ]))}`,
            locator_kind: "paragraph",
            locator: "3",
            end_locator: "5",
          },
        },
      ],
    );
    const modelResult = JSON.parse(response.content);

    expect(modelResult.ok).toBe(true);
    expect(modelResult).not.toHaveProperty("url");
    expect(modelResult.passages).toMatchObject([
      { locator: "par3", evidence_id: expect.stringMatching(/^e_/u) },
      { locator: "par4", evidence_id: expect.stringMatching(/^e_/u) },
      { locator: "par5", evidence_id: expect.stringMatching(/^e_/u) },
    ]);
    expect(response.evidence).toHaveLength(3);
    expect(response.evidence?.every(
      ({ external_url }) => external_url === "https://example.test/case",
    ))
      .toBe(true);
  });

  it.each(["search", "direct"])("resolves %s source identity and keeps it stable without widening evidence", async (entry) => {
    const text = Array.from({ length: 6 }, (_, index) =>
      `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence.`
    ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            dataset: "SCC",
            citation_en: "2099 SCC 2",
            name_en: "Example v. Respondent",
            source_url_en: "https://example.test/case-2",
            unofficial_text_en: text,
          }],
        }),
      }),
    );
    const tools = await import("./support/localAssistantTools");
    const { legalSourceOperations } = await import("../legalSourceApplication");
    const { createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const state = createLegalEvidenceTurnState();
    const registry = tools.localAssistantToolRegistry("local-user", { legalEvidence: state });
    vi.spyOn(legalSourceOperations, "search").mockResolvedValue({ results: [{
      provider: "a2aj", id: "2099 SCC 2", kind: "case", collection: "SCC", language: "en",
      title: "Example v. Respondent", citation: "2099 SCC 2", url: "https://example.test/case-2",
    }], unavailable: [] });
    if (entry === "search") await registry.run([{ id: "search", name: "search_sources",
      input: { query: "Example v. Respondent", source_types: ["case"] } }], {});
    const call = {
      id: "call-document",
      name: "Read",
      input: {
        file_path: resourceReference.source(
          "a2aj",
          JSON.stringify(["2099 SCC 2", "cases", "SCC"]),
        ),
      },
    };
    const identity = [{ kind: "a2aj", ref: 1, name: "Example v. Respondent",
      citation: "2099 SCC 2", dataset: "SCC", source_class: "case", quotes: [],
      url: "https://example.test/case-2", external_url: "https://example.test/case-2" }];
    const onResult: NonNullable<Parameters<typeof registry.run>[3]> = (_call, outcome) => {
      expect(outcome.activityCitations).toEqual(identity);
    };
    expect(registry.activityCitations(call)).toEqual(entry === "search" ? identity : []);
    expect(fetch).not.toHaveBeenCalled();
    const [overview] = await registry.run([call], {}, undefined, onResult);
    expect(registry.activityCitations(call)).toEqual(identity);
    const payload = JSON.parse(overview.content);
    expect(payload.ok).toBe(true);
    expect(payload.passages).toHaveLength(6);
    expect(payload.passages.map(({ text }: { text: string }) => text)).toEqual(text.split("\n"));
    expect(state.evidence.size).toBe(6);
    await registry.run([{ ...call, id: "no-match",
      input: { ...call.input, pattern: "absent phrase" } }], {}, undefined, onResult);
    expect(state.evidence.size).toBe(6);
    const pinpoint = { ...call, id: "pinpoint", input: { ...call.input,
      locator_kind: "paragraph", locator: "2" } };
    expect(registry.activityCitations(pinpoint)).toEqual(identity);
    const [located] = await registry.run([pinpoint], {}, undefined, onResult);
    expect(located.status, located.content).not.toBe("error");
    expect(JSON.parse(located.content).passages[0].evidence_id).toBe(payload.passages[1].evidence_id);
    expect(state.evidence.size).toBe(6);
    expect(state.evidence.get(payload.passages[1].evidence_id)?.receipt).toMatchObject({
      locator: { kind: "paragraph", label: "par2" }, span_text: text.split("\n")[1],
    });
    expect(tools.localAssistantToolRegistry("local-user", { legalEvidence: state })
      .activityCitations(pinpoint)).toEqual(identity);
  });
});
