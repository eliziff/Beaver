import type { NextFunction, Request, Response } from "express";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireTrustedOrigin(expectedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
  if (SAFE.has(req.method)) return void next();
  const origin = req.get("origin");
  try {
    if (!origin || new URL(origin).origin !== expectedOrigin) throw new Error();
    next();
  } catch {
    res.status(403).json({
      code: "untrusted_origin",
      detail: "The request origin is not allowed.",
    });
  }
  };
}
