/** Shared Authorities state and public commands; resolved reducer actions remain server-side. */
import type { AuthoritiesBookParts, AuthoritySourceDecision } from "./authorities-sources.mjs";
import type { PdfAnnotationSet, PdfAnnotationSets } from "./pdf-annotations.mjs";
import type { WorkProductBuildReceipt, WorkProductInput,
  WorkProductState } from "./work-products.mjs";

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
  /** Import provenance: detected while scanning, never entered by hand. */
  scanOnly?: true;
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

/** Filing defaults for one court; the values live in ./authorities-profiles.json. */
export type AuthoritiesProfile = {
  id: AuthoritiesProfileId;
  label: string;
  courtId: string;
  bookTitle?: string;
  sourceIds?: string[];
  defaults: { outputMode: AuthoritiesOutputMode; settings: AuthoritiesBuildSettings };
  locked?: { outputMode?: AuthoritiesOutputMode;
    settings?: Partial<AuthoritiesBuildSettings> };
  options?: {
    filingMedium?: Array<{ value: "electronic" | "paper"; label: string }>;
    bookRole?: Array<{ value: AuthoritiesBookRole; label: string }>;
    missingSourcePolicy?: boolean;
  };
  requirements?: { completeBookSources?: boolean; documentOutputDefault?: boolean;
    unlinkedPdfTableSources?: boolean; markedPassages?: boolean;
    federalFormatting?: boolean; appealPaperCovers?: boolean; bilingualEnactments?: boolean;
    electronicVolumes?: { maxPages: number; maxBytes: number;
      completeToc: boolean; coverLabels: boolean } };
};

export type AuthoritySeed = AuthoritySourceIdentity & {
  key: string;
  kind: AuthorityKind;
  citation: string;
  name: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
};

export type AuthoritiesLedgerOccurrence = {
  id: string;
  markerId: string;
  targetId: string;
  authorityKey: string;
  unit: Omit<AuthoritiesReviewUnit, "occurrenceIds"> & { sourceTextSha256: string };
  start: number;
  end: number;
  text: string;
  displayedForm: "full" | "short" | "supra" | "ibid";
  pinpoints: Array<{ kind: "paragraph" | "section" | "page"; text: string }>;
  evidenceIds: string[];
  localOrdinal: number;
};

export type AuthorityCitationLedger = {
  schemaVersion: "beaver.authority-ledger.v1";
  document: AuthoritiesDocumentSnapshot;
  seeds: AuthoritySeed[];
  occurrences: AuthoritiesLedgerOccurrence[];
};

export type AuthoritiesDraft = WorkProductState & {
  schemaVersion: "beaver.authorities-draft.v1";
  import: AuthoritiesImport;
  bindings: Record<string, WorkProductInput>;
  outputMode: AuthoritiesOutputMode;
  settings: AuthoritiesSettings;
  cover: AuthoritiesCover;
  bookParts: AuthoritiesBookParts;
  insertIntoDocument: boolean;
  ledger: AuthorityCitationLedger | null;
  units: AuthoritiesReviewUnit[];
  occurrences: Record<string, AuthorityOccurrence>;
  authorities: Record<string, AuthorityIdentity>;
  authorityOrder: string[];
  stage?: "citations" | "sources" | "highlights" | "build";
  discrepancyDecisions: Record<string, AuthoritiesDiscrepancyAction>;
};

export type AuthoritiesSourcePassage = {
  locator: { kind: "paragraph" | "section" | "page"; label: string };
  text: string;
};

/** `Evidence` is the server's retrieved passage behind `cited`; browsers never receive one. */
export type AuthoritiesDiscrepancy<Evidence = never> = {
  id: string;
  actions: AuthoritiesDiscrepancyAction[];
  occurrenceId: string;
  authorityId: string;
  footnoteId: number;
  citation: string;
  proposition: string;
  authoredQuote: string;
  authoredPinpoint: AuthorityOccurrence["pinpoints"][number];
  cited: AuthoritiesSourcePassage;
  citedPassage?: Evidence;
} & (
  | { kind: "quote_mismatch"; found: AuthoritiesSourcePassage | null }
  | { kind: "wrong_pinpoint"; found: AuthoritiesSourcePassage }
  | { kind: "quote_unlocated"; found: null }
);

/** One book PDF per volume, so a split book numbers its parts after the first. */
export type AuthoritiesOutputRole = "table" | "book" | `book-${number}` |
  "annotated-document";
export type AuthoritiesOutputFile = {
  filename: string; mimeType: string; sha256: string; pageCount: number | null;
};

export type AuthoritiesBuildReceipt = {
  schemaVersion: "beaver.authorities-build.v1";
  builtAt: string;
  workProduct: { id: string; kind: "authorities"; revision: number };
  inputs: WorkProductBuildReceipt["inputs"];
  draft: { schemaVersion: AuthoritiesDraft["schemaVersion"];
    outputMode: AuthoritiesOutputMode;
    settings: AuthoritiesSettings;
    cover: AuthoritiesCover;
    bookParts: AuthoritiesBookParts;
    insertIntoDocument: boolean;
    document: AuthoritiesDocumentSnapshot | null };
  authorities: Array<{
    id: string; key: string; kind: AuthorityKind; citation: string; name: string;
    tab: string; excluded: boolean; source: AuthoritySourceDecision;
    sourceIdentity: AuthoritySourceIdentity | null;
    evidenceIds: string[]; locators: Array<{ kind: string; label: string }>;
    bindings: WorkProductInput[];
  }>;
  outputs: Partial<Record<AuthoritiesOutputRole, AuthoritiesOutputFile>>;
};
