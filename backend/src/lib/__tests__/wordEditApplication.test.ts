import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DocumentStore } from "../documentStore";
import { createWordEditApplication } from "../wordEditApplication";

const file_path = "document://source/version/v1";
const bytes = Buffer.from("original"), candidate = Buffer.from("verified candidate");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const signal = new AbortController().signal;

function fixture(editMode: "manual" | "auto" = "auto") {
  const state = { head: "v1", working: 0, part: Buffer.alloc(0), creates: 0, saves: 0, modes: [] as unknown[],
    published: "", bytes: candidate, race: false, changes: 1 };
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
      return { id: "preview", current_version_id: "p1", active_version_number: 1, filename: "preview.docx" };
    },
    async readParts(_scope: unknown, id: string) { return id === "preview" && state.part.length ? [{ bytes: state.part }] : []; },
    async addVersion(_scope: unknown, _id: string, input: { bytes: Buffer; expectedCurrentSha256: string }) {
      if (state.race || !input.bytes.equals(candidate) || input.expectedCurrentSha256 !== hash(bytes)) return null;
      state.saves++; state.head = "v2";
      return { id: "v2", version_number: 2, working_revision: 0 };
    },
  } as unknown as DocumentStore;
  const options = { documents, userId: "user", editMode, allowedDocumentIds: new Set(["source"]),
    docIndex: { "doc-0": { document_id: "source", filename: "test.docx", version_id: "v1" } },
    onMutationCommitted() {}, onPublished(_id: string, version: string) { state.published = version; } };
  const run = createWordEditApplication(options, async (_bytes, request) => {
    const mode = editMode === "manual" ? "tracked" : "direct";
    state.modes.push(request.mode);
    return { candidate, report: { ok: true, reopened: true, snapshot: hash(bytes),
      candidate_sha256: hash(candidate), mode: mode + "-candidate", review_verified: mode === "tracked", change_count: state.changes } };
  });
  // The model's mode argument is ignored: the user's setting decides.
  const preview = () => run({ action: "preview", file_path, snapshot: hash(bytes), program: "return True", mode: "direct" }, signal);
  const apply = () => run({ action: "apply", file_path: "document://preview/version/p1" }, signal);
  return { state, options, run, preview, apply };
}

describe("Word edit application", () => {
  it("files a preview without touching the source and publishes its exact candidate once", async () => {
    const f = fixture();
    await expect(f.run({ action: "preview", file_path, snapshot: hash(bytes) }, signal)).rejects.toThrow(/program/u);
    await expect(f.run({ action: "apply", file_path }, signal)).rejects.toThrow(/pass the preview's artifact/u);
    f.state.changes = 0;
    expect((await f.preview()).report.no_changes).toBe(true); expect(f.state.creates).toBe(0);
    f.state.changes = 1;
    expect((await f.preview()).report.original_unchanged).toBe(true);
    expect(f.state).toMatchObject({ head: "v1", saves: 0 });
    await expect(f.run({ action: "preview", file_path, snapshot: "0".repeat(64), program: "return 1" }, signal))
      .rejects.toThrow(/changed since/u);
    expect((await f.apply()).report.mode).toBe("direct");
    expect((await f.apply()).report.already_applied).toBe(true);
    expect(f.state).toMatchObject({ saves: 1, published: "v2" });
  });

  it("publishes only verified native revisions in Review mode, whatever the model asks", async () => {
    const f = fixture("manual"); await f.preview();
    expect(f.state.modes).toEqual(["tracked"]);
    expect((await f.apply()).report.mode).toBe("tracked");
    const other = fixture("manual"); await other.preview();
    const receipt = JSON.parse(other.state.part.toString());
    receipt.mode = "direct"; receipt.report.mode = "direct-candidate"; receipt.report.review_verified = false;
    other.state.part = Buffer.from(JSON.stringify(receipt));
    await expect(other.apply()).rejects.toThrow(/Review mode requires/u); expect(other.state.saves).toBe(0);
  });

  it("keeps the original on a stale head, a commit-time race or a tampered candidate", async () => {
    const f = fixture(); await f.preview(); f.state.head = "someone-else";
    await expect(f.apply()).rejects.toThrow(/Source changed/u);
    f.state.head = "v1"; f.state.race = true;
    await expect(f.apply()).rejects.toThrow(/no longer writable/u);
    f.state.race = false; f.state.bytes = Buffer.from("tampered");
    await expect(f.apply()).rejects.toThrow(/receipt does not match/u);
    expect(f.state.saves).toBe(0);
  });

  it("refuses documents outside the selection, naming the attached ones, and restricted research", async () => {
    const f = fixture();
    await expect(f.run({ action: "inspect", file_path: "document://sourse/version/v1" }, signal))
      .rejects.toThrow(/no document in the selected scope; test\.docx is document:\/\/source\/version\/v1/u);
    await expect(f.run({ action: "inspect", file_path }, signal, true)).rejects.toThrow(/restricted research/u);
    f.options.allowedDocumentIds.clear();
    await expect(f.preview()).rejects.toThrow(/no document in the selected scope/u);
    expect(f.state).toMatchObject({ creates: 0, saves: 0 });
    const cancelled = fixture(), aborted = new AbortController(); aborted.abort();
    await expect(cancelled.run({ action: "preview", file_path, program: "return 1" }, aborted.signal)).rejects.toThrow();
    expect(cancelled.state).toMatchObject({ creates: 0, saves: 0, modes: [] });
  });
});
