import { z } from "zod";
import { textField } from "../textField";

export const legalSourceReferenceSchema = z.object({ provider: textField(100),
  family: textField(1_000).optional(), id: textField(500),
  part: textField(1_000).optional(), kind: z.enum(["case", "legislation", "journal", "hansard"]),
  title: textField(1_000).nullable().optional(), citation: textField(1_000).nullable().optional(),
  alternateCitation: textField(1_000).nullable().optional(), date: textField(1_000).nullable().optional(),
  collection: textField(1_000).nullable().optional(), language: z.enum(["en", "fr"]).optional(),
  url: z.string().url().max(4_000).nullable().optional() }).strict();
export type LegalSourceReference = z.infer<typeof legalSourceReferenceSchema>;
