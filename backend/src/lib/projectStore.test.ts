import { describe, expect, it } from "vitest";
import { projectDocuments, type ProjectStore } from "./projectStore";

describe("project document membership", () => {
  it("collects paged project documents with their nested folder paths", async () => {
    const projects = {
      async get(_scope, id) { return id === "p1" ? { id } : null; },
      async directory(_scope, _id, { parentFolderId, after }) {
        return parentFolderId ? { items: [{ kind: "document", document: { id: "nested" } }], nextAfter: null }
          : after ? { items: [{ kind: "document", document: { id: "second" } }], nextAfter: null }
          : { items: [{ kind: "folder", folder: { id: "folder", name: "Evidence" } },
            { kind: "document", document: { id: "first" } }], nextAfter: [0, "first", "first"] };
      },
    } as ProjectStore;
    expect(await projectDocuments(projects, { userId: "owner" }, "p1")).toEqual([
      { id: "first" }, { id: "second" }, { id: "nested", folder_path: "Evidence" },
    ]);
    expect(await projectDocuments(projects, { userId: "owner" }, "missing")).toBeNull();
  });

});
