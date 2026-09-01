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

  it("resolves an indexed alias to its exact document version", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-indexed-read-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const original = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "factum.txt", bytes: Buffer.from("Original filing text.") });
    await store.addLocalVersion({ userId: "local-user", documentId: original.id,
      filename: "factum.txt", bytes: Buffer.from("Later filing text.") });
    const resource = resourceReference.document(original.id, original.current_version_id);
    const tools = await import("./support/localAssistantTools");
    const [listed, read] = await tools.runLocalAssistantTools("local-user", [
      { id: "glob-index", name: "Glob", input: { pattern: "doc-1" } },
      { id: "read-index", name: "Read", input: { file_path: resource } },
    ], { docIndex: { "doc-1": { document_id: original.id, filename: "factum.txt",
      version_id: original.current_version_id, version_number: 1 } } });

    expect(listed.content).toContain(`${resource}\talias=doc-1\tfilename=factum.txt`);
    expect(read.content).toContain("Original filing text.");
    expect(read.content).not.toContain("Later filing text.");
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

  it("creates an Authorities draft with a latest Library binding", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.docx",
      bytes: await nativeTableBytes(),
    });
    const importDraft = vi.fn(async () => ({ id: "draft-1", kind: "authorities",
      projectId: null, revision: 1 }));
    const authorities = { importDraft } as never;
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa",
        name: "update_work_product",
        input: {
          action: "create",
          kind: "authorities",
          document_id: `document://${document.id}/version/${document.current_version_id}`,
        },
      },
    ], { authorities });

    const payload = JSON.parse(response.content) as Record<string, string>;
    expect(payload).toMatchObject({
      ok: true,
      work_product: { id: "draft-1", kind: "authorities", revision: 1 },
    });
    expect(payload).not.toHaveProperty("job");
    expect(response.events).toEqual([expect.objectContaining({
      status: "complete",
      tool: "update_work_product",
      work_product: { id: "draft-1", kind: "authorities", revision: 1 },
    })]);
    expect(importDraft).toHaveBeenCalledWith({ userId: "local-user" }, {
      source: { kind: "document", documentId: document.id, version: "latest" },
      projectId: null,
    });
  });

  it("uses the canonical nested action for model-authored research", async () => {
    const { createResearchSetState } = await import("../researchSet");
    const state = createResearchSetState({ kind: "human", id: "local-user" }, "Research");
    const product = { id: "10000000-0000-4000-8000-000000000001",
      kind: "research-set" as const, title: "Research", projectId: null, revision: 1,
      state, outputs: {}, createdAt: "now", updatedAt: "now" };
    const applyResearchSetAction = vi.fn(async () => ({ ...product, revision: 2 }));
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "call-research", name: "update_work_product", input: { action: "update",
        kind: "research-set", research_action: { type: "memo", markdown: "# Finding" } },
    }], { model: "test-model", chatId: "chat-1", researchSetId: product.id,
      researchSetRevision: 1, workProducts: { get: vi.fn(async () => product),
        applyResearchSetAction } as never });

    expect(applyResearchSetAction).toHaveBeenCalledWith(expect.anything(), product.id,
      { revision: 1, action: { type: "memo", markdown: "# Finding" } },
      { kind: "model", id: "test-model", origin: { type: "chat", chatId: "chat-1",
        callId: "call-research" } });
    expect(response.mutated).toBe(true);
  });

  it("attaches an existing Library PDF to an Authorities citation", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const document = await store.createLocalDocument({
      userId: "local-user", kind: "file", filename: "decision.pdf",
      bytes: Buffer.from("%PDF-1.7\n%%EOF"),
    });
    const active = { id: "draft-1", kind: "authorities" as const,
      projectId: null, revision: 3 };
    const attachLibraryPdf = vi.fn(async () => ({ ...active, revision: 4 }));
    const tools = await import("./support/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "attach-authority", name: "update_work_product", input: {
        action: "update", kind: "authorities", draft_id: active.id,
        authority_id: "authority-1",
        document_id: resourceReference.document(document.id, document.current_version_id),
      },
    }], {
      authorities: { attachLibraryPdf } as never,
      workProducts: { get: vi.fn(async () => active) } as never,
    });

    expect(attachLibraryPdf).toHaveBeenCalledWith({ userId: "local-user" }, active.id, {
      revision: 3, authorityId: "authority-1", documentId: document.id,
      versionId: document.current_version_id,
    });
    expect(response.mutated).toBe(true);
    expect(JSON.parse(response.content)).toMatchObject({ ok: true,
      work_product: { id: active.id, kind: "authorities", revision: 4 },
    });
  });

  it("reads Authorities summary-first and returns only requested occurrence detail", async () => {
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const draft = createAuthoritiesDraft({ kind: "manual" });
    const text = "See R v Jordan, 2016 SCC 27 at para 5.";
    draft.units = [{ id: "body:0", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["occurrence-1"] }];
    draft.authorities.jordan = { id: "jordan", key: "jordan", kind: "case",
      citation: "2016 SCC 27", name: "R v Jordan", displayName: null, evidenceIds: [],
      locators: [], sourceIdentity: null, excluded: false, tabLabel: "3",
      source: { kind: "unresolved" } };
    draft.authorityOrder = ["jordan"];
    for (let index = 0; index < 500; index += 1) {
      const id = `case-${index}`;
      draft.authorities[id] = { ...draft.authorities.jordan, id, key: id,
        citation: `${index} ${"x".repeat(800)}`, name: `Case ${index} ${"y".repeat(800)}` };
      draft.authorityOrder.push(id);
    }
    draft.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:0",
      start: 4, end: 37, text: text.slice(4, 37),
      authoritySpan: { start: 4, end: 27, text: text.slice(4, 27) },
      coreSpan: { start: 16, end: 27, text: text.slice(16, 27) },
      pinpointSpan: { start: 31, end: 37, text: text.slice(31, 37) },
      kind: "case", citation: "2016 SCC 27",
      authorityId: "jordan", reference: null, pinpoints: [{ kind: "paragraph", text: "para 5" }],
      evidenceIds: [], sourceTextSha256: "source-hash", localOrdinal: 4, reviewed: false };
    const current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 7, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = vi.fn(async (_scope, _id, revision) => ({ ...current, revision: revision + 1 }));
    const refreshInput = vi.fn(async (_scope, _id, { revision }) =>
      ({ ...current, revision: revision + 1 }));
    const prepareSources = vi.fn(async (_scope, _id, revision) =>
      ({ ...current, revision }));
    const build = vi.fn(async (_scope, _id, revision) => ({
      product: { ...current, revision: revision + 1 }, receipt: {},
    }));
    const tools = await import("./support/localAssistantTools");
    const responses = await tools.runLocalAssistantTools("local-user", [
      { id: "read-authorities", name: "update_work_product",
        input: { action: "read", kind: "authorities" } },
      { id: "read-occurrence", name: "update_work_product", input: { action: "read",
        kind: "authorities", occurrence_id: "occurrence-1" } },
      { id: "edit-authorities", name: "update_work_product", input: { action: "update",
        kind: "authorities", authorities_action: { type: "set-authority-span",
          occurrence_id: "occurrence-1", start: 4, end: 27 } } },
      { id: "refresh-authorities", name: "update_work_product", input: {
        action: "refresh", kind: "authorities", input_role: "source" } },
      { id: "build-authorities", name: "update_work_product",
        input: { action: "build", kind: "authorities" } },
      { id: "wrong-authorities", name: "update_work_product",
        input: { action: "read", kind: "authorities", draft_id: "another-draft" } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act, refreshInput, prepareSources, build } as never,
      workProducts: { get: vi.fn(async () => current), resolve: vi.fn(async () => ({
        product: current, freshness: "unbuilt", inputs: {}, dependencies: [],
      })) } as never });

    const summary = JSON.parse(responses[0].content);
    expect(summary).toMatchObject({ ok: true,
      work_product: { id: current.id, kind: "authorities", revision: 7 },
      draft: { counts: { units: 1, occurrences: 1, authorities: 501 },
        book_parts: { cover: null, index: null, supplements: [] },
        authorities: expect.arrayContaining([
          expect.objectContaining({ id: "jordan", citation: "2016 SCC 27", tab_label: "3" }),
        ]) },
    });
    expect(summary.draft).not.toHaveProperty("units");
    expect(summary.draft).not.toHaveProperty("occurrences");
    expect(responses[0].content.length).toBeLessThan(64_000);
    expect(JSON.parse(responses[1].content)).toMatchObject({ draft: { unit: {
      id: "body:0", text, text_offset: 0 }, occurrence: { id: "occurrence-1",
      authority_span: { start: 4, end: 27 }, pinpoint_span: { start: 31, end: 37 } } } });
    expect(responses[1].content).not.toContain("reviewed");
    expect(act).toHaveBeenCalledWith({ userId: "local-user" }, current.id, 7,
      { type: "set-authority-span", occurrenceId: "occurrence-1", start: 4, end: 27 });
    expect(refreshInput).toHaveBeenCalledWith({ userId: "local-user" }, current.id,
      { revision: 8, role: "source" });
    expect(prepareSources).toHaveBeenCalledWith({ userId: "local-user" }, current.id,
      9, expect.any(AbortSignal));
    expect(build).toHaveBeenCalledWith({ userId: "local-user" }, current.id,
      9, expect.any(AbortSignal));
    expect(responses.at(-2)?.events).toEqual([expect.objectContaining({
      status: "complete", tool: "update_work_product",
      id: `work-product:${current.id}`,
      work_product: { id: current.id, kind: "authorities", revision: 10 },
    })]);
    expect(JSON.parse(responses.at(-1)!.content)).toEqual({ ok: false,
      error: "This assistant is bound to a different Authorities draft" });
  });

  it("routes authority and book-part edits through the existing Authorities reducer seam", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("./support/localDocumentFixtures");
    const pdf = await store.createLocalDocument({ userId: "local-user", kind: "file",
      filename: "appendix.pdf", bytes: Buffer.from("%PDF-1.7\n%%EOF") });
    const { createAuthoritiesDraft } = await import("../authoritiesDomain");
    const draft = createAuthoritiesDraft({ kind: "manual" });
    draft.bindings["book:supplement:s1"] = { kind: "document", documentId: pdf.id,
      version: "latest" };
    draft.bookParts.supplements = [{ id: "s1", bindingRole: "book:supplement:s1",
      filename: "old.pdf", sourceSha256: "a".repeat(64), title: "Old", tab: "A" }];
    const current = { id: "draft-1", kind: "authorities" as const, title: "Authorities",
      projectId: null, revision: 2, state: draft, outputs: {}, createdAt: "now", updatedAt: "now" };
    const act = vi.fn(async (_scope, _id, revision) => ({ ...current, revision: revision + 1 }));
    const tools = await import("./support/localAssistantTools");
    const resource = resourceReference.document(pdf.id, pdf.current_version_id);
    const actions = [
      { type: "add-authority", authority_kind: "case", citation: "2026 SCC 1", name: "R v A" },
      { type: "remove-authority", authority_id: "unused" },
      { type: "clear-book-part", slot: "cover" },
      { type: "update-book-supplement", supplement_id: "s1", title: "Appendix", tab: "B" },
      { type: "reorder-book-supplements", supplement_ids: ["s1"] },
      { type: "remove-book-supplement", supplement_id: "s1" },
    ];
    const responses = await tools.runLocalAssistantTools("local-user", [
      ...actions.map((authorities_action, index) => ({ id: `action-${index}`,
        name: "update_work_product", input: { action: "update", kind: "authorities",
          authorities_action } })),
      { id: "cover", name: "update_work_product", input: { action: "update",
        kind: "authorities", book_slot: "cover", document_id: resource } },
      { id: "supplement", name: "update_work_product", input: { action: "update",
        kind: "authorities", book_slot: "supplement", document_id: resource,
        supplement_title: "Chronology", supplement_tab: "C" } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { act } as never,
      workProducts: { get: vi.fn(async () => current) } as never });

    expect(act.mock.calls.slice(0, 6).map((call) => call[3])).toEqual([
      { type: "add-authority", kind: "case", citation: "2026 SCC 1", name: "R v A" },
      { type: "remove-authority", authorityId: "unused" },
      { type: "clear-book-part", slot: "cover" },
      { type: "update-book-supplement", id: "s1", title: "Appendix", tab: "B" },
      { type: "reorder-book-supplements", ids: ["s1"] },
      { type: "remove-book-supplement", id: "s1" },
    ]);
    expect(act.mock.calls[6][3]).toMatchObject({ type: "set-book-part", slot: "cover",
      pdf: { bindingRole: "book:cover:cover", filename: "appendix.pdf" },
      binding: { kind: "document", documentId: pdf.id, version: "latest" } });
    expect(act.mock.calls[7][3]).toMatchObject({ type: "set-book-supplement",
      supplement: { title: "Chronology", tab: "C", filename: "appendix.pdf" },
      binding: { kind: "document", documentId: pdf.id, version: "latest" } });
    expect(JSON.parse(responses.at(-1)!.content)).toMatchObject({ ok: true,
      change: { type: "attach-book-pdf", book_slot: "supplement",
        supplement_id: expect.any(String) } });
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
    const [review, refreshed] = await tools.runLocalAssistantTools("local-user", [
      { id: "review", name: "update_work_product", input: { action: "review",
        kind: "authorities" } },
      { id: "refresh", name: "update_work_product", input: { action: "refresh",
        kind: "authorities", input_role: "source" } },
    ], { authoritiesId: current.id, authoritiesRevision: current.revision,
      authorities: { discrepancies, refreshInput } as never,
      workProducts: { get: vi.fn(async () => current), resolve } as never });

    expect(JSON.parse(review.content)).toMatchObject({ freshness: "stale", input_issue_count: 2,
      input_issues: [{ role: "source", status: "changed", refreshable: true },
        { role: "missing", status: "missing", refreshable: false }],
      discrepancy_count: 1, discrepancies: [{ occurrence_id: "occ-1",
        cited_locator: { label: "para 9" }, suggested_locator: { label: "para 10" } }] });
    expect(review.content.length).toBeLessThan(64_000);
    expect(review.content).not.toContain("\"proposition\"");
    expect(refreshInput).toHaveBeenCalledWith({ userId: "local-user" }, current.id,
      { revision: 3, role: "source" });
    expect(refreshed.mutated).toBe(true);
  });

  it("lists scoped drafts when unbound and will not replace a bound draft", async () => {
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
    expect(JSON.parse(create.content)).toEqual({ ok: false,
      error: "This assistant is already bound to an Authorities draft" });
    expect(JSON.parse(select.content)).toEqual({ ok: false,
      error: "This assistant is bound to a different Authorities draft" });
  });

  it("creates a Court Record when no work product is active", async () => {
    const created = { id: "record-1", kind: "court-record" as const,
      title: "Motion record", projectId: null, revision: 1,
      state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} },
      outputs: {}, createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z" };
    const create = vi.fn(async () => created);
    const tools = await import("./support/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "create-record", name: "update_work_product", input: {
        action: "create", kind: "court-record",
        profile_id: "fc-motion-record-moving", title: "Motion record",
      },
    }], { workProducts: { create, get: vi.fn() } as never });

    expect(create).toHaveBeenCalledWith({ userId: "local-user", userEmail: undefined }, {
      kind: "court-record", title: "Motion record", projectId: null,
      state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} },
    });
    expect(response.mutated).toBe(true);
    expect(JSON.parse(response.content)).toMatchObject({ ok: true,
      work_product: { id: "record-1", kind: "court-record", revision: 1 },
      requested_action: "open",
      profile: { id: "fc-motion-record-moving",
        slots: expect.arrayContaining([expect.objectContaining({ id: "notice-motion" })]) },
    });
  });

  it("updates a selected Court Record through the same semantic fields as the builder", async () => {
    const current = { id: "record-1", kind: "court-record" as const,
      title: "Motion record", projectId: null, revision: 1,
      state: { profileId: "fc-motion-record-moving", cover: {}, entries: [], bindings: {} },
      outputs: {}, createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z" };
    const updateDraft = vi.fn(async () => ({ product: { ...current, revision: 2,
      state: { ...current.state, cover: { courtFileNumber: "T-123-26" } } },
    filled: ["courtFileNumber"], entryId: undefined }));
    const tools = await import("./support/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [{
      id: "update-record", name: "update_work_product", input: {
        action: "update", kind: "court-record", draft_id: current.id,
        cover: { courtFileNumber: "T-123-26" },
      },
    }], { workProducts: { create: vi.fn(), get: vi.fn(async () => current) } as never,
      courtRecords: { updateDraft, bindOutput: vi.fn() } as never });

    expect(updateDraft).toHaveBeenCalledWith({ userId: "local-user", userEmail: undefined }, {
      courtRecordId: current.id, revision: 1, projectId: null,
      cover: { courtFileNumber: "T-123-26" },
    });
    expect(response.mutated).toBe(true);
    expect(JSON.parse(response.content)).toMatchObject({ ok: true,
      work_product: { id: current.id, kind: "court-record", revision: 2 },
      filled_fields: ["courtFileNumber"],
    });
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

    expect(importDraft).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local-user",
    }), {
      source: { kind: "receipts", seeds: [{
        authorityKey: "2016scc27",
        receipts,
      }] },
      projectId: "project-1", title: undefined,
    });
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
      input: { action: "update", kind: "authorities",
        evidence_ids: receipts.map(({ evidence_id }) => evidence_id) },
    }], {
      legalEvidence: state, authorities, documents: { read } as never,
      authoritiesId: "active-draft", authoritiesRevision: 3,
      workProducts: { get: vi.fn(async () => active) } as never,
    });
    expect(addReceipts).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local-user",
    }), "active-draft", 3, [{ authorityKey: "2016scc27", receipts }]);
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
