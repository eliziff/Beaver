import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {
  it("discovers documents in the local Mike Library", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const tools = await import("../chat/localAssistantTools");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "Chamberlain.pdf",
      bytes: Buffer.from("%PDF-1.4 test"),
    });

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-1",
        name: "library_list",
        input: { query: "chamberlain" },
      },
    ]);

    expect(JSON.parse(response.content)).toMatchObject({
      ok: true,
      documents: [
        {
          document_id: document.id,
          filename: "Chamberlain.pdf",
        },
      ],
    });
  });
});
