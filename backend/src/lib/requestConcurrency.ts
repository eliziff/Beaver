import type { RequestHandler } from "express";

export function concurrentRequests(maximum: number, detail: string): RequestHandler {
  let active = 0;
  return (_req, res, next) => {
    if (active >= maximum) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ detail });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (!released) active -= 1;
      released = true;
    };
    res.once("finish", release).once("close", release);
    next();
  };
}
