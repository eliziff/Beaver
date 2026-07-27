import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { isIP } from "node:net";
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
import { guardedRemoteFetch } from "./remoteUrlSafety";
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

export type ProviderPdfQueueResult = {
  provider: ProviderPdfFallbackProvider;
  identity: string;
  request_reference: string;
  reference_id: string;
  source_reference: string | null;
  source_sha256: string | null;
  download_status: "queued" | "downloaded";
  parse_status: LocalPdfParseStatus | null;
  freshness_status: ProviderPdfFreshnessStatus;
  fetched_at: string | null;
  checked_at: string | null;
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
  request?: SafeRequest;
  freshness?: PointerRefresh;
};

type HashMemo = {
  signature: string;
  sha256: string;
  hasPdfHeader: boolean;
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
const hashMemo = new Map<string, HashMemo>();
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
  | "etag"
  | "last_modified"
  | "validator_url"
  | "fetched_at"
  | "checked_at"
  | "refresh_failed_at"
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
  if (activeDownloads < MAX_CONCURRENT_PDF_DOWNLOADS) {
    activeDownloads += 1;
  } else {
    await new Promise<void>((resolve) => downloadWaiters.push(resolve));
  }
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

function revalidateIntervalMs() {
  const configured = Number(
    process.env.MIKE_PROVIDER_PDF_REVALIDATE_INTERVAL_MS,
  );
  return Number.isFinite(configured)
    ? Math.min(
        Math.max(Math.trunc(configured), MIN_REVALIDATE_MS),
        MAX_REVALIDATE_MS,
      )
    : DEFAULT_REVALIDATE_MS;
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

function failureRetryMs() {
  const configured = Number(process.env.MIKE_PROVIDER_PDF_FAILURE_RETRY_MS);
  return Number.isFinite(configured)
    ? Math.min(
        Math.max(Math.trunc(configured), MIN_FAILURE_RETRY_MS),
        MAX_FAILURE_RETRY_MS,
      )
    : DEFAULT_FAILURE_RETRY_MS;
}

function failureFields(pointer: RequestPointer | null) {
  const previous = Number(pointer?.failure_count);
  const count = Math.min(
    Math.max(Number.isFinite(previous) ? Math.trunc(previous) : 0, 0) + 1,
    16,
  );
  const delay = Math.min(
    failureRetryMs() * 2 ** (count - 1),
    MAX_FAILURE_RETRY_MS,
  );
  return {
    failure_count: count,
    retry_after: new Date(Date.now() + delay).toISOString(),
  };
}

function refreshFields(pointer: RequestPointer): PointerRefresh {
  return {
    ...(pointer.etag ? { etag: pointer.etag } : {}),
    ...(pointer.last_modified ? { last_modified: pointer.last_modified } : {}),
    ...(pointer.validator_url ? { validator_url: pointer.validator_url } : {}),
    ...(pointer.fetched_at ? { fetched_at: pointer.fetched_at } : {}),
    ...(pointer.checked_at ? { checked_at: pointer.checked_at } : {}),
    ...(pointer.refresh_failed_at
      ? { refresh_failed_at: pointer.refresh_failed_at }
      : {}),
  };
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
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { last_modified: lastModified } : {}),
    ...(validatorUrl ? { validator_url: validatorUrl } : {}),
    ...(downloaded
      ? { fetched_at: now }
      : previous?.fetched_at
        ? { fetched_at: previous.fetched_at }
        : {}),
    checked_at: now,
  };
}

