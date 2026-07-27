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
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-lookup-"));
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
  const propositions = footnotes.map((footnote) => ({
    pair_id: footnote.pair_id,
    label: footnote.label,
    reference_page: footnote.reference_page,
    sentence: footnote.sentence_proposition,
    passage_since_prior_note: footnote.passage_since_prior_note,
  }));
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
    page_count: pages.length,
    status: "ready",
    counts: {
      pages: pages.length,
      paragraphs: paragraphs.length,
      sections: sections.length,
      footnotes: footnotes.length,
      diagnostics: 0,
      repairs: 0,
    },
    artifacts: {
      pages: "pages.jsonl",
      paragraphs: "paragraphs.jsonl",
      sections: "sections.jsonl",
      footnotes: "footnotes.jsonl",
      diagnostics: "diagnostics.jsonl",
      repairs: "repairs.jsonl",
      propositions: "propositions.jsonl",
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
    writeJsonLines(path.join(output, "propositions.jsonl"), propositions),
    writeFile(path.join(output, "diagnostics.jsonl"), "", "utf8"),
    writeFile(path.join(output, "repairs.jsonl"), "", "utf8"),
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
    paragraphsPath: path.join(output, "paragraphs.jsonl"),
    sectionsPath: path.join(output, "sections.jsonl"),
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
          text: "[page 1]\nFirst line. Second line.",
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
    expect(pages.status === "found" && pages.link.href).toBe(
      pages.status === "found"
        ? `/single-documents/${documentId}/evidence-view?version_id=${versionId}&evidence=${encodeURIComponent(
            pages.evidence.handle,
          )}#page=1`
        : "",
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
    if (paragraph.status !== "found") {
      throw new Error("fixture lookup failed");
    }
    const linkedParagraph = await (
      await import("../localPdfLookup")
    ).rehydrateLocalPdfLinkEvidence(
      built.source,
      paragraph.evidence.handle,
    );
    expect(linkedParagraph.sources).toMatchObject([
      {
        key: "paragraph:section_7",
        blockText: "Section 7 General rule",
      },
      {
        key: "paragraph:paragraph-rule",
        blockText: "The rule applies.",
      },
      {
        key: "paragraph:section_7__subsection_1",
        blockText: "Subsection 7(1) Exception",
      },
    ]);
  });

  it("binds context pages but navigates and falls back to selected pages", async () => {
    const built = await fixture();
    const {
      lookupLocalPdfStructure,
      readLocalPdfEvidenceReceipt,
      rehydrateLocalPdfLinkEvidence,
    } = await import("../localPdfLookup");
    const { buildLegalSourcePinpointUrl } =
      await import("../legalSourceLinks");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "paragraph",
      locator: "3",
      contextBlocks: 1,
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    await expect(
      readLocalPdfEvidenceReceipt(lookup.evidence.handle),
    ).resolves.toMatchObject({
      evidence: { page_numbers: [1, 2] },
    });
    const linked = await rehydrateLocalPdfLinkEvidence(
      built.source,
      lookup.evidence.handle,
    );
    const selectedHref =
      `/single-documents/${documentId}/evidence-view?version_id=${versionId}` +
      `&evidence=${encodeURIComponent(lookup.evidence.handle)}#page=2`;
    expect(linked.href).toBe(selectedHref);
    expect(linked.pageNumbers).toEqual([2]);
    expect(linked.pageScoped).toBe(true);
    expect(linked.pages.map(({ pageNumber }) => pageNumber)).toEqual([
      1, 2,
    ]);
    expect(linked.documentText).toContain("Page 2 text.");
    expect(linked.documentText).not.toContain("Page 3 text.");
    expect(
      buildLegalSourcePinpointUrl(
        {
          url: linked.href,
          blockText: linked.blockText,
          documentText: linked.documentText,
          pageScoped: linked.pageScoped,
        },
        ["not present in the selected unit"],
      ),
    ).toBe(selectedHref);
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
        page_numbers: [1, 2],
        page_text_sha256: lookup.evidence.page_text_sha256,
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

  it("binds non-page evidence to the rendered pages used for links", async () => {
    const built = await fixture();
    const {
      lookupLocalPdfStructure,
      readLocalPdfEvidenceReceipt,
      rehydrateLocalPdfEvidence,
    } = await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "footnote",
      locator: "fn-a",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    await expect(
      readLocalPdfEvidenceReceipt(lookup.evidence.handle),
    ).resolves.toMatchObject({
      evidence: {
        artifact_ids: ["fn-a"],
        page_numbers: [1, 2],
        page_text_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });

    const pages = (await readFile(built.pagesPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstPage = pages[0] as {
      lines: { reading_order: number; text: string }[];
    };
    firstPage.lines[0].text = "Unrelated rendered-page drift.";
    await writeJsonLines(built.pagesPath, pages);

    await expect(
      rehydrateLocalPdfEvidence(built.source, lookup.evidence.handle),
    ).rejects.toThrow(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  });

  it("rehydrates legacy exact units but refuses unbound automatic links", async () => {
    const built = await fixture();
    const {
      lookupLocalPdfStructure,
      rehydrateLocalPdfEvidence,
      rehydrateLocalPdfLinkEvidence,
    } = await import("../localPdfLookup");
    const lookupInput = {
      locatorKind: "paragraph" as const,
      locator: "2",
    };
    const lookup = await lookupLocalPdfStructure(
      built.source,
      lookupInput,
      { persistEvidence: false },
    );
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    const legacyIdentity = {
      document_id: lookup.source.document_id,
      version_id: lookup.source.version_id,
      source_sha256: lookup.source.source_sha256,
      cache_key: lookup.source.cache_key,
      kind: "paragraph",
      artifact_ids: lookup.evidence.artifact_ids,
      text_sha256: lookup.evidence.text_sha256,
      context_artifact_ids: lookup.evidence.context_artifact_ids,
      payload_sha256: lookup.evidence.payload_sha256,
    };
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(legacyIdentity))
      .digest("hex");
    const legacyHandle = `mike-evidence:v1:${digest}`;
    const receiptPath = path.join(
      temporaryDirectory!,
      "evidence",
      "pdf",
      "v1",
      `${digest}.json`,
    );
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: "mike.pdf_evidence.v1",
        handle: legacyHandle,
        source: {
          document_id: lookup.source.document_id,
          version_id: lookup.source.version_id,
          source_path: built.state.source_path,
          source_sha256: lookup.source.source_sha256,
          parser_version: lookup.source.parser_version,
          parser_config_version: lookup.source.parser_config_version,
          cache_key: lookup.source.cache_key,
        },
        lookup: lookupInput,
        evidence: {
          artifact_ids: lookup.evidence.artifact_ids,
          context_artifact_ids: lookup.evidence.context_artifact_ids,
          text_sha256: lookup.evidence.text_sha256,
          payload_sha256: lookup.evidence.payload_sha256,
        },
      }),
      "utf8",
    );

    await expect(
      rehydrateLocalPdfEvidence(built.source, legacyHandle),
    ).resolves.toMatchObject({
      status: "found",
      units: [{ id: "paragraph-rule", text: "The rule applies." }],
    });
    await expect(
      rehydrateLocalPdfLinkEvidence(built.source, legacyHandle),
    ).rejects.toThrow(
      "PDF evidence receipt is not bound to authoritative page text",
    );
  });

  it("rehydrates page-scoped link evidence after restart", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    vi.resetModules();
    const { rehydrateLocalPdfLinkEvidence } =
      await import("../localPdfLookup");
    const { buildLegalSourcePinpointUrl } =
      await import("../legalSourceLinks");
    const linkEvidence = await rehydrateLocalPdfLinkEvidence(
      built.source,
      lookup.evidence.handle,
    );

    expect(linkEvidence).toMatchObject({
      handle: lookup.evidence.handle,
      documentId,
      versionId,
      href: `/single-documents/${documentId}/evidence-view?version_id=${versionId}&evidence=${encodeURIComponent(
        lookup.evidence.handle,
      )}#page=1`,
      label: "[page 1]",
      blockText: "[page 1]\nFirst line. Second line.",
      pageScoped: true,
      pageNumbers: [1],
      sources: [
        {
          key: "page:page-1",
          label: "[page 1]",
          blockText: "[page 1]\nFirst line. Second line.",
          pageScoped: true,
          pageNumbers: [1],
        },
      ],
      pages: [
        {
          pageNumber: 1,
          href: `/single-documents/${documentId}/evidence-view?version_id=${versionId}&evidence=${encodeURIComponent(
            lookup.evidence.handle,
          )}#page=1`,
          label: "[page 1]",
          blockText: "First line. Second line.",
        },
      ],
    });
    const source = {
      url: linkEvidence.href,
      blockText: linkEvidence.blockText,
      documentText: linkEvidence.documentText,
      pageScoped: linkEvidence.pageScoped,
    };
    const link = buildLegalSourcePinpointUrl(source, [
      "First line",
      "Second line",
    ]);
    expect(link?.match(/text=/gu)).toHaveLength(2);
    expect(link).toContain("#page=1:~:text=");
    expect(
      buildLegalSourcePinpointUrl(source, ["not present in the PDF"]),
    ).toBe(linkEvidence.href);

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
      rehydrateLocalPdfLinkEvidence(
        built.source,
        lookup.evidence.handle,
      ),
    ).rejects.toThrow(
      "PDF evidence no longer matches the authoritative source artifacts",
    );
  });

  it("uses engine-equivalent soft-hyphen joining for rendered link text", async () => {
    const built = await fixture();
    const pages = (await readFile(built.pagesPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    (pages[0] as { lines: { reading_order: number; text: string }[] }).lines =
      [
        { reading_order: 1, text: "The inter-" },
        { reading_order: 2, text: "pretation applies." },
        { reading_order: 3, text: "Do-" },
        { reading_order: 4, text: "Not merge." },
      ];
    await writeJsonLines(built.pagesPath, pages);
    const {
      lookupLocalPdfStructure,
      rehydrateLocalPdfLinkEvidence,
    } = await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "1",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    await expect(
      rehydrateLocalPdfLinkEvidence(
        built.source,
        lookup.evidence.handle,
      ),
    ).resolves.toMatchObject({
      blockText: "[page 1]\nThe interpretation applies. Do- Not merge.",
      sources: [
        {
          blockText:
            "[page 1]\nThe interpretation applies. Do- Not merge.",
        },
      ],
      pages: [
        {
          blockText:
            "The interpretation applies. Do- Not merge.",
        },
      ],
    });
  });

  it("keeps top-level link matching scoped to exact units, not their whole page", async () => {
    const built = await fixture();
    const {
      lookupLocalPdfStructure,
      rehydrateLocalPdfLinkEvidence,
    } = await import("../localPdfLookup");
    const lookup = await lookupLocalPdfStructure(built.source, {
      locatorKind: "paragraph",
      locator: "2",
    });
    expect(lookup.status).toBe("found");
    if (lookup.status !== "found") throw new Error("fixture lookup failed");

    const linked = await rehydrateLocalPdfLinkEvidence(
      built.source,
      lookup.evidence.handle,
    );
    expect(linked.blockText).toBe("The rule applies.");
    expect(linked.blockText).not.toContain("First line.");
    expect(linked.pages[0].blockText).toBe(
      "First line. Second line.",
    );
  });

  it("reuses one source snapshot across lookup rounds and link finalization", async () => {
    const built = await fixture();
    const {
      createLocalPdfArtifactSession,
      createLocalPdfLinkEvidenceSession,
      lookupLocalPdfStructure,
      rehydrateLocalPdfLinkEvidence,
    } = await import("../localPdfLookup");
    const artifactSession = createLocalPdfArtifactSession(built.source);
    const first = await lookupLocalPdfStructure(
      built.source,
      {
        locatorKind: "page",
        locator: "1",
      },
      { artifactSession },
    );
    expect(first.status).toBe("found");
    if (first.status !== "found") throw new Error("fixture lookup failed");
    await rm(built.pagesPath);
    const second = await lookupLocalPdfStructure(
      built.source,
      {
        locatorKind: "page",
        locator: "2",
      },
      { artifactSession },
    );
    expect(second.status).toBe("found");
    if (second.status !== "found") throw new Error("fixture lookup failed");

    const session = createLocalPdfLinkEvidenceSession(
      built.source,
      artifactSession,
    );
    await expect(session.rehydrate(first.evidence.handle)).resolves.toMatchObject(
      { pageNumbers: [1] },
    );
    await expect(
      session.rehydrate(second.evidence.handle),
    ).resolves.toMatchObject({ pageNumbers: [2] });
    await expect(
      rehydrateLocalPdfLinkEvidence(
        built.source,
        second.evidence.handle,
      ),
    ).rejects.toThrow();
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

  it("normalizes provider fragments across every exact provision kind", async () => {
    const built = await fixture();
    const headings = [
      {
        id: "opaque-section",
        page_index: 4,
        region_type: "heading",
        text: "7 General rule",
        locator_kind: "section",
        provider_locator: "#sec7",
      },
      {
        id: "opaque-subsection",
        page_index: 5,
        region_type: "heading",
        text: "7(2) Exception",
        locator_kind: "subsec",
        locator: "section/7/subsection/2",
      },
      {
        id: "section_7_subsection_2_paragraph_a",
        page_index: 6,
        region_type: "heading",
        text: "7(2)(a) Application",
      },
      {
        id: "sec7__subsec2__para_a__subpara_i",
        page_index: 7,
        region_type: "heading",
        text: "7(2)(a)(i) Detail",
      },
      {
        id: "opaque-clause",
        page_index: 8,
        region_type: "heading",
        text: "Cl. 7(2)(a)(i)(A) Condition",
      },
      {
        id: "opaque-subclause",
        page_index: 9,
        region_type: "heading",
        text: "Subcl. 7(2)(a)(i)(A)(I) Exception",
      },
      {
        id: "schedule-A",
        page_index: 10,
        region_type: "heading",
        text: "Sched. A Forms",
      },
      {
        id: "article_IV",
        page_index: 11,
        region_type: "heading",
        text: "Art. IV Rights",
      },
      {
        id: "section-hyphen",
        page_index: 12,
        region_type: "heading",
        text: "Section 4-1 Hyphenated rule",
      },
      {
        id: "section-parenthetical",
        page_index: 13,
        region_type: "heading",
        text: "Section 4(1) Parenthetical rule",
      },
    ];
    const paragraphs = headings.flatMap((heading) => [
      heading,
      {
        id: `body-${heading.id}`,
        page_index: heading.page_index,
        region_type: "body",
        text: `Body for ${heading.id}.`,
      },
    ]);
    await Promise.all([
      writeJsonLines(built.paragraphsPath, paragraphs),
      writeJsonLines(
        built.sectionsPath,
        headings.map((heading) => ({
          ...heading,
          provenance: "provider-fixture",
        })),
      ),
    ]);
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");
    const matrix = [
      ["section", "#sec7", "opaque-section"],
      ["subsection", "section/7/subsection/2", "opaque-subsection"],
      [
        "provision_paragraph",
        "sec-7-subsec-2-para-a",
        "section_7_subsection_2_paragraph_a",
      ],
      [
        "subparagraph",
        "section_7__subsection_2__paragraph_a__subparagraph_i",
        "sec7__subsec2__para_a__subpara_i",
      ],
      ["clause", "cl. 7(2)(a)(i)(A)", "opaque-clause"],
      [
        "subclause",
        "subcl. 7(2)(a)(i)(A)(I)",
        "opaque-subclause",
      ],
      ["schedule", "schedule A", "schedule-A"],
      ["article", "article IV", "article_IV"],
    ] as const;
    for (const [locatorKind, locator, id] of matrix) {
      const found = await lookupLocalPdfStructure(built.source, {
        locatorKind,
        locator,
      });
      expect(found).toMatchObject({
        status: "found",
        exact: true,
        units: [{ id }],
        link: {
          href: expect.stringContaining("/evidence-view?"),
          artifact_ids: [id],
        },
      });
    }

    const neighbors = await lookupLocalPdfStructure(built.source, {
      locatorKind: "subparagraph",
      locator: "sec7__subsec2__para_a__subpara_i",
      contextBlocks: 1,
    });
    expect(neighbors).toMatchObject({
      status: "found",
      units: [{ id: "sec7__subsec2__para_a__subpara_i" }],
      before: [{ id: "section_7_subsection_2_paragraph_a" }],
      after: [{ id: "opaque-clause" }],
    });

    const sectionAlias = await lookupLocalPdfStructure(built.source, {
      locatorKind: "section",
      locator: "section 7",
    });
    const providerAlias = await lookupLocalPdfStructure(built.source, {
      locatorKind: "section",
      locator: "#sec7",
    });
    expect(sectionAlias.status).toBe("found");
    expect(providerAlias.status).toBe("found");
    if (sectionAlias.status === "found" && providerAlias.status === "found") {
      expect(providerAlias.evidence.handle).toBe(
        sectionAlias.evidence.handle,
      );
      expect(providerAlias.evidence.text_sha256).toBe(
        sectionAlias.evidence.text_sha256,
      );
      expect(providerAlias.evidence.payload_sha256).toBe(
        sectionAlias.evidence.payload_sha256,
      );
      expect(providerAlias.link.href).toBe(sectionAlias.link.href);
    }

    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "section",
        locator: "sec4-1",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [{ id: "section-hyphen" }],
    });
    await expect(
      lookupLocalPdfStructure(built.source, {
        locatorKind: "section",
        locator: "sec4(1)",
      }),
    ).resolves.toMatchObject({
      status: "found",
      units: [{ id: "section-parenthetical" }],
    });
  });

  it("accepts provider page-range and paragraph fragments without changing evidence identity", async () => {
    const built = await fixture();
    const { lookupLocalPdfStructure } = await import("../localPdfLookup");
    const ordinaryPages = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "pages 1-2",
    });
    const fragmentPages = await lookupLocalPdfStructure(built.source, {
      locatorKind: "page",
      locator: "#page=1-2",
    });
    const ordinaryParagraph = await lookupLocalPdfStructure(built.source, {
      locatorKind: "paragraph",
      locator: "paragraphs 2-3",
    });
    const fragmentParagraph = await lookupLocalPdfStructure(built.source, {
      locatorKind: "paragraph",
      locator: "#par2-3",
    });
    expect(ordinaryPages.status).toBe("found");
    expect(fragmentPages.status).toBe("found");
    expect(ordinaryParagraph.status).toBe("found");
    expect(fragmentParagraph.status).toBe("found");
    if (
      ordinaryPages.status === "found" &&
      fragmentPages.status === "found" &&
      ordinaryParagraph.status === "found" &&
      fragmentParagraph.status === "found"
    ) {
      expect(fragmentPages.evidence.handle).toBe(
        ordinaryPages.evidence.handle,
      );
      expect(fragmentPages.evidence.payload_sha256).toBe(
        ordinaryPages.evidence.payload_sha256,
      );
      expect(fragmentPages.link.href).toBe(ordinaryPages.link.href);
      expect(fragmentParagraph.evidence.handle).toBe(
        ordinaryParagraph.evidence.handle,
      );
      expect(fragmentParagraph.evidence.text_sha256).toBe(
        ordinaryParagraph.evidence.text_sha256,
      );
      expect(fragmentParagraph.link.href).toBe(
        ordinaryParagraph.link.href,
      );
    }
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
    const built = await fixture();
    const tools = await import("../chat/localAssistantTools");
    const handles = new Set<string>();
    expect(
      tools.LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name),
    ).toEqual(expect.arrayContaining(["library_lookup", "library_evidence"]));

    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      [
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
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
    );
    const lookupPayload = JSON.parse(response.content) as {
      handle: string;
    };
    expect(lookupPayload).toMatchObject({
      ok: true,
      filename: "fixture.pdf",
      status: "found",
      exact: true,
      handle: expect.stringMatching(/^mike-evidence:v1:/u),
      version_id: versionId,
      units: [
        {
          id: "fn-a",
          proposition: { sentence: "The rule applies." },
        },
      ],
      context: { before: [], after: [] },
      link: { page_numbers: [1, 2] },
    });
    expect(lookupPayload).not.toHaveProperty("source");
    expect(lookupPayload).not.toHaveProperty("evidence");
    expect(handles).toEqual(new Set([lookupPayload.handle]));
    await Promise.all([
      rm(built.pagesPath),
      rm(built.footnotesPath),
    ]);
    const [rehydrated] = await tools.runLocalAssistantTools(
      "local-user",
      [
        {
          id: "evidence-1",
          name: "library_evidence",
          input: { handle: lookupPayload.handle },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
    );
    expect(JSON.parse(rehydrated.content)).toMatchObject({
      ok: true,
      filename: "fixture.pdf",
      status: "found",
      handle: lookupPayload.handle,
      version_id: versionId,
      units: [{ id: "fn-a", text: "First note body." }],
    });
    const { appendLocalPdfPinpointLinks } = await import(
      "../chat/localPdfEvidenceState"
    );
    await expect(
      appendLocalPdfPinpointLinks(
        'The note says "First note body."',
        "local-user",
        handles,
      ),
    ).resolves.toContain("/evidence-view?");

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

  it("does not advertise a viewer link without an exact page mapping", async () => {
    const built = await fixture();
    const paragraphsPath = path.join(
      path.dirname(built.manifestPath),
      "paragraphs.jsonl",
    );
    const paragraphs = (await readFile(paragraphsPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    paragraphs[1].page_index = 999;
    await writeJsonLines(paragraphsPath, paragraphs);
    const tools = await import("../chat/localAssistantTools");
    const handles = new Set<string>();

    const [response] = await tools.runLocalAssistantTools(
      "local-user",
      [{
        id: "lookup-unmapped",
        name: "library_lookup",
        input: {
          document_id: documentId,
          version_id: versionId,
          locator_kind: "paragraph",
          locator: "2",
        },
      }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
    );
    const payload = JSON.parse(response.content);

    expect(payload).toMatchObject({
      ok: true,
      handle: expect.stringMatching(/^mike-evidence:v1:/u),
      link: { page_numbers: [] },
    });
    expect(payload.link).not.toHaveProperty("href");
  });
});
