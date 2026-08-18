import path from "node:path";
import { readFile } from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import {
  documentProjectionService,
  type LocalPdfLookupInput,
  type LocalPdfParseStatus,
} from "./documentProjectionService";
import {
  atomicWriteProjection,
  inspectPdf,
  pdfContentPath,
  publishPdfStream,
  withProjectionLock,
} from "./documentProjection";
import {
  boundRemoteResponse,
  guardedRemoteFetch,
  normalizeRemoteHttpsUrl,
} from "./remoteUrlSafety";
import { sha256 } from "./hash";

type ProviderPdfFallbackProvider =
  | "a2aj"
  | "courtlistener"
  | "govinfo"
  | "govuk-et"
  | "tna";

export type ProviderPdfAttachment = {
  provider: ProviderPdfFallbackProvider;
  identity: string;
  structureSource: "native" | "hybrid" | "flat_text" | "section_map";
  url: string;
  canonicalUrl?: string | null;
  filename?: string | null;
  title?: string | null;
  version?: string | null;
  requestReference?: string | null;
};

export type ProviderPdfQueueResult = Omit<
  ProviderPdfAttachmentState,
  "download_status"
> & { download_status: "queued" | "downloaded" };

export type ProviderPdfLibraryResult = {
  provider: ProviderPdfFallbackProvider;
  identity: string;
  request_reference: string;
  reference_id: string;
  source_reference: string;
  source_sha256: string;
  cache_hit: boolean;
  parse_status: LocalPdfParseStatus;
};

type ProviderPdfFreshnessStatus =
  | "immutable"
  | "versioned"
  | "current"
  | "stale";

export type ProviderPdfAttachmentState = {
  provider: ProviderPdfFallbackProvider;
  identity: string;
  request_reference: string;
  reference_id: string;
  source_reference: string | null;
  download_status: "not_queued" | "queued" | "downloaded" | "failed";
  source_sha256: string | null;
  parse_status: LocalPdfParseStatus | null;
  freshness_status: ProviderPdfFreshnessStatus;
  fetched_at: string | null;
  checked_at: string | null;
};

type SafeRequest = ProviderPdfAttachment & {
  structureSource: "flat_text";
  canonicalUrl: string | null;
  filename: string | null;
  title: string | null;
  version: string | null;
  requestReference: string;
  requestKey: string;
};

type Freshness = {
  etag?: string;
  last_modified?: string;
  validator_url?: string;
  fetched_at?: string;
  checked_at?: string;
  refresh_failed_at?: string;
};

type RequestRecord = Omit<SafeRequest, "requestKey"> & Freshness & {
  schema_version: typeof RECORD_SCHEMA;
  status: "queued" | "downloaded" | "failed";
  current_sha256?: string;
  source_sha256s: string[];
  failure_count?: number;
  retry_after?: string;
  updated_at: string;
};

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_PDF_DOWNLOADS = 3;
const DEFAULT_REVALIDATE_MS = 24 * 60 * 60_000;
const MIN_REVALIDATE_MS = 60_000;
const MAX_REVALIDATE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_FAILURE_RETRY_MS = 60_000;
const MIN_FAILURE_RETRY_MS = 1_000;
const MAX_FAILURE_RETRY_MS = 60 * 60_000;
const POINTER_SCHEMA = "mike.provider_pdf.v2";
const RECORD_SCHEMA = "mike.provider_pdf_projection.v1";
const REFERENCE_PREFIX = "mike-provider-pdf:v1";
const REFERENCE_RE =
  /^mike-provider-pdf:v1:(a2aj|courtlistener|govinfo|govuk-et|tna):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/u;
const background = new Set<string>();
const waiters: Array<() => void> = [];
let activeDownloads = 0;

const fixedHosts: Partial<
  Record<ProviderPdfFallbackProvider, ReadonlySet<string>>
> = {
  courtlistener: new Set(["storage.courtlistener.com"]),
  govinfo: new Set(["api.govinfo.gov", "www.govinfo.gov"]),
  "govuk-et": new Set(["www.gov.uk", "assets.publishing.service.gov.uk"]),
  tna: new Set(["caselaw.nationalarchives.gov.uk"]),
};

