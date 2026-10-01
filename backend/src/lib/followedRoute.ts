import type { Request, Response } from "express";
import { ApplicationError } from "./applicationError";
import { asyncRoute } from "./asyncRoute";

/** Asked for in `Accept`: the response is one JSON line per progress message, then a line
 *  naming the result's status and type, then the result exactly as it is otherwise sent. */
export const PROGRESS_STREAM = "application/x-beaver-progress";
export type Progress = (message: string) => void;

/** A long request the page can follow while it works. Without the progress type it is an
 *  ordinary route; with it, the same handler streams its progress ahead of its result. */
export function followedRoute(handler: (req: Request, res: Response, progress?: Progress) => Promise<unknown>) {
  return asyncRoute(async (req, res) => {
    if (req.get("accept") !== PROGRESS_STREAM) return handler(req, res);
    res.setHeader("Content-Type", PROGRESS_STREAM);
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
    let status = 200, type = "application/json", started = false;
    const start = () => {
      if (started) return;
      started = true;
      write(`${JSON.stringify({ result: { status, type } })}\n`);
    };
    // The result's status and type travel in its head line; the stream itself stays 200.
    Object.assign(res, {
      status: (code: number) => { status = code; return res; },
      setHeader: (name: string, value: unknown) => {
        if (name.toLowerCase() === "content-type") type = String(value);
        return res;
      },
      json: (value: unknown) => { type = "application/json"; start(); res.end(JSON.stringify(value)); return res; },
      write: (chunk: unknown, ...rest: unknown[]) => { start(); return write(chunk, ...rest); },
    });
    const progress: Progress = (message) => {
      if (!started && !res.writableEnded) write(`${JSON.stringify({ progress: message })}\n`);
    };
    try { await handler(req, res, progress); }
    catch (error) {
      // A result already under way is broken off, as an ordinary response is.
      if (started) throw error;
      const known = error instanceof ApplicationError;
      if (!known && !req.destroyed && !(res as { abandoned?: boolean }).abandoned) console.error(error);
      res.status(known ? error.status : 500).json(known
        ? { detail: error.message, ...error.details }
        : { detail: "Authorities could not complete that operation" });
    }
  });
}
