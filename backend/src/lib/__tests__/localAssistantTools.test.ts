import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resourceReference } from "../resourceReferences";
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
  vi.doUnmock("../convert");
  vi.doUnmock("../draftingStyleStore");
  vi.doUnmock("../chat/tools/sourceSearchTools");
  vi.doUnmock("node:fs/promises");
  vi.unstubAllGlobals();
  vi.resetModules();
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
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Original provision.")] }],
      }),
    );
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
      projectId: null,
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
      : "{}")).toMatchObject({ artifact: "draft-1" });
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
  }, 30_000);

  it("creates a DOCX directly even when other Library documents are unread", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-create-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "unrelated.docx",
      bytes: await Packer.toBuffer(new Document({
        sections: [{ children: [new Paragraph("Unrelated source.")] }],
      })),
    });
    const [
      { createChatToolRunner },
      { createLegalEvidenceTurnState },
      { localDocuments, localLibraryStore, localProjects },
    ] = await Promise.all([
      import("../chat/chatToolRunner"),
      import("../chat/legalEvidence"),
      import("./support/localDocumentFixtures"),
    ]);
    const { runLocalAssistantTools } = await import("./support/localAssistantTools");
    const [created, workbook, presentation] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "create-docx",
          name: "Write",
          input: {
            filename: "Requested memo.docx",
            document_type: "memo",
            content: "# Requested memo\n\nThe requested text.",
          },
        },
        {
          id: "create-xlsx",
          name: "Write",
          input: {
            filename: "Issues.xlsx",
            content: "## Open\n| Party | Status |\n| --- | --- |\n| Acme | Open |",
          },
        },
        {
          id: "create-pptx",
          name: "Write",
          input: {
            filename: "Briefing.pptx",
            content: "## Result\n- Motion granted",
          },
        },
      ],
    );

    expect(JSON.parse(created.content), created.content).toMatchObject({
      ok: true,
      artifact: "draft-1",
      filename: "Requested memo.docx",
    });
    expect(created).toMatchObject({
      mutated: true,
      events: [{ type: "document_artifact", action: "created", filename: "Requested memo.docx" }],
    });
    expect(created.terminal).toBeUndefined();
    const savedTypes = await Promise.all([workbook, presentation].map(async (output) => {
      const event = output.events!.find((event) => event.type === "document_artifact")!;
      return (await store.localDocuments.read({ userId: "local-user" },
        event.document_id, event.version_id, false))?.fileType;
    }));
    expect(savedTypes).toEqual(["xlsx", "pptx"]);
  }, 10_000);

  it("writes field and grouped citation maps into one durable DOCX", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-write-maps-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const { createTnaEvidence, createLegalEvidenceTurnState, registerLegalEvidence } =
      await import("../chat/legalEvidence");
    const state = createLegalEvidenceTurnState();
    const receipts = [5, 9].map((paragraph) => createTnaEvidence({
      jurisdiction: "CA", sourceClass: "case", stableSourceId: "example-case",
      sourceText: "The appeal is allowed. The order is varied.",
      spanText: paragraph === 5 ? "The appeal is allowed." : "The order is varied.",
      citation: "2026 SCC 1", name: "Example v State", dataset: "fixture",
      externalUrl: "https://example.test/case", locatorKind: "paragraph",
      locatorLabel: `par${paragraph}`,
    }));
    receipts.forEach((receipt) => registerLegalEvidence(state, receipt));
    const { runLocalAssistantTools } = await import("./support/localAssistantTools");
    const input = { filename: "Map memo.docx", citation_style: "footnotes",
      content: "# Positions\n\n{{party}} relies on the result.[@rule]\n\n{{party}} requests relief.[@rule]",
      fields: { party: "Acme" }, citations: { rule: receipts.map((receipt) => receipt.evidence_id) } };
    const results = await runLocalAssistantTools("local-user", [
      { id: "bad-fields", name: "Write", input: { ...input, fields: [{ id: "party", value: "Acme" }] } },
      { id: "bad-citations", name: "Write", input: { ...input, citations: [{ id: "rule", evidence_ids: input.citations.rule }] } },
      { id: "bad-field-value", name: "Write", input: { ...input, fields: { party: 7 } } },
      { id: "bad-citation-value", name: "Write", input: { ...input, citations: { rule: input.citations.rule[0] } } },
      { id: "maps", name: "Write", input },
    ], { legalEvidence: state });
    for (const invalid of results.slice(0, -1)) {
      expect(JSON.parse(invalid.content).error).toBe("invalid_arguments");
      expect(invalid.mutated).not.toBe(true);
    }
    const created = results.at(-1)!;
    expect(created.mutated, created.content).toBe(true);
    const event = created.events!.find((event) => event.type === "document_artifact")!;
    const { localDocuments } = await import("./support/localDocumentFixtures");
    const saved = await localDocuments.read({ userId: "local-user" }, event.document_id,
      event.version_id, false);
    const { default: JSZip } = await import("jszip"), zip = await JSZip.loadAsync(saved!.bytes);
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml.match(/<w:tag w:val="party"\/>/gu)).toHaveLength(2);
    expect(xml.match(/w:xpath="\/b:fields\/b:field\[@name=&apos;party&apos;\]"/gu)).toHaveLength(2);
    expect(await zip.file("customXml/item1.xml")!.async("text"))
      .toContain('<b:field name="party">Acme</b:field>');
    const footnotes = await zip.file("word/footnotes.xml")!.async("text");
    for (const text of ["Example v State", "2026 SCC 1", "para 5", "para 9", "Ibid"])
      expect(footnotes).toContain(text);
    expect(footnotes).not.toContain("[@rule]");
    expect([...state.documentEvidenceIds]).toEqual(input.citations.rule);
  });

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
  });

  it("applies deterministic DOCX operations through edit_docx_advanced", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-ref-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Original provision.")] }],
      }),
    );
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes,
    });
    const { runLocalAssistantTools } = await import(
      "./support/localAssistantTools"
    );

    const [response] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "deterministic-edit",
          name: "edit_docx_advanced",
          input: {
            file_path: `document://${document.id}/version/${document.current_version_id}`,
            ops: [
              {
                op: "replace_text",
                scope: { kind: "whole_document" },
                find: "Original",
                replace: "Revised",
              },
            ],
          },
        },
      ],
      { allowedDocumentIds: new Set([document.id]) },
    );

    expect(JSON.parse(response.content)).toEqual({ ok: true, artifact: "draft-1",
      filename: "draft.docx" });
    expect(response).toMatchObject({
      mutated: true,
      events: [{ type: "document_artifact", action: "edited", document_id: document.id,
        version_number: 2, annotations: [{ deleted_text: "Original", inserted_text: "Revised" }] }],
    });
    const event = response.events!.find((event) => event.type === "document_artifact")!;
    expect(event.annotations![0].reason).toBeUndefined();
    const { parsePublicAssistantEvent } = await import("../chat/assistantEvents");
    expect(parsePublicAssistantEvent(event)).toEqual(event);
    const saved = await store.localDocuments.read({ userId: "local-user" },
      document.id, event.version_id, false);
    const { extractDocxBodyText } = await import("../docxTrackedChanges");
    expect(await extractDocxBodyText(saved!.bytes)).toContain("Revised provision.");
    const resource = resourceReference.document(document.id, event.version_id);
    const [unchanged, lint] = await runLocalAssistantTools("local-user", [{
      id: "unchanged", name: "edit_docx_advanced", input: { file_path: resource,
        ops: [{ op: "replace_text", scope: { kind: "whole_document" },
          find: "Absent", replace: "Replacement" }] },
    }, { id: "lint", name: "lint_document", input: { document_id: resource } }]);
    expect(JSON.parse(unchanged.content)).toMatchObject({ ok: true, action: "no_changes",
      ops: [{ op: "replace_text", replacements: 0 }] });
    expect(JSON.parse(lint.content)).toMatchObject({ ok: true,
      version_id: event.version_id, findings: expect.any(Array) });
    expect((await store.listLocalVersions("local-user", document.id))?.versions).toHaveLength(2);
  });

  it("saves supra fields as ordinary assistant edits that can be rejected", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-supras-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const zip = new JSZip();
    const namespace = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    zip.file("word/document.xml", `<w:document ${namespace}><w:body><w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>`);
    zip.file("word/footnotes.xml", `<w:footnotes ${namespace}><w:footnote w:id="1"><w:p><w:r><w:t>Smith, supra note 1.</w:t></w:r></w:p></w:footnote></w:footnotes>`);
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "Brief.docx", bytes: await zip.generateAsync({ type: "nodebuffer" }) });
    const { runLocalAssistantTools } = await import("./support/localAssistantTools");
    const [response] = await runLocalAssistantTools("local-user", [{ id: "fix-supras",
      name: "document_operation", input: { action: "fix_supras",
        document_id: resourceReference.document(document.id, document.current_version_id) } }]);
    const artifact = response.events?.find((event) => event.type === "document_artifact");
    expect(artifact).toMatchObject({ action: "edited", edit_mode: "manual", filename: "Brief.docx",
      annotations: [{ status: "pending", del_w_id: expect.any(String), ins_w_id: expect.any(String) }] });
    expect(response.events).toHaveLength(1);
    const resolved = await store.localDocuments.resolveEdits({ userId: "local-user" }, document.id,
      artifact!.annotations!.map(({ edit_id }) => edit_id), "reject");
    expect(resolved.status).toBe("resolved");
    const saved = await store.localDocuments.read({ userId: "local-user" }, document.id, null, false);
    const notes = await (await JSZip.loadAsync(saved!.bytes)).file("word/footnotes.xml")!.async("string");
    expect(notes).not.toContain("NOTEREF");
    expect(notes).toContain("Smith, supra note 1.");
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

  it("addresses spreadsheet cells through the same bounded Read contract", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-xlsx-cells-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const sheet = XLSX.utils.aoa_to_sheet([
      ["Matter", "Status"],
      ["Smith", "Unique spreadsheet value"],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Ledger");
    const bytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "ledger.xlsx",
      bytes,
    });
    const tools = await import("./support/localAssistantTools");
    const [read] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "read-xlsx-cell",
        name: "Read",
        input: {
          file_path: `document://${document.id}/version/${document.current_version_id}`,
          section: "table:1/row:2/col:2",
        },
      },
    ]);
    expect(read.content).toContain("Unique spreadsheet value");
    expect(read.content).not.toContain("Matter");
    const [whole] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-xlsx", name: "Read", input: {
        file_path: resourceReference.document(document.id, document.current_version_id),
      },
    }]);
    expect(whole.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ span_text: "Smith",
        locator: expect.objectContaining({ sheet: "Ledger", cells: "A2" }) }),
      expect.objectContaining({ span_text: "Unique spreadsheet value",
        locator: expect.objectContaining({ sheet: "Ledger", cells: "B2" }) }),
    ]));
    for (const receipt of whole.evidence ?? []) {
      expect(whole.content.split("\n").find((line) => line.includes(receipt.evidence_id)))
        .toContain(receipt.span_text);
    }
  });

  it("keeps generic Grep output independent of ambiguous legal structure", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-code-duplicate-handle-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("1.01 First occurrence."),
              new Paragraph("ordinary text"),
              new Paragraph("1.01 Repeated occurrence."),
              new Paragraph("UNIQUE NEEDLE"),
            ],
          },
        ],
      }),
    );
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "duplicate.docx",
      bytes,
    });
    const tools = await import("./support/localAssistantTools");
    const [grep] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "grep-duplicate-handle",
        name: "Grep",
        input: {
          pattern: "UNIQUE NEEDLE",
          path: `document://${document.id}/version/${document.current_version_id}`,
          output_mode: "content",
        },
      },
    ]);

    expect(grep.content).toContain("UNIQUE NEEDLE");
    expect(grep.content).not.toMatch(/\[sec1\.01\]/u);
  });

  it("keeps coding replace_all exact-case and no-match versionless", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-all-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Term term TERM.")] }],
      }),
    );
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "case.docx",
      bytes,
    });
    const tools = await import("./support/localAssistantTools");
    const editAll = async (oldString: string, newString: string) =>
      (
        await tools.runLocalAssistantTools("local-user", [
          {
            id: `replace-${oldString}`,
            name: "Edit",
            input: {
              file_path: `document://${document.id}/version/${document.current_version_id}`,
              old_string: oldString,
              new_string: newString,
              replace_all: true,
            },
          },
        ])
      )[0];

    expect(JSON.parse((await editAll("Missing", "Found")).content)).toMatchObject({
      ok: true,
      action: "no_changes",
    });
    expect((await store.listLocalVersions("local-user", document.id))?.versions)
      .toHaveLength(1);
    const revised = await editAll("Term", "Clause");
    const event = revised.events!.find((event) => event.type === "document_artifact")!;
    expect(event.annotations).toHaveLength(1);
    const [read] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-revised",
      name: "Read",
      input: { file_path: resourceReference.document(event.document_id, event.version_id) },
    }]);
    expect(read.content).toContain("Clause term TERM.");
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
        bytes: await Packer.toBuffer(
          new Document({ sections: [{ children: [new Paragraph(text)] }] }),
        ),
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

  it("discovers root Library files when the chat has no focused documents", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-library-chat-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "library-opinion.txt",
      bytes: Buffer.from("Library evidence survives an empty chat focus."),
    });
    const tools = await import("./support/localAssistantTools");
    const resource = resourceReference.document(
      document.id,
      document.current_version_id,
    );
    const registry = tools.localAssistantToolRegistry("local-user", {
      allowedDocumentIds: new Set(),
    });
    const glob = { id: "glob-library", name: "Glob", input: { pattern: "*" } };
    const readCall = {
      id: "read-library", name: "Read", input: { file_path: resource },
    };
    const [listed] = await registry.run([glob], {});
    expect(registry.activity(readCall)).toBe("Reading library-opinion.txt");
    expect(registry.activityCitations(readCall)).toEqual([{
      kind: "document", ref: 1, document_id: document.id,
      version_id: document.current_version_id, filename: document.filename, quotes: [],
    }]);
    const [read] = await registry.run([readCall], {});

    expect(listed.content).toContain(`${resource}\tfilename=library-opinion.txt`);
    expect(read.content).toContain("Library evidence survives an empty chat focus.");
  });

  it("discovers Library files beyond the first page", async () => {
    const store = await import("./support/localDocumentFixtures");
    const document = { id: "later-document", filename: "later-opinion.pdf",
      current_version_id: "later-version", file_type: "pdf", project_id: null,
      library_kind: "file" };
    const page = vi.fn(async (_scope, options: { after: unknown }) => options.after
      ? { items: [{ kind: "document" as const, document }], nextAfter: null }
      : { items: [], nextAfter: [0, "cursor", "cursor"] as [number, string, string] });
    const tools = await import("./support/localAssistantTools");
    const [listed] = await tools.runLocalAssistantTools("local-user", [{
      id: "glob-later-library-page", name: "Glob", input: { pattern: "later-*" },
    }], { library: { ...store.localLibraryStore, page } });

    expect(page).toHaveBeenCalledTimes(2);
    expect(listed.content).toContain(
      "document://later-document/version/later-version\tfilename=later-opinion.pdf");
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

  it("creates saved research as an ordinary readable Library file", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-create-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const tools = await import("./support/localAssistantTools"), edits = new Map();
    const [created] = await tools.runLocalAssistantTools("local-user", [{ id: "create-research",
      name: "document_operation", input: { action: "research",
        research_action: { type: "create", title: "Notice cases" } } }], { edits });
    const output = created.events!.find((event) => event.type === "document_artifact")!;
    const resource = resourceReference.document(output.document_id, output.version_id);
    const [read] = await tools.runLocalAssistantTools("local-user", [{ id: "read-research",
      name: "Read", input: { file_path: resource } }], {
      documentNames: new Map([[output.document_id, output.filename]]) });
    expect(JSON.parse(read.content)).toMatchObject({ filename: "Notice cases.research.md",
      resource, total: 0, items: [] });
    const [root] = await tools.runLocalAssistantTools("local-user", [{ id: "root-label",
      name: "document_operation", input: { action: "research", document_id: resource,
        research_action: { type: "label", name: "Fairness", scope: "source" } } }], { edits });
    const rootOutput = JSON.parse(root.content);
    expect(rootOutput.label_id).toMatch(/^[0-9a-f-]{36}$/u);
    const [child] = await tools.runLocalAssistantTools("local-user", [{ id: "child-label",
      name: "document_operation", input: { action: "research", document_id: rootOutput.resource,
        research_action: { type: "label", name: "Hearing", scope: "source",
          parentId: rootOutput.label_id } } }], { edits });
    expect(JSON.parse(child.content)).toMatchObject({ label_id: expect.any(String),
      counts: { labels: 2 } });
    const [stale] = await tools.runLocalAssistantTools("local-user", [{ id: "stale-label",
      name: "document_operation", input: { action: "research",
        document_id: JSON.parse(child.content).resource,
        research_action: { type: "label", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Resurrected", scope: "source" } } }], { edits });
    expect(JSON.parse(stale.content)).toMatchObject({ ok: false, error: "tool_error" });
    const history = await store.listLocalVersions("local-user", output.document_id);
    expect(history?.versions).toHaveLength(1);
    expect(history?.versions[0]).toMatchObject({ provenance: {
      actor: "assistant", action: "created" } });
  });

  it.each(["rename", "unfile"])("reports a protected %s as pending and distinguishes later applied additions", async (operation) => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-pending-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures"), tools = await import("./support/localAssistantTools"),
      { readResearchFile } = await import("../researchFile"), edits = new Map(), labelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const seeded = await seedResearch(store, "protected.research.md", [
      { type: "label", id: labelId, name: "Counsel questions" },
      { type: "source", reference: { provider: "a2aj", id: "2001 SCC 1", kind: "case" }, labelIds: [labelId] },
    ]), sourceId = Object.keys(seeded.file.state.sources)[0];
    const [, changed] = await tools.runLocalAssistantTools("local-user", [
      { id: "read", name: "Read", input: { file_path: seeded.resource } },
      { id: "protected-change", name: "document_operation", input: { action: "research", document_id: seeded.resource,
        research_action: operation === "rename" ? { type: "label", id: labelId, name: "Counsel follow-up" }
          : { type: "label-selection", target: "sources", sourceIds: [sourceId], assign: [labelId], mode: "remove" } } },
    ], { documentNames: new Map([[seeded.document.id, seeded.document.filename]]), edits });
    const pending = JSON.parse(changed.content);
    expect(pending).toMatchObject({ ok: true, status: "pending", applied: false,
      change_id: expect.any(String), message: expect.stringMatching(/waiting for acceptance/i) });
    expect(pending.proposals).toMatchObject([{ id: pending.change_id }]);
    const saved = await readResearchFile(store.localDocuments, { userId: "local-user" }, seeded.document.id);
    expect(saved?.state.labels).toEqual(seeded.file.state.labels);
    expect(saved?.state.sources).toEqual(seeded.file.state.sources);
    const [addition] = await tools.runLocalAssistantTools("local-user", [{ id: "ordinary-addition", name: "document_operation",
      input: { action: "research", document_id: pending.resource, research_action: { type: "label", name: "Further review" } } }], { edits });
    expect(JSON.parse(addition.content)).toMatchObject({ ok: true, status: "applied", applied: true,
      label_id: expect.any(String), proposals: [{ id: pending.change_id }] });
    expect(JSON.parse(addition.content).change_id).toBeUndefined();
  });

  it("omits research operations where the chat does not support them", async () => {
    const tools = await import("./support/localAssistantTools"), operation =
      tools.localAssistantToolRegistry("local-user", { includeResearchTools: false }).all()
        .find(({ name }) => name === "document_operation");
    expect(operation).toMatchObject({ inputSchema: { properties: {
      action: { enum: ["metadata", "fix_supras"] } } } });
    expect(JSON.stringify(operation)).not.toContain("research_action");
  });

  it("advances same-turn research writes without checkpointing no-ops", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-reuse-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createResearchFileState, researchFileMarkdown } = await import("../researchFile");
    const document = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "Cases.research.md", bytes: Buffer.from(researchFileMarkdown("Cases", createResearchFileState())) });
    const resource = resourceReference.document(document.id, document.current_version_id);
    const tools = await import("./support/localAssistantTools");
    const [selected, , first, second] = await tools.runLocalAssistantTools("local-user", [
      { id: "read", name: "Read", input: { file_path: resource } },
      { id: "noop", name: "document_operation", input: { action: "research", document_id: resource,
        research_action: { type: "note", markdown: "" } } },
      { id: "first", name: "document_operation", input: { action: "research", document_id: resource,
        research_action: { type: "label", name: "First", scope: "source" } } },
      { id: "second", name: "document_operation", input: { action: "research", document_id: resource,
        research_action: { type: "label", name: "Second", scope: "source" } } },
    ], { documentNames: new Map([[document.id, document.filename]]), edits: new Map() });
    expect(JSON.parse(selected.content)).toMatchObject({ document_id: document.id });
    expect(JSON.parse(first.content)).toMatchObject({ counts: { labels: 1 } });
    expect(JSON.parse(second.content)).toMatchObject({ counts: { labels: 2 } });
    const history = await store.listLocalVersions("local-user", document.id);
    expect(history?.versions).toHaveLength(2);
    expect(history?.versions.find(({ id }) => id === history.current_version_id)).toMatchObject({
      source: "assistant_edit", parent_version_id: document.current_version_id,
      provenance: { actor: "assistant", action: "revised" } });
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

  it("pages the full saved-research note as ordinary Read rows", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-note-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createResearchFileState, researchFileMarkdown } = await import("../researchFile");
    const state = createResearchFileState(), note = "n".repeat(9_000); state.note = note;
    const document = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "notes.research.md", bytes: Buffer.from(researchFileMarkdown("Notes", state)) });
    const tools = await import("./support/localAssistantTools");
    const [read] = await tools.runLocalAssistantTools("local-user", [{ id: "read-note",
      name: "Read", input: { file_path: resourceReference.document(
        document.id, document.current_version_id), limit: 2 } }], {
      documentNames: new Map([[document.id, document.filename]]) });
    const output = JSON.parse(read.content);
    expect(output.categories.notes).toEqual({ count: 2, start: 1 });
    expect(output.items.map((item: { markdown: string }) => item.markdown).join("")).toBe(note);
  });

  it("pages complete bounded saved-research details without materializing them at once", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-details-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures"),
      { a2ajLegalSourceProvider } = await import("../legalSources/a2aj"),
      { structureNative } = await import("../structureNative");
    const { createA2AJPassageEvidence, createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const { commitResearchFile, pageResearchItems, researchQueryReceipt } = await import("../researchFile");
    const passageText = "The exact holding controls. ".repeat(1_300),
      native = await structureNative().deriveDocumentStructure({ kind: "provider_text", input: {
        provider: "a2aj", citation: "2026 SCC 1", source_kind: "cases", text: passageText,
        dataset: "scc", require_report_start: true, url: null } });
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceSha256: structureNative().documentRevision(native),
      spanText: passageText, start: 0, end: passageText.length, externalUrl: null, sourceClass: "case",
      sourceReference: { id: "2026 SCC 1" } });
    vi.spyOn(a2ajLegalSourceProvider, "document").mockResolvedValue({ docType: "cases", dataset: "scc",
      citation: receipt.citation, alternateCitation: null, name: "Example", date: null, url: null,
      verifiedPdf: null, language: "en", upstreamLicense: null, native });
    const seeded = await seedResearch(store, "details.research.md", []); let state = seeded.file.state,
      researchFile = seeded.file;
    for (const scope of ["source", "highlight"] as const) for (let index = 0; index < 21; index++)
      { researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
        researchFile, { type: "label", name: `${scope} ${index}`, scope }))!; state = researchFile.state; }
    researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
      researchFile, { type: "merge", evidence: [receipt] }))!; state = researchFile.state;
    const sourceLabelIds = Object.values(state.labels).filter(({ scope }) => scope === "source")
      .map(({ id }) => id), highlightLabelIds = Object.values(state.labels)
      .filter(({ scope }) => scope === "highlight").map(({ id }) => id).slice(0, 1),
      ids = Array.from({ length: 105 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      evidenceIds = [receipt.evidence_id, ...ids.slice(1).map((_, index) => `e_${index}`)],
      hostileNote = "\0".repeat(13_000), sourceNote = hostileNote, passageNote = hostileNote,
      hostile = "\0\\\"".repeat(200), fullReference = { provider: "journal", family: "f".repeat(1_000),
        id: "i".repeat(500), part: "p".repeat(1_000), kind: "case" as const,
        title: "t".repeat(1_000), citation: "c".repeat(1_000),
        alternateCitation: "a".repeat(1_000), date: "d".repeat(1_000),
        collection: "o".repeat(1_000), language: "fr" as const,
        url: `https://example.test/${"u".repeat(1_000)}` },
      query = researchQueryReceipt({
        query_id: "q_details", call_id: hostileNote, tool: "Read",
        executed_at: "2026-09-01T00:00:00.000Z", model: hostileNote,
        executor_version: "legal-source-pattern-v1",
        input: { pattern: hostile.repeat(20), source_ids: ids, label_ids: ids,
          rules: ids.slice(0, 50).map((id) => ({ phrase: hostile.slice(0, 500),
            direction: "after", unit: "sentence", chars: 500, slot: id })) },
        results: evidenceIds.slice(0, 100).map((evidence_id, rank) => ({ rank: rank + 1, evidence_id })),
      });
    query.sourceIds = ids; query.evidenceIds = evidenceIds;
    query.failures = ids.map((id) => ({ sourceId: id, code: "unavailable" }));
    query.slots = Object.fromEntries(evidenceIds.map((id, index) => [id, index
      ? [ids[index]] : Array.from({ length: 100 }, () => hostile.slice(0, 200))]));
    query.sourceFingerprints = Object.fromEntries(ids.map((id) => [id, ["a".repeat(64)]]));
    query.sourceReferences = Object.fromEntries(ids.map((id, index) => [id, index
      ? { provider: "courtlistener", id: String(index), kind: "case" } : fullReference]));
    query.labelPaths = Object.fromEntries(ids.map((id, index) => [id,
      index ? `Issues / Label ${index}` : "\0".repeat(1_000)]));
    researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
      researchFile, { type: "note", markdown: hostileNote }))!;
    researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
      researchFile, { type: "source", reference: fullReference,
        labelIds: sourceLabelIds, note: sourceNote }))!; state = researchFile.state;
    const detailedSourceId = Object.values(state.sources)
      .find(({ reference }) => reference.id === fullReference.id)!.id;
    const passageSourceId = Object.values(state.sources).find(({ reference }) =>
      reference.id === "2026 SCC 1")!.id;
    researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
      researchFile, { type: "annotate", kind: "evidence", sourceId: passageSourceId,
        id: receipt.evidence_id, labelIds: highlightLabelIds, note: passageNote }))!;
    const discovery = researchQueryReceipt({ query_id: "q_discovery", call_id: "source-search",
      tool: "search_sources", executed_at: "2026-09-01T00:01:00.000Z", model: "model",
      executor_version: "legal-source-search-v1", input: { query: "procedural fairness",
        source_types: ["case", "journal"], syntax: "boolean", search_type: "full_text",
        jurisdiction: "CA", collection: "ONCA", court: "onca", speaker: "Smith",
        date_from: "2020-01-01", date_to: "2026-09-01", sort: "most_cited", limit: 20 },
      results: [{ rank: 1, resource: resourceReference.source("a2aj",
        JSON.stringify(["2026 ONCA 1", "cases", "onca"])) }] });
    researchFile = (await commitResearchFile(store.localDocuments, { userId: "local-user" },
      researchFile, { type: "merge", queries: [query, discovery] }))!; state = researchFile.state;
    const savedQueries = (await pageResearchItems(store.localDocuments, { userId: "local-user" },
      researchFile, "queries", 0, 2)).items.flatMap((item) => item.kind === "query" ? [item.value] : []),
      savedQuery = savedQueries.find(({ query_id }) => query_id === query.query_id)!,
      savedDiscovery = savedQueries.find(({ query_id }) => query_id === discovery.query_id)!;
    const document = seeded.document;
    const tools = await import("./support/localAssistantTools"), evidence = createLegalEvidenceTurnState(),
      file_path = resourceReference.document(document.id, researchFile.versionId),
      context = { documentNames: new Map([[document.id, document.filename]]), legalEvidence: evidence },
      read = async (input: Record<string, unknown>, id: string) => {
        const [answer] = await tools.runLocalAssistantTools("local-user",
          [{ id, name: "Read", input: { file_path, ...input } }], context);
        expect(answer.content.length).toBeLessThan(45_000);
        return JSON.parse(answer.content) as { items: Array<Record<string, unknown>>;
          next_offset: number | null; total: number; categories?: Record<string, { count: number }> };
      }, first = await read({ offset: 1, limit: 1 }, "read-details-first"),
      rows = [...first.items];
    expect(first.items).toEqual([expect.objectContaining({ kind: "note" })]);
    expect(evidence.queries.size).toBe(0);
    expect(a2ajLegalSourceProvider.document).not.toHaveBeenCalled();
    let next = first.next_offset, output = first, reads = 1;
    while (next !== null) {
      output = await read({ offset: next, limit: 20 }, `read-details-${reads}`);
      rows.push(...output.items); next = output.next_offset;
      expect(++reads).toBeLessThan(20);
    }
    expect(rows).toHaveLength(output.total);
    expect(Math.max(...rows.map((row) => JSON.stringify(row).length))).toBeLessThan(45_000);
    expect(rows.filter(({ kind }) => kind === "note").map(({ markdown }) => markdown).join(""))
      .toBe(hostileNote);
    expect(rows.find(({ query_id }) => query_id === query.query_id)).toMatchObject({
      section: "search:2", continued: true, truncated: true });
    expect(rows.find(({ sourceId }) => sourceId === detailedSourceId)).toMatchObject({
      section: expect.stringMatching(/^source:\d+$/u), labels: 21, continued: true });
    expect(rows.find(({ evidence_id }) => evidence_id === receipt.evidence_id)).toMatchObject({
      section: expect.stringMatching(/^passage:\d+$/u), labels: 1, continued: true });
    const decoded = new Map<string, Record<string, unknown>>();
    for (const head of rows.filter(({ continued }) => continued === true)) {
      const chunks: Array<Record<string, unknown>> = [];
      let sectionNext: number | null = 1;
      while (sectionNext !== null) {
        const page = await read({ section: head.section, offset: sectionNext, limit: 20 },
          `read-${head.section}-${sectionNext}`);
        expect(page.items.length).toBeLessThanOrEqual(3);
        chunks.push(...page.items); sectionNext = page.next_offset;
      }
      let charOffset = 1;
      for (const chunk of chunks) { expect(chunk).toMatchObject({ section: head.section,
        field: "receipt", encoding: "json", offset: charOffset });
        expect(JSON.stringify(chunk).length).toBeLessThan(45_000);
        charOffset += String(chunk.json).length; }
      decoded.set(String(head.section), JSON.parse(chunks.map(({ json }) => json).join("")));
    }
    const exact = (head: Record<string, unknown>) => head.continued
      ? decoded.get(String(head.section))! : head,
      searches = rows.filter(({ kind }) => kind === "search").map(exact),
      search = searches.find(({ query_id }) => query_id === query.query_id)!,
      restoredDiscovery = searches.find(({ query_id }) => query_id === discovery.query_id)!;
    expect(search).toMatchObject({ kind: "search", truncated: false,
      query_id: query.query_id, executed_at: query.executed_at });
    expect(search.input).toEqual(query.input);
    expect(search.results).toEqual(savedQuery.results);
    expect(search.attempted_source_ids).toEqual(savedQuery.sourceIds);
    expect(search.matched_source_ids).toEqual(savedQuery.matchedSourceIds);
    expect(search.evidence_ids).toEqual(savedQuery.evidenceIds);
    expect(search.failures).toEqual(savedQuery.failures);
    expect(search.slots).toEqual(savedQuery.slots);
    expect(evidence.queries.get(query.query_id)).toMatchObject({
      sourceFingerprints: savedQuery.sourceFingerprints, call_id: query.call_id, model: query.model });
    const { url: _url, ...safeReference } = fullReference;
    const savedDetailedSourceId = Object.entries(savedQuery.sourceReferences ?? {})
      .find(([, reference]) => reference.id === fullReference.id)![0];
    expect(search.source_references).toMatchObject({ [savedDetailedSourceId]: safeReference });
    expect(Object.keys(search.source_references as object)).toHaveLength(savedQuery.sourceIds.length);
    expect(search.label_paths).toEqual(savedQuery.labelPaths);
    expect((search.slots as Record<string, string[]>)[receipt.evidence_id]).toHaveLength(100);
    expect(restoredDiscovery.input).toEqual(discovery.input);
    expect(restoredDiscovery.results).toEqual(savedDiscovery.results);
    expect(restoredDiscovery.result_source_ids).toEqual(savedDiscovery.sourceIds);
    expect(restoredDiscovery.matched_source_ids).toEqual(savedDiscovery.matchedSourceIds);
    expect(restoredDiscovery.continued).toBeUndefined();
    const restoredSource = exact(rows.find(({ sourceId }) => sourceId === detailedSourceId)!);
    expect(restoredSource.reference).toEqual(safeReference);
    expect(restoredSource.labelIds).toEqual(sourceLabelIds);
    expect(restoredSource.note).toBe(sourceNote);
    const restoredPassage = exact(rows.find(({ evidence_id }) => evidence_id === receipt.evidence_id)!);
    expect(restoredPassage).toMatchObject({ kind: "passage", evidence_id: receipt.evidence_id,
      sourceId: passageSourceId, locator: receipt.locator });
    expect(restoredPassage.exact_passage).toBe(passageText);
    expect(restoredPassage.labelIds).toEqual(highlightLabelIds);
    expect(restoredPassage.note).toBe(passageNote);
    expect(evidence.priorQueryIds).toEqual(new Set([query.query_id, discovery.query_id]));
  });

  it("saves and classifies a search result and its verified passage", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-source-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createA2AJPassageEvidence, createLegalEvidenceTurnState, registerLegalEvidence,
      registerLegalResearchQueries } =
      await import("../chat/legalEvidence");
    const { readResearchEvidenceParts, readResearchFile } = await import("../researchFile"),
      seeded = await seedResearch(store, "cases.research.md", [
        { type: "label", name: "Leading", scope: "source" },
        { type: "label", name: "Holding", scope: "highlight" }]),
      sourceLabel = Object.values(seeded.file.state.labels).find(({ scope }) => scope === "source")!.id,
      highlightLabel = Object.values(seeded.file.state.labels).find(({ scope }) => scope === "highlight")!.id,
      document = seeded.document;
    const source = resourceReference.source("a2aj",
      JSON.stringify(["2026 SCC 1", "cases", "scc", "en"]));
    const evidence = createLegalEvidenceTurnState();
    registerLegalResearchQueries(evidence, [{ call_id: "search", tool: "search_sources",
      executed_at: "2026-09-01T00:00:00.000Z", executor_version: "legal-source-search-v1",
      input: { query: "example" }, results: [{ rank: 1, resource: source }] }], "model");
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "The verified holding.",
      spanText: "The verified holding.", start: 0, end: 21, externalUrl: null,
      sourceClass: "case", sourceReference: { id: "2026 SCC 1" },
      locator: { kind: "paragraph", label: "par7" } });
    registerLegalEvidence(evidence, receipt);
    const tools = await import("./support/localAssistantTools");
    const edits = new Map(), documentNames = new Map([[document.id, document.filename]]);
    const [, saved] = await tools.runLocalAssistantTools("local-user", [{ id: "read-research",
      name: "Read", input: { file_path: seeded.resource } }, { id: "save-source",
      name: "document_operation", input: { action: "research",
        document_id: seeded.resource,
        research_action: { type: "source", reference: { provider: "a2aj",
          id: "2026 SCC 1", kind: "case", title: "Example case" },
        labelIds: [sourceLabel],
        note: "Controls the test." } } }], { legalEvidence: evidence, documentNames, edits });
    const sourceOutput = JSON.parse(saved.content);
    expect(sourceOutput).toMatchObject({ ok: true, counts: { sources: 1 } });
    expect(sourceOutput.source_id).toMatch(/^[0-9a-f-]{36}$/u);
    const [passage] = await tools.runLocalAssistantTools("local-user", [{ id: "save-passage",
      name: "document_operation", input: { action: "research", document_id: sourceOutput.resource,
        evidence_ids: [receipt.evidence_id], research_action: { type: "save" } } }],
    { legalEvidence: evidence, documentNames, edits });
    const passageOutput = JSON.parse(passage.content), savedPassage = passageOutput.saved[0];
    expect(savedPassage).toEqual({ evidence_id: receipt.evidence_id, source_id: sourceOutput.source_id });
    await tools.runLocalAssistantTools("local-user", [{ id: "annotate-passage",
      name: "document_operation", input: { action: "research", document_id: passageOutput.resource,
        research_action: { type: "annotate", kind: "evidence", id: savedPassage.evidence_id,
          sourceId: savedPassage.source_id, labelIds: [highlightLabel], note: "Controls." } } }],
    { legalEvidence: evidence, documentNames, edits });
    const file = await readResearchFile(store.localDocuments, { userId: "local-user" }, document.id);
    expect(Object.values(file!.state.sources)[0]).toMatchObject({
      labelIds: [sourceLabel],
      note: "Controls the test.",
      reference: { provider: "a2aj", id: "2026 SCC 1", title: "Example case",
        collection: "scc", language: "en" },
    });
    expect(Object.values((await readResearchEvidenceParts(store.localDocuments,
      { userId: "local-user" }, file!, [sourceOutput.source_id])).get(sourceOutput.source_id)!))
      .toEqual([expect.objectContaining({
        labelIds: [highlightLabel], note: "Controls." })]);
  });

  it("writes the cited memo inside its research file", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-research-memo-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const { createA2AJPassageEvidence, createLegalEvidenceTurnState, registerLegalEvidence } =
      await import("../chat/legalEvidence");
    const receipt = createA2AJPassageEvidence({ citation: "2026 SCC 1", name: "Example",
      dataset: "scc", language: "en", sourceText: "The verified holding.",
      spanText: "The verified holding.", start: 0, end: 21, externalUrl: null,
      sourceClass: "case", sourceReference: { id: "2026 SCC 1" },
      locator: { kind: "paragraph", label: "par7" } }), unsaved = createA2AJPassageEvidence({
      citation: "2026 SCC 2", name: "Other", dataset: "scc", language: "en",
      sourceText: "Another verified passage.", spanText: "Another verified passage.", start: 0,
      end: 25, externalUrl: null, sourceClass: "case", sourceReference: { id: "2026 SCC 2" } });
    const seeded = await seedResearch(store, "cases.research.md",
      [{ type: "merge", evidence: [receipt] }]), research = seeded.document, exact = seeded.resource;
    const tools = await import("./support/localAssistantTools"), evidence = createLegalEvidenceTurnState();
    registerLegalEvidence(evidence, receipt); registerLegalEvidence(evidence, unsaved);
    const [, created, rejected] = await tools.runLocalAssistantTools("local-user", [{ id: "read-research",
      name: "Read", input: { file_path: exact } }, { id: "memo",
      name: "document_operation", input: { action: "research", document_id: exact,
        evidence_ids: [receipt.evidence_id],
        research_action: { type: "memo", title: "Case memo",
          markdown: `# Case memo\n\n## Analysis\n\nThe authorities support the proposition. [@${receipt.evidence_id}]` } } }, { id: "unsupported-memo",
      name: "document_operation", input: { action: "research", document_id: exact,
        evidence_ids: [unsaved.evidence_id], research_action: { type: "memo", title: "Unsupported",
          markdown: "An unsupported proposition." } } }], {
      documentNames: new Map([[research.id, research.filename]]), edits: new Map(),
      legalEvidence: evidence });
    const output = JSON.parse(created.content), file = await store.localDocuments.read(
      { userId: "local-user" }, output.document_id, null, false);
    expect(output).toMatchObject({ ok: true, action: "updated", filename: research.filename,
      document_id: research.id });
    const markdown = file?.bytes.toString() ?? "";
    expect(markdown.match(/^## Case memo$/gmu)).toHaveLength(1);
    expect(markdown).toContain(`research_file=${research.id}`);
    expect(markdown).toContain("## Analysis");
    expect(markdown).toContain("[Example, 2026 SCC 1 at para 7](</sources/view?");
    expect(markdown).not.toContain("document://");
    expect(markdown).not.toContain("[@");
    expect(JSON.parse(rejected.content)).toEqual({ ok: false,
      error: "Unknown or unsaved evidence ID" });
    expect((await store.localDocuments.metadata({ userId: "local-user" }, output.document_id))
      ?.project_id).toBeNull();
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
    expect(footnote.evidence![0].span_text).toBe(footnoteText);
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

  it("reads system workflow instructions in account-free mode", async () => {
    const tools = await import("./support/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "workflow",
        name: "Read",
        input: { file_path: "workflow://builtin-extract-key-terms" },
      },
    ]);

    expect(response.content).toContain("# Extract Key Terms");
    expect(response.content).toContain("uploaded documents");
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

  it("reads Authorities summary-first and returns only requested occurrence detail", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const draft = createAuthoritiesDraft({ kind: "manual" });
    draft.cover = { courtFileNumber: "T-42-26", partyGroups: [
      { role: "Applicant", parties: ["Ada North"] },
      { role: "Respondent", parties: ["Boreal Ltd."] },
    ], applicationUnder: "Federal Courts Act, section 18.1", title: "Book of Authorities" };
    const text = "See R v Jordan, 2016 SCC 27 at para 5.";
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["occurrence-1"] },
    { id: "body:1", kind: "body", ordinal: 1, footnoteId: null,
      footnoteRefs: [], pageNumbers: [2], text: "See ibid.",
      occurrenceIds: ["occurrence-2"] }];
    draft.authorities.jordan = { id: "jordan", key: "jordan", kind: "case",
      citation: "2016 SCC 27", name: "R v Jordan", displayName: null, evidenceIds: [],
      locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "unresolved" } };
    draft.authorityOrder = ["jordan"];
    for (let index = 0; index < 500; index += 1) {
      const id = `case-${index}`;
      draft.authorities[id] = { ...draft.authorities.jordan, id, key: id,
        citation: `${index} ${"x".repeat(800)}`, name: `Case ${index} ${"y".repeat(800)}` };
      draft.authorityOrder.push(id);
    }
    const enSha = "a".repeat(64), frSha = "b".repeat(64);
    draft.authorities.jordan.source = { kind: "attached", sources: [
      { bindingRole: "authority:jordan:en", filename: "Jordan EN.pdf", sourceSha256: enSha,
        sourceUrl: null, origin: "manual", language: "en" },
      { bindingRole: "authority:jordan:fr", filename: "Jordan FR.pdf", sourceSha256: frSha,
        sourceUrl: null, origin: "manual", language: "fr" },
    ] };
    draft.bindings["authority:jordan:en"] = { kind: "local-file", handleId: "en",
      lastSeen: { name: "Jordan EN.pdf", size: 1, modified: 1, sha256: enSha } };
    draft.bindings["authority:jordan:fr"] = { kind: "local-file", handleId: "fr",
      lastSeen: { name: "Jordan FR.pdf", size: 1, modified: 1, sha256: frSha } };
    draft.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:0",
      start: 4, end: 37, text: text.slice(4, 37),
      authoritySpan: { start: 4, end: 27, text: text.slice(4, 27) },
      coreSpan: { start: 16, end: 27, text: text.slice(16, 27) },
      pinpointSpan: { start: 31, end: 37, text: text.slice(31, 37) },
      kind: "case", citation: "2016 SCC 27",
      authorityId: "jordan", reference: null, pinpoints: [{ kind: "paragraph", text: "para 5" }],
      evidenceIds: [], sourceTextSha256: "source-hash", localOrdinal: 4, reviewed: false };
    draft.occurrences["occurrence-2"] = { ...draft.occurrences["occurrence-1"],
      id: "occurrence-2", unitId: "body:1", start: 4, end: 8, text: "ibid",
      authoritySpan: { start: 4, end: 8, text: "ibid" },
      coreSpan: { start: 4, end: 8, text: "ibid" }, pinpointSpan: null,
      kind: "reference", citation: "ibid", reference: { kind: "ibid",
        targetAuthorityId: "jordan" }, pinpoints: [], localOrdinal: 4 };
    const current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 7, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const tools = await import("./support/localAssistantTools");
    const responses = await tools.runLocalAssistantTools("local-user", [
      { id: "read-authorities", name: "update_work_product",
        input: { action: "read", occurrence_limit: 1 } },
      { id: "page-occurrences", name: "update_work_product",
        input: { action: "read", occurrence_offset: 1,
          occurrence_limit: 1 } },
      { id: "read-occurrence", name: "update_work_product", input: { action: "read",
        occurrence_id: "occurrence-1" } },
      { id: "read-unit", name: "update_work_product", input: { action: "read",
        unit_id: "body:0", text_limit: 10 } },
      { id: "continue-unit", name: "update_work_product", input: { action: "read",
        unit_id: "body:0", text_offset: 10 } },
      { id: "read-reference", name: "update_work_product", input: { action: "read",
        occurrence_id: "occurrence-2" } },
      { id: "wrong-authorities", name: "update_work_product",
        input: { action: "read", draft_id: "another-draft" } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      workProducts: { get: vi.fn(async () => current), resolve: vi.fn(async () => ({
        product: current, freshness: "unbuilt", inputs: {}, dependencies: [],
      })) } as never });

    const summary = JSON.parse(responses[0].content);
    expect(summary).toMatchObject({ ok: true,
      work_product: { id: current.id, kind: "authorities", revision: 7 },
      draft: { counts: { units: 2, occurrences: 2, authorities: 501 },
        cover: draft.cover,
        book_parts: { cover: null, index: null },
        authorities: expect.arrayContaining([
          expect.objectContaining({ id: "jordan", citation: "2016 SCC 27", source: {
            status: "attached", pdf_count: 2,
            pdfs: expect.arrayContaining([
              expect.objectContaining({ filename: "Jordan EN.pdf", language: "en" }),
              expect.objectContaining({ filename: "Jordan FR.pdf", language: "fr" }),
            ]),
          } }),
        ]), occurrence_index: [{ id: "occurrence-1", unit_id: "body:0",
          start: 4, end: 37, kind: "case", citation: "2016 SCC 27",
          authority_id: "jordan" }],
        occurrence_page: { offset: 0, limit: 1, has_more: true } },
    });
    expect(summary.draft).not.toHaveProperty("units");
    expect(summary.draft).not.toHaveProperty("occurrences");
    expect(responses[0].content.length).toBeLessThan(64_000);
    expect(JSON.parse(responses[1].content)).toMatchObject({ draft: {
      occurrence_index: [{ id: "occurrence-2", unit_id: "body:1" }],
      occurrence_page: { offset: 1, limit: 1, has_more: false },
    } });
    expect(JSON.parse(responses[2].content)).toMatchObject({ draft: { unit: {
      id: "body:0", text, text_offset: 0 }, occurrence: { id: "occurrence-1",
      authority_span: { start: 4, end: 27 }, pinpoint_span: { start: 31, end: 37 } } } });
    expect(responses[2].content).not.toContain("reviewed");
    const detail = JSON.parse(responses[2].content);
    expect(detail).toMatchObject({ output_freshness: "unbuilt", input_issues: [],
      work_product: { id: current.id, revision: 7 }, draft: {
        authorities: [expect.objectContaining({ id: "jordan" })],
        authority_page: { has_more: false } } });
    for (const field of ["cover", "settings", "book_parts", "counts", "occurrence_index"]) {
      expect(detail.draft).not.toHaveProperty(field);
    }
    expect(detail).not.toHaveProperty("output_roles");
    const first = JSON.parse(responses[3].content).draft.unit;
    const next = JSON.parse(responses[4].content).draft.unit;
    expect(first).toMatchObject({ text_offset: 0, text_end: 10, text_length: text.length,
      has_more: true, occurrences: [{ id: "occurrence-1", start: 4, end: 37 }] });
    expect(next).toMatchObject({ text_offset: 10, text_end: text.length, has_more: false });
    expect(first.text + next.text).toBe(text);
    expect(JSON.parse(responses[5].content).draft).toMatchObject({
      authorities: [expect.objectContaining({ id: "jordan" })],
      occurrence: { reference: { kind: "ibid", targetAuthorityId: "jordan" } },
    });
    expect(JSON.parse(responses.at(-1)!.content)).toMatchObject({ ok: false,
      error: "invalid_arguments" });
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
    ]);
  });

  it("applies canonical authority actions and rejects invalid payloads", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const { applyAuthoritiesUserAction } = await import("../authoritiesActions");
    const draft = applyAuthoritiesUserAction(createAuthoritiesDraft({ kind: "manual" }),
      { type: "add-authority", kind: "case", citation: "2016 SCC 27" });
    const unusedId = draft.authorityOrder[0];
    let current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 2, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = async (_scope: unknown, _id: string, revision: number,
      action: Parameters<typeof applyAuthoritiesUserAction>[1]) => {
      current = { ...current, revision: revision + 1,
        state: applyAuthoritiesUserAction(current.state, action) };
      return current;
    };
    const tools = await import("./support/localAssistantTools");
    const actions = [
      { type: "set-profile", profileId: "federal-court" },
      { type: "add-authority", kind: "case", citation: "2026 SCC 1", name: "R v A" },
      { type: "clear-authority-source", authorityId: unusedId },
      { type: "remove-authority", authorityId: unusedId },
      { type: "clear-book-part", slot: "cover" },
      { type: "set-cover", cover: { courtFileNumber: "T-42-26", partyGroups: [
        { role: "Applicant", parties: ["Ada North"] },
        { role: "Respondent", parties: ["Boreal Ltd."] },
      ], applicationUnder: "Federal Courts Act, section 18.1", title: "Book of Authorities" } },
      { type: "set-settings", settings: { bookRole: "moving-party" } },
    ];
    const responses = await tools.runLocalAssistantTools("local-user", [
      ...actions.map((authorities_action, index) => ({ id: `action-${index}`,
        name: "update_work_product", input: { action: "update", authorities_action } })),
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act } as never,
      workProducts: { get: vi.fn(async () => current) } as never });

    expect(responses.map((response) => JSON.parse(response.content)))
      .toEqual(Array.from({ length: actions.length }, () => expect.objectContaining({ ok: true })));
    expect(Object.values(current.state.authorities)).toEqual([
      expect.objectContaining({ kind: "case", citation: "2026 SCC 1", name: "R v A" }),
    ]);
    expect(current.state.cover).toEqual(actions[5].cover);
    expect(current.state.settings.profileId).toBe("federal-court");
    expect(current.state.settings.bookRole).toBe("moving-party");
    const before = structuredClone(current);
    const rejected = await tools.runLocalAssistantTools("local-user", [
      { id: "old-field", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "remove-authority",
          authority_id: current.state.authorityOrder[0] } } },
      { id: "unadvertised", name: "update_work_product", input: { action: "update",
        authorities_action: { type: "begin-canlii-handoff",
          authorityId: current.state.authorityOrder[0] } } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act } as never, workProducts: { get: async () => current } as never });
    expect(rejected.map((response) => JSON.parse(response.content).error))
      .toEqual(["invalid_arguments", "invalid_arguments"]);
    expect(current).toEqual(before);
  });

  it("inspects, attaches, replaces, and removes a supplemental book PDF", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const first = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "chronology.pdf", bytes: Buffer.from("%PDF-1.7\nfirst\n%%EOF") });
    const second = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "chronology revised.pdf", bytes: Buffer.from("%PDF-1.7\nsecond\n%%EOF") });
    const { createAuthoritiesDraft, reduceAuthoritiesDraft } = await import("../authoritiesDomain");
    let current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 1, state: createAuthoritiesDraft({ kind: "manual" }),
      outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = vi.fn(async (_scope: unknown, _id: string, revision: number,
      action: Parameters<typeof reduceAuthoritiesDraft>[1]) => {
      current = { ...current, revision: revision + 1,
        state: reduceAuthoritiesDraft(current.state, action) };
      return current;
    });
    const attachLibraryPdf = vi.fn(async (_scope: unknown, _id: string, input: {
      revision: number; documentId: string; target: { kind: "book"; slot: "supplemental";
        supplementId?: string } }) => {
      const document = input.documentId === first.id ? first : second;
      const id = input.target.supplementId ?? "supplement-1";
      current = { ...current, revision: input.revision + 1, state: reduceAuthoritiesDraft(
        current.state, { type: "set-book-supplement", binding: { kind: "document",
          documentId: document.id, version: "latest" }, supplement: { id,
          bindingRole: `book:supplemental:${id}`, filename: document.filename,
          sourceSha256: document.source_sha256 } }) };
      return current;
    });
    const tools = await import("./support/localAssistantTools");
    const [attached] = await tools.runLocalAssistantTools("local-user", [{
      id: "attach-supplement", name: "update_work_product", input: {
        action: "update", book_slot: "supplemental",
        document_id: resourceReference.document(first.id, first.current_version_id),
      },
    }], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act, attachLibraryPdf } as never,
      workProducts: { get: vi.fn(async () => current) } as never });
    const supplementId = JSON.parse(attached.content).change.supplement_id as string;

    const [inspected, replaced, removed] = await tools.runLocalAssistantTools("local-user", [
      { id: "read-supplement", name: "update_work_product",
        input: { action: "read" } },
      { id: "replace-supplement", name: "update_work_product", input: {
        action: "update", book_slot: "supplemental",
        supplement_id: supplementId,
        document_id: resourceReference.document(second.id, second.current_version_id),
      } },
      { id: "remove-supplement", name: "update_work_product", input: {
        action: "update", authorities_action: {
          type: "remove-book-supplement", id: supplementId,
        },
      } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act, attachLibraryPdf } as never,
      workProducts: { get: vi.fn(async () => current), resolve: vi.fn(async () => ({
        product: current, freshness: "unbuilt", inputs: {}, dependencies: [],
      })) } as never });

    expect(JSON.parse(inspected.content)).toMatchObject({ draft: { book_parts: {
      supplements: [{ id: supplementId, filename: "chronology.pdf" }],
    } } });
    expect(JSON.parse(replaced.content)).toMatchObject({ change: {
      type: "attach-book-pdf", book_slot: "supplemental", supplement_id: supplementId,
    } });
    expect(JSON.parse(removed.content)).toMatchObject({ change: {
      type: "remove-book-supplement", supplement_id: supplementId,
    } });
    expect(attachLibraryPdf.mock.calls.map((call) => call[2].target)).toEqual([
      { kind: "book", slot: "supplemental" },
      { kind: "book", slot: "supplemental", supplementId },
    ]);
    expect(act.mock.calls.map((call) => call[3])).toEqual([
      { type: "remove-book-supplement", id: supplementId },
    ]);
    expect(current.state.bookParts.supplements).toEqual([]);
  });

  it("reports compact discrepancies and stale inputs", async () => {
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
    const tools = await import("./support/localAssistantTools");
    const { createLegalEvidenceTurnState } = await import("../chat/legalEvidence");
    const legalEvidence = createLegalEvidenceTurnState();
    const [review] = await tools.runLocalAssistantTools("local-user", [
      { id: "review", name: "update_work_product", input: { action: "review",
        occurrence_limit: 100 } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision, legalEvidence,
      authorities: { discrepancies } as never,
      workProducts: { get: vi.fn(async () => current), resolve } as never });

    expect(JSON.parse(review.content)).toMatchObject({ output_freshness: "stale", input_issue_count: 2,
      input_issues: [{ role: "source", status: "changed", refreshable: true },
        { role: "missing", status: "missing", refreshable: false }],
      discrepancy_count: 1, discrepancies: [{ occurrence_id: "occ-1",
        cited_locator: { label: "para 9" }, suggested_locator: { label: "para 10" } }] });
    expect(review.content.length).toBeLessThan(64_000);
    expect(JSON.parse(review.content).discrepancies[0].proposition.length).toBeLessThanOrEqual(701);
    expect([...legalEvidence.reportedCitations ?? []]).toContain("2026 SCC 1");
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

  it("creates or updates Authorities from exact grounded receipts without reading documents", async () => {
    const {
      createLegalEvidenceTurnState,
      createTnaEvidence,
      registerLegalEvidence,
    } = await import("../chat/legalEvidence");
    const sourceText = "First grounded passage. Second grounded passage.";
    const receipt = (spanText: string, locatorLabel: string) => createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "2016-scc-27",
      sourceText,
      spanText,
      citation: "2016 SCC 27",
      name: "R v Jordan",
      dataset: "fixture",
      version: "2016-07-08",
      locatorKind: "paragraph",
      locatorLabel,
    });
    const receipts = [receipt("First grounded passage.", "par1"),
      receipt("Second grounded passage.", "par2")];
    const state = createLegalEvidenceTurnState();
    receipts.forEach((item) => registerLegalEvidence(state, item));
    const importDraft = vi.fn(async () => ({ id: "grounded-draft", kind: "authorities",
      projectId: "project-1", revision: 1 }));
    const active = { id: "active-draft", kind: "authorities", projectId: null,
      revision: 3 };
    const addReceipts = vi.fn(async () => ({ ...active, revision: 4 }));
    const authorities = { importDraft, addReceipts } as never;
    const read = vi.fn(() => { throw new Error("documents must not be read"); });
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "grounded-authorities",
      name: "update_work_product",
      input: { action: "create", kind: "authorities",
        evidence_ids: receipts.map(({ evidence_id }) => evidence_id) },
    }], {
      legalEvidence: state,
      matterId: "project-1",
      authorities,
      documents: { read } as never,
    });

    expect(importDraft.mock.calls[0][1].source.seeds).toEqual([{
      authorityKey: "2016scc27", receipts }]);
    expect(importDraft.mock.calls[0][1].source.seeds[0].receipts[0]).toBe(receipts[0]);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(response.content)).toEqual({ ok: true, requested_action: "open",
      work_product: { id: "grounded-draft", kind: "authorities", revision: 1 } });
    expect(response.events).toEqual([expect.objectContaining({
      type: "workflow_run",
      status: "complete",
      tool: "update_work_product",
      work_product: { id: "grounded-draft", kind: "authorities", revision: 1 },
    })]);

    const [updated] = await tools.runLocalAssistantTools("local-user", [{
      id: "update-grounded-authorities",
      name: "update_work_product",
      input: { action: "update",
        evidence_ids: receipts.map(({ evidence_id }) => evidence_id) },
    }], {
      legalEvidence: state, authorities, documents: { read } as never,
      authoritiesId: "active-draft", authoritiesRevision: 3,
      workProducts: { get: vi.fn(async () => active) } as never,
    });
    expect(JSON.parse(updated.content)).toEqual({ ok: true,
      change: { type: "add-authorities", evidence_count: 2 },
      work_product: { id: "active-draft", kind: "authorities", revision: 4 } });
    expect(updated.events).toEqual([expect.objectContaining({
      status: "complete", tool: "update_work_product",
      work_product: { id: "active-draft", kind: "authorities", revision: 4 },
    })]);
    expect(read).not.toHaveBeenCalled();
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

  it("turns A2AJ pattern hits into native pinpoint evidence", async () => {
    const text = Array.from({ length: 6 }, (_, index) =>
      `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language ${
        index === 2 ? "and states the distinctive governing principle" : "to preserve structure"
      } for a reliable source passage.`).join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{
        dataset: "SCC",
        citation_en: "2099 SCC 3",
        source_url_en: "https://example.test/case-3",
        unofficial_text_en: text,
      }] }),
    }));
    const [{ createLegalEvidenceTurnState }, tools] = await Promise.all([
      import("../chat/legalEvidence"),
      import("./support/localAssistantTools"),
    ]);
    const state = createLegalEvidenceTurnState();
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "call-pattern",
      name: "Read",
      input: {
        file_path: resourceReference.source(
          "a2aj",
          JSON.stringify(["2099 SCC 3", "cases", "SCC"]),
        ),
        pattern: "distinctive governing principle",
        context_chars: 40,
      },
    }], { legalEvidence: state });
    const receipt = response.evidence?.[0];
    const entry = receipt && state.evidence.get(receipt.evidence_id);

    expect(receipt?.locator).toEqual({ kind: "paragraph", label: "par3" });
    expect(receipt?.span_text).toBe(text.split("\n")[2]);
    expect(entry).toBeDefined();
    expect(response.queryReceipts).toEqual([expect.objectContaining({
      call_id: "call-pattern",
      tool: "Read",
      executor_version: "legal-source-pattern-v1",
      input: expect.objectContaining({
        pattern: "distinctive governing principle",
        max_results: 20,
        context_chars: 40,
      }),
      results: [{ rank: 1, evidence_id: receipt?.evidence_id }],
    })]);
    const { presentLegalEvidence } = await import("../chat/citationPresentation");
    expect(presentLegalEvidence(entry!).passageUrl)
      .toContain("https://example.test/case-3#:~:text=");
    expect(presentLegalEvidence(entry!).passageUrl).not.toContain("#par3");
  });

  it("keeps unstructured A2AJ pattern evidence on clean text-fragment boundaries", async () => {
    const text = [
      "Case summary",
      "This preliminary case summary provides background framing material before saying that effective notice requires clear communication with records and permits meaningful assessment by the recipient parent after disclosure.",
      "A separate concluding summary addresses disposition.",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{
        dataset: "SCC",
        citation_en: "2099 SCC 4",
        source_url_en: "https://example.test/case-4",
        unofficial_text_en: text,
      }] }),
    }));
    const [{ createLegalEvidenceTurnState }, tools] = await Promise.all([
      import("../chat/legalEvidence"),
      import("./support/localAssistantTools"),
    ]);
    const state = createLegalEvidenceTurnState();
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "call-unstructured-pattern",
      name: "Read",
      input: {
        file_path: resourceReference.source(
          "a2aj",
          JSON.stringify(["2099 SCC 4", "cases", "SCC"]),
        ),
        pattern: "effective notice requires clear communication",
        context_chars: 40,
      },
    }], { legalEvidence: state });
    const receipt = response.evidence?.[0];
    const entry = receipt && state.evidence.get(receipt.evidence_id);

    expect(receipt?.locator.kind).toBe("document");
    expect(receipt?.span_text).toBe(text.split("\n")[1]);
    expect(receipt?.span_text).not.toContain("\n");
    const { presentLegalEvidence } = await import("../chat/citationPresentation");
    expect(presentLegalEvidence(entry!).passageUrl)
      .toContain("#:~:text=");
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
