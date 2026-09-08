import type { DocumentStore } from "./documentStore";
import {
  enqueueJob,
  interruptJobs,
  requestGroupCancellation,
  PermanentJobError,
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
type PdfSource = { documentId: string; versionId: string; sourceSha256: string };
const pdfGroupKey = (input: PdfSource) =>
  groupKey(input.documentId, input.versionId, input.sourceSha256);

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
  // The engine numbers requested pages from one; an empty list means the whole PDF.
  if (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.length > 5_000 ||
      value.pages.some((page) => !Number.isSafeInteger(page) || Number(page) < 1)))
    throw new Error("InvalidPdfJob");
  return { ...base, ocrProvider, layout, pages: value.pages as number[] | undefined };
}

async function preparePdf(
  input: Parameters<typeof documentProjectionService.preparePdf>[0],
) {
  try { return await documentProjectionService.preparePdf(input); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "PdfEncrypted") throw error;
    const permanent = new PermanentJobError(error.message, { cause: error });
    permanent.name = error.name;
    throw permanent;
  }
}

export function pdfJobHandlers(documents: DocumentStore): Record<string, JobHandler> {
  const run: JobHandler = async (job, context) => {
    const { documentId, documentVersionId } = job;
    if (!documentId || !documentVersionId) throw new Error("InvalidPdfJob");
    pdfLifecycleMark("queue.claimed", documentId);
    const input = reprocessPayload(job);
    const content = await pdfLifecyclePhase("worker.source_read", documentId, () =>
      documents.read(
        { userId: job.userId }, documentId, documentVersionId, false,
      ));
    if (!content || content.fileType !== "pdf" ||
        content.version.source_sha256 !== input.sourceSha256) {
      return { skipped: "source-unavailable" } as Record<string, string>;
    }
    const summary = await preparePdf({
      documentId,
      versionId: documentVersionId,
      bytes: content.bytes,
      ...input,
      signal: context.signal,
      progress: (value: PdfPreparationProgress) => context.progress(
        input.ocrProvider ? { ...value, phase: "ocr" } : value),
    });
    // A page-limited run recognizes a slice for the workspace cache; the document
    // profile must keep describing the whole PDF.
    if (input.pages?.length) return { recognized: input.pages.length } as Record<string, number>;
    if (!await documents.recordPdfPreparation({ userId: job.userId }, documentId, {
      versionId: documentVersionId,
      sourceSha256: summary.sourceSha256,
      pageCount: summary.pageCount,
      pdfProfile: { cacheKey: summary.cacheKey, profile: summary.profile,
        status: summary.status },
    })) return { skipped: "source-unavailable" };
    return { status: summary.status, pageCount: summary.pageCount,
      pagesNeedingOcr: summary.pagesNeedingOcr,
      ocrRoutedPages: summary.ocrRoutedPages };
  };
  return { "pdf.prepare": run, "pdf.reprocess": run };
}

export function enqueuePdfPreparation(input: {
  userId: string;
  documentId: string;
  versionId: string;
  sourceSha256: string;
  ocrProvider?: PdfOcrProvider | null;
}, database?: RelationalDatabase) {
  return enqueueJob({
    kind: "pdf.prepare",
    dedupeKey: `${groupKey(input.documentId, input.versionId, input.sourceSha256)}:full${input.ocrProvider === undefined ? "" : `:${input.ocrProvider ?? "none"}`}`,
    groupKey: groupKey(input.documentId, input.versionId, input.sourceSha256),
    userId: input.userId,
    documentId: input.documentId,
    documentVersionId: input.versionId,
    payload: { sourceSha256: input.sourceSha256,
      ...(input.ocrProvider !== undefined ? { ocrProvider: input.ocrProvider } : {}) },
    priority: 0,
  }, database);
}

/** Recognize the pages carrying cited passages before the rest of the scan. */
export async function enqueueAuthorityOcr(input: PdfSource & {
  userId: string; citedPages: number[];
}) {
  const cited = [...new Set(input.citedPages)].sort((a, b) => a - b);
  const settings = { ...input, ocrProvider: "kraken-lite" as const };
  if (cited.length) await enqueuePdfReprocess({ ...settings, pages: cited, priority: 60 });
  return enqueuePdfReprocess({ ...settings, priority: 40 });
}

export const cancelPdfJobs = (input: PdfSource & { userId: string }) =>
  requestGroupCancellation(pdfGroupKey(input), input.userId);

export async function enqueuePdfReprocess(input: PdfSource & {
  userId: string;
  ocrProvider?: PdfOcrProvider | null;
  layout?: boolean | null;
  pages?: number[];
  priority?: number;
}) {
  const settings = {
    sourceSha256: input.sourceSha256,
    ...(input.ocrProvider !== undefined ? { ocrProvider: input.ocrProvider } : {}),
    ...(input.layout !== undefined ? { layout: input.layout ? "local" : null } : {}),
    ...(input.pages?.length ? { pages: input.pages } : {}),
  };
  const group = pdfGroupKey(input), priority = input.priority ?? 50;
  const queued = await enqueueJob({
    kind: "pdf.reprocess",
    dedupeKey: `${group}:reprocess:${sha256(JSON.stringify(settings))}`,
    groupKey: group,
    userId: input.userId,
    documentId: input.documentId,
    documentVersionId: input.versionId,
    payload: settings,
    priority,
  });
  await interruptJobs(group, priority);
  return queued;
}
