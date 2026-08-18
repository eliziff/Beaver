import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/localMode", () => ({ isAnonymousLocalMode: () => true }));
vi.mock("../lib/localPdfIngestion", () => ({
  queueLocalPdfParse: vi.fn(async () => ({
    status: "queued",
  })),
  removeLocalPdfParseArtifacts: vi.fn(async () => undefined),
}));
vi.mock("../lib/convert", () => ({
  docxToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 preview")),
}));

let temporaryDirectory: string | null = null;

afterEach(async () => {
  try {
    (await import("../lib/localApplicationDatabase"))
      .closeLocalApplicationDatabase();
  } catch {}
  delete process.env.AUTH_MODE;
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.OPEN_LEGAL_DATA_HOME;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local document version replacement", () => {
  it("omits stale assistant provenance from the replace and versions APIs", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-local-api-"),
    );
    process.env.AUTH_MODE = "anonymous";
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    process.env.OPEN_LEGAL_DATA_HOME = temporaryDirectory;
    const store = await import("../lib/localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "00000000-0000-0000-0000-000000000001",
      kind: "file",
      filename: "draft.xlsx",
      bytes: Buffer.from("assistant-created"),
      provenance: {
        schemaVersion: 1,
        actor: "assistant",
        action: "created",
      },
    });
    const [{ createDocumentsRouter }, { localLibraryStore, localDocuments },
      { localDocumentExtensionsRouter }] = await Promise.all([
      import("./documentRoutes"),
      import("../lib/localLibraryStore"),
      import("./localDocuments"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/single-documents", localDocumentExtensionsRouter);
    app.use("/single-documents", createDocumentsRouter(
      localLibraryStore,
      localDocuments,
    ));

    const replacement = await request(app)
      .put(
        `/single-documents/${document.id}/versions/${document.current_version_id}/file`,
      )
      .attach("file", Buffer.from("user-replacement"), "draft.xlsx");
    const versions = await request(app).get(
      `/single-documents/${document.id}/versions`,
    );

    expect(replacement.status).toBe(200);
    expect(replacement.body.provenance).toBeUndefined();
    expect(versions.status).toBe(200);
    expect(versions.body.versions[0].provenance).toBeUndefined();
  });

  it("accepts a durable assistant tracked edit through the local API", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-local-redline-"),
    );
    process.env.AUTH_MODE = "anonymous";
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    process.env.OPEN_LEGAL_DATA_HOME = temporaryDirectory;
    const [{ renderMarkdownDocx }, tracked, store] = await Promise.all([
      import("../lib/chat/tools/documentOps"),
      import("../lib/docxTrackedChanges"),
      import("../lib/localDocumentStore"),
    ]);
    const rendered = await renderMarkdownDocx(
      "Draft",
      "Original provision.",
      [],
    );
    if ("error" in rendered) throw new Error(rendered.error);
    const document = await store.createLocalDocument({
      userId: "00000000-0000-0000-0000-000000000001",
      kind: "file",
      filename: "draft.docx",
      bytes: rendered.bytes,
    });
    const edited = await tracked.applyTrackedEdits(rendered.bytes, [
      {
        find: "Original",
        replace: "Revised",
        context_before: "",
        context_after: " provision.",
      },
    ]);
    const change = edited.changes[0];
    const editId = crypto.randomUUID();
    const version = await store.addLocalVersion({
      userId: "00000000-0000-0000-0000-000000000001",
      documentId: document.id,
      filename: "draft.docx",
      bytes: edited.bytes,
      provenance: {
        schemaVersion: 1,
        actor: "assistant",
        action: "revised",
        parentVersionId: document.current_version_id,
        changeCount: 1,
        trackedEdits: [
          {
            id: editId,
            changeId: change.id,
            delWId: change.delId,
            insWId: change.insId,
            deletedText: change.deletedText,
            insertedText: change.insertedText,
            contextBefore: change.contextBefore,
            contextAfter: change.contextAfter,
            diff: change.diff,
            status: "pending",
          },
        ],
      },
    });
    const [{ createDocumentsRouter }, { localLibraryStore, localDocuments },
      { localDocumentExtensionsRouter }] = await Promise.all([
      import("./documentRoutes"),
      import("../lib/localLibraryStore"),
      import("./localDocuments"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/single-documents", localDocumentExtensionsRouter);
    app.use("/single-documents", createDocumentsRouter(
      localLibraryStore,
      localDocuments,
    ));

    const accepted = await request(app).post(
      `/single-documents/${document.id}/edits/${editId}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      status: "accepted",
      version_id: version!.id,
      version_number: 2,
    });
    expect(accepted.body.download_url).toContain("&rev=");

    const current = await store.getLocalVersionFile(
      "00000000-0000-0000-0000-000000000001",
      document.id,
      version!.id,
    );
    const text = await tracked.extractDocxBodyText(
      await readFile(current!.path),
    );
    expect(text).toContain("Revised provision.");
    expect(text).not.toContain("Original provision.");
    await expect(
      store.localTrackedEditStatuses(
        "00000000-0000-0000-0000-000000000001",
        [document.id],
      ),
    ).resolves.toMatchObject([
      {
        editId,
        status: "accepted",
        versionNumber: 2,
      },
    ]);

    const chats = await import("../lib/anonymousChatStore");
    const chat = chats.createAnonymousChat(
      "00000000-0000-0000-0000-000000000001",
    );
    chats.appendAnonymousMessage(chat, {
      role: "assistant",
      content: [
        {
          type: "doc_edited",
          filename: "draft.docx",
          document_id: document.id,
          version_id: version!.id,
          version_number: 2,
          download_url: accepted.body.download_url,
          edit_mode: "manual",
          annotations: [
            {
              kind: "edit",
              edit_id: editId,
              document_id: document.id,
              version_id: version!.id,
              version_number: 2,
              change_id: change.id,
              deleted_text: "Original",
              inserted_text: "Revised",
              diff: change.diff,
              status: "pending",
            },
          ],
        },
      ],
    });
    const [
      { createChatRouter },
      { localTabularData },
      { createLocalChatStore },
      { createChatApplication },
      { localChatApplicationFeatures },
      { localProjects },
    ] = await Promise.all([
      import("./chat"),
      import("../lib/localTabularStore"),
      import("../lib/localChatStore"),
      import("../lib/chat/chatApplication"),
      import("../lib/chat/localChatApplicationFeatures"),
      import("../lib/localProjectStore"),
    ]);
    const chatStore = createLocalChatStore(localTabularData);
    const application = createChatApplication({
      chats: chatStore,
      documents: localDocuments,
      library: localLibraryStore,
      projects: localProjects,
      tabular: localTabularData,
      features: localChatApplicationFeatures,
    });
    const chatApp = express();
    chatApp.use(express.json());
    chatApp.use("/chat", createChatRouter(
      localTabularData,
      chatStore,
      application,
    ));
    const reloaded = await request(chatApp).get(`/chat/${chat.id}`);
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body.messages[0].content[0].annotations[0].status,
    ).toBe("accepted");
  });
});
