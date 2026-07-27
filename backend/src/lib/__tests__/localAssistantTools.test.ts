import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.doUnmock("../tableOfAuthorities");
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {
  it("offers bounded deterministic DOCX actions", async () => {
    const { LOCAL_ASSISTANT_TOOLS } = await import(
      "../chat/localAssistantTools"
    );
    const names = LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name);

    expect(names).toContain("library_link_docx_citations");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_link_docx_citations",
      )?.function.description,
    ).toContain("do not read, split, classify, or construct citation URLs");
    expect(names).toContain("library_fix_docx_supras");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_fix_docx_supras",
      )?.function.description,
    ).toContain("before asking the model");
    expect(names).toContain("toa_submit_library_document");
    expect(names).toContain("toa_job_status");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "toa_submit_library_document",
      )?.function.parameters.properties,
    ).not.toHaveProperty("path");
  });

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

  it("submits only an owned Library DOCX version to the ToA bridge", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const jobId = "a".repeat(32);
    const submit = vi.fn().mockResolvedValue({
      id: jobId,
      state: "running",
      operation: "detection",
      progress: 0,
      message: "Starting detection",
      error: "",
      has_review: false,
      split_fallback: "auto",
      files: [],
      open_path: `/table-of-authorities?job=${jobId}`,
    });
    vi.doMock("../tableOfAuthorities", () => ({
      submitTableOfAuthoritiesDocument: submit,
      getTableOfAuthoritiesJob: vi.fn(),
    }));
    const store = await import("../localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "factum.docx",
      bytes: Buffer.from("owned-docx-bytes"),
    });
    const tools = await import("../chat/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-toa",
        name: "toa_submit_library_document",
        input: {
          document_id: document.id,
          version_id: document.current_version_id,
          split_fallback: "auto",
        },
      },
    ]);

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({
      filename: "factum.docx",
      splitFallback: "auto",
    });
    expect(submit.mock.calls[0][0].bytes.toString()).toBe("owned-docx-bytes");
    expect(JSON.parse(response.content)).toMatchObject({
      ok: true,
      document_id: document.id,
      version_id: document.current_version_id,
      job: {
        id: jobId,
        open_path: `/table-of-authorities?job=${jobId}`,
      },
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
