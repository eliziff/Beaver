import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantSessionState } from "../assistantSession";

import { duplicateWorkProduct, getWorkProductResolution } from "./workProducts";
import { attachAuthorityPdf, uploadAuthoritiesDocument } from "./authorities";
import { uploadCourtRecordDocument, saveCourtRecordBuild } from "./courtRecords";
import { removeProjectDocument, directoryResource } from "./documents";
import { apiBlobRequest } from "./client";
import { startTabularGeneration } from "./tabular";
import { getChat, deleteChat } from "./chat";

afterEach(() => vi.unstubAllGlobals());

function respond(value: unknown, status = 200) {
  const request = vi.fn<typeof fetch>(async () => Response.json(value, { status }));
  vi.stubGlobal("fetch", request);
  return request;
}

describe("duplicateWorkProduct", () => {
  it("preserves the selected project context", async () => {
    const fetchMock = respond({ id: "draft-copy" });

    await expect(duplicateWorkProduct("draft-1", { title: "Record copy", projectId: "matter-1" }))
      .resolves.toEqual({ id: "draft-copy" });

    expect(fetchMock).toHaveBeenCalledWith("/api/work-products/draft-1/duplicate",
      expect.objectContaining({ method: "POST", body: JSON.stringify({
        title: "Record copy", project_id: "matter-1",
      }) }));
  });
});

