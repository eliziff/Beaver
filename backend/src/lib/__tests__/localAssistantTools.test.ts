import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.unstubAllGlobals();
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

  it("keeps A2AJ link provenance private while collecting lookup evidence", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence.`,
    ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 1",
              source_url_en: "https://example.test/case",
              unofficial_text_en: text,
            },
          ],
        }),
      }),
    );
    const tools = await import("../chat/localAssistantTools");
    const evidence: import("../a2aj").A2AJLocatorLookup[] = [];

    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: "a2aj_lookup",
          input: {
            citation: "2099 SCC 1",
            locator_type: "paragraph",
            locator: "3",
          },
        },
      ],
      evidence,
    );
    const modelResult = JSON.parse(response.content);

    expect(modelResult.ok).toBe(true);
    expect(modelResult).not.toHaveProperty("url");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].url).toBe("https://example.test/case");
  });
});
