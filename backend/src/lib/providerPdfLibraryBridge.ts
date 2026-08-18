import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { legalProviderCache, mikeLocalDataHome } from "./legalDataPath";
import {
  createLocalPdfLinkEvidenceSession,
  lookupLocalPdfStructure,
  rehydrateLocalPdfEvidence,
  type LocalPdfLookupInput,
} from "./localPdfLookup";
import {
  queueLocalPdfParse,
  readLocalPdfParseState,
  type LocalPdfParseStatus,
} from "./localPdfIngestion";
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
> & {
  download_status: "queued" | "downloaded";
};

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

type CachedPdf = {
  path: string;
  sha256: string;
  cacheHit: boolean;
  pointer: RequestPointer | null;
};

type SafeRequest = {
  provider: ProviderPdfFallbackProvider;
  identity: string;
  url: string;
  canonical_url: string | null;
  filename: string | null;
  title: string | null;
  version: string | null;
  request_reference: string;
};

type RequestPointer = SafeRequest & {
  schema_version: typeof POINTER_SCHEMA;
  status: "queued" | "downloaded" | "failed";
  source_sha256?: string;
  etag?: string;
  last_modified?: string;
  validator_url?: string;
  fetched_at?: string;
  checked_at?: string;
  refresh_failed_at?: string;
  failure_count?: number;
  retry_after?: string;
  updated_at: string;
};

type SourceBindingReceipt = {
  schema_version: typeof SOURCE_BINDING_SCHEMA;
  provider: ProviderPdfFallbackProvider;
  request_reference: string;
  source_sha256: string;
  bound_at: string;
  request: SafeRequest;
  freshness: PointerRefresh;
};

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_PDF_DOWNLOADS = 3;
const DEFAULT_REVALIDATE_MS = 24 * 60 * 60_000;
const MIN_REVALIDATE_MS = 60_000;
const MAX_REVALIDATE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_FAILURE_RETRY_MS = 60_000;
const MIN_FAILURE_RETRY_MS = 1_000;
const MAX_FAILURE_RETRY_MS = 60 * 60_000;
const REQUEST_LOCK_WAIT_MS = 35_000;
const REQUEST_LEASE_MS = 2 * 60_000;
const REQUEST_LEASE_HEARTBEAT_MS = 30_000;
const REQUEST_LOCK_RETRY_MS = 25;
const POINTER_SCHEMA = "mike.provider_pdf.v2";
const SOURCE_BINDING_SCHEMA = "mike.provider_pdf_binding.v1";
const REFERENCE_PREFIX = "mike-provider-pdf:v1";
const REFERENCE_RE =
  /^mike-provider-pdf:v1:(a2aj|courtlistener|govinfo|govuk-et|tna):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/u;
const downloads = new Map<string, Promise<CachedPdf>>();
const backgroundJobs = new Map<string, Promise<ProviderPdfLibraryResult>>();
const hardlinkJobs = new Map<string, Promise<string>>();
const knownRequests = new Map<string, ProviderPdfAttachment>();
const hashMemo = new Map<
  string,
  { signature: string; sha256: string; hasPdfHeader: boolean }
>();
const downloadWaiters: Array<() => void> = [];
let activeDownloads = 0;
const fixedHosts: Partial<
  Record<ProviderPdfFallbackProvider, ReadonlySet<string>>
> = {
  courtlistener: new Set(["storage.courtlistener.com"]),
  govinfo: new Set(["api.govinfo.gov", "www.govinfo.gov"]),
  "govuk-et": new Set(["www.gov.uk", "assets.publishing.service.gov.uk"]),
  tna: new Set(["caselaw.nationalarchives.gov.uk"]),
};

type PointerRefresh = Pick<
  RequestPointer,
  (typeof REFRESH_FIELD_KEYS)[number]
>;

type PointerWriteFields = PointerRefresh &
  Partial<Pick<RequestPointer, "failure_count" | "retry_after">>;

type RequestLease = {
  guard: <T>(operation: () => Promise<T>) => Promise<T>;
  release: () => void;
};

class InvalidProviderPdfRevalidationError extends Error {}
class LostProviderPdfLeaseError extends Error {}

async function acquireDownloadSlot() {
  if (activeDownloads < MAX_CONCURRENT_PDF_DOWNLOADS) activeDownloads += 1;
  else await new Promise<void>((resolve) => downloadWaiters.push(resolve));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = downloadWaiters.shift();
    if (next) next();
    else activeDownloads -= 1;
  };
}

function safeText(value: string | null | undefined, maximum: number) {
  const normalized = value?.trim().replace(/\s+/gu, " ") ?? "";
  return normalized &&
    normalized.length <= maximum &&
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
  const configured = Number(raw);
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.trunc(configured), minimum), maximum)
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

function refreshDue(
  request: { version?: string | null },
  pointer: RequestPointer,
) {
  if (request.version) return false;
  const checkedAt = validTimestamp(pointer.checked_at);
  const age = checkedAt === null ? null : Date.now() - checkedAt;
  return age === null || age < 0 || age >= revalidateIntervalMs();
}

function retryDue(pointer: RequestPointer) {
  const retryAt = validTimestamp(pointer.retry_after);
  return retryAt === null || Date.now() >= retryAt;
}

