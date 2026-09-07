import type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesProfileId, AuthoritiesBuildSettings,
  AuthoritiesCover, AuthorityIdentity, AuthorityOccurrence, AuthoritiesDiscrepancyAction,
  AuthoritiesImport, AuthoritiesSettings, AuthoritiesReviewUnit,
} from "../../../../shared/authorities-contract.d.ts";
export type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId,
  AuthoritiesBookRole, AuthoritiesBuildSettings, AuthoritiesCover, AuthorityIdentity,
  AuthorityTextSpan, AuthorityOccurrence, AuthoritiesDiscrepancyAction,
} from "../../../../shared/authorities-contract.d.ts";

import type { AuthoritiesBookParts } from
  "../../../../shared/authorities-sources.mjs";
export type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritiesBoundPdf,
  AuthoritiesBookSupplement } from "../../../../shared/authorities-sources.mjs";
import type { PdfAnnotationSet } from "../../../../shared/pdf-annotations.mjs";
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

export type AuthoritiesAction =
  | { type: "set-annotations"; entries: Array<{ authorityId: string; bindingRole: string; annotations: PdfAnnotationSet }> }
  | { type: "add-authority"; kind: AuthorityKind; citation: string; name?: string | null }
  | { type: "move-authority"; authorityId: string; toIndex: number }
  | { type: "set-stage"; stage: "citations" | "sources" | "highlights" | "build" }
  | { type: "remove-authority"; authorityId: string }
  | { type: "exclude-authority"; authorityId: string; excluded: boolean }
  | { type: "edit-authority"; authorityId: string; kind: AuthorityKind;
      citation: string; name: string | null }
  | { type: "rename-authority"; authorityId: string; displayName: string | null }
  | { type: "split-occurrence"; occurrenceId: string; cursor: number }
  | { type: "merge-occurrence"; occurrenceId: string }
  | { type: "remove-occurrence"; occurrenceId: string }
  | { type: "set-authority-span"; occurrenceId: string; start: number; end: number }
  | { type: "set-pinpoint-span"; occurrenceId: string; start: number; end: number }
  | { type: "relink-occurrence"; occurrenceId: string; authorityId: string | null }
  | { type: "set-reviewed"; occurrenceId: string; reviewed: boolean }
  | { type: "set-reference"; occurrenceId: string;
      reference: { kind: "supra" | "ibid"; targetAuthorityId: string } | null }
  | { type: "begin-canlii-handoff"; authorityId: string }
  | { type: "clear-authority-source"; authorityId: string }
  | { type: "clear-book-part"; slot: "cover" | "index" }
  | { type: "remove-book-supplement"; id: string }
  | { type: "set-cover"; cover: AuthoritiesCover }
  | { type: "set-profile"; profileId: AuthoritiesProfileId }
  | { type: "set-settings"; settings: Partial<AuthoritiesBuildSettings> }
  | { type: "set-output-mode"; outputMode: AuthoritiesOutputMode }
  | { type: "set-document-output"; enabled: boolean }
  | { type: "set-highlight-exclusion"; authorityId: string;
      locator: { kind: string; label: string }; excluded: boolean };

export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  outputs: Partial<Record<"table" | "book" | "annotated-document", {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
