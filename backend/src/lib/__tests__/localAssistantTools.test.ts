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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipDocumentBytes } from "./support/documentBytes";
import { resourceReference } from "../resourceReferences";
import { globPattern } from "../chat/resourceTools";

vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

let temporaryDirectory: string | null = null;

beforeEach(() => { process.env.AUTH_MODE = "local"; });

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
  tools: typeof import("./support/localAssistantTools"),
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
    await (await import("../relationalDatabase")).closeRelationalDatabase();
  } catch {}
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.AUTH_MODE;
  vi.doUnmock("../tableOfAuthorities");
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
      { localDocuments, localLibraryStore, localProjects },
    ] =
      await Promise.all([
        import("../chat/chatToolRunner"),
        import("../chat/legalEvidence"),
        import("./support/localDocumentFixtures"),
      ]);
    const committed = vi.fn();
    const chat = createChatToolRunner({
      userId: "local-user",
      documents: localDocuments,
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
    vi.doMock("../draftingStyleStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../draftingStyleStore")>()),
      getDraftingStyleSettings: vi.fn(async () => (
        await import("../draftingStyle")
      ).DEFAULT_DRAFTING_STYLE),
    }));
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
      action: "created",
      filename: "Requested memo.docx",
    });
    expect(created).toMatchObject({
      mutated: true,
      events: [{ type: "document_artifact", action: "created", filename: "Requested memo.docx" }],
    });
    expect(created.terminal).toBeUndefined();
    expect([workbook, presentation].map(({ content }) =>
      JSON.parse(content).file_type)).toEqual(["xlsx", "pptx"]);
  }, 10_000);

  it("rejects unmarked evidence copying before Write persists a DOCX", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-grounded-write-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.doMock("../draftingStyleStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../draftingStyleStore")>()),
      getDraftingStyleSettings: vi.fn(async () => (
        await import("../draftingStyle")
      ).DEFAULT_DRAFTING_STYLE),
    }));
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
        citations: [{ id: "standing", evidence_ids: [evidence.evidence_id] }],
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

    const payload = JSON.parse(response.content);
    expect(payload).toMatchObject({
      ok: true,
      action: "revised",
      document_id: document.id,
      version_number: 2,
    });
    expect(response).toMatchObject({
      mutated: true,
      events: [{ type: "document_artifact", action: "edited", document_id: document.id }],
    });
    expect(payload.annotations[0]).not.toHaveProperty("reason");
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

    expect(new Set(grep.evidenceSegments?.map((item) => item.documentId))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(firstRead.evidenceSegments?.[0]).toMatchObject({
      documentId: first.id,
      versionId: first.current_version_id,
    });
    expect(secondRead.evidenceSegments?.[0]).toMatchObject({
      documentId: second.id,
      versionId: second.current_version_id,
    });
  });

  it("keeps broad Grep display context out of the drafting handoff", async () => {
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
    const carried = grep.evidenceSegments?.map((segment) =>
      text.slice(segment.start, segment.end),
    );

    const resource =
      `document://${document.id}/version/${document.current_version_id}`;
    expect(grep.content).toContain(`${resource}-1-zero`);
    expect(grep.content).toContain(`${resource}-7-six`);
    expect(carried).toEqual(["two", "NEEDLE", "four"]);
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
    const revised = JSON.parse((await editAll("Term", "Clause")).content);
    expect(revised).toMatchObject({
      ok: true,
      action: "revised",
      change_count: 1,
    });
    const [read] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-revised",
      name: "Read",
      input: { file_path: revised.resource },
    }]);
    expect(read.content).toContain("Clause term TERM.");
  });

  it("lists duplicate filenames and edits by canonical resource", async () => {
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

    const turnState = new Map<
      string,
      { versionId: string; parentVersionId: string }
    >();
    const edits = [
      ...(await tools.runLocalAssistantTools(
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
        { edits: turnState },
      )),
      ...(await tools.runLocalAssistantTools(
        "local-user",
        [{
          id: "edit-beta",
          name: "Edit",
          input: {
            file_path: intendedResource,
            old_string: "Beta",
            new_string: "Delta",
          },
        }],
        { edits: turnState },
      )),
    ];
    expect(edits.every((edit) =>
      JSON.parse(edit.content).action === "revised")).toBe(true);
    expect((await store.listLocalVersions("local-user", intended.id))?.versions)
      .toHaveLength(2);
    expect((await store.listLocalVersions("local-user", other.id))?.versions)
      .toHaveLength(1);
    const revised = JSON.parse(edits.at(-1)!.content);
    const [read] = await tools.runLocalAssistantTools("local-user", [{
      id: "read-edited-duplicate",
      name: "Read",
      input: { file_path: revised.resource },
    }]);
    expect(read.content).toContain("Gamma Delta.");
  }, 45_000);

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
    const listed = (await registry.run([glob], {})).results[0];
    expect(registry.activity(readCall)).toBe("Reading library-opinion.txt");
    const read = (await registry.run([readCall], {})).results[0];

    expect(listed.content).toContain(`${resource}\tfilename=library-opinion.txt`);
    expect(read.content).toContain("Library evidence survives an empty chat focus.");
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
    const store = await import("./support/localDocumentFixtures");
    const ownedBytes = await zipDocumentBytes("owned-docx-bytes");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.docx",
      bytes: ownedBytes,
    });
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa",
        name: "document_operation",
        input: {
          action: "table_of_authorities",
          document_id: `document://${document.id}/version/${document.current_version_id}`,
          split_fallback: "auto",
        },
      },
    ]);

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({
      filename: "factum.docx",
      splitFallback: "auto",
    });
    expect(submit.mock.calls[0][0].bytes).toEqual(ownedBytes);
    expect(JSON.parse(response.content)).toMatchObject({
      ok: true,
      document_id: document.id,
      version_id: document.current_version_id,
      job: {
        id: jobId,
      },
    });

    const pdf = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.pdf",
      bytes: await readFile(path.resolve(process.cwd(), "../e2e/fixtures/test.pdf")),
    });
    const [pdfResponse] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa-pdf",
        name: "document_operation",
        input: {
          action: "table_of_authorities",
          document_id: `document://${pdf.id}/version/${pdf.current_version_id}`,
          split_fallback: "off",
        },
      },
    ]);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toMatchObject({
      filename: "factum.pdf",
      splitFallback: "off",
    });
    expect(submit.mock.calls[1][0].bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(JSON.parse(pdfResponse.content)).toMatchObject({
      ok: true,
      document_id: pdf.id,
      version_id: pdf.current_version_id,
    });
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

  it("does not mint document-wide evidence for an unlocated A2AJ Read", async () => {
    const text = [
      "[1] First native decision paragraph with enough text to be addressable.",
      "[2] Second native decision paragraph with enough text to be addressable.",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            dataset: "SCC",
            citation_en: "2099 SCC 2",
            source_url_en: "https://example.test/case-2",
            unofficial_text_en: text,
          }],
        }),
      }),
    );
    const tools = await import("./support/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "call-document",
      name: "Read",
      input: {
        file_path: resourceReference.source(
          "a2aj",
          JSON.stringify(["2099 SCC 2", "cases", "SCC"]),
        ),
      },
    }]);
    const payload = JSON.parse(response.content);
    expect(payload.ok).toBe(true);
    expect(payload.evidence_ids).toEqual([]);
    expect(payload.passages[0]).not.toHaveProperty("evidence_id");
    expect(payload.next_required_action).toContain("native locator");
  });
});