class InvalidProviderPdfRevalidationError extends Error {}

function safeText(value: string | null | undefined, maximum: number) {
  const normalized = value?.trim().replace(/\s+/gu, " ") ?? "";
  return normalized && normalized.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function clampedMs(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
    : fallback;
}

function revalidateIntervalMs() {
  return clampedMs(
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS,
    MIN_REVALIDATE_MS,
    MAX_REVALIDATE_MS,
    DEFAULT_REVALIDATE_MS,
  );
}

function validTimestamp(value: string | undefined) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function refreshDue(request: SafeRequest, record: RequestRecord) {
  if (request.version) return false;
  const checkedAt = validTimestamp(record.checked_at);
  return checkedAt === null || Date.now() - checkedAt < 0 ||
    Date.now() - checkedAt >= revalidateIntervalMs();
}

function retryDue(record: RequestRecord) {
  const retryAt = validTimestamp(record.retry_after);
  return retryAt === null || Date.now() >= retryAt;
}

function failureFields(record: RequestRecord | null) {
  const previous = Number(record?.failure_count);
  const count = Math.min(
    Math.max(Number.isFinite(previous) ? Math.trunc(previous) : 0, 0) + 1,
    16,
  );
  const base = clampedMs(
    process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS,
    MIN_FAILURE_RETRY_MS,
    MAX_FAILURE_RETRY_MS,
    DEFAULT_FAILURE_RETRY_MS,
  );
  return {
    failure_count: count,
    retry_after: new Date(
      Date.now() + Math.min(base * 2 ** (count - 1), MAX_FAILURE_RETRY_MS),
    ).toISOString(),
  };
}

function sourceHistory(record: RequestRecord | null, added?: string) {
  const values = record?.source_sha256s ?? [];
  return added && !values.includes(added) ? [...values, added] : values;
}

function publicHttpsUrl(raw: string) {
  return normalizeRemoteHttpsUrl(raw, {
    label: "Provider PDF URL",
    maxUrlLength: 8_192,
    defaultPortOnly: true,
    allowIpLiterals: false,
    blockedHostSuffixes: [".local"],
  }).url;
}

function sourceUrl(params: ProviderPdfAttachment) {
  const url = publicHttpsUrl(params.url);
  const allowed = fixedHosts[params.provider];
  if (allowed && !allowed.has(url.hostname.toLowerCase())) {
    throw new Error("Provider PDF URL is outside the provider host");
  }
  if (params.provider === "a2aj") {
    const canonical = publicHttpsUrl(params.canonicalUrl || "");
    if (url.origin !== canonical.origin) {
      throw new Error("A2AJ PDF URL is outside the canonical source origin");
    }
  }
  if (params.provider === "govinfo") url.searchParams.delete("api_key");
  return url;
}

function safeRequest(params: ProviderPdfAttachment) {
  const url = sourceUrl(params);
  const canonical = params.canonicalUrl
    ? publicHttpsUrl(params.canonicalUrl)
    : null;
  if (canonical && params.provider === "govinfo") {
    canonical.searchParams.delete("api_key");
  }
  const identity = safeText(params.identity, 500);
  if (!identity) throw new Error("Provider PDF identity is invalid");
  const payload = {
    provider: params.provider,
    identity,
    structureSource: "flat_text" as const,
    url: url.toString(),
    canonicalUrl: canonical?.toString() ?? null,
    filename: safeText(params.filename, 260),
    title: safeText(params.title, 500),
    version: safeText(params.version, 200),
  };
  const requestKey = sha256(JSON.stringify([
    POINTER_SCHEMA,
    payload.provider,
    payload.identity,
    payload.url,
    payload.canonicalUrl,
    payload.version,
  ]));
  const requestReference = `${REFERENCE_PREFIX}:${params.provider}:${requestKey}`;
  if (params.requestReference && params.requestReference !== requestReference) {
    throw new Error("Provider PDF request reference does not match its source");
  }
  return {
    ...payload,
    requestReference,
    requestKey,
  } satisfies SafeRequest;
}

export function providerPdfRequestReference(params: ProviderPdfAttachment) {
  return safeRequest(params).requestReference;
}

function sourceReference(requestReference: string, sourceSha256: string) {
  return `${requestReference}:${sourceSha256}`;
}

function parsedReference(reference: string) {
  const match = reference.match(REFERENCE_RE);
  if (!match) throw new Error("Provider PDF reference is invalid");
  return {
    provider: match[1] as ProviderPdfFallbackProvider,
    requestKey: match[2],
    sourceSha256: match[3] ?? null,
    requestReference: `${REFERENCE_PREFIX}:${match[1]}:${match[2]}`,
  };
}

function requestDirectory(provider: ProviderPdfFallbackProvider) {
  return path.join(mikeLocalDataHome(), "projections", "v1", "provider-pdf", provider);
}

function recordPath(provider: ProviderPdfFallbackProvider, requestKey: string) {
  return path.join(requestDirectory(provider), `${requestKey}.json`);
}

function storedRequest(request: SafeRequest): Omit<SafeRequest, "requestKey"> {
  const { requestKey: _, ...stored } = request;
  return stored;
}

function parsedStoredRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return safeRequest(value as ProviderPdfAttachment);
  } catch {
    return null;
  }
}

