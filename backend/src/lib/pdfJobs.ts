import type { DocumentStore } from "./documentStore";
import {
  enqueueJob,
  interruptJobs,
  waitForJob,
  wakeJobWorker,
  type ApplicationJob,
  type JobHandler,
} from "./jobQueue";
import { documentProjectionService, type PdfPreparationProgress } from
  "./documentProjectionService";
import { sha256 } from "./hash";
import type { LegalPdfOcrProvider } from "./structureNative";
import type { RelationalDatabase } from "./relationalDatabase";

const SHA256 = /^[a-f0-9]{64}$/u;
const groupKey = (documentId: string, versionId: string, sourceSha256: string) =>
  `pdf:${documentId}:${versionId}:${sourceSha256}`;

function documentPayload(job: ApplicationJob) {
  const value = job.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("InvalidPdfJob");
  }
  const sourceSha256 = value.sourceSha256;
  const rawPages = value.pages;
  if (typeof sourceSha256 !== "string" || !SHA256.test(sourceSha256)) {
    throw new Error("InvalidPdfJob");
  }
  const pages = rawPages === undefined ? null : Array.isArray(rawPages) &&
    rawPages.length > 0 && rawPages.length <= 32 && rawPages.every((page) =>
      Number.isInteger(page) && Number(page) >= 1 && Number(page) <= 100_000)
    ? [...new Set(rawPages.map(Number))].sort((left, right) => left - right)
    : undefined;
  if (pages === undefined) throw new Error("InvalidPdfJob");
  return { sourceSha256, pages };
}

function reprocessPayload(job: ApplicationJob) {
  const base = documentPayload(job), value = job.payload as Record<string, unknown>;
  if (value.ocrProvider !== undefined && value.ocrProvider !== null &&
      value.ocrProvider !== "tesseract" && value.ocrProvider !== "kraken-lite") {
    throw new Error("InvalidPdfJob");
  }
  const ocrProvider = value.ocrProvider as LegalPdfOcrProvider | null | undefined;
  let layout: boolean | null | undefined;
  if (value.layout === null) layout = null;
  else if (value.layout === "local") layout = true;
  else if (value.layout !== undefined) throw new Error("InvalidPdfJob");
  return { ...base, ocrProvider, layout };
}

export function pdfJobHandlers(documents: DocumentStore): Record<string, JobHandler> {
  const run: JobHandler = async (job, context) => {
    if (!job.documentId || !job.documentVersionId) throw new Error("InvalidPdfJob");
    const input = documentPayload(job);
    const content = await documents.read(
      { userId: job.userId },
      job.documentId,
      job.documentVersionId,
      false,
    );
    if (!content || content.fileType !== "pdf" ||
        content.version.source_sha256 !== input.sourceSha256) {
      return { skipped: "source-unavailable" } as Record<string, string>;
    }
    const sourcePath = await documentProjectionService.publishPdf(
      content.bytes,
      input.sourceSha256,
    );
    if (input.pages) {
      const state = await documentProjectionService.parsePdfPages({
        documentId: job.documentId,
        versionId: job.documentVersionId,
        sourcePath,
        sourceSha256: input.sourceSha256,
        pages: input.pages,
        signal: context.signal,
        progress: (value: PdfPreparationProgress) => context.progress(value),
      });
      return { cacheKey: state.cache_key, status: state.status } as Record<string, string>;
    }
    const state = await documentProjectionService.parsePdf({
      documentId: job.documentId,
      versionId: job.documentVersionId,
      sourcePath,
      sourceSha256: input.sourceSha256,
      signal: context.signal,
      progress: (value: PdfPreparationProgress) => context.progress(value),
    });
    return { cacheKey: state.cache_key, status: state.status } as Record<string, string>;
  };
  const reprocess: JobHandler = async (job, context) => {
    if (!job.documentId || !job.documentVersionId) throw new Error("InvalidPdfJob");
    const input = reprocessPayload(job);
    const content = await documents.read(
      { userId: job.userId }, job.documentId, job.documentVersionId, false,
    );
    if (!content || content.fileType !== "pdf" ||
        content.version.source_sha256 !== input.sourceSha256) {
      return { skipped: "source-unavailable" } as Record<string, string>;
    }
    const sourcePath = await documentProjectionService.publishPdf(
      content.bytes, input.sourceSha256, context.signal,
    );
    const state = await documentProjectionService.parsePdf({
      documentId: job.documentId,
      versionId: job.documentVersionId,
      sourcePath,
      sourceSha256: input.sourceSha256,
      ocrProvider: input.ocrProvider,
      layout: input.layout,
      signal: context.signal,
      progress: (value: PdfPreparationProgress) => context.progress(value),
    });
    return { cacheKey: state.cache_key, status: state.status } as Record<string, string>;
  };
  return { "pdf.prepare": run, "pdf.pages": run, "pdf.reprocess": reprocess };
}