function publicHttpsUrl(raw: string) {
  if (raw.length > 8192) {
    throw new Error("Provider PDF URL is too long");
  }
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const ipHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(ipHostname)
  ) {
    throw new Error("Provider PDF URL is not a trusted default-port HTTPS URL");
  }
  url.hash = "";
  return url;
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
  const canonicalUrl = canonical?.toString() ?? null;
  const identity = safeText(params.identity, 500);
  if (!identity) throw new Error("Provider PDF identity is invalid");
  const payload = {
    provider: params.provider,
    identity,
    url: url.toString(),
    canonical_url: canonicalUrl,
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
  return {
    ...payload,
    request_reference: requestReference,
    requestKey,
  };
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

function requestUrl(provider: ProviderPdfFallbackProvider, url: URL) {
  const requested = new URL(url);
  if (
    provider === "govinfo" &&
    requested.hostname.toLowerCase() === "api.govinfo.gov" &&
    !requested.searchParams.has("api_key")
  ) {
    requested.searchParams.set(
      "api_key",
      process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY",
    );
  }
  return requested;
}

async function responseFor(
  params: ProviderPdfAttachment,
  initial: URL,
  cached: RequestPointer | null = null,
) {
  let current = initial;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    current = sourceUrl({ ...params, url: current.toString() });
    const requested = requestUrl(params.provider, current);
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
      {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(30_000),
      },
      "Provider PDF URL",
    );
    if (
      response.status === 304 &&
      !headers["If-None-Match"] &&
      !headers["If-Modified-Since"]
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // The invalid response is never evidence; closing it is best effort.
      }
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
    try {
      await response.body?.cancel();
    } catch {
      // Redirect bodies are never evidence; closing them is best effort.
    }
    if (!location || redirects === 5) {
      throw new Error("Provider PDF redirect could not be resolved");
    }
    current = sourceUrl({
      ...params,
      url: new URL(location, requested).toString(),
    });
  }
  throw new Error("Provider PDF redirect limit exceeded");
}

async function streamPdfToTemporary(response: Response, directory: string) {
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the useful HTTP error below.
    }
    throw new Error(`Provider PDF request failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error(`Provider PDF request failed (${response.status})`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
    try {
      await response.body.cancel();
    } catch {
      // Preserve the deterministic size error below.
    }
    throw new Error("Provider PDF exceeds the local import size limit");
  }
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.download-${crypto.randomUUID()}.tmp`,
  );
  let output: Awaited<ReturnType<typeof open>>;
  try {
    output = await open(temporary, "wx");
  } catch (error) {
    try {
      await response.body.cancel();
    } catch {
      // Preserve the filesystem error.
    }
    throw error;
  }
  const reader = response.body.getReader();
  const digest = crypto.createHash("sha256");
  const header = Buffer.alloc(1024);
  let headerSize = 0;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF_BYTES) {
        throw new Error("Provider PDF exceeds the local import size limit");
      }
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
    return {
      path: temporary,
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the validation or write error.
    }
    try {
      await output.close();
    } catch {
      // Preserve the validation or write error.
    }
    invalidateHash(temporary);
    await rm(temporary, { force: true });
    throw error;
  }
}

function cachePaths(provider: ProviderPdfFallbackProvider, requestKey: string) {
  const root = path.join(legalProviderCache(provider), "pdf");
  return {
    blobs: path.join(root, "blobs"),
    bindings: path.join(root, "bindings", requestKey),
    pointer: path.join(root, "requests", `${requestKey}.json`),
  };
}

