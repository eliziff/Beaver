import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
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
    async readParts() { return [{ bytes: state.part }]; },
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
  const run = createLibreOfficeApplication(options, async () => ({ candidate,
    report: { ok: true, reopened: true, snapshot: hash(bytes), candidate_sha256: hash(candidate) } }));
  const preview = () => run({ action: "preview", file_path, snapshot: hash(bytes), operations: [] }, signal);
  const apply = () => run({ action: "apply", file_path, preview_resource: "document://preview/version/p1" }, signal);
  return { state, options, run, preview, apply };
}

test("preview preserves source; apply publishes the exact candidate once", async () => {
  const f = fixture(); const preview = await f.preview();
  assert.equal(f.state.head, "v1"); assert.equal(f.state.saves, 0);
  assert.equal(preview.report.original_unchanged, true);
  const applied = await f.apply();
  assert.equal(applied.report.mode, "direct"); assert.equal(f.state.saves, 1);
  assert.equal(f.state.published, "v2");
  assert.equal((await f.apply()).report.already_applied, true); assert.equal(f.state.saves, 1);
});

test("manual review mode refuses direct publication without invoking the store", async () => {
  const f = fixture("manual"); await f.preview();
  await assert.rejects(f.apply(), /Direct mode/); assert.equal(f.state.saves, 0);
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
