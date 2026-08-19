import type { Response } from "express";

export type ApplicationScope = { userId: string; userEmail?: string };

export class ApplicationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, string | undefined>,
  ) { super(message); }
}

export const reject = (status: number, message: string): never => {
  throw new ApplicationError(status, message);
};

export const applicationScope = (res: Response): ApplicationScope => ({
  userId: res.locals.userId as string,
  userEmail: res.locals.userEmail as string | undefined,
});
