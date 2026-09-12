import type { Request, Response } from "express";
import { ApplicationError } from "./applicationError";
import { asyncRoute } from "./asyncRoute";
import { requestAbortController, startSse, writeSse } from "./httpStreaming";
import type { ProposalProgress } from "./researchLabelDesign";

/** A proposal answers as JSON, or as a progress stream ending in the result when the modal asks for one. */
export const proposalRoute = <I>(parse: (body: unknown) => I,
  run: (req: Request, res: Response, input: I, signal: AbortSignal,
    progress: (event: ProposalProgress) => void) => Promise<unknown>) => asyncRoute(async (req, res) => {
  const input = parse(req.body ?? {}), { signal } = requestAbortController(req, res);
  if (req.accepts(["json", "text/event-stream"]) !== "text/event-stream")
    return res.json(await run(req, res, input, signal, () => {}));
  startSse(res);
  try { writeSse(res, { done: true, result: await run(req, res, input, signal, (event) => writeSse(res, event)) }); }
  catch (error) { if (!signal.aborted) writeSse(res, { error: error instanceof Error ? error.message : String(error),
    status: error instanceof ApplicationError ? error.status : 500 }); }
  res.end();
});
