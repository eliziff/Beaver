import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} from "docx";
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

const nativeTableBytes = () =>
  Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph("1.01 Schedule."),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Alpha")] }),
                    new TableCell({
                      children: [new Paragraph("Unique cell value")],
                    }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Director")] }),
                    new TableCell({ children: [new Paragraph("$10,000")] }),
                    new TableCell({ children: [new Paragraph("$50,000")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Secretary")] }),
                    new TableCell({ children: [new Paragraph("$15,000")] }),
                    new TableCell({ children: [new Paragraph("$75,000")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Treasurer")] }),
                    new TableCell({ children: [new Paragraph("$25,000")] }),
                    new TableCell({ children: [new Paragraph("$100,000")] }),
                  ],
                }),
              ],
            }),
            new Paragraph("2.01 Unique elsewhere."),
          ],
        },
      ],
    }),
  );

const numberedReferenceBytes = () =>
  Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            "ARTICLE I",
            "COVENANTS",
            "",
            "1.01 First. This points to Section 1.03.",
            "",
            "1.02 Delete Me. This provision is obsolete.",
            "",
            "1.03 Third. This provision remains.",
            "",
            "ARTICLE II",
            "GENERAL",
            "",
            "2.01 Pointer. Section 1.03 controls.",
          ].map((text) => new Paragraph(text)),
        },
      ],
    }),
  );

async function expectReadRecipesAccepted(
  tools: typeof import("../chat/localAssistantTools"),
  filePath: string,
  rows: Array<{ read: Record<string, unknown> }>,
) {
  const reads = await tools.runLocalAssistantTools(
    "local-user",
    rows.map((row, index) => ({
      id: `recipe-${index}`,
      name: "Read",
      input: { file_path: filePath, ...row.read },
    })),
  );
  expect(reads).toHaveLength(rows.length);
  for (const read of reads) {
    expect(read.evidenceSpans?.length, read.content).toBeGreaterThan(0);
  }
}