function failureFields(pointer: RequestPointer | null) {
  const previous = Number(pointer?.failure_count);
  const count = Math.min(
    Math.max(Number.isFinite(previous) ? Math.trunc(previous) : 0, 0) + 1,
    16,
  );
  const retryMs = clampedMs(
    process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS,
    MIN_FAILURE_RETRY_MS,
    MAX_FAILURE_RETRY_MS,
    DEFAULT_FAILURE_RETRY_MS,
  );
  const delay = Math.min(retryMs * 2 ** (count - 1), MAX_FAILURE_RETRY_MS);
  return {
    failure_count: count,
    retry_after: new Date(Date.now() + delay).toISOString(),
  };
}

// Falsy fields are dropped so persisted JSON keeps its historical shape
// (absent keys, never null/empty), and insertion order is preserved.
function prune<T extends object>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value),
  ) as { [K in keyof T]?: NonNullable<T[K]> };
}

const REFRESH_FIELD_KEYS = [
  "etag",
  "last_modified",
  "validator_url",
  "fetched_at",
  "checked_at",
  "refresh_failed_at",
] as const;

function refreshFields(pointer: RequestPointer): PointerRefresh {
  return prune(
    Object.fromEntries(REFRESH_FIELD_KEYS.map((key) => [key, pointer[key]])),
  ) as PointerRefresh;
}

function responseRefreshFields(
  response: Response,
  responseUrl: string,
  previous: RequestPointer | null,
  downloaded: boolean,
): PointerRefresh {
  const now = new Date().toISOString();
  const prior = downloaded ? null : previous;
  const responseEtag = safeText(response.headers.get("etag"), 500);
  const responseLastModified = safeText(
    response.headers.get("last-modified"),
    200,
  );
  const etag = responseEtag || prior?.etag || null;
  const lastModified = responseLastModified || prior?.last_modified || null;
  const validatorUrl =
    etag || lastModified
      ? responseEtag || responseLastModified
        ? responseUrl
        : prior?.validator_url
      : null;
  return prune({
    etag,
    last_modified: lastModified,
    validator_url: validatorUrl,
    fetched_at: downloaded ? now : previous?.fetched_at,
    checked_at: now,
  });
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
  if (params.provider === "govinfo") {
    url.searchParams.delete("api_key");
  }
  return url;
}

function safeRequest(
  params: ProviderPdfAttachment,
  url = sourceUrl(params),
): SafeRequest & { requestKey: string } {
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
    url: url.toString(),
    canonical_url: canonical?.toString() ?? null,
    filename: safeText(params.filename, 260),
    title: safeText(params.title, 500),
    version: safeText(params.version, 200),
  };
  const requestKey = sha256(
    JSON.stringify([
      POINTER_SCHEMA,
      payload.provider,
      payload.identity,
      payload.url,
      payload.canonical_url,
      payload.version,
    ]),
  );
  const requestReference = `${REFERENCE_PREFIX}:${params.provider}:${requestKey}`;
  if (params.requestReference && params.requestReference !== requestReference) {
    throw new Error("Provider PDF request reference does not match its source");
  }
  return { ...payload, request_reference: requestReference, requestKey };
}

export function providerPdfRequestReference(params: ProviderPdfAttachment) {
  return safeRequest(params).request_reference;
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

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Discarded bodies are never evidence; closing them is best effort.
  }
}

async function responseFor(
  params: ProviderPdfAttachment,
  initial: URL,
  cached: RequestPointer | null = null,
) {
  let current = initial;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    current = sourceUrl({ ...params, url: current.toString() });
    const requested = new URL(current);
    if (
      params.provider === "govinfo" &&
      requested.hostname.toLowerCase() === "api.govinfo.gov" &&
      !requested.searchParams.has("api_key")
    ) {
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
      if (cached.last_modified) {
        headers["If-Modified-Since"] = cached.last_modified;
      }
    }
    const response = await guardedRemoteFetch(
      requested,
      { redirect: "manual", headers },
      { label: "Provider PDF URL", timeoutMs: 30_000 },
    );
    if (
      response.status === 304 &&
      !headers["If-None-Match"] &&
      !headers["If-Modified-Since"]
    ) {
      await cancelBody(response);
      throw new InvalidProviderPdfRevalidationError(
        "Provider returned 304 without a matching URL-bound validator",
      );
    }
    if (
      response.status === 304 ||
      response.status < 300 ||
      response.status >= 400
    ) {
      return { response, responseUrl: validatorUrl };
    }
    const location = response.headers.get("location");
    await cancelBody(response);
    if (!location || redirects === 5) {
      throw new Error("Provider PDF redirect could not be resolved");
    }
    // The next loop iteration re-validates the redirect target via sourceUrl.
    current = new URL(location, requested);
  }
  throw new Error("Provider PDF redirect limit exceeded");
}

