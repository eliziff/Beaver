import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runLegalPdf = vi.hoisted(() => vi.fn());
const renameFault = vi.hoisted(() => ({ remaining: 0, injected: 0 }));

vi.mock("../legalPdfProcess", () => ({
  LEGAL_PDF_DOCUMENT_SCHEMA: "legalpdf.document.v2",
  LEGAL_PDF_PARSER_VERSION: "0.3.0",
  runLegalPdf,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: string | Buffer | URL,
      newPath: string | Buffer | URL,
    ) => {
      if (
        process.platform === "win32" &&
        String(newPath).endsWith(".legalpdf-state.json") &&
        renameFault.remaining > 0
      ) {
        renameFault.remaining -= 1;
        renameFault.injected += 1;
        throw Object.assign(new Error("simulated Windows file contention"), {
          code: "EPERM",
        });
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

let temporaryDirectory: string | null = null;

const repairableDiagnosticCodes = [
  "COLUMN_ORDER_UNCERTAIN",
  "FOOTNOTE_REGION_UNCERTAIN",
  "FOOTNOTE_UNMATCHED_LABEL",
  "FOOTNOTE_UNMATCHED_REFERENCE",
  "TEXT_QUALITY_LOW",
];
const repairIdentity = {
  schema_version: "legalpdf.codex.repair-identity.v1",
  prompt_version: "legalpdf.codex.structure.r1.v2",
  response_schema_sha256: "b".repeat(64),
  repairable_diagnostics_sha256: crypto
    .createHash("sha256")
    .update(JSON.stringify(repairableDiagnosticCodes))
    .digest("hex"),
  context_radius: 1,
  max_attempts: 3,
  max_live_calls: 6,
  max_scope_pages: 2,
  repairable_diagnostics: repairableDiagnosticCodes,
};

async function fakeArtifacts(
  args: string[],
  status = "ready",
  diagnosticCode = "OCR_REQUIRED",
) {
  const source = args[1];
  const output = args[args.indexOf("--output") + 1];
  const sourceSha256 = crypto
    .createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  await mkdir(output, { recursive: true });
  const rows: Record<string, string> = {
    "pages.jsonl": `${JSON.stringify({
      id: "page-1",
      index: 0,
      number: 1,
      width: 612,
      height: 792,
      printed_label: "1",
      printed_label_source: "physical",
      source: "native",
      text_quality: 0.99,
      lines: [
        {
          id: "line-1",
          reading_order: 0,
          text: "Introduction",
          bbox: [72, 72, 160, 84],
          spans: [{ text: "Introduction", bbox: [72, 72, 160, 84] }],
          words: [{ text: "Introduction", bbox: [72, 72, 160, 84] }],
        },
      ],
      regions: [{ type: "body", bbox: [72, 72, 540, 720] }],
    })}\n`,
    "paragraphs.jsonl": `${JSON.stringify({
      id: "paragraph-1",
      page_index: 0,
      region_type: "heading",
      text: "Introduction",
      line_ids: [],
    })}\n`,
    "sections.jsonl": `${JSON.stringify({
      id: "paragraph-1",
      page_index: 0,
      text: "Introduction",
      line_ids: [],
      provenance: "heading-region",
    })}\n`,
    "footnotes.jsonl": `${JSON.stringify({
      pair_id: "fn-1",
      label: "1",
      reference_page: 1,
      sentence_proposition: "The proposition.",
      passage_since_prior_note: "The proposition.",
    })}\n`,
    "diagnostics.jsonl":
      status === "ready"
        ? ""
        : `${JSON.stringify({
            code: diagnosticCode,
            severity: "warning",
            message: "Page needs OCR.",
            page_index: 0,
          })}\n`,
    "repairs.jsonl": "",
  };
  if (args.includes("--compact-pages")) {
    const page = JSON.parse(rows["pages.jsonl"]);
    rows["pages.jsonl"] = `${JSON.stringify({
      id: page.id,
      index: page.index,
      number: page.number,
      printed_label: page.printed_label,
      printed_label_source: page.printed_label_source,
      source: page.source,
      text_quality: page.text_quality,
      lines: page.lines.map((line: { reading_order: number; text: string }) => ({
        reading_order: line.reading_order,
        text: line.text,
      })),
    })}\n`;
  }
  await Promise.all(
    Object.entries(rows).map(([name, content]) =>
      writeFile(path.join(output, name), content, "utf8"),
    ),
  );
  await writeFile(
    path.join(output, "document.json"),
    JSON.stringify({
      schema_version: "legalpdf.document.v2",
      artifact_profile: "compact-source",
      parser_version: "0.3.0",
      document_id: "parsed-document",
      source_name: path.basename(source),
      source_sha256: sourceSha256,
      page_count: 1,
      status,
      metadata: {
        pairing: {
          created_at: "2026-07-31T18:00:00Z",
          elapsed_seconds: 1.2345,
          paired_count: 1,
        },
      },
      provenance: {
        cache_hit: false,
        ...(args[args.indexOf("--mode") + 1] === "codex"
          ? {
              codex: {
                model: args[args.indexOf("--model") + 1],
                effort: args[args.indexOf("--effort") + 1],
                prompt_version: repairIdentity.prompt_version,
                response_schema_sha256: repairIdentity.response_schema_sha256,
                repairable_diagnostics_sha256:
                  repairIdentity.repairable_diagnostics_sha256,
                repairable_diagnostics: repairIdentity.repairable_diagnostics,
                context_radius: repairIdentity.context_radius,
                max_attempts: repairIdentity.max_attempts,
                max_live_calls: repairIdentity.max_live_calls,
                max_scope_pages: repairIdentity.max_scope_pages,
              },
            }
          : {}),
      },
      counts: {
        pages: 1,
        lines: 0,
        paragraphs: 1,
        sections: 1,
        footnotes: 1,
        diagnostics: status === "ready" ? 0 : 1,
        repairs: 0,
      },
      artifacts: {
        pages: "pages.jsonl",
        paragraphs: "paragraphs.jsonl",
        sections: "sections.jsonl",
        footnotes: "footnotes.jsonl",
        diagnostics: "diagnostics.jsonl",
        repairs: "repairs.jsonl",
      },
    }),
    "utf8",
  );
}

async function fakeLegalPdf(
  args: string[],
  status = "ready",
  identity = "tesseract-cli-v1:tesseract 5.3.0",
  diagnosticCode = "OCR_REQUIRED",
) {
  if (args[0] === "ocr-identity") {
    return {
      stdout: JSON.stringify({ provider: "tesseract", identity }),
      stderr: "",
    };
  }
  if (args[0] === "repair-identity") {
    return {
      stdout: JSON.stringify(repairIdentity),
      stderr: "",
    };
  }
  await fakeArtifacts(args, status, diagnosticCode);
  return { stdout: "", stderr: "" };
}

async function waitForState(
  ingestion: typeof import("../localPdfIngestion"),
  sourcePath: string,
  expected: string,
) {
  let lastState = null;
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = await ingestion.readLocalPdfParseState(sourcePath);
    if (state?.status === expected) return state;
    lastState = state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `PDF parse state did not become ${expected}: ${JSON.stringify(lastState)}`,
  );
}

afterEach(async () => {
  runLegalPdf.mockReset();
  renameFault.remaining = 0;
  renameFault.injected = 0;
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.MIKE_PDF_PARSE_CONFIG_VERSION;
  delete process.env.MIKE_PDF_OCR_LANGUAGE;
  delete process.env.MIKE_PDF_OCR_DPI;
  delete process.env.MIKE_PDF_OCR_PSM;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local PDF ingestion", () => {
  it("stores a PDF without parsing until structural use", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const store = await import("../localDocumentStore");
    const ingestion = await import("../localPdfIngestion");
    const bytes = Buffer.from("%PDF-1.4 durable source");

    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "sample.pdf",
      bytes,
    });
    const file = await store.getLocalVersionFile("local-user", document.id);

    expect(document).not.toHaveProperty("pdf_parse");
    expect(await ingestion.readLocalPdfParseState(file!.path)).toBeNull();
    expect(runLegalPdf).not.toHaveBeenCalled();
    expect(file).not.toBeNull();
    expect(path.basename(file!.path)).toMatch(
      new RegExp(`^${file!.version.id}-[a-f0-9]{16}\\.pdf$`, "u"),
    );
    expect(await readFile(file!.path)).toEqual(bytes);

    const state = await ingestion.parseLocalPdfOnDemand({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
      sourceSha256: file!.version.source_sha256,
    });
    const parseArgs = runLegalPdf.mock.calls.find(
      ([args]) => args[0] === "parse",
    )?.[0];
    expect(state).toMatchObject({
      source_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      parser_version: "0.3.0",
      parser_config_version: "mike-local-v1",
      parser_config: {
        mode: "local",
        model: null,
        prompt_version: null,
      },
      repair_contract: {
        repairable_diagnostics: repairableDiagnosticCodes,
        repairable_diagnostics_sha256:
          repairIdentity.repairable_diagnostics_sha256,
        max_live_calls: 6,
        max_scope_pages: 2,
      },
      page_count: 1,
      diagnostic_count: 0,
    });
    expect(parseArgs).toContain("--no-cache");
    expect(parseArgs).toContain("--compact-pages");
    expect(parseArgs).not.toContain("--cache-dir");
    expect(parseArgs).not.toContain("--text-fidelity-root");
    expect(state!.parser_config).not.toHaveProperty("text_fidelity_root");
    const artifactRoot = path.dirname(
      path.join(temporaryDirectory, state!.artifact_manifest),
    );
    const manifest = JSON.parse(
      await readFile(path.join(artifactRoot, "document.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schema_version: "mike.pdf_source.v1",
      engine_schema_version: "legalpdf.document.v2",
      artifact_profile: "compact-source",
      metadata: { pairing: { paired_count: 1 } },
    });
    expect(manifest.metadata.pairing).not.toHaveProperty("created_at");
    expect(manifest.metadata.pairing).not.toHaveProperty("elapsed_seconds");
    expect(manifest.artifacts).toMatchObject({
      pages: "pages.jsonl",
      paragraphs: "paragraphs.jsonl",
      sections: "sections.jsonl",
      footnotes: "footnotes.jsonl",
      diagnostics: "diagnostics.jsonl",
      repairs: "repairs.jsonl",
      parser_config: "parser-config.json",
    });
    const [page] = (
      await readFile(path.join(artifactRoot, "pages.jsonl"), "utf8")
    )
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    expect(page).toEqual({
      id: "page-1",
      index: 0,
      number: 1,
      printed_label: "1",
      printed_label_source: "physical",
      source: "native",
      text_quality: 0.99,
      lines: [{ reading_order: 0, text: "Introduction" }],
    });
    expect(page).not.toHaveProperty("regions");
    expect(page.lines[0]).not.toHaveProperty("bbox");
    expect(page.lines[0]).not.toHaveProperty("spans");
    expect(page.lines[0]).not.toHaveProperty("words");

    await ingestion.queueLocalPdfParse({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
    });
    expect(
      runLegalPdf.mock.calls.filter(([args]) => args[0] === "parse"),
    ).toHaveLength(1);
  });

  it("reparses changed version bytes and deletes every obsolete publication", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    const firstBytes = Buffer.from("%PDF-1.4 first version");
    const firstHash = crypto.createHash("sha256").update(firstBytes).digest("hex");
    await writeFile(source, firstBytes);
    const first = await ingestion.parseLocalPdfOnDemand({
      documentId: "document",
      versionId: "version-1",
      sourcePath: source,
      sourceSha256: firstHash,
    });
    const firstManifest = path.join(temporaryDirectory, first.artifact_manifest);
    const artifactRoot = path.dirname(path.dirname(firstManifest));
    const obsolete = path.join(artifactRoot, "obsolete-key", "leftover.bin");
    await mkdir(path.dirname(obsolete), { recursive: true });
    await writeFile(obsolete, "stale");

    await ingestion.parseLocalPdfOnDemand({
      documentId: "document",
      versionId: "version-1",
      sourcePath: source,
      sourceSha256: firstHash,
    });
    await expect(readFile(obsolete)).rejects.toMatchObject({ code: "ENOENT" });

    const secondBytes = Buffer.from("%PDF-1.4 second version");
    const secondHash = crypto
      .createHash("sha256")
      .update(secondBytes)
      .digest("hex");
    await writeFile(source, secondBytes);
    await expect(
      ingestion.parseLocalPdfOnDemand({
        documentId: "document",
        versionId: "version-1",
        sourcePath: source,
        sourceSha256: firstHash,
      }),
    ).rejects.toThrow("source bytes no longer match their version");
    await expect(readFile(firstManifest)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = await ingestion.parseLocalPdfOnDemand({
      documentId: "document",
      versionId: "version-2",
      sourcePath: source,
      sourceSha256: secondHash,
    });
    expect(second.source_sha256).toBe(secondHash);
    expect(second.cache_key).not.toBe(first.cache_key);
    expect(
      runLegalPdf.mock.calls.filter(([args]) => args[0] === "parse"),
    ).toHaveLength(2);
  });

  it("rebuilds incomplete or corrupt ready publications before reuse", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let parseCalls = 0;
    const rebuildStartedWithManifest: boolean[] = [];
    runLegalPdf.mockImplementation(async (args: string[]) => {
      if (args[0] === "repair-identity") return fakeLegalPdf(args);
      parseCalls += 1;
      if (parseCalls > 1) {
        const output = args[args.indexOf("--output") + 1];
        try {
          await readFile(path.join(output, "document.json"), "utf8");
          rebuildStartedWithManifest.push(true);
        } catch (error) {
          expect(error).toMatchObject({ code: "ENOENT" });
          rebuildStartedWithManifest.push(false);
        }
      }
      return fakeArtifacts(args);
    });
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 cache integrity", "utf8");
    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const first = await waitForState(ingestion, source, "ready");
    const output = path.dirname(
      path.join(temporaryDirectory, first!.artifact_manifest),
    );

    await writeFile(path.join(output, "paragraphs.jsonl"), "{broken", "utf8");
    await expect(
      ingestion.readLocalPdfParseState(source),
    ).resolves.toMatchObject({ status: "queued" });
    const repaired = await waitForState(ingestion, source, "ready");
    expect(repaired!.attempts).toBe(2);

    await rm(path.join(output, "sections.jsonl"));
    await ingestion.resumeLocalPdfParses();
    const completed = await waitForState(ingestion, source, "ready");
    expect(completed!.attempts).toBe(3);
    await expect(
      readFile(path.join(output, "sections.jsonl"), "utf8"),
    ).resolves.toContain("Introduction");
    expect(rebuildStartedWithManifest).toEqual([false, false]);

    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    expect(parseCalls).toBe(3);
  });

  it("survives overlapping state reads and extended Windows rename contention", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 concurrent", "utf8");
    renameFault.remaining = process.platform === "win32" ? 21 : 0;

    const queued = ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const readers = Array.from({ length: 32 }, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await ingestion.readLocalPdfParseState(source);
      }
    });
    await Promise.all([queued, ...readers]);
    const state = await waitForState(ingestion, source, "ready");

    expect(state!.error).toBeUndefined();
    expect(renameFault.remaining).toBe(0);
    expect(renameFault.injected).toBe(process.platform === "win32" ? 21 : 0);
  });

  it("reports raster-only parser output honestly as degraded", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let identity = "tesseract-cli-v1:tesseract 5.3.0";
    runLegalPdf.mockImplementation((args: string[]) =>
      fakeLegalPdf(args, "ocr_required", identity),
    );
    const store = await import("../localDocumentStore");
    const ingestion = await import("../localPdfIngestion");
    const document = await store.createLocalDocument({
      userId: "local-user",
      kind: "file",
      filename: "scan.pdf",
      bytes: Buffer.from("%PDF-1.4 scan"),
    });
    const file = await store.getLocalVersionFile("local-user", document.id);

    const state = await ingestion.parseLocalPdfOnDemand({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
      sourceSha256: file!.version.source_sha256,
    });

    expect(state).toMatchObject({
      engine_status: "ocr_required",
      diagnostic_count: 1,
      diagnostic_summary: {
        by_code: { OCR_REQUIRED: 1 },
        by_severity: { warning: 1 },
      },
    });
    expect(state!.diagnostics).toHaveLength(1);

    process.env.MIKE_PDF_OCR_LANGUAGE = "fra";
    process.env.MIKE_PDF_OCR_DPI = "144";
    process.env.MIKE_PDF_OCR_PSM = "6";
    runLegalPdf.mockImplementation((args: string[]) =>
      fakeLegalPdf(args, "ready", identity),
    );
    const queued = await ingestion.queueLocalPdfParse({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
      ocrProvider: "tesseract",
      force: true,
    });
    const recovered = await waitForState(ingestion, file!.path, "ready");

    expect(queued.cache_key).not.toBe(state!.cache_key);
    expect(recovered!.parser_config).toMatchObject({
      ocr_provider: "tesseract",
      ocr_identity: identity,
      ocr_language: "fra",
      ocr_dpi: 144,
      ocr_psm: 6,
    });
    const ocrParse = runLegalPdf.mock.calls.find(
      ([args]) => args[0] === "parse" && args.includes("--ocr-provider"),
    )?.[0];
    expect(ocrParse?.slice(-10)).toEqual([
      "--ocr-provider",
      "tesseract",
      "--ocr-language",
      "fra",
      "--ocr-dpi",
      "144",
      "--ocr-psm",
      "6",
      "--expected-ocr-identity",
      identity,
    ]);
    const firstOcrManifest = recovered!.artifact_manifest;
    identity = "tesseract-cli-v1:tesseract 5.4.0";
    const requeued = await ingestion.queueLocalPdfParse({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
      ocrProvider: "tesseract",
      force: true,
    });
    const upgraded = await waitForState(ingestion, file!.path, "ready");
    expect(requeued.cache_key).not.toBe(recovered!.cache_key);
    expect(upgraded!.artifact_manifest).not.toBe(firstOcrManifest);
    expect(upgraded!.parser_config.ocr_identity).toBe(identity);

    process.env.MIKE_PDF_OCR_LANGUAGE = "eng; unsafe";
    process.env.MIKE_PDF_OCR_DPI = "601";
    process.env.MIKE_PDF_OCR_PSM = "14";
    identity = "tesseract-cli-v1:tesseract 5.5.0";
    const validated = await ingestion.queueLocalPdfParse({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
      ocrProvider: "tesseract",
      force: true,
    });
    expect(validated.parser_config).toMatchObject({
      ocr_identity: identity,
      ocr_language: "eng",
      ocr_dpi: 180,
      ocr_psm: 3,
    });
    await waitForState(ingestion, file!.path, "ready");
  });

  it("runs bounded Codex repair only when explicitly queued and records its identity", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let parseCalls = 0;
    runLegalPdf.mockImplementation(async (args: string[]) => {
      if (args[0] === "repair-identity") return fakeLegalPdf(args);
      parseCalls += 1;
      return fakeLegalPdf(
        args,
        parseCalls === 1 ? "degraded" : "ready",
        "tesseract-cli-v1:tesseract 5.3.0",
        "COLUMN_ORDER_UNCERTAIN",
      );
    });
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 uncertain columns", "utf8");

    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const local = await waitForState(ingestion, source, "degraded");
    expect(local).toMatchObject({
      structural_repair_available: true,
      parser_config: { mode: "local", model: null },
    });

    const queued = await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
      force: true,
      repair: { model: "gpt-5.6-luna", effort: "max" },
    });
    expect(queued.cache_key).not.toBe(local!.cache_key);
    expect(queued.parser_config).toMatchObject({
      mode: "codex",
      model: "gpt-5.6-luna",
      effort: "max",
      prompt_version: repairIdentity.prompt_version,
      response_schema_sha256: repairIdentity.response_schema_sha256,
      repairable_diagnostics_sha256:
        repairIdentity.repairable_diagnostics_sha256,
      repairable_diagnostics: repairIdentity.repairable_diagnostics,
      context_radius: 1,
      max_attempts: 3,
      max_live_calls: 6,
      max_scope_pages: 2,
    });

    const repaired = await waitForState(ingestion, source, "ready");
    expect(repaired!.structural_repair_available).toBe(false);
    const repairParse = runLegalPdf.mock.calls.find(
      ([args]) =>
        args[0] === "parse" && args[args.indexOf("--mode") + 1] === "codex",
    )?.[0];
    expect(repairParse).toEqual(
      expect.arrayContaining(["--model", "gpt-5.6-luna", "--effort", "max"]),
    );
    expect(repairParse).toContain("--no-cache");
  });

  it("refreshes the engine repair contract without changing local cache identity", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const engineCodes = ["TEXT_QUALITY_LOW"];
    const engineIdentity = {
      ...repairIdentity,
      repairable_diagnostics: engineCodes,
      repairable_diagnostics_sha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(engineCodes))
        .digest("hex"),
    };
    let parseCalls = 0;
    runLegalPdf.mockImplementation((args: string[]) => {
      if (args[0] === "repair-identity") {
        return Promise.resolve({
          stdout: JSON.stringify(engineIdentity),
          stderr: "",
        });
      }
      parseCalls += 1;
      return fakeLegalPdf(
        args,
        "degraded",
        "tesseract-cli-v1:tesseract 5.3.0",
        "COLUMN_ORDER_UNCERTAIN",
      );
    });
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 catalog", "utf8");

    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const state = await waitForState(ingestion, source, "degraded");

    expect(state!.repair_contract!.repairable_diagnostics).toEqual(engineCodes);
    expect(state!.parser_config.prompt_version).toBeNull();
    expect(state!.structural_repair_available).toBe(false);

    const changedCodes = ["COLUMN_ORDER_UNCERTAIN"];
    const changedIdentity = {
      ...repairIdentity,
      prompt_version: "legalpdf.codex.structure.r1.v3",
      repairable_diagnostics: changedCodes,
      repairable_diagnostics_sha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(changedCodes))
        .digest("hex"),
    };
    vi.resetModules();
    runLegalPdf.mockImplementation((args: string[]) => {
      if (args[0] === "repair-identity") {
        return Promise.resolve({
          stdout: JSON.stringify(changedIdentity),
          stderr: "",
        });
      }
      parseCalls += 1;
      return fakeLegalPdf(args, "degraded");
    });
    const restarted = await import("../localPdfIngestion");
    const refreshed = await restarted.readLocalPdfParseState(source);

    expect(refreshed!.cache_key).toBe(state!.cache_key);
    expect(refreshed!.parser_config).toMatchObject({
      mode: "local",
      model: null,
      prompt_version: null,
    });
    expect(refreshed!.repair_contract!.prompt_version).toBe(
      changedIdentity.prompt_version,
    );
    expect(parseCalls).toBe(1);
    expect(refreshed!.repair_contract!.repairable_diagnostics).toEqual(
      changedCodes,
    );
    expect(refreshed!.structural_repair_available).toBe(true);
  });

  it("does not block deterministic import when repair identity is unavailable", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) =>
      args[0] === "repair-identity"
        ? Promise.reject(new Error("repair identity unavailable"))
        : fakeLegalPdf(args),
    );
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 identity outage", "utf8");

    const queued = await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    expect(queued.status).toBe("queued");
    expect(queued.repair_contract).toBeUndefined();

    const completed = await waitForState(ingestion, source, "ready");
    expect(completed).toMatchObject({
      status: "ready",
      parser_config: { mode: "local", model: null },
      structural_repair_available: false,
    });
    expect(completed!.repair_contract).toBeUndefined();
  });

  it("requeues a parse left in parsing state and records the interruption", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 interrupted", "utf8");
    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
      ocrProvider: "tesseract",
    });
    await waitForState(ingestion, source, "ready");
    const stateFile = `${source}.legalpdf-state.json`;
    const interrupted = JSON.parse(await readFile(stateFile, "utf8"));
    interrupted.status = "parsing";
    delete interrupted.completed_at;
    await writeFile(stateFile, JSON.stringify(interrupted), "utf8");

    await ingestion.resumeLocalPdfParses();
    const resumed = await waitForState(ingestion, source, "ready");

    expect(resumed!.interrupted_at).toBeTruthy();
    expect(resumed!.attempts).toBe(2);
    expect(resumed!.parser_config.ocr_identity).toBe(
      "tesseract-cli-v1:tesseract 5.3.0",
    );
  });

  it("recovers an unowned parsing state through the normal queue path", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 restart queue", "utf8");
    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    await waitForState(ingestion, source, "ready");
    const stateFile = `${source}.legalpdf-state.json`;
    const interrupted = JSON.parse(await readFile(stateFile, "utf8"));
    interrupted.status = "parsing";
    delete interrupted.completed_at;
    await writeFile(stateFile, JSON.stringify(interrupted), "utf8");

    vi.resetModules();
    const restarted = await import("../localPdfIngestion");
    const queued = await restarted.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });

    expect(queued).toMatchObject({
      status: "queued",
      interrupted_at: expect.any(String),
    });
    const completed = await waitForState(restarted, source, "ready");
    expect(completed!.attempts).toBe(2);
  });

  it("fails an orphaned Codex parse safely when its identity probe fails", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 preserved repair", "utf8");
    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
      repair: { model: "gpt-5.6-luna", effort: "max" },
    });
    await waitForState(ingestion, source, "ready");
    const stateFile = `${source}.legalpdf-state.json`;
    const orphaned = JSON.parse(await readFile(stateFile, "utf8"));
    orphaned.status = "parsing";
    delete orphaned.completed_at;
    await writeFile(stateFile, JSON.stringify(orphaned), "utf8");

    vi.resetModules();
    runLegalPdf.mockImplementation((args: string[]) =>
      args[0] === "repair-identity"
        ? Promise.reject(new Error("repair identity unavailable"))
        : fakeLegalPdf(args),
    );
    const restarted = await import("../localPdfIngestion");

    await expect(
      restarted.queueLocalPdfParse({
        documentId: "document",
        versionId: "version",
        sourcePath: source,
      }),
    ).rejects.toThrow("Codex structural repair could not start");
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted).toMatchObject({
      status: "failed",
      error: "Codex structural repair could not start",
      completed_at: expect.any(String),
      interrupted_at: expect.any(String),
    });
  });

  it("fails unowned queued and parsing OCR jobs safely on identity failure", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const jobs = await Promise.all(
      (["queued", "parsing"] as const).map(async (status) => {
        const source = path.join(
          temporaryDirectory!,
          "files",
          status,
          "version-hash.pdf",
        );
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, `%PDF-1.4 preserved OCR ${status}`, "utf8");
        await ingestion.queueLocalPdfParse({
          documentId: status,
          versionId: "version",
          sourcePath: source,
          ocrProvider: "tesseract",
        });
        await waitForState(ingestion, source, "ready");
        const stateFile = `${source}.legalpdf-state.json`;
        const orphaned = JSON.parse(await readFile(stateFile, "utf8"));
        orphaned.status = status;
        delete orphaned.completed_at;
        delete orphaned.interrupted_at;
        await writeFile(stateFile, JSON.stringify(orphaned), "utf8");
        return { source, stateFile, status };
      }),
    );

    vi.resetModules();
    runLegalPdf.mockImplementation((args: string[]) => {
      if (args[0] === "repair-identity") return fakeLegalPdf(args);
      if (args[0] === "ocr-identity") {
        return Promise.reject(new Error("OCR identity unavailable"));
      }
      return fakeLegalPdf(args);
    });
    const restarted = await import("../localPdfIngestion");

    for (const job of jobs) {
      await expect(
        restarted.queueLocalPdfParse({
          documentId: job.status,
          versionId: "version",
          sourcePath: job.source,
        }),
      ).rejects.toThrow("PDF structural parser failed");
      const persisted = JSON.parse(await readFile(job.stateFile, "utf8"));
      expect(persisted).toMatchObject({
        status: "failed",
        error: "PDF structural parser failed",
        completed_at: expect.any(String),
      });
      if (job.status === "parsing") {
        expect(persisted.interrupted_at).toEqual(expect.any(String));
      } else {
        expect(persisted.interrupted_at).toBeUndefined();
      }
    }
  });

  it("keeps an actively owned parsing state idempotent", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let started!: () => void;
    let release!: () => void;
    const parseStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runLegalPdf.mockImplementation(async (args: string[]) => {
      if (args[0] === "repair-identity") return fakeLegalPdf(args);
      started();
      await gate;
      return fakeLegalPdf(args);
    });
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 active owner", "utf8");
    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    await parseStarted;
    const active = await ingestion.readLocalPdfParseState(source, {
      validatePublication: false,
    });
    const same = await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });

    expect(same).toMatchObject({
      job_id: active!.job_id,
      status: "parsing",
    });
    expect(same.interrupted_at).toBeUndefined();
    release();
    await waitForState(ingestion, source, "ready");
  });

  it("does not overwrite a job that gains an owner during identity probes", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const initial = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 probe race", "utf8");
    await initial.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const ready = await waitForState(initial, source, "ready");
    const stateFile = `${source}.legalpdf-state.json`;
    const queued = JSON.parse(await readFile(stateFile, "utf8"));
    queued.status = "queued";
    delete queued.completed_at;
    await writeFile(stateFile, JSON.stringify(queued), "utf8");

    vi.resetModules();
    let markOcrStarted!: () => void;
    let releaseOcr!: () => void;
    let markParseStarted!: () => void;
    let releaseParse!: () => void;
    const ocrStarted = new Promise<void>((resolve) => {
      markOcrStarted = resolve;
    });
    const ocrGate = new Promise<void>((resolve) => {
      releaseOcr = resolve;
    });
    const parseStarted = new Promise<void>((resolve) => {
      markParseStarted = resolve;
    });
    const parseGate = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    runLegalPdf.mockImplementation(async (args: string[]) => {
      if (args[0] === "repair-identity") return fakeLegalPdf(args);
      if (args[0] === "ocr-identity") {
        markOcrStarted();
        await ocrGate;
        return fakeLegalPdf(args);
      }
      markParseStarted();
      await parseGate;
      return fakeLegalPdf(args);
    });
    const restarted = await import("../localPdfIngestion");
    const probing = restarted.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
      ocrProvider: "tesseract",
    });

    try {
      await ocrStarted;
      await restarted.queueLocalPdfParse({
        documentId: "document",
        versionId: "version",
        sourcePath: source,
        ocrProvider: null,
      });
      await parseStarted;
      releaseOcr();
      const preserved = await probing;
      const active = await restarted.readLocalPdfParseState(source, {
        validatePublication: false,
      });

      expect(preserved.cache_key).toBe(ready!.cache_key);
      expect(active!.cache_key).toBe(ready!.cache_key);
      expect(active!.parser_config.ocr_provider).toBeNull();
    } finally {
      releaseOcr();
      releaseParse();
    }
    await waitForState(restarted, source, "ready");
  });

  it("keeps a safe badge message and durable parser failure detail", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) =>
      args[0] === "repair-identity"
        ? fakeLegalPdf(args)
        : Promise.reject(
            new Error(
              `Command failed while reading ${path.join(temporaryDirectory, "private", "source.pdf")}`,
            ),
          ),
    );
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 failure", "utf8");

    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
    });
    const state = await waitForState(ingestion, source, "failed");

    expect(state!.error).toBe("PDF structural parser failed");
    expect(state!.error).not.toContain(temporaryDirectory);
    expect(state!.error_detail).toContain("Command failed while reading");
    expect(state!.error_detail).toContain(temporaryDirectory);
  });

  it("aborts an in-flight OCR parse before deleting its artifacts", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let started!: () => void;
    let partialPath = "";
    const parseStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    runLegalPdf.mockImplementation(
      async (
        args: string[],
        options?: { signal?: AbortSignal },
      ): Promise<{ stdout: string; stderr: string }> => {
        if (args[0] === "ocr-identity" || args[0] === "repair-identity") {
          return fakeLegalPdf(args);
        }
        const output = args[args.indexOf("--output") + 1];
        await mkdir(output, { recursive: true });
        partialPath = path.join(output, "partial.json");
        await writeFile(partialPath, "partial", "utf8");
        started();
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () =>
              reject(new Error("aborted parser with C:\\private\\path.pdf")),
            { once: true },
          );
        });
      },
    );
    const ingestion = await import("../localPdfIngestion");
    const source = path.join(
      temporaryDirectory,
      "files",
      "document",
      "version-hash.pdf",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 OCR cancellation", "utf8");

    await ingestion.queueLocalPdfParse({
      documentId: "document",
      versionId: "version",
      sourcePath: source,
      ocrProvider: "tesseract",
    });
    await parseStarted;
    await ingestion.removeLocalPdfParseArtifacts(source);

    await expect(ingestion.readLocalPdfParseState(source)).resolves.toBeNull();
    await expect(
      readFile(`${source}.legalpdf-state.json`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(partialPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not parse an untouched stored PDF during startup recovery", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeLegalPdf(args));
    const ingestion = await import("../localPdfIngestion");
    const relativeSource = path.join("files", "document", "version-hash.pdf");
    const source = path.join(temporaryDirectory, relativeSource);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "%PDF-1.4 stored", "utf8");
    await writeFile(
      path.join(temporaryDirectory, "library.json"),
      JSON.stringify({
        version: 1,
        documents: [
          {
            id: "document",
            versions: [
              {
                id: "version",
                fileType: "pdf",
                storagePath: relativeSource,
              },
            ],
          },
        ],
        folders: [],
        legalSources: [],
      }),
      "utf8",
    );

    await ingestion.resumeLocalPdfParses();
    await expect(ingestion.readLocalPdfParseState(source)).resolves.toBeNull();
    expect(runLegalPdf).not.toHaveBeenCalled();
  });
});
