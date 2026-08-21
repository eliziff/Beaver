import type { Request, Response } from "express";

export function requestAbortController(req: Request, res: Response) {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  return controller;
}

export function startSse(res: Response) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
}

export function writeSse(res: Response, payload: unknown) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    (res as Response & { flush?: () => void }).flush?.();
  }
}
