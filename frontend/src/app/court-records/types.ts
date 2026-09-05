import type { FileSnapshot, WorkProductInput } from "@/app/lib/workProducts";
import type { CourtRecordWorkProductSlot } from "../../../../shared/court-record-work-products.mjs";

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

export type CoverIssueId = CoverFieldId | "partyStyleId" | "partyGroups" | "partyContacts" |
  "filingPartyIds";

export interface CoverField {
  id: CoverFieldId;
  label: string;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  partyStyleId?: string;
}

export interface CaseParty {
  id: string;
  name: string;
  contact?: PartyContact;
}

export type PartyContact = Partial<Record<"name" | "address" | "phone" | "fax" | "email", string>>;

export interface CasePartyGroup {
  id: string;
  role: string;
  roleBelow?: string;
  parties: CaseParty[];
}

export interface PartyStyle {
  id: string;
  label: string;
  groups: Array<Omit<CasePartyGroup, "parties"> & { optional?: boolean }>;
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

export const rule70MaximumPages = ({ rule70PageLimit }: Pick<DocumentKind,
  "rule70PageLimit">) => rule70PageLimit
  ? rule70PageLimit === "combined-cross-appeal" ? 60 : 30
  : undefined;

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

export interface CoverValues extends Partial<Record<CoverFieldId, string>> {
  partyStyleId?: string;
  partyGroups?: CasePartyGroup[];
  filingPartyIds?: string[];
}

export interface SourcePartyGroup {
  role: string;
  roleBelow?: string;
  parties: string[];
}

export interface SourceDocumentFields {
  cover: Partial<Pick<CoverValues,
    "courtName" | "courtFileNumber" | "lowerCourtFileNumber" | "registry" |
    "decisionMaker" | "decisionDate" | "decisionFileDate" | "affidavitNumber" |
    "deponent" | "swornDate" | "swornPlace" | "recordTitle" | "counselName" |
    "counselAddress" | "counselPhone" | "counselFax" | "counselEmail">>;
  partyStyleId?: string;
  partyGroups?: SourcePartyGroup[];
  exhibitLabels: string[];
  exhibitMentions?: Record<string, string[]>;
  explicitExhibitLabel?: string;
  entryTitle?: string;
  entryDate?: string;
}

export interface SourceExhibits {
  sourceSha256: string;
  labels: string[];
}

export function coverPartyGroups(profile: CourtProfile, cover: CoverValues): CasePartyGroup[] {
  const styles = profile.cover.partyStyles;
  if (!styles?.length) return cover.partyGroups ?? [];
  const style = styles.find((item) => item.id === cover.partyStyleId) ??
    (styles.length === 1 ? styles[0] : undefined);
  if (!style) return cover.partyGroups ?? [];
  return style.groups.flatMap((definition) => {
    const existing = cover.partyGroups?.find((group) => group.id === definition.id);
    if (definition.optional && !existing && definition.id !== profile.cover.filingGroupId) return [];
    return [{
      id: definition.id,
      role: definition.role,
      roleBelow: definition.roleBelow,
      parties: existing?.parties ?? [{ id: `${definition.id}-1`, name: "" }],
    }];
  });
}

export function partyNames(group: CasePartyGroup) {
  return group.parties.map((party) => party.name.trim()).filter(Boolean).join("\n");
}

export function filingParties(profile: CourtProfile, cover: CoverValues) {
  const groups = coverPartyGroups(profile, cover);
  const entered = groups
    .filter((group) => !profile.cover.filingGroupId || group.id === profile.cover.filingGroupId)
    .flatMap((group) => group.parties
      .filter((party) => party.name.trim())
      .map((party) => ({ party, group })));
  const selected = new Set(cover.filingPartyIds ?? []);
  const explicit = entered.filter(({ party }) => selected.has(party.id));
  if (Object.hasOwn(cover, "filingPartyIds")) return explicit;
  return entered.length === 1 || profile.cover.filingGroupId ? entered : [];
}

export const filingParty = (profile: CourtProfile, cover: CoverValues) =>
  filingParties(profile, cover)[0];

export const filingPartyNames = (profile: CourtProfile, cover: CoverValues) =>
  filingParties(profile, cover).map(({ party }) => party.name.trim()).filter(Boolean).join("\n");

export function ap5BookTitle(profile: CourtProfile, cover: CoverValues) {
  if (cover.recordTitle?.trim()) return cover.recordTitle.trim();
  const filers = filingParties(profile, cover).map(({ party, group }) =>
    `${party.name.trim()}, ${group.role}`);
  return `${profile.cover.title}${filers.length ? ` OF ${filers.join("; ")}` : ""}`;
}

export const captionPartyGroups = coverPartyGroups;

export function contactGroups(profile: CourtProfile, cover: CoverValues) {
  const groups = coverPartyGroups(profile, cover);
  const selected = filingParties(profile, cover), ids = new Set(selected.map(({ party }) => party.id));
  const filing = selected.length ? {
    id: "filing-parties",
    role: [...new Set(selected.map(({ group }) => group.role))].join(" / "),
    parties: selected.map(({ party }) => party),
  } : groups[0];
  const others = groups.map((group) => ({ ...group,
    parties: group.parties.filter((party) => !ids.has(party.id)) }))
    .filter((group) => group.parties.some((party) => party.name.trim()));
  return [filing, others] as const;
}

export const groupNames = (...groups: Array<CasePartyGroup | undefined>) => groups
  .filter((group): group is CasePartyGroup => !!group).map(partyNames).filter(Boolean).join("\n");

const ap5PartyRank = (group: CasePartyGroup) =>
  /^(plaintiff|applicant)$/iu.test(group.roleBelow ?? group.role) ? 0 :
    /^(defendant|respondent)$/iu.test(group.roleBelow ?? group.role) ? 1 : 2;

export const ap5PartyGroups = (profile: CourtProfile, cover: CoverValues) =>
  [...coverPartyGroups(profile, cover)].sort((left, right) =>
    ap5PartyRank(left) - ap5PartyRank(right));

export const ap5PartyLabel = (group: CasePartyGroup) =>
  ["PLAINTIFF/APPLICANT:", "DEFENDANT/RESPONDENT:", "INTERVENER:"][ap5PartyRank(group)];

export const exhibitIndex = (label = "") => /^[A-Z]+$/u.test(label.trim().toUpperCase())
  ? [...label.trim().toUpperCase()].reduce((value, character) =>
    value * 26 + character.charCodeAt(0) - 64, 0) - 1 : -1;

export function exhibitName(index: number) {
  let value = index + 1, label = "";
  while (value) { value -= 1; label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26); }
  return label;
}

