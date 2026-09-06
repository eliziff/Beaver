import { getDocumentParseStates } from "@/app/lib/api/documents";

export async function waitForPdfPreparation(
  documentId: string,
  progress?: (message: string) => void,
  signal?: AbortSignal,
) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    signal?.throwIfAborted();
    const state = (await getDocumentParseStates([documentId]))[0]?.parse_state;
    if (state?.status === "ready" || state?.status === "degraded") return;
    if (state?.status === "failed" || state?.status === "cancelled") {
      throw new Error(state.error || "PDF preparation did not complete.");
    }
    if (state?.phase === "ocr") {
      const page = state.pages?.[0];
      progress?.(`Running OCR${page ? ` on page ${page}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 850));
  }
  throw new Error("PDF preparation did not finish within 10 minutes.");
}
