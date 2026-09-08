import type {
  AuthoritiesOutputMode,
  AuthoritiesCover, AuthorityIdentity, AuthorityOccurrence, AuthoritiesDiscrepancyAction,
  AuthoritiesImport, AuthoritiesSettings, AuthoritiesReviewUnit,
} from "../../../../shared/authorities-contract.d.ts";
export type {
  AuthoritiesUserAction as AuthoritiesAction, AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId,
  AuthoritiesBookRole, AuthoritiesBuildSettings, AuthoritiesCover, AuthorityIdentity,
  AuthorityTextSpan, AuthorityOccurrence, AuthoritiesDiscrepancyAction,
} from "../../../../shared/authorities-contract.d.ts";

import type { AuthoritiesBookParts } from
  "../../../../shared/authorities-sources.mjs";
export type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritiesBoundPdf,
  AuthoritiesBookSupplement } from "../../../../shared/authorities-sources.mjs";
import type { WorkProduct, WorkProductInput } from "@/app/lib/workProducts";

export type AuthoritiesDraft = {
  schemaVersion: "beaver.authorities-draft.v1";
  import: AuthoritiesImport;
  bindings: Record<string, WorkProductInput>;
  outputMode: AuthoritiesOutputMode;
  settings: AuthoritiesSettings;
  cover: AuthoritiesCover;
  bookParts: AuthoritiesBookParts;
  insertIntoDocument: boolean;
  ledger: unknown | null;
  units: AuthoritiesReviewUnit[];
  occurrences: Record<string, AuthorityOccurrence>;
  authorities: Record<string, AuthorityIdentity>;
  authorityOrder: string[];
  stage?: "citations" | "sources" | "highlights" | "build";
  discrepancyDecisions: Record<string, AuthoritiesDiscrepancyAction>;
};

export type AuthoritiesProduct = WorkProduct<AuthoritiesDraft>;
export type AuthoritiesDiscrepancy = {
  id: string;
  actions: AuthoritiesDiscrepancyAction[];
  kind: "quote_mismatch" | "wrong_pinpoint" | "quote_unlocated";
  occurrenceId: string;
  authorityId: string;
  footnoteId: number;
  citation: string;
  proposition: string;
  authoredQuote: string;
  authoredPinpoint: { kind: "paragraph" | "section" | "page"; text: string };
  cited: { locator: { kind: "paragraph" | "section" | "page"; label: string }; text: string };
  found: { locator: { kind: "paragraph" | "section" | "page"; label: string };
    text: string } | null;
};

export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  outputs: Partial<Record<"table" | "book" | "annotated-document", {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