function leaseDatabasePath(provider: ProviderPdfFallbackProvider) {
  return path.join(
    legalProviderCache(provider),
    "pdf",
    "request-leases.sqlite",
  );
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

function withLeaseDatabase<T>(
  provider: ProviderPdfFallbackProvider,
  operation: (database: DatabaseSync) => T,
) {
  const database = openLeaseDatabase(provider);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function leaseTransaction<T>(database: DatabaseSync, operation: () => T) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function tryAcquireRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
) {
  const now = Date.now();
  return withLeaseDatabase(provider, (database) =>
    leaseTransaction(database, () => {
      const current = database
        .prepare(
          "SELECT owner, expires_at FROM request_leases WHERE request_key = ?",
        )
        .get(requestKey) as { owner: string; expires_at: number } | undefined;
      if (!current) {
        database
          .prepare(
            "INSERT INTO request_leases (request_key, owner, expires_at) VALUES (?, ?, ?)",
          )
          .run(requestKey, owner, now + REQUEST_LEASE_MS);
        return true;
      }
      if (Number(current.expires_at) > now) return false;
      const updated = database
        .prepare(
          "UPDATE request_leases SET owner = ?, expires_at = ? WHERE request_key = ? AND owner = ? AND expires_at = ?",
        )
        .run(
          owner,
          now + REQUEST_LEASE_MS,
          requestKey,
          current.owner,
          current.expires_at,
        );
      return Number(updated.changes) === 1;
    }),
  );
}

function renewRequestLease(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  owner: string,
) {
  const now = Date.now();
  return withLeaseDatabase(provider, (database) =>
    leaseTransaction(database, () => {
      const updated = database
        .prepare(
          "UPDATE request_leases SET expires_at = ? WHERE request_key = ? AND owner = ? AND expires_at > ?",
        )
        .run(now + REQUEST_LEASE_MS, requestKey, owner, now);
      return Number(updated.changes) === 1;
    }),
  );
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
        .prepare(
          "UPDATE request_leases SET expires_at = ? WHERE request_key = ? AND owner = ? AND expires_at > ?",
        )
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
      const heldTransaction = inTransaction;
      if (inTransaction) {
        try {
          database!.exec("ROLLBACK");
        } catch {
          // The original ownership or filesystem failure is more useful.
        }
      }
      if (heldTransaction || !sqliteBusy(error) || Date.now() >= deadline) {
        throw error;
      }
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
  return withLeaseDatabase(provider, (database) =>
    leaseTransaction(database, () => {
      database
        .prepare(
          "DELETE FROM request_leases WHERE request_key = ? AND owner = ?",
        )
        .run(requestKey, owner);
    }),
  );
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

function sourceBindingPath(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
) {
  return path.join(
    cachePaths(request.provider, request.requestKey).bindings,
    `${sourceSha256}.json`,
  );
}

function requestSnapshot(request: ReturnType<typeof safeRequest>): SafeRequest {
  const { requestKey: _requestKey, ...snapshot } = request;
  return snapshot;
}

function requestFromSnapshot(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<SafeRequest>;
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
  try {
    const params = {
      provider: stored.provider as ProviderPdfFallbackProvider,
      identity: stored.identity,
      structureSource: "flat_text" as const,
      url: stored.url,
      canonicalUrl:
        typeof stored.canonical_url === "string"
          ? stored.canonical_url
          : undefined,
      filename:
        typeof stored.filename === "string" ? stored.filename : undefined,
      title: typeof stored.title === "string" ? stored.title : undefined,
      version: typeof stored.version === "string" ? stored.version : undefined,
      requestReference: stored.request_reference,
    } satisfies ProviderPdfAttachment;
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
  const etag = safeText(stored.etag, 500);
  const lastModified = safeText(stored.last_modified, 200);
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
  return {
    ...(etag ? { etag } : {}),
    ...(lastModified ? { last_modified: lastModified } : {}),
    ...(validatorUrl ? { validator_url: validatorUrl } : {}),
    ...(validTimestamp(stored.fetched_at) !== null
      ? { fetched_at: stored.fetched_at }
      : {}),
    ...(validTimestamp(stored.checked_at) !== null
      ? { checked_at: stored.checked_at }
      : {}),
    ...(validTimestamp(stored.refresh_failed_at) !== null
      ? { refresh_failed_at: stored.refresh_failed_at }
      : {}),
  };
}

async function readSourceBinding(
  request: ReturnType<typeof safeRequest>,
  sourceSha256: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(sourceBindingPath(request, sourceSha256), "utf8"),
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
    const recovered = stored.request
      ? requestFromSnapshot(stored.request)
      : null;
    if (
      stored.request &&
      (!recovered ||
        recovered.request.requestKey !== request.requestKey ||
        recovered.request.request_reference !== request.request_reference)
    ) {
      return null;
    }
    return {
      schema_version: SOURCE_BINDING_SCHEMA,
      provider: request.provider,
      request_reference: request.request_reference,
      source_sha256: sourceSha256,
      bound_at: stored.bound_at,
      ...(recovered ? { request: requestSnapshot(recovered.request) } : {}),
      ...(recovered
        ? { freshness: normalizedFreshness(stored.freshness, recovered.params) }
        : {}),
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
      if (existing?.request) return existing;
      const receipt = {
        schema_version: SOURCE_BINDING_SCHEMA,
        provider: request.provider,
        request_reference: request.request_reference,
        source_sha256: sourceSha256,
        bound_at: existing?.bound_at ?? new Date().toISOString(),
        request: requestSnapshot(request),
        freshness: normalizedFreshness(freshness, {
          provider: request.provider,
          identity: request.identity,
          structureSource: "flat_text",
          url: request.url,
          canonicalUrl: request.canonical_url,
          filename: request.filename,
          title: request.title,
          version: request.version,
          requestReference: request.request_reference,
        }),
      } satisfies SourceBindingReceipt;
      try {
        await atomicWrite(
          sourceBindingPath(request, sourceSha256),
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
      } catch (error) {
        const winner = await readSourceBinding(request, sourceSha256);
        if (winner?.request) return winner;
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
  pointer: RequestPointer | null,
  sourceSha256: string,
  blob: string,
  lease?: RequestLease,
) {
  if (!(await validPdfFile(blob, sourceSha256))) return false;
  const receipt = await readSourceBinding(request, sourceSha256);
  if (receipt?.request) return true;
  if (receipt) {
    await writeSourceBinding(
      request,
      sourceSha256,
      pointer?.source_sha256 === sourceSha256 ? refreshFields(pointer) : {},
      lease,
    );
    return true;
  }
  if (
    pointer?.status !== "downloaded" ||
    pointer.request_reference !== request.request_reference ||
    pointer.source_sha256 !== sourceSha256
  ) {
    return false;
  }
  await writeSourceBinding(
    request,
    sourceSha256,
    refreshFields(pointer),
    lease,
  );
  return true;
}

async function sourceBindingForReference(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
  sourceSha256: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(
        path.join(
          cachePaths(provider, requestKey).bindings,
          `${sourceSha256}.json`,
        ),
        "utf8",
      ),
    ) as Partial<SourceBindingReceipt>;
    const recovered = requestFromSnapshot(stored.request);
    if (
      stored.schema_version !== SOURCE_BINDING_SCHEMA ||
      stored.provider !== provider ||
      stored.request_reference !==
        `${REFERENCE_PREFIX}:${provider}:${requestKey}` ||
      stored.source_sha256 !== sourceSha256 ||
      !recovered ||
      recovered.request.requestKey !== requestKey
    ) {
      return null;
    }
    const receipt = await readSourceBinding(recovered.request, sourceSha256);
    return receipt?.request ? { ...recovered, receipt } : null;
  } catch {
    return null;
  }
}

function bindingPointer(
  request: SafeRequest,
  sourceSha256: string,
  receipt: SourceBindingReceipt | null,
) {
  if (!receipt?.request) return null;
  return {
    schema_version: POINTER_SCHEMA,
    ...request,
    status: "downloaded",
    source_sha256: sourceSha256,
    ...receipt.freshness,
    updated_at: receipt.bound_at,
  } satisfies RequestPointer;
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
    const details = await stat(resolved);
    const signature = [
      details.dev,
      details.ino,
      details.size,
      details.mtimeMs,
      details.ctimeMs,
    ].join(":");
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
    hashMemo.set(resolved, {
      signature,
      sha256: actualSha256,
      hasPdfHeader,
    });
    return hasPdfHeader && actualSha256 === expectedSha256;
  } catch {
    hashMemo.delete(resolved);
    return false;
  }
}

async function publishImmutablePdf(
  temporary: string,
  destination: string,
  expectedSha256: string,
) {
  try {
    await link(temporary, destination);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (!["EACCES", "EEXIST", "EPERM"].includes(code)) throw error;
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
    if (
      !["EACCES", "EEXIST", "EPERM"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      throw error;
    }
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

function pointerRequest(pointer: Partial<RequestPointer>) {
  if (
    pointer.schema_version !== POINTER_SCHEMA ||
    !REFERENCE_RE.test(String(pointer.request_reference)) ||
    !["a2aj", "courtlistener", "govinfo", "govuk-et", "tna"].includes(
      String(pointer.provider),
    ) ||
    typeof pointer.identity !== "string" ||
    typeof pointer.url !== "string"
  ) {
    return null;
  }
  return {
    provider: pointer.provider as ProviderPdfFallbackProvider,
    identity: pointer.identity,
    structureSource: "flat_text" as const,
    url: pointer.url,
    canonicalUrl:
      typeof pointer.canonical_url === "string"
        ? pointer.canonical_url
        : undefined,
    filename:
      typeof pointer.filename === "string" ? pointer.filename : undefined,
    title: typeof pointer.title === "string" ? pointer.title : undefined,
    version: typeof pointer.version === "string" ? pointer.version : undefined,
    requestReference: pointer.request_reference,
  } satisfies ProviderPdfAttachment;
}

async function readPointer(
  provider: ProviderPdfFallbackProvider,
  requestKey: string,
) {
  try {
    const stored = JSON.parse(
      await readFile(cachePaths(provider, requestKey).pointer, "utf8"),
    ) as Omit<Partial<RequestPointer>, "status"> & { status?: string };
    const pointer = {
      ...stored,
      status: stored.status === "ready" ? "downloaded" : stored.status,
    } as Partial<RequestPointer>;
    const params = pointerRequest(pointer);
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

async function cachedPdf(
  params: ProviderPdfAttachment,
  request: ReturnType<typeof safeRequest>,
  loaded?: Awaited<ReturnType<typeof readPointer>>,
  lease?: RequestLease,
) {
  const paths = cachePaths(params.provider, request.requestKey);
  const current =
    loaded === undefined
      ? await readPointer(params.provider, request.requestKey)
      : loaded;
  if (
    !current ||
    current.pointer.status !== "downloaded" ||
    typeof current.pointer.source_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(current.pointer.source_sha256)
  ) {
    return null;
  }
  const blob = path.join(paths.blobs, `${current.pointer.source_sha256}.pdf`);
  if (
    !(await ensureSourceBinding(
      request,
      current.pointer,
      current.pointer.source_sha256,
      blob,
      lease,
    ))
  ) {
    return null;
  }
  return {
    path: blob,
    sha256: current.pointer.source_sha256,
    cacheHit: true,
    pointer: current.pointer,
  };
}

async function loadPdf(
  params: ProviderPdfAttachment,
  request: ReturnType<typeof safeRequest>,
) {
  const existing = downloads.get(request.requestKey);
  if (existing) return existing;
  const pending = (async () => {
    const optimistic = await cachedPdf(params, request);
    if (optimistic?.pointer && !refreshDue(request, optimistic.pointer)) {
      return optimistic;
    }
    const requestLease = await acquireRequestLease(
      params.provider,
      request.requestKey,
    );
    try {
      const paths = cachePaths(params.provider, request.requestKey);
      const loaded = await readPointer(params.provider, request.requestKey);
      const cached = await cachedPdf(params, request, loaded, requestLease);
      if (cached?.pointer && !refreshDue(request, cached.pointer))
        return cached;
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
          paths.pointer,
          request,
          "queued",
          undefined,
          {
            ...(previous?.failure_count
              ? { failure_count: previous.failure_count }
              : {}),
          },
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
            paths.pointer,
            request,
            "downloaded",
            cached.sha256,
            responseRefreshFields(response, responseUrl, cached.pointer, false),
          );
          return cached;
        }
        const staged = await streamPdfToTemporary(response, paths.blobs);
        try {
          const blob = path.join(paths.blobs, `${staged.sha256}.pdf`);
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
            paths.pointer,
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
              paths.pointer,
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
          paths.pointer,
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
  })();
  downloads.set(request.requestKey, pending);
  try {
    return await pending;
  } finally {
    downloads.delete(request.requestKey);
  }
}

function parseSourcePath(sourceSha256: string) {
  return path.join(
    mikeLocalDataHome(),
    "provider-pdf",
    "by-sha256",
    `${sourceSha256}.pdf`,
  );
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

async function ensureHardlink(cached: CachedPdf) {
  const existing = hardlinkJobs.get(cached.sha256);
  if (existing) return existing;
  const pending = installHardlink(cached);
  hardlinkJobs.set(cached.sha256, pending);
  try {
    return await pending;
  } finally {
    if (hardlinkJobs.get(cached.sha256) === pending) {
      hardlinkJobs.delete(cached.sha256);
    }
  }
}

async function ensureParser(cached: CachedPdf) {
  const sourcePath = await ensureHardlink(cached);
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
  const url = sourceUrl(params);
  const request = safeRequest(params, url);
  const cached = await loadPdf(params, request);
  const { parse } = await ensureParser(cached);
  return {
    provider: params.provider,
    identity: request.identity,
    request_reference: request.request_reference,
    reference_id: sourceReference(request.request_reference, cached.sha256),
    source_reference: sourceReference(request.request_reference, cached.sha256),
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
    if (loaded?.pointer.status === "downloaded") {
      const sourceSha256 =
        typeof loaded.pointer.source_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(loaded.pointer.source_sha256)
          ? loaded.pointer.source_sha256
          : null;
      const blob = sourceSha256
        ? path.join(
            cachePaths(params.provider, request.requestKey).blobs,
            `${sourceSha256}.pdf`,
          )
        : null;
      if (
        sourceSha256 &&
        blob &&
        (await ensureSourceBinding(
          request,
          loaded.pointer,
          sourceSha256,
          blob,
          lease,
        ))
      ) {
        return {
          sourceSha256,
          pointer: loaded.pointer,
          start: false,
        };
      }
    }
    if (loaded?.pointer.status === "failed" && !retryDue(loaded.pointer)) {
      return {
        sourceSha256: null,
        pointer: loaded.pointer,
        start: false,
      };
    }
    if (loaded?.pointer.status === "queued") {
      return {
        sourceSha256: null,
        pointer: loaded.pointer,
        start: true,
      };
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
      cachePaths(params.provider, request.requestKey).pointer,
      request,
      "queued",
      undefined,
      {
        ...(loaded?.pointer.failure_count
          ? { failure_count: loaded.pointer.failure_count }
          : {}),
      },
    );
    return {
      sourceSha256: null,
      pointer: null,
      start: true,
    };
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
    void job
      .catch(() => undefined)
      .finally(() => {
        backgroundJobs.delete(request.requestKey);
        knownRequests.delete(request.requestKey);
      });
  } else if (!durable.start && !durable.sourceSha256) {
    knownRequests.delete(request.requestKey);
  }
  const sourceSha256 = durable.sourceSha256;
  const downloaded = sourceSha256 !== null;
  return {
    provider: params.provider,
    identity: request.identity,
    request_reference: request.request_reference,
    reference_id: downloaded
      ? sourceReference(request.request_reference, sourceSha256)
      : request.request_reference,
    source_reference: downloaded
      ? sourceReference(request.request_reference, sourceSha256)
      : null,
    source_sha256: sourceSha256,
    download_status: downloaded ? "downloaded" : "queued",
    parse_status: null,
    freshness_status: freshnessStatus(request, durable.pointer),
    fetched_at: durable.pointer?.fetched_at ?? null,
    checked_at: durable.pointer?.checked_at ?? null,
  };
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
  return {
    provider: request.provider,
    identity: request.identity,
    request_reference: request.request_reference,
    reference_id: sourceSha256
      ? sourceReference(request.request_reference, sourceSha256)
      : request.request_reference,
    source_reference: sourceSha256
      ? sourceReference(request.request_reference, sourceSha256)
      : null,
    download_status: downloadStatus,
    source_sha256: sourceSha256,
    parse_status: parseStatus,
    freshness_status: freshnessStatus(request, pointer),
    fetched_at: pointer?.fetched_at ?? null,
    checked_at: pointer?.checked_at ?? null,
  };
}

async function stateForRequest(
  params: ProviderPdfAttachment,
  expectedSourceSha256: string | null,
  resume: boolean,
) {
  const url = sourceUrl(params);
  const request = safeRequest(params, url);
  const loaded = await readPointer(params.provider, request.requestKey);
  if (expectedSourceSha256) {
    const historicalBlob = path.join(
      cachePaths(params.provider, request.requestKey).blobs,
      `${expectedSourceSha256}.pdf`,
    );
    if (
      !(await ensureSourceBinding(
        request,
        loaded?.pointer ?? null,
        expectedSourceSha256,
        historicalBlob,
      ))
    ) {
      return stateResult(request, "failed", null, null);
    }
    const receipt = await readSourceBinding(request, expectedSourceSha256);
    const historicalPointer =
      bindingPointer(request, expectedSourceSha256, receipt) ??
      (loaded?.pointer.source_sha256 === expectedSourceSha256
        ? loaded.pointer
        : null);
    try {
      const { parse } = resume
        ? await ensureParser({
            path: historicalBlob,
            sha256: expectedSourceSha256,
            cacheHit: true,
            pointer: null,
          })
        : {
            parse: await readLocalPdfParseState(
              parseSourcePath(expectedSourceSha256),
              { validatePublication: false },
            ),
          };
      return stateResult(
        request,
        "downloaded",
        expectedSourceSha256,
        parse?.status ?? null,
        historicalPointer,
      );
    } catch {
      return stateResult(
        request,
        "downloaded",
        expectedSourceSha256,
        "failed",
        historicalPointer,
      );
    }
  }
  if (!loaded || loaded.pointer.status !== "downloaded") {
    const backedOff =
      loaded?.pointer.status === "failed" && !retryDue(loaded.pointer);
    if (resume && !backedOff) await queueProviderPdfAttachment(params);
    return stateResult(
      request,
      resume && !backedOff
        ? "queued"
        : (loaded?.pointer.status ?? "not_queued"),
      null,
      null,
      loaded?.pointer ?? null,
    );
  }
  const sourceSha256 =
    typeof loaded.pointer.source_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(loaded.pointer.source_sha256)
      ? loaded.pointer.source_sha256
      : null;
  if (!sourceSha256) {
    return stateResult(request, "failed", null, null, loaded.pointer);
  }
  const blob = path.join(
    cachePaths(params.provider, request.requestKey).blobs,
    `${sourceSha256}.pdf`,
  );
  if (
    !(await ensureSourceBinding(request, loaded.pointer, sourceSha256, blob))
  ) {
    if (resume) await queueProviderPdfAttachment(params);
    return stateResult(
      request,
      resume ? "queued" : "failed",
      null,
      null,
      loaded.pointer,
    );
  }
  if (resume && refreshDue(request, loaded.pointer)) {
    void queueProviderPdfAttachment(params).catch(() => undefined);
  }
  const cached = {
    path: blob,
    sha256: sourceSha256,
    cacheHit: true,
    pointer: loaded.pointer,
  };
  try {
    const { parse } = resume
      ? await ensureParser(cached)
      : {
          parse: await readLocalPdfParseState(parseSourcePath(sourceSha256), {
            validatePublication: false,
          }),
        };
    return stateResult(
      request,
      "downloaded",
      sourceSha256,
      parse?.status ?? null,
      loaded.pointer,
    );
  } catch {
    return stateResult(
      request,
      "downloaded",
      sourceSha256,
      "failed",
      loaded.pointer,
    );
  }
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
      return {
        pointer: bindingPointer(
          requestSnapshot(binding.request),
          parsed.sourceSha256,
          binding.receipt,
        ),
        params: binding.params,
        request: binding.request,
        parsed,
      };
    }
  }
  const loaded = await readPointer(parsed.provider, parsed.requestKey);
  if (loaded) return { ...loaded, parsed };
  const known = knownRequests.get(parsed.requestKey);
  if (!known) return null;
  const request = safeRequest(known);
  return {
    pointer: null,
    params: known,
    request,
    parsed,
  };
}

export async function readProviderPdfReferenceState(reference: string) {
  const resolved = await requestForReference(reference);
  if (!resolved) throw new Error("Provider PDF reference is unavailable");
  return stateForRequest(resolved.params, resolved.parsed.sourceSha256, true);
}

async function readyProviderSource(reference: string) {
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
    return {
      availability:
        state.download_status === "failed" || state.parse_status === "failed"
          ? ("error" as const)
          : ("queued" as const),
      state,
      error:
        state.download_status === "failed" || state.parse_status === "failed"
          ? "Provider PDF download or parse failed"
          : undefined,
    };
  }
  return {
    availability: "ready" as const,
    state,
    params: resolved.params,
    sourcePath: parseSourcePath(state.source_sha256),
  };
}

export async function lookupProviderPdfReference(
  reference: string,
  input: LocalPdfLookupInput,
) {
  const source = await readyProviderSource(reference);
  if (source.availability !== "ready") return source;
  const lookup = await lookupLocalPdfStructure(source.sourcePath, input);
  return {
    availability: "ready" as const,
    state: source.state,
    params: source.params,
    lookup,
    linkEvidence:
      lookup.status === "found"
        ? await createLocalPdfLinkEvidenceSession(source.sourcePath).rehydrate(
            lookup.evidence.handle,
          )
        : null,
  };
}

export async function rehydrateProviderPdfReference(
  reference: string,
  handle: string,
) {
  const source = await readyProviderSource(reference);
  if (source.availability !== "ready") return source;
  const lookup = await rehydrateLocalPdfEvidence(source.sourcePath, handle);
  return {
    availability: "ready" as const,
    state: source.state,
    params: source.params,
    lookup,
    linkEvidence:
      lookup.status === "found"
        ? await createLocalPdfLinkEvidenceSession(source.sourcePath).rehydrate(
            handle,
          )
        : null,
  };
}
