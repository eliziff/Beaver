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
