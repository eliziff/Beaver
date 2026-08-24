import type { DocumentStore } from "./documentStore";
import {
  enqueueJob,
  interruptJobs,
  wakeJobWorker,
  type ApplicationJob,
  type JobHandler,
} from "./jobQueue";
import { documentProjectionService, type PdfOcrProvider,
  type PdfPreparationProgress } from "./documentProjectionService";
import { sha256 } from "./hash";
import type { RelationalDatabase } from "./relationalDatabase";
import { pdfLifecycleMark, pdfLifecyclePhase } from "./pdfLifecycleDiagnostics";

const SHA256 = /^[a-f0-9]{64}$/u;
const groupKey = (documentId: string, versionId: string, sourceSha256: string) =>
  `pdf:${documentId}:${versionId}:${sourceSha256}`;

function documentPayload(job: ApplicationJob) {
  const value = job.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("InvalidPdfJob");
  }
  const sourceSha256 = value.sourceSha256;
  if (typeof sourceSha256 !== "string" || !SHA256.test(sourceSha256)) {
    throw new Error("InvalidPdfJob");
  }
  return { sourceSha256 };
}

function reprocessPayload(job: ApplicationJob) {
  const base = documentPayload(job), value = job.payload as Record<string, unknown>;
  if (value.ocrProvider !== undefined && value.ocrProvider !== null &&
      value.ocrProvider !== "tesseract" && value.ocrProvider !== "kraken-lite") {
    throw new Error("InvalidPdfJob");
  }
  const ocrProvider = value.ocrProvider as PdfOcrProvider | null | undefined;
  let layout: boolean | null | undefined;
  if (value.layout === null) layout = null;
  else if (value.layout === "local") layout = true;
  else if (value.layout !== undefined) throw new Error("InvalidPdfJob");
  return { ...base, ocrProvider, layout };
}

export function pdfJobHandlers(documents: DocumentStore): Record<string, JobHandler> {
  const run: JobHandler = async (job, context) => {
    const { documentId, documentVersionId } = job;
    if (!documentId || !documentVersionId) throw new Error("InvalidPdfJob");
    pdfLifecycleMark("queue.claimed", documentId);
    const input = documentPayload(job);
    const content = await pdfLifecyclePhase("worker.source_read", documentId, () =>
      documents.read(
        { userId: job.userId }, documentId, documentVersionId, false,
      ));
    if (!content || content.fileType !== "pdf" ||
        content.version.source_sha256 !== input.sourceSha256) {
      return { skipped: "source-unavailable" } as Record<string, string>;
    }
    const summary = await documentProjectionService.preparePdf({
      documentId,
      versionId: documentVersionId,
      bytes: content.bytes,
      sourceSha256: input.sourceSha256,
      signal: context.signal,
      progress: (value: PdfPreparationProgress) => context.progress(value),
    });
    if (!await documents.recordPdfPreparation({ userId: job.userId }, documentId, {
      versionId: documentVersionId,
      sourceSha256: summary.sourceSha256,
      pageCount: summary.pageCount,
      pdfProfile: { cacheKey: summary.cacheKey, profile: summary.profile,
        status: summary.status },
    })) return { skipped: "source-unavailable" };
    return { status: summary.status, pageCount: summary.pageCount };
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
    const summary = await documentProjectionService.preparePdf({
      documentId: job.documentId,
      versionId: job.documentVersionId,
      bytes: content.bytes,
      sourceSha256: input.sourceSha256,
      ocrProvider: input.ocrProvider,
      layout: input.layout,
      signal: context.signal,
      progress: (value: PdfPreparationProgress) => context.progress(value),
    });
    if (!await documents.recordPdfPreparation({ userId: job.userId }, job.documentId, {
      versionId: job.documentVersionId,
      sourceSha256: summary.sourceSha256,
      pageCount: summary.pageCount,
      pdfProfile: { cacheKey: summary.cacheKey, profile: summary.profile,
        status: summary.status },
    })) return { skipped: "source-unavailable" };
    return { status: summary.status, pageCount: summary.pageCount };
  };
  return { "pdf.prepare": run, "pdf.reprocess": reprocess };
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
  ocrProvider?: PdfOcrProvider | null;
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
