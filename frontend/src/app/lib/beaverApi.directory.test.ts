import { expect, it, vi } from "vitest";
import type { DirectoryEntry, DirectoryList } from "./beaverApi";
import { listDirectoryDocuments } from "./beaverApi";
import type { Document, Folder } from "@/app/components/shared/types";

const doc = (id: string, folder_id: string | null) =>
  ({ id, filename: `${id}.pdf`, folder_id }) as Document;
const folder = (id: string, parent_folder_id: string | null) =>
  ({ id, name: id, parent_folder_id }) as Folder;

it("pages and recursively resolves every document in a directory scope", async () => {
  const pages = new Map<string, { items: DirectoryEntry[]; next_cursor: string | null }>([
    ["root:", { items: [{ kind: "document", document: doc("root", null) },
      { kind: "folder", folder: folder("a", null) }], next_cursor: "next" }],
    ["root:next", { items: [{ kind: "folder", folder: folder("b", null) }], next_cursor: null }],
    ["a:", { items: [{ kind: "document", document: doc("inside-a", "a") },
      { kind: "folder", folder: folder("nested", "a") }], next_cursor: null }],
    ["b:", { items: [{ kind: "document", document: doc("inside-b", "b") }], next_cursor: null }],
    ["nested:", { items: [{ kind: "document", document: doc("deep", "nested") }], next_cursor: null }],
  ]);
  const list = vi.fn<DirectoryList>(async ({ parent_id = null, cursor = null } = {}) =>
    pages.get(`${parent_id ?? "root"}:${cursor ?? ""}`) ?? { items: [], next_cursor: null });

  const result = await listDirectoryDocuments(list);

  expect(result.map(({ id }) => id).sort()).toEqual(["deep", "inside-a", "inside-b", "root"]);
  expect(list).toHaveBeenCalledTimes(5);
});
