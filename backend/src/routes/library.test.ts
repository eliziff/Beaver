import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import { createLibraryRouter } from "./library";

const scope = expect.objectContaining({
  userId: "00000000-0000-0000-0000-000000000001",
  kind: "file",
});

function fixture() {
  const store = {
    page: vi.fn().mockResolvedValue({ items: [], nextAfter: [1, "z", "v1"] }),
    folder: vi.fn().mockImplementation(async (_scope, id) => ({
      id,
      parent_folder_id: id === "child" ? "parent" : null,
    })),
    createFolder: vi.fn().mockResolvedValue({ id: "f1", parent_folder_id: null }),
    updateFolder: vi.fn().mockResolvedValue({ id: "f1", parent_folder_id: null }),
    deleteFolder: vi.fn().mockResolvedValue(true),
    document: vi.fn().mockResolvedValue({ id: "d1", filename: "lease.docx" }),
    moveDocument: vi.fn().mockResolvedValue({ id: "d1", filename: "lease.docx" }),
    updateDocument: vi.fn().mockResolvedValue({ id: "d1", filename: "Lease.docx" }),
  } satisfies LibraryStore;
  const documents = {
    create: vi.fn().mockResolvedValue({ id: "d1", filename: "memo.txt" }),
  } as unknown as DocumentStore;
  const app = express();
  app.use(express.json());
  app.use("/library", createLibraryRouter(store, documents));
  return { app, store, documents };
}

describe("canonical Library routes", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "local";
  });

  it("owns paging and binds cursors to the requested collection", async () => {
    const { app, store } = fixture();
    const first = await request(app).get("/library/files?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.next_cursor).toEqual(expect.any(String));

    const second = await request(app).get("/library/files").query({
      limit: 1,
      cursor: first.body.next_cursor,
    });
    expect(second.status).toBe(200);
    expect(store.page).toHaveBeenLastCalledWith(scope, {
      q: "",
      parentFolderId: null,
      limit: 1,
      after: [1, "z", "v1"],
    });
    expect((await request(app).get("/library/files").query({
      q: "lease",
      cursor: first.body.next_cursor,
    })).status).toBe(400);
  });

  it("applies the same upload validation before either store", async () => {
    const { app, documents } = fixture();
    expect((await request(app).post("/library/files/documents")
      .attach("file", Buffer.from("memo"), "memo.txt")).status).toBe(201);
    expect(documents.create).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ filename: "memo.txt", fileType: "txt" }),
    );
    expect((await request(app).post("/library/files/documents")
      .attach("file", Buffer.from("bad"), "memo.exe")).status).toBe(400);
    expect(documents.create).toHaveBeenCalledTimes(1);
  });

  it("creates folders through the canonical Library route", async () => {
    const { app, store } = fixture();
    const created = await request(app).post("/library/files/folders")
      .send({ name: " Authorities ", parent_folder_id: "parent" });
    expect(created.status).toBe(201);
    expect(store.createFolder).toHaveBeenCalledWith(
      scope,
      "Authorities",
      "parent",
    );
  });
});