export function enqueuePdfPreparation(input: {
  userId: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
}, database?: RelationalDatabase) {
  return enqueueJob({
    kind: "pdf.prepare",
    dedupeKey: `${groupKey(input.documentId, input.versionId, input.sourceSha256)}:full`,
    groupKey: groupKey(input.documentId, input.versionId, input.sourceSha256),
    userId: input.userId,
    documentId: input.documentId,
    documentVersionId: input.versionId,
    payload: { sourceSha256: input.sourceSha256 },
    priority: 0,
  }, database);
}

export async function enqueuePdfReprocess(input: {
  userId: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
  ocrProvider?: LegalPdfOcrProvider | null;
  layout?: boolean | null;
}) {
  const settings = {
    sourceSha256: input.sourceSha256,
    ...(input.ocrProvider !== undefined ? { ocrProvider: input.ocrProvider } : {}),
    ...(input.layout !== undefined ? {
      layout: input.layout ? "local" : null,
    } : {}),
  };
  const group = groupKey(input.documentId, input.versionId, input.sourceSha256);
  const queued = await enqueueJob({
    kind: "pdf.reprocess",
    dedupeKey: `${group}:reprocess:${sha256(JSON.stringify(settings))}`,
    groupKey: group,
    userId: input.userId,
    documentId: input.documentId,
    documentVersionId: input.versionId,
    payload: settings,
    priority: 50,
  });
  await interruptJobs(group, 50);
  wakeJobWorker();
  return queued;
}

async function preparedCacheKey(job: ApplicationJob, userId: string, options: {
  signal?: AbortSignal;
  onProgress?(progress: PdfPreparationProgress): void;
}) {
  const completed = await waitForJob(job.id, userId, {
    signal: options.signal,
    progress: (value) => {
      if (value && typeof value === "object" && !Array.isArray(value) &&
          (value.phase === "inspecting" || value.phase === "extracting" ||
            value.phase === "ocr") && Array.isArray(value.pages)) {
        options.onProgress?.(value as unknown as PdfPreparationProgress);
      }
    },
  });
  const result = completed.result;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      typeof result.cacheKey !== "string") throw new Error("PDF preparation failed");
  return result.cacheKey;
}

export async function preparePdf(input: {
  userId: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
  signal?: AbortSignal;
  onProgress?(progress: PdfPreparationProgress): void;
}) {
  const queued = await enqueuePdfPreparation(input);
  wakeJobWorker();
  return preparedCacheKey(queued, input.userId, input);
}

export async function preparePdfPages(input: {
  userId: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
  pages: number[];
  signal?: AbortSignal;
  onProgress?(progress: PdfPreparationProgress): void;
}) {
  const group = groupKey(input.documentId, input.versionId, input.sourceSha256);
  const pages = [...new Set(input.pages)].sort((left, right) => left - right);
  const queued = await enqueueJob({
    kind: "pdf.pages",
    dedupeKey: `${group}:pages:${pages.join(",")}`,
    groupKey: group,
    userId: input.userId,
    documentId: input.documentId,
    documentVersionId: input.versionId,
    payload: { sourceSha256: input.sourceSha256, pages },
    priority: 100,
  });
  await interruptJobs(group, 100);
  wakeJobWorker();
  return preparedCacheKey(queued, input.userId, input);
}
