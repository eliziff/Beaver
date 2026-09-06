import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { DocumentStore } from "../lib/documentStore";
import { createAuthoritiesImporter } from "../lib/authoritiesImport";
import { checkQuotes, type QuoteResult } from "../lib/quoteCheck";
import { saveQuoteCheckWorkbook } from "../lib/quoteCheckWorkbook";

export function createQuoteCheckRouter(documents: DocumentStore) {
  const router = Router(); router.use(requireAuth);
  router.post("/", asyncRoute(async (req, res) => {
    const scope = applicationScope(res);
    const id = req.body?.documentId;
    if (typeof id !== "string" || !id.trim()) reject(400, "Select a Library document.");
    const versionId = req.body?.versionId;
    if (versionId !== undefined && typeof versionId !== "string") reject(400, "Invalid document version.");
    const source = await documents.projectionSource(scope, id, versionId ?? null)
      ?? reject(404, "Document version not found.");
    const draft = await createAuthoritiesImporter(documents).draft(scope, { kind: "document",
      documentId: id, version: { versionId: source.versionId, sha256: source.sourceSha256 } });
    const abort = new AbortController(); res.on("close", () => abort.abort());
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache"); res.flushHeaders();
    const completedQuotes: QuoteResult[] = [];
    let citationUnits: Awaited<ReturnType<typeof checkQuotes>>["citationUnits"] = [];
    let total = 0;
    try {
      const report = await checkQuotes(draft, [], abort.signal, (completed, count, quote, units) => {
        citationUnits = units ?? [];
        completedQuotes.push(quote); total = count;
        res.write(`data: ${JSON.stringify({ quote, completed, total })}\n\n`);
      });
      const workbook = await saveQuoteCheckWorkbook(documents, scope, id, report, undefined, source.versionId);
      res.write(`data: ${JSON.stringify({ done: true, counts: report.counts, total: report.total, workbook })}\n\n`);
    } catch (error) {
      const workbook = completedQuotes.length ? await saveQuoteCheckWorkbook(documents, scope, id, {
        mode: "mechanical — incomplete", total, quotes: completedQuotes, citationUnits,
        counts: Object.fromEntries([...new Set(completedQuotes.map(({ status }) => status))]
          .map((status) => [status, completedQuotes.filter((quote) => quote.status === status).length])),
      }, undefined, source.versionId) : null;
      if (!abort.signal.aborted) res.write(`data: ${JSON.stringify({ error: error instanceof Error
        ? error.message : "Quotation checking failed. Completed receipts remain available.", workbook })}\n\n`);
    } finally { res.end(); }
  }));
  return router;
}
