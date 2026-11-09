import path from "node:path";
import { readFile } from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import { preparePdf } from "./sourceDocument";
import { lookupPdf, rehydratePdfEvidence, type PdfLookupInput } from "./pdfEvidence";
import {
  atomicWrite,
  inspectPdf,
  pdfContentPath,
  publishPdfStream,
  withStoreLock,
} from "./contentStore";
import { boundRemoteResponse, guardedRemoteFetch, normalizeRemoteHttpsUrl } from "./remoteUrlSafety";
import { decisiaIndexUrl, publisherChallengeUrl, publisherPdfCandidate,
  rankedPublisherPdfLinks, verifiedDecisiaPdf } from "./legalSourcePresentation";
import { sha256 } from "./hash";
import type { RemoteLegalSourceDocument } from "./legalSources/remoteProvider";
import { legalSourceReferenceSchema, type LegalSourceReference } from "./legalSources";
import { resourceReference } from "mike/shared/runtime/resourceReferences.mjs";
import { structureNative, type PdfStatus } from "./structureNative";
import { isCanliiUrl } from "mike/shared/runtime/canliiPageUrls.mjs";
import type { PdfProfileSelection } from "./documentStore";
import type { JobHandler } from "./jobQueue";

export type ProviderPdfAttachment = {
  source: LegalSourceReference;
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
  parse_status: PdfStatus | "parsing" | "failed" | null;
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
  parse_status?: PdfStatus | "parsing" | "failed";
  pdf_profile?: PdfProfileSelection;
  updated_at: string;
};

// What a record says: a parse only follows a download, and only a finished parse
// with its profile is usable ("unparsed" also reads ready without the profile).
type PdfPhase =
  | { phase: "queued" | "failed" }
  | { phase: "downloaded"; digest: string; parse: "unparsed" | "parsing" | "failed";
    profile?: PdfProfileSelection }
  | { phase: "parsed"; digest: string; parse: PdfStatus; profile: PdfProfileSelection };

function pdfPhase(record: PdfRecord | null): PdfPhase | null {
  if (!record) return null;
  if (record.status !== "downloaded") return { phase: record.status };
  const digest = record.source_sha256, parse = record.parse_status, profile = record.pdf_profile;
  if (!digest) return null;
  if (parse === "ready" || parse === "degraded") return profile
    ? { phase: "parsed", digest, parse, profile } : { phase: "downloaded", digest, parse: "unparsed" };
  return { phase: "downloaded", digest, parse: parse ?? "unparsed", ...(profile && { profile }) };
}
const pdfDigest = (phase: PdfPhase | null) => phase && "digest" in phase ? phase.digest : null;

const PREFIX = "mike-provider-pdf:v1";
const REFERENCE = /^mike-provider-pdf:v1:([a-z0-9-]+):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/u;

const text = (value: string | null | undefined, maximum: number) => {
  const result = value?.trim().replace(/\s+/gu, " ") ?? "";
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(result)
    ? result : null;
};

function publicUrl(raw: string) {
  const url = normalizeRemoteHttpsUrl(raw, { label: "Source PDF URL", maxUrlLength: 8_192,
    defaultPortOnly: true, allowIpLiterals: false, blockedHostSuffixes: [".local"] }).url;
  if (isCanliiUrl(url)) throw new Error("Source PDF URL points to a blocked host.");
  return url;
}

function withoutApiKey(url: URL) {
  if (url.hostname === "api.govinfo.gov") url.searchParams.delete("api_key");
  return url;
}
const sourceUrl = (raw: string) => withoutApiKey(publicUrl(raw));

