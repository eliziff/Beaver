import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runLegalPdf = vi.hoisted(() => vi.fn());
const renameFault = vi.hoisted(() => ({ remaining: 0, injected: 0 }));

vi.mock("../legalPdfProcess", () => ({ runLegalPdf }));
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

async function fakeArtifacts(args: string[], status = "ready") {
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
      lines: [],
      regions: [],
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
            code: "OCR_REQUIRED",
            severity: "warning",
            message: "Page needs OCR.",
            page_index: 0,
          })}\n`,
    "repairs.jsonl": "",
  };
  await Promise.all(
    Object.entries(rows).map(([name, content]) =>
      writeFile(path.join(output, name), content, "utf8"),
    ),
  );
  await writeFile(
    path.join(output, "document.json"),
    JSON.stringify({
      schema_version: "legalpdf.document.v1",
      parser_version: "0.1.0",
      document_id: "parsed-document",
      source_name: path.basename(source),
      source_sha256: sourceSha256,
      page_count: 1,
      status,
      metadata: {},
      provenance: { cache_hit: false },
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
) {
  if (args[0] === "ocr-identity") {
    return {
      stdout: JSON.stringify({ provider: "tesseract", identity }),
      stderr: "",
    };
  }
  await fakeArtifacts(args, status);
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
  it("stores the immutable source, returns queued, and publishes versioned artifacts", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeArtifacts(args));
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

    expect(document.pdf_parse).toMatchObject({
      status: "queued",
      flat_text_fallback_available: true,
    });
    expect(file).not.toBeNull();
    expect(path.basename(file!.path)).toMatch(
      new RegExp(`^${file!.version.id}-[a-f0-9]{16}\\.pdf$`, "u"),
    );
    expect(await readFile(file!.path)).toEqual(bytes);

    const state = await waitForState(ingestion, file!.path, "ready");
    expect(state).toMatchObject({
      source_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      parser_version: "0.1.0",
      parser_config_version: "mike-local-v1",
      page_count: 1,
      diagnostic_count: 0,
    });
    const manifest = JSON.parse(
      await readFile(
        path.join(temporaryDirectory, state!.artifact_manifest),
        "utf8",
      ),
    );
    expect(manifest.artifacts).toMatchObject({
      pages: "pages.jsonl",
      paragraphs: "paragraphs.jsonl",
      sections: "sections.jsonl",
      footnotes: "footnotes.jsonl",
      propositions: "propositions.jsonl",
      diagnostics: "diagnostics.jsonl",
      repairs: "repairs.jsonl",
      parser_config: "parser-config.json",
    });

    await ingestion.queueLocalPdfParse({
      documentId: document.id,
      versionId: file!.version.id,
      sourcePath: file!.path,
    });
    expect(runLegalPdf).toHaveBeenCalledTimes(1);
    expect(runLegalPdf.mock.calls[0][0][0]).toBe("parse");
  });

  it("rebuilds incomplete or corrupt ready publications before reuse", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    let parseCalls = 0;
    const rebuildStartedWithManifest: boolean[] = [];
    runLegalPdf.mockImplementation(async (args: string[]) => {
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
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeArtifacts(args));
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
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
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

    const state = await waitForState(ingestion, file!.path, "degraded");

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

  it("requeues a parse left in parsing state and records the interruption", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
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

  it("sanitizes parser failures before persisting them", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockRejectedValue(
      new Error(
        `Command failed while reading ${path.join(temporaryDirectory, "private", "source.pdf")}`,
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
  });

  it("aborts an in-flight OCR parse before deleting its artifacts", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
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
        if (args[0] === "ocr-identity") {
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

  it("recovers a stored PDF if shutdown occurred before its job sidecar was written", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) => fakeArtifacts(args));
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
    const state = await waitForState(ingestion, source, "ready");

    expect(state).toMatchObject({
      document_id: "document",
      version_id: "version",
      attempts: 1,
    });
  });
});
