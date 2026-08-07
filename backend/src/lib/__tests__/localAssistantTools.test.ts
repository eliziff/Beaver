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
  vi.doUnmock("node:fs/promises");
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {
  it("keeps demand-paged Grep hits compact and leaves exact Read recipes", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
    process.env.MIKE_CONTEXT_HANDOFF = "1";
    process.env.MIKE_DRAFT_HANDOFF_MODE = "paged";
    process.env.MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS = "24000";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-paged-grep-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const tools = await import("../chat/localAssistantTools");
    const workingSetPath = ".mike/working-sets/evidence.txt";
    const lines = Array.from(
      { length: 40 },
      (_, index) =>
        `${index + 1} ${"prefix ".repeat(140)}NEEDLE ${"suffix ".repeat(140)}`,
    );
    const text = lines.join("\n");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map([
        [
          workingSetPath,
          {
            path: workingSetPath,
            text,
            sourceChars: text.length,
            matchedSourceChars: text.length,
            immutableSourceChars: text.length,
            mapChars: 0,
            budgetChars: 0,
            mappedVersions: [],
            segments: [],
            refs: [],
            demandPaged: true,
            readGrants: new Set(),
          },
        ],
      ]);
    const [defaultPage, requestedLargePage] =
      await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "default-page",
            name: "Grep",
            input: {
              pattern: "NEEDLE",
              path: workingSetPath,
              output_mode: "content",
            },
          },
          {
            id: "requested-large-page",
            name: "Grep",
            input: {
              pattern: "NEEDLE",
              path: workingSetPath,
              output_mode: "content",
              head_limit: 2_000,
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        state,
      );

    const recipeCount = (content: string) =>
      content.match(/\[exact Read recipe:/gu)?.length ?? 0;
    expect(tools.WORKING_SET_PAGE_MAX_CHARS).toBe(24_000);
    expect(recipeCount(defaultPage.content)).toBe(
      tools.WORKING_SET_GREP_DEFAULT_HEAD_LIMIT,
    );
    expect(recipeCount(requestedLargePage.content)).toBe(
      tools.WORKING_SET_GREP_MAX_HEAD_LIMIT,
    );
    expect(defaultPage.content).toContain("Results truncated");
    expect(defaultPage.content.length).toBeLessThan(10_000);
    expect(requestedLargePage.content.length).toBeLessThanOrEqual(24_000);
    expect(defaultPage.content).toContain("NEEDLE");
  });

  it("runs the pinned upstream whole-document comparator and suppresses duplicate reads", async () => {
    process.env.MIKE_TOOL_SHAPE = "upstream-mike";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-upstream-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "agreement.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [
            { children: [new Paragraph("The borrower shall deliver reports.")] },
          ],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const names = tools.LOCAL_ASSISTANT_TOOLS.map(
      (entry) => entry.function.name,
    );
    expect(names).toEqual([
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "generate_docx",
    ]);
    const upstream = await import("../chat/upstreamMikeBenchmarkSurface");
    expect(
      createHash("sha256")
        .update(JSON.stringify(tools.LOCAL_ASSISTANT_TOOLS.slice(0, 4)))
        .digest("hex"),
    ).toBe(upstream.UPSTREAM_MIKE_SCHEMA_SHA256);
    expect(upstream.UPSTREAM_MIKE_LAB_SYSTEM_PROMPT).not.toMatch(
      /Beaver|library_|describe_tools|mike-evidence|\bGlob\b|\bGrep\b|progressive disclosure/u,
    );

    const [listed] = await tools.runLocalAssistantTools(
      "local-user",
      [{ id: "list", name: "list_documents", input: {} }],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
    );
    expect(JSON.parse(listed.content)).toEqual([
      {
        doc_id: "doc-0",
        filename: "agreement.docx",
        file_type: "docx",
      },
    ]);

    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const invoke = () =>
      tools.runLocalAssistantTools(
        "local-user",
        [{ id: "read", name: "read_document", input: { doc_id: "doc-0" } }],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set([document.id]),
        undefined,
        undefined,
        undefined,
        undefined,
        readState,
      );
    const [first] = await invoke();
    const [second] = await invoke();
    expect(first.content).toContain("borrower shall deliver reports");
    expect(first.evidenceSegments).toEqual([
      expect.objectContaining({
        documentId: document.id,
        start: 0,
        end: expect.any(Number),
        kind: "evidence",
      }),
    ]);
    expect(JSON.parse(second.content)).toMatchObject({
      ok: true,
      already_read: true,
      doc_id: "doc-0",
      document_id: document.id,
    });
    expect(second.evidenceSegments).toEqual([]);
  });

  it("keeps adaptive Mike whole reads simple while bounded reads remain repeatable", async () => {
    process.env.MIKE_TOOL_SHAPE = "adaptive-mike-v1";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    process.env.MIKE_TERMINAL_AUTHORING = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-adaptive-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "credit-agreement.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph("ARTICLE I"),
                new Paragraph("Section 1.01 Reports."),
                new Paragraph(`The borrower shall deliver ${"monthly reports ".repeat(40)}promptly.`),
                new Paragraph("Section 1.02 Notices."),
                new Paragraph("Every notice must be in writing."),
              ],
            },
          ],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    expect(
      tools.LOCAL_ASSISTANT_TOOLS.map((entry) => entry.function.name),
    ).toEqual([
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "generate_docx",
    ]);
    const readSchema = tools.LOCAL_ASSISTANT_TOOLS[0].function.parameters as {
      properties: Record<string, unknown>;
    };
    expect(readSchema.properties).toEqual(
      expect.objectContaining({
        section: expect.any(Object),
        pages: expect.any(Object),
        offset: expect.any(Object),
        max_chars: expect.any(Object),
      }),
    );

    const invoke = (
      input: Record<string, unknown>,
      state: import("../chat/localAssistantTools").LocalAssistantReadTurnState,
    ) =>
      tools.runLocalAssistantTools(
        "local-user",
        [{ id: `call-${Math.random()}`, name: "read_document", input }],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set([document.id]),
        undefined,
        undefined,
        undefined,
        undefined,
        state,
      );

    const [listed] = await tools.runLocalAssistantTools(
      "local-user",
      [{ id: "list", name: "list_documents", input: {} }],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
    );
    const inventory = JSON.parse(listed.content);
    expect(inventory.documents[0]).toEqual(
      expect.objectContaining({
        doc_id: "doc-0",
        filename: "credit-agreement.docx",
        characters: expect.any(Number),
        lines: expect.any(Number),
        pages: 0,
      }),
    );
    expect(inventory.totals.characters).toBe(
      inventory.documents[0].characters,
    );

    const fullState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const [whole] = await invoke({ doc_id: "doc-0" }, fullState);
    const [duplicateWhole] = await invoke({ doc_id: "doc-0" }, fullState);
    expect(whole.content).toContain("borrower shall deliver");
    expect(JSON.parse(duplicateWhole.content).already_read).toBe(true);

    const boundedInput = {
      doc_id: "doc-0",
      section: "Section 1.01",
      max_chars: 160,
    };
    const [boundedAfterWhole] = await invoke(boundedInput, fullState);
    const [boundedAgain] = await invoke(boundedInput, fullState);
    for (const bounded of [boundedAfterWhole, boundedAgain]) {
      const payload = JSON.parse(bounded.content);
      expect(payload.ok).toBe(true);
      expect(payload.text).toContain("monthly reports");
      expect(payload.returned_characters).toBeLessThanOrEqual(160);
      expect(payload.next_read).toEqual(
        expect.objectContaining({
          doc_id: "doc-0",
          section: "Section 1.01",
          offset: expect.any(Number),
        }),
      );
      expect(bounded.evidenceSegments).toHaveLength(1);
    }

    const boundedOnlyState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    await invoke({ doc_id: "doc-0", offset: 10, max_chars: 80 }, boundedOnlyState);
    const [wholeAfterBounded] = await invoke({ doc_id: "doc-0" }, boundedOnlyState);
    expect(wholeAfterBounded.content).toContain("Section 1.02 Notices");
    expect(() => JSON.parse(wholeAfterBounded.content)).toThrow();

    const [found] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "find",
          name: "find_in_document",
          input: { doc_id: "doc-0", query: "in writing" },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
    );
    expect(JSON.parse(found.content).hits[0]).toEqual(
      expect.objectContaining({
        locator: expect.stringMatching(/^chars /u),
        read: expect.objectContaining({
          doc_id: "doc-0",
          offset: expect.any(Number),
          max_chars: expect.any(Number),
        }),
      }),
    );
  });

  it("runs cross-document Grep and bounded Read on Mike doc labels", async () => {
    process.env.MIKE_TOOL_SHAPE = "mike-legal-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    process.env.MIKE_TERMINAL_AUTHORING = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-grep-"));
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
    const first = await makeDoc("Alpha NEEDLE obligation.");
    const second = await makeDoc("Beta NEEDLE covenant.");
    const allowed = new Set([first.id, second.id]);
    const tools = await import("../chat/localAssistantTools");
    const [inventory, grep, read] = await tools.runLocalAssistantTools(
      "local-user",
      [
        { id: "inventory", name: "list_documents", input: {} },
        {
          id: "grep",
          name: "Grep",
          input: { pattern: "NEEDLE", output_mode: "content" },
        },
        {
          id: "read",
          name: "Read",
          input: { file_path: "doc-1", offset: 1, limit: 2 },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      allowed,
    );
    expect(JSON.parse(inventory.content).documents).toEqual([
      expect.objectContaining({ doc_id: "doc-0", filename: "shared.docx" }),
      expect.objectContaining({ doc_id: "doc-1", filename: "shared.docx" }),
    ]);
    expect(grep.content).toContain("doc-0:");
    expect(grep.content).toContain("doc-1:");
    expect(grep.content).toContain('Read file_path="doc-1"');
    expect(read.content).toContain("Beta NEEDLE covenant");
    expect(read.evidenceSegments).toEqual([
      expect.objectContaining({ documentId: second.id, kind: "evidence" }),
    ]);
    const [found] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "find",
          name: "find_in_document",
          input: { doc_id: "doc-1", query: "covenant" },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      allowed,
    );
    expect(JSON.parse(found.content).hits[0].read).toEqual(
      expect.objectContaining({
        file_path: "doc-1",
        offset: expect.any(Number),
        limit: expect.any(Number),
      }),
    );
    const [missing] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "missing",
          name: "Grep",
          input: { pattern: "NEEDLE", path: "missing.docx" },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      allowed,
    );
    expect(missing.status).toBe("not_found");
    expect(JSON.parse(missing.content)).toMatchObject({ ok: false });

    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const [whole, duplicateBatch] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "whole",
          name: "read_document",
          input: { doc_id: "doc-0" },
        },
        {
          id: "duplicate-batch",
          name: "fetch_documents",
          input: { doc_ids: ["doc-0"] },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      allowed,
      undefined,
      undefined,
      undefined,
      undefined,
      readState,
    );
    expect(whole.evidenceSegments).toHaveLength(1);
    expect(duplicateBatch.evidenceSegments).toEqual([]);
    expect(duplicateBatch.content).toContain('"already_read":true');
  });

  it("batch-reads lean sources, preserves repeat reads, and authors Markdown", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "lean-batch-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS = "0";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    process.env.MIKE_TERMINAL_AUTHORING = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "lean-batch-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const makeDoc = async (filename: string, text: string) =>
      store.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename,
        bytes: await Packer.toBuffer(
          new Document({ sections: [{ children: [new Paragraph(text)] }] }),
        ),
      });
    const first = await makeDoc("first.docx", "Alpha source text.");
    const second = await makeDoc("second.docx", "Beta source text.");
    const allowed = new Set([first.id, second.id]);
    const tools = await import("../chat/localAssistantTools");
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const run = (calls: Array<{ id: string; name: string; input: any }>) =>
      tools.runLocalAssistantTools(
        "local-user",
        calls,
        undefined,
        undefined,
        undefined,
        undefined,
        allowed,
        undefined,
        undefined,
        undefined,
        undefined,
        readState,
      );

    const [inventory] = await run([
      { id: "inventory", name: "list_documents", input: {} },
    ]);
    const listed = JSON.parse(inventory.content);
    expect(listed.documents).toEqual([
      expect.objectContaining({
        filename: "first.docx",
        opening_line: "Alpha source text.",
      }),
      expect.objectContaining({
        filename: "second.docx",
        opening_line: "Beta source text.",
      }),
    ]);
    expect(inventory.evidenceSegments).toHaveLength(2);

    const invokeWhole = (id: string) =>
      run([
        {
          id,
          name: "Read",
          input: { paths: ["first.docx", "second.docx"] },
        },
      ]);
    const [whole] = await invokeWhole("whole");
    const [repeated] = await invokeWhole("repeated");
    for (const read of [whole, repeated]) {
      expect(read.content).toContain("Alpha source text.");
      expect(read.content).toContain("Beta source text.");
      expect(read.content).not.toContain("Citation requirement");
      expect(read.evidenceSegments).toHaveLength(2);
    }

    const [bounded, invalid] = await run([
      {
        id: "bounded",
        name: "Read",
        input: { paths: ["second.docx"], offset: 1, limit: 2 },
      },
      {
        id: "invalid",
        name: "Read",
        input: {
          paths: ["first.docx", "second.docx"],
          offset: 1,
          limit: 2,
        },
      },
    ]);
    expect(bounded.content).toContain("Beta source text.");
    expect(bounded.evidenceSegments).toHaveLength(1);
    expect(JSON.parse(invalid.content)).toMatchObject({ ok: false });

    const [authored] = await run([
      {
        id: "author",
        name: "generate_docx",
        input: { title: "Lean result", markdown: "# Finding\n\nComplete." },
      },
    ]);
    expect(JSON.parse(authored.mutationReceipt!)).toMatchObject({
      ok: true,
      action: "created",
      filename: "Lean result.docx",
    });
  });

  it("batch-fetches complete documents by filename in coding shape", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-bulk-read-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "source-form.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("Complete source text.")] }],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const [fetched] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "fetch",
          name: "fetch_documents",
          input: { doc_ids: ["source-form.docx"] },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
    );

    expect(fetched.content).toContain("Complete source text.");
    expect(fetched.evidenceSegments).toEqual([
      expect.objectContaining({
        documentId: document.id,
        start: 0,
        end: expect.any(Number),
        kind: "evidence",
      }),
    ]);
  });

  it("returns a repeated whole read when duplicate suppression is disabled", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    process.env.MIKE_WHOLE_READ_MAX_CHARS = "90";
    process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS = "0";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-repeat-read-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const source = "R".repeat(40);
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "repeat.docx",
      bytes: await Packer.toBuffer(
        new Document({ sections: [{ children: [new Paragraph(source)] }] }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const invoke = (id: string) =>
      tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id,
            name: "fetch_documents",
            input: { doc_ids: ["repeat.docx"] },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set([document.id]),
        undefined,
        undefined,
        undefined,
        undefined,
        readState,
      );

    const [first] = await invoke("repeat-1");
    const [second] = await invoke("repeat-2");
    const [third] = await invoke("repeat-3");

    expect(tools.SUPPRESS_DUPLICATE_WHOLE_READS).toBe(false);
    expect(first.content).toContain(source);
    expect(second.content).toContain(source);
    expect(second.content).not.toContain("already_read");
    expect(JSON.parse(third.content)).toMatchObject({
      ok: false,
      status: "selection_required",
      already_read_chars: 80,
      requested_chars: 40,
      projected_chars: 120,
      max_chars: 90,
    });
  });

  it("refuses an over-budget batch without exposing partial source text", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    process.env.MIKE_WHOLE_READ_MAX_CHARS = "10";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-bulk-cap-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "large-source.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("This source exceeds ten characters.")] }],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const [fetched] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "fetch-over-cap",
          name: "fetch_documents",
          input: { doc_ids: ["large-source.docx"] },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
    );

    expect(JSON.parse(fetched.content)).toMatchObject({
      ok: false,
      code: "WHOLE_READ_OVER_CONTEXT_BUDGET",
      requested_files: 1,
      new_files: 1,
      max_chars: 10,
    });
    expect(fetched.content).not.toContain("This source exceeds");
    expect(fetched.evidenceSegments).toBeUndefined();
    expect(fetched.status).toBe("selection_required");
  });

  it("cannot bypass the whole-read budget with parallel smaller batches", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_MODEL_COVERAGE_ROUTING = "1";
    process.env.MIKE_WHOLE_READ_MAX_CHARS = "60";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-bulk-union-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const first = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "first.docx",
      bytes: await Packer.toBuffer(
        new Document({ sections: [{ children: [new Paragraph("A".repeat(40))] }] }),
      ),
    });
    const second = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "second.docx",
      bytes: await Packer.toBuffer(
        new Document({ sections: [{ children: [new Paragraph("B".repeat(40))] }] }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const [firstResult, secondResult] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "fetch-first",
          name: "fetch_documents",
          input: { doc_ids: ["first.docx"] },
        },
        {
          id: "fetch-second",
          name: "fetch_documents",
          input: { doc_ids: ["second.docx"] },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([first.id, second.id]),
      undefined,
      undefined,
      undefined,
      undefined,
      readState,
    );

    expect(firstResult.content).toContain("A".repeat(40));
    expect(JSON.parse(secondResult.content)).toMatchObject({
      ok: false,
      status: "selection_required",
      already_read_chars: 40,
      requested_chars: 40,
      projected_chars: 80,
      max_chars: 60,
    });
    expect(secondResult.content).not.toContain("B".repeat(40));
    expect(secondResult.status).toBe("selection_required");
  });

  it("uses only Edit in coding shape and retains its durable receipt", async () => {
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
    const { LOCAL_ASSISTANT_TOOLS, runLocalAssistantTools } =
      await import("../chat/localAssistantTools");
    const names = LOCAL_ASSISTANT_TOOLS.map((entry) => entry.function.name);

    expect(names).toContain("Edit");
    expect(names).not.toContain("library_revise_docx");

    const [edited] = await runLocalAssistantTools("local-user", [
      {
        id: "coding-edit",
        name: "Edit",
        input: {
          file_path: "draft.docx",
          old_string: "Original",
          new_string: "Revised",
        },
      },
    ]);
    expect(edited.content).toBe(
      "Updated draft.docx: 1 tracked change applied.",
    );
    expect(JSON.parse(edited.mutationReceipt ?? "null")).toMatchObject({
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: document.id,
      version_number: 2,
    });
  });

  it("routes draft.md Edit to the in-memory draft and renders the edited buffer", async () => {
    // Regression guard for the gen-7 draft-edit shadowing: the CODING_TOOL_SHAPE
    // dispatch used to route EVERY Edit to runCodingShapeCall, whose FS resolver
    // answered draft.md (an in-memory buffer, never on disk) with "File does
    // not exist: draft.md", while the in-memory DRAFT_EDIT handler sat dead
    // code behind the dispatch's early return. Real-path edits (test above)
    // stay on the FS text-ops surface; draft.md must fall through to the
    // in-memory handler.
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "lean-batch-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
    process.env.MIKE_DISABLE_ASK_INPUTS = "1";
    process.env.MIKE_DRAFT_EDIT = "1";
    process.env.MIKE_EXPOSURE_ECHO = "1";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-draft-edit-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const tools = await import("../chat/localAssistantTools");
    const state = tools.createLocalAssistantRequirementsState();
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const run = (calls: Array<{ id: string; name: string; input: any }>) =>
      tools.runLocalAssistantTools(
        "local-user",
        calls,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        readState,
        undefined,
        undefined,
        state,
      );

    // 1. First bodied generate_docx pauses: the draft is captured and the
    //    refine_check refusal names draft.md.
    const [refusal] = await run([
      {
        id: "draft",
        name: "generate_docx",
        input: {
          title: "Term sheet",
          markdown: "# Terms\n\nDeposit is $10,000.",
        },
      },
    ]);
    expect(refusal.content).toContain("draft.md");
    expect(state.draftMarkdown).toContain("$10,000");

    // 2. Edit(draft.md) mutates the in-memory buffer (pre-fix: "File does not
    //    exist: draft.md" on every call).
    const [edited] = await run([
      {
        id: "edit",
        name: "Edit",
        input: {
          file_path: "draft.md",
          old_string: "$10,000",
          new_string: "$25,000",
        },
      },
    ]);
    expect(JSON.parse(edited.content)).toMatchObject({
      ok: true,
      replacements: 1,
    });
    expect(state.draftMarkdown).toContain("$25,000");
    expect(state.draftMarkdown).not.toContain("$10,000");

    // 3. generate_docx without markdown renders the edited buffer.
    const [rendered] = await run([
      { id: "render", name: "generate_docx", input: { title: "Term sheet" } },
    ]);
    expect(JSON.parse(rendered.mutationReceipt!)).toMatchObject({
      ok: true,
      action: "created",
      filename: "Term sheet.docx",
    });
  });

  it("resolves coding specialist document references from filenames", async () => {
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
          id: "coding-specialist-edit",
          name: "library_apply_text_ops",
          input: {
            document_id: "draft.docx",
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
      undefined,
      undefined,
      undefined,
      undefined,
      new Set([document.id]),
    );

    expect(JSON.parse(response.content)).toMatchObject({
      ok: true,
      action: "revised",
      document_id: document.id,
      version_number: 2,
    });
  });

  it("gives coding mode the same progressive drafting gate and familiar globs", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph("Draft.")] }] }),
    );
    await (await import("../localDocumentStore")).createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "draft.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    const resident = partition.resident.map((entry) => entry.function.name);
    const drafting = tools
      .toolsForDomains(partition.deferred, ["drafting"])
      .map((entry) => entry.function.name);

    expect(resident).toContain("Glob");
    expect(resident).not.toContain("library_list");
    expect(resident).not.toContain("Edit");
    expect(drafting).toEqual(
      expect.arrayContaining(["Edit", "library_delete_and_renumber_docx"]),
    );
    const [revealed, star, recursive] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "reveal-drafting",
          name: "describe_tools",
          input: { domains: ["drafting"] },
        },
        { id: "glob-star", name: "Glob", input: { pattern: "*.docx" } },
        {
          id: "glob-recursive",
          name: "Glob",
          input: { pattern: "**/*.docx" },
        },
      ],
    );
    expect(JSON.parse(revealed.content).opened).toEqual(
      expect.arrayContaining(["Edit", "library_delete_and_renumber_docx"]),
    );
    for (const inventory of [star.content, recursive.content]) {
      expect(inventory).toMatch(/^draft\.docx\tchars=\d+\tlines=\d+$/mu);
      expect(inventory).toMatch(/^TOTAL\tfiles=1\tchars=\d+\tlines=\d+$/mu);
    }
  });

  it("keeps coding search and section pagination evidence-complete", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-code-read-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const longLine = `${"x".repeat(2_400)}NEEDLE${"y".repeat(100)}`;
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              "Preamble.",
              "1.01 Scope.",
              "first",
              "second",
              "third",
              longLine,
              "fourth",
              "2.01 End.",
            ].map((text) => new Paragraph(text)),
          },
        ],
      }),
    );
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "long.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const [grep, inlineCaseGrep, read, providerDefaultRead, providerMinimumRead] =
      await tools.runLocalAssistantTools("local-user", [
      {
        id: "grep-long-line",
        name: "Grep",
        input: {
          pattern: "NEEDLE",
          path: "long.docx",
          output_mode: "content",
        },
      },
      {
        id: "grep-inline-case",
        name: "Grep",
        input: {
          pattern: "(?i)needle",
          path: "long.docx",
          output_mode: "content",
          "-i": false,
          head_limit: 0,
        },
      },
      {
        id: "read-section-page",
        name: "Read",
        input: { file_path: "long.docx", section: "1.01", offset: 4, limit: 2 },
      },
      {
        id: "read-section-provider-defaults",
        name: "Read",
        input: { file_path: "long.docx", section: "1.01", offset: 0, limit: 0 },
      },
      {
        id: "read-section-provider-minimum",
        name: "Read",
        input: {
          file_path: "long.docx",
          section: "1.01",
          offset: 1,
          limit: 1,
          start_char: 0,
        },
      },
    ]);
    const extracted = await tools.extractLocalDocument("local-user", document.id);

    expect(grep.content).toContain("NEEDLE");
    expect(grep.content).toMatch(/^long\.docx:6:\u2026/u);
    expect(grep.evidenceSpans?.some(([start, end]) =>
      extracted!.text.slice(start, end).includes("NEEDLE"),
    )).toBe(true);
    expect(grep.evidenceSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: document.id,
          versionId: document.current_version_id,
        }),
      ]),
    );
    expect(inlineCaseGrep.content).toContain("NEEDLE");
    expect(read.content).toMatch(/^\s*4\tsecond\n\s*5\tthird/mu);
    expect(read.content).not.toContain("\tfirst");
    expect(read.evidenceSpans).toHaveLength(2);
    expect(
      new Set(read.evidenceSegments?.map((segment) => segment.documentId)),
    ).toEqual(new Set([document.id]));
    expect(providerDefaultRead.content).toContain("\tfirst");
    expect(providerDefaultRead.content).toContain("\tfourth");
    expect(providerDefaultRead.content).toContain(`NEEDLE${"y".repeat(100)}`);
    expect(providerDefaultRead.content).not.toContain("line truncated");
    expect(providerDefaultRead.content).not.toContain("offset 1 is outside");
    expect(providerMinimumRead.content).toMatch(/^\s*2\t1\.01 Scope\./mu);
    expect(providerMinimumRead.content).toContain("\tfirst");
    expect(providerMinimumRead.content).toContain("\tfourth");
    expect(providerMinimumRead.content).toContain(`NEEDLE${"y".repeat(100)}`);
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

  it("reads a native DOCX table row and cell in coding mode", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-code-cell-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await nativeTableBytes();
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "cells.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const run = async (name: string, input: Record<string, unknown>) =>
      (
        await tools.runLocalAssistantTools("local-user", [
          { id: `coding-cell-${name}`, name, input },
        ])
      )[0];

    const grep = await run("Grep", {
      pattern: "Unique cell value",
      path: "cells.docx",
      output_mode: "content",
    });
    expect(grep.content).toContain("[table:1/row:1]");
    expect(grep.evidenceSpans).toHaveLength(1);
    const read = await run("Read", {
      file_path: "cells.docx",
      offset: 0,
      limit: 0,
      section: "table:1/row:1/col:2",
    });
    expect(read.content).toContain("Unique cell value");
    expect(read.evidenceSegments?.[0]).toMatchObject({
      locator: "table:1/row:1/col:2",
      projection: "canonical",
    });

    const rowRead = await run("Read", {
      file_path: "cells.docx",
      offset: 1,
      limit: 10,
      section: "table:1/row:4",
    });
    const extracted = await tools.extractLocalDocument(
      "local-user",
      document.id,
    );
    expect(
      rowRead.evidenceSpans
        ?.map(([start, end]) => extracted!.text.slice(start, end))
        .filter(Boolean),
    ).toEqual(["Treasurer", "$25,000", "$100,000"]);
    expect(rowRead.content).not.toContain("not found");

    const edited = await run("Edit", {
      file_path: "cells.docx",
      section: "table:1/row:1/col:2",
      old_string: "Unique cell value",
      new_string: "Revised cell value",
    });
    expect(JSON.parse(edited.mutationReceipt ?? "null")).toMatchObject({
      ok: true,
      document_id: document.id,
      version_number: 2,
    });
    expect(
      (
        await run("Read", {
          file_path: "cells.docx",
          section: "table:1/row:1/col:2",
        })
      ).content,
    ).toContain("Revised cell value");
  });

  it.each([
    ["d0-generic", "", ""],
    [
      "d1-routed",
      "start with one whole Read for files at or below 24000 characters",
      "start with one whole Read for files at or below 24000 characters",
    ],
    [
      "d2-concrete",
      "covering every requested occurrence and any stated exclusion",
      "do not stop at the first hit",
    ],
  ] as const)(
    "isolates the %s description ablation without changing tools",
    async (shape, grepNeedle, readNeedle) => {
      process.env.MIKE_NAV_SHAPE = "address";
      process.env.MIKE_TOOL_SHAPE = "coding";
      process.env.MIKE_RETRIEVAL_EXPERIMENT = shape;
      vi.resetModules();

      const tools = await import("../chat/localAssistantTools");
      const resident = tools.LOCAL_ASSISTANT_TOOLS.filter((entry) =>
        ["Glob", "Grep", "Read"].includes(entry.function.name),
      );
      expect(resident.map((entry) => entry.function.name)).toEqual([
        "Glob",
        "Grep",
        "Read",
      ]);
      const grep = resident.find((entry) => entry.function.name === "Grep")!;
      const read = resident.find((entry) => entry.function.name === "Read")!;
      if (grepNeedle) {
        expect(grep.function.description).toContain(grepNeedle);
        expect(read.function.description).toContain(readNeedle);
      } else {
        expect(grep.function.description).not.toContain("24000");
        expect(read.function.description).not.toContain("24000");
      }
    },
  );

  it("keeps p0 as routed pure file coding with strict line-only Read", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-p0-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "cells.docx",
      bytes: await nativeTableBytes(),
    });
    const bakedSkeleton = vi.fn(() => {
      throw new Error("p0 compiled hidden structure");
    });
    vi.doMock("../legalStructureSidecar", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../legalStructureSidecar")>()),
      bakedSkeleton,
    }));
    vi.resetModules();

    const tools = await import("../chat/localAssistantTools");
    const nav = tools.LOCAL_ASSISTANT_TOOLS.filter((entry) =>
      ["Glob", "Grep", "Read"].includes(entry.function.name),
    );
    expect(nav.map((entry) => entry.function.name)).toEqual([
      "Glob",
      "Grep",
      "Read",
    ]);
    const grepSchema = nav.find((entry) => entry.function.name === "Grep")!;
    const readSchema = nav.find((entry) => entry.function.name === "Read")!;
    const editSchema = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Edit",
    )!;
    expect(grepSchema.function.description).toContain(
      "start with one whole Read for files at or below 24000 characters",
    );
    expect(readSchema.function.description).toContain(
      "start with one whole Read for files at or below 24000 characters",
    );
    const serializedRead = JSON.stringify(readSchema.function).toLowerCase();
    for (const word of [
      "section",
      "provision",
      "paragraph",
      "table",
      "cell",
      "page",
    ]) {
      expect(serializedRead).not.toContain(word);
    }
    expect(JSON.stringify(editSchema.function).toLowerCase()).not.toContain(
      "section",
    );

    const [grep, rejected, read] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "p0-grep",
          name: "Grep",
          input: {
            pattern: "Treasurer",
            path: "cells.docx",
            output_mode: "content",
          },
        },
        {
          id: "p0-hidden-section",
          name: "Read",
          input: { file_path: "cells.docx", section: "table:1/row:4" },
        },
        {
          id: "p0-line-read",
          name: "Read",
          input: { file_path: "cells.docx", offset: 1, limit: 2 },
        },
      ],
    );
    expect(grep.content).toContain("Treasurer");
    expect(grep.content).not.toMatch(/\[(?:table|section|article|clause):/iu);
    expect(bakedSkeleton).not.toHaveBeenCalled();
    expect(JSON.parse(rejected.content)).toEqual({
      ok: false,
      error: "Read accepts only file_path, offset, limit, and start_char",
    });
    expect(read.evidenceSpans?.length).toBeGreaterThan(0);
  });

  it("keeps the H1 Grep contact executable and bounded", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h1-contact";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h1-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "cells.docx",
      bytes: await nativeTableBytes(),
    });
    const tools = await import("../chat/localAssistantTools");
    const [grep] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h1-grep",
        name: "Grep",
        input: {
          pattern: "Treasurer",
          path: "cells.docx",
          output_mode: "content",
        },
      },
    ]);
    const contact = grep.content.match(/ {2}\[(Read[^\]\r\n]+)\]$/mu);
    const recipe = contact?.[1].split(" |", 1)[0] ?? "";

    expect(contact?.[0].length).toBeLessThanOrEqual(120);
    expect(recipe).toBe('Read section="table:1/row:4"');

    const section = /section="([^"]+)"/u.exec(recipe)?.[1];
    const [read] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h1-read",
        name: "Read",
        input: { file_path: "cells.docx", section },
      },
    ]);
    const extracted = await tools.extractLocalDocument(
      "local-user",
      document.id,
    );
    expect(
      read.evidenceSpans
        ?.map(([start, end]) => extracted!.text.slice(start, end))
        .filter(Boolean),
    ).toEqual(["Treasurer", "$25,000", "$100,000"]);
  });

  it("exposes verified legal units as immutable Grep and Read paths", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "mike-structure-paths-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "s1-structure-paths";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-structure-paths-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "schedule.docx",
      bytes: await nativeTableBytes(),
    });
    const tools = await import("../chat/localAssistantTools");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map();
    const run = (calls: Parameters<typeof tools.runLocalAssistantTools>[1]) =>
      tools.runLocalAssistantTools(
        "local-user",
        calls,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        state,
      );

    const [unmounted] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "unmounted-structure-grep",
        name: "Grep",
        input: {
          pattern: "Treasurer",
          path: "schedule.docx",
          output_mode: "content",
        },
      },
    ]);
    expect(unmounted.content).toContain("schedule.docx");
    expect(unmounted.content).not.toContain(".mike/structure/");
    expect(unmounted.content).not.toContain("table:1/row:4");

    const [grep, repeated] = await run([
      {
        id: "structure-grep",
        name: "Grep",
        input: {
          pattern: "Treasurer",
          path: "schedule.docx",
          output_mode: "content",
        },
      },
      {
        id: "repeated-structure-grep",
        name: "Grep",
        input: {
          pattern: "Treasurer",
          path: "schedule.docx",
          output_mode: "content",
        },
      },
    ]);
    const structurePath = grep.content.match(
      /\.mike\/structure\/[^:\r\n]+\.txt/u,
    )?.[0];
    expect(structurePath).toBeTruthy();
    expect(repeated.content).toContain(structurePath);
    expect(grep.content).toContain("source=schedule.docx");
    expect(grep.content).toContain("table:1/row:4");
    expect(grep.evidenceSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: document.id,
          virtualPath: structurePath,
          locator: "table:1/row:4",
          projection: "legal-unit",
          kind: "candidate",
        }),
      ]),
    );
    expect(state.get(structurePath!)?.segments).toHaveLength(1);
    expect(state.size).toBe(1);

    const [
      read,
      bounded,
      searched,
      missingRead,
      missingGrep,
      hiddenReadScope,
      hiddenGrepScope,
    ] = await run([
      {
        id: "structure-read",
        name: "Read",
        input: { file_path: structurePath },
      },
      {
        id: "bounded-structure-read",
        name: "Read",
        input: { file_path: structurePath, offset: 1, limit: 1 },
      },
      {
        id: "structure-search",
        name: "Grep",
        input: {
          pattern: "100,000",
          path: structurePath,
          output_mode: "content",
        },
      },
      {
        id: "missing-structure-read",
        name: "Read",
        input: { file_path: ".mike/structure/invented.txt" },
      },
      {
        id: "missing-structure-grep",
        name: "Grep",
        input: {
          pattern: "anything",
          path: ".mike/structure/invented.txt",
          output_mode: "content",
        },
      },
      {
        id: "hidden-structure-read-scope",
        name: "Read",
        input: { file_path: "schedule.docx", section: "table:1/row:4" },
      },
      {
        id: "hidden-structure-grep-scope",
        name: "Grep",
        input: {
          pattern: "Treasurer",
          path: "schedule.docx",
          section: "table:1/row:4",
        },
      },
      ]);
    expect(read.content).toContain("Treasurer");
    expect(read.content).toContain("$25,000");
    expect(read.content).toContain("$100,000");
    expect(read.evidenceSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: document.id,
          virtualPath: structurePath,
          locator: "table:1/row:4",
          projection: "legal-unit",
          kind: "evidence",
        }),
      ]),
    );
    const firstUnitLine = state.get(structurePath!)!.text.split(/\r?\n/u)[0];
    expect(bounded.evidenceSegments).toEqual([
      expect.objectContaining({
        start: state.get(structurePath!)!.segments[0].sourceStart,
        end:
          state.get(structurePath!)!.segments[0].sourceStart +
          firstUnitLine.length,
      }),
    ]);
    expect(searched.content).toContain(structurePath);
    expect(searched.content).toContain("100,000");
    expect(missingRead.status).toBe("not_found");
    expect(missingGrep.status).toBe("not_found");
    expect(missingRead.content).toContain("never invent or alter one");
    expect(JSON.parse(hiddenReadScope.content)).toMatchObject({ ok: false });
    expect(JSON.parse(hiddenGrepScope.content)).toMatchObject({ ok: false });
  });

  it("falls back to an exact verified PDF page structure path", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "mike-structure-paths-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "s1-structure-paths";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-structure-page-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;

    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "source.pdf",
      bytes: Buffer.from("%PDF-1.4\n% test fixture"),
    });
    const text = "[page 1]\nUnstructured target evidence on this page.\n";
    vi.doMock("../localPdfLookup", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../localPdfLookup")>()),
      readLocalPdfSourceDoc: vi.fn(async () => ({
        text,
        blocks: [
          {
            kind: "page" as const,
            label: "page1",
            start: 0,
            end: text.length,
            origin: "native" as const,
            anchor: "page=1",
            aliases: ["1"],
          },
        ],
      })),
    }));
    vi.resetModules();

    const tools = await import("../chat/localAssistantTools");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map();
    const [grep] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "page-structure-grep",
          name: "Grep",
          input: {
            pattern: "target evidence",
            path: "source.pdf",
            output_mode: "content",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      state,
    );
    const structurePath = grep.content.match(
      /\.mike\/structure\/[^:\r\n]+\.txt/u,
    )?.[0];
    expect(structurePath).toBeTruthy();
    expect(grep.content).toContain("PDF page 1");
    expect(grep.evidenceSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: document.id,
          locator: "pdf:1",
          projection: "pdf-page",
          virtualPath: structurePath,
        }),
      ]),
    );
    expect(state.get(structurePath!)?.text).toBe(text);
  });

  it("keeps H2 as one deferred bounded DocumentMap", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h2-document-map";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h2-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "cells.docx",
      bytes: await nativeTableBytes(),
    });
    const tools = await import("../chat/localAssistantTools");
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(partition.resident.map((entry) => entry.function.name)).toEqual(
      expect.arrayContaining(["Glob", "Grep", "Read", "describe_tools"]),
    );
    expect(partition.deferred.map((entry) => entry.function.name)).toEqual(
      expect.arrayContaining([
        "DocumentMap",
        "Edit",
        "library_delete_and_renumber_docx",
      ]),
    );

    const [described] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h2-open",
        name: "describe_tools",
        input: { domains: ["document_map"] },
      },
    ]);
    expect(JSON.parse(described.content)).toMatchObject({
      ok: true,
      domains: ["document_map"],
      opened: ["DocumentMap"],
    });
    const [mapped] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h2-map",
        name: "DocumentMap",
        input: {
          file_path: "cells.docx",
          focus: "tables",
          max_results: 25,
        },
      },
    ]);
    expect(mapped.content.length).toBeLessThanOrEqual(4_000);
    const payload = JSON.parse(mapped.content);
    expect(payload).toMatchObject({ ok: true, failures: [] });
    expect(payload.rows.length).toBeGreaterThan(0);
    expect(payload.rows.length).toBeLessThanOrEqual(25);
    expect(payload.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "row", label: "table:1/row:4" }),
      ]),
    );
    await expectReadRecipesAccepted(tools, "cells.docx", payload.rows);
  });

  it("keeps H3 as one deferred bounded ReferenceImpact", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h3-reference-impact";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h3-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "references.docx",
      bytes: await numberedReferenceBytes(),
    });
    const tools = await import("../chat/localAssistantTools");
    const partition = tools.partitionTools(tools.LOCAL_ASSISTANT_TOOLS);
    expect(partition.resident.map((entry) => entry.function.name)).toEqual(
      expect.arrayContaining(["Glob", "Grep", "Read", "describe_tools"]),
    );
    expect(partition.deferred.map((entry) => entry.function.name)).toEqual(
      expect.arrayContaining([
        "ReferenceImpact",
        "Edit",
        "library_delete_and_renumber_docx",
      ]),
    );

    const [described] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h3-open",
        name: "describe_tools",
        input: { domains: ["cross_reference_impact"] },
      },
    ]);
    expect(JSON.parse(described.content)).toMatchObject({
      ok: true,
      domains: ["cross_reference_impact"],
      opened: ["ReferenceImpact"],
    });
    const [impacted] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h3-impact",
        name: "ReferenceImpact",
        input: {
          file_path: "references.docx",
          targets: ["1.02"],
          operation: "delete_and_close_gap",
        },
      },
    ]);
    expect(impacted.content.length).toBeLessThanOrEqual(4_000);
    const payload = JSON.parse(impacted.content);
    expect(payload).toMatchObject({ ok: true, failures: [] });
    expect(payload.rows.length).toBeGreaterThan(0);
    expect(payload.rows.length).toBeLessThanOrEqual(50);
    expect(payload.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "target",
          target: "sec1.02",
          label: "sec1.02",
          read: { section: "sec1.02" },
        }),
        expect.objectContaining({
          kind: "affected_sibling",
          target: "sec1.02",
          label: "sec1.03",
          from: "sec1.03",
          to: "sec1.02",
          read: { section: "sec1.03" },
        }),
      ]),
    );
    expect(
      payload.rows.filter((row: { kind: string }) => row.kind === "inbound"),
    ).toHaveLength(2);
    await expectReadRecipesAccepted(tools, "references.docx", payload.rows);
  });

  it("integrates legal sections and one-hop references into Grep and Read", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h4-legal-grep";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h4-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "references.docx",
      bytes: await numberedReferenceBytes(),
    });
    const tools = await import("../chat/localAssistantTools");
    const grepSchema = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Grep",
    )!;
    const readSchema = tools.LOCAL_ASSISTANT_TOOLS.find(
      (entry) => entry.function.name === "Read",
    )!;
    expect(grepSchema.function.parameters.properties.output_mode.enum).toContain(
      "sections",
    );
    expect(grepSchema.function.parameters.properties).toHaveProperty("references");
    expect(readSchema.function.parameters.properties).toHaveProperty("references");

    const [mapped, read] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "h4-grep",
        name: "Grep",
        input: {
          pattern: "Section 1\\.03|provision remains",
          path: "references.docx",
          output_mode: "sections",
          section: "1.03",
          references: "inbound",
        },
      },
      {
        id: "h4-read",
        name: "Read",
        input: {
          file_path: "references.docx",
          section: "1.03",
          references: "inbound",
        },
      },
    ]);
    expect(mapped.content).toContain('Read section="sec1.01"');
    expect(mapped.content).toContain('Read section="sec1.03"');
    expect(mapped.content).toContain('Read section="sec2.01"');
    expect(mapped.content).toContain("hits=");
    expect(read.content).toContain("First. This points to Section 1.03.");
    expect(read.content).toContain("Third. This provision remains.");
    expect(read.content).toContain("Pointer. Section 1.03 controls.");
    expect(read.content).not.toContain("Delete Me");

    const extracted = await tools.extractLocalDocument("local-user", document.id);
    const spans = read.evidenceSpans ?? [];
    for (let left = 0; left < spans.length; left += 1) {
      for (let right = left + 1; right < spans.length; right += 1) {
        expect(
          Math.max(spans[left][0], spans[right][0]) <
            Math.min(spans[left][1], spans[right][1]),
        ).toBe(false);
      }
    }
    expect(spans.map(([start, end]) => extracted!.text.slice(start, end)).join(" ")).toContain(
      "provision remains",
    );
  });

  it("adds resolved hard-reference Read hints without exposing target prose", async () => {
    process.env.MIKE_NAV_SHAPE = "legacy";
    process.env.MIKE_TOOL_SHAPE = "lean-batch-v1";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
    process.env.MIKE_SUPPRESS_DUPLICATE_WHOLE_READS = "0";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "lean-hardrefs-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "references.docx",
      bytes: await numberedReferenceBytes(),
    });
    const allowed = new Set([document.id]);
    const grepWith = async (
      tools: typeof import("../chat/localAssistantTools"),
      id: string,
    ) =>
      (
        await tools.runLocalAssistantTools(
          "local-user",
          [
            {
              id,
              name: "Grep",
              input: {
                pattern: "First",
                path: "references.docx",
              },
            },
          ],
          undefined,
          undefined,
          undefined,
          undefined,
          allowed,
        )
      )[0];

    const lean = await import("../chat/localAssistantTools");
    const base = await grepWith(lean, "base");
    expect(base.content).not.toContain("literal reference");

    process.env.MIKE_TOOL_SHAPE = "lean-batch-hardrefs-v1";
    vi.resetModules();
    const hardrefs = await import("../chat/localAssistantTools");
    const hinted = await grepWith(hardrefs, "hinted");
    expect(hinted.content).toContain("First. This points to Section 1.03.");
    expect(hinted.content).toMatch(
      /\[literal reference sec1\.03: Read\(paths=\["references\.docx"\], offset=\d+, limit=\d+\)\]/u,
    );
    expect(hinted.content).not.toContain("Third. This provision remains.");
    expect(hinted.content).not.toContain(".mike/structure/");

    const recipe =
      /Read\(paths=\["references\.docx"\], offset=(\d+), limit=(\d+)\)/u.exec(
        hinted.content,
      )!;
    const [target] = await hardrefs.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "target",
          name: "Read",
          input: {
            paths: ["references.docx"],
            offset: Number(recipe[1]),
            limit: Number(recipe[2]),
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      allowed,
    );
    expect(target.content).toContain("Third. This provision remains.");
  });

  it("keeps the frozen H5 working set stateless", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h5-working-set";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h5-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "frozen.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("Unique frozen evidence.")] }],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map();
    const [created] = await tools.runLocalAssistantTools(
      "local-user",
      [{
        id: "frozen-working-set",
        name: "Grep",
        input: { pattern: "(?i)unique", output_mode: "working_set" },
      }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      state,
    );
    const manifest = JSON.parse(created.content);
    expect(manifest.path).toMatch(/^\.mike\/working-sets\/[a-f0-9]{16}\.txt$/u);
    expect(manifest).not.toHaveProperty("added_map_chars");
    const [read] = await tools.runLocalAssistantTools(
      "local-user",
      [{ id: "read-frozen", name: "Read", input: { file_path: manifest.path } }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      state,
    );
    expect(read.content).not.toContain("FILE MAP");
  });

  it("accretes a source-deduplicated multi-document working set", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h9-accretive-union";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h9-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    const table = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "schedule.docx",
      bytes: await nativeTableBytes(),
    });
    const prose = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "memo.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph("1.01 Background."),
                new Paragraph("The unique value is discussed here."),
                new Paragraph("Context ".repeat(150)),
                new Paragraph("2.01 Additional."),
                new Paragraph("A later fact belongs to a distinct section."),
              ],
            },
          ],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map();
    const run = (calls: Parameters<typeof tools.runLocalAssistantTools>[1]) =>
      tools.runLocalAssistantTools(
        "local-user",
        calls,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        state,
      );

    const [braced] = await run([
      {
        id: "brace-glob",
        name: "Glob",
        input: { pattern: "{schedule.docx,memo.docx}" },
      },
    ]);
    expect(
      braced.content
        .split("\n")
        .filter((line) => !line.startsWith("TOTAL\t"))
        .map((line) => line.split("\t", 1)[0])
        .sort(),
    ).toEqual(["memo.docx", "schedule.docx"]);

    const [created] = await run([
      {
        id: "make-working-set",
        name: "Grep",
        input: {
          pattern: "(?i)unique",
          output_mode: "working_set",
        },
      },
    ]);
    const workingSetPath = ".mike/working-sets/evidence.txt";
    expect(created.content).toContain(`[WORKING SET ${workingSetPath}`);
    expect(created.content).toMatch(/matched \d+\/\d+ docs/);
    expect(created.content).toContain("FILE MAP");
    expect(created.content).toContain("Unique cell value");
    expect(created.evidenceSegments?.some((item) => item.documentId === table.id)).toBe(true);
    expect(state.get(workingSetPath)?.text).toContain("Unique cell value");

    const [duplicate, expanded] = await run([
      {
        id: "repeat-working-set",
        name: "Grep",
        input: { pattern: "(?i)unique", output_mode: "working_set" },
      },
      {
        id: "expand-working-set",
        name: "Grep",
        input: { pattern: "(?i)later fact", output_mode: "working_set" },
      },
    ]);
    expect(duplicate.content).toContain("No new evidence");
    expect(expanded.content).toContain("A later fact belongs to a distinct section.");
    expect(expanded.evidenceSegments?.some((item) => item.documentId === prose.id)).toBe(true);

    const immutableChars = 129_000;
    const pagedState: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map([
        [
          workingSetPath,
          {
            path: workingSetPath,
            text: "x".repeat(immutableChars),
            sourceChars: immutableChars,
            matchedSourceChars: immutableChars,
            immutableSourceChars: immutableChars,
            mapChars: 0,
            budgetChars: 0,
            mappedVersions: [],
            segments: [],
            refs: [
              {
                virtualStart: 0,
                virtualEnd: 1,
                handle: "provider:immutable",
                filename: "provider.html",
                exactSha256: "immutable-hash",
              },
            ],
          },
        ],
      ]);
    const [pagedExpansion] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "expand-paged-working-set",
          name: "Grep",
          input: { pattern: "(?i)later fact", output_mode: "working_set" },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pagedState,
    );
    expect(pagedExpansion.content).toContain(
      "A later fact belongs to a distinct section.",
    );
    expect(pagedState.get(workingSetPath)?.refs).toHaveLength(1);

    const [read, refused] = await run([
      {
        id: "read-working-set",
        name: "Read",
        input: { file_path: workingSetPath },
      },
      {
        id: "edit-working-set",
        name: "Edit",
        input: {
          file_path: workingSetPath,
          old_string: "unique",
          new_string: "changed",
        },
      },
    ]);
    expect(read.content).toContain("schedule.docx");
    expect(read.content).toContain("FILE MAP");
    expect(read.content).toContain("headers");
    expect(read.content).toContain("Alpha");
    expect(read.content).toContain("Unique cell value");
    expect(read.content).toContain("memo.docx");
    expect(read.content).toContain("A later fact belongs to a distinct section.");
    expect(new Set(read.evidenceSegments?.map((item) => item.documentId))).toEqual(
      new Set([table.id, prose.id]),
    );
    expect(refused.content).toContain("append-only");
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

  it("maps a long flat instrument across its full structure", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h9-accretive-union";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h9-map-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();

    const store = await import("../localDocumentStore");
    await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "long-agreement.docx",
      bytes: await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: Array.from(
                { length: 80 },
                (_, index) =>
                  new Paragraph(
                    `${index + 1}.01 Heading ${index + 1}${index === 79 ? " unique needle" : ""}`,
                  ),
              ),
            },
          ],
        }),
      ),
    });
    const tools = await import("../chat/localAssistantTools");
    const state: import("../chat/localAssistantTools").LocalAssistantWorkingSetTurnState =
      new Map();
    const [grep] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "balanced-map",
          name: "Grep",
          input: { pattern: "needle", output_mode: "working_set" },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      state,
    );
    expect(grep.content).toContain("section\tsec1.01");
    expect(grep.content).toMatch(/section\tsec(?:3[5-9]|4[0-5])\.01/u);
    expect(grep.content).toContain("80.01 Heading 80 unique needle");
    expect(grep.content).not.toContain("opening:");
  });

  it("keeps semantic compiler advisories out of automatic mutation receipts", async () => {
    process.env.MIKE_TOOL_SHAPE = "coding";
    process.env.MIKE_RETRIEVAL_EXPERIMENT = "h9-accretive-union";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-h9-compiler-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.resetModules();
    const tools = await import("../chat/localAssistantTools");
    const [warning, error] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "warning-draft",
        name: "library_create_docx",
        input: {
          title: "Analytical Memo",
          filename: "analysis-memo.docx",
          markdown: "# Analysis\n\nThe borrower may not have sufficient liquidity.",
        },
      },
      {
        id: "error-draft",
        name: "library_create_docx",
        input: {
          title: "Agreement",
          filename: "agreement.docx",
          markdown: "# Covenant\n\nThe borrower must shall deliver notice.",
        },
      },
    ]);
    expect(JSON.parse(warning.content).compiler_diagnostics).toEqual({
      status: "passed",
      finding_count: 0,
    });
    expect(JSON.parse(error.content).compiler_diagnostics).toMatchObject({
      status: "action_required",
      finding_count: 1,
      findings: [expect.objectContaining({ code: "stacked-modals" })],
    });
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
    process.env.MIKE_NAV_SHAPE = "address";
    process.env.MIKE_TOOL_SHAPE = "coding";
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      turnState,
    );
    expect(edits.every((edit) => edit.content.startsWith("Updated"))).toBe(true);
    expect((await store.listLocalVersions("local-user", intended.id))?.versions)
      .toHaveLength(2);
    expect((await store.listLocalVersions("local-user", other.id))?.versions)
      .toHaveLength(1);
    expect((await tools.extractLocalDocument("local-user", intended.id))?.text)
      .toContain("Gamma Delta.");
  });

  it("uses verified PDF artifacts without loading the source into memory", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    const sourcePath = path.join(os.tmpdir(), "verified-source.pdf");
    const sourceReads = vi.fn();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readFile: async (filePath: unknown, ...args: unknown[]) => {
          if (filePath === sourcePath) {
            sourceReads();
            return Buffer.from("%PDF-1.4");
          }
          return (
            actual.readFile as (
              filePath: unknown,
              ...args: unknown[]
            ) => Promise<unknown>
          )(filePath, ...args);
        },
      };
    });
    vi.doMock("../localDocumentStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../localDocumentStore")>()),
      getLocalVersionFile: vi.fn(async () => ({
        path: sourcePath,
        fileType: "pdf",
        document: { filename: "verified-source.pdf" },
        version: {
          id: "version-1",
          created_at: "2026-07-30T00:00:00.000Z",
        },
      })),
    }));
    vi.doMock("../localPdfLookup", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../localPdfLookup")>()),
      readLocalPdfSourceDoc: vi.fn(async () => ({
        text: "Text from the verified PDF artifact.",
      })),
    }));

    const { extractLocalDocument, runLocalAssistantTools } =
      await import("../chat/localAssistantTools");

    await expect(
      extractLocalDocument("local-user", "document-1"),
    ).resolves.toEqual({
      filename: "verified-source.pdf",
      documentId: "document-1",
      versionId: "version-1",
      text: "Text from the verified PDF artifact.",
      cautions: [],
      // A PDF whose artifact yields no page records reports UNAVAILABLE, not
      // "none": the file has pages, we just could not index them, and the
      // refusal must not claim otherwise.
      pages: { pages: [], source: "unindexed" },
      tableCells: [],
    });
    expect(sourceReads).not.toHaveBeenCalled();

    const [search] = await runLocalAssistantTools("local-user", [
      {
        id: "call-unindexed-page",
        name: "library_find",
        input: { document_id: "document-1", query: "Text", at: "pdf:1" },
      },
    ]);
    const refusal = JSON.parse(search.content);
    expect(refusal).toMatchObject({ ok: false });
    expect(refusal.error).toContain("omit at");
    expect(refusal.error).not.toContain("`pages`");
  });

  /**
   * The navigation surface end to end, on the case it exists for: front
   * matter printed "i" makes PDF page 2 the sheet printed "1", which is the
   * sheet a table of contents cites.
   */
  it("addresses pages by both numbering schemes and follows the reference graph", async () => {
    // The address arm is the subject here; pin it rather than inheriting it.
    process.env.MIKE_NAV_SHAPE = "address";
    const sourcePath = path.join(os.tmpdir(), "paged-agreement.pdf");
    const parts = [
      { printed: "i", body: "TABLE OF CONTENTS\n\nARTICLE II — TERM ... 1" },
      {
        printed: "1",
        body:
          "ARTICLE II — TERM\n\n2.01 Term. This Agreement continues until terminated under Section 3.02.",
      },
      {
        printed: "2",
        body:
          "ARTICLE III — TERMINATION\n\n3.02 Effect. On termination, Section 2.01 ceases to apply.",
      },
    ];
    let text = "";
    const blocks = parts.map((part, index) => {
      const start = text.length;
      text += `[page ${part.printed}]\n${part.body}\n\n`;
      return {
        kind: "page" as const,
        label: `page${part.printed}`,
        start,
        end: text.length,
        origin: "native" as const,
        anchor: `page=${index + 1}`,
        aliases: [String(index + 1), part.printed],
      };
    });
    vi.doMock("../localDocumentStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../localDocumentStore")>()),
      getLocalVersionFile: vi.fn(async () => ({
        path: sourcePath,
        fileType: "pdf",
        document: { filename: "paged-agreement.pdf" },
        version: { id: "v1", created_at: "2026-07-31T00:00:00.000Z" },
      })),
    }));
    vi.doMock("../localPdfLookup", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../localPdfLookup")>()),
      readLocalPdfSourceDoc: vi.fn(async () => ({ text, blocks })),
    }));
    const tools = await import("../chat/localAssistantTools");
    const run = async (name: string, input: Record<string, unknown>) => {
      const [response] = await tools.runLocalAssistantTools("local-user", [
        { id: `call-${name}`, name, input: { document_id: "doc-1", ...input } },
      ]);
      return JSON.parse(response.content);
    };

    // The two schemes are separate calls, and a page must be named as one:
    // a bare address is structural, so pages are qualified.
    const bare = await run("library_read", { at: "pdf:1" });
    expect(bare).toMatchObject({ ok: true, pdf_page: 1, matched_on: "pdf" });
    expect(bare.text).toContain("TABLE OF CONTENTS");

    const printed = await run("library_read", { at: "printed:1" });
    expect(printed).toMatchObject({
      ok: true,
      pdf_page: 2,
      printed_label: "1",
      matched_on: "printed",
    });
    expect(printed.text).toContain("2.01 Term.");
    expect(printed.sections.map((entry: { section: string }) => entry.section)).toContain(
      "sec2.01",
    );

    // Search scoped to a page, with document-wide offsets preserved.
    const scoped = await run("library_find", {
      query: "Section",
      at: "printed:2",
    });
    expect(scoped.pages_searched).toBe(1);
    expect(scoped.hits).toHaveLength(1);
    expect(scoped.hits[0].page).toBe('PDF page 3 (printed "2")');
    // The address arm hands back a passable address plus the raw offset.
    expect(scoped.hits[0].at).toBe(`off:${scoped.hits[0].offset}`);
    expect(text.slice(scoped.hits[0].offset)).toMatch(/^Section 2\.01/u);

    // The orientation call carries the page map, including the divergence.
    const outline = await run("library_outline", {});
    expect(outline.pages).toMatchObject({
      count: 3,
      addressable_by: ["pdf", "printed"],
      printed_differs_from_pdf: 3,
    });

    // One address grammar across the tools, and tail reads.
    const viaAt = await run("library_read", { at: "printed:1" });
    expect(viaAt).toMatchObject({ ok: true, pdf_page: 2, matched_on: "printed" });
    // 200 is the schema floor for max_chars; the tail is exactly the last
    // window, so an execution page is reachable without a length probe.
    const tail = await run("library_read", { from: "end", max_chars: 200 });
    expect(tail.text).toBe(text.slice(text.length - 200));
    expect(tail.offset).toBe(text.length - 200);
    const scopedByAt = await run("library_find", {
      query: "Section",
      at: "printed:2",
    });
    expect(scopedByAt.hits).toHaveLength(1);

    // Some providers materialize every optional argument. `depth` has no
    // effect when `follow` is none, so these calls must behave exactly like
    // their omitted-default counterparts rather than being mistaken for
    // graph traversal.
    const defaultedFind = await run("library_find", {
      query: "Section",
      follow: "none",
      depth: 1,
    });
    expect(defaultedFind.ok).toBe(true);
    expect(defaultedFind.hits.length).toBeGreaterThan(0);
    const defaultedScopedFind = await run("library_find", {
      query: "Section",
      at: "printed:2",
      follow: "none",
      depth: 1,
    });
    expect(defaultedScopedFind.ok).toBe(true);
    expect(defaultedScopedFind.hits).toHaveLength(1);
    const defaultedOpeningRead = await run("library_read", {
      follow: "none",
      depth: 1,
    });
    expect(defaultedOpeningRead.ok).toBe(true);
    expect(defaultedOpeningRead.text).toContain("TABLE OF CONTENTS");
    const defaultedOffsetRead = await run("library_read", {
      at: "off:20",
      follow: "none",
      depth: 1,
    });
    expect(defaultedOffsetRead.ok).toBe(true);
    expect(defaultedOffsetRead.offset).toBe(20);
    const defaultedPageRead = await run("library_read", {
      at: "printed:1",
      follow: "none",
      depth: 1,
    });
    expect(defaultedPageRead).toMatchObject({
      ok: true,
      pdf_page: 2,
      matched_on: "printed",
    });

    // follow expands the address on read, not just on find.
    const withRelated = await run("library_read", { at: "2.01", follow: "out" });
    expect(withRelated.text).toContain("2.01 Term.");
    expect(
      withRelated.related.map((entry: { section: string }) => entry.section),
    ).toEqual(["sec3.02"]);
    const missing = await run("library_read", { at: "9.99", follow: "out" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/u);

    const links = await run("library_links", { at: "2.01" });
    expect(links.ok).toBe(true);
    expect(
      links.references_out.map((edge: { target: string }) => edge.target),
    ).toEqual(["sec3.02"]);
    expect(links.references_in.map((edge: { from: string }) => edge.from)).toEqual([
      "sec3.02",
    ]);

    // Address kinds are capabilities, not hints. Unsupported combinations
    // refuse instead of quietly widening to the whole document or census.
    const offsetFind = await run("library_find", {
      query: "Section",
      at: "off:20",
    });
    const pageFollow = await run("library_read", {
      at: "printed:1",
      follow: "out",
    });
    const pageDepth = await run("library_find", {
      query: "Section",
      at: "printed:2",
      follow: "out",
      depth: 2,
    });
    const pageLinks = await run("library_links", { at: "pdf:1" });
    const offsetLinks = await run("library_links", { at: "off:20" });
    for (const refused of [
      offsetFind,
      pageFollow,
      pageDepth,
      pageLinks,
      offsetLinks,
    ]) {
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("at");
      expect(refused.error).not.toMatch(/(?:section|offset|pages)=|`(?:section|offset|pages)`/u);
    }
  });

  it("reads, searches, and revises one native DOCX table cell by address", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-cells-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await Packer.toBuffer(
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
                ],
              }),
              new Paragraph("2.01 Other text with Unique elsewhere."),
            ],
          },
        ],
      }),
    );
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "cells.docx",
      bytes,
    });
    const allowed = new Set([document.id]);
    const tools = await import("../chat/localAssistantTools");
    const run = async (name: string, input: Record<string, unknown>) => {
      const [response] = await tools.runLocalAssistantTools(
        "local-user",
        [{ id: `cell-${name}`, name, input: { document_id: document.id, ...input } }],
        undefined,
        undefined,
        undefined,
        undefined,
        allowed,
      );
      return JSON.parse(response.content);
    };

    const outline = await run("library_outline", {});
    expect(outline).toMatchObject({ ok: true, tables: 1, cells: 2 });
    expect(outline.outline).toContain("table:1/row:1/col:2");

    const read = await run("library_read", {
      at: "table:1/row:1/col:2",
    });
    expect(read.text).toBe("Unique cell value");

    const find = await run("library_find", {
      query: "Unique",
      at: "table:1/row:1/col:2",
    });
    expect(find.hits).toHaveLength(1);
    expect(find.hits[0].section).toBe("table:1/row:1/col:2");

    const links = await run("library_links", {
      at: "table:1/row:1/col:2",
    });
    expect(links).toMatchObject({
      ok: true,
      section: "table:1/row:1/col:2",
    });
    expect(
      links.ancestors.map((entry: { section: string }) => entry.section),
    ).toContain("table:1");

    const revised = await run("library_revise_docx", {
      version_id: document.current_version_id,
      edits: [
        {
          at: "table:1/row:1/col:2",
          find: "Unique cell value",
          replace: "Revised cell value",
        },
      ],
    });
    expect(revised).toMatchObject({
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      version_number: 2,
    });
    const reread = await run("library_read", {
      at: "table:1/row:1/col:2",
    });
    expect(reread.text).toBe("Revised cell value");
  });

  it("deletes and renumbers a DOCX atomically inside one turn version", async () => {
    process.env.MIKE_NAV_SHAPE = "address";
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-renumber-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const bytes = await numberedReferenceBytes();
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "renumber.docx",
      bytes,
    });
    const tools = await import("../chat/localAssistantTools");
    const turnState: import("../chat/localAssistantTools").LocalAssistantEditTurnState =
      new Map();
    const [renumberResponse, reviseResponse] =
      await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "renumber",
            name: "library_delete_and_renumber_docx",
            input: {
              document_id: document.id,
              version_id: document.current_version_id,
              target: "1.02",
            },
          },
          {
            id: "revise-after-renumber",
            name: "library_revise_docx",
            input: {
              document_id: document.id,
              version_id: document.current_version_id,
              edits: [
                {
                  at: "1.02",
                  find: "Third",
                  replace: "Final",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set([document.id]),
        undefined,
        undefined,
        undefined,
        turnState,
      );
    const renumber = JSON.parse(renumberResponse.content);
    const revise = JSON.parse(reviseResponse.content);
    expect(renumber, JSON.stringify(renumber)).toMatchObject({
      ok: true,
      operation_receipt: "mike-delete-and-renumber:v1",
      version_number: 2,
      mapping: [{ from: "sec1.03", to: "sec1.02" }],
      verification: { headingsRenumbered: 1, referencesUpdated: 2 },
    });
    expect(revise).toMatchObject({
      ok: true,
      version_id: renumber.version_id,
      version_number: 2,
      parent_version_id: document.current_version_id,
    });

    const versions = await store.listLocalVersions("local-user", document.id);
    expect(versions?.versions).toHaveLength(2);
    const active = await store.getLocalVersionFile("local-user", document.id);
    const accepted = await (await import("../docxTrackedChanges"))
      .extractDocxBodyText(await readFile(active!.path));
    expect(accepted).not.toContain("Delete Me");
    expect(accepted).toContain("1.02 Final.");
    expect(accepted.match(/Section 1\.02/gu)).toHaveLength(2);
    expect(accepted).not.toContain("1.03");
  });

  it("keeps oversized research results as valid JSON with research guidance", async () => {
    process.env.MIKE_TOOL_RESULT_CAP = "1000";
    vi.doMock("../chat/publicLegalSourceState", async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../chat/publicLegalSourceState")
      >()),
      createPublicLegalSourceState: vi.fn(() => ({})),
      executePublicLegalSourceTool: vi.fn(async (name: string) =>
        name === "public_legal_source_search"
          ? {
              ok: true,
              hits: Array.from({ length: 100 }, (_, index) => ({
                id: `source-${index}`,
                excerpt: `research passage ${index} ${"x".repeat(100)}`,
              })),
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

  it("offers bounded deterministic DOCX actions", async () => {
    const { LOCAL_ASSISTANT_TOOLS } =
      await import("../chat/localAssistantTools");
    const names = LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name);

    expect(names).toContain("ask_inputs");
    expect(names).toContain("library_link_docx_citations");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_link_docx_citations",
      )?.function.description,
    ).toContain("do not read, split, classify, or construct citation URLs");
    expect(names).toContain("library_fix_docx_supras");
    expect(names).toContain("library_lint_docx_structure");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_lint_docx_structure",
      )?.function.description,
    ).toContain("receipt of what was checked");
    expect(names).toContain("legal_pdf_lookup");
    expect(names).toContain("library_create_docx");
    expect(names).toContain("library_revise_docx");
    expect(names).toContain("library_delete_and_renumber_docx");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_delete_and_renumber_docx",
      )?.function.description,
    ).toContain("delete-and-close-gap only");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_revise_docx",
      )?.function.description,
    ).toContain("instead of replying with proposed or suggested changes");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_revise_docx",
      )?.function.parameters.required,
    ).toEqual(["document_id", "edits"]);
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_fix_docx_supras",
      )?.function.description,
    ).toContain("ambiguous/restarted/split cases");
    expect(names).toContain("toa_submit_library_document");
    expect(names).toContain("toa_job_status");
    expect(names).toContain("list_workflows");
    expect(names).toContain("read_workflow");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "toa_submit_library_document",
      )?.function.parameters.properties,
    ).not.toHaveProperty("path");
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

  it("creates and immutably revises a matter DOCX across reloads", async () => {
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
      const allowedDocumentIds = new Set<string>();
      const tools = await import("../chat/localAssistantTools");

      const [createdResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-create",
            name: "library_create_docx",
            input: {
              title: "Opinion Draft",
              filename: "opinion-draft.docx",
              markdown:
                "# Background\n\nOriginal provision.\n\nEffective on {{effective_date}}.[^1]\n\n[^1]: The effective date remains editable.",
              fields: [
                {
                  id: "effective_date",
                  value: "July 27, 2026",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
        undefined,
        matter.id,
      );
      const created = JSON.parse(createdResponse.content);

      expect(created).toMatchObject({
        ok: true,
        receipt: "mike-document:v1",
        action: "created",
        version_number: 1,
        filename: "opinion-draft.docx",
        file_type: "docx",
        attached_to_matter: true,
      });
      expect(created.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(created.download_url).toBe(
        `/single-documents/${created.document_id}/file?version_id=${created.version_id}`,
      );
      expect(created.app_url).toBeUndefined();
      // Card/URL etiquette lives once, in the system prompt; the receipt does
      // not re-teach it on every create.
      expect(created.next_required_action).toBeUndefined();
      expect(allowedDocumentIds).toContain(created.document_id);
      expect(graph.listMatterDocumentIds("local-user", matter.id)).toEqual([
        created.document_id,
      ]);

      const [draftingReadResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-drafting-read",
            name: "library_read",
            input: {
              document_id: created.document_id,
              mode: "drafting",
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      const draftingRead = JSON.parse(draftingReadResponse.content);

      expect(draftingRead).toMatchObject({
        ok: true,
        format: "pandoc-markdown-v1",
        document_id: created.document_id,
        version_id: created.version_id,
      });
      expect(draftingRead.source_sha256).toBe(created.source_sha256);
      expect(draftingRead.markdown).toMatch(
        /\*\*Background\*\*/u,
      );
      expect(draftingRead.markdown).toContain("[^");

      const [scopedDraftingResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-scoped-drafting-read",
            name: "library_read",
            input: {
              document_id: created.document_id,
              mode: "drafting",
              at: "art1",
              from: "start",
              follow: "none",
              depth: 1,
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(scopedDraftingResponse.content)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Use mode=text"),
      });

      const [revisedResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-revise",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: created.version_id,
              edits: [
                {
                  find: "Original",
                  replace: "Revised",
                  context_before: "",
                  context_after: " provision.",
                  reason: "Update the draft.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      const revised = JSON.parse(revisedResponse.content);

      expect(revised).toMatchObject({
        ok: true,
        receipt: "mike-document:v1",
        action: "revised",
        document_id: created.document_id,
        parent_version_id: created.version_id,
        version_number: 2,
        change_count: 1,
      });
      expect(revised.app_url).toBeUndefined();
      expect(revised.download_url).toBe(
        `/single-documents/${created.document_id}/file?version_id=${revised.version_id}`,
      );
      expect(revised.annotations).toMatchObject([
        {
          kind: "edit",
          document_id: created.document_id,
          version_id: revised.version_id,
          version_number: 2,
          deleted_text: "Original",
          inserted_text: "Revised",
          reason: "Update the draft.",
          status: "pending",
        },
      ]);
      expect(revised.annotations[0].edit_id).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(revised.next_required_action).toBeUndefined();
      expect(revised.version_id).not.toBe(created.version_id);
      expect(revised.source_sha256).toMatch(/^[a-f0-9]{64}$/u);

      const [noOpResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-no-op",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: revised.version_id,
              edits: [
                {
                  find: "Revised",
                  replace: "Revised",
                  context_before: "",
                  context_after: " provision.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(noOpResponse.content)).toEqual({
        ok: false,
        error: "No revision was saved",
        edit_errors: ["Every requested edit was a no-op"],
      });

      const [normalizedNoOpResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-normalized-no-op",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: revised.version_id,
              edits: [
                {
                  find: "Revised  provision.",
                  replace: "Revised provision.",
                  context_before: "",
                  context_after: "",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(normalizedNoOpResponse.content)).toEqual({
        ok: false,
        error: "No revision was saved",
        edit_errors: [
          {
            index: 0,
            reason: "Replacement does not change the matched text.",
          },
        ],
      });

      const [staleResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-stale",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: created.version_id,
              edits: [
                {
                  find: "Original",
                  replace: "Stale",
                  context_before: "",
                  context_after: " provision.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(staleResponse.content)).toEqual({
        ok: false,
        error: "version_id is not the active version",
      });

      const liveStore = await import("../localDocumentStore");
      const spreadsheet = await liveStore.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "schedule.xlsx",
        bytes: Buffer.from("not-used-by-the-format-guard"),
      });
      allowedDocumentIds.add(spreadsheet.id);
      const [wrongVersionResponse, wrongFormatResponse] =
        await tools.runLocalAssistantTools(
          "local-user",
          [
            {
              id: "call-wrong-version",
              name: "library_revise_docx",
              input: {
                document_id: created.document_id,
                version_id: "missing-version",
                edits: [
                  {
                    find: "Revised",
                    replace: "Changed",
                    context_before: "",
                    context_after: " provision.",
                  },
                ],
              },
            },
            {
              id: "call-wrong-format",
              name: "library_revise_docx",
              input: {
                document_id: spreadsheet.id,
                version_id: spreadsheet.current_version_id,
                edits: [
                  {
                    find: "A",
                    replace: "B",
                    context_before: "",
                    context_after: "",
                  },
                ],
              },
            },
          ],
          undefined,
          undefined,
          undefined,
          undefined,
          allowedDocumentIds,
        );
      expect(JSON.parse(wrongVersionResponse.content)).toEqual({
        ok: false,
        error: "DOCX Library version not found",
      });
      expect(JSON.parse(wrongFormatResponse.content)).toEqual({
        ok: false,
        error: "Revision requires a DOCX Library version",
      });

      vi.resetModules();
      const reloadedStore = await import("../localDocumentStore");
      const trackedChanges = await import("../docxTrackedChanges");
      const versions = await reloadedStore.listLocalVersions(
        "local-user",
        created.document_id,
      );
      const original = await reloadedStore.getLocalVersionFile(
        "local-user",
        created.document_id,
        created.version_id,
      );
      const latest = await reloadedStore.getLocalVersionFile(
        "local-user",
        created.document_id,
        revised.version_id,
      );

      expect(versions?.current_version_id).toBe(revised.version_id);
      expect(versions?.versions).toHaveLength(2);
      expect(versions?.versions).toMatchObject([
        {
          id: created.version_id,
          provenance: {
            schema_version: 1,
            actor: "assistant",
            action: "created",
          },
        },
        {
          id: revised.version_id,
          provenance: {
            schema_version: 1,
            actor: "assistant",
            action: "revised",
            parent_version_id: created.version_id,
            change_count: 1,
          },
        },
      ]);
      const durableStore = JSON.parse(
        await readFile(path.join(temporaryDirectory, "library.json"), "utf8"),
      );
      expect(
        durableStore.documents[0].versions[0].provenance.generation,
      ).toMatchObject({
        rendererVersion: "beaver.docx-markdown.v1",
        markdownSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fieldValuesSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceRegistrySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        evidenceBindings: [],
      });
      expect(
        durableStore.documents[0].versions[1].provenance.trackedEdits,
      ).toMatchObject([
        {
          id: revised.annotations[0].edit_id,
          deletedText: "Original",
          insertedText: "Revised",
          status: "pending",
        },
      ]);
      expect(
        await trackedChanges.extractDocxBodyText(
          await readFile(original!.path),
        ),
      ).toContain("Original provision.");
      expect(
        await trackedChanges.extractDocxBodyText(await readFile(latest!.path)),
      ).toContain("Revised provision.");
    } finally {
      graph.close();
    }
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
            name: "library_create_docx",
            input: {
              title: "Unattached Draft",
              markdown: "Draft text.",
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set<string>(),
        undefined,
        matter.id,
      );

      expect(JSON.parse(response.content)).toEqual({
        ok: false,
        error: "Could not attach document to matter",
      });
      expect(
        (
          await (
            await import("../localDocumentStore")
          ).listLocalLibrary("local-user", "file")
        ).documents,
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("discovers documents in the local Beaver Library", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const tools = await import("../chat/localAssistantTools");
    const graph = (
      await import("../legalKnowledgeGraphStore")
    ).legalKnowledgeGraphStore();
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "Chamberlain.pdf",
      bytes: Buffer.from("%PDF-1.4 test"),
    });

    try {
      const [response] = await tools.runLocalAssistantTools("local-user", [
        {
          id: "call-1",
          name: "library_list",
          input: { query: "chamberlain" },
        },
      ]);

      expect(JSON.parse(response.content)).toMatchObject({
        ok: true,
        documents: [
          {
            document_id: document.id,
            filename: "Chamberlain.pdf",
          },
        ],
      });
    } finally {
      try {
        await store.deleteLocalDocument("local-user", document.id);
      } finally {
        graph.close();
      }
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
      evidence,
    );
    const modelResult = JSON.parse(response.content);

    expect(modelResult.ok).toBe(true);
    expect(modelResult).not.toHaveProperty("url");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].url).toBe("https://example.test/case");
  });
});
