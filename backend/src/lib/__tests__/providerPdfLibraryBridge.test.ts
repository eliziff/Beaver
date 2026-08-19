import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  queuePdf: vi.fn(),
  lookupPdf: vi.fn(),
  rehydratePdfLink: vi.fn(),
}));

vi.mock("dns/promises", () => ({ default: { lookup: mocks.dnsLookup } }));
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("../documentProjectionService", () => ({
  documentProjectionService: {
    queuePdf: mocks.queuePdf,
    lookupPdf: mocks.lookupPdf,
    rehydratePdfLink: mocks.rehydratePdfLink,
  },
}));

const attachment = {
  provider: "govinfo",
  identity: "USCOURTS-cod-1_22-cv-00930",
  structureSource: "flat_text" as const,
  url: "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
  filename: "decision.pdf",
};
let temporaryDirectory: string | null = null;

const digest = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const pdfResponse = (bytes: Buffer) => new Response(bytes, {
  status: 200,
  headers: {
    "Content-Type": "application/pdf",
    "Content-Length": String(bytes.length),
  },
});

async function waitForDownloaded(
  bridge: typeof import("../providerPdfLibraryBridge"),
  input = attachment,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await bridge.readProviderPdfAttachmentState(input);
    if (state?.download_status === "downloaded" && state.parse_status) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider PDF did not finish downloading");
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "provider-pdf-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  mocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.queuePdf.mockResolvedValue({ status: "ready" });
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.GOVINFO_API_KEY;
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("provider PDF projection bridge", () => {
  it("queues once and durably addresses verified bytes by SHA-256", async () => {
    const bytes = Buffer.from("%PDF-1.4 provider source");
    const fetchMock = vi.fn(async () => pdfResponse(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");

    const [first, second] = await Promise.all([
      bridge.queueProviderPdfAttachment(attachment),
      bridge.queueProviderPdfAttachment(attachment),
    ]);
    expect(first?.request_reference).toBe(second?.request_reference);

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
      pdfResponse(Buffer.from("%PDF-1.4 credential test"))));
    const bridge = await import("../providerPdfLibraryBridge");
    const input = { ...attachment, url: `${attachment.url}?api_key=input-secret` };
    await bridge.queueProviderPdfAttachment(input);
    await waitForDownloaded(bridge, input);

    const records = path.join(
      temporaryDirectory!, "projections", "v1", "source-pdf",
    );
    const stored = await Promise.all((await readdir(records)).map((name) =>
      readFile(path.join(records, name), "utf8")));
    expect(stored.join("\n")).not.toMatch(/input-secret|server-secret/u);
    expect(() => bridge.providerPdfRequestReference({
      ...attachment,
      provider: "bad/provider",
    })).toThrow("provider is invalid");
    expect(() => bridge.providerPdfRequestReference({
      ...attachment,
      url: "http://example.com/source.pdf",
    })).toThrow();
  });

  it("fails closed when a source digest is spliced onto another request", async () => {
    const firstBytes = Buffer.from("%PDF-1.4 first");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse(firstBytes)));
    const bridge = await import("../providerPdfLibraryBridge");
    await bridge.queueProviderPdfAttachment(attachment);
    const firstState = await waitForDownloaded(bridge);

    await expect(bridge.lookupProviderPdfReference(
      `${firstState.request_reference}:${"f".repeat(64)}`,
      { locatorKind: "page", locator: "1" },
    )).resolves.toMatchObject({ availability: "queued" });
    expect(mocks.lookupPdf).not.toHaveBeenCalled();
  });

  it("resolves exact evidence only after download and parse", async () => {
    const bytes = Buffer.from("%PDF-1.4 exact evidence");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse(bytes)));
    const handle = `mike-evidence:v1:${"a".repeat(64)}`;
    mocks.lookupPdf.mockResolvedValue({ status: "found", evidence: { handle } });
    mocks.rehydratePdfLink.mockResolvedValue({ handle, sources: [], pages: [] });
    const bridge = await import("../providerPdfLibraryBridge");
    await bridge.queueProviderPdfAttachment(attachment);
    const state = await waitForDownloaded(bridge);

    await expect(bridge.lookupProviderPdfReference(
      state.source_reference!, { locatorKind: "page", locator: "1" },
    )).resolves.toMatchObject({
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
