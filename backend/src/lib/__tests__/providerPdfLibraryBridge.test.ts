import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  queuePdf: vi.fn(),
  pdfState: vi.fn(),
  lookupPdf: vi.fn(),
  rehydratePdfEvidence: vi.fn(),
  rehydratePdfLink: vi.fn(),
}));

vi.mock("dns/promises", () => ({
  default: { lookup: mocks.dnsLookup },
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

vi.mock("../documentProjectionService", () => ({
  documentProjectionService: {
    queuePdf: mocks.queuePdf,
    pdfState: mocks.pdfState,
    lookupPdf: mocks.lookupPdf,
    rehydratePdfEvidence: mocks.rehydratePdfEvidence,
    rehydratePdfLink: mocks.rehydratePdfLink,
  },
}));

let temporaryDirectory: string | null = null;

const attachment = {
  provider: "govinfo" as const,
  identity: "USCOURTS-cod-1_22-cv-00930",
  structureSource: "flat_text" as const,
  url: "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
  filename: "decision.pdf",
};

function digest(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pdfResponse(bytes: Buffer, headers: Record<string, string> = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      ...headers,
    },
  });
}

async function setup() {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "beaver-provider-projection-"),
  );
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  mocks.dnsLookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ]);
}

async function waitForDownloaded(
  bridge: typeof import("../providerPdfLibraryBridge"),
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await bridge.readProviderPdfAttachmentState(attachment, {
      resume: false,
    });
    if (state?.download_status === "downloaded") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider PDF did not finish downloading");
}

