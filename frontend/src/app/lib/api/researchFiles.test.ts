import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actOnResearchFile,
  bindWorkspaceView,
  createResearchFile,
  getResearchItems,
  runResearchFileQuery,
} from "@/app/lib/api/researchFiles";
import {
  checkpointDocumentVersion,
  deleteDocument,
  restoreDocumentVersion,
  uploadDocumentVersion,
} from "@/app/lib/api/documents";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("research file API", () => {
  it("creates a Sources workspace through the workspace application", async () => {
    const fetchMock = vi.fn(async () => json({ document: { id: "file-1", filename: "Fairness.research.md" },
      versionId: "version-1", workingRevision: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createResearchFile({ title: "Fairness", projectId: "project-1" }))
      .resolves.toMatchObject({ versionId: "version-1", workingRevision: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/source-workspaces");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ title: "Fairness", projectId: "project-1" });
  });

  it("version-checks edits and queries, and binds views to the workspace", async () => {
    const fetchMock = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetchMock);
    await actOnResearchFile("file/1", "v1", 3, { type: "note", markdown: "Note" });
    await runResearchFileQuery("file/1", { versionId: "v2", workingRevision: 4,
      text: "fairness", syntax: "terms", target: "sources" });
    await bindWorkspaceView("file/1", { chatId: "chat/1", selection: { target: "sources", sourceIds: ["s1"] } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/source-workspaces/file%2F1/actions",
      "/api/source-workspaces/file%2F1/query",
      "/api/source-workspaces/file%2F1/bind",
    ]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.slice(0, 2).map(({ version_id, working_revision }) => [version_id, working_revision]))
      .toEqual([["v1", 3], ["v2", 4]]);
    expect(bodies[1]).not.toHaveProperty("versionId");
    expect(bodies[2]).toEqual({ chatId: "chat/1", selection: { target: "sources", sourceIds: ["s1"] } });
  });

  it("pages v2 parts without reconstructing them from the root file", async () => {
    const fetchMock = vi.fn(async () => json({ items: [], next_cursor: null, total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await getResearchItems("file/1", { kind: "passages",
      sourceId: "source/1", cursor: "next page", limit: 25 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/source-workspaces/file%2F1/items?kind=passages&source_id=source%2F1&cursor=next+page&limit=25");
  });

  it("carries the version head and revision through document writes", async () => {
    const fetchMock = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetchMock);
    const file = new File(["draft"], "draft.docx");
    await uploadDocumentVersion("file/1", file, "v1", 6);
    await restoreDocumentVersion("file/1", "v1", "v2", 9);
    await checkpointDocumentVersion("file/1", "v3", 10, "Before filing");

    const bodies = fetchMock.mock.calls.map(([, init]) => init?.body);
    expect(bodies.slice(0, 1).map((body) => [
      (body as FormData).get("expected_current_version_id"),
      (body as FormData).get("expected_working_revision"),
    ])).toEqual([["v1", "6"]]);
    expect(bodies.slice(1).map((body) => JSON.parse(String(body))))
      .toEqual([
        { expected_current_version_id: "v2", expected_working_revision: 9 },
        { expected_current_version_id: "v3", expected_working_revision: 10,
          comment: "Before filing" },
      ]);
  });

  it("version-checks permanent document deletion in its current location", async () => {
    const fetchMock = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetchMock);
    await deleteDocument({ id: "file/1", project_id: null, folder_id: "folder-1",
      filename: "draft.docx", file_type: "docx", pdf_storage_path: null, size_bytes: 1,
      page_count: 1, created_at: null, current_version_id: "v3",
      current_working_revision: 10 });

    expect(fetchMock).toHaveBeenCalledWith("/api/single-documents/file%2F1",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({
        expected_current_version_id: "v3", expected_working_revision: 10,
        expected_project_id: null, expected_folder_id: "folder-1",
      }) }));
  });
});
