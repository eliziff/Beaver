/** Shared Authorities state and public commands; resolved reducer actions remain server-side. */
import type { AuthoritySourceDecision } from "./authorities-sources.mjs";
import type { PdfAnnotationSet, PdfAnnotationSets } from "./pdf-annotations.mjs";

export type AuthorityKind = "case" | "legislation" | "commentary" | "other";

export type AuthoritiesOutputMode = "table" | "book" | "both";

export type AuthoritiesSourceMode = "automatic" | "manual-originals" | "render";

export type AuthoritiesProfileId = string;

export type AuthoritiesBookRole = "applicant" | "respondent" | "joint" |
  "appellant" | "intervener" | "plaintiff" | "defendant" |
  "moving-party" | "responding-party";

export type AuthoritiesBuildSettings = {
  sourceMode: AuthoritiesSourceMode;
  tabStyle: "numeric" | "alpha" | "lower-alpha" | "roman" | "lower-roman";
  tabStart?: number;
  tabPrefix?: string;
  tabLabels?: string[];
  /** Explicit draft export only; never a representation of filing completeness. */
  allowIncomplete?: boolean;
  tableOrder: "first-reference" | "alphabetical";
  tableDelivery: "native-marks" | "native-append" | "linked-append";
  tableLocation: "pages" | "pinpoints" | "combined";
  passageMarking: "none" | "margin" | "paragraph" | "text" | "sidelined";
  scannedPdfPolicy: "page-margin" | "cited-pages" | "full";
  missingSourcePolicy: "placeholder" | "omit";
  filingMedium?: "electronic" | "paper";
  bookRole?: AuthoritiesBookRole;
};

export type AuthoritiesSettings = AuthoritiesBuildSettings & {
  profileId: AuthoritiesProfileId;
};

export type AuthoritiesDocumentSnapshot = {
  documentId: string;
  versionId: string;
  sha256: string;
};

export type AuthoritiesImport =
  | { kind: "manual" }
  | { kind: "document"; bindingRole: "source"; filename: string;
      fileType: "docx" | "pdf"; snapshot: AuthoritiesDocumentSnapshot | null };

export type AuthoritiesCover = {
  courtFileNumber: string;
  partyGroups: Array<{ role: string; parties: string[] }>;
  applicationUnder: string;
  title: string;
};

export type AuthoritySourceIdentity = {
  provider: string;
  stableSourceId: string;
  sourceSha256: string;
  version: string | null;
  externalUrl: string | null;
};

export type AuthorityHighlightExclusion = { kind: string; label: string };

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
  source: AuthoritySourceDecision;
  highlightExclusions?: AuthorityHighlightExclusion[];
  annotations?: PdfAnnotationSets;
  userAdded?: true;
};

export type AuthoritiesReviewUnit = {
  id: string;
  kind: "body" | "footnote";
  ordinal: number;
  footnoteId: number | null;
  footnoteRefs: Array<[number, number]>;
  pageNumbers: number[];
  text: string;
  occurrenceIds: string[];
};

export type AuthorityTextSpan = { start: number; end: number; text: string };

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

export type AuthoritiesDiscrepancyAction =
  "ignore" | "pinpoint" | "quote_exact" | "quote_editorial";

export type AuthoritiesUserAction =
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
  | { type: "clear-pinpoint"; occurrenceId: string }
  | { type: "add-occurrence"; unitId: string; start: number; end: number }
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