async function readRecord(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
) {
  try {
    const value = JSON.parse(await readFile(recordPath(provider, requestKey), "utf8"));
    const request = parsedStoredRequest(value);
    const record = value as Partial<RequestRecord>;
    if (!request || record.schema_version !== RECORD_SCHEMA ||
      request.requestKey !== requestKey ||
      !["queued", "downloaded", "failed"].includes(String(record.status))) {
      return null;
    }
    if (record.current_sha256 !== undefined &&
      !/^[a-f0-9]{64}$/u.test(record.current_sha256)) return null;
    if (!Array.isArray(record.source_sha256s) ||
      record.source_sha256s.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) return null;
    return { ...record, ...request } as RequestRecord;
  } catch {
    return null;
  }
}

async function writeRecord(request: SafeRequest & { requestKey: string }, fields: {
  status: RequestRecord["status"];
  current_sha256?: string;
  source_sha256s: string[];
} & Partial<Freshness> & Partial<Pick<RequestRecord, "failure_count" | "retry_after">>) {
  const record: RequestRecord = {
    schema_version: RECORD_SCHEMA,
    ...storedRequest(request),
    ...fields,
    updated_at: new Date().toISOString(),
  };
  await atomicWriteProjection(
    recordPath(request.provider, request.requestKey),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

async function verifiedContent(sourceSha256: string) {
  const filename = pdfContentPath(sourceSha256);
  try {
    await inspectPdf(filename, { expectedSha256: sourceSha256 });
    return filename;
  } catch {
    return null;
  }
}

async function acquireDownloadSlot() {
  if (activeDownloads < MAX_CONCURRENT_PDF_DOWNLOADS) activeDownloads += 1;
  else await new Promise<void>((resolve) => waiters.push(resolve));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next();
    else activeDownloads -= 1;
  };
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

async function responseFor(
  params: ProviderPdfAttachment,
  initial: URL,
  cached: RequestRecord | null,
) {
  let current = initial;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    current = sourceUrl({ ...params, url: current.toString() });
    const requested = new URL(current);
    if (params.provider === "govinfo" &&
      requested.hostname.toLowerCase() === "api.govinfo.gov" &&
      !requested.searchParams.has("api_key")) {
      requested.searchParams.set(
        "api_key",
        process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY",
      );
    }
    const headers: Record<string, string> = {
      Accept: "application/pdf, application/octet-stream",
    };
    const validatorUrl = current.toString();
    if (cached?.validator_url === validatorUrl) {
      if (cached.etag) headers["If-None-Match"] = cached.etag;
      if (cached.last_modified) headers["If-Modified-Since"] = cached.last_modified;
    }
    const response = await guardedRemoteFetch(
      requested,
      { redirect: "manual", headers },
      { label: "Provider PDF URL", timeoutMs: 30_000 },
    );
    if (response.status === 304 &&
      !headers["If-None-Match"] && !headers["If-Modified-Since"]) {
      await cancelBody(response);
      throw new InvalidProviderPdfRevalidationError(
        "Provider returned 304 without a matching URL-bound validator",
      );
    }
    if (response.status === 304 || response.status < 300 || response.status >= 400) {
      return { response, responseUrl: validatorUrl };
    }
    const location = response.headers.get("location");
    await cancelBody(response);
    if (!location || redirects === 5) {
      throw new Error("Provider PDF redirect could not be resolved");
    }
    current = new URL(location, requested);
  }
  throw new Error("Provider PDF redirect limit exceeded");
}

async function streamPdf(response: Response) {
  if (!response.ok || !response.body) {
    await cancelBody(response);
    throw new Error(`Provider PDF request failed (${response.status})`);
  }
  response = await boundRemoteResponse(response, {
    label: "Provider PDF",
    maxBytes: MAX_PDF_BYTES,
  });
  if (!response.body) throw new Error("Provider PDF response has no body");
  const published = await publishPdfStream(response.body);
  return { path: published.path, sha256: published.sourceSha256 };
}

function responseFreshness(
  response: Response,
  responseUrl: string,
  previous: RequestRecord | null,
  downloaded: boolean,
): Freshness {
  const now = new Date().toISOString();
  const etag = safeText(response.headers.get("etag"), 1_024) ?? previous?.etag;
  const lastModified = safeText(response.headers.get("last-modified"), 1_024) ??
    previous?.last_modified;
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { last_modified: lastModified } : {}),
    ...(etag || lastModified
      ? { validator_url: responseUrl }
      : previous?.validator_url
        ? { validator_url: previous.validator_url }
        : {}),
    ...(downloaded
      ? { fetched_at: now }
      : previous?.fetched_at
        ? { fetched_at: previous.fetched_at }
        : {}),
    checked_at: now,
  };
}

