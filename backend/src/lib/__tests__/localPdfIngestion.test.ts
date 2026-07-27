import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runLegalPdf = vi.hoisted(() => vi.fn());

vi.mock("../legalPdfProcess", () => ({ runLegalPdf }));

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
        footnotes: 1,
        diagnostics: status === "ready" ? 0 : 1,
        repairs: 0,
      },
      artifacts: {
        pages: "pages.jsonl",
        paragraphs: "paragraphs.jsonl",
        footnotes: "footnotes.jsonl",
        diagnostics: "diagnostics.jsonl",
        repairs: "repairs.jsonl",
      },
    }),
    "utf8",
  );
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
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.MIKE_PDF_PARSE_CONFIG_VERSION;
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
  });

  it("reports raster-only parser output honestly as degraded", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mike-pdf-"));
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    runLegalPdf.mockImplementation((args: string[]) =>
      fakeArtifacts(args, "ocr_required"),
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
  });

  it("requeues a parse left in parsing state and records the interruption", async () => {
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
    await writeFile(source, "%PDF-1.4 interrupted", "utf8");
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

    await ingestion.resumeLocalPdfParses();
    const resumed = await waitForState(ingestion, source, "ready");

    expect(resumed!.interrupted_at).toBeTruthy();
    expect(resumed!.attempts).toBe(2);
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
