import { z } from "zod";

/** A required field of user text: trimmed, non-empty, and bounded. */
export const textField = (max: number) => z.string().trim().min(1).max(max);
