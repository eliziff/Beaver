import { describe, expect, it } from "vitest";
import type { Document, Folder } from "@/app/components/shared/types";
import {
    buildDocumentTree,
    descendantFolderIds,
    documentTreeDropFolder,
    wouldCreateFolderCycle,
} from "./documentTree";

const folder = (id: string, name: string, parent_folder_id: string | null = null) =>
    ({ id, name, parent_folder_id } as Folder);
const file = (id: string, filename: string, folder_id: string | null = null) =>
    ({ id, filename, folder_id } as Document);

describe("documentTree", () => {
    it("flattens expanded rows in each consumer's existing order", () => {
        const folders = [folder("z", "Zulu"), folder("a", "Alpha")];
        const documents = [
            file("root", "Root.pdf"),
            file("child", "Child.pdf", "a"),
        ];
        const table = buildDocumentTree(documents, folders, new Set(["a"]), null);
        const explorer = buildDocumentTree(
            documents,
            folders,
            new Set(["a"]),
            null,
            "",
            true,
        );

        expect(table.rows.map((row) => row.kind === "document"
            ? row.document.id : row.kind === "folder" ? row.folder.id : "editor"))
            .toEqual(["root", "a", "child", "z", "editor"]);
        expect(explorer.rows.map((row) => row.kind === "document"
            ? row.document.id : row.kind === "folder" ? row.folder.id : "editor"))
            .toEqual(["editor", "a", "child", "z", "root"]);
        expect(table.rows.find((row) =>
            row.kind === "document" && row.document.id === "child")?.depth).toBe(1);
    });

    it("returns flat document matches for search", () => {
        const result = buildDocumentTree(
            [file("one", "Factum.pdf", "a"), file("two", "Order.docx")],
            [folder("a", "Appeal")],
            new Set(),
            undefined,
            "FACT",
        );

        expect(result.visibleDocuments.map(({ id }) => id)).toEqual(["one"]);
        expect(result.rows).toEqual([
            {
                kind: "document",
                document: expect.objectContaining({ id: "one" }),
                parentId: null,
                depth: 0,
            },
        ]);
    });

    it("finds folder descendants and rejects ancestry cycles", () => {
        const folders = [folder("a", "A"), folder("b", "B", "a")];
        const tree = buildDocumentTree([], folders, new Set());

        expect([...descendantFolderIds("a", tree.foldersByParent)]).toEqual([
            "a",
            "b",
        ]);
        expect(wouldCreateFolderCycle("a", "b", tree.folderById)).toBe(true);
        expect(wouldCreateFolderCycle("b", "a", tree.folderById)).toBe(false);
    });

    it("resolves delegated drops to the nearest containing folder", () => {
        const row = document.createElement("li");
        const child = document.createElement("span");
        row.dataset.treeDropFolder = "folder";
        row.append(child);

        expect(documentTreeDropFolder(child)).toBe("folder");
        row.dataset.treeDropFolder = "";
        expect(documentTreeDropFolder(child)).toBeNull();
    });
});
