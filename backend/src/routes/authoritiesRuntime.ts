import { Router, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { ApplicationError } from "../lib/applicationError";
import { createAuthoritiesOperations, assertAuthoritiesBuildUploadSize } from "../lib/authoritiesOperations";
import { resolveAuthoritiesSources } from "../lib/authoritiesSourceResolution";
import { reviewAuthoritiesDiscrepancies } from "../lib/authoritiesDiscrepancy";
import { asyncRoute } from "../lib/asyncRoute";
import { followedRoute } from "../lib/followedRoute";
import { multipleFileUpload, singleFileUpload } from "../lib/upload";
import type { AuthoritiesOperation, AuthoritiesOperationInput, AuthoritiesRuntimeResult } from "mike/shared/runtime/authoritiesRuntime.mjs";
function sendMultipart(res: Response, metadata: Record<string, unknown>,
  files: Iterable<{ role: string; mimeType: string; bytes: Uint8Array; filename?: string }>) {
  const boundary = `beaver-${randomUUID()}`;
  res.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
  return pipeline((function* () {
    for (const [name, value] of Object.entries(metadata)) yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n` +
      `Content-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`);
    for (const file of files) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ` +
        `name="${file.role}"; filename="${file.filename ?? "output"}"\r\n` +
        `Content-Type: ${file.mimeType}\r\n\r\n`);
      yield file.bytes;
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  })(), res);
}

async function sendDraft(res: Response, state: unknown,
  attachments: NonNullable<AuthoritiesRuntimeResult["attachments"]>) {
  if (!attachments.length) return void res.json(state);
  await sendMultipart(res, { draft: state, attachments: attachments.map((item, index) => ({
      part: `file-${index}`, authorityId: item.authorityId, filename: item.filename,
      sourceSha256: item.sourceSha256, language: item.language,
    })) }, attachments.map((item, index) => ({ role: `file-${index}`,
      filename: "source.pdf", mimeType: "application/pdf", bytes: item.bytes })));
}


async function operationInput(req: Request): Promise<AuthoritiesOperationInput> {
  const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
  assertAuthoritiesBuildUploadSize(files);
  return { ...req.body, files: await Promise.all(files.map(async file => ({
    filename: file.originalname, bytes: await readFile(file.path), modified: Number(req.body?.modified),
  }))) };
}
async function sendResult(res: Response, operation: AuthoritiesOperation, result: AuthoritiesRuntimeResult) {
  if (result.attachments) return sendDraft(res, result.data, result.attachments);
  if (operation === "book-front") return void res.type("application/pdf").send(Buffer.from(result.files![0].bytes));
  if (result.files) return sendMultipart(res, result.data as Record<string, unknown>, result.files);
  res.json(result.data);
}
export function createAuthoritiesRuntimeRouter(authenticate: RequestHandler,
  resolveSources: typeof resolveAuthoritiesSources = resolveAuthoritiesSources,
  reviewDiscrepancies: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies) {
  const router = Router(); router.use(authenticate);
  const operations = createAuthoritiesOperations(resolveSources, reviewDiscrepancies);
  router.get("/capabilities", asyncRoute(async (_req, res) => { res.json((await operations.capabilities()).data); }));
  router.post("/quote-check", asyncRoute(async (req, res) => {
    const abort = new AbortController(); res.once("close", () => abort.abort());
    const streamed = req.accepts("text/event-stream") && req.get("accept") === "text/event-stream";
    if (!streamed) return sendResult(res, "quote-check", await operations["quote-check"](await operationInput(req), { signal: abort.signal }));
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.flushHeaders();
    try {
      const result = await operations["quote-check"](await operationInput(req), { signal: abort.signal,
        quoteProgress: value => res.write(`data: ${JSON.stringify(value)}\n\n`) });
      res.write(`data: ${JSON.stringify({ done: true, counts: (result.data as { counts: unknown }).counts })}\n\n`);
    } catch (error) {
      if (!abort.signal.aborted) res.write(`data: ${JSON.stringify({ error: error instanceof ApplicationError
        ? error.message : "Checking stopped. Completed receipts are available to download." })}\n\n`);
    } finally { res.end(); }
  }));
  const uploads = new Set<AuthoritiesOperation>(["source-text", "source-read", "excerpt", "page-labels",
    "annotations", "import", "refresh", "discrepancies/actions", "pdf"]);
  const streamed = new Set<AuthoritiesOperation>(["source-text", "source-read", "sources", "build"]);
  for (const operation of Object.keys(operations) as AuthoritiesOperation[]) {
    if (operation === "capabilities" || operation === "quote-check") continue;
    const handle = async (req: Request, res: Response, progress?: (message: string) => void) => {
      const abort = new AbortController(); res.once("close", () => abort.abort());
      await sendResult(res, operation, await operations[operation](await operationInput(req), { signal: abort.signal, progress }));
    };
    const middleware = operation === "build" ? [multipleFileUpload("files", 500, 16 * 1024 * 1024)]
      : uploads.has(operation) ? [singleFileUpload("file")] : [];
    router.post(`/${operation}`, ...middleware, streamed.has(operation) ? followedRoute(handle) : asyncRoute(handle));
  }
  return router;
}
