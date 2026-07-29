import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedToolCall } from "../llm";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.doUnmock("../convert");
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

async function setup() {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-textops-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  vi.doMock("../convert", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../convert")>()),
    docxToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 preview")),
  }));
  return import("../chat/localAssistantTools");
}

const call = (input: Record<string, unknown>): NormalizedToolCall[] => [
  { id: "call-text-ops", name: "library_apply_text_ops", input },
];

describe("library_apply_text_ops tool flow", () => {
  it("is advertised with a server-side execution contract", async () => {
    const tools = await setup();
    const schema = tools.LOCAL_ASSISTANT_TOOLS.find(
      (tool) => tool.function.name === "library_apply_text_ops",
    );
    expect(schema).toBeDefined();
    expect(schema?.function.description).toContain("NEVER retype");
    expect(schema?.function.parameters.required).toEqual([
      "document_id",
      "ops",
    ]);
  });

  it("persists a tracked-change version through the library_revise_docx path", async () => {
    const tools = await setup();
    const [createdResponse] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-create",
        name: "library_create_docx",
        input: {
          title: "Case Transform Draft",
          markdown:
            "The governing law clause controls.\n\nThe parties agree the governing law of Ontario applies.",
        },
      },
    ]);
    const created = JSON.parse(createdResponse.content);
    expect(created.ok).toBe(true);

    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [
          {
            op: "uppercase",
            scope: { kind: "find_text", text: "governing law" },
          },
        ],
      }),
    );
    const applied = JSON.parse(response.content);

    expect(applied).toMatchObject({
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: created.document_id,
      parent_version_id: created.version_id,
      version_number: 2,
      change_count: 2,
      filename: created.filename,
      file_type: "docx",
      ops: [{ op: "uppercase", replacements: 2, unchanged_sites: [] }],
    });
    expect(applied.download_url).toBe(
      `/single-documents/${created.document_id}/file?version_id=${applied.version_id}`,
    );
    expect(applied.annotations).toHaveLength(2);
    for (const annotation of applied.annotations) {
      expect(annotation).toMatchObject({
        kind: "edit",
        document_id: created.document_id,
        version_id: applied.version_id,
        version_number: 2,
        deleted_text: "governing law",
        inserted_text: "GOVERNING LAW",
        reason: "uppercase",
        status: "pending",
      });
      expect(annotation.edit_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(annotation.del_w_id).toMatch(/^\d+$/u);
      expect(annotation.ins_w_id).toMatch(/^\d+$/u);
    }
    // Card/URL etiquette is a prompt rule, not restated per tool result; the
    // receipt carries only what the prompt cannot know.
    expect(applied.next_required_action).toContain("unchanged_sites");

    // The persisted version is accept/reject compatible via the store.
    const store = await import("../localDocumentStore");
    const resolved = await store.resolveLocalTrackedEdit({
      userId: "local-user",
      documentId: created.document_id,
      editId: applied.annotations[0].edit_id,
      mode: "accept",
    });
    expect(resolved.status).toBe("resolved");
    const file = await store.getLocalVersionFile(
      "local-user",
      created.document_id,
    );
    const { extractDocxBodyText } = await import("../docxTrackedChanges");
    const text = await extractDocxBodyText(await readFile(file!.path));
    expect(text).toContain("GOVERNING LAW clause controls");

    // A follow-up call without version_id uses the active version.
    const [secondResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [
          {
            op: "replace_text",
            scope: { kind: "whole_document" },
            find: "Ontario",
            replace: "Alberta",
          },
        ],
      }),
    );
    const second = JSON.parse(secondResponse.content);
    expect(second).toMatchObject({
      ok: true,
      action: "revised",
      version_number: 3,
      change_count: 1,
    });
  });

  it("reports no-ops, invalid ops, and stale versions without mutating", async () => {
    const tools = await setup();
    const [createdResponse] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-create",
        name: "library_create_docx",
        input: {
          title: "Static Draft",
          markdown: "already lowercase text where parties recieve notice.",
        },
      },
    ]);
    const created = JSON.parse(createdResponse.content);

    const [noOpResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [
          {
            op: "lowercase",
            scope: { kind: "find_text", text: "already lowercase text" },
          },
        ],
      }),
    );
    const noOp = JSON.parse(noOpResponse.content);
    expect(noOp).toMatchObject({
      ok: true,
      action: "no_changes",
      change_count: 0,
    });
    expect(noOp.ops[0].op).toBe("lowercase");

    // check_spelling is flag-only: a successful report, zero mutations.
    const [spellingResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [{ op: "check_spelling", scope: { kind: "whole_document" } }],
      }),
    );
    const spelling = JSON.parse(spellingResponse.content);
    expect(spelling).toMatchObject({
      ok: true,
      action: "no_changes",
      change_count: 0,
    });
    expect(spelling.ops[0].unchanged_sites).toMatchObject([
      { site: "recieve", reason: "possible misspelling" },
    ]);
    expect(spelling.ops[0].unchanged_sites[0].suggestions).toContain("receive");
    // How to correct a flagged word is taught once, in the op enum schema.
    expect(spelling.next_required_action).toContain("per-op notes");

    const [badOpResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [{ op: "delete_everything", scope: { kind: "whole_document" } }],
      }),
    );
    expect(JSON.parse(badOpResponse.content).error).toContain(
      "ops[0].op must be one of",
    );

    const [badScopeResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [{ op: "uppercase", scope: { kind: "find_text" } }],
      }),
    );
    expect(JSON.parse(badScopeResponse.content).error).toContain(
      "scope.text is required",
    );

    const [missingScopeTextResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        ops: [
          {
            op: "uppercase",
            scope: { kind: "find_text", text: "not in the document" },
          },
        ],
      }),
    );
    expect(JSON.parse(missingScopeTextResponse.content).error).toContain(
      "Scope text not found",
    );

    const [staleResponse] = await tools.runLocalAssistantTools(
      "local-user",
      call({
        document_id: created.document_id,
        version_id: "00000000-0000-0000-0000-000000000000",
        ops: [{ op: "uppercase", scope: { kind: "whole_document" } }],
      }),
    );
    expect(JSON.parse(staleResponse.content).error).toBe(
      "DOCX Library version not found",
    );

    const store = await import("../localDocumentStore");
    const versions = await store.listLocalVersions(
      "local-user",
      created.document_id,
    );
    expect(versions?.versions).toHaveLength(1);
  });
});