async function streamPdfToTemporary(response: Response, directory: string) {
  if (!response.ok || !response.body) {
    await cancelBody(response);
    throw new Error(`Provider PDF request failed (${response.status})`);
  }
  response = await boundRemoteResponse(response, {
    label: "Provider PDF",
    maxBytes: MAX_PDF_BYTES,
  });
  if (!response.body) throw new Error("Provider PDF response has no body");
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.download-${crypto.randomUUID()}.tmp`);
  // try/catch (not .catch) so a synchronous open() throw still cancels.
  let output: Awaited<ReturnType<typeof open>>;
  try {
    output = await open(temporary, "wx");
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
  const reader = response.body.getReader();
  const digest = crypto.createHash("sha256");
  const header = Buffer.alloc(1024);
  let headerSize = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (headerSize < header.length) {
        const copied = Math.min(header.length - headerSize, value.byteLength);
        header.set(value.subarray(0, copied), headerSize);
        headerSize += copied;
        if (
          headerSize === header.length &&
          header.indexOf("%PDF-", 0, "utf8") < 0
        ) {
          throw new Error("Provider attachment is not a PDF");
        }
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await output.write(
          value,
          offset,
          value.byteLength - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error("Provider PDF temporary write made no progress");
        }
        offset += bytesWritten;
      }
    }
    if (header.subarray(0, headerSize).indexOf("%PDF-") < 0) {
      throw new Error("Provider attachment is not a PDF");
    }
    await output.close();
    return { path: temporary, sha256: digest.digest("hex") };
  } catch (error) {
    for (const cleanup of [() => reader.cancel(), () => output.close()]) {
      try {
        await cleanup();
      } catch {
        // Preserve the validation or write error.
      }
    }
    invalidateHash(temporary);
    await rm(temporary, { force: true });
    throw error;
  }
}

function cacheFile(provider: ProviderPdfFallbackProvider, ...parts: string[]) {
  return path.join(legalProviderCache(provider), "pdf", ...parts);
}

function blobPath(provider: ProviderPdfFallbackProvider, sourceSha256: string) {
  return cacheFile(provider, "blobs", `${sourceSha256}.pdf`);
}

function bindingFilePath(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  sourceSha256: string,
) {
  return cacheFile(provider, "bindings", requestKey, `${sourceSha256}.json`);
}

function pointerPath(provider: ProviderPdfFallbackProvider, requestKey: string) {
  return cacheFile(provider, "requests", `${requestKey}.json`);
}

function leaseDatabasePath(provider: ProviderPdfFallbackProvider) {
  return cacheFile(provider, "request-leases.sqlite");
}

function openLeaseDatabase(provider: ProviderPdfFallbackProvider) {
  const database = new DatabaseSync(leaseDatabasePath(provider));
  try {
    database.exec(`
      PRAGMA busy_timeout = 0;
      CREATE TABLE IF NOT EXISTS request_leases (
        request_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function leaseWrite<T>(
  provider: ProviderPdfFallbackProvider,
  operation: (database: DatabaseSync) => T,
) {
  const database = openLeaseDatabase(provider);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

const RENEW_LEASE_SQL =
  "UPDATE request_leases SET expires_at = ? WHERE request_key = ? AND owner = ? AND expires_at > ?";

function tryAcquireRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
) {
  const now = Date.now();
  // BEGIN IMMEDIATE serializes writers, so the upsert can take over an
  // expired lease atomically; a live lease leaves changes at 0.
  return leaseWrite(provider, (database) => {
    const updated = database
      .prepare(
        `INSERT INTO request_leases (request_key, owner, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(request_key) DO UPDATE
         SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE request_leases.expires_at <= ?`,
      )
      .run(requestKey, owner, now + REQUEST_LEASE_MS, now);
    return Number(updated.changes) === 1;
  });
}

function renewRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
) {
  const now = Date.now();
  return leaseWrite(provider, (database) => {
    const updated = database
      .prepare(RENEW_LEASE_SQL)
      .run(now + REQUEST_LEASE_MS, requestKey, owner, now);
    return Number(updated.changes) === 1;
  });
}

async function guardRequestLease<T>(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
  operation: () => Promise<T>,
) {
  const deadline = Date.now() + REQUEST_LOCK_WAIT_MS;
  for (;;) {
    let database: DatabaseSync | null = null;
    let inTransaction = false;
    try {
      database = openLeaseDatabase(provider);
      database.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      const now = Date.now();
      const updated = database
        .prepare(RENEW_LEASE_SQL)
        .run(now + REQUEST_LEASE_MS, requestKey, owner, now);
      if (Number(updated.changes) !== 1) {
        throw new LostProviderPdfLeaseError(
          "Provider PDF request lease ownership was lost",
        );
      }
      const result = await operation();
      database.exec("COMMIT");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          database!.exec("ROLLBACK");
        } catch {
          // The original ownership or filesystem failure is more useful.
        }
        throw error;
      }
      if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
    } finally {
      try {
        database?.close();
      } catch {
        // A failed SQLite operation is already being propagated or retried.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_LOCK_RETRY_MS));
  }
}

function releaseRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
) {
  return leaseWrite(provider, (database) => {
    database
      .prepare("DELETE FROM request_leases WHERE request_key = ? AND owner = ?")
      .run(requestKey, owner);
  });
}

function sqliteBusy(error: unknown) {
  return /busy|locked/iu.test((error as Error).message);
}

async function acquireRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
): Promise<RequestLease> {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + REQUEST_LOCK_WAIT_MS;
  await mkdir(path.dirname(leaseDatabasePath(provider)), { recursive: true });
  for (;;) {
    try {
      if (tryAcquireRequestLease(provider, requestKey, owner)) {
        let released = false;
        let lost = false;
        let guarding = false;
        const heartbeat = setInterval(() => {
          if (released || lost || guarding) return;
          try {
            if (!renewRequestLease(provider, requestKey, owner)) lost = true;
          } catch {
            // A guarded pointer write performs a synchronous ownership check.
          }
        }, REQUEST_LEASE_HEARTBEAT_MS);
        heartbeat.unref();
        return {
          guard: async <T>(operation: () => Promise<T>) => {
            if (released || lost) {
              throw new LostProviderPdfLeaseError(
                "Provider PDF request lease ownership was lost",
              );
            }
            guarding = true;
            try {
              return await guardRequestLease(
                provider,
                requestKey,
                owner,
                operation,
              );
            } catch (error) {
              if (error instanceof LostProviderPdfLeaseError) lost = true;
              throw error;
            } finally {
              guarding = false;
            }
          },
          release: () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            try {
              releaseRequestLease(provider, requestKey, owner);
            } catch {
              // Expiry is the safe fallback if SQLite is temporarily busy.
            }
          },
        };
      }
    } catch (error) {
      if (!sqliteBusy(error)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for provider PDF request lease");
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_LOCK_RETRY_MS));
  }
}