function safeRequest(input: ProviderPdfAttachment): SafeRequest {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(input.provider))
    throw new Error("Source provider is invalid");
  const identity = text(input.identity, 500);
  if (!identity) throw new Error("Source PDF identity is invalid");
  const source = legalSourceReferenceSchema.safeParse(input.source);
  if (!source.success || source.data.provider !== input.provider)
    throw new Error("Source PDF legal reference is invalid");
  const request = {
    source: { ...source.data,
      ...(source.data.url ? { url: withoutApiKey(new URL(source.data.url)).toString() } : {}) },
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

const sourceReference = (request: SafeRequest, digest: string) =>
  `${request.requestReference}:${digest}`;
const recordPath = (key: string) => path.join(
  mikeLocalDataHome(), "projections", "v1", "source-pdf", `${key}.json`,
);

// Written only by writeRecord, from a request already made safe, under that request's hash.
async function readRecord(key: string) {
  try { return JSON.parse(await readFile(recordPath(key), "utf8")) as PdfRecord; }
  catch { return null; }
}

async function writeRecord(request: SafeRequest, phase: PdfPhase) {
  const record: PdfRecord = { ...request, schema_version: 1,
    status: phase.phase === "queued" || phase.phase === "failed" ? phase.phase : "downloaded",
    ...("digest" in phase ? { source_sha256: phase.digest } : {}),
    ...("parse" in phase && phase.parse !== "unparsed" ? { parse_status: phase.parse } : {}),
    ...("profile" in phase && phase.profile ? { pdf_profile: phase.profile } : {}),
    updated_at: new Date().toISOString() };
  await atomicWrite(recordPath(request.requestKey), `${JSON.stringify(record)}\n`);
  return record;
}

async function verifiedContent(digest?: string) {
  if (!digest) return null;
  const filename = pdfContentPath(digest);
  try { await inspectPdf(filename, { expectedSha256: digest }); return filename; }
  catch { return null; }
}

async function fetchSource(rawUrl: string, accept: string, signal?: AbortSignal) {
  let current = new URL(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const url = sourceUrl(current.toString());
    if (url.hostname === "api.govinfo.gov" && !url.searchParams.has("api_key"))
      url.searchParams.set("api_key", process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY");
    let response: Response;
    try {
      response = await guardedRemoteFetch(url, {
        redirect: "manual", signal,
        headers: { Accept: accept, "User-Agent": "Mozilla/5.0 (compatible; Beaver-Authorities/1.0)" },
      }, { label: "Source PDF URL", timeoutMs: 30_000 });
    } catch (error) {
      const { code, pdfUrl } = error as { code?: unknown; pdfUrl?: string };
      if (code === "verification_required") throw new PublisherDownloadFailure(rawUrl, "blocked", pdfUrl);
      if (code === "origin_denied") throw new PublisherDownloadFailure(rawUrl, "refused");
      throw error;
    }
    if (response.status < 300 || response.status >= 400) return { response, url };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === 5) throw new Error("Source PDF redirect could not be resolved");
    current = new URL(location, url);
    if (verificationPage(current.href)) {
      throw new PublisherDownloadFailure(rawUrl);
    }
  }
  throw new Error("Source PDF redirect limit exceeded");
}

async function download(request: SafeRequest, signal?: AbortSignal) {
  const found = await inspectPublisherSource(request, signal, false);
  if (!found.path || !found.digest) throw new Error("Source PDF is unavailable");
  return { path: found.path, digest: found.digest };
}

type ProviderOriginalPdfRequest = Omit<ProviderPdfAttachment,
  "url" | "canonicalUrl" | "requestReference"> & {
  sourceUrl?: string | null;
  pdfUrl?: string | null;
};

/** Why a publisher's original was not downloaded: the publisher blocked the download, the
 *  download service refused this page's address, or the publisher or service did not answer.
 *  `pdfUrl` is the PDF the service named, when it named one. */
export class PublisherDownloadFailure extends Error {
  constructor(readonly pageUrl: string, readonly reason: "blocked" | "refused" | "failed" = "blocked",
    readonly pdfUrl?: string) {
    super(`Automatic download ${reason}.`);
  }
}
const verificationPage = (value: string) =>
  /\/robocop\/captcha\//iu.test(value);
/** A publisher or download service that did not answer, unlike one that answered with no PDF. */
const unanswered = (error: unknown) => error instanceof TypeError || (error as Error)?.name === "TimeoutError" ||
  ["timeout", "publisher_error", "service_error", "rate_limited"].includes(String((error as { code?: unknown })?.code));

async function inspectPublisherSource(request: SafeRequest, signal?: AbortSignal,
  allowHtml = true) {
  return withStoreLock(request.requestReference, async () => {
    const prior = pdfDigest(pdfPhase(await readRecord(request.requestKey)));
    const cached = prior ? await verifiedContent(prior) : null;
    if (cached && prior) return {
      path: cached, digest: prior, url: request.url, links: [] as string[],
    };
    let pdf = !allowHtml;
    try {
      if (pdf) await writeRecord(request, { phase: "queued" });
      let { response, url } = await fetchSource(request.url,
        `application/pdf, application/octet-stream${allowHtml
          ? ", text/html, application/xhtml+xml" : ""}`, signal);
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]
        .trim().toLowerCase();
      let markup: string | undefined;
      if (["text/html", "application/xhtml+xml"].includes(mediaType ?? "")) {
        response = await boundRemoteResponse(response, { label: "Publisher source page",
          maxBytes: 2_000_000, contentTypes: ["text/html", "application/xhtml+xml"] });
        markup = await response.text();
        const challengeUrl = publisherChallengeUrl(markup, url);
        if (challengeUrl || response.headers.get("cf-mitigated") === "challenge")
          throw new PublisherDownloadFailure(request.canonicalUrl ?? request.url);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Source PDF request failed (${response.status})`);
      }
      if (allowHtml && markup !== undefined) {
        const index = decisiaIndexUrl(url);
        const representation = index && verifiedDecisiaPdf(markup, url);
        const links = rankedPublisherPdfLinks(markup, url);
        return { path: null, digest: null, url: url.toString(),
          links: index ? representation ? [representation.url] : links.filter((link) => {
            const frame = new URL(link);
            return frame.origin === index.origin && frame.pathname === index.pathname &&
              frame.searchParams.get("iframe") === "true";
          }) : links };
      }
      if (!pdf) { pdf = true; await writeRecord(request, { phase: "queued" }); }
      response = await boundRemoteResponse(response, { label: "Source PDF",
        maxBytes: 100 * 1024 * 1024,
        contentTypes: ["application/pdf", "application/octet-stream"] });
      const published = await publishPdfStream(response.body!, signal);
      await writeRecord(request, { phase: "downloaded", digest: published.sourceSha256, parse: "unparsed" });
      return { path: published.path, digest: published.sourceSha256,
        url: url.toString(), links: [] as string[] };
    } catch (error) {
      if (pdf) await writeRecord(request, { phase: "failed" });
      throw error;
    }
  });
}

/** The addresses a publisher's original is asked for at, in turn: the PDF a source names, the route
 *  the publisher prints its PDFs at, and the decision's own page. */
export function publisherOriginalUrls(sourceUrl?: string | null, pdfUrl?: string | null) {
  const candidate = sourceUrl && publisherPdfCandidate(sourceUrl);
  return [...new Set([pdfUrl, candidate, sourceUrl].filter((value): value is string => Boolean(value)))];
}

/** Finds and validates an A2AJ publisher's original PDF without ever requesting CanLII. */
export async function downloadProviderOriginalPdf(
  input: ProviderOriginalPdfRequest,
  signal?: AbortSignal,
) {
  const { sourceUrl: rawSource, pdfUrl, ...attachment } = input;
  let canonicalUrl: string | null = null;
  try { canonicalUrl = rawSource ? sourceUrl(rawSource).toString() : null; } catch { /* blocked */ }
  const candidate = rawSource && publisherPdfCandidate(rawSource);
  const queue = publisherOriginalUrls(rawSource, pdfUrl);
  const seen = new Set<string>();
  let candidateChallenge: PublisherDownloadFailure | null = null;
  let candidateAdvertised = false, failed = false;
  while (queue.length && seen.size < 12) {
    signal?.throwIfAborted();
    let request: SafeRequest;
    try { request = safeRequest({ ...attachment, url: queue.shift()!, canonicalUrl }); }
    catch { continue; }
    if (seen.has(request.url)) continue;
    seen.add(request.url);
    try {
      const found = await inspectPublisherSource(request, signal);
      if (found.path && found.digest) return { bytes: await readFile(found.path),
        sourceSha256: found.digest, url: found.url };
      if (candidate && found.links.includes(candidate)) candidateAdvertised = true;
      queue.push(...found.links);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PublisherDownloadFailure) {
        // A guessed route can challenge even when the case page has no PDF.
        if (error.reason === "blocked" && candidate && request.url === candidate && request.url !== pdfUrl) {
          candidateChallenge = error;
          continue;
        }
        throw error;
      }
      failed ||= unanswered(error);
    }
  }
  if (candidateAdvertised && candidateChallenge) throw candidateChallenge;
  if (failed) throw new PublisherDownloadFailure(canonicalUrl ?? rawSource ?? pdfUrl ?? "", "failed");
  return null;
}

const parse = (bytes: Buffer, digest: string, signal?: AbortSignal,
  pdfProfile?: PdfProfileSelection) =>
  preparePdf({
  documentId: `provider-pdf-${digest.slice(0, 32)}`,
  versionId: digest.slice(0, 32), bytes, sourceSha256: digest,
  signal, pdfProfile,
});

function state(request: SafeRequest, record: PdfRecord | null): ProviderPdfAttachmentState {
  const phase = pdfPhase(record), digest = pdfDigest(phase);
  const reference = digest ? sourceReference(request, digest) : null;
  return {
    provider: request.provider, identity: request.identity,
    request_reference: request.requestReference,
    reference_id: reference ?? request.requestReference, source_reference: reference,
    download_status: !phase ? "not_queued" : digest ? "downloaded" : phase.phase as "queued" | "failed",
    source_sha256: digest,
    parse_status: !phase || !("parse" in phase) || phase.parse === "unparsed" ? null : phase.parse,
  };
}

async function enqueueProviderJob(request: SafeRequest, userId: string) {
  const { enqueueJob } = await import("./jobQueue");
  const queued = await enqueueJob({
    kind: "pdf.provider",
    dedupeKey: request.requestReference,
    groupKey: `provider-pdf:${request.requestKey}`,
    userId,
    payload: { requestReference: request.requestReference },
    priority: 0,
  });
  return queued;
}

export async function queueProviderPdfAttachment(
  input: ProviderPdfAttachment,
  userId: string,
) {
  const request = safeRequest(input);
  const { record, enqueue } = await withStoreLock(request.requestReference, async () => {
    const record = await readRecord(request.requestKey), phase = pdfPhase(record);
    const content = await verifiedContent(pdfDigest(phase) ?? undefined);
    return { record: !content && phase?.phase !== "queued" ? await writeRecord(request, { phase: "queued" }) : record,
      enqueue: !content || phase?.phase !== "parsed" };
  });
  if (enqueue) await enqueueProviderJob(request, userId);
  return state(request, record);
}

async function stateFor(request: SafeRequest, expected: string | null, userId: string) {
  const record = await readRecord(request.requestKey), phase = pdfPhase(record), digest = pdfDigest(phase);
  if (expected && digest !== expected) return state(request, null);
  const content = await verifiedContent(digest ?? undefined);
  // A record promises work its job may not have lived to do, so each waiting read
  // asks for the job again. The job's dedupe key makes that nothing while it lives.
  if (content ? phase?.phase === "downloaded" && phase.parse !== "failed" : phase?.phase === "queued")
    await enqueueProviderJob(request, userId);
  else if (!content && phase?.phase !== "failed") return queueProviderPdfAttachment(request, userId);
  return state(request, record);
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
      const downloaded = await download(request, context.signal), digest = downloaded.digest;
      const selected = (await readRecord(request.requestKey))?.pdf_profile;
      await context.progress({ phase: "extracting" });
      await writeRecord(request, { phase: "downloaded", digest, parse: "parsing", profile: selected });
      try {
        const summary = await parse(await readFile(downloaded.path), digest, context.signal, selected);
        const profile = { cacheKey: summary.cacheKey, profile: summary.profile, status: summary.status };
        await writeRecord(request, { phase: "parsed", digest, parse: summary.status, profile });
        return {
          requestReference: request.requestReference,
          sourceSha256: digest,
          status: summary.status,
        };
      } catch (error) {
        await writeRecord(request, { phase: "downloaded", digest, parse: "failed", profile: selected });
        throw error;
      }
    },
  };
}

type PdfEvidenceLookup = Awaited<ReturnType<typeof lookupPdf>>;

async function readyEvidence(
  reference: string,
  userId: string,
  lookup: (readBytes: () => Promise<Buffer>, sourceSha256: string,
    pdfProfile?: PdfProfileSelection) => Promise<PdfEvidenceLookup>,
  verifySource = true,
) {
  let resolved: Awaited<ReturnType<typeof requestForReference>>;
  try { resolved = await requestForReference(reference); }
  catch { return { availability: "error" as const,
    error: "Source PDF reference is unavailable" }; }
  const cached = verifySource ? null : await readRecord(resolved.request.requestKey);
  const current = verifySource
    ? await stateFor(resolved.request, resolved.digest, userId)
    : state(resolved.request, cached);
  if (current.download_status !== "downloaded" || !current.source_sha256 ||
      !["ready", "degraded"].includes(String(current.parse_status))) {
    const failed = current.download_status === "failed" || current.parse_status === "failed";
    return { availability: failed ? "error" as const : "queued" as const, state: current,
      error: failed ? "Source PDF download or parse failed" : undefined };
  }
  const sourceSha256 = current.source_sha256;
  const profile = (verifySource
    ? await readRecord(resolved.request.requestKey)
    : cached)?.pdf_profile;
  if (!profile) return { availability: "queued" as const, state: current };
  const result = await lookup(
    () => readFile(pdfContentPath(sourceSha256)),
    sourceSha256,
    profile,
  );
  return { availability: "ready" as const, state: current, params: resolved.request,
    lookup: result };
}

const providerProjectionReference = (sourceSha256: string) => ({
  documentId: `provider-pdf-${sourceSha256.slice(0, 32)}`,
  versionId: sourceSha256.slice(0, 32),
  sourceSha256,
});

export const lookupProviderPdfReference = (
  reference: string, userId: string, input: PdfLookupInput,
) => readyEvidence(reference, userId,
    (readSource, sourceSha256, pdfProfile) => lookupPdf(
      readSource, input, { ...providerProjectionReference(sourceSha256), pdfProfile }));

export const rehydrateProviderPdfReference = (
  reference: string, userId: string, handle: string,
) => readyEvidence(reference, userId,
    (_readSource, sourceSha256) => rehydratePdfEvidence(
      handle,
      providerProjectionReference(sourceSha256),
    ), false);

export async function queueProviderPdfRenditions(
  document: RemoteLegalSourceDocument,
  source: LegalSourceReference,
  userId?: string,
) {
  if (!userId || structureNative().documentHasOrigin(document.native, "native")) {
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
        source,
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
