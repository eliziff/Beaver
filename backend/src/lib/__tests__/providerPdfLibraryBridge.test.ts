import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  fsCopyFile: vi.fn(),
  fsLink: vi.fn(),
  fsOpen: vi.fn(),
  fsRename: vi.fn(),
  hashReads: 0,
  lookupLocalPdfStructure: vi.fn(),
  queueLocalPdfParse: vi.fn(),
  readLocalPdfParseState: vi.fn(),
  rehydrateLocalPdfEvidence: vi.fn(),
  rehydrateLocalPdfLinkEvidence: vi.fn(),
}));

vi.mock("dns/promises", () => ({
  default: { lookup: mocks.dnsLookup },
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: (...args: Parameters<typeof actual.copyFile>) =>
      mocks.fsCopyFile(actual.copyFile, ...args),
    link: (...args: Parameters<typeof actual.link>) =>
      mocks.fsLink(actual.link, ...args),
    open: (...args: Parameters<typeof actual.open>) =>
      mocks.fsOpen(actual.open, ...args),
    rename: (...args: Parameters<typeof actual.rename>) =>
      mocks.fsRename(actual.rename, ...args),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      mocks.hashReads += 1;
      return actual.createReadStream(...args);
    },
  };
});

vi.mock("../localPdfIngestion", () => ({
  queueLocalPdfParse: mocks.queueLocalPdfParse,
  readLocalPdfParseState: mocks.readLocalPdfParseState,
}));

vi.mock("../localPdfLookup", () => ({
  createLocalPdfLinkEvidenceSession: () => ({
    rehydrate: mocks.rehydrateLocalPdfLinkEvidence,
  }),
  lookupLocalPdfStructure: mocks.lookupLocalPdfStructure,
  rehydrateLocalPdfEvidence: mocks.rehydrateLocalPdfEvidence,
}));

let temporaryDirectory: string | null = null;

beforeEach(() => {
  mocks.dnsLookup.mockReset();
  mocks.dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.fsCopyFile.mockReset();
  mocks.fsCopyFile.mockImplementation((delegate, ...args) => delegate(...args));
  mocks.fsLink.mockReset();
  mocks.fsLink.mockImplementation((delegate, ...args) => delegate(...args));
  mocks.fsOpen.mockReset();
  mocks.fsOpen.mockImplementation((delegate, ...args) => delegate(...args));
  mocks.fsRename.mockReset();
  mocks.fsRename.mockImplementation((delegate, ...args) => delegate(...args));
  mocks.hashReads = 0;
  mocks.queueLocalPdfParse.mockReset();
  mocks.queueLocalPdfParse.mockResolvedValue({
    status: "queued",
    flat_text_fallback_available: true,
  });
  mocks.readLocalPdfParseState.mockReset();
  mocks.readLocalPdfParseState.mockResolvedValue({ status: "queued" });
  mocks.lookupLocalPdfStructure.mockReset();
  mocks.rehydrateLocalPdfEvidence.mockReset();
  mocks.rehydrateLocalPdfLinkEvidence.mockReset();
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.OPEN_LEGAL_DATA_HOME;
  delete process.env.GOVINFO_API_KEY;
  delete process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS;
  delete process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

async function setup(
  bytes = Buffer.from("%PDF-1.4 provider attachment"),
  headers: Record<string, string> = {},
) {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "mike-provider-pdf-"),
  );
  process.env.OPEN_LEGAL_DATA_HOME = temporaryDirectory;
  process.env.MIKE_LOCAL_DATA_DIR = path.join(temporaryDirectory, "library");
  const fetchMock = vi.fn(
    async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.length),
          ...headers,
        },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { bytes, fetchMock };
}

const govInfoAttachment = {
  provider: "govinfo" as const,
  identity: "USCOURTS-cod-1_22-cv-00930",
  structureSource: "flat_text" as const,
  url: "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
  filename: "decision.pdf",
};

function keyFromReference(reference: string) {
  return reference.split(":").at(-1)!;
}

function pointerPath(reference: string) {
  return path.join(
    temporaryDirectory!,
    "cache",
    "govinfo",
    "pdf",
    "requests",
    `${keyFromReference(reference)}.json`,
  );
}

function blobPath(sourceSha256: string) {
  return path.join(
    temporaryDirectory!,
    "cache",
    "govinfo",
    "pdf",
    "blobs",
    `${sourceSha256}.pdf`,
  );
}

function bindingPath(reference: string, sourceSha256: string) {
  return path.join(
    temporaryDirectory!,
    "cache",
    "govinfo",
    "pdf",
    "bindings",
    keyFromReference(reference),
    `${sourceSha256}.json`,
  );
}

function leasePath() {
  return path.join(
    temporaryDirectory!,
    "cache",
    "govinfo",
    "pdf",
    "request-leases.sqlite",
  );
}