beforeEach(async () => {
  await setup();
  mocks.dnsLookup.mockReset();
  mocks.dnsLookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ]);
  mocks.queuePdf.mockReset();
  mocks.queuePdf.mockResolvedValue({ status: "ready" });
  mocks.pdfState.mockReset();
  mocks.pdfState.mockResolvedValue({ status: "ready" });
  mocks.lookupPdf.mockReset();
  mocks.rehydratePdfEvidence.mockReset();
  mocks.rehydratePdfLink.mockReset();
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.GOVINFO_API_KEY;
  delete process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS;
  delete process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("provider PDF projection bridge", () => {
  it("serializes one request across isolated modules and stores one SHA source", async () => {
    const bytes = Buffer.from("%PDF-1.4 shared source");
    const fetchMock = vi.fn(async () => pdfResponse(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const firstProcess = await import("../providerPdfLibraryBridge");
    vi.resetModules();
    const secondProcess = await import("../providerPdfLibraryBridge");

    const [first, second] = await Promise.all([
      firstProcess.ingestProviderPdfAttachment(attachment),
      secondProcess.ingestProviderPdfAttachment(attachment),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second?.source_reference).toBe(first?.source_reference);
    expect(first?.source_sha256).toBe(digest(bytes));
    const { pdfContentPath } = await import("../documentProjection");
    expect(await readFile(pdfContentPath(digest(bytes)))).toEqual(bytes);
  });

  it("returns a durable queue reference before the background download", async () => {
    const bytes = Buffer.from("%PDF-1.4 queued source");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await blocked;
      return pdfResponse(bytes);
    }));
    const bridge = await import("../providerPdfLibraryBridge");

    const queued = await bridge.queueProviderPdfAttachment(attachment);
    expect(queued).toMatchObject({
      download_status: "queued",
      source_reference: null,
    });
    expect(queued?.request_reference).toMatch(/^mike-provider-pdf:v1:govinfo:/u);
    release();
    const downloaded = await waitForDownloaded(bridge);
    expect(downloaded.source_sha256).toBe(digest(bytes));
  });

  it("keeps versioned source references immutable across restart", async () => {
    const bytes = Buffer.from("%PDF-1.4 immutable revision");
    const fetchMock = vi.fn(async () => pdfResponse(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const versioned = { ...attachment, version: "2026-08-18" };
    const firstProcess = await import("../providerPdfLibraryBridge");
    const first = await firstProcess.ingestProviderPdfAttachment(versioned);
    vi.resetModules();
    const secondProcess = await import("../providerPdfLibraryBridge");
    const second = await secondProcess.ingestProviderPdfAttachment(versioned);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second).toMatchObject({
      source_reference: first?.source_reference,
      cache_hit: true,
    });
  });

  it("revalidates only with URL-bound validators and preserves old SHA references", async () => {
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const firstBytes = Buffer.from("%PDF-1.4 first revision");
    const secondBytes = Buffer.from("%PDF-1.4 second revision");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return pdfResponse(firstBytes, { ETag: '"first"' });
      }
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"first"');
      return pdfResponse(secondBytes, { ETag: '"second"' });
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(attachment);
    const current = await bridge.readProviderPdfAttachmentState(attachment, {
      resume: false,
    });
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(current!.checked_at!) + 60_001,
    );
    const second = await bridge.ingestProviderPdfAttachment(attachment);

    expect(second?.source_sha256).toBe(digest(secondBytes));
    expect(second?.source_reference).not.toBe(first?.source_reference);
    const historical = await bridge.readProviderPdfReferenceState(
      first!.source_reference,
    );
    expect(historical).toMatchObject({
      download_status: "downloaded",
      source_sha256: digest(firstBytes),
    });
  });

  it("serves verified stale bytes when refresh is offline", async () => {
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const bytes = Buffer.from("%PDF-1.4 stale but verified");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(pdfResponse(bytes, { ETag: '"stable"' }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(attachment);
    const current = await bridge.readProviderPdfAttachmentState(attachment, {
      resume: false,
    });
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(current!.checked_at!) + 60_001,
    );
    const stale = await bridge.ingestProviderPdfAttachment(attachment);

    expect(stale).toMatchObject({
      source_reference: first?.source_reference,
      cache_hit: true,
    });
    await expect(
      bridge.readProviderPdfAttachmentState(attachment, { resume: false }),
    ).resolves.toMatchObject({ freshness_status: "stale" });
  });

  it("strips GovInfo credentials and rejects request/SHA splices", async () => {
    process.env.GOVINFO_API_KEY = "server-secret";
    const firstBytes = Buffer.from("%PDF-1.4 first request");
    const secondBytes = Buffer.from("%PDF-1.4 second request");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(pdfResponse(firstBytes))
      .mockResolvedValueOnce(pdfResponse(secondBytes)));
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment({
      ...attachment,
      url: `${attachment.url}?api_key=input-secret`,
    });
    const second = await bridge.ingestProviderPdfAttachment({
      ...attachment,
      identity: "USCOURTS-other",
      url: "https://api.govinfo.gov/packages/USCOURTS-other/pdf",
    });
    const spliced = `${first!.request_reference}:${second!.source_sha256}`;

    let rejection: unknown;
    const splicedState = await bridge.readProviderPdfReferenceState(spliced)
      .catch((error) => { rejection = error; return null; });
    if (splicedState) {
      expect(splicedState).toMatchObject({
        download_status: "failed",
        source_reference: null,
        source_sha256: null,
      });
    } else expect(String(rejection)).toContain("unavailable");
    const records = path.join(
      temporaryDirectory!, "projections", "v1", "provider-pdf", "govinfo",
    );
    const { readdir } = await import("node:fs/promises");
    const stored = await Promise.all(
      (await readdir(records)).filter((name) => name.endsWith(".json"))
        .map((name) => readFile(path.join(records, name), "utf8")),
    );
    expect(stored.join("\n")).not.toContain("input-secret");
    expect(stored.join("\n")).not.toContain("server-secret");
  });

  it("fails closed on unsolicited 304 and declared oversized bodies", async () => {
    const bridge = await import("../providerPdfLibraryBridge");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await expect(bridge.ingestProviderPdfAttachment(attachment)).rejects.toThrow(
      "304",
    );

    vi.resetModules();
    const retryBridge = await import("../providerPdfLibraryBridge");
    const oversized = new Response(Buffer.from("%PDF-1.4"), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(100 * 1024 * 1024 + 1),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => oversized));
    const changed = { ...attachment, identity: "oversized" };
    await expect(retryBridge.ingestProviderPdfAttachment(changed)).rejects.toThrow(
      "size limit",
    );
  });

  it("resolves exact lookup and evidence through the SHA projection", async () => {
    const bytes = Buffer.from("%PDF-1.4 exact evidence");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse(bytes)));
    const handle = `mike-evidence:v1:${"a".repeat(64)}`;
    mocks.lookupPdf.mockResolvedValue({
      status: "found",
      evidence: { handle },
    });
    mocks.rehydratePdfLink.mockResolvedValue({ handle, pages: [] });
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested = await bridge.ingestProviderPdfAttachment(attachment);
    const result = await bridge.lookupProviderPdfReference(
      ingested!.source_reference,
      { locatorKind: "page", locator: "1" },
    );

    expect(result).toMatchObject({
      availability: "ready",
      lookup: { status: "found", evidence: { handle } },
      linkEvidence: { handle },
    });
    expect(mocks.lookupPdf).toHaveBeenCalledWith(
      expect.stringContaining(`${digest(bytes)}.pdf`),
      { locatorKind: "page", locator: "1" },
    );
  });
});