function invalidateHash(filename: string) {
  hashMemo.delete(path.resolve(filename));
}

async function atomicWrite(filename: string, value: string | Buffer) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  invalidateHash(filename);
  try {
    await writeFile(temporary, value);
    await rename(temporary, filename);
  } finally {
    invalidateHash(filename);
    await rm(temporary, { force: true });
  }
}

function requestSnapshot(request: ReturnType<typeof safeRequest>): SafeRequest {
  const { requestKey: _requestKey, ...snapshot } = request;
  return snapshot;
}

function attachmentFromStored(
  stored: Partial<SafeRequest>,
): ProviderPdfAttachment | null {
  if (
    !["a2aj", "courtlistener", "govinfo", "govuk-et", "tna"].includes(
      String(stored.provider),
    ) ||
    typeof stored.identity !== "string" ||
    typeof stored.url !== "string" ||
    typeof stored.request_reference !== "string"
  ) {
    return null;
  }
  const optional = (value: string | null | undefined) =>
    typeof value === "string" ? value : undefined;
  return {
    provider: stored.provider as ProviderPdfFallbackProvider,
    identity: stored.identity,
    structureSource: "flat_text",
    url: stored.url,
    canonicalUrl: optional(stored.canonical_url),
    filename: optional(stored.filename),
    title: optional(stored.title),
    version: optional(stored.version),
    requestReference: stored.request_reference,
  };
}

function requestFromSnapshot(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<SafeRequest>;
  const params = attachmentFromStored(stored);
  if (!params) return null;
  try {
    const request = safeRequest(params);
    const normalized = requestSnapshot(request);
    for (const key of Object.keys(normalized) as Array<keyof SafeRequest>) {
      if (stored[key] !== normalized[key]) return null;
    }
    return { params, request };
  } catch {
    return null;
  }
}

function normalizedFreshness(
  value: unknown,
  params: ProviderPdfAttachment,
): PointerRefresh {
  if (!value || typeof value !== "object") return {};
  const stored = value as Partial<PointerRefresh>;
  let validatorUrl: string | null = null;
  if (typeof stored.validator_url === "string") {
    try {
      validatorUrl = sourceUrl({
        ...params,
        url: stored.validator_url,
      }).toString();
      if (validatorUrl !== stored.validator_url) validatorUrl = null;
    } catch {
      validatorUrl = null;
    }
  }
  const timestamp = (candidate: string | undefined) =>
    validTimestamp(candidate) === null ? null : candidate;
  return prune({
    etag: safeText(stored.etag, 500),
    last_modified: safeText(stored.last_modified, 200),
    validator_url: validatorUrl,
    fetched_at: timestamp(stored.fetched_at),
    checked_at: timestamp(stored.checked_at),
    refresh_failed_at: timestamp(stored.refresh_failed_at),
  });
}

async function readSourceBinding(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(
        bindingFilePath(request.provider, request.requestKey, sourceSha256),
        "utf8",
      ),
    ) as Partial<SourceBindingReceipt>;
    if (
      stored.schema_version !== SOURCE_BINDING_SCHEMA ||
      stored.provider !== request.provider ||
      stored.request_reference !== request.request_reference ||
      stored.source_sha256 !== sourceSha256 ||
      typeof stored.bound_at !== "string" ||
      validTimestamp(stored.bound_at) === null
    ) {
      return null;
    }
    const recovered = requestFromSnapshot(stored.request);
    if (
      !recovered ||
        recovered.request.requestKey !== request.requestKey ||
        recovered.request.request_reference !== request.request_reference
    ) {
      return null;
    }
    return {
      schema_version: SOURCE_BINDING_SCHEMA,
      provider: request.provider,
      request_reference: request.request_reference,
      source_sha256: sourceSha256,
      bound_at: stored.bound_at,
      request: requestSnapshot(recovered.request),
      freshness: normalizedFreshness(stored.freshness, recovered.params),
    } satisfies SourceBindingReceipt;
  } catch {
    return null;
  }
}

