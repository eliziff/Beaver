import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  preparePdf: vi.fn(),
  lookupPdf: vi.fn(),
}));

vi.mock("dns/promises", () => ({ default: { lookup: mocks.dnsLookup } }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("../documentProjectionService", () => ({
  documentProjectionService: {
    preparePdf: mocks.preparePdf,
    lookupPdf: mocks.lookupPdf,
  },
}));

const attachment = {
  provider: "govinfo",
  identity: "USCOURTS-cod-1_22-cv-00930",
  source: { provider: "govinfo", id: "USCOURTS-cod-1_22-cv-00930", kind: "case" as const,
    citation: "1:22-cv-00930", title: "Example v. Respondent", collection: "USCOURTS" },
  structureSource: "flat_text" as const,
  url: "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
  filename: "decision.pdf",
};
let temporaryDirectory: string | null = null;
let worker: { stop(): Promise<void> } | null = null;

const digest = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const pdfResponse = (bytes: Buffer) => new Response(bytes, {
  status: 200,
  headers: {
    "Content-Type": "application/pdf",
    "Content-Length": String(bytes.length),
  },
});

it("does not publish a download that ends before the PDF trailer", async () => {
  const { publishPdfStream } = await import("../documentProjection");
  await expect(publishPdfStream(pdfResponse(Buffer.from("%PDF-1.4 interrupted")).body!))
    .rejects.toThrow("incomplete");
});

async function waitForDownloaded(
  bridge: typeof import("../providerPdfLibraryBridge"),
  input = attachment,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await bridge.readProviderPdfAttachmentState(input, "local-user");
    if (
      state?.download_status === "downloaded"
      && ["ready", "degraded", "failed"].includes(String(state.parse_status))
    ) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider PDF did not finish downloading");
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "provider-pdf-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  process.env.AUTH_MODE = "local";
  mocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.preparePdf.mockImplementation(async ({ bytes }: { bytes: Buffer }) => ({
    status: "ready",
    sourceSha256: digest(bytes),
    parserVersion: "test",
    cacheKey: "a".repeat(64),
    pageCount: 1,
    projectionPageCount: 1,
    profile: {},
  }));
  vi.resetModules();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
  await (await import("../relationalDatabase")).closeRelationalDatabase();
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.AUTH_MODE;
  delete process.env.GOVINFO_API_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

async function startProviderWorker(
  bridge: typeof import("../providerPdfLibraryBridge"),
) {
  const { startJobWorker } = await import("../jobQueue");
  worker = startJobWorker(bridge.providerPdfJobHandlers());
}

describe("provider PDF projection bridge", () => {
  it("queues once and durably addresses verified bytes by SHA-256", async () => {
    const bytes = Buffer.from("%PDF-1.4 provider source\n%%EOF\n");
    let fetchStarted!: () => void, releaseFetch!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchMock = vi.fn(async () => {
      fetchStarted();
      await held;
      return pdfResponse(bytes);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");

    const [first, second] = await Promise.all([
      bridge.queueProviderPdfAttachment(attachment, "local-user"),
      bridge.queueProviderPdfAttachment(attachment, "local-user"),
    ]);
    expect(first?.request_reference).toBe(second?.request_reference);
    await startProviderWorker(bridge);
    await started;

    let watchdogReleased = false;
    const watchdog = setTimeout(() => {
      watchdogReleased = true;
      releaseFetch();
    }, 500);
    const queued = await bridge.readProviderPdfAttachmentState(attachment, "local-user");
    clearTimeout(watchdog);
    releaseFetch();
    expect(watchdogReleased).toBe(false);
    expect(queued.download_status).toBe("queued");

    const downloaded = await waitForDownloaded(bridge);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(downloaded).toMatchObject({
      download_status: "downloaded",
      source_sha256: digest(bytes),
      parse_status: "ready",
    });
    expect(downloaded.source_reference).toBe(
      `${downloaded.request_reference}:${digest(bytes)}`,
    );
  });

  it("keeps credentials out of durable identity and rejects unsafe sources", async () => {
    process.env.GOVINFO_API_KEY = "server-secret";
    vi.stubGlobal("fetch", vi.fn(async () =>
      pdfResponse(Buffer.from("%PDF-1.4 credential test\n%%EOF\n"))));
    const bridge = await import("../providerPdfLibraryBridge");
    await startProviderWorker(bridge);
    const input = { ...attachment, url: `${attachment.url}?api_key=input-secret`,
      source: { ...attachment.source, url: `${attachment.url}?api_key=reference-secret` } };
    await bridge.queueProviderPdfAttachment(input, "local-user");
    await waitForDownloaded(bridge, input);

    const records = path.join(
      temporaryDirectory!, "projections", "v1", "source-pdf",
    );
    const stored = await Promise.all((await readdir(records)).map((name) =>
      readFile(path.join(records, name), "utf8")));
    expect(stored.join("\n")).not.toMatch(/input-secret|server-secret|reference-secret/u);
    expect(() => bridge.providerPdfRequestReference({ ...attachment,
      source: undefined as never })).toThrow("legal reference is invalid");
    expect(() => bridge.providerPdfRequestReference({ ...attachment,
      source: { ...attachment.source, provider: "a2aj" } })).toThrow("legal reference is invalid");
    expect(() => bridge.providerPdfRequestReference({
      ...attachment,
      provider: "bad/provider",
    })).toThrow("provider is invalid");
    expect(() => bridge.providerPdfRequestReference({
      ...attachment,
      url: "http://example.com/source.pdf",
    })).toThrow();
    for (const url of ["https://www.canlii.org/source.pdf",
      "https://download.canlii.ca./source.pdf"]) {
      expect(() => bridge.providerPdfRequestReference({ ...attachment, url }))
        .toThrow("blocked host");
    }
  });

  it("does not follow an allowed provider redirect into CanLII", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0]) => new Response(null, { status: 302,
      headers: { Location: "https://www.canlii.ca./redirected.pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");

    await startProviderWorker(bridge);
    await bridge.queueProviderPdfAttachment(attachment, "local-user");
    await vi.waitFor(async () => expect(
      await bridge.readProviderPdfAttachmentState(attachment, "local-user"),
    ).toMatchObject({ download_status: "failed" }));
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(["api.govinfo.gov"]);
  });

  it("finds a valid publisher PDF through ranked pages without requesting CanLII", async () => {
    const source = "https://publisher.example/decision/1";
    const bytes = Buffer.from("%PDF-1.7 publisher original\n%%EOF\n");
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === source) return new Response(`
        <a href="https://www.canlii.org/en/ca/scc/doc/2001/2001scc1/2001scc1.pdf">Download PDF</a>
        <a href="/bad.pdf">Download PDF</a>
        <a href="/article/view/1">View article</a>`, {
        status: 200, headers: { "Content-Type": "text/html" },
      });
      if (url === "https://publisher.example/bad.pdf") {
        return pdfResponse(Buffer.from("not a PDF"));
      }
      if (url === "https://publisher.example/article/view/1") return new Response(
        '<a href="/official.pdf">PDF</a>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
      if (url === "https://publisher.example/official.pdf") return pdfResponse(bytes);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");

    await expect(bridge.downloadProviderOriginalPdf({
      provider: "a2aj", identity: "a2aj:en:test:2001 scc 1", sourceUrl: source,
      source: { provider: "a2aj", id: "2001 SCC 1", kind: "case",
        citation: "2001 SCC 1", collection: "test", language: "en" },
      filename: "Decision.pdf", title: "Decision",
    })).resolves.toEqual({ bytes, sourceSha256: digest(bytes),
      url: "https://publisher.example/official.pdf" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      source,
      "https://publisher.example/bad.pdf",
      "https://publisher.example/article/view/1",
      "https://publisher.example/official.pdf",
    ]);
  });

  it.each([200, 403, 302])("exposes publisher verification for HTTP %s and permits a later retry", async (status) => {
    const source = "https://publisher.example/decision/1";
    const request = {
      provider: "a2aj", identity: "a2aj:en:test:2001 scc 1", sourceUrl: source,
      source: { provider: "a2aj", id: "2001 SCC 1", kind: "case" as const,
        citation: "2001 SCC 1", collection: "test", language: "en" },
      filename: "Decision.pdf", title: "Decision",
    };
    const fetchMock = vi.fn(async () => status === 302
      ? new Response(null, { status, headers: { Location: "/robocop/captcha/en/query.do" } })
      : new Response('<iframe src="/robocop/captcha/en/query.do"></iframe>', {
        status, headers: { "Content-Type": "text/html" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    await expect(bridge.downloadProviderOriginalPdf(request)).rejects.toMatchObject({
      pageUrl: source,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bytes = Buffer.from("%PDF-1.7 publisher original\n%%EOF\n");
    fetchMock.mockImplementation(async () => pdfResponse(bytes));
    await expect(bridge.downloadProviderOriginalPdf(request)).resolves.toMatchObject({ bytes });
  });

  it.each([[true, true], [false, true], [true, false]] as const)(
    "keeps a guessed-route challenge only with a form and an advertised PDF (%s, %s)",
    async (hasPdf, hasChallenge) => {
    const source = "https://decisions.fpslreb-crtespf.gc.ca/fpslreb-crtespf/d/en/item/521078/index.do";
    const candidate = "https://decisions.fpslreb-crtespf.gc.ca/fpslreb-crtespf/d/en/521078/1/document.do";
        const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === candidate) return new Response(hasChallenge
        ? '<iframe src="/robocop/captcha/en/query.do?token=example"></iframe>' : "Forbidden",
        { status: 403, headers: { "Content-Type": hasChallenge ? "text/html" : "text/plain" } });
      if (url === source) return new Response(
        '<script>const captchaPath="/robocop/captcha/en/query.do";</script>' +
        `<div class="documents">${hasPdf ? `<a href="${candidate}">PDF</a>` : ""}</div>`,
        { status: 200, headers: { "Content-Type": "text/html" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    const request = { provider: "a2aj", identity: "a2aj:en:fpslreb:example", sourceUrl: source,
      source: { provider: "a2aj", id: "Example", kind: "case" as const,
        citation: "Example", collection: "fpslreb", language: "en" as const } };
    if (hasPdf && hasChallenge) await expect(bridge.downloadProviderOriginalPdf(request))
      .rejects.toMatchObject({ pageUrl: source });
    else await expect(bridge.downloadProviderOriginalPdf(request)).resolves.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([candidate, source]);
  });

  it("opens the decision page in the browser session when decision content is blocked", async () => {
    const source = "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/14385/index.do";
    const content = `${source}?iframe=true`;
    const candidate = "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/14385/1/document.do";
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === candidate) return new Response(
        '<iframe src="/robocop/captcha/en/query.do"></iframe>',
        { status: 403, headers: { "Content-Type": "text/html" } });
      if (url === source) return new Response(
        '<script src="/robocop/captcha/en/loader.js"></script>' +
        '<iframe src="/scc-csc/scc-csc/en/item/14385/index.do?iframe=true"></iframe>',
        { headers: { "Content-Type": "text/html" } });
      if (url === content) return new Response(
        '<title>Validation</title><div style="padding-top: 10px;" id="captchaForm">\n' +
        '<form action="/robocop/captcha/eval.do" target="_parent"><img id="captchaTag"></form></div>',
        { status: 403, headers: { "Content-Type": "text/html" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    await expect(bridge.downloadProviderOriginalPdf({
      provider: "a2aj", identity: "a2aj:en:scc:14385", sourceUrl: source,
      source: { provider: "a2aj", id: "14385", kind: "case",
        citation: "14385", collection: "scc", language: "en" },
    })).rejects.toMatchObject({ pageUrl: source });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([candidate, source, content]);
  });

  it("fails closed when a source digest is spliced onto another request", async () => {
    const firstBytes = Buffer.from("%PDF-1.4 first\n%%EOF\n");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse(firstBytes)));
    const bridge = await import("../providerPdfLibraryBridge");
    await startProviderWorker(bridge);
    await bridge.queueProviderPdfAttachment(attachment, "local-user");
    const firstState = await waitForDownloaded(bridge);

    await expect(bridge.lookupProviderPdfReference(
      `${firstState.request_reference}:${"f".repeat(64)}`,
      "local-user",
      { locatorKind: "page", locator: "1" },
    )).resolves.toMatchObject({ availability: "queued" });
    expect(mocks.lookupPdf).not.toHaveBeenCalled();
  });

  it("resolves exact evidence only after download and parse", async () => {
    const bytes = Buffer.from("%PDF-1.4 exact evidence\n%%EOF\n");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse(bytes)));
    const handle = `mike-evidence:v1:${"a".repeat(64)}`;
    mocks.lookupPdf.mockResolvedValue({ status: "found", evidence: { handle } });
    const bridge = await import("../providerPdfLibraryBridge");
    await startProviderWorker(bridge);
    await bridge.queueProviderPdfAttachment(attachment, "local-user");
    const state = await waitForDownloaded(bridge);

    await expect(bridge.lookupProviderPdfReference(
      state.source_reference!, "local-user", { locatorKind: "page", locator: "1" },
    )).resolves.toMatchObject({
      availability: "ready",
      params: { source: attachment.source },
      lookup: { status: "found", evidence: { handle } },
    });
    expect(mocks.lookupPdf).toHaveBeenCalledWith(
      expect.any(Function),
      { locatorKind: "page", locator: "1" },
      {
        documentId: `provider-pdf-${digest(bytes).slice(0, 32)}`,
        versionId: digest(bytes).slice(0, 32),
        sourceSha256: digest(bytes),
        pdfProfile: {
          cacheKey: "a".repeat(64), profile: {}, status: "ready",
        },
      },
    );
    expect(await mocks.lookupPdf.mock.calls[0]![0]()).toEqual(bytes);
    const records = path.join(temporaryDirectory!, "projections", "v1", "source-pdf");
    const filename = path.join(records, (await readdir(records))[0]);
    const persisted = JSON.parse(await readFile(filename, "utf8"));
    delete persisted.source;
    await writeFile(filename, JSON.stringify(persisted));
    await expect(bridge.lookupProviderPdfReference(state.source_reference!, "local-user",
      { locatorKind: "page", locator: "1" })).resolves.toMatchObject({ availability: "error" });
  });
});
