import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODING_MARKDOWN_FINAL_LAB_SYSTEM_PROMPT,
  CODING_MARKDOWN_FINAL_LAB_TOOLS,
} from "../chat/upstreamMikeBenchmarkSurface";

let temporaryDirectory: string | null = null;

const docx = (lines: string[]) =>
  Packer.toBuffer(
    new Document({
      sections: [{ children: lines.map((line) => new Paragraph(line)) }],
    }),
  );

async function setupFinalArm(idempotentAuthoring = false) {
  process.env.MIKE_NAV_SHAPE = "legacy";
  process.env.MIKE_TOOL_SHAPE = "lean-batch-v1";
  process.env.MIKE_RETRIEVAL_EXPERIMENT = "p0-pure-coding";
  process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
  process.env.MIKE_DISABLE_ASK_INPUTS = "1";
  process.env.MIKE_READ_DOCX_MARKDOWN = "1";
  process.env.MIKE_CODING_NEUTRAL_PROMPT = "1";
  process.env.MIKE_CODING_PARITY = "1";
  process.env.MIKE_GREP_SECTION_CONTEXT = "1";
  process.env.MIKE_CODING_TOC_FILES = "1";
  process.env.MIKE_GREP_PER_FILE_BUDGET = "1";
  process.env.MIKE_TRIAGE_WORKFLOW = "1";
  process.env.MIKE_EXPOSURE_ECHO = "1";
  process.env.MIKE_DRAFT_EDIT = "1";
  process.env.MIKE_FINAL_ARM = "1";
  process.env.MIKE_IDEMPOTENT_AUTHORING = idempotentAuthoring ? "1" : "";
  process.env.MIKE_TERMINAL_AUTHORING = "1";
  process.env.MIKE_TOOL_RESULT_CAP = "64000";
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "beaver-final-arm-"),
  );
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  vi.resetModules();

  const store = await import("../localDocumentStore");
  const tools = await import("../chat/localAssistantTools");
  return { store, tools };
}

