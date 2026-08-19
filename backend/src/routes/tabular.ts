import { Router, type Request, type Response } from "express";
import { z, type ZodType } from "zod";
import { requireAuth } from "../middleware/auth";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { tabularDtos, type TabularApplication } from "../lib/tabular/application";
import { safeErrorMessage } from "../lib/safeError";
import { buildContentDisposition } from "../lib/storage";

const scope = applicationScope;
const parse = <T extends ZodType>(schema: T, value: unknown): z.output<T> =>
  schema.parse(value);
const abortSignal = (req: Request, res: Response) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  return controller.signal;
};
const json = (
  operation: (req: Request, res: Response) => Promise<unknown>,
  status = 200,
) => asyncRoute(async (req, res) => {
  res.status(status).json(await operation(req, res));
});

export function createTabularRouter(app: TabularApplication) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", json((req, res) => app.list(scope(res),
    parse(tabularDtos.list, req.query))));
  router.post("/", json((req, res) => app.create(scope(res),
    parse(tabularDtos.create, req.body)), 201));
  router.post("/prompt", json((req, res) => app.prompt(scope(res),
    parse(tabularDtos.prompt, req.body), abortSignal(req, res))));
  router.get("/:reviewId", json((req, res) => app.detail(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.get("/:reviewId/export", asyncRoute(async (req, res) => {
    const file = await app.export(scope(res), parse(tabularDtos.id, req.params.reviewId));
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": buildContentDisposition("attachment", file.filename),
    });
    res.send(file.bytes);
  }));
  router.get("/:reviewId/people", json((req, res) => app.people(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.patch("/:reviewId", json((req, res) => app.update(scope(res),
    parse(tabularDtos.id, req.params.reviewId), parse(tabularDtos.update, req.body))));
  router.delete("/:reviewId", asyncRoute(async (req, res) => {
    await app.remove(scope(res), parse(tabularDtos.id, req.params.reviewId));
    res.status(204).send();
  }));
  router.post("/:reviewId/clear-cells", asyncRoute(async (req, res) => {
    await app.clear(scope(res), parse(tabularDtos.id, req.params.reviewId),
      parse(tabularDtos.clear, req.body));
    res.status(204).send();
  }));
  router.post("/:reviewId/regenerate-cell", json((req, res) =>
    app.regenerate(scope(res), parse(tabularDtos.id, req.params.reviewId),
      parse(tabularDtos.regenerate, req.body), abortSignal(req, res))));

  router.post("/:reviewId/generate", asyncRoute(async (req, res) => {
    const signal = abortSignal(req, res);
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
    try { await job.run(send); }
    catch (error) {
      if (!signal.aborted) send({ type: "error",
        message: safeErrorMessage(error, "Stream error") });
    } finally {
      if (!signal.aborted && !res.writableEnded) res.write("data: [DONE]\n\n");
      if (!res.writableEnded) res.end();
    }
  }));

  return router;
}
