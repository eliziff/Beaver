import { Router, type Request, type Response } from "express";
import { z, ZodError, type ZodType } from "zod";
import { requireAuth } from "../middleware/auth";
import { createTabularApplication, tabularDtos } from "../lib/tabular/application";
import type { DocumentStore } from "../lib/documentStore";
import { PageCursorError } from "../lib/pagination";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import {
  TabularStoreError,
  type TabularScope,
  type TabularStore,
} from "../lib/tabularStore";

const scope = (res: Response): TabularScope => ({
  userId: res.locals.userId as string,
  userEmail: res.locals.userEmail as string | undefined,
});
const parse = <T extends ZodType>(schema: T, value: unknown): z.output<T> =>
  schema.parse(value);
const abortSignal = (req: Request, res: Response) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  return controller.signal;
};
const errorResponse = (res: Response, error: unknown) => {
  if (error instanceof ZodError || error instanceof PageCursorError) {
    const detail = error instanceof ZodError
      ? error.issues[0]?.message ?? "Invalid request" : error.message;
    res.status(400).json({ detail }); return;
  }
  if (error instanceof TabularStoreError) {
    const details = error as TabularStoreError & {
      code?: string; provider?: string; model?: string;
    };
    res.status(error.status).json({ detail: error.message,
      ...(details.code ? { code: details.code, provider: details.provider,
        model: details.model } : {}) });
    return;
  }
  console.error("[tabular]", safeErrorLog(error));
  res.status(500).json({ detail: safeErrorMessage(error, "Tabular request failed") });
};
const json = async (res: Response, operation: () => Promise<unknown>, status = 200) => {
  try { res.status(status).json(await operation()); } catch (error) { errorResponse(res, error); }
};

export function createTabularRouter(store: TabularStore, documents: DocumentStore) {
  const router = Router(), app = createTabularApplication(store, documents);
  router.use(requireAuth);

  router.get("/", (req, res) => json(res, () => app.list(scope(res),
    parse(tabularDtos.list, req.query))));
  router.post("/", (req, res) => json(res, () => app.create(scope(res),
    parse(tabularDtos.create, req.body)), 201));
  router.post("/prompt", (req, res) => json(res, () => app.prompt(scope(res),
    parse(tabularDtos.prompt, req.body), abortSignal(req, res))));
  router.get("/:reviewId", (req, res) => json(res, () => app.detail(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.get("/:reviewId/people", (req, res) => json(res, () => app.people(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.patch("/:reviewId", (req, res) => json(res, () => app.update(scope(res),
    parse(tabularDtos.id, req.params.reviewId), parse(tabularDtos.update, req.body))));
  router.delete("/:reviewId", async (req, res) => {
    try {
      await app.remove(scope(res), parse(tabularDtos.id, req.params.reviewId));
      res.status(204).send();
    } catch (error) { errorResponse(res, error); }
  });
  router.post("/:reviewId/clear-cells", async (req, res) => {
    try {
      await app.clear(scope(res), parse(tabularDtos.id, req.params.reviewId),
        parse(tabularDtos.clear, req.body));
      res.status(204).send();
    } catch (error) { errorResponse(res, error); }
  });
  router.post("/:reviewId/regenerate-cell", (req, res) => json(res,
    () => app.regenerate(scope(res), parse(tabularDtos.id, req.params.reviewId),
      parse(tabularDtos.regenerate, req.body), abortSignal(req, res))));

  router.post("/:reviewId/generate", async (req, res) => {
    const signal = abortSignal(req, res);
    try {
      const job = await app.generate(scope(res),
        parse(tabularDtos.id, req.params.reviewId),
        parse(tabularDtos.generate, req.body ?? {}), signal);
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const send = (event: unknown) => {
        if (!signal.aborted && !res.writableEnded)
          res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      let terminal = false;
      const finish = () => {
        if (terminal || signal.aborted || res.writableEnded) return;
        terminal = true; res.write("data: [DONE]\n\n");
      };
      try { await job.run(send); }
      catch (error) {
        if (!signal.aborted) send({ type: "error",
          message: safeErrorMessage(error, "Stream error") });
      } finally {
        finish();
        if (!res.writableEnded) res.end();
      }
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else if (!res.writableEnded) res.end();
    }
  });

  return router;
}