async function writeSourceBinding(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
  freshness: PointerRefresh = {},
  existingLease?: RequestLease,
) {
  const lease =
    existingLease ??
    (await acquireRequestLease(request.provider, request.requestKey));
  try {
    return await lease.guard(async () => {
      const existing = await readSourceBinding(request, sourceSha256);
      if (existing) return existing;
      const receipt = {
        schema_version: SOURCE_BINDING_SCHEMA,
        provider: request.provider,
        request_reference: request.request_reference,
        source_sha256: sourceSha256,
        bound_at: new Date().toISOString(),
        request: requestSnapshot(request),
        freshness: normalizedFreshness(freshness, attachmentFromStored(request)!),
      } satisfies SourceBindingReceipt;
      try {
        await atomicWrite(
          bindingFilePath(request.provider, request.requestKey, sourceSha256),
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
      } catch (error) {
        const winner = await readSourceBinding(request, sourceSha256);
        if (winner) return winner;
        throw error;
      }
      return receipt;
    });
  } finally {
    if (!existingLease) lease.release();
  }
}

async function ensureSourceBinding(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
  blob: string,
) {
  if (!(await validPdfFile(blob, sourceSha256))) return false;
  const receipt = await readSourceBinding(request, sourceSha256);
  return receipt !== null;
}

async function sourceBindingForReference(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  sourceSha256: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(
        bindingFilePath(provider, requestKey, sourceSha256),
        "utf8",
      ),
    ) as Partial<SourceBindingReceipt>;
    // readSourceBinding re-validates every stored receipt field against the
    // recovered request, so only the identity checks remain here.
    const recovered = requestFromSnapshot(stored.request);
    if (
      !recovered ||
      recovered.params.provider !== provider ||
      recovered.request.requestKey !== requestKey
    ) {
      return null;
    }
    const receipt = await readSourceBinding(recovered.request, sourceSha256);
    return receipt ? { ...recovered, receipt } : null;
  } catch {
    return null;
  }
}

function bindingPointer(
  request: SafeRequest,
  sourceSha256: string,
  receipt: SourceBindingReceipt | null,
) {
  if (!receipt) return null;
  return {
    schema_version: POINTER_SCHEMA,
    ...request,
    status: "downloaded",
    source_sha256: sourceSha256,
    ...receipt.freshness,
    updated_at: receipt.bound_at,
  } satisfies RequestPointer;
}

// Shares one in-flight job per key and clears the slot once it settles.
function share<T>(
  jobs: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
) {
  const existing = jobs.get(key);
  if (existing) return existing;
  const pending = create();
  jobs.set(key, pending);
  return pending.finally(() => {
    if (jobs.get(key) === pending) jobs.delete(key);
  });
}

async function hashFile(filename: string) {
  return new Promise<string>((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function validPdfFile(filename: string, expectedSha256: string) {
  const resolved = path.resolve(filename);
  try {
    const { dev, ino, size, mtimeMs, ctimeMs } = await stat(resolved);
    const signature = [dev, ino, size, mtimeMs, ctimeMs].join(":");
    const cached = hashMemo.get(resolved);
    if (cached?.signature === signature) {
      return cached.hasPdfHeader && cached.sha256 === expectedSha256;
    }
    const handle = await open(resolved, "r");
    let hasPdfHeader = false;
    try {
      const header = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      hasPdfHeader = header.subarray(0, bytesRead).indexOf("%PDF-") >= 0;
    } finally {
      await handle.close();
    }
    const actualSha256 = hasPdfHeader ? await hashFile(resolved) : "";
    hashMemo.set(resolved, { signature, sha256: actualSha256, hasPdfHeader });
    return hasPdfHeader && actualSha256 === expectedSha256;
  } catch {
    hashMemo.delete(resolved);
    return false;
  }
}

function linkDenied(error: unknown) {
  return ["EACCES", "EEXIST", "EPERM"].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}

async function publishImmutablePdf(
  temporary: string,
  destination: string,
  expectedSha256: string,
) {
  try {
    await link(temporary, destination);
  } catch (error) {
    if (!linkDenied(error)) throw error;
    invalidateHash(destination);
    if (await validPdfFile(destination, expectedSha256)) return;
    throw error;
  }
  invalidateHash(destination);
  if (!(await validPdfFile(destination, expectedSha256))) {
    throw new Error("Published provider PDF failed integrity validation");
  }
}

async function publishOrRepairImmutablePdf(
  temporary: string,
  destination: string,
  expectedSha256: string,
) {
  try {
    await publishImmutablePdf(temporary, destination, expectedSha256);
    return;
  } catch (error) {
    if (!linkDenied(error)) throw error;
    try {
      await stat(destination);
    } catch {
      throw error;
    }
  }

  const quarantine = `${destination}.${crypto.randomUUID()}.quarantine`;
  try {
    await rename(destination, quarantine);
  } catch (error) {
    invalidateHash(destination);
    if (await validPdfFile(destination, expectedSha256)) return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await publishImmutablePdf(temporary, destination, expectedSha256);
      return;
    }
    throw error;
  }

  invalidateHash(destination);
  invalidateHash(quarantine);
  if (await validPdfFile(quarantine, expectedSha256)) {
    await publishImmutablePdf(quarantine, destination, expectedSha256);
    await rm(quarantine, { force: true });
    return;
  }

  try {
    await publishImmutablePdf(temporary, destination, expectedSha256);
    await rm(quarantine, { force: true });
  } catch (error) {
    try {
      await link(quarantine, destination);
      await rm(quarantine, { force: true });
    } catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code === "EEXIST") {
        await rm(quarantine, { force: true });
      }
    }
    throw error;
  }
}

async function writePointer(
  lease: RequestLease,
  pointerPath: string,
  request: SafeRequest,
  status: RequestPointer["status"],
  sourceSha256?: string,
  refresh: PointerWriteFields = {},
) {
  await lease.guard(() =>
    atomicWrite(
      pointerPath,
      `${JSON.stringify(
        {
          schema_version: POINTER_SCHEMA,
          ...request,
          status,
          ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
          ...refresh,
          updated_at: new Date().toISOString(),
        } satisfies RequestPointer,
        null,
        2,
      )}\n`,
    ),
  );
}

