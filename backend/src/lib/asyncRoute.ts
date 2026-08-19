import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApplicationError } from "./applicationError";
import { PageCursorError } from "./pagination";

export function asyncRoute(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch((error: unknown) => {
      if (res.headersSent) return next(error);
      if (error instanceof ZodError) {
        return void res.status(400).json({
          detail: error.issues[0]?.message ?? "Invalid request",
        });
      }
      if (error instanceof PageCursorError) {
        return void res.status(400).json({ detail: error.message });
      }
      if (error instanceof ApplicationError) {
        return void res.status(error.status).json({
          detail: error.message,
          ...error.details,
        });
      }
      next(error);
    });
  };
}