async function download(request: ReturnType<typeof safeRequest>) {
  return withProjectionLock(request.requestReference, async () => {
    let record = await readRecord(request.provider, request.requestKey);
    const cachedSha = record?.status === "downloaded"
      ? record.current_sha256 ?? null
      : null;
    const cachedPath = cachedSha ? await verifiedContent(cachedSha) : null;
    if (record && cachedPath && !refreshDue(request, record)) {
      return { path: cachedPath, sha256: cachedSha!, cacheHit: true };
    }
    if (!cachedPath && record?.status === "failed" && !retryDue(record)) {
      throw new Error("Provider PDF retry is temporarily backed off");
    }
    if (!cachedPath) {
      record = await writeRecord(request, {
        status: "queued",
        source_sha256s: sourceHistory(record),
        ...(record?.failure_count ? { failure_count: record.failure_count } : {}),
      });
    }
    const release = await acquireDownloadSlot();
    try {
      const { response, responseUrl } = await responseFor(
        request,
        new URL(request.url),
        cachedPath ? record : null,
      );
      if (response.status === 304) {
        if (!cachedPath || !cachedSha) {
          throw new InvalidProviderPdfRevalidationError(
            "Provider returned 304 without a verified local PDF",
          );
        }
        const freshness = responseFreshness(response, responseUrl, record, false);
        await writeRecord(request, {
          status: "downloaded",
          current_sha256: cachedSha,
          source_sha256s: sourceHistory(record),
          ...freshness,
        });
        return { path: cachedPath, sha256: cachedSha, cacheHit: true };
      }
      const staged = await streamPdf(response);
      const freshness = responseFreshness(response, responseUrl, record, true);
      await writeRecord(request, {
        status: "downloaded",
        current_sha256: staged.sha256,
        source_sha256s: sourceHistory(record, staged.sha256),
        ...freshness,
      });
      return { path: staged.path, sha256: staged.sha256, cacheHit: false };
    } catch (error) {
      if (cachedPath && cachedSha && record) {
        const now = new Date().toISOString();
        await writeRecord(request, {
          status: "downloaded",
          current_sha256: cachedSha,
          source_sha256s: sourceHistory(record),
          ...(record.etag ? { etag: record.etag } : {}),
          ...(record.last_modified ? { last_modified: record.last_modified } : {}),
          ...(record.validator_url ? { validator_url: record.validator_url } : {}),
          ...(record.fetched_at ? { fetched_at: record.fetched_at } : {}),
          checked_at: now,
          refresh_failed_at: now,
        }).catch(() => undefined);
        if (error instanceof InvalidProviderPdfRevalidationError) throw error;
        return { path: cachedPath, sha256: cachedSha, cacheHit: true };
      }
      await writeRecord(request, {
        status: "failed",
        source_sha256s: sourceHistory(record),
        ...failureFields(record),
      });
      throw error;
    } finally {
      release();
    }
  });
}