async function readPointer(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(pointerPath(provider, requestKey), "utf8"),
    ) as Omit<Partial<RequestPointer>, "status"> & { status?: string };
    const pointer = stored as Partial<RequestPointer>;
    const params =
      pointer.schema_version === POINTER_SCHEMA
        ? attachmentFromStored(pointer)
        : null;
    if (!params) return null;
    const request = safeRequest(params);
    if (
      request.requestKey !== requestKey ||
      request.request_reference !== pointer.request_reference ||
      !["queued", "downloaded", "failed"].includes(String(pointer.status))
    ) {
      return null;
    }
    return { pointer: pointer as RequestPointer, params, request };
  } catch {
    return null;
  }
}

function pointerSha(pointer: RequestPointer | null | undefined) {
  const sha = pointer?.source_sha256;
  return typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha) ? sha : null;
}

async function cachedPdf(
  params: ProviderPdfAttachment,
  request: ReturnType<typeof safeRequest>,
  loaded?: Awaited<ReturnType<typeof readPointer>>,
) {
  const current =
    loaded === undefined
      ? await readPointer(params.provider, request.requestKey)
      : loaded;
  if (current?.pointer.status !== "downloaded") return null;
  const sha256 = pointerSha(current.pointer);
  if (!sha256) return null;
  const blob = blobPath(params.provider, sha256);
  if (
    !(await ensureSourceBinding(request, sha256, blob))
  ) {
    return null;
  }
  return { path: blob, sha256, cacheHit: true, pointer: current.pointer };
}

function loadPdf(
  params: ProviderPdfAttachment,
  request: ReturnType<typeof safeRequest>,
) {
  return share(downloads, request.requestKey, async () => {
    const optimistic = await cachedPdf(params, request);
    if (optimistic?.pointer && !refreshDue(request, optimistic.pointer)) {
      return optimistic;
    }
    const requestLease = await acquireRequestLease(
      params.provider,
      request.requestKey,
    );
    try {
      const pointerFile = pointerPath(params.provider, request.requestKey);
      const blobsDir = cacheFile(params.provider, "blobs");
      const loaded = await readPointer(params.provider, request.requestKey);
      const cached = await cachedPdf(params, request, loaded);
      if (cached?.pointer && !refreshDue(request, cached.pointer)) return cached;
      if (
        !cached &&
        loaded?.pointer.status === "failed" &&
        !retryDue(loaded.pointer)
      ) {
        throw new Error("Provider PDF retry is temporarily backed off");
      }
      const previous = loaded?.pointer ?? null;
      if (!cached) {
        await writePointer(
          requestLease,
          pointerFile,
          request,
          "queued",
          undefined,
          prune({ failure_count: previous?.failure_count }),
        );
      }
      const releaseDownloadSlot = await acquireDownloadSlot();
      try {
        const { response, responseUrl } = await responseFor(
          params,
          new URL(request.url),
          cached?.pointer,
        );
        if (response.status === 304) {
          if (!cached?.pointer) {
            throw new Error(
              "Provider returned 304 without a verified local PDF",
            );
          }
          await writePointer(
            requestLease,
            pointerFile,
            request,
            "downloaded",
            cached.sha256,
            responseRefreshFields(response, responseUrl, cached.pointer, false),
          );
          return cached;
        }
        const staged = await streamPdfToTemporary(response, blobsDir);
        try {
          const blob = blobPath(params.provider, staged.sha256);
          if (!(await validPdfFile(blob, staged.sha256))) {
            await publishOrRepairImmutablePdf(staged.path, blob, staged.sha256);
          }
          const freshness = responseRefreshFields(
            response,
            responseUrl,
            cached?.pointer ?? null,
            true,
          );
          await writeSourceBinding(
            request,
            staged.sha256,
            freshness,
            requestLease,
          );
          await writePointer(
            requestLease,
            pointerFile,
            request,
            "downloaded",
            staged.sha256,
            freshness,
          );
          return {
            path: blob,
            sha256: staged.sha256,
            cacheHit: false,
            pointer: null,
          };
        } finally {
          invalidateHash(staged.path);
          await rm(staged.path, { force: true });
        }
      } catch (error) {
        if (cached?.pointer) {
          const checkedAt = new Date().toISOString();
          try {
            await writePointer(
              requestLease,
              pointerFile,
              request,
              "downloaded",
              cached.sha256,
              {
                ...refreshFields(cached.pointer),
                checked_at: checkedAt,
                refresh_failed_at: checkedAt,
              },
            );
          } catch {
            // A complete verified pointer still exists; refresh can retry later.
          }
          if (error instanceof InvalidProviderPdfRevalidationError) throw error;
          return cached;
        }
        await writePointer(
          requestLease,
          pointerFile,
          request,
          "failed",
          undefined,
          failureFields(previous),
        );
        throw error;
      } finally {
        releaseDownloadSlot();
      }
    } finally {
      requestLease.release();
    }
  });
}

function parseSourcePath(sourceSha256: string) {
  const home = path.join(mikeLocalDataHome(), "provider-pdf", "by-sha256");
  return path.join(home, `${sourceSha256}.pdf`);
}

