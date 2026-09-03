import { afterEach, describe, expect, it, vi } from "vitest";
import { actOnResearchFile, createResearchFile, promoteChatResearch, runResearchFileQuery } from "./beaverApi";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("research file API", () => {
  it("creates a normal Library Markdown document", async () => {
    const fetchMock = vi.fn(async () => json({ id: "file-1", filename: "Fairness.research.md",
      file_type: "md", project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
      created_at: null, current_version_id: "version-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await createResearchFile({ title: "Fairness" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/library/files/documents");
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect((body.get("file") as File).name).toBe("Fairness.research.md");
  });

  it("version-checks edits, queries, and chat saves on the document", async () => {
    const fetchMock = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetchMock);
    await actOnResearchFile("file/1", "v1", { type: "note", markdown: "Note" });
    await runResearchFileQuery("file/1", { versionId: "v2", text: "fairness", syntax: "terms", target: "sources" });
    await promoteChatResearch({ chatId: "chat/1", researchFileId: "file/1", versionId: "v3", includeQueries: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/single-documents/file%2F1/research/actions",
      "/api/single-documents/file%2F1/research/query",
      "/api/chat/chat%2F1/research-files/file%2F1/promote",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).map((body) => body.version_id ?? body.versionId))
      .toEqual(["v1", "v2", "v3"]);
  });
});