async function ensureParser(sourcePath: string, sourceSha256: string) {
  return documentProjectionService.queuePdf({
    documentId: `provider-pdf-${sourceSha256.slice(0, 32)}`,
    versionId: sourceSha256.slice(0, 32),
    sourcePath,
    sourceSha256,
  });
}

export async function ingestProviderPdfAttachment(
  params: ProviderPdfAttachment,
): Promise<ProviderPdfLibraryResult | null> {
  if (params.structureSource !== "flat_text") return null;
  const request = safeRequest(params);
  const cached = await download(request);
  const parse = await ensureParser(cached.path, cached.sha256);
  const reference = sourceReference(request.requestReference, cached.sha256);
  return {
    provider: request.provider,
    identity: request.identity,
    request_reference: request.requestReference,
    reference_id: reference,
    source_reference: reference,
    source_sha256: cached.sha256,
    cache_hit: cached.cacheHit,
    parse_status: parse.status,
  };
}

function freshnessStatus(
  request: SafeRequest,
  record: RequestRecord | null,
): ProviderPdfFreshnessStatus {
  if (request.version) return "versioned";
  if (!record || record.refresh_failed_at || refreshDue(request, record)) return "stale";
  return "current";
}

function stateResult(
  request: SafeRequest,
  downloadStatus: ProviderPdfAttachmentState["download_status"],
  sourceSha256: string | null,
  parseStatus: LocalPdfParseStatus | null,
  record: RequestRecord | null = null,
): ProviderPdfAttachmentState {
  const source = sourceSha256
    ? sourceReference(request.requestReference, sourceSha256)
    : null;
  return {
    provider: request.provider,
    identity: request.identity,
    request_reference: request.requestReference,
    reference_id: source ?? request.requestReference,
    source_reference: source,
    download_status: downloadStatus,
    source_sha256: sourceSha256,
    parse_status: parseStatus,
    freshness_status: freshnessStatus(request, record),
    fetched_at: record?.fetched_at ?? null,
    checked_at: record?.checked_at ?? null,
  };
}

function startBackground(params: ProviderPdfAttachment) {
  const key = providerPdfRequestReference(params);
  if (background.has(key)) return;
  background.add(key);
  void ingestProviderPdfAttachment(params)
    .catch(() => undefined)
    .finally(() => background.delete(key));
}

export async function queueProviderPdfAttachment(
  params: ProviderPdfAttachment,
): Promise<ProviderPdfQueueResult | null> {
  if (params.structureSource !== "flat_text") return null;
  const request = safeRequest(params);
  const durable = await withProjectionLock(request.requestReference, async () => {
    const record = await readRecord(request.provider, request.requestKey);
    const sha = record?.status === "downloaded" ? record.current_sha256 ?? null : null;
    const content = sha ? await verifiedContent(sha) : null;
    const backedOff = record?.status === "failed" && !retryDue(record);
    if (content) return { record, sha, start: refreshDue(request, record!) };
    if (backedOff) return { record, sha: null, start: false };
    const queued = record?.status === "queued"
      ? record
      : await writeRecord(request, {
          status: "queued",
          source_sha256s: sourceHistory(record),
          ...(record?.failure_count ? { failure_count: record.failure_count } : {}),
        });
    return { record: queued, sha: null, start: true };
  });
  if (durable.start) startBackground(params);
  return stateResult(
    request,
    durable.sha ? "downloaded" : "queued",
    durable.sha,
    null,
    durable.record,
  ) as ProviderPdfQueueResult;
}

async function parsedState(
  request: SafeRequest,
  sourceSha256: string,
  sourcePath: string,
  record: RequestRecord | null,
  resume: boolean,
) {
  try {
    const parse = resume
      ? await ensureParser(sourcePath, sourceSha256)
      : await documentProjectionService.pdfState(sourcePath, {
          validatePublication: false,
        });
    return stateResult(
      request,
      "downloaded",
      sourceSha256,
      parse?.status ?? null,
      record,
    );
  } catch {
    return stateResult(request, "downloaded", sourceSha256, "failed", record);
  }
}