export interface RecordEntry {
  id: string;
  kindId: string;
  file: File;
  pdfRendition?: File;
  title: string;
  date?: string;
  pageCount: number | null;
  searchable: boolean | null;
  encrypted: boolean | null;
  textlessPageCount?: number;
  textlessPages?: number[];
  ocrAttemptedPages?: number[];
  nonTextPagesConfirmed?: boolean;
  rule70CountedPages?: number;
  exhibitLabel?: string;
  sourceBookmarks?: SourceBookmark[];
  pageLabels?: string[] | null;
  sourceTitle?: string;
  sourceFields?: SourceDocumentFields;
  sourceExhibits?: SourceExhibits;
  ocrTextByPage?: string[];
  origin?: {
    kind: "device" | "library";
    documentId?: string;
    versionId?: string;
    sourceSha256?: string;
  };
  binding?: WorkProductInput;
  lastSeen?: FileSnapshot;
  inputStatus?: "ready" | "changed" | "stale" | "missing";
  missingReason?: "deleted" | "permission" | "unavailable";
  inspectionError?: string;
  descriptionOnly?: boolean;
}

export const propagatingSourceFields = (entry: Pick<RecordEntry, "kindId" | "sourceFields">) =>
  entry.sourceFields && !entry.sourceFields.explicitExhibitLabel &&
  !/(?:authority|exhibit)/u.test(entry.kindId) ? entry.sourceFields : undefined;

