import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Paragraph } from "docx";
import { createLibreOfficeApplication } from "../../src/lib/libreOfficeApplication";
import type { DocumentStore } from "../../src/lib/documentStore";

const file_path = "document://source/version/v1";
const bytes = Buffer.from("original"), candidate = Buffer.from("verified candidate");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const signal = new AbortController().signal;
function fixture(editMode: "manual" | "auto" = "auto") {
  const state = { head: "v1", working: 0, part: Buffer.alloc(0), creates: 0, saves: 0,
    published: "", bytes: candidate, race: false };
  const documents = {
    async metadata(_scope: unknown, id: string) {
      return { id, current_version_id: id === "source" ? state.head : "p1", current_working_revision: state.working,
        filename: "test.docx", project_id: null, library_kind: "file" };
    },
    async read(_scope: unknown, id: string, version: string) {
      return { bytes: id === "source" ? bytes : state.bytes, fileType: "docx", filename: "test.docx",
        version: { id: version, working_revision: 0 } };
    },
    async create(_scope: unknown, input: { bytes: Buffer; parts: { bytes: Buffer }[] }) {
      state.creates++; state.part = input.parts[0].bytes;
      assert.equal(input.bytes, candidate);
      return { id: "preview", current_version_id: "p1", active_version_number: 1, filename: "preview.docx" };
    },
    async readParts(_scope: unknown, id: string) { return id === "preview" && state.part.length ? [{ bytes: state.part }] : []; },
    async addVersion(_scope: unknown, id: string, input: { bytes: Buffer; expectedCurrentVersionId: string;
      expectedCurrentWorkingRevision: number; expectedCurrentSha256: string }) {
      assert.equal(id, "source"); assert.equal(input.bytes, candidate);
      assert.equal(input.expectedCurrentVersionId, "v1");
      assert.equal(input.expectedCurrentWorkingRevision, 0); assert.equal(input.expectedCurrentSha256, hash(bytes));
      if (state.race) return null;
      state.saves++; state.head = "v2";
      return { id: "v2", version_number: 2, working_revision: 0 };
    },
  } as unknown as DocumentStore;
  const options = { documents, userId: "user", editMode, allowedDocumentIds: new Set(["source"]),
    onMutationCommitted() {}, onPublished(_id: string, version: string) { state.published = version; } };
  const run = createLibreOfficeApplication(options, async (_bytes, request) => {
    const mode = editMode === "manual" ? "tracked" : "direct";
    assert.equal(request.mode, mode, "The application setting, not model input, determines mode");
    return { candidate, report: { ok: true, reopened: true, snapshot: hash(bytes),
      candidate_sha256: hash(candidate), mode: mode + "-candidate", review_verified: mode === "tracked" } };
  });
  const preview = () => run({ action: "preview", file_path, snapshot: hash(bytes), program: "return true;", mode: "direct" }, signal);
  const apply = () => run({ action: "apply", file_path: "document://preview/version/p1" }, signal);
  return { state, options, run, preview, apply };
}

test("preview preserves source; apply publishes the exact candidate once", async () => {
  const f = fixture();
  await assert.rejects(f.run({ action: "preview", file_path, snapshot: hash(bytes) }, signal), /program/);
  await assert.rejects(f.run({ action: "apply", file_path }, signal), /pass the preview's artifact/);
  const preview = await f.preview();
  assert.equal(f.state.head, "v1"); assert.equal(f.state.saves, 0);
  assert.equal(preview.report.original_unchanged, true);
  await assert.rejects(f.run({ action: "preview", file_path, snapshot: "0".repeat(64), program: "return 1;" }, signal), /changed since/);
  const applied = await f.apply();
  assert.equal(applied.report.mode, "direct"); assert.equal(f.state.saves, 1);
  assert.equal(f.state.published, "v2");
  assert.equal((await f.apply()).report.already_applied, true); assert.equal(f.state.saves, 1);
});

test("manual mode publishes only verified native revisions and cannot be overridden by model input", async () => {
  const f = fixture("manual"); await f.preview();
  assert.equal((await f.apply()).report.mode, "tracked"); assert.equal(f.state.saves, 1);
  const other = fixture("manual"); await other.preview();
  const receipt = JSON.parse(other.state.part.toString());
  receipt.mode = "direct"; receipt.report.mode = "direct-candidate"; receipt.report.review_verified = false;
  other.state.part = Buffer.from(JSON.stringify(receipt));
  await assert.rejects(other.apply(), /Review mode requires/); assert.equal(other.state.saves, 0);
});

test("stale head and a commit-time race both preserve the original", async () => {
  const f = fixture(); await f.preview(); f.state.head = "someone-else";
  await assert.rejects(f.apply(), /Source changed/); assert.equal(f.state.saves, 0);
  f.state.head = "v1"; f.state.race = true;
  await assert.rejects(f.apply(), /no longer writable/); assert.equal(f.state.saves, 0);
});

test("tampered candidate, revoked scope and restricted selections are refused", async () => {
  const f = fixture(); await f.preview(); f.state.bytes = Buffer.from("tampered");
  await assert.rejects(f.apply(), /receipt does not match/); assert.equal(f.state.saves, 0);
  f.options.allowedDocumentIds.clear();
  await assert.rejects(f.preview(), /outside the selected scope/);
  await assert.rejects(f.run({ action: "inspect", file_path }, signal, true), /restricted research/);
});

test("cancellation before execution does not create or publish a document", async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.run({ action: "inspect", file_path }, abort.signal));
  assert.equal(f.state.creates, 0); assert.equal(f.state.saves, 0);
});

