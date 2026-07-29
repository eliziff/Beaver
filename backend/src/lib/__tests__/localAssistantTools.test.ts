import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.doUnmock("../tableOfAuthorities");
  vi.doUnmock("../convert");
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local assistant tools", () => {
  it("offers bounded deterministic DOCX actions", async () => {
    const { LOCAL_ASSISTANT_TOOLS } =
      await import("../chat/localAssistantTools");
    const names = LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name);

    expect(names).toContain("ask_inputs");
    expect(names).toContain("library_link_docx_citations");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_link_docx_citations",
      )?.function.description,
    ).toContain("do not read, split, classify, or construct citation URLs");
    expect(names).toContain("library_fix_docx_supras");
    expect(names).toContain("library_lint_docx_structure");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_lint_docx_structure",
      )?.function.description,
    ).toContain("receipt of what was checked");
    expect(names).toContain("provider_pdf_lookup");
    expect(names).toContain("library_create_docx");
    expect(names).toContain("library_revise_docx");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_revise_docx",
      )?.function.description,
    ).toContain("instead of replying with proposed or suggested changes");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_revise_docx",
      )?.function.parameters.required,
    ).toEqual(["document_id", "edits"]);
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "library_fix_docx_supras",
      )?.function.description,
    ).toContain("ambiguous/restarted/split cases");
    expect(names).toContain("toa_submit_library_document");
    expect(names).toContain("toa_job_status");
    expect(names).toContain("list_workflows");
    expect(names).toContain("read_workflow");
    expect(
      LOCAL_ASSISTANT_TOOLS.find(
        (tool) => tool.function.name === "toa_submit_library_document",
      )?.function.parameters.properties,
    ).not.toHaveProperty("path");
  });

  it("reads system workflow instructions in account-free mode", async () => {
    const tools = await import("../chat/localAssistantTools");
    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "workflow",
        name: "read_workflow",
        input: { workflow_id: "builtin-extract-key-terms" },
      },
    ]);

    expect(response.content).toContain("# Extract Key Terms");
    expect(response.content).toContain("uploaded documents");
  });

  it("creates and immutably revises a matter DOCX across reloads", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.doMock("../convert", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../convert")>()),
      docxToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 preview")),
    }));
    const graph = (
      await import("../legalKnowledgeGraphStore")
    ).legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      const allowedDocumentIds = new Set<string>();
      const tools = await import("../chat/localAssistantTools");

      const [createdResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-create",
            name: "library_create_docx",
            input: {
              title: "Opinion Draft",
              markdown:
                "# Background\n\nOriginal provision.\n\nEffective on {{effective_date}}.[^1]\n\n[^1]: The effective date remains editable.",
              fields: [
                {
                  id: "effective_date",
                  value: "July 27, 2026",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
        undefined,
        matter.id,
      );
      const created = JSON.parse(createdResponse.content);

      expect(created).toMatchObject({
        ok: true,
        receipt: "mike-document:v1",
        action: "created",
        version_number: 1,
        filename: "Opinion Draft.docx",
        file_type: "docx",
        attached_to_matter: true,
      });
      expect(created.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(created.download_url).toBe(
        `/single-documents/${created.document_id}/file?version_id=${created.version_id}`,
      );
      expect(created.app_url).toBeUndefined();
      // Card/URL etiquette lives once, in the system prompt; the receipt does
      // not re-teach it on every create.
      expect(created.next_required_action).toBeUndefined();
      expect(allowedDocumentIds).toContain(created.document_id);
      expect(graph.listMatterDocumentIds("local-user", matter.id)).toEqual([
        created.document_id,
      ]);

      const [draftingReadResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-drafting-read",
            name: "library_read",
            input: {
              document_id: created.document_id,
              mode: "drafting",
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      const draftingRead = JSON.parse(draftingReadResponse.content);

      expect(draftingRead).toMatchObject({
        ok: true,
        format: "beaver-precedent-html-v1",
        document_id: created.document_id,
        version_id: created.version_id,
      });
      expect(draftingRead.source_sha256).toBe(created.source_sha256);
      expect(draftingRead.html).toMatch(
        /<h1>(?:<strong>)?Background(?:<\/strong>)?<\/h1>/u,
      );
      expect(draftingRead.html).toContain("[^");

      const [revisedResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-revise",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: created.version_id,
              edits: [
                {
                  find: "Original",
                  replace: "Revised",
                  context_before: "",
                  context_after: " provision.",
                  reason: "Update the draft.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      const revised = JSON.parse(revisedResponse.content);

      expect(revised).toMatchObject({
        ok: true,
        receipt: "mike-document:v1",
        action: "revised",
        document_id: created.document_id,
        parent_version_id: created.version_id,
        version_number: 2,
        change_count: 1,
      });
      expect(revised.app_url).toBeUndefined();
      expect(revised.download_url).toBe(
        `/single-documents/${created.document_id}/file?version_id=${revised.version_id}`,
      );
      expect(revised.annotations).toMatchObject([
        {
          kind: "edit",
          document_id: created.document_id,
          version_id: revised.version_id,
          version_number: 2,
          deleted_text: "Original",
          inserted_text: "Revised",
          reason: "Update the draft.",
          status: "pending",
        },
      ]);
      expect(revised.annotations[0].edit_id).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(revised.next_required_action).toBeUndefined();
      expect(revised.version_id).not.toBe(created.version_id);
      expect(revised.source_sha256).toMatch(/^[a-f0-9]{64}$/u);

      const [noOpResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-no-op",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: revised.version_id,
              edits: [
                {
                  find: "Revised",
                  replace: "Revised",
                  context_before: "",
                  context_after: " provision.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(noOpResponse.content)).toEqual({
        ok: false,
        error: "No revision was saved",
        edit_errors: ["Every requested edit was a no-op"],
      });

      const [normalizedNoOpResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-normalized-no-op",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: revised.version_id,
              edits: [
                {
                  find: "Revised  provision.",
                  replace: "Revised provision.",
                  context_before: "",
                  context_after: "",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(normalizedNoOpResponse.content)).toEqual({
        ok: false,
        error: "No revision was saved",
        edit_errors: [
          {
            index: 0,
            reason: "Replacement does not change the matched text.",
          },
        ],
      });

      const [staleResponse] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-stale",
            name: "library_revise_docx",
            input: {
              document_id: created.document_id,
              version_id: created.version_id,
              edits: [
                {
                  find: "Original",
                  replace: "Stale",
                  context_before: "",
                  context_after: " provision.",
                },
              ],
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        allowedDocumentIds,
      );
      expect(JSON.parse(staleResponse.content)).toEqual({
        ok: false,
        error: "version_id is not the active version",
      });

      const liveStore = await import("../localDocumentStore");
      const spreadsheet = await liveStore.createLocalDocument({
        userId: "local-user",
        kind: "file",
        filename: "schedule.xlsx",
        bytes: Buffer.from("not-used-by-the-format-guard"),
      });
      allowedDocumentIds.add(spreadsheet.id);
      const [wrongVersionResponse, wrongFormatResponse] =
        await tools.runLocalAssistantTools(
          "local-user",
          [
            {
              id: "call-wrong-version",
              name: "library_revise_docx",
              input: {
                document_id: created.document_id,
                version_id: "missing-version",
                edits: [
                  {
                    find: "Revised",
                    replace: "Changed",
                    context_before: "",
                    context_after: " provision.",
                  },
                ],
              },
            },
            {
              id: "call-wrong-format",
              name: "library_revise_docx",
              input: {
                document_id: spreadsheet.id,
                version_id: spreadsheet.current_version_id,
                edits: [
                  {
                    find: "A",
                    replace: "B",
                    context_before: "",
                    context_after: "",
                  },
                ],
              },
            },
          ],
          undefined,
          undefined,
          undefined,
          undefined,
          allowedDocumentIds,
        );
      expect(JSON.parse(wrongVersionResponse.content)).toEqual({
        ok: false,
        error: "DOCX Library version not found",
      });
      expect(JSON.parse(wrongFormatResponse.content)).toEqual({
        ok: false,
        error: "Revision requires a DOCX Library version",
      });

      vi.resetModules();
      const reloadedStore = await import("../localDocumentStore");
      const trackedChanges = await import("../docxTrackedChanges");
      const versions = await reloadedStore.listLocalVersions(
        "local-user",
        created.document_id,
      );
      const original = await reloadedStore.getLocalVersionFile(
        "local-user",
        created.document_id,
        created.version_id,
      );
      const latest = await reloadedStore.getLocalVersionFile(
        "local-user",
        created.document_id,
        revised.version_id,
      );

      expect(versions?.current_version_id).toBe(revised.version_id);
      expect(versions?.versions).toHaveLength(2);
      expect(versions?.versions).toMatchObject([
        {
          id: created.version_id,
          provenance: {
            schema_version: 1,
            actor: "assistant",
            action: "created",
          },
        },
        {
          id: revised.version_id,
          provenance: {
            schema_version: 1,
            actor: "assistant",
            action: "revised",
            parent_version_id: created.version_id,
            change_count: 1,
          },
        },
      ]);
      const durableStore = JSON.parse(
        await readFile(path.join(temporaryDirectory, "library.json"), "utf8"),
      );
      expect(
        durableStore.documents[0].versions[0].provenance.generation,
      ).toMatchObject({
        rendererVersion: "beaver.docx-markdown.v1",
        markdownSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fieldValuesSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sourceRegistrySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        evidenceBindings: [],
      });
      expect(
        durableStore.documents[0].versions[1].provenance.trackedEdits,
      ).toMatchObject([
        {
          id: revised.annotations[0].edit_id,
          deletedText: "Original",
          insertedText: "Revised",
          status: "pending",
        },
      ]);
      expect(
        await trackedChanges.extractDocxBodyText(
          await readFile(original!.path),
        ),
      ).toContain("Original provision.");
      expect(
        await trackedChanges.extractDocxBodyText(await readFile(latest!.path)),
      ).toContain("Revised provision.");
    } finally {
      graph.close();
    }
  });

  it("rolls back a generated DOCX when matter attachment fails", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    vi.doMock("../convert", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../convert")>()),
      docxToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 preview")),
    }));
    const graph = (
      await import("../legalKnowledgeGraphStore")
    ).legalKnowledgeGraphStore();
    try {
      const matter = graph.createMatter("local-user", { name: "Appeal" });
      vi.spyOn(graph, "attachMatterDocument").mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
      const tools = await import("../chat/localAssistantTools");

      const [response] = await tools.runLocalAssistantTools(
        "local-user",
        [
          {
            id: "call-create",
            name: "library_create_docx",
            input: {
              title: "Unattached Draft",
              markdown: "Draft text.",
            },
          },
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        new Set<string>(),
        undefined,
        matter.id,
      );

      expect(JSON.parse(response.content)).toEqual({
        ok: false,
        error: "Could not attach document to matter",
      });
      expect(
        (
          await (
            await import("../localDocumentStore")
          ).listLocalLibrary("local-user", "file")
        ).documents,
      ).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("discovers documents in the local Beaver Library", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../localDocumentStore");
    const tools = await import("../chat/localAssistantTools");
    const graph = (
      await import("../legalKnowledgeGraphStore")
    ).legalKnowledgeGraphStore();
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "Chamberlain.pdf",
      bytes: Buffer.from("%PDF-1.4 test"),
    });

    try {
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
    } finally {
      try {
        await store.deleteLocalDocument("local-user", document.id);
      } finally {
        graph.close();
      }
    }
  });

  it("does not expose local paths for a missing evidence receipt", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const tools = await import("../chat/localAssistantTools");

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "call-evidence",
        name: "library_evidence",
        input: { handle: `mike-evidence:v1:${"a".repeat(64)}` },
      },
    ]);

    expect(JSON.parse(response.content)).toEqual({
      ok: false,
      error: "PDF evidence is unavailable",
    });
    expect(response.content).not.toContain(temporaryDirectory);
    expect(response.content).not.toContain("ENOENT");
  });

  it("submits only an owned Library DOCX version to the ToA bridge", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-tools-"));
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
      app_url: `/table-of-authorities?job=${jobId}`,
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
        app_url: `/table-of-authorities?job=${jobId}`,
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
