import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentStore } from "../lib/documentStore";
import type { LibraryStore } from "../lib/libraryStore";
import type { ProjectStore } from "../lib/projectStore";
import { folderOrganizePlan, type FolderDesign, type FolderDesigner } from "../lib/folderOrganize";
import { createLibraryRouter } from "./library";
import { createProjectsRouter } from "./projects";

const files = [
  { id: "d1", filename: "Share purchase agreement.docx" },
  { id: "d2", filename: "Disclosure schedule.docx" },
  { id: "d3", filename: "Employment offer - Chen.docx" },
  { id: "d4", filename: "Retention agreement - Diaz.docx" },
];
const design: FolderDesign = {
  folders: [{ key: "a", name: "Acquisition" }, { key: "b", name: "Employment" }],
  filings: [{ folderKey: "a", documentIds: ["d1", "d2"] }, { folderKey: "b", documentIds: ["d3", "d4"] }],
};
const documentStore = () => ({
  projectionSource: vi.fn().mockResolvedValue(null),
} as unknown as DocumentStore);

function library(designer: FolderDesigner) {
  const store = {
    page: vi.fn().mockImplementation(async (_scope, { parentFolderId }) => ({
      items: parentFolderId ? [] : files.map((document) => ({ kind: "document", document })),
      nextAfter: null,
    })),
    createFolder: vi.fn().mockImplementation(async (_scope, name) => ({ id: `folder-${name}` })),
    moveDocument: vi.fn().mockResolvedValue({ id: "d1" }),
  } as unknown as LibraryStore;
  const app = express();
  app.use(express.json());
  app.use("/library", createLibraryRouter(store, documentStore(), designer));
  return { app, store };
}

function project(designer: FolderDesigner) {
  const store = {
    get: vi.fn().mockResolvedValue({ id: "p1" }),
    directory: vi.fn().mockImplementation(async (_scope, _id, { parentFolderId }) => ({
      items: parentFolderId ? [] : files.map((document) => ({ kind: "document", document })),
      nextAfter: null,
    })),
    createFolder: vi.fn().mockImplementation(async (_scope, _id, { name }) => ({ id: `folder-${name}` })),
    moveDocument: vi.fn().mockResolvedValue({ id: "d1" }),
  } as unknown as ProjectStore;
  const app = express();
  app.use(express.json());
  app.use("/projects", createProjectsRouter(store, {} as never, documentStore(), designer));
  return { app, store };
}

describe("Organize for a library and a project", () => {
  beforeEach(() => { process.env.AUTH_MODE = "local"; });

  it("proposes folders from the lawyer's instruction and then files the documents", async () => {
    const designer = vi.fn().mockResolvedValue(design);
    const { app, store } = library(designer);
    const preview = await request(app).post("/library/files/organize/preview")
      .send({ instruction: "organize by workstream" });
    expect(preview.status).toBe(200);
    expect(designer.mock.calls[0][2]).toBe("organize by workstream");
    expect(preview.body.folders.map((folder: { name: string }) => folder.name)).toEqual(["Acquisition", "Employment"]);
    expect(preview.body.folders[0].documents).toHaveLength(2);
    expect(preview.body.unfiled).toEqual([]);

    const applied = await request(app).post("/library/files/organize/apply")
      .send({ fingerprint: preview.body.fingerprint, design: preview.body.design });
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ folders: 2, moved: 4 });
    expect(store.createFolder).toHaveBeenCalledTimes(2);
    expect(store.moveDocument).toHaveBeenCalledTimes(4);
  });

  it("organizes a project the same way", async () => {
    const { app, store } = project(vi.fn().mockResolvedValue(design));
    const preview = await request(app).post("/projects/p1/organize/preview")
      .send({ instruction: "organize by workstream" });
    expect(preview.status).toBe(200);
    const applied = await request(app).post("/projects/p1/organize/apply")
      .send({ fingerprint: preview.body.fingerprint, design: preview.body.design });
    expect(applied.status).toBe(200);
    expect(store.moveDocument).toHaveBeenCalledTimes(4);
  });

  it("refuses to apply a proposal made before the files changed", async () => {
    const { app } = library(vi.fn().mockResolvedValue(design));
    const stale = await request(app).post("/library/files/organize/apply")
      .send({ fingerprint: "0".repeat(64), design });
    expect(stale.status).toBe(409);
  });

  it("streams the proposal's progress to the modal that asked for one", async () => {
    const designer: FolderDesigner = async (_scope, _documents, _instruction, options) => {
      options.progress?.({ stage: "asking", model: "test-model", chars: 12 });
      return design;
    };
    const { app } = library(vi.fn(designer));
    const stream = await request(app).post("/library/files/organize/preview")
      .set("Accept", "text/event-stream").send({ instruction: "by workstream" });
    expect(stream.text).toContain('"stage":"reading"');
    expect(stream.text).toContain('"stage":"asking"');
    expect(stream.text).toContain('"done":true');
  });
});

describe("a proposal that organizes nothing", () => {
  const bad = (value: FolderDesign) => () => folderOrganizePlan(value, files);

  it("refuses a structure that files nothing, groups nothing, or restates one file", () => {
    expect(bad({ folders: [{ key: "a", name: "Everything" }], filings: [] })).toThrow(/files nothing/);
    expect(bad({ folders: [{ key: "a", name: "Everything" }],
      filings: [{ folderKey: "a", documentIds: ["d1", "d2", "d3", "d4"] }] })).toThrow(/groups nothing/);
    expect(bad({ folders: [{ key: "a", name: "Share purchase agreement" }, { key: "b", name: "Other" }],
      filings: [{ folderKey: "a", documentIds: ["d1", "d2"] }, { folderKey: "b", documentIds: ["d3", "d4"] }] }))
      .toThrow(/names one file/);
    expect(bad({ folders: [{ key: "a", name: "Acquisition" }, { key: "b", name: "Employment" }],
      filings: [{ folderKey: "a", documentIds: ["d1", "d2"] }, { folderKey: "b", documentIds: ["d1", "d3", "d4"] }] }))
      .toThrow(/filed in two folders/);
  });
});