describe("getWorkProductResolution", () => {
  it("uses the durable nested-resolution endpoint", async () => {
    const fetchMock = respond({
      product: { id: "draft/1" }, freshness: "stale", inputs: {}, dependencies: [],
    });

    await expect(getWorkProductResolution("draft/1")).resolves.toEqual({
      product: { id: "draft/1" }, freshness: "stale", inputs: {}, dependencies: [],
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/work-products/draft%2F1/resolution");
  });
});

describe("work-product uploads", () => {
  it("carries the selected authority source language", async () => {
    const fetchMock = respond({ id: "draft-1" });

    const file = new File(["%PDF-1.7"], "French.pdf", { type: "application/pdf" });

    await expect(attachAuthorityPdf("draft-1", "case-1", 3, file, "fr"))
      .resolves.toEqual({ id: "draft-1" });

    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("revision")).toBe("3");
    expect(body.get("language")).toBe("fr");
    expect(body.get("file")).toBe(file);
  });

  it("carries Court Draft and Authorities Project context in multipart fields", async () => {
    const fetchMock = respond({ id: "document-1" });

    const file = new File(["record"], "record.pdf", { type: "application/pdf" });

    await expect(uploadCourtRecordDocument(file, "record-1")).resolves.toEqual({ id: "document-1" });
    await expect(uploadAuthoritiesDocument(file, "matter-1")).resolves.toEqual({ id: "document-1" });

    expect((fetchMock.mock.calls[0][1]?.body as FormData).get("work_product_id"))
      .toBe("record-1");
    expect((fetchMock.mock.calls[1][1]?.body as FormData).get("projectId"))
      .toBe("matter-1");
  });

  it("sends a Court build as one repeated-file request", async () => {
    const fetchMock = respond({
      id: "record-1", revision: 4,
    });

    const receipt = { schemaVersion: "beaver.work-product-build.v2",
      output: { role: "record" } } as never;

    await expect(saveCourtRecordBuild([{ file: new File(["record"], "Record.pdf"), receipt }]))
      .resolves.toEqual({ id: "record-1", revision: 4 });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/court-records/builds");
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect((body.get("files") as File).name).toBe("Record.pdf");
    expect(JSON.parse(String(body.get("receipts")))).toEqual(receipt);
  });
});

describe("removeProjectDocument", () => {
  it("uses the local removal route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(removeProjectDocument("matter-1", "document-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/matter-1/documents/document-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("directoryResource", () => {
  it("uses one encoded directory contract for project and library storage", async () => {
    const fetchMock = respond({ items: [], next_cursor: null });

    await expect(directoryResource({ projectId: "matter/1" }).list({ parent_id: "folder/1" }))
      .resolves.toEqual({ items: [], next_cursor: null });
    await expect(directoryResource({ library: "files" }).list())
      .resolves.toEqual({ items: [], next_cursor: null });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/matter%2F1/directory?parent_id=folder%2F1",
      "/api/library/files",
    ]);
  });

  it("recreates a selected folder tree before uploading its files", async () => {
    let folder = 0, document = 0, leaseAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const value = String(url);
      if (value.endsWith("/folders")) return new Response(JSON.stringify({
        id: `folder-${++folder}`,
      }), { headers: { "Content-Type": "application/json" } });
      if (value.endsWith("/documents")) {
        const file = (init?.body as FormData).get("file") as File;
        if (file.name === "lease.pdf" && leaseAttempts++ === 0) {
          return new Response("failed", { status: 500 });
        }
        return new Response(JSON.stringify({ id: `document-${++document}` }),
          { headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = (name: string, relativePath: string) => {
      const value = new File([name], name);
      Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
      return value;
    };

    const resource = directoryResource({ library: "files" });
    const files = [
      file("lease.pdf", "Matter/Contracts/lease.pdf"),
      file("notes.docx", "Matter/notes.docx"),
    ];
    await expect(resource.uploadDirectory(files)).rejects.toThrow();
    await resource.uploadDirectory(files);

    const folderBodies = fetchMock.mock.calls.slice(0, 2).map(([, init]) =>
      JSON.parse(String(init?.body)));
    expect(folderBodies).toEqual([
      { name: "Matter", parent_folder_id: null },
      { name: "Contracts", parent_folder_id: "folder-1" },
    ]);
    const uploads = fetchMock.mock.calls.slice(2).map(([, init]) => {
      const body = init?.body as FormData;
      return [String((body.get("file") as File).name), body.get("folder_id")];
    });
    expect(uploads).toEqual(expect.arrayContaining([
      ["lease.pdf", "folder-2"],
      ["notes.docx", "folder-1"],
    ]));
    expect(uploads.filter(([name]) => name === "lease.pdf")).toHaveLength(2);
    expect(uploads.filter(([name]) => name === "notes.docx")).toHaveLength(1);
  });
});

describe("apiBlobRequest", () => {
  it("preserves native Headers values and overrides", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("file"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiBlobRequest("/health", {
      headers: new Headers({ Accept: "text/plain", "X-Test": "kept" }),
    });

    expect(await result.blob.text()).toBe("file");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("accept")).toBe("text/plain");
    expect(headers.get("x-test")).toBe("kept");
  });

  it("preserves structured API failure details for tabular agents", async () => {
    respond({
      code: "missing_api_key",
      detail: "Configure a provider",
      provider: "openai",
    }, 401);

    await expect(startTabularGeneration("review-1")).rejects.toMatchObject({
      name: "BeaverApiError",
      message: "Configure a provider",
      status: 401,
      code: "missing_api_key",
      details: { provider: "openai" },
    });
  });
});

describe("getChat", () => {
  it("keeps crafted identifiers inside their route segment", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteChat("../user/account?confirm=true")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/chat/..%2Fuser%2Faccount%3Fconfirm%3Dtrue",
    );
  });

  it("settles work left running by an interrupted backend turn", async () => {
    respond({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [
        { id: "user-1", role: "user", turn_id: "turn-1", content: "Research this" },
        {
          id: "assistant-1",
          role: "assistant",
          turn_id: "turn-1",
          content: [{
            type: "subagent_run",
            id: "scout:1",
            task: "Research",
            status: "running",
            activities: [{ id: "read-1", tool: "read", label: "Reading", status: "running" }],
          }],
        },
      ],
    });

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });
    const assistant = state.messages[1];

    expect(messages[0].turn_id).toBe("turn-1");
    expect(assistant).toMatchObject({
      turnId: "turn-1",
      turnStatus: "interrupted",
      activities: [expect.objectContaining({
        id: "reader:scout:1",
        status: "interrupted",
      })],
    });
    expect(state.readers[0]).toMatchObject({ id: "scout:1", status: "interrupted" });
  });

  it("keeps cancellation metadata out of assistant prose", async () => {
    respond({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [{
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "content", text: "Partial answer." },
          { type: "content", text: "Continued answer." },
          { type: "turn_status", status: "cancelled" },
        ],
      }],
    });

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });

    expect(state.messages[0]).toMatchObject({
      turnStatus: "cancelled",
      blocks: [
        expect.objectContaining({ text: "Partial answer." }),
        expect.objectContaining({ text: "Continued answer." }),
      ],
    });
    expect(state.messages[0].role === "assistant" ? state.messages[0].blocks.map(({ text }) => text).join("\n\n") : "").toBe("Partial answer.\n\nContinued answer.");
  });

  it("marks a durable user turn with no response as interrupted", async () => {
    respond({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [{
        id: "user-1",
        role: "user",
        turn_id: "turn-1",
        content: "Research this",
      }],
    });

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });

    expect(messages[0]).toMatchObject({
      turn_id: "turn-1",
    });
    expect(state.rejectedTurn?.message).toMatchObject({ turnId: "turn-1" });
  });
});
