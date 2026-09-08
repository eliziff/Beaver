import { z } from "zod";

const referenceText = (max: number) => z.string().trim().min(1).max(max);
export const legalSourceReferenceSchema = z.object({ provider: referenceText(100),
  family: referenceText(1_000).optional(), id: referenceText(500),
  part: referenceText(1_000).optional(), kind: z.enum(["case", "legislation", "journal", "hansard"]),
  title: referenceText(1_000).nullable().optional(), citation: referenceText(1_000).nullable().optional(),
  alternateCitation: referenceText(1_000).nullable().optional(), date: referenceText(1_000).nullable().optional(),
  collection: referenceText(1_000).nullable().optional(), language: z.enum(["en", "fr"]).optional(),
  url: z.string().url().max(4_000).nullable().optional() }).strict();
export type LegalSourceReference = z.infer<typeof legalSourceReferenceSchema>;
