import { getDocumentParseStates } from "@/app/lib/api/documents";

/** `pages` lists a page-limited pass; an empty list means the whole PDF is being read. */
export type PdfProgress = { id: string; done: boolean; pages?: number[]; error?: string };

/** One reading of PDF preparation state, for watchers and for the wait below. */
export async function pdfProgress(documentIds: string[]): Promise<PdfProgress[]> {
  return (await getDocumentParseStates(documentIds)).map(({ id, parse_state: state }) => ({
    id, done: state?.status === "ready" || state?.status === "degraded",
    ...(state?.phase === "ocr" && state.pages?.length ? { pages: state.pages } : {}),
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
    if (state?.pages?.length) progress?.(`Running OCR on page ${state.pages[0]}`);
    await new Promise((resolve) => setTimeout(resolve, 850));
  }
  throw new Error("PDF preparation did not finish within 10 minutes.");
}
