import { getDocumentParseStates } from "@/app/lib/api/documents";

export type PdfProgress = { id: string; done: boolean; page?: number; error?: string };

/** One reading of PDF preparation state, for watchers and for the wait below. */
export async function pdfProgress(documentIds: string[]): Promise<PdfProgress[]> {
  return (await getDocumentParseStates(documentIds)).map(({ id, parse_state: state }) => ({
    id, done: state?.status === "ready" || state?.status === "degraded",
    ...(state?.phase === "ocr" && state.pages?.length ? { page: state.pages[0] } : {}),
    ...(state?.status === "failed" || state?.status === "cancelled"
      ? { error: state.error || "PDF preparation did not complete." } : {}),
  }));
}

export async function waitForPdfPreparation(
  documentId: string,
  progress?: (message: string) => void,
  signal?: AbortSignal,
) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    signal?.throwIfAborted();
    const [state] = await pdfProgress([documentId]);
    if (state?.done) return;
    if (state?.error) throw new Error(state.error);
    if (state?.page) progress?.(`Reading page ${state.page}`);
    await new Promise((resolve) => setTimeout(resolve, 850));
  }
  throw new Error("PDF preparation did not finish within 10 minutes.");
}
