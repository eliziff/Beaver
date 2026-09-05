import { sourceDocumentFields as extractSourceFields } from
  "../../../../shared/court-record-source-fields.mjs";
import type { SourceDocumentFields } from "./types";

export const sourceDocumentFields = (pages: string[]): SourceDocumentFields | undefined =>
  extractSourceFields(pages) as SourceDocumentFields | undefined;
