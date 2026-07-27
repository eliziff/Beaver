import crypto from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let temporaryDirectory: string | null = null;

const documentId = "document-1";
const versionId = "version-1";
const cacheKey = "c".repeat(64);
const parserVersion = "0.1.0";
const parserConfigVersion = "fixture-v1";

async function writeJsonLines(filePath: string, rows: object[]) {
  await writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

async function fixture() {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-lookup-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  const sourceRelative = path.join(
    "files",
    documentId,
    `${versionId}-fixture.pdf`,
  );
  const source = path.join(temporaryDirectory, sourceRelative);
  const sourceBytes = Buffer.from("%PDF-1.4 exact lookup fixture");
  const sourceSha256 = crypto
    .createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  const artifactRoot = `${source}.legalpdf`;
  const output = path.join(artifactRoot, cacheKey);
  const manifestPath = path.join(output, "document.json");
  const statePath = `${source}.legalpdf-state.json`;
  const pages = Array.from({ length: 22 }, (_, index) => ({
    id: `page-${index + 1}`,
    index,
    number: index + 1,
    text_quality: index === 1 ? 0.82 : 0.98,
    source: "native",
    lines:
      index === 21
        ? []
        : index === 0
          ? [
              { reading_order: 2, text: "Second line." },
              { reading_order: 1, text: "First line." },
            ]
          : [{ reading_order: 1, text: `Page ${index + 1} text.` }],
  }));
  const paragraphs = [
    {
      id: "section_7",
      page_index: 0,
      region_type: "heading",
      text: "Section 7 General rule",
    },
    {
      id: "paragraph-rule",
      page_index: 0,
      region_type: "body",
      text: "The rule applies. \u27e6FN:fn-a\u27e7",
    },
    {
      id: "section_7__subsection_1",
      page_index: 1,
      region_type: "heading",
      text: "Subsection 7(1) Exception",
    },
    {
      id: "paragraph-exception",
      page_index: 1,
      region_type: "body",
      text: "The exception is narrow.",
    },
    {
      id: "section_8",
      page_index: 2,
      region_type: "heading",
      text: "Section 8 Remedy",
    },
    {
      id: "section_9_first",
      page_index: 2,
      region_type: "heading",
      text: "Section 9 First version",
    },
    {
      id: "section_9_second",
      page_index: 3,
      region_type: "heading",
      text: "Section 9 Second version",
    },
  ];
  const sections = paragraphs
    .filter((row) => row.region_type === "heading")
    .map((row) => ({ ...row, provenance: "heading-region" }));
  const footnotes = [
    {
      pair_id: "fn-a",
      label: "1",
      occurrence: 1,
      restart_sequence: 1,
      reference_page: 1,
      body_pages: [2],
      body: "First note body.",
      sentence_proposition: "The rule applies.",
      passage_since_prior_note: "The rule applies.",
      confidence: 0.97,
      provenance: "deterministic",
      warnings: [],
    },
    {
      pair_id: "fn-c",
      label: "2",
      occurrence: 1,
      restart_sequence: 1,
      reference_page: 2,
      body_pages: [2],
      body: "Second note body.",
      sentence_proposition: "A second proposition.",
      passage_since_prior_note: "A second proposition.",
      confidence: 0.95,
      provenance: "deterministic",
      warnings: ["wrapped-body"],
    },
    {
      pair_id: "fn-symbol",
      label: "*",
      occurrence: 1,
      restart_sequence: 1,
      reference_page: 2,
      body_pages: [2],
      body: "Symbol note body.",
      sentence_proposition: "A symbol proposition.",
      passage_since_prior_note: "A symbol proposition.",
      confidence: 0.93,
      provenance: "deterministic",
      warnings: [],
    },
    {
      pair_id: "fn-b",
      label: "1",
      occurrence: 2,
      restart_sequence: 2,
      reference_page: 3,
      body_pages: [3],
      body: "Restarted note body.",
      sentence_proposition: "The numbering restarted.",
      passage_since_prior_note: "The numbering restarted.",
      confidence: 0.91,
      provenance: "deterministic",
      warnings: [],
    },
  ];
  const parserConfig = {
    parser_version: parserVersion,
    parser_config_version: parserConfigVersion,
    parser_config: {
      mode: "local",
      ocr_provider: null,
      model: null,
      prompt_version: null,
      text_fidelity_root: null,
      text_fidelity_native: false,
    },
    cache_key: cacheKey,
    source_sha256: sourceSha256,
  };
  const manifest = {
    schema_version: "legalpdf.document.v1",
    parser_version: parserVersion,
    document_id: "parsed-document",
    source_sha256: sourceSha256,
    status: "ready",
    artifacts: {
      pages: "pages.jsonl",
      paragraphs: "paragraphs.jsonl",
      sections: "sections.jsonl",
      footnotes: "footnotes.jsonl",
      parser_config: "parser-config.json",
    },
  };
  const state = {
    schema_version: "mike.pdf_parse.v1",
    job_id: "job-1",
    document_id: documentId,
    version_id: versionId,
    status: "ready",
    source_path: sourceRelative,
    source_sha256: sourceSha256,
    parser_version: parserVersion,
    parser_config_version: parserConfigVersion,
    parser_config: parserConfig.parser_config,
    cache_key: cacheKey,
    artifact_manifest: path.relative(temporaryDirectory, manifestPath),
    attempts: 1,
    queued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    flat_text_fallback_available: true,
  };

  await mkdir(output, { recursive: true });
  await writeFile(source, sourceBytes);
  await Promise.all([
    writeJsonLines(path.join(output, "pages.jsonl"), pages),
    writeJsonLines(path.join(output, "paragraphs.jsonl"), paragraphs),
    writeJsonLines(path.join(output, "sections.jsonl"), sections),
    writeJsonLines(path.join(output, "footnotes.jsonl"), footnotes),
    writeFile(manifestPath, JSON.stringify(manifest), "utf8"),
    writeFile(
      path.join(output, "parser-config.json"),
      JSON.stringify(parserConfig),
      "utf8",
    ),
    writeFile(statePath, JSON.stringify(state), "utf8"),
    writeFile(
      path.join(temporaryDirectory, "library.json"),
      JSON.stringify({
        version: 1,
        folders: [],
        legalSources: [],
        documents: [
          {
            id: documentId,
            userId: "local-user",
            kind: "file",
            folderId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            currentVersionId: versionId,
            versions: [
              {
                id: versionId,
                versionNumber: 1,
                source: "upload",
                createdAt: "2026-01-01T00:00:00.000Z",
                filename: "fixture.pdf",
                fileType: "pdf",
                sizeBytes: sourceBytes.length,
                pageCount: 22,
                storagePath: sourceRelative,
                pdfStoragePath: sourceRelative,
                sourceSha256,
              },
            ],
          },
        ],
      }),
      "utf8",
    ),
  ]);
  return {
    source,
    statePath,
    manifestPath,
    parserConfigPath: path.join(output, "parser-config.json"),
    pagesPath: path.join(output, "pages.jsonl"),
    footnotesPath: path.join(output, "footnotes.jsonl"),
    state,
    manifest,
    parserConfig,
  };
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("exact local PDF structure lookup", () => {
  it("returns exact page ranges, paragraph neighbors, and stable evidence receipts", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");

    const pages = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "pages 1\u20132",
    });
    expect(pages).toMatchObject({
      status: "found",
      exact: true,
      units: [
        {
          locator: "[page 1]",
          text: "[page 1]\nFirst line.\nSecond line.",
          page_numbers: [1],
        },
        { locator: "[page 2]", page_numbers: [2], confidence: 0.82 },
      ],
      source: {
        document_id: documentId,
        version_id: versionId,
        source_sha256: built.state.source_sha256,
        cache_key: cacheKey,
      },
      link: {
        page_numbers: [1, 2],
        artifact_ids: ["page-1", "page-2"],
      },
    });
    expect(pages.status === "found" && pages.link.href).toContain(
      `version_id=${versionId}#page=1`,
    );

    const repeated = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
      endLocator: "2",
    });
    expect(repeated.status === "found" && repeated.evidence.handle).toBe(
      pages.status === "found" ? pages.evidence.handle : "",
    );

    const paragraph = await lookupLocalPdfStructure(built.source, {
      locatorKind: "paragraph",
      locator: "\u00b6 2",
      contextBlocks: 1,
    });
    expect(paragraph).toMatchObject({
      status: "found",
      units: [
        {
          id: "paragraph-rule",
          locator: "paragraph 2",
          text: "The rule applies.",
          page_numbers: [1],
        },
      ],
      before: [{ id: "section_7" }],
      after: [{ id: "section_7__subsection_1" }],
    });
  });

  it("pairs notes with propositions and refuses to guess restarted labels", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "footnote",
        locator: "footnote 1",
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      exact: false,
      matches: ["fn-a", "fn-b"],
    });

    const resolved = await lookupLocalPdfStructure(built.source, {
      locatorKind: "footnote",
      locator: "1",
      occurrence: 2,
    });
    expect(resolved).toMatchObject({
      status: "found",
      units: [
        {
          id: "fn-b",
          text: "Restarted note body.",
          proposition: {
            sentence: "The numbering restarted.",
            passage_since_prior_note: "The numbering restarted.",
          },
          note: {
            label: "1",
            occurrence: 2,
            restart_sequence: 2,
            reference_page: 3,
          },
        },
      ],
    });

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "footnote",
        locator: "note *",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [{ id: "fn-symbol", text: "Symbol note body." }],
    });

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "footnote",
        locator: "fn-a",
        endLocator: "fn-c",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [{ id: "fn-a" }, { id: "fn-c" }],
    });
  });

  it("persists a version-bound evidence receipt and fails closed after artifact drift", async () => {
    const built = await fixture();
    const {
      lookupLocalPdfStructure,
      readLocalPdfEvidenceReceipt,
      rehydrateLocalPdfEvidence,
    } = await import("../localPdfLookup");

    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
      contextBlocks: 1,
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    const receipt = await readLocalPdfEvidenceReceipt(lookup.evidence.handle);
    expect(receipt).toMatchObject({
      handle: lookup.evidence.handle,
      source: {
        document_id: documentId,
        version_id: versionId,
        source_sha256: built.state.source_sha256,
      },
      lookup: { locatorKind: "page", locator: "1", contextBlocks: 1 },
      evidence: {
        artifact_ids: ["page-1"],
        context_artifact_ids: ["page-2"],
        text_sha256: lookup.evidence.text_sha256,
        payload_sha256: lookup.evidence.payload_sha256,
      },
    });
    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).resolves.toMatchObject({
      status: "found",
      evidence: { handle: lookup.evidence.handle },
      before: [],
      after: [{ id: "page-2" }],
    });

    const sourceBytes = await readFile(built.source);
    await writeFile(built.source, "%PDF-1.4 changed bytes", "utf8");
    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).rejects.toThrow(
      "PDF evidence source bytes no longer match their version",
    );
    await writeFile(built.source, sourceBytes);

    const pages = (await readFile(built.pagesPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstPage = pages[0] as {
      lines: { reading_order: number; text: string }[];
    };
    firstPage.lines[0].text = "Changed authoritative text.";
    await writeJsonLines(built.pagesPath, pages);
    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).rejects.toThrow(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
    const drifted = await lookupLocalPdfStructure(
      built.source,
      { locatorKind: "page", locator: "1", contextBlocks: 1 },
      { persistEvidence: false },
    );
    expect(drifted.status).toBe("found");
    if (drifted.status !== "found") throw new Error("fixture lookup failed");
    expect(drifted.evidence.handle).not.toBe(lookup.evidence.handle);
    await expect(
      readLocalPdfEvidenceReceipt(drifted.evidence.handle),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hashes current source bytes before the first exact lookup or receipt", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");
    await writeFile(built.source, "%PDF-1.4 replaced bytes", "utf8");

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      exact: false,
      error: "PDF source bytes no longer match their version",
    });
    await expect(
      access(path.join(temporaryDirectory!, "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails an old receipt closed after the detected OCR identity rekeys it", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure, rehydrateLocalPdfEvidence } =
      await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    const nextConfig = {
      ...built.state.parser_config,
      ocr_provider: "tesseract",
      ocr_identity: "tesseract-cli-v1:tesseract 5.4.0",
      ocr_language: "eng",
      ocr_dpi: 180,
      ocr_psm: 3,
    };
    const nextCacheKey = "d".repeat(64);
    await Promise.all([
      writeFile(
        built.statePath,
        JSON.stringify({
          ...built.state,
          parser_config: nextConfig,
          cache_key: nextCacheKey,
        }),
        "utf8",
      ),
      writeFile(
        built.parserConfigPath,
        JSON.stringify({
          ...built.parserConfig,
          parser_config: nextConfig,
          cache_key: nextCacheKey,
        }),
        "utf8",
      ),
    ]);

    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).rejects.toThrow(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  });

  it("binds evidence to proposition and provenance metadata, not text alone", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure, rehydrateLocalPdfEvidence } =
      await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "footnote",
      locator: "fn-a",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    const notes = (await readFile(built.footnotesPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    notes[0].sentence_proposition = "Changed proposition metadata.";
    await writeJsonLines(built.footnotesPath, notes);

    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).rejects.toThrow(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  });

  it("does not alias identical bytes imported as another Library version", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure, readLocalPdfEvidenceReceipt } =
      await import("../localPdfLookup");
    const first = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
    });
    expect(first.status).toBe("found");
    if (first.status !== "found") throw new Error("fixture lookup failed");

    await writeFile(
      built.statePath,
      JSON.stringify({
        ...built.state,
        document_id: "document-2",
        version_id: "version-2",
      }),
      "utf8",
    );
    const second = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
    });
    expect(second.status).toBe("found");
    if (second.status !== "found") throw new Error("fixture lookup failed");
    expect(second.evidence.handle).not.toBe(first.evidence.handle);
    await expect(
      readLocalPdfEvidenceReceipt(second.evidence.handle),
    ).resolves.toMatchObject({
      source: { document_id: "document-2", version_id: "version-2" },
    });
  });

  it("resolves exact section kinds and encoded subsection identifiers", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "section",
        locator: "s. 7",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [
        {
          id: "section_7",
          text: "Section 7 General rule\n\nThe rule applies.",
          page_numbers: [1],
        },
      ],
    });

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "subsection",
        locator: "section_7__subsection_1",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [
        {
          id: "section_7__subsection_1",
          text: "Subsection 7(1) Exception\n\nThe exception is narrow.",
          page_numbers: [2],
        },
      ],
    });

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "section",
        locator: "9",
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      matches: ["section_9_first", "section_9_second"],
    });
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "subclause",
        locator: "7(1)(a)(i)",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      exact: false,
      error: "No exact subclause identifiers exist in this PDF artifact",
    });
  });

  it("enforces range, context, and text bounds", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
        endLocator: "21",
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      exact: false,
      error: "Exact ranges are limited to 20 units",
    });
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "paragraph",
        locator: "2",
        contextBlocks: 3,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      error: "Invalid or unbounded PDF locator",
    });
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "22",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      error: "The requested structural unit has no exact text",
    });
  });

  it("fails closed for missing sources and mismatched versioned artifacts", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");

    await writeFile(
      built.parserConfigPath,
      JSON.stringify({ ...built.parserConfig, cache_key: "wrong-version" }),
      "utf8",
    );
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      error:
        "PDF lookup parser configuration does not match the selected source",
    });

    await writeFile(
      built.parserConfigPath,
      JSON.stringify(built.parserConfig),
      "utf8",
    );
    await writeFile(
      built.statePath,
      JSON.stringify({ ...built.state, source_path: "files/other.pdf" }),
      "utf8",
    );
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      error: "PDF lookup parse state does not match the selected source",
    });

    await writeFile(built.statePath, JSON.stringify(built.state), "utf8");
    await writeFile(
      built.manifestPath,
      JSON.stringify({
        ...built.manifest,
        artifacts: { ...built.manifest.artifacts, pages: "../pages.jsonl" },
      }),
      "utf8",
    );
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      exact: false,
      error: "PDF lookup artifact path is outside its data directory",
    });

    await rm(built.source);
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "page",
        locator: "1",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      exact: false,
      error: "PDF lookup source or artifact is unavailable",
    });
  });

  it("exposes the same bounded lookup through the assistant tool", async () => {
    await fixture();
    const tools = await import("../chat/localAssistantTools");
    expect(
      tools.LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining(["library_lookup", "library_evidence"]));

    const [response] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "lookup-1",
        name: "library_lookup",
        input: {
          document_id: documentId,
          version_id: versionId,
          locator_kind: "footnote",
          locator: "fn-a",
        },
      },
    ]);
    const lookupPayload = JSON.parse(response.content) as {
      evidence: { handle: string };
    };
    expect(lookupPayload).toMatchObject({
      ok: true,
      filename: "fixture.pdf",
      status: "found",
      exact: true,
      units: [
        {
          id: "fn-a",
          proposition: { sentence: "The rule applies." },
        },
      ],
      source: { document_id: documentId, version_id: versionId },
      evidence: { handle: expect.stringMatching(/^mike-evidence:v1:/u) },
    });
    const [rehydrated] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "evidence-1",
        name: "library_evidence",
        input: { handle: lookupPayload.evidence.handle },
      },
    ]);
    expect(JSON.parse(rehydrated.content)).toMatchObject({
      ok: true,
      filename: "fixture.pdf",
      status: "found",
      evidence: { handle: lookupPayload.evidence.handle },
      units: [{ id: "fn-a", text: "First note body." }],
    });

    const [missing] = await tools.runLocalAssistantTools("local-user", [
      {
        id: "lookup-2",
        name: "library_lookup",
        input: {
          document_id: documentId,
          version_id: "not-a-version",
          locator_kind: "page",
          locator: "1",
        },
      },
    ]);
    expect(JSON.parse(missing.content)).toMatchObject({
      ok: false,
      error: "PDF Library version not found",
    });
  });
});
