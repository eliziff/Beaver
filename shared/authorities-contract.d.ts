/** Shared Authorities data only; browser commands and reducer actions stay with their hosts. */
import type { AuthoritySourceDecision } from "./authorities-sources.mjs";
import type { PdfAnnotationSets } from "./pdf-annotations.mjs";

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
