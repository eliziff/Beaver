import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actOnResearchSet,
  createResearchSet,
  listResearchSets,
  promoteChatResearch,
  runResearchSetQuery,
} from "./beaverApi";

afterEach(() => vi.unstubAllGlobals());

const response = () => new Response(JSON.stringify({ id: "set-1" }), {
  headers: { "Content-Type": "application/json" },
});

describe("research set API", () => {
  it("lists only research metadata", async () => {
    const fetchMock = vi.fn(async () => response()); vi.stubGlobal("fetch", fetchMock);
    await listResearchSets();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work-products?kind=research-set&metadata=true&limit=100",
      expect.anything(),
    );
  });

  it("lets the server initialize the canonical research state", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await createResearchSet({ title: "Duty of fairness", projectId: "matter-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/work-products", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        kind: "research-set",
        title: "Duty of fairness",
        project_id: "matter-1",
      }),
    }));
  });

  it("uses the revision-checked research action endpoint", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const action = { type: "annotate" as const, kind: "source" as const,
      id: "00000000-0000-4000-8000-000000000001", note: "Key case" };

    await actOnResearchSet("set/1", 4, action);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work-products/set%2F1/research-actions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ revision: 4, action }) }),
    );
  });

  it("runs a scoped query and promotes optional chat query receipts", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await runResearchSetQuery("set-1", {
      revision: 4, text: "good faith", syntax: "terms", target: "sources",
      sourceIds: ["source-1"], labelIds: ["label-1"], limit: 500,
    });
    await promoteChatResearch({ chatId: "chat-1", researchSetId: "set-1",
      revision: 5, includeQueries: true });

    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ revision: 4, text: "good faith", syntax: "terms",
        target: "sources", sourceIds: ["source-1"], labelIds: ["label-1"], limit: 500 }),
    }));
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ revision: 5, includeQueries: true }),
    }));
  });
});