test("real chat tools share artifacts, native edits and durable document versions", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"), path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-uno-chat-"));
  const previous = { auth: process.env.AUTH_MODE, data: process.env.MIKE_LOCAL_DATA_DIR };
  process.env.AUTH_MODE = "local"; process.env.MIKE_LOCAL_DATA_DIR = directory;
  const { closeRelationalDatabase } = await import("../../src/lib/relationalDatabase");
  try {
    const { createChatToolRunner } = await import("../../src/lib/chat/chatToolRunner");
    const { TurnToolRegistry } = await import("../../src/lib/chat/toolRegistry");
    const { createLegalEvidenceTurnState } = await import("../../src/lib/chat/legalEvidence");
    const { createSourceWorkspaceApplication } = await import("../../src/lib/sourceWorkspaceApplication");
    const { localDocuments: documents, localLibraryStore: library, localProjects: projects,
      createLocalDocument } = await import("../../src/lib/__tests__/support/localDocumentFixtures");
    const { docxBytes, docxXml } = await import("../../src/lib/__tests__/support/docxFixtures");
    const source = await createLocalDocument({ userId: "local-user", kind: "file", filename: "native.docx",
      bytes: await docxBytes([new Paragraph("Original provision.")]) });
    const allowedDocumentIds = new Set([source.id]);
    const scope = { userId: "local-user" }, evidence = createLegalEvidenceTurnState();
    const context = { evidence, operation: { executor: "assistant" as const }, emit() {}, addEvent() {} };
    const runner = createChatToolRunner({ ...scope, documents, library, projects, allowedDocumentIds,
      includeResearchTools: false, editMode: "auto", onMutationCommitted() {},
      sources: createSourceWorkspaceApplication(documents, { chats: {} as never, tables: {} as never,
        tabular: async () => { throw new Error("No table in this document fixture"); } }) });
    const registry = new TurnToolRegistry(runner.createTools(evidence, "main", context));
    let id = 0;
    const call = async (name: string, input: Record<string, unknown>) => {
      const [result] = await registry.run([{ id: String(++id), name, input }], context);
      assert.equal(result.status, "ok", `${name}: ${result.content}`);
      return JSON.parse(result.content);
    };
    await call("load_tools", { names: ["word_uno", "edit_docx_advanced", "document_operation", "compare_versions"] });
    const edited = await call("Edit", { file_path: `document://${source.id}/version/${source.current_version_id}`,
      old_string: "Original", new_string: "Surgical" });
    const original = await documents.read(scope, source.id, null, false);
    assert.ok(edited.resource.includes(source.id));
    await call("document_operation", { action: "metadata", kind: "file", document_id: edited.artifact, notes: "Reviewed" });
    assert.equal((await documents.metadata(scope, source.id))!.current_working_revision, original!.version.working_revision);
    const inspected = await call("word_uno", { action: "inspect", file_path: edited.artifact });
    const preview = await call("word_uno", { action: "preview", file_path: edited.artifact, snapshot: inspected.snapshot,
      program: "const p=word.target('paragraph:0'); p.set({String:'Intermediate clause.',CharHeight:14}); p.set({CharHeight:14,String:'Native clause.'}); return p.get(['String','CharHeight']);" });
    assert.deepEqual(preview.result, { String: "Native clause.", CharHeight: 14 });
    assert.equal(preview.reopened, true);
    assert.deepEqual((await documents.read(scope, source.id, null, false))!.bytes, original!.bytes);
    const checked = await call("word_uno", { action: "inspect", file_path: preview.artifact,
      program: "return word.target('paragraph:0').get(['String','CharHeight']);" });
    assert.deepEqual(checked.result, preview.result);
    // A preview of the candidate still revises the original; apply needs only that candidate.
    const refined = await call("word_uno", { action: "preview", file_path: preview.artifact,
      program: "word.target('paragraph:0').CharWeight = 150; return word.target('paragraph:0').CharWeight;" });
    assert.equal(refined.result, 150); assert.equal(refined.source, preview.source);
    const applied = await call("word_uno", { action: "apply", file_path: refined.artifact });
    const candidate = await documents.read(scope, refined.resource.split('/')[2], null, false);
    assert.deepEqual((await documents.read(scope, source.id, null, false))!.bytes, candidate!.bytes);
    await call("Edit", { file_path: edited.artifact, old_string: "Native", new_string: "Final" });
    await call("edit_docx_advanced", { file_path: edited.artifact,
      ops: [{ op: "replace_text", find: "clause", replace: "provision", scope: { kind: "whole_document" } }] });
    const comparison = await call("compare_versions", { document_id: edited.artifact, baseline: edited.resource });
    assert.ok(comparison.changes_total > 0);
    const final = await documents.read(scope, source.id, null, false);
    const xml = await docxXml(final!.bytes);
    assert.match(xml, /Final/); assert.match(xml, /provision/); assert.match(xml, /w:sz w:val="28"/);
    assert.equal((await call("word_uno", { action: "apply", file_path: refined.resource })).already_applied, true);
    assert.equal((await documents.read(scope, source.id, null, false))!.version.id, final!.version.id);
    // Stale snapshots and revoked scope still fail through the production registry.
    const [stale] = await registry.run([{ id: String(++id), name: "word_uno", input: { action: "preview",
      file_path: edited.artifact, snapshot: inspected.snapshot, program: "return true;" } }], context);
    assert.equal(stale.status, "error"); assert.match(stale.content, /changed since/);
    allowedDocumentIds.clear();
    const [revoked] = await registry.run([{ id: String(++id), name: "word_uno",
      input: { action: "inspect", file_path: applied.resource } }], context);
    assert.equal(revoked.status, "error"); assert.match(revoked.content, /selected scope/);
  } finally {
    await closeRelationalDatabase();
    for (const [key, value] of [["AUTH_MODE", previous.auth], ["MIKE_LOCAL_DATA_DIR", previous.data]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
