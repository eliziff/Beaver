import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureOntologyWorkspace,
  getOntologyWorkspace,
  getWorkspaceMembership,
} from "@/app/lib/api/ontology";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("ontology API", () => {
  it("resolves the ontology workspace without creating one", async () => {
    const fetchMock = vi.fn(async () => json(null)); vi.stubGlobal("fetch", fetchMock);
    await expect(getOntologyWorkspace()).resolves.toBeNull();
    await expect(getOntologyWorkspace("project-1")).resolves.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/source-workspaces/ontology",
      "/api/source-workspaces/ontology?project_id=project-1",
    ]);
  });

  it("creates the ontology workspace and reads membership for visible documents", async () => {
    const fetchMock = vi.fn(async () => json({})); vi.stubGlobal("fetch", fetchMock);
    await ensureOntologyWorkspace("project-1");
    await getWorkspaceMembership(["doc-1", "doc-2"], "project-1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/source-workspaces/ontology",
      "/api/source-workspaces/membership?project_id=project-1&document_ids=doc-1%2Cdoc-2",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ projectId: "project-1" });
  });
});
