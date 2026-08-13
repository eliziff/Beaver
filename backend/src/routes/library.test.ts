import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryStore } from "../lib/libraryStore";
import { createLibraryRouter } from "./library";

const scope = expect.objectContaining({
  userId: "00000000-0000-0000-0000-000000000001",
  kind: "file",
});

function fixture() {
  const store = {
    page: vi.fn().mockResolvedValue({ items: [], nextAfter: [1, "z", "v1"] }),
    upload: vi.fn().mockResolvedValue({ id: "d1", filename: "memo.txt" }),
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
  const app = express();
  app.use(express.json());
  app.use("/library", createLibraryRouter(store));
  return { app, store };
}

describe("canonical Library routes", () => {
  beforeEach(() => {
    process.env.AUTH_MODE = "anonymous";
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
    const { app, store } = fixture();
    expect((await request(app).post("/library/files/documents")
      .attach("file", Buffer.from("memo"), "memo.txt")).status).toBe(201);
    expect(store.upload).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ originalname: "memo.txt" }),
      "txt",
    );
    expect((await request(app).post("/library/files/documents")
      .attach("file", Buffer.from("bad"), "memo.exe")).status).toBe(400);
    expect(store.upload).toHaveBeenCalledTimes(1);
  });

  it("validates folder ancestry once and rejects cycles", async () => {
    const { app, store } = fixture();
    const created = await request(app).post("/library/files/folders")
      .send({ name: " Authorities ", parent_folder_id: "parent" });
    expect(created.status).toBe(201);
    expect(store.createFolder).toHaveBeenCalledWith(
      scope,
      "Authorities",
      "parent",
    );

    const cycle = await request(app).patch("/library/files/folders/parent")
      .send({ parent_folder_id: "child" });
    expect(cycle.status).toBe(400);
    expect(store.updateFolder).not.toHaveBeenCalled();
  });

  it("normalizes document annotations and preserves the filename extension", async () => {
    const { app, store } = fixture();
    const response = await request(app).patch("/library/files/documents/d1")
      .send({
        filename: " Lease ",
        metadata: {
          jurisdiction: " Alberta ",
          areas_of_law: ["Contracts", "Contracts", ""],
          document_types: ["Agreement"],
          description: " Summary ",
        },
        notes: " Privileged ",
      });
    expect(response.status).toBe(200);
    expect(store.updateDocument).toHaveBeenCalledWith(scope, "d1", {
      filename: "Lease.docx",
      metadata: {
        jurisdiction: "Alberta",
        areas_of_law: ["Contracts"],
        document_types: ["Agreement"],
        description: "Summary",
      },
      notes: "Privileged",
    });
  });
});