afterEach(async () => {
  for (const name of [
    "MIKE_NAV_SHAPE",
    "MIKE_TOOL_SHAPE",
    "MIKE_RETRIEVAL_EXPERIMENT",
    "MIKE_DISABLE_RESEARCH_TOOLS",
    "MIKE_DISABLE_ASK_INPUTS",
    "MIKE_READ_DOCX_MARKDOWN",
    "MIKE_CODING_NEUTRAL_PROMPT",
    "MIKE_CODING_PARITY",
    "MIKE_GREP_SECTION_CONTEXT",
    "MIKE_CODING_TOC_FILES",
    "MIKE_GREP_PER_FILE_BUDGET",
    "MIKE_TRIAGE_WORKFLOW",
    "MIKE_EXPOSURE_ECHO",
    "MIKE_DRAFT_EDIT",
    "MIKE_FINAL_ARM",
    "MIKE_IDEMPOTENT_AUTHORING",
    "MIKE_TERMINAL_AUTHORING",
    "MIKE_TOOL_RESULT_CAP",
    "MIKE_LOCAL_DATA_DIR",
  ]) {
    delete process.env[name];
  }
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("coding_markdown_final_v1", () => {
  it("keeps the model-visible surface operational rather than experimental", () => {
    const visibleSurface = [
      CODING_MARKDOWN_FINAL_LAB_SYSTEM_PROMPT,
      JSON.stringify(CODING_MARKDOWN_FINAL_LAB_TOOLS),
    ].join("\n");
    expect(visibleSurface).not.toMatch(
      /\b(?:LAB|benchmark|experiment|ablation|receipt|provider-derived|fixed document-count|body evidence|signal gate)\b/iu,
    );
    const edit = CODING_MARKDOWN_FINAL_LAB_TOOLS.find(
      (tool) => tool.function.name === "Edit",
    );
    expect(edit?.function.description).toContain(
      "source documents are read-only",
    );
  });

  it("renders a clean first draft without a refinement round", async () => {
    const { store, tools } = await setupFinalArm();
    expect(tools.LOCAL_ASSISTANT_TOOLS).toEqual(
      CODING_MARKDOWN_FINAL_LAB_TOOLS,
    );
    const source = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "price.docx",
      bytes: await docx([
        "1.01 Price.",
        "Purchase price is $392,500,000 minus $92,500,000, or $300,000,000.",
        "The first installment is $274,750,000 less $64,750,000, yielding a net first installment of $210,000,000.",
      ]),
    });
    const allowed = new Set([source.id]);
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const state = tools.createLocalAssistantRequirementsState();
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
        undefined,
        "Prepare the assessment.",
        state,
      );

    await run([
      { id: "read", name: "Read", input: { file_path: "price.docx" } },
    ]);
    const [rendered] = await run([
      {
        id: "render",
        name: "generate_docx",
        input: {
          title: "Assessment",
          markdown: "# Assessment\n\nThe 70% net installment is $210,000,000.",
        },
      },
    ]);

    expect(JSON.parse(rendered.mutationReceipt ?? "null")).toMatchObject({
      ok: true,
      action: "created",
      filename: "Assessment.docx",
    });
    expect(rendered.content).not.toMatch(/refine_check|COMPOSITION CHECK/u);
    expect(state.firstDraftCoverage).toEqual({
      bodyEvidence: ["price.docx"],
      tocOnly: [],
      unseen: [],
    });
    expect(state.signalGateCount).toBe(0);
    expect(state.compositionCheckCount).toBe(1);
  });

  it("reuses one document for repeated same-filename creates in a turn", async () => {
    const { store, tools } = await setupFinalArm(true);
    const state = tools.createLocalAssistantRequirementsState();
    const results = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "first",
          name: "generate_docx",
          input: { title: "Checklist", markdown: "# Checklist\n\nFirst." },
        },
        {
          id: "duplicate",
          name: "generate_docx",
          input: { title: "Checklist", markdown: "# Checklist\n\nDuplicate." },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(),
      undefined,
      "Prepare the checklist.",
      state,
    );

    const receipts = results.map((entry) =>
      JSON.parse(entry.mutationReceipt ?? "null"),
    );
    expect(receipts[0].document_id).toBe(receipts[1].document_id);
    expect(receipts[0].version_id).toBe(receipts[1].version_id);
    expect((await store.listLocalLibrary("local-user", "file")).documents).toHaveLength(1);
  });

  it("counts Grep body text, keeps TOC separate, pauses once, and refuses source edits", async () => {
    const { store, tools } = await setupFinalArm();
    const price = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "price.docx",
      bytes: await docx(["1.01 Price.", "Purchase price is $10,000."]),
    });
    const terms = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "terms.docx",
      bytes: await docx([
        "ARTICLE I",
        "1.01 Term.",
        "The agreement continues for five years.",
        "2.01 Termination.",
        "Either party may terminate on notice.",
      ]),
    });
    const allowed = new Set([price.id, terms.id]);
    const readState: import("../chat/localAssistantTools").LocalAssistantReadTurnState =
      new Map();
    const state = tools.createLocalAssistantRequirementsState();
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
        undefined,
        "Prepare two distinct deliverables.",
        state,
      );

    await run([
      {
        id: "grep",
        name: "Grep",
        input: {
          pattern: "Purchase price",
          path: "price.docx",
          output_mode: "content",
        },
      },
      {
        id: "toc",
        name: "Read",
        input: { file_path: "terms.docx.toc" },
      },
    ]);
    expect(tools.splitReadExposure(
      [
        { id: price.id, filename: "price.docx" },
        { id: terms.id, filename: "terms.docx" },
      ],
      readState,
    )).toEqual({
      read: ["price.docx"],
      orientedOnly: ["terms.docx"],
      unread: [],
    });

    const [paused] = await run([
      {
        id: "draft",
        name: "generate_docx",
        input: {
          title: "Risk assessment",
          markdown: "# Risk assessment\n\nPurchase price: $10,000.",
        },
      },
    ]);
    expect(paused.content).toContain(
      "1 source has no source text retrieved.",
    );
    expect(paused.content).toContain("TOC-only: terms.docx");
    expect(paused.content).not.toMatch(/\bgate\b/iu);
    expect(state.signalGateCount).toBe(1);
    expect(state.drafts["draft.md"]).toContain("$10,000");

    const [sourceEdit] = await run([
      {
        id: "source-edit",
        name: "Edit",
        input: {
          file_path: "price.docx",
          old_string: "$10,000",
          new_string: "$20,000",
        },
      },
    ]);
    expect(sourceEdit.content).toContain("Source files are immutable");
    expect(state.sourceEditCount).toBe(0);
    expect(state.sourceEditRefusalCount).toBe(1);

    const [draftEdit] = await run([
      {
        id: "draft-edit",
        name: "Edit",
        input: {
          file_path: "draft.md",
          old_string: "Purchase price: $10,000.",
          new_string: "Purchase price: $10,000. The agreement term is five years.",
        },
      },
    ]);
    expect(JSON.parse(draftEdit.content)).toMatchObject({ ok: true });

    const [first, second] = await run([
      {
        id: "first",
        name: "generate_docx",
        input: { title: "Risk assessment" },
      },
      {
        id: "second",
        name: "generate_docx",
        input: {
          title: "Action plan",
          markdown: "# Action plan\n\nConfirm the five-year term.",
        },
      },
    ]);
    const firstReceipt = JSON.parse(first.mutationReceipt ?? "null");
    const secondReceipt = JSON.parse(second.mutationReceipt ?? "null");
    expect(firstReceipt.filename).toBe("Risk assessment.docx");
    expect(secondReceipt.filename).toBe("Action plan.docx");
    expect(firstReceipt.source_sha256).not.toBe(secondReceipt.source_sha256);
    expect(state.signalGateCount).toBe(1);
  });
});
