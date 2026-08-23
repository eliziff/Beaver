import path from "node:path";
import { readFile } from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import {
  documentProjectionService,
  type PdfLookupInput,
  type PdfParseStatus,
} from "./documentProjectionService";
import {
  atomicWriteProjection,
  inspectPdf,
  pdfContentPath,
  publishPdfStream,
  withProjectionLock,
} from "./documentProjection";
import { boundRemoteResponse, guardedRemoteFetch, normalizeRemoteHttpsUrl } from "./remoteUrlSafety";
import { sha256 } from "./hash";
import type { RemoteLegalSourceDocument } from "./legalSources/remoteProvider";
import { resourceReference } from "./resourceReferences";
import { documentHasOriginNative } from "./structureNative";
import { enqueueJob, wakeJobWorker, type JobHandler } from "./jobQueue";

export type ProviderPdfAttachment = {
  provider: string;
  identity: string;
  url: string;
  canonicalUrl?: string | null;
  filename?: string | null;
  title?: string | null;
  version?: string | null;
  requestReference?: string | null;
};

export type ProviderPdfAttachmentState = {
  provider: string;
  identity: string;
  request_reference: string;
  reference_id: string;
  source_reference: string | null;
  download_status: "not_queued" | "queued" | "downloaded" | "failed";
  source_sha256: string | null;
  parse_status: PdfParseStatus | null;
};

type SafeRequest = ProviderPdfAttachment & {
  canonicalUrl: string | null;
  filename: string | null;
  title: string | null;
  version: string | null;
  requestReference: string;
  requestKey: string;
};
type PdfRecord = SafeRequest & {
  schema_version: 1;
  status: "queued" | "downloaded" | "failed";
  source_sha256?: string;
  updated_at: string;
};

const PREFIX = "mike-provider-pdf:v1";
const REFERENCE = /^mike-provider-pdf:v1:([a-z0-9-]+):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/u;

const text = (value: string | null | undefined, maximum: number) => {
  const result = value?.trim().replace(/\s+/gu, " ") ?? "";
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(result)
    ? result : null;
};

function publicUrl(raw: string) {
  return normalizeRemoteHttpsUrl(raw, { label: "Source PDF URL", maxUrlLength: 8_192,
    defaultPortOnly: true, allowIpLiterals: false, blockedHostSuffixes: [".local"] }).url;
}

function sourceUrl(raw: string) {
  const url = publicUrl(raw);
  if (url.hostname === "api.govinfo.gov") url.searchParams.delete("api_key");
  return url;
}

function safeRequest(input: ProviderPdfAttachment): SafeRequest {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(input.provider))
    throw new Error("Source provider is invalid");
  const identity = text(input.identity, 500);
  if (!identity) throw new Error("Source PDF identity is invalid");
  const request = {
    provider: input.provider,
    identity,
    url: sourceUrl(input.url).toString(),
    canonicalUrl: input.canonicalUrl ? publicUrl(input.canonicalUrl).toString() : null,
    filename: text(input.filename, 260),
    title: text(input.title, 500),
    version: text(input.version, 200),
  };
  const requestKey = sha256(JSON.stringify(request));
  const requestReference = `${PREFIX}:${request.provider}:${requestKey}`;
  if (input.requestReference && input.requestReference !== requestReference)
    throw new Error("Source PDF request reference does not match its source");
  return { ...request, requestReference, requestKey };
}

export const providerPdfRequestReference = (input: ProviderPdfAttachment) =>
  safeRequest(input).requestReference;
const sourceReference = (request: SafeRequest, digest: string) =>
  `${request.requestReference}:${digest}`;
const recordPath = (key: string) => path.join(
  mikeLocalDataHome(), "projections", "v1", "source-pdf", `${key}.json`,
);

async function readRecord(key: string) {
  try {
    const value = JSON.parse(await readFile(recordPath(key), "utf8")) as PdfRecord;
    const request = safeRequest(value);
    if (value.schema_version !== 1 || request.requestKey !== key ||
        !["queued", "downloaded", "failed"].includes(value.status) ||
        (value.source_sha256 && !/^[a-f0-9]{64}$/u.test(value.source_sha256))) return null;
    return { ...value, ...request };
  } catch { return null; }
}

async function writeRecord(request: SafeRequest, status: PdfRecord["status"], digest?: string) {
  const record: PdfRecord = { ...request, schema_version: 1, status,
    ...(digest ? { source_sha256: digest } : {}), updated_at: new Date().toISOString() };
  await atomicWriteProjection(recordPath(request.requestKey), `${JSON.stringify(record)}\n`);
  return record;
}

async function verifiedContent(digest?: string) {
  if (!digest) return null;
  const filename = pdfContentPath(digest);
  try { await inspectPdf(filename, { expectedSha256: digest }); return filename; }
  catch { return null; }
}