async function stateForRequest(
  request: SafeRequest & { requestKey: string },
  expectedSourceSha256: string | null,
  resume: boolean,
) {
  let record = await readRecord(request.provider, request.requestKey);
  let sourceSha256 = expectedSourceSha256;
  if (expectedSourceSha256) {
    if (!record?.source_sha256s.includes(expectedSourceSha256)) {
      return stateResult(request, "failed", null, null);
    }
    record = record?.current_sha256 === expectedSourceSha256 ? record : null;
  } else if (record?.status === "downloaded") {
    sourceSha256 = record.current_sha256 ?? null;
  }
  if (!sourceSha256) {
    const backedOff = record?.status === "failed" && !retryDue(record);
    if (resume && !backedOff) {
      await queueProviderPdfAttachment(request);
    }
    return stateResult(
      request,
      resume && !backedOff ? "queued" : record?.status ?? "not_queued",
      null,
      null,
      record,
    );
  }
  const sourcePath = await verifiedContent(sourceSha256);
  if (!sourcePath) {
    if (resume) await queueProviderPdfAttachment(request);
    return stateResult(request, resume ? "queued" : "failed", null, null, record);
  }
  if (resume && record && refreshDue(request, record)) {
    startBackground(request);
  }
  return parsedState(request, sourceSha256, sourcePath, record, resume);
}

export async function readProviderPdfAttachmentState(
  params: ProviderPdfAttachment,
  options?: { resume?: boolean },
): Promise<ProviderPdfAttachmentState | null> {
  if (params.structureSource !== "flat_text") return null;
  return stateForRequest(safeRequest(params), null, options?.resume !== false);
}

async function requestForReference(reference: string) {
  const parsed = parsedReference(reference);
  const record = await readRecord(parsed.provider, parsed.requestKey);
  if (!record) return null;
  const request = safeRequest(record);
  return { request, params: request, parsed };
}

export async function readProviderPdfReferenceState(reference: string) {
  const resolved = await requestForReference(reference);
  if (!resolved) throw new Error("Provider PDF reference is unavailable");
  return stateForRequest(
    resolved.request,
    resolved.parsed.sourceSha256,
    true,
  );
}

async function readyEvidence<Lookup extends { status: string }>(
  reference: string,
  lookupFor: (sourcePath: string) => Promise<Lookup>,
  handleFor: (lookup: Lookup) => string | null,
) {
  const resolved = await requestForReference(reference);
  if (!resolved) {
    return { availability: "error" as const, error: "Provider PDF reference is unavailable" };
  }
  const state = await stateForRequest(
    resolved.request,
    resolved.parsed.sourceSha256,
    true,
  );
  if (state.download_status !== "downloaded" || !state.source_sha256 ||
    !["ready", "degraded"].includes(String(state.parse_status))) {
    const failed = state.download_status === "failed" || state.parse_status === "failed";
    return {
      availability: failed ? "error" as const : "queued" as const,
      state,
      error: failed ? "Provider PDF download or parse failed" : undefined,
    };
  }
  const sourcePath = pdfContentPath(state.source_sha256);
  const lookup = await lookupFor(sourcePath);
  const handle = handleFor(lookup);
  return {
    availability: "ready" as const,
    state,
    params: resolved.params,
    lookup,
    linkEvidence: handle
      ? await documentProjectionService.rehydratePdfLink(sourcePath, handle)
      : null,
  };
}

export async function lookupProviderPdfReference(
  reference: string,
  input: LocalPdfLookupInput,
) {
  return readyEvidence(
    reference,
    (sourcePath) => documentProjectionService.lookupPdf(sourcePath, input),
    (lookup) => lookup.status === "found" ? lookup.evidence.handle : null,
  );
}

export async function rehydrateProviderPdfReference(
  reference: string,
  handle: string,
) {
  return readyEvidence(
    reference,
    (sourcePath) => documentProjectionService.rehydratePdfEvidence(sourcePath, handle),
    (lookup) => lookup.status === "found" ? handle : null,
  );
}
