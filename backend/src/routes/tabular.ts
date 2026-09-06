import { Router, type Request, type Response } from "express";
import { z, type ZodType } from "zod";
import { requireAuth } from "../middleware/auth";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { requestAbortController } from "../lib/httpStreaming";
import { tabularDtos, type TabularApplication } from "../lib/tabular/application";
import { downloadHeaders } from "../lib/storage";

const scope = applicationScope;
const parse = <T extends ZodType>(schema: T, value: unknown): z.output<T> =>
  schema.parse(value);
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
    parse(tabularDtos.prompt, req.body), requestAbortController(req, res).signal)));
  router.get("/:reviewId", json((req, res) => app.detail(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.get("/:reviewId/export", asyncRoute(async (req, res) => {
    const file = await app.export(scope(res), parse(tabularDtos.id, req.params.reviewId));
    res.set(downloadHeaders("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", file.filename));
    res.send(file.bytes);
  }));
  router.get("/:reviewId/people", json((req, res) => app.people(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.post("/:reviewId/workspace", json((req, res) => app.workspace(scope(res),
    parse(tabularDtos.id, req.params.reviewId))));
  router.get("/:reviewId/history", json((req, res) => app.history(scope(res),
    parse(tabularDtos.id, req.params.reviewId), parse(tabularDtos.history, req.query))));
  router.post("/:reviewId/changes", json((req, res) => app.change(scope(res),
    parse(tabularDtos.id, req.params.reviewId), parse(tabularDtos.change, req.body))));
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
      parse(tabularDtos.regenerate, req.body)), 202));
  router.post("/:reviewId/stop", json((req, res) =>
    app.stop(scope(res), parse(tabularDtos.id, req.params.reviewId))));

  router.post("/:reviewId/generate", json((req, res) => app.generate(scope(res),
      parse(tabularDtos.id, req.params.reviewId),
      parse(tabularDtos.generate, req.body ?? {})), 202));

  return router;
}
