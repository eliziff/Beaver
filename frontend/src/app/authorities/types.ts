import type { WorkProduct, WorkProductInput } from "@/app/lib/workProducts";

export type AuthorityKind = "case" | "legislation" | "commentary" | "other";
export type AuthoritiesOutputMode = "table" | "book" | "both";
export type AuthoritiesSourceMode = "automatic" | "manual-originals" | "render";
export type AuthoritiesProfileId = string;
export type AuthoritiesBookRole = "applicant" | "respondent" | "joint" |
  "appellant" | "intervener" | "plaintiff" | "defendant" |
  "moving-party" | "responding-party";
export type AuthoritiesBuildSettings = {
  sourceMode: AuthoritiesSourceMode;
  tabStyle: "numeric" | "alpha";
  tableOrder: "first-reference" | "alphabetical";
  tableDelivery: "native-marks" | "native-append" | "linked-append";
  tableLocation: "pages" | "pinpoints" | "combined";
  passageMarking: "none" | "margin" | "paragraph" | "text" | "sidelined";
  scannedPdfPolicy: "page-margin" | "cited-pages" | "full";
  missingSourcePolicy: "placeholder" | "omit";
  filingMedium?: "electronic" | "paper";
  bookRole?: AuthoritiesBookRole;
};
export type AuthoritiesBoundPdf = {
  bindingRole: string;
  filename: string;
  sourceSha256: string;
};
export type AuthoritiesCover = {
  courtFileNumber: string;
  partyGroups: Array<{ role: string; parties: string[] }>;
  applicationUnder: string;
  title: string;
};
export type AuthoritiesBookSupplement = AuthoritiesBoundPdf & { id: string };
type AuthoritySourceIdentity = {
  provider: string;
  stableSourceId: string;
  sourceSha256: string;
  version: string | null;
  externalUrl: string | null;
};

export type AuthoritySourceLanguage = "en" | "fr" | "bilingual";
export type AttachedAuthoritySource = {
  bindingRole: string;
  filename: string;
  sourceSha256: string;
  sourceUrl: string | null;
  origin: "manual" | "original" | "reconstructed";
  language: AuthoritySourceLanguage;
};
type AuthoritySource =
  | { kind: "unresolved" }
  | { kind: "resolved" }
  | { kind: "attached"; sources: AttachedAuthoritySource[] }
  | { kind: "pending-canlii"; authorityKey: string; pageUrl: string; pdfUrl: string };

export type AuthorityIdentity = {
  id: string;
  key: string;
  kind: AuthorityKind;
  citation: string;
  name: string | null;
  displayName: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
  sourceIdentity: AuthoritySourceIdentity | null;
  excluded: boolean;
  source: AuthoritySource;
  userAdded?: true;
};

export type AuthorityOccurrence = {
  id: string;
  unitId: string;
  start: number;
  end: number;
  text: string;
  authoritySpan: AuthorityTextSpan;
  coreSpan: AuthorityTextSpan;
  pinpointSpan: AuthorityTextSpan | null;
  kind: AuthorityKind | "reference";
  citation: string;
  authorityId: string | null;
  reference: { kind: "supra" | "ibid"; targetAuthorityId: string } | null;
  pinpoints: Array<{ kind: "paragraph" | "section" | "page"; text: string }>;
  evidenceIds: string[];
  sourceTextSha256: string;
  localOrdinal: number;
  reviewed: boolean;
};

export type AuthorityTextSpan = { start: number; end: number; text: string };

export type AuthoritiesDraft = {
  schemaVersion: "beaver.authorities-draft.v1";
  import: { kind: "manual" } | { kind: "document"; bindingRole: "source";
    filename: string; fileType: "docx" | "pdf"; snapshot: {
      documentId: string; versionId: string; sha256: string;
    } | null };
  bindings: Record<string, WorkProductInput>;
  outputMode: AuthoritiesOutputMode;
  settings: AuthoritiesBuildSettings & { profileId: AuthoritiesProfileId };
  cover: AuthoritiesCover;
  bookParts: {
    cover: AuthoritiesBoundPdf | null;
    index: AuthoritiesBoundPdf | null;
    supplements: AuthoritiesBookSupplement[];
  };
  insertIntoDocument: boolean;
  ledger: unknown | null;
  units: Array<{ id: string; kind: "body" | "footnote"; ordinal: number;
    footnoteId: number | null; footnoteRefs: Array<[number, number]>;
    pageNumbers: number[]; text: string; occurrenceIds: string[] }>;
  occurrences: Record<string, AuthorityOccurrence>;
  authorities: Record<string, AuthorityIdentity>;
  authorityOrder: string[];
  discrepancyDecisions: Record<string, AuthoritiesDiscrepancyAction>;
};

export type AuthoritiesProduct = WorkProduct<AuthoritiesDraft>;
export type AuthoritiesDiscrepancyAction =
  "ignore" | "pinpoint" | "quote_exact" | "quote_editorial";
export type AuthoritiesDiscrepancy = {
  id: string;
  actions: AuthoritiesDiscrepancyAction[];
  kind: "quote_mismatch" | "wrong_pinpoint";
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
  | { type: "add-authority"; kind: AuthorityKind; citation: string; name?: string | null }
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
  | { type: "set-document-output"; enabled: boolean };

export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  outputs: Partial<Record<"table" | "book" | "annotated-document", {
    filename: string; mimeType: string; sha256: string; pageCount: number | null;
  }>>;
};
