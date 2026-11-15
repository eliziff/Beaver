import type { checkQuotes } from "./quoteCheck";
import type { AuthoritiesDraft } from "./authoritiesDomain";
import type { DocumentScope, DocumentStore } from "./documentStore";
import { reject } from "./applicationError";

type Result = Awaited<ReturnType<typeof checkQuotes>>;
export type QuoteAnalysis = Record<string, string>;
const json = (value: unknown) => JSON.stringify(value ?? null);
const isIncompleteCheck = (result: Result) => result.quotes.length < result.total || result.mode.includes("incomplete");

/** A quote check's "[CHECKED]" workbook (the verifier's: quoteVerification/checkedWorkbook.ts), saved beside its input
 *  with the check's receipt. */
export async function saveQuoteCheckWorkbook(documents: Pick<DocumentStore, "metadata" | "create">,
  scope: DocumentScope, inputDocumentId: string, draft: AuthoritiesDraft, result: Result, analysis?: QuoteAnalysis,
  inputVersionId?: string, signal?: AbortSignal) {
  const input = await documents.metadata(scope, inputDocumentId) ?? reject(404, "The input document is no longer available.");
  const { verificationResults } = await import("./quoteVerification/verifier");
  const written = await verificationResults(input.filename, draft, result, { options: analysis ? { analysis } : {}, signal });
  return documents.create(scope, { filename: isIncompleteCheck(result) ? written.name.replace(/\.xlsx$/u, " (incomplete).xlsx") : written.name,
    fileType: "xlsx", projectId: input.project_id, folderId: input.folder_id, bytes: Buffer.from(written.workbook),
    parts: [{ name: "quote-check-receipt.json", bytes: Buffer.from(json({ inputDocumentId,
      inputVersionId, result, ...(analysis ? { analysis } : {}) })) }],
  });
}