afterEach(async () => {
  try {
    const store = await import("../localDocumentStore");
    await store.closeLocalDocumentStore();
  } catch {}
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.MIKE_NAV_SHAPE;
  delete process.env.MIKE_TOOL_SHAPE;
  delete process.env.MIKE_RETRIEVAL_EXPERIMENT;
  delete process.env.MIKE_PROGRESSIVE_DISCLOSURE;
  delete process.env.MIKE_MODEL_COVERAGE_ROUTING;
  delete process.env.MIKE_WHOLE_READ_MAX_CHARS;
  delete process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS;
  delete process.env.MIKE_RESIDENT_AUTHORING;
  delete process.env.MIKE_TERMINAL_AUTHORING;
  delete process.env.MIKE_DISABLE_RESEARCH_TOOLS;
  delete process.env.MIKE_DISABLE_ASK_INPUTS;
  delete process.env.MIKE_TOOL_RESULT_CAP;
  delete process.env.MIKE_CONTEXT_HANDOFF;
  delete process.env.MIKE_DRAFT_HANDOFF_MODE;
  delete process.env.MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS;
  delete process.env.MIKE_DRAFT_EDIT;
  delete process.env.MIKE_EXPOSURE_ECHO;
  vi.doUnmock("../tableOfAuthorities");
  vi.doUnmock("../convert");
  vi.doUnmock("../localDocumentStore");
  vi.doUnmock("../localPdfLookup");
  vi.doUnmock("../legalStructureSidecar");
  vi.doUnmock("../chat/publicLegalSourceState");
  vi.doUnmock("node:fs/promises");
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {

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
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-edit-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Original provision.")] }],
      }),
    );
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes,
    });
    const [{ createLocalChatToolRunner }, { createLegalEvidenceTurnState }] =
      await Promise.all([
        import("../chat/localChatToolRunner"),
        import("../chat/legalEvidence"),
      ]);
    const committed = vi.fn();
    const chat = createLocalChatToolRunner({
      userId: "local-user",
      projectId: null,
      allowedDocumentIds: new Set([document.id]),
      documentNames: new Map([[document.id, "draft.docx"]]),
      editMode: mode,
      onMutationCommitted: committed,
    });
    expect(chat.toolActivityMetadata({
      id: "read-draft",
      name: "Read",
      input: { file_path: document.id },
    })).toEqual({ label: "Reading draft.docx" });
    const evidence = createLegalEvidenceTurnState();
    const events: unknown[] = [];
    const { results: [edited] } = await chat.createToolRunner(
      evidence,
      "main",
    )([
      {
        id: "coding-edit",
        name: "Edit",
        input: {
          file_path: "draft.docx",
          old_string: "Original",
          new_string: "Revised",
        },
      },
    ], { evidence, emit: vi.fn(), addEvent: (event) => events.push(event) });
    expect(JSON.parse(edited.mutationReceipt ?? "null")).toMatchObject({
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      edit_mode: mode,
      document_id: document.id,
      version_number: 2,
    });
    expect(events).toMatchObject([{
      type: "doc_edited",
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
    const saved = await store.getLocalVersionFile("local-user", document.id);
    expect(saved).not.toBeNull();
    const { extractDocxBodyText, extractTrackedChangeIds } = await import(
      "../docxTrackedChanges"
    );
    const savedBytes = await readFile(saved!.path);
    expect(await extractDocxBodyText(savedBytes)).toContain("Revised provision.");
    expect(await extractTrackedChangeIds(savedBytes)).toHaveLength(revisionCount);
    expect(committed).toHaveBeenCalledOnce();
  }, 10_000);

  it("applies deterministic DOCX operations through Edit", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-ref-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Original provision.")] }],
      }),
    );
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes,
    });
    const { runLocalAssistantTools } = await import(
      "../chat/localAssistantTools"
    );

    const [response] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "deterministic-edit",
          name: "Edit",
          input: {
            file_path: "draft.docx",
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

    const payload = JSON.parse(response.content);
    expect(payload).toMatchObject({
      ok: true,
      action: "revised",
      document_id: document.id,
      version_number: 2,
    });
    expect(payload.annotations[0]).not.toHaveProperty("reason");
  });

  it("source-qualifies multi-document coding reads independently of aliases", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-evidence-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
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
    const tools = await import("../chat/localAssistantTools");
    const [grep, byFilename, byId] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "grep-both",
          name: "Grep",
          input: { pattern: "needle", output_mode: "content" },
        },
        {
          id: "read-name",
          name: "Read",
          input: { file_path: "first.txt" },
        },
        {
          id: "read-id",
          name: "Read",
          input: { file_path: first.id },
        },
      ],
    );

    expect(new Set(grep.evidenceSegments?.map((item) => item.documentId))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(byFilename.evidenceSegments?.[0]).toMatchObject({
      documentId: first.id,
      versionId: first.current_version_id,
    });
    expect(byId.evidenceSegments?.[0]).toMatchObject({
      documentId: first.id,
      versionId: first.current_version_id,
    });
  });

  it("keeps broad Grep display context out of the drafting handoff", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-grep-focus-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const text = ["zero", "one", "two", "NEEDLE", "four", "five", "six"].join("\n");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "focus.txt",
      bytes: Buffer.from(text, "utf8"),
    });
    const tools = await import("../chat/localAssistantTools");
    const [grep] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "grep-focus",
        name: "Grep",
        input: {
          pattern: "NEEDLE",
          path: "focus.txt",
          output_mode: "content",
          "-C": 3,
        },
      },
    ]);
    const extracted = await tools.extractLocalDocument("local-user", document.id);
    const carried = grep.evidenceSegments?.map((segment) =>
      extracted!.text.slice(segment.start, segment.end),
    );

    expect(grep.content).toContain("focus.txt-1-zero");
    expect(grep.content).toContain("focus.txt-7-six");
    expect(carried).toEqual(["two", "NEEDLE", "four"]);
  });

  it("addresses spreadsheet cells through the same bounded Read contract", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
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
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "ledger.xlsx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const extracted = await tools.extractLocalDocument("local-user", document.id);
    expect(extracted?.tableCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "Ledger",
          address: "B2",
          row: 2,
          column: 2,
        }),
      ]),
    );

    const [read] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "read-xlsx-cell",
        name: "Read",
        input: {
          file_path: document.id,
          section: "table:1/row:2/col:2",
        },
      },
    ]);
    expect(read.content).toContain("Unique spreadsheet value");
    expect(read.content).not.toContain("Matter");
  });

  it("keeps generic Grep output independent of ambiguous legal structure", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
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
    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "duplicate.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const [grep] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "grep-duplicate-handle",
        name: "Grep",
        input: {
          pattern: "UNIQUE NEEDLE",
          path: "duplicate.docx",
          output_mode: "content",
        },
      },
    ]);

    expect(grep.content).toContain("UNIQUE NEEDLE");
    expect(grep.content).not.toMatch(/\[sec1\.01\]/u);
  });

  it("keeps coding replace_all exact-case and no-match versionless", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-all-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph("Term term TERM.")] }],
      }),
    );
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "case.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const editAll = async (oldString: string, newString: string) =>
      (
        await tools.runLocalAssistantTools("local-user", [
          {
            id: `replace-${oldString}`,
            name: "Edit",
            input: {
              file_path: "case.docx",
              old_string: oldString,
              new_string: newString,
              replace_all: true,
            },
          },
        ])
      )[0];

    expect((await editAll("Missing", "Found")).content).toContain(
      "No exact matches",
    );
    expect((await store.listLocalVersions("local-user", document.id))?.versions)
      .toHaveLength(1);
    expect((await editAll("Term", "Clause")).content).toContain(
      "1 replacement(s)",
    );
    expect((await tools.extractLocalDocument("local-user", document.id))?.text)
      .toContain("Clause term TERM.");
  });

  it("recovers duplicate filenames by id and consolidates a coding edit turn", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-turn-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
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
    const tools = await import("../chat/localAssistantTools");
    const [listed, ambiguous, recovered] = await tools.runLocalAssistantTools(
      "local-user",
      [
        { id: "glob-duplicates", name: "Glob", input: { pattern: "shared.docx" } },
        { id: "ambiguous-read", name: "Read", input: { file_path: "shared.docx" } },
        { id: "id-read", name: "Read", input: { file_path: intended.id } },
      ],
    );
    expect(listed.content).toContain(`shared.docx\t[document_id=${intended.id}]`);
    expect(listed.content).toContain(`shared.docx\t[document_id=${other.id}]`);
    expect(ambiguous.content).toContain("File path is ambiguous");
    expect(ambiguous.content).toContain("Glob(pattern=");
    expect(recovered.content).toContain("Alpha Beta.");

    const turnState: import("../chat/localAssistantTools").LocalAssistantEditTurnState =
      new Map();
    const edits = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "edit-alpha",
          name: "Edit",
          input: {
            file_path: intended.id,
            old_string: "Alpha",
            new_string: "Gamma",
          },
        },
        {
          id: "edit-beta",
          name: "Edit",
          input: {
            file_path: intended.id,
            old_string: "Beta",
            new_string: "Delta",
          },
        },
      ],
      { edits: turnState },
    );
    expect(edits.every((edit) => edit.content.startsWith("Updated"))).toBe(true);
    expect((await store.listLocalVersions("local-user", intended.id))?.versions)
      .toHaveLength(2);
    expect((await store.listLocalVersions("local-user", other.id))?.versions)
      .toHaveLength(1);
    expect((await tools.extractLocalDocument("local-user", intended.id))?.text)
      .toContain("Gamma Delta.");
  }, 45_000);

  it("keeps oversized research results as valid JSON with research guidance", async () => {
    process.env.MIKE_TOOL_RESULT_CAP = "1000";
    vi.doMock("../chat/publicLegalSourceState", () => ({
      createPublicLegalSourceState: vi.fn(() => ({})),
      executePublicLegalSourceTool: vi.fn(async (name: string) =>
        name === "public_legal_source_search"
          ? {
              payload: {
                ok: true,
                hits: Array.from({ length: 100 }, (_, index) => ({
                  id: `source-${index}`,
                  excerpt: `research passage ${index} ${"x".repeat(100)}`,
                })),
              },
            }
          : null,
      ),
    }));
    const { runLocalAssistantTools } =
      await import("../chat/localAssistantTools");
    const [response] = await runLocalAssistantTools("local-user", [
      {
        id: "call-research",
        name: "public_legal_source_search",
        input: { query: "research" },
      },
    ]);

    expect(response.content.length).toBeLessThanOrEqual(1000);
    const payload = JSON.parse(response.content);
    expect(payload).toMatchObject({
      ok: true,
      truncated: true,
      original_format: "json",
    });
    expect(payload.omitted_characters).toBeGreaterThan(0);
    expect(payload.preview.head).toContain("source-0");
    expect(payload.continuation).toContain("public_legal_source_search");
    expect(payload.continuation).not.toContain("library_");
  });

  it("reads system workflow instructions in account-free mode", async () => {
    const tools = await import("../chat/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "workflow",
        name: "read_workflow",
        input: { workflow_id: "builtin-extract-key-terms" },
      },
    ]);

    expect(response.content).toContain("# Extract Key Terms");
    expect(response.content).toContain("uploaded documents");
  });

  it("rolls back a generated DOCX when matter attachment fails", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.doMock("../convert", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../convert")>()),
      docxToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 preview")),
    }));
    const graph = (
      await import("../legalKnowledgeGraphStore")
    ).legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      vi.spyOn(graph, "attachMatterDocument").mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
      const tools = await import("../chat/localAssistantTools");

      const [response] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-create",
            name: "generate_docx",
            input: {
              title: "Unattached Draft",
              document_type: "other",
              markdown: "Draft text.",
            },
          },
        ],
        { allowedDocumentIds: new Set(), matterId: matter.id },
      );

      expect(JSON.parse(response.content)).toEqual({
        ok: false,
        error: "Could not attach document to matter",
      });
      expect(
        (
          await (
            await import("../localDocumentStore")
          ).pageLocalDocuments("local-user", ["file"], {
            q: "", limit: 50, after: null,
          })
        ).items,
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("does not expose local paths for a missing evidence receipt", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const tools = await import("../chat/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-evidence",
        name: "library_evidence",
        input: { handle: `mike-evidence:v1:${"a".repeat(64)}` },
      },
    ]);

    expect(JSON.parse(response.content)).toEqual({
      ok: false,
      error: "PDF evidence is unavailable",
    });
    expect(response.content).not.toContain(temporaryDirectory);
    expect(response.content).not.toContain("ENOENT");
  });

  it("submits owned Word and PDF Library versions to the ToA bridge", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const jobId = "a".repeat(32);
    const submit = vi.fn().mockResolvedValue({
      id: jobId,
      state: "running",
      operation: "detection",
      progress: 0,
      message: "Starting detection",
      error: "",
      has_review: false,
      split_fallback: "auto",
      files: [],
      app_url: `/table-of-authorities?job=${jobId}`,
    });
    vi.doMock("../tableOfAuthorities", () => ({
      submitTableOfAuthoritiesDocument: submit,
      getTableOfAuthoritiesJob: vi.fn(),
    }));
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.docx",
      bytes: Buffer.from("owned-docx-bytes"),
    });
    const tools = await import("../chat/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa",
        name: "toa_submit_library_document",
        input: {
          document_id: document.id,
          version_id: document.current_version_id,
          split_fallback: "auto",
        },
      },
    ]);

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({
      filename: "factum.docx",
      splitFallback: "auto",
    });
    expect(submit.mock.calls[0][0].bytes.toString()).toBe("owned-docx-bytes");
    expect(JSON.parse(response.content)).toMatchObject({
      ok: true,
      document_id: document.id,
      version_id: document.current_version_id,
      job: {
        id: jobId,
        app_url: `/table-of-authorities?job=${jobId}`,
      },
    });

    const pdf = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.pdf",
      bytes: Buffer.from("owned-pdf-bytes"),
    });
    const [pdfResponse] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa-pdf",
        name: "toa_submit_library_document",
        input: {
          document_id: pdf.id,
          version_id: pdf.current_version_id,
          split_fallback: "off",
        },
      },
    ]);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toMatchObject({
      filename: "factum.pdf",
      splitFallback: "off",
    });
    expect(submit.mock.calls[1][0].bytes.toString()).toBe("owned-pdf-bytes");
    expect(JSON.parse(pdfResponse.content)).toMatchObject({
      ok: true,
      document_id: pdf.id,
      version_id: pdf.current_version_id,
    });
  });

  it("keeps A2AJ link provenance private while collecting lookup evidence", async () => {
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
    const tools = await import("../chat/localAssistantTools");
    const evidence: import("../a2aj").A2AJLocatorLookup[] = [];

    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: "a2aj_lookup",
          input: {
            citation: "2099 SCC 1",
            locator_type: "paragraph",
            locator: "3",
          },
        },
      ],
      { a2ajLookups: evidence },
    );
    const modelResult = JSON.parse(response.content);

    expect(modelResult.ok).toBe(true);
    expect(modelResult).not.toHaveProperty("url");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].url).toBe("https://example.test/case");
  });
});