/** Returns the sequential exhibit slots bound to the currently loaded affidavit bytes. */
export function sourceExhibitSlots(entries: RecordEntry[]): SourceExhibits | undefined {
  const affidavit = entries.find((entry) => entry.kindId === "affidavit");
  if (!affidavit) return;
  const sourceSha256 = affidavit.origin?.sourceSha256 ??
    (affidavit.binding?.kind === "local-file" ? affidavit.binding.lastSeen.sha256 : undefined) ??
    affidavit.lastSeen?.sha256;
  if (!sourceSha256 || !/^[a-f0-9]{64}$/u.test(sourceSha256)) return;
  const fields = affidavit.sourceFields;
  const highest = Math.max(-1, ...[
    ...(fields?.exhibitLabels ?? []), ...Object.keys(fields?.exhibitMentions ?? {}),
  ].map(exhibitIndex));
  const savedCount = affidavit.sourceExhibits?.sourceSha256 === sourceSha256
    ? affidavit.sourceExhibits.labels.length : 0;
  return { sourceSha256, labels: Array.from({ length: Math.max(highest + 1, savedCount) },
    (_, index) => exhibitName(index)) };
}

export function hasMatchingExhibitCertificate(entry: RecordEntry) {
  const assigned = entry.exhibitLabel?.trim().toUpperCase();
  return !!assigned && entry.sourceFields?.explicitExhibitLabel?.trim().toUpperCase() === assigned;
}

export interface CourtRecordDraftEntry {
  id: string;
  kindId: string;
  title: string;
  date?: string;
  rule70CountedPages?: number;
  exhibitLabel?: string;
  sourceExhibits?: SourceExhibits;
  sourceFields?: SourceDocumentFields;
  descriptionOnly?: boolean;
  nonTextPagesConfirmed?: boolean;
  lastSeen: FileSnapshot;
}

export interface CourtRecordDraft {
  profileId: string;
  cover: CoverValues;
  entries: CourtRecordDraftEntry[];
  bindings: Record<string, WorkProductInput>;
}

export interface SourceBookmark {
  title: string;
  pageIndex: number;
  children: SourceBookmark[];
}

export interface ComplianceFinding {
  id: string;
  level: "blocker" | "review" | "pass";
  title: string;
  detail: string;
  entryId?: string;
  fieldId?: CoverIssueId;
}

export interface ComplianceReport {
  ready: boolean;
  blockers: ComplianceFinding[];
  review: ComplianceFinding[];
  passes: ComplianceFinding[];
  pageCount: number | null;
  inputBytes: number;
}

export interface BuildArtifact {
  role?: string;
  filename: string;
  mimeType: "application/pdf" |
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" |
    "text/markdown";
  bytes: Uint8Array;
  pageCount?: number;
  sha256: string;
}

export interface BuildReceiptSource {
  order: number;
  entryId: string;
  filename: string;
  title: string;
  kindId: string;
  sha256: string;
  mimeType: string;
  byteCount: number;
  pageCount: number | null;
  origin: NonNullable<RecordEntry["origin"]>;
  ocrAppliedPages: number[];
}

export interface CourtRecordReceipt {
  schema_version: "beaver.court-record-receipt.v2";
  created_at: string;
  profile: {
    id: string;
    sha256: string;
    jurisdiction: JurisdictionId;
    court_id: string;
    division: string | null;
    language: CourtLanguage;
    document_family: string;
    variant: string;
    label: string;
    effective: EffectivePeriod;
    source_ids: string[];
  };
  preparation_date: string;
  cover: CoverValues;
  sources: BuildReceiptSource[];
  outputs: Array<{
    role: string;
    filename: string;
    mime_type: string;
    byte_count: number;
    sha256: string;
    page_count: number | null;
  }>;
  automatic_steps: string[];
  needs_attention: Array<{ title: string; detail: string }>;
}

export interface BuildResult {
  artifacts: BuildArtifact[];
  receipt: CourtRecordReceipt;
}
