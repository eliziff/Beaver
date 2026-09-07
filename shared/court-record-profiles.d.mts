import type { CourtRecordWorkProductSlot } from "./court-record-work-products.mjs";

export type JurisdictionId = string;
export type CourtLanguage = "en" | "fr";

export type RecordFamily =
  | "affidavit"
  | "application"
  | "motion"
  | "appeal"
  | "extracts"
  | "hearing-record"
  | "filing-set";

export type OutputMode =
  | "affidavit-with-exhibits"
  | "combined-record"
  | "separate-files";

export type Requirement = "required" | "optional" | "conditional" | "forbidden";

export type CourtSourceFormat = "pdf" | "docx";

export type CoverFieldId =
  | "courtName"
  | "courtFileNumber"
  | "lowerCourtFileNumber"
  | "registry"
  | "recordTitle"
  | "recordSubtitle"
  | "applicationUnder"
  | "hearingDate"
  | "counselName"
  | "counselAddress"
  | "counselPhone"
  | "counselFax"
  | "counselEmail"
  | "otherCounselName"
  | "otherCounselAddress"
  | "otherCounselPhone"
  | "otherCounselFax"
  | "otherCounselEmail"
  | "decisionMaker"
  | "decisionDate"
  | "decisionFileDate"
  | "affidavitNumber"
  | "deponent"
  | "swornDate"
  | "swornPlace";

export interface CoverField {
  id: CoverFieldId;
  label: string;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  partyStyleId?: string;
}

export interface PartyStyle {
  id: string;
  label: string;
  groups: Array<{ id: string; role: string; roleBelow?: string; optional?: boolean }>;
}

export interface CoverDefinition {
  generated: boolean;
  title: string;
  template?: "abca-ap5" | "federal-record";
  form?: string;
  ruleReference?: string;
  colourName: string;
  colourHex: string;
  textColourHex?: string;
  fields: CoverField[];
  partyStyles?: PartyStyle[];
  filingGroupId?: string;
}

export interface DocumentKind extends CourtRecordWorkProductSlot {
  id: string;
  label: string;
  requirement: Requirement;
  order: number;
  repeatable?: boolean;
  group?: string;
  condition?: string;
  maximumPages?: number;
  rule70PageLimit?: "standard" | "combined-cross-appeal";
  acceptedFormats?: CourtSourceFormat[];
  generated?: "federal-form-344-certificate";
  appendTo?: string;
  descriptionOnly?: boolean;
  renderDescriptionPage?: boolean;
  defaultDescription?: string;
  allowUnavailableNote?: boolean;
  separateFile?: boolean;
  chronological?: boolean;
  preserveFilename?: boolean;
  pageLabelScheme?: "abca-transcript";
}

export interface TechnicalRequirements {
  pdfOnly: boolean;
  searchable: boolean;
  noSecurity: boolean;
  continuousPageNumbers: boolean;
  pageNumberPosition: "top-centre" | "top-right" | "bottom-centre" | "bottom-right";
  pageNumberInset?: number;
  pageNumberOffset?: number;
  pageOne: "cover" | "first-content";
  pdfPageLabelsMatch: boolean;
  bookmarks: "documents" | "tabs-and-documents" | "exhibits";
  bookmarksPanelOpen: boolean;
  hyperlinkedIndex: boolean;
  indexStyle?: "standard" | "federal" | "abca";
  indexTitle?: string;
  indexDocumentLabel?: string;
  indexRowsPerPage?: number;
  indexDate?: "required" | "none";
  pageNumberSize?: number;
  maxOutputBytes?: number;
  maxOutputPages?: number;
  volumeInstructions?: string;
  completeIndexEachVolume?: boolean;
  volumeLabelOnBackCover?: boolean;
  separateSourceFiles?: boolean;
}

export interface EffectivePeriod {
  from: string;
  to?: string;
}

export interface CourtProfile {
  id: string;
  selectable: boolean;
  jurisdiction: JurisdictionId;
  courtId: string;
  court: string;
  courtAbbreviation: string;
  division?: string;
  language: CourtLanguage;
  documentFamily: string;
  documentLabel: string;
  variant: string;
  label: string;
  shortLabel: string;
  family: RecordFamily;
  outputMode: OutputMode;
  exhibitCertificate?: boolean;
  role?: string;
  effective: EffectivePeriod;
  cover: CoverDefinition;
  documentKinds: DocumentKind[];
  oneOf?: Array<{ slots: string[]; label: string }>;
  technical: TechnicalRequirements;
  minimumDocuments?: number;
  sourceIds: string[];
  filenamePattern: string;
}

type ProfileRow = Omit<CourtProfile,
  "selectable" | "jurisdiction" | "court" | "courtAbbreviation" | "language" |
  "effective" | "cover" | "documentKinds" | "technical"> & {
  selectable?: boolean;
  effectiveFrom: string;
  partyStyleIds?: string[];
  filingGroupId?: string;
  cover: Omit<CoverDefinition, "fields" | "partyStyles" | "filingGroupId"> & {
    fieldKeys: string[];
  };
  slots: Array<DocumentKind | string>;
  technical: string;
};
export type CourtRecordCatalogue = {
  slotDefinitions: Record<string, DocumentKind>;
  partyStyles: PartyStyle[];
  coverFieldDefinitions: Record<string, CoverField>;
  technicalDefinitions: Record<string, TechnicalRequirements>;
  profiles: ProfileRow[];
};

type RegisteredCourt = { id: string; jurisdictionId: string; label: string;
  abbreviation: string; language: "en" | "fr" };

/** Expand and validate trusted built-in catalogue references, not user draft state. */
export function compileCourtRecordProfiles(catalogue: CourtRecordCatalogue,
  courts: readonly RegisteredCourt[]): CourtProfile[];
export const COURT_PROFILES: CourtProfile[];
export const COURT_PROFILE_BY_ID: Map<string, CourtProfile>;
export const COURT_RECORD_COVER_FIELD_IDS: string[];