function leaseRow(reference: string) {
  const database = new DatabaseSync(leasePath());
  try {
    return database
      .prepare(
        "SELECT owner, expires_at FROM request_leases WHERE request_key = ?",
      )
      .get(keyFromReference(reference)) as
      | { owner: string; expires_at: number }
      | undefined;
  } finally {
    database.close();
  }
}

function parserSourcePath(sourceSha256: string) {
  return path.join(
    temporaryDirectory!,
    "library",
    "provider-pdf",
    "by-sha256",
    `${sourceSha256}.pdf`,
  );
}

function digest(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("provider PDF Library bridge", () => {
  it("serializes one request key across isolated module instances", async () => {
    const { fetchMock } = await setup();
    const firstProcess = await import("../providerPdfLibraryBridge");
    vi.resetModules();
    const secondProcess = await import("../providerPdfLibraryBridge");

    const [first, second] = await Promise.all([
      firstProcess.ingestProviderPdfAttachment(govInfoAttachment),
      secondProcess.ingestProviderPdfAttachment(govInfoAttachment),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second?.reference_id).toBe(first?.reference_id);
    await expect(
      readFile(pointerPath(first!.request_reference), "utf8"),
    ).resolves.toContain('"status": "downloaded"');
  });

  it("cannot let an expired owner overwrite or release its replacement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    const { fetchMock } = await setup();
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const firstProcess = await import("../providerPdfLibraryBridge");
    const reference =
      firstProcess.providerPdfRequestReference(govInfoAttachment);
    const first = firstProcess
      .ingestProviderPdfAttachment(govInfoAttachment)
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const expiredOwner = leaseRow(reference)!.owner;

    vi.setSystemTime("2026-07-27T00:02:00.001Z");
    vi.resetModules();
    const secondProcess = await import("../providerPdfLibraryBridge");
    const second = secondProcess.ingestProviderPdfAttachment(govInfoAttachment);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const replacement = leaseRow(reference);
    expect(replacement?.owner).not.toBe(expiredOwner);

    resolveFirst(
      new Response(Buffer.from("%PDF-1.4 expired owner"), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    const expired = await first;
    expect(String(expired.error)).toContain("lease ownership was lost");
    expect(leaseRow(reference)?.owner).toBe(replacement?.owner);
    const guardedPointer = JSON.parse(
      await readFile(pointerPath(reference), "utf8"),
    );
    expect(guardedPointer.status).toBe("queued");
    expect(guardedPointer).not.toHaveProperty("source_sha256");

    resolveSecond(
      new Response(Buffer.from("%PDF-1.4 replacement owner"), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    await expect(second).resolves.toMatchObject({
      source_sha256: expect.any(String),
    });
    expect(leaseRow(reference)).toBeUndefined();
  });

  it("returns a durable queue reference before an exact download completes", async () => {
    await setup();
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");

    const queued =
      (await bridge.queueProviderPdfAttachment(govInfoAttachment))!;

    expect(queued.reference_id).toMatch(
      /^mike-provider-pdf:v1:govinfo:[a-f0-9]{64}$/u,
    );
    expect(queued).toMatchObject({
      download_status: "queued",
      parse_status: null,
      freshness_status: "stale",
      fetched_at: null,
      checked_at: null,
    });
    expect(mocks.queueLocalPdfParse).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(pointerPath(queued.reference_id), "utf8"))
        .status,
    ).toBe("queued");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFetch!(
      new Response(Buffer.from("%PDF-1.4 deferred"), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.queueLocalPdfParse).toHaveBeenCalledOnce(),
    );
  });

  it("keeps one shared blob, SHA-bound references, and a parser hardlink", async () => {
    const { fetchMock } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");

    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const second = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const state =
      await bridge.readProviderPdfAttachmentState(govInfoAttachment);

    expect(first).toMatchObject({
      provider: "govinfo",
      identity: govInfoAttachment.identity,
      cache_hit: false,
      parse_status: "queued",
    });
    expect(first!.reference_id).toBe(
      `${first!.request_reference}:${first!.source_sha256}`,
    );
    expect(second).toMatchObject({
      request_reference: first!.request_reference,
      reference_id: first!.reference_id,
      source_sha256: first!.source_sha256,
      cache_hit: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api_key=DEMO_KEY");

    const pointer = await readFile(
      pointerPath(first!.request_reference),
      "utf8",
    );
    expect(pointer).toContain('"schema_version": "mike.provider_pdf.v2"');
    expect(pointer).toContain('"status": "downloaded"');
    expect(pointer).toContain('"fetched_at"');
    expect(pointer).toContain('"checked_at"');
    expect(pointer).toContain(first!.request_reference);
    expect(pointer).not.toContain("api_key");
    expect(pointer).not.toContain("DEMO_KEY");

    const blob = blobPath(first!.source_sha256);
    const parseSource = mocks.queueLocalPdfParse.mock.calls[0][0].sourcePath;
    expect(parseSource).toContain(
      path.join("library", "provider-pdf", "by-sha256"),
    );
    expect((await stat(blob)).nlink).toBeGreaterThanOrEqual(2);
    expect((await stat(parseSource)).ino).toBe((await stat(blob)).ino);
    expect(state).toMatchObject({
      request_reference: first!.request_reference,
      reference_id: first!.reference_id,
      download_status: "downloaded",
      source_sha256: first!.source_sha256,
      parse_status: "queued",
    });
    await expect(
      access(path.join(temporaryDirectory!, "library", "files")),
    ).rejects.toThrow();
  });

  it("returns the immutable source reference immediately on a verified warm cache", async () => {
    const { fetchMock } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    mocks.queueLocalPdfParse.mockClear();

    const warm = await bridge.queueProviderPdfAttachment(govInfoAttachment);

    expect(warm).toMatchObject({
      download_status: "downloaded",
      parse_status: null,
      freshness_status: "current",
      fetched_at: expect.any(String),
      checked_at: expect.any(String),
      request_reference: ingested!.request_reference,
      reference_id: ingested!.reference_id,
      source_reference: ingested!.reference_id,
      source_sha256: ingested!.source_sha256,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(mocks.queueLocalPdfParse).toHaveBeenCalledOnce(),
    );
  });

  it("keeps an explicit provider revision readable across restart without revalidation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    const { fetchMock } = await setup();
    const versioned = {
      ...govInfoAttachment,
      version: "provider-pdf-revision-7",
    };
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(versioned);

    vi.setSystemTime("2027-07-27T00:00:00.000Z");
    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    const state = await restarted.readProviderPdfAttachmentState(versioned);

    expect(state).toMatchObject({
      reference_id: first!.reference_id,
      source_sha256: first!.source_sha256,
      download_status: "downloaded",
      freshness_status: "versioned",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("conditionally replaces stale unversioned PDFs without changing old source references", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const original = Buffer.from("%PDF-1.4 original");
    const { fetchMock } = await setup(original, {
      ETag: '"pdf-v1"',
      "Last-Modified": "Sun, 26 Jul 2026 00:00:00 GMT",
    });
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    vi.setSystemTime("2026-07-27T00:00:30.000Z");
    const insideInterval =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    expect(insideInterval?.reference_id).toBe(first?.reference_id);
    expect(fetchMock).toHaveBeenCalledOnce();

    const replacement = Buffer.from("%PDF-1.4 replacement");
    fetchMock.mockResolvedValueOnce(
      new Response(replacement, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
        },
      }),
    );
    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    const replaced =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      "If-None-Match": '"pdf-v1"',
      "If-Modified-Since": "Sun, 26 Jul 2026 00:00:00 GMT",
    });
    expect(replaced?.request_reference).toBe(first?.request_reference);
    expect(replaced?.source_sha256).not.toBe(first?.source_sha256);
    const replacementPointer = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );
    expect(replacementPointer.etag).toBeUndefined();
    expect(replacementPointer.last_modified).toBeUndefined();
    const historical = await bridge.readProviderPdfReferenceState(
      first!.reference_id,
    );
    const latest = await bridge.readProviderPdfReferenceState(
      first!.request_reference,
    );
    expect(historical).toMatchObject({
      reference_id: first!.reference_id,
      source_sha256: first!.source_sha256,
      freshness_status: "stale",
      download_status: "downloaded",
      fetched_at: "2026-07-27T00:00:00.000Z",
      checked_at: "2026-07-27T00:00:00.000Z",
    });
    expect(latest).toMatchObject({
      reference_id: replaced!.reference_id,
      source_sha256: replaced!.source_sha256,
      freshness_status: "current",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(replacement, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    vi.setSystemTime("2026-07-27T00:02:02.000Z");
    await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty(
      "If-Modified-Since",
    );
  });

  it("records conditional 304 checks and does not fetch again inside the interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const { fetchMock } = await setup(Buffer.from("%PDF-1.4 unchanged"), {
      ETag: '"unchanged"',
    });
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const before = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 304,
        headers: { ETag: '"unchanged"' },
      }),
    );
    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    const checked = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const after = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );

    expect(checked).toMatchObject({
      reference_id: first!.reference_id,
      cache_hit: true,
    });
    expect(after).toMatchObject({
      status: "downloaded",
      source_sha256: first!.source_sha256,
      fetched_at: before.fetched_at,
      checked_at: "2026-07-27T00:01:01.000Z",
    });
    await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a verified stale blob usable when refresh is offline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const bytes = Buffer.from("%PDF-1.4 offline cache");
    const { fetchMock } = await setup(bytes, { ETag: '"offline-v1"' });
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    const offline = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const state = await bridge.readProviderPdfAttachmentState(
      govInfoAttachment,
      { resume: false },
    );

    expect(offline).toMatchObject({
      reference_id: first!.reference_id,
      source_sha256: first!.source_sha256,
      cache_hit: true,
    });
    expect(state).toMatchObject({
      download_status: "downloaded",
      source_sha256: first!.source_sha256,
      freshness_status: "stale",
      checked_at: "2026-07-27T00:01:01.000Z",
    });
    expect(await readFile(blobPath(first!.source_sha256))).toEqual(bytes);
    await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips an input GovInfo key from storage and reference identity", async () => {
    const { fetchMock } = await setup();
    process.env.GOVINFO_API_KEY = "configured-key";
    const bridge = await import("../providerPdfLibraryBridge");
    const supplied = {
      ...govInfoAttachment,
      url: `${govInfoAttachment.url}?foo=bar&api_key=input-secret`,
      canonicalUrl:
        "https://www.govinfo.gov/app/details/USCOURTS-example" +
        "?collection=USCOURTS&api_key=canonical-secret",
    };
    const clean = {
      ...govInfoAttachment,
      url: `${govInfoAttachment.url}?foo=bar`,
      canonicalUrl:
        "https://www.govinfo.gov/app/details/USCOURTS-example" +
        "?collection=USCOURTS",
    };

    expect(bridge.providerPdfRequestReference(supplied)).toBe(
      bridge.providerPdfRequestReference(clean),
    );
    const ingested = await bridge.ingestProviderPdfAttachment(supplied);
    const pointer = await readFile(
      pointerPath(ingested!.request_reference),
      "utf8",
    );

    expect(pointer).not.toContain("input-secret");
    expect(pointer).not.toContain("canonical-secret");
    expect(pointer).not.toContain("configured-key");
    expect(ingested!.request_reference).not.toContain("input-secret");
    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.searchParams.get("api_key")).toBe("configured-key");
    expect(requested.searchParams.get("foo")).toBe("bar");
  });

  it("memoizes validation and safely repairs a corrupt immutable blob", async () => {
    const { bytes, fetchMock } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    mocks.hashReads = 0;
    await bridge.readProviderPdfAttachmentState(govInfoAttachment, {
      resume: false,
    });
    const afterFirstStatus = mocks.hashReads;
    await bridge.readProviderPdfAttachmentState(govInfoAttachment, {
      resume: false,
    });
    expect(afterFirstStatus).toBeGreaterThan(0);
    expect(mocks.hashReads).toBe(afterFirstStatus);

    const corrupt = Buffer.from("%PDF-1.4 corrupt");
    const blob = blobPath(first!.source_sha256);
    await writeFile(blob, corrupt);
    let windowsCollisionInjected = false;
    mocks.fsLink.mockImplementation(async (delegate, source, destination) => {
      if (
        !windowsCollisionInjected &&
        path.resolve(String(destination)) === path.resolve(blob)
      ) {
        windowsCollisionInjected = true;
        throw Object.assign(new Error("Windows destination collision"), {
          code: "EPERM",
        });
      }
      return delegate(source, destination);
    });
    const repaired =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(windowsCollisionInjected).toBe(true);
    expect(repaired?.source_sha256).toBe(first?.source_sha256);
    expect(await readFile(blob)).toEqual(bytes);
    expect(await readFile(parserSourcePath(first!.source_sha256))).toEqual(
      bytes,
    );
    expect(mocks.hashReads).toBeGreaterThan(afterFirstStatus);
  });

  it("shares parse bytes without collapsing identities under concurrent hardlink creation", async () => {
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const [first, second] = await Promise.all([
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
      bridge.ingestProviderPdfAttachment({
        ...govInfoAttachment,
        identity: "USCOURTS-cod-1_22-cv-00931",
      }),
    ]);

    expect(second?.request_reference).not.toBe(first?.request_reference);
    expect(second?.reference_id).not.toBe(first?.reference_id);
    expect(second?.source_sha256).toBe(first?.source_sha256);
    expect(mocks.queueLocalPdfParse.mock.calls[1][0].sourcePath).toBe(
      mocks.queueLocalPdfParse.mock.calls[0][0].sourcePath,
    );
  });

  it("copies cache bytes only when the Mike data directory is on another volume", async () => {
    const { bytes } = await setup();
    const sourceSha256 = digest(bytes);
    const blob = blobPath(sourceSha256);
    const parserSource = parserSourcePath(sourceSha256);
    mocks.fsLink.mockImplementation(async (delegate, source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(blob) &&
        String(destination).startsWith(`${parserSource}.`)
      ) {
        throw Object.assign(new Error("cross-volume link"), {
          code: "EXDEV",
        });
      }
      return delegate(source, destination);
    });
    const bridge = await import("../providerPdfLibraryBridge");

    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(ingested?.source_sha256).toBe(sourceSha256);
    expect(mocks.fsCopyFile).toHaveBeenCalledOnce();
    expect(path.resolve(String(mocks.fsCopyFile.mock.calls[0][1]))).toBe(
      path.resolve(blob),
    );
    expect(await readFile(parserSource)).toEqual(bytes);
    expect((await stat(parserSource)).ino).not.toBe((await stat(blob)).ino);
  });

  it("does not hide non-EXDEV hardlink failures behind a copy", async () => {
    const { bytes } = await setup();
    const sourceSha256 = digest(bytes);
    const blob = blobPath(sourceSha256);
    const parserSource = parserSourcePath(sourceSha256);
    mocks.fsLink.mockImplementation(async (delegate, source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(blob) &&
        String(destination).startsWith(`${parserSource}.`)
      ) {
        throw Object.assign(new Error("hardlink denied"), {
          code: "EPERM",
        });
      }
      return delegate(source, destination);
    });
    const bridge = await import("../providerPdfLibraryBridge");

    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(mocks.fsCopyFile).not.toHaveBeenCalled();
    await expect(access(parserSource)).rejects.toThrow();
  });

  it("accepts a concurrent immutable blob winner only after validating it", async () => {
    const { bytes } = await setup();
    const sourceSha256 = digest(bytes);
    const blob = blobPath(sourceSha256);
    let winnerInjected = false;
    mocks.fsLink.mockImplementation(async (delegate, source, destination) => {
      if (
        !winnerInjected &&
        path.resolve(String(destination)) === path.resolve(blob)
      ) {
        winnerInjected = true;
        await delegate(source, destination);
        return delegate(source, destination);
      }
      return delegate(source, destination);
    });
    const bridge = await import("../providerPdfLibraryBridge");

    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(winnerInjected).toBe(true);
    expect(ingested?.source_sha256).toBe(sourceSha256);
    expect(await readFile(blob)).toEqual(bytes);
  });

  it("restores a concurrent valid winner moved during corrupt-blob repair", async () => {
    const { bytes, fetchMock } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const blob = blobPath(first!.source_sha256);
    await writeFile(blob, Buffer.from("%PDF-1.4 corrupt"));
    let winnerInode: bigint | number | null = null;
    mocks.fsRename.mockImplementation(async (delegate, source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(blob) &&
        String(destination).endsWith(".quarantine")
      ) {
        await delegate(source, `${blob}.displaced-corrupt`);
        await writeFile(blob, bytes, { flag: "wx" });
        winnerInode = (await stat(blob)).ino;
        return delegate(blob, destination);
      }
      return delegate(source, destination);
    });

    const repaired =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repaired?.source_sha256).toBe(first?.source_sha256);
    expect(await readFile(blob)).toEqual(bytes);
    expect((await stat(blob)).ino).toBe(winnerInode);
  });

  it("serves the verified cache and keeps the last complete pointer when atomic rename fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const { fetchMock } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const pointer = pointerPath(first!.request_reference);
    const original = await readFile(pointer, "utf8");
    mocks.fsRename.mockImplementation(async (delegate, source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(pointer)) {
        throw Object.assign(new Error("pointer locked"), { code: "EPERM" });
      }
      return delegate(source, destination);
    });
    vi.setSystemTime("2026-07-27T00:01:01.000Z");

    const retained =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retained).toMatchObject({
      reference_id: first!.reference_id,
      source_sha256: first!.source_sha256,
      cache_hit: true,
    });
    expect(await readFile(pointer, "utf8")).toBe(original);
  });

  it("cancels a non-PDF response as soon as its bounded header is known", async () => {
    await setup();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
    const bridge = await import("../providerPdfLibraryBridge");

    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toThrow("not a PDF");

    expect(cancelled).toBe(true);
  });

  it("streams a PDF through a bounded temporary file and removes it after publication", async () => {
    await setup();
    const firstChunk = Buffer.from("%PDF-1.4 first chunk");
    const secondChunk = Buffer.from(" second chunk");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(firstChunk);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );
    const bridge = await import("../providerPdfLibraryBridge");
    const pending = bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const blobs = path.dirname(blobPath("0".repeat(64)));
    let temporary = "";

    await vi.waitFor(async () => {
      temporary =
        (await readdir(blobs)).find((name) => name.startsWith(".download-")) ??
        "";
      expect(temporary).not.toBe("");
      expect(await readFile(path.join(blobs, temporary))).toEqual(firstChunk);
    });

    controller.enqueue(secondChunk);
    controller.close();
    const ingested = await pending;
    expect(await readFile(blobPath(ingested!.source_sha256))).toEqual(
      Buffer.concat([firstChunk, secondChunk]),
    );
    expect(
      (await readdir(blobs)).some((name) => name.startsWith(".download-")),
    ).toBe(false);
  });

  it("cancels a declared oversized PDF before opening a temporary file", async () => {
    await setup();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(100 * 1024 * 1024 + 1),
          },
        }),
      ),
    );
    const bridge = await import("../providerPdfLibraryBridge");

    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toThrow("size limit");

    expect(cancelled).toBe(true);
    await expect(
      access(path.dirname(blobPath("0".repeat(64)))),
    ).rejects.toThrow();
  });

  it("cancels the response if its unique temporary file cannot be opened", async () => {
    await setup();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("%PDF-1.4"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );
    mocks.fsOpen.mockImplementation((delegate, filename, ...args) => {
      if (String(filename).includes(".download-")) {
        throw Object.assign(new Error("temporary file denied"), {
          code: "EACCES",
        });
      }
      return delegate(filename, ...args);
    });
    const bridge = await import("../providerPdfLibraryBridge");

    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(cancelled).toBe(true);
  });

  it("limits unique cold downloads while verified warm reads bypass the budget", async () => {
    const { bytes } = await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const warm = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve(
              new Response(bytes, {
                status: 200,
                headers: { "Content-Type": "application/pdf" },
              }),
            );
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cold = Array.from({ length: 4 }, (_, index) =>
      bridge.ingestProviderPdfAttachment({
        ...govInfoAttachment,
        identity: `USCOURTS-concurrency-${index}`,
      }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(peak).toBe(3);
    const warmAgain = await Promise.race([
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("warm cache waited")), 250),
      ),
    ]);
    expect(warmAgain?.reference_id).toBe(warm?.reference_id);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    releases.shift()!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    while (releases.length) releases.shift()!();
    await Promise.all(cold);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("keeps an old source reference bound when the latest pointer changes", async () => {
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const replacement = Buffer.from("%PDF-1.4 replacement");
    const replacementSha = crypto
      .createHash("sha256")
      .update(replacement)
      .digest("hex");
    await writeFile(blobPath(replacementSha), replacement);
    const pointerFile = pointerPath(first!.request_reference);
    const pointer = JSON.parse(await readFile(pointerFile, "utf8"));
    await writeFile(
      pointerFile,
      JSON.stringify({
        ...pointer,
        status: "ready",
        source_sha256: replacementSha,
      }),
    );

    const historical = await bridge.readProviderPdfReferenceState(
      first!.reference_id,
    );
    const latest = await bridge.readProviderPdfReferenceState(
      first!.request_reference,
    );

    expect(historical.source_sha256).toBe(first!.source_sha256);
    expect(historical.reference_id).toBe(first!.reference_id);
    expect(latest.source_sha256).toBe(replacementSha);
    expect(latest.reference_id).toBe(
      `${first!.request_reference}:${replacementSha}`,
    );
  });

  it("backs off a cold failure across polling and retries after the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS = "5000";
    const { fetchMock } = await setup();
    mocks.dnsLookup.mockRejectedValueOnce(new Error("temporary DNS failure"));
    const bridge = await import("../providerPdfLibraryBridge");

    const queued =
      (await bridge.queueProviderPdfAttachment(govInfoAttachment))!;
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(pointerPath(queued.reference_id), "utf8"))
          .status,
      ).toBe("failed"),
    );
    const inspected = await bridge.readProviderPdfAttachmentState(
      govInfoAttachment,
      { resume: false },
    );
    expect(inspected?.download_status).toBe("failed");
    expect(
      JSON.parse(await readFile(pointerPath(queued.reference_id), "utf8"))
        .status,
    ).toBe("failed");
    const failedPointer = JSON.parse(
      await readFile(pointerPath(queued.reference_id), "utf8"),
    );
    expect(failedPointer).toMatchObject({
      failure_count: 1,
      retry_after: expect.any(String),
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    for (let poll = 0; poll < 3; poll += 1) {
      await expect(
        restarted.readProviderPdfReferenceState(queued.reference_id),
      ).resolves.toMatchObject({ download_status: "failed" });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(Date.parse(failedPointer.retry_after) + 1));
    const resumed = await restarted.readProviderPdfReferenceState(
      queued.reference_id,
    );
    expect(resumed.download_status).toBe("queued");
    await vi.waitFor(() =>
      expect(mocks.queueLocalPdfParse).toHaveBeenCalledOnce(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves ready exact lookups and bounded evidence rehydration by SHA hardlink", async () => {
    await setup();
    mocks.queueLocalPdfParse.mockResolvedValue({
      status: "ready",
      flat_text_fallback_available: true,
    });
    const found = {
      status: "found",
      evidence: { handle: `mike-evidence:v1:${"a".repeat(64)}` },
      link: { page_numbers: [3] },
      units: [{ text: "Exact passage.", locator: "[page 3]" }],
      before: [],
      after: [],
    };
    mocks.lookupLocalPdfStructure.mockResolvedValue(found);
    mocks.rehydrateLocalPdfEvidence.mockResolvedValue(found);
    mocks.rehydrateLocalPdfLinkEvidence.mockResolvedValue({
      handle: found.evidence.handle,
      documentId: "provider-pdf-example",
      versionId: "a".repeat(32),
      href: "/single-documents/provider/evidence#page=3",
      label: "[page 3]",
      blockText: "Exact passage.",
      documentText: "Exact passage.",
      pageScoped: true,
      pageNumbers: [3],
      sources: [],
      pages: [],
    });
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    const lookup = await bridge.lookupProviderPdfReference(
      ingested!.reference_id,
      { locatorKind: "page", locator: "3" },
    );
    const rehydrated = await bridge.rehydrateProviderPdfReference(
      ingested!.reference_id,
      found.evidence.handle,
    );

    expect(lookup).toMatchObject({
      availability: "ready",
      state: {
        reference_id: ingested!.reference_id,
        source_sha256: ingested!.source_sha256,
      },
      lookup: found,
    });
    expect(mocks.lookupLocalPdfStructure).toHaveBeenCalledWith(
      expect.stringContaining(
        path.join(
          "provider-pdf",
          "by-sha256",
          `${ingested!.source_sha256}.pdf`,
        ),
      ),
      { locatorKind: "page", locator: "3" },
    );
    expect(rehydrated).toMatchObject({
      availability: "ready",
      lookup: found,
      linkEvidence: {
        documentText: "Exact passage.",
      },
    });
  });

  it("re-enters the parser queue when a downloaded reference is accessed after restart", async () => {
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    mocks.queueLocalPdfParse.mockClear();
    mocks.queueLocalPdfParse.mockResolvedValue({
      status: "queued",
      interrupted_at: "2026-07-27T00:00:00.000Z",
      flat_text_fallback_available: true,
    });

    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    const state = await restarted.readProviderPdfReferenceState(
      ingested!.reference_id,
    );

    expect(state).toMatchObject({
      reference_id: ingested!.reference_id,
      download_status: "downloaded",
      parse_status: "queued",
    });
    expect(mocks.queueLocalPdfParse).toHaveBeenCalledOnce();
    expect(mocks.queueLocalPdfParse.mock.calls[0][0]).toMatchObject({
      sourcePath: expect.stringContaining(
        path.join(
          "provider-pdf",
          "by-sha256",
          `${ingested!.source_sha256}.pdf`,
        ),
      ),
      sourceSha256: ingested!.source_sha256,
    });
  });

  it("rejects a request/SHA splice across restart while preserving bound references", async () => {
    const { fetchMock } = await setup(Buffer.from("%PDF-1.4 request A"));
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment({
      ...govInfoAttachment,
      identity: "USCOURTS-binding-a",
    });
    const secondBytes = Buffer.from("%PDF-1.4 request B");
    fetchMock.mockResolvedValueOnce(
      new Response(secondBytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    const second = await bridge.ingestProviderPdfAttachment({
      ...govInfoAttachment,
      identity: "USCOURTS-binding-b",
    });
    const splicedReference = `${first!.request_reference}:${second!.source_sha256}`;

    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    const legitimateFirst = await restarted.readProviderPdfReferenceState(
      first!.reference_id,
    );
    const legitimateSecond = await restarted.readProviderPdfReferenceState(
      second!.reference_id,
    );
    const spliced =
      await restarted.readProviderPdfReferenceState(splicedReference);

    expect(legitimateFirst).toMatchObject({
      download_status: "downloaded",
      source_sha256: first!.source_sha256,
      reference_id: first!.reference_id,
    });
    expect(legitimateSecond).toMatchObject({
      download_status: "downloaded",
      source_sha256: second!.source_sha256,
      reference_id: second!.reference_id,
    });
    expect(spliced).toMatchObject({
      download_status: "failed",
      source_sha256: null,
      source_reference: null,
    });
  });

  it("migrates a legacy source binding from its verified pointer", async () => {
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const binding = bindingPath(
      ingested!.request_reference,
      ingested!.source_sha256,
    );
    const legacy = JSON.parse(await readFile(binding, "utf8"));
    delete legacy.request;
    delete legacy.freshness;
    await writeFile(binding, JSON.stringify(legacy));

    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    const state = await restarted.readProviderPdfReferenceState(
      ingested!.reference_id,
    );
    const receipt = JSON.parse(await readFile(binding, "utf8"));

    expect(state).toMatchObject({
      download_status: "downloaded",
      source_sha256: ingested!.source_sha256,
    });
    expect(receipt).toMatchObject({
      schema_version: "mike.provider_pdf_binding.v1",
      provider: "govinfo",
      request_reference: ingested!.request_reference,
      source_sha256: ingested!.source_sha256,
      request: {
        request_reference: ingested!.request_reference,
        url: govInfoAttachment.url,
      },
      freshness: {
        fetched_at: expect.any(String),
        checked_at: expect.any(String),
      },
    });
  });

  it("recovers an exact SHA reference from its receipt without a valid pointer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    const ingested =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    await writeFile(pointerPath(ingested!.request_reference), "{corrupt");

    vi.setSystemTime("2026-07-27T00:02:00.000Z");
    vi.resetModules();
    const restarted = await import("../providerPdfLibraryBridge");
    const exact = await restarted.readProviderPdfReferenceState(
      ingested!.reference_id,
    );

    expect(exact).toMatchObject({
      reference_id: ingested!.reference_id,
      source_sha256: ingested!.source_sha256,
      download_status: "downloaded",
      freshness_status: "stale",
      fetched_at: "2026-07-27T00:00:00.000Z",
      checked_at: "2026-07-27T00:00:00.000Z",
    });
    await expect(
      restarted.readProviderPdfReferenceState(ingested!.request_reference),
    ).rejects.toThrow("reference is unavailable");
  });

  it("sends validators only to the exact URL that issued them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    await setup();
    const bytes = Buffer.from("%PDF-1.4 redirected evidence");
    const redirected =
      "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: redirected },
        }),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            ETag: '"redirected-v1"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: redirected },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { ETag: '"redirected-v1"' },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const pointer = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );

    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    const checked = await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    expect(pointer.validator_url).toBe(redirected);
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
      "If-None-Match": '"redirected-v1"',
    });
    expect(checked).toMatchObject({
      reference_id: first!.reference_id,
      cache_hit: true,
    });
  });

  it("does not send validators to a different path on the same origin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    await setup();
    const firstUrl =
      "https://www.govinfo.gov/content/pkg/example/pdf/first.pdf";
    const secondUrl =
      "https://www.govinfo.gov/content/pkg/example/pdf/second.pdf";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: firstUrl },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("%PDF-1.4 first path"), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            ETag: '"first-path"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: secondUrl },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("%PDF-1.4 second path"), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            ETag: '"second-path"',
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);

    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const pointer = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );

    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(fetchMock.mock.calls[3][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(pointer).toMatchObject({
      validator_url: secondUrl,
      etag: '"second-path"',
    });
  });

  it("omits legacy unbound validators until their issuing URL is learned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const { fetchMock } = await setup(Buffer.from("%PDF-1.4 legacy"), {
      ETag: '"legacy-v1"',
    });
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const pointerFile = pointerPath(first!.request_reference);
    const legacyPointer = JSON.parse(await readFile(pointerFile, "utf8"));
    delete legacyPointer.validator_url;
    await writeFile(pointerFile, JSON.stringify(legacyPointer));
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("%PDF-1.4 refreshed"), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          ETag: '"legacy-v2"',
        },
      }),
    );

    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const refreshed = JSON.parse(await readFile(pointerFile, "utf8"));

    expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    expect(refreshed).toMatchObject({
      etag: '"legacy-v2"',
      validator_url: govInfoAttachment.url,
    });
  });

  it("rejects an unsolicited cross-origin 304 instead of reusing cached evidence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-27T00:00:00.000Z");
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS = "60000";
    const { fetchMock } = await setup(Buffer.from("%PDF-1.4 origin A"), {
      ETag: '"origin-a"',
    });
    const bridge = await import("../providerPdfLibraryBridge");
    const first = await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    const redirected =
      "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf";
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: redirected },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    vi.setSystemTime("2026-07-27T00:01:01.000Z");
    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toThrow("304 without a matching URL-bound validator");

    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      "If-None-Match": '"origin-a"',
    });
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty(
      "If-None-Match",
    );
    const retained = JSON.parse(
      await readFile(pointerPath(first!.request_reference), "utf8"),
    );
    expect(retained.source_sha256).toBe(first!.source_sha256);
    expect(retained).toMatchObject({
      checked_at: "2026-07-27T00:01:01.000Z",
      refresh_failed_at: "2026-07-27T00:01:01.000Z",
    });
    const backedOff =
      await bridge.ingestProviderPdfAttachment(govInfoAttachment);
    expect(backedOff?.reference_id).toBe(first!.reference_id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(
      bridge.readProviderPdfAttachmentState(govInfoAttachment, {
        resume: false,
      }),
    ).resolves.toMatchObject({ freshness_status: "stale" });
  });

  it("rejects local/private DNS, alternate ports, origins, and redirect rebinding", async () => {
    await setup();
    const bridge = await import("../providerPdfLibraryBridge");
    await expect(
      bridge.ingestProviderPdfAttachment({
        provider: "govuk-et",
        identity: "1234567/2026",
        structureSource: "flat_text",
        url: "https://files.localhost/decision.pdf",
      }),
    ).rejects.toThrow("default-port HTTPS");
    await expect(
      bridge.ingestProviderPdfAttachment({
        ...govInfoAttachment,
        url: "https://api.govinfo.gov:444/decision.pdf",
      }),
    ).rejects.toThrow("default-port HTTPS");
    await expect(
      bridge.ingestProviderPdfAttachment({
        provider: "a2aj",
        identity: "SCC:1",
        structureSource: "flat_text",
        canonicalUrl: "https://decisions.scc-csc.ca/item/1",
        url: "https://other.scc-csc.ca/document.pdf",
      }),
    ).rejects.toThrow("canonical source origin");

    mocks.dnsLookup.mockResolvedValueOnce([
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(
      bridge.ingestProviderPdfAttachment(govInfoAttachment),
    ).rejects.toThrow("blocked network address");

    mocks.dnsLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
    ]);
    mocks.dnsLookup.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf",
          },
        }),
      ),
    );
    await expect(
      bridge.ingestProviderPdfAttachment({
        ...govInfoAttachment,
        identity: "USCOURTS-redirect",
      }),
    ).rejects.toThrow("blocked network address");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