async function fetchPdf(request: SafeRequest, signal?: AbortSignal) {
  let current = new URL(request.url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const url = sourceUrl(current.toString());
    if (url.hostname === "api.govinfo.gov" && !url.searchParams.has("api_key"))
      url.searchParams.set("api_key", process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY");
    const response = await guardedRemoteFetch(url, {
      redirect: "manual", signal,
      headers: { Accept: "application/pdf, application/octet-stream" },
    }, { label: "Source PDF URL", timeoutMs: 30_000 });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === 5) throw new Error("Source PDF redirect could not be resolved");
    current = new URL(location, url);
  }
  throw new Error("Source PDF redirect limit exceeded");
}

async function download(request: SafeRequest, signal?: AbortSignal) {
  return withProjectionLock(request.requestReference, async () => {
    const prior = await readRecord(request.requestKey);
    const cached = prior?.status === "downloaded"
      ? await verifiedContent(prior.source_sha256) : null;
    if (cached && prior?.source_sha256)
      return { path: cached, digest: prior.source_sha256 };
    await writeRecord(request, "queued");
    try {
      let response = await fetchPdf(request, signal);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Source PDF request failed (${response.status})`);
      }
      response = await boundRemoteResponse(response, { label: "Source PDF",
        maxBytes: 100 * 1024 * 1024,
        contentTypes: ["application/pdf", "application/octet-stream"] });
      const published = await publishPdfStream(response.body!, signal);
      await writeRecord(request, "downloaded", published.sourceSha256);
      return { path: published.path, digest: published.sourceSha256 };
    } catch (error) {
      await writeRecord(request, "failed");
      throw error;
    }
  });
}

const parse = (path: string, digest: string, signal?: AbortSignal) =>
  documentProjectionService.parsePdf({
  documentId: `provider-pdf-${digest.slice(0, 32)}`,
  versionId: digest.slice(0, 32), sourcePath: path, sourceSha256: digest,
  layout: null, signal,
});

function state(request: SafeRequest, record: PdfRecord | null,
  parseStatus: PdfParseStatus | null = null): ProviderPdfAttachmentState {
  const digest = record?.status === "downloaded" ? record.source_sha256 ?? null : null;
  const reference = digest ? sourceReference(request, digest) : null;
  return {
    provider: request.provider, identity: request.identity,
    request_reference: request.requestReference,
    reference_id: reference ?? request.requestReference, source_reference: reference,
    download_status: record?.status ?? "not_queued", source_sha256: digest,
    parse_status: parseStatus,
  };
}

async function enqueueProviderJob(request: SafeRequest, userId: string) {
  const queued = await enqueueJob({
    kind: "pdf.provider",
    dedupeKey: request.requestReference,
    groupKey: `provider-pdf:${request.requestKey}`,
    userId,
    payload: { requestReference: request.requestReference },
    priority: 0,
  });
  wakeJobWorker();
  return queued;
}

export async function queueProviderPdfAttachment(
  input: ProviderPdfAttachment,
  userId: string,
) {
  const request = safeRequest(input);
  let record: PdfRecord | null = null;
  await withProjectionLock(request.requestReference, async () => {
    record = await readRecord(request.requestKey);
    const content = record?.status === "downloaded"
      ? await verifiedContent(record.source_sha256) : null;
    if (!content && record?.status !== "queued") record = await writeRecord(request, "queued");
  });
  await enqueueProviderJob(request, userId);
  return state(request, record);
}

async function stateFor(request: SafeRequest, expected: string | null, userId: string) {
  let record = await readRecord(request.requestKey);
  let digest = record?.status === "downloaded" ? record.source_sha256 ?? null : null;
  if (expected && digest !== expected) return state(request, null);
  let content = await verifiedContent(digest ?? undefined);
  if (!content) {
    const queued = await queueProviderPdfAttachment(request, userId);
    record = await readRecord(request.requestKey);
    return queued ?? state(request, record);
  }
  const parsed = await documentProjectionService.pdfState({
    documentId: `provider-pdf-${digest!.slice(0, 32)}`,
    versionId: digest!.slice(0, 32), sourceSha256: digest!,
  });
  if (!parsed || !["ready", "degraded"].includes(parsed.status)) {
    await enqueueProviderJob(request, userId);
  }
  return state(request, record, parsed?.status ?? null);
}

export async function readProviderPdfAttachmentState(
  input: ProviderPdfAttachment,
  userId: string,
) {
  return stateFor(safeRequest(input), null, userId);
}

async function requestForReference(reference: string) {
  const match = reference.match(REFERENCE);
  if (!match) throw new Error("Source PDF reference is invalid");
  const record = await readRecord(match[2]);
  if (!record || record.provider !== match[1])
    throw new Error("Source PDF reference is unavailable");
  return { request: safeRequest(record), digest: match[3] ?? null };
}

export function providerPdfJobHandlers(): Record<string, JobHandler> {
  return {
    "pdf.provider": async (job, context) => {
      const value = job.payload;
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          typeof value.requestReference !== "string") throw new Error("InvalidProviderPdfJob");
      const { request } = await requestForReference(value.requestReference);
      const downloaded = await download(request, context.signal);
      await context.progress({ phase: "extracting" });
      const parsed = await parse(downloaded.path, downloaded.digest, context.signal);
      if (!["ready", "degraded"].includes(parsed.status)) {
        throw new Error("ProviderPdfParseFailed");
      }
      return {
        requestReference: request.requestReference,
        sourceSha256: downloaded.digest,
        cacheKey: parsed.cache_key,
        status: parsed.status,
      };
    },
  };
}

async function readyEvidence<Lookup extends { status: string }>(
  reference: string,
  userId: string,
  lookup: (sourcePath: string, cacheKey: string, sourceSha256: string) => Promise<Lookup>,
  handle: (result: Lookup) => string | null,
) {
  let resolved: Awaited<ReturnType<typeof requestForReference>>;
  try { resolved = await requestForReference(reference); }
  catch { return { availability: "error" as const,
    error: "Source PDF reference is unavailable" }; }
  const current = await stateFor(resolved.request, resolved.digest, userId);
  if (current.download_status !== "downloaded" || !current.source_sha256 ||
      !["ready", "degraded"].includes(String(current.parse_status))) {
    const failed = current.download_status === "failed" || current.parse_status === "failed";
    return { availability: failed ? "error" as const : "queued" as const, state: current,
      error: failed ? "Source PDF download or parse failed" : undefined };
  }
  const sourcePath = pdfContentPath(current.source_sha256);
  const parsed = await documentProjectionService.pdfState({
    documentId: `provider-pdf-${current.source_sha256.slice(0, 32)}`,
    versionId: current.source_sha256.slice(0, 32),
    sourceSha256: current.source_sha256,
  });
  if (!parsed || !["ready", "degraded"].includes(parsed.status)) return {
    availability: "queued" as const, state: current,
  };
  const result = await lookup(sourcePath, parsed.cache_key, current.source_sha256);
  const evidence = handle(result);
  return { availability: "ready" as const, state: current, params: resolved.request,
    lookup: result, linkEvidence: evidence
      ? await documentProjectionService.rehydratePdfLink(sourcePath, evidence) : null };
}

export const lookupProviderPdfReference = (
  reference: string, userId: string, input: PdfLookupInput,
) => readyEvidence(reference, userId,
    (source, cacheKey, sourceSha256) => documentProjectionService.lookupPdf(source, input, {
      cacheKey,
      documentId: `provider-pdf-${sourceSha256.slice(0, 32)}`,
      versionId: sourceSha256.slice(0, 32),
      sourceSha256,
    }),
    (result) => result.status === "found" ? result.evidence.handle : null);

export const rehydrateProviderPdfReference = (
  reference: string, userId: string, handle: string,
) => readyEvidence(reference, userId,
    (source) => documentProjectionService.rehydratePdfEvidence(source, handle),
    (result) => result.status === "found" ? handle : null);

export async function queueProviderPdfRenditions(
  document: RemoteLegalSourceDocument,
  userId?: string,
) {
  if (!userId || documentHasOriginNative(document.native, "native")) {
    return [];
  }
  const attachments = new Map<string, RemoteLegalSourceDocument["attachments"][number]>();
  for (const attachment of document.attachments) {
    try {
      const url = new URL(attachment.url);
      url.hash = "";
      const mediaType = attachment.contentType?.toLowerCase().split(";", 1)[0];
      const pathname = url.pathname.toLowerCase();
      if (mediaType === "application/pdf" ||
          attachment.filename?.toLowerCase().endsWith(".pdf") ||
          pathname.endsWith(".pdf") || pathname.endsWith("/pdf")) {
        attachments.set(url.toString(), attachment);
      }
    } catch { /* Optional malformed attachments are unusable. */ }
  }
  return (await Promise.all([...attachments.values()].map(async (attachment) => {
    try {
      const queued = await queueProviderPdfAttachment({
        provider: document.provider,
        identity: document.identity,
        url: attachment.url,
        canonicalUrl: document.url,
        filename: attachment.filename,
        title: attachment.title || document.title,
      }, userId);
      return queued ? {
        ...queued,
        resource: resourceReference.source("pdf", queued.reference_id),
        attachment_title: attachment.title || document.title,
        attachment_filename: attachment.filename,
      } : null;
    } catch { return null; }
  }))).filter((item): item is NonNullable<typeof item> => item !== null);
}