async function installHardlink(cached: CachedPdf) {
  const sourcePath = parseSourcePath(cached.sha256);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  if (await validPdfFile(sourcePath, cached.sha256)) return sourcePath;
  const temporary = `${sourcePath}.${crypto.randomUUID()}.tmp`;
  try {
    try {
      await link(cached.path, temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(cached.path, temporary);
    }
    await publishOrRepairImmutablePdf(temporary, sourcePath, cached.sha256);
  } finally {
    invalidateHash(temporary);
    await rm(temporary, { force: true });
  }
  return sourcePath;
}

async function ensureParser(cached: CachedPdf) {
  const sourcePath = await share(hardlinkJobs, cached.sha256, () =>
    installHardlink(cached),
  );
  const parse = await queueLocalPdfParse({
    documentId: `provider-pdf-${cached.sha256.slice(0, 32)}`,
    versionId: cached.sha256.slice(0, 32),
    sourcePath,
    sourceSha256: cached.sha256,
  });
  return { sourcePath, parse };
}

export async function ingestProviderPdfAttachment(
  params: ProviderPdfAttachment,
): Promise<ProviderPdfLibraryResult | null> {
  if (params.structureSource !== "flat_text") return null;
  const request = safeRequest(params);
  const cached = await loadPdf(params, request);
  const { parse } = await ensureParser(cached);
  const reference = sourceReference(request.request_reference, cached.sha256);
  return {
    provider: params.provider,
    identity: request.identity,
    request_reference: request.request_reference,
    reference_id: reference,
    source_reference: reference,
    source_sha256: cached.sha256,
    cache_hit: cached.cacheHit,
    parse_status: parse.status,
  };
}

async function publishQueuedPointer(
  params: ProviderPdfAttachment,
  request: ReturnType<typeof safeRequest>,
) {
  async function currentResult(
    loaded: Awaited<ReturnType<typeof readPointer>>,
    lease?: RequestLease,
  ) {
    const pointer = loaded?.pointer ?? null;
    const cached = await cachedPdf(params, request, loaded);
    if (cached) return { sourceSha256: cached.sha256, pointer, start: false };
    if (pointer?.status === "failed" && !retryDue(pointer)) {
      return { sourceSha256: null, pointer, start: false };
    }
    if (pointer?.status === "queued") {
      return { sourceSha256: null, pointer, start: true };
    }
    return null;
  }

  const optimistic = await readPointer(params.provider, request.requestKey);
  const ready = await currentResult(optimistic);
  if (ready) return ready;
  const requestLease = await acquireRequestLease(
    params.provider,
    request.requestKey,
  );
  try {
    const loaded = await readPointer(params.provider, request.requestKey);
    const current = await currentResult(loaded, requestLease);
    if (current) return current;
    await writePointer(
      requestLease,
      pointerPath(params.provider, request.requestKey),
      request,
      "queued",
      undefined,
      prune({ failure_count: loaded?.pointer.failure_count }),
    );
    return { sourceSha256: null, pointer: null, start: true };
  } finally {
    requestLease.release();
  }
}

export async function queueProviderPdfAttachment(
  params: ProviderPdfAttachment,
): Promise<ProviderPdfQueueResult | null> {
  if (params.structureSource !== "flat_text") return null;
  const request = safeRequest(params);
  knownRequests.set(request.requestKey, {
    ...params,
    identity: request.identity,
    requestReference: request.request_reference,
  });
  let durable: Awaited<ReturnType<typeof publishQueuedPointer>>;
  try {
    durable = await publishQueuedPointer(params, request);
  } catch (error) {
    knownRequests.delete(request.requestKey);
    throw error;
  }
  if (
    (durable.start || durable.sourceSha256) &&
    !backgroundJobs.has(request.requestKey)
  ) {
    const job = ingestProviderPdfAttachment(params).then((result) => {
      if (!result) throw new Error("Provider PDF fallback was not eligible");
      return result;
    });
    backgroundJobs.set(request.requestKey, job);
    void job.catch(() => undefined).finally(() => {
      backgroundJobs.delete(request.requestKey);
      knownRequests.delete(request.requestKey);
    });
  } else if (!durable.start && !durable.sourceSha256) {
    knownRequests.delete(request.requestKey);
  }
  return stateResult(
    request,
    durable.sourceSha256 ? "downloaded" : "queued",
    durable.sourceSha256,
    null,
    durable.pointer,
  ) as ProviderPdfQueueResult;
}

function freshnessStatus(
  request: SafeRequest,
  pointer: RequestPointer | null,
): ProviderPdfFreshnessStatus {
  if (request.version) return "versioned";
  if (!pointer || pointer.refresh_failed_at || refreshDue(request, pointer)) {
    return "stale";
  }
  return "current";
}

function stateResult(
  request: SafeRequest,
  downloadStatus: ProviderPdfAttachmentState["download_status"],
  sourceSha256: string | null,
  parseStatus: LocalPdfParseStatus | null,
  pointer: RequestPointer | null = null,
): ProviderPdfAttachmentState {
  const sourceRef = sourceSha256
    ? sourceReference(request.request_reference, sourceSha256)
    : null;
  return {
    provider: request.provider,
    identity: request.identity,
    request_reference: request.request_reference,
    reference_id: sourceRef ?? request.request_reference,
    source_reference: sourceRef,
    download_status: downloadStatus,
    source_sha256: sourceSha256,
    parse_status: parseStatus,
    freshness_status: freshnessStatus(request, pointer),
    fetched_at: pointer?.fetched_at ?? null,
    checked_at: pointer?.checked_at ?? null,
  };
}

async function parsedState(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
  blob: string,
  pointer: RequestPointer | null,
  resume: boolean,
) {
  try {
    const { parse } = resume
      ? await ensureParser({
          path: blob,
          sha256: sourceSha256,
          cacheHit: true,
          pointer: null,
        })
      : {
          parse: await readLocalPdfParseState(parseSourcePath(sourceSha256), {
            validatePublication: false,
          }),
        };
    const parseStatus = parse?.status ?? null;
    return stateResult(request, "downloaded", sourceSha256, parseStatus, pointer);
  } catch {
    return stateResult(request, "downloaded", sourceSha256, "failed", pointer);
  }
}

async function stateForRequest(
  params: ProviderPdfAttachment,
  expectedSourceSha256: string | null,
  resume: boolean,
) {
  const request = safeRequest(params);
  const loaded = await readPointer(params.provider, request.requestKey);
  if (expectedSourceSha256) {
    const historicalBlob = blobPath(params.provider, expectedSourceSha256);
    const bound = await ensureSourceBinding(
      request,
      expectedSourceSha256,
      historicalBlob,
    );
    if (!bound) return stateResult(request, "failed", null, null);
    const receipt = await readSourceBinding(request, expectedSourceSha256);
    const pointer =
      bindingPointer(request, expectedSourceSha256, receipt) ??
      (loaded?.pointer.source_sha256 === expectedSourceSha256
        ? loaded.pointer
        : null);
    return parsedState(request, expectedSourceSha256, historicalBlob, pointer, resume);
  }
  if (!loaded || loaded.pointer.status !== "downloaded") {
    const backedOff =
      loaded?.pointer.status === "failed" && !retryDue(loaded.pointer);
    if (resume && !backedOff) await queueProviderPdfAttachment(params);
    const status =
      resume && !backedOff
        ? "queued"
        : (loaded?.pointer.status ?? "not_queued");
    return stateResult(request, status, null, null, loaded?.pointer ?? null);
  }
  const sourceSha256 = pointerSha(loaded.pointer);
  if (!sourceSha256) {
    return stateResult(request, "failed", null, null, loaded.pointer);
  }
  const blob = blobPath(params.provider, sourceSha256);
  if (
    !(await ensureSourceBinding(request, sourceSha256, blob))
  ) {
    if (resume) await queueProviderPdfAttachment(params);
    const status = resume ? ("queued" as const) : ("failed" as const);
    return stateResult(request, status, null, null, loaded.pointer);
  }
  if (resume && refreshDue(request, loaded.pointer)) {
    void queueProviderPdfAttachment(params).catch(() => undefined);
  }
  return parsedState(request, sourceSha256, blob, loaded.pointer, resume);
}

export async function readProviderPdfAttachmentState(
  params: ProviderPdfAttachment,
  options?: { resume?: boolean },
): Promise<ProviderPdfAttachmentState | null> {
  if (params.structureSource !== "flat_text") return null;
  return stateForRequest(params, null, options?.resume !== false);
}

async function requestForReference(reference: string) {
  const parsed = parsedReference(reference);
  if (parsed.sourceSha256) {
    const binding = await sourceBindingForReference(
      parsed.provider,
      parsed.requestKey,
      parsed.sourceSha256,
    );
    if (binding) {
      const pointer = bindingPointer(
        requestSnapshot(binding.request),
        parsed.sourceSha256,
        binding.receipt,
      );
      return { pointer, params: binding.params, request: binding.request, parsed };
    }
  }
  const loaded = await readPointer(parsed.provider, parsed.requestKey);
  if (loaded) return { ...loaded, parsed };
  const known = knownRequests.get(parsed.requestKey);
  if (!known) return null;
  return { pointer: null, params: known, request: safeRequest(known), parsed };
}

export async function readProviderPdfReferenceState(reference: string) {
  const resolved = await requestForReference(reference);
  if (!resolved) throw new Error("Provider PDF reference is unavailable");
  return stateForRequest(resolved.params, resolved.parsed.sourceSha256, true);
}

async function readyEvidence<Lookup extends { status: string }>(
  reference: string,
  lookupFor: (sourcePath: string) => Promise<Lookup>,
  handleFor: (lookup: Lookup) => string | null,
) {
  const resolved = await requestForReference(reference);
  if (!resolved) {
    return {
      availability: "error" as const,
      error: "Provider PDF reference is unavailable",
    };
  }
  const state = await stateForRequest(
    resolved.params,
    resolved.parsed.sourceSha256,
    true,
  );
  if (
    state.download_status !== "downloaded" ||
    !state.source_sha256 ||
    !["ready", "degraded"].includes(String(state.parse_status))
  ) {
    const failed =
      state.download_status === "failed" || state.parse_status === "failed";
    return {
      availability: failed ? ("error" as const) : ("queued" as const),
      state,
      error: failed ? "Provider PDF download or parse failed" : undefined,
    };
  }
  const sourcePath = parseSourcePath(state.source_sha256);
  const lookup = await lookupFor(sourcePath);
  const handle = handleFor(lookup);
  return {
    availability: "ready" as const,
    state,
    params: resolved.params,
    lookup,
    linkEvidence: handle
      ? await createLocalPdfLinkEvidenceSession(sourcePath).rehydrate(handle)
      : null,
  };
}

export async function lookupProviderPdfReference(
  reference: string,
  input: LocalPdfLookupInput,
) {
  return readyEvidence(
    reference,
    (sourcePath) => lookupLocalPdfStructure(sourcePath, input),
    (lookup) => (lookup.status === "found" ? lookup.evidence.handle : null),
  );
}

export async function rehydrateProviderPdfReference(
  reference: string,
  handle: string,
) {
  return readyEvidence(
    reference,
    (sourcePath) => rehydrateLocalPdfEvidence(sourcePath, handle),
    (lookup) => (lookup.status === "found" ? handle : null),
  );
}
