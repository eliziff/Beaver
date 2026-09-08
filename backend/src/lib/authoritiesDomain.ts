import type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId, AuthoritiesBookRole,
  AuthoritiesBuildSettings, AuthoritiesSettings, AuthoritiesDocumentSnapshot, AuthoritiesImport,
  AuthoritiesCover, AuthoritySourceIdentity, AuthorityHighlightExclusion,
  AuthorityIdentity as SharedAuthorityIdentity, AuthoritiesReviewUnit, AuthorityTextSpan,
  AuthorityOccurrence, AuthoritiesDiscrepancyAction,
} from "mike/shared/authorities-contract.d.ts";
export type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId, AuthoritiesBookRole,
  AuthoritiesBuildSettings, AuthoritiesSettings, AuthoritiesDocumentSnapshot, AuthoritiesImport,
  AuthoritiesCover, AuthoritySourceIdentity, AuthorityHighlightExclusion,
  AuthoritiesReviewUnit, AuthorityTextSpan, AuthorityOccurrence, AuthoritiesDiscrepancyAction,
};

// Import provenance is reducer-private; it is not part of the browser contract.
export type AuthorityIdentity = SharedAuthorityIdentity & { scanOnly?: true };

import { attachAuthoritySource, attachedAuthoritySources,
  authoritiesBookPdfs, removeUnusedBinding, replaceSource } from "mike/shared/authorities-sources.mjs";
import type { AuthoritySourceLanguage,
  AuthoritiesBoundPdf, AuthoritiesBookSupplement, AuthoritiesBookParts } from "mike/shared/authorities-sources.mjs";
export { attachedAuthoritySources, hasBilingualAuthoritySource, authoritiesBookPdfs } from
  "mike/shared/authorities-sources.mjs";
export type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritySourceDecision,
  AuthoritiesBoundPdf, AuthoritiesBookSupplement, AuthoritiesBookParts } from "mike/shared/authorities-sources.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { buildCanliiPdfUrl } from "./canliiUrls";
import { sha256 } from "./hash";
import { decodeWorkProductBindings, type WorkProductInput,
  type WorkProductState } from "./workProduct";
import profileValues from "mike/shared/authorities-profiles.json";

export const AUTHORITIES_BOOK_ROLES = ["applicant", "respondent", "joint", "appellant",
  "intervener", "plaintiff", "defendant", "moving-party", "responding-party"] as const;
type AuthoritiesProfile = {
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

/** Filing defaults only; source receipts remain in the repository audit data. */
const authoritiesProfiles = profileValues as AuthoritiesProfile[];
const AUTHORITIES_PROFILES = new Map(authoritiesProfiles.map((profile) => [profile.id, profile]));
export const authoritiesProfileIds = authoritiesProfiles.map(({ id }) => id);
export function authoritiesProfile(id: AuthoritiesProfileId) {
  const profile = AUTHORITIES_PROFILES.get(id);
  if (!profile) throw new AuthoritiesDomainError(`Unknown Authorities profile: ${id}`);
  return profile;
}

export const federalEnactmentCitation = (citation: string) =>
  /\b(?:R\.?S\.?C\.?|S\.?C\.?|C\.?R\.?C\.?|SOR|SI|DORS|TR)\b/iu.test(citation);

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

import { decodeAnnotationSet, type PdfAnnotationSet } from "mike/shared/pdf-annotations.mjs";

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

export type AuthoritiesFreshReview = Pick<AuthoritiesDraft,
  "import" | "bindings" | "units" | "occurrences" | "authorities" | "authorityOrder"> &
  { cover?: AuthoritiesCover };

export type AuthoritiesAction =
  | { type: "set-annotations"; entries: Array<{ authorityId: string; bindingRole: string; annotations: PdfAnnotationSet }> }
  | { type: "ingest-ledger"; ledger: AuthorityCitationLedger }
  | { type: "add-seed"; seed: AuthoritySeed }
  | { type: "add-authority"; authority: AuthorityIdentity }
  | { type: "move-authority"; authorityId: string; toIndex: number }
  | { type: "set-stage"; stage: "citations" | "sources" | "highlights" | "build" }
  | { type: "remove-authority"; authorityId: string }
  | { type: "exclude-authority"; authorityId: string; excluded: boolean }
  | { type: "set-highlight-exclusion"; authorityId: string;
      locator: { kind: string; label: string }; excluded: boolean }
  | { type: "edit-authority"; authorityId: string; kind: AuthorityKind;
      citation: string; name: string | null }
  | { type: "rename-authority"; authorityId: string; displayName: string | null }
  | { type: "split-occurrence"; occurrenceId: string;
      replacements: [AuthorityOccurrence, AuthorityOccurrence] }
  | { type: "merge-occurrences"; occurrenceIds: [string, string];
      replacement: AuthorityOccurrence }
  | { type: "replace-occurrence"; occurrenceId: string;
      replacement: AuthorityOccurrence;
      absorbed?: { ids: string[]; start: number; end: number } }
  | { type: "remove-occurrence"; occurrenceId: string }
  | { type: "relink-occurrence"; occurrenceId: string; authorityId: string | null }
  | { type: "set-reviewed"; occurrenceId: string; reviewed: boolean }
  | { type: "set-reference"; occurrenceId: string;
      reference: AuthorityOccurrence["reference"] }
  | { type: "resolve-authority"; authorityId: string; citation: string;
      name: string | null; source: AuthoritySourceIdentity }
  | { type: "attach-source"; authorityId: string; bindingRole: string;
      binding: WorkProductInput; filename: string; sourceSha256: string;
      sourceUrl: string | null; language: AuthoritySourceLanguage;
      origin?: "manual" | "original" | "reconstructed" }
  | { type: "clear-authority-source"; authorityId: string }
  | { type: "begin-canlii-handoff"; authorityId: string; pageUrl: string }
  | { type: "set-book-part"; slot: "cover" | "index"; pdf: AuthoritiesBoundPdf;
      binding: WorkProductInput }
  | { type: "clear-book-part"; slot: "cover" | "index" }
  | { type: "set-book-supplement"; supplement: AuthoritiesBookSupplement;
      binding: WorkProductInput }
  | { type: "remove-book-supplement"; id: string }
  | { type: "set-cover"; cover: AuthoritiesCover }
  | { type: "set-profile"; profileId: AuthoritiesProfileId }
  | { type: "set-settings"; settings: Partial<AuthoritiesBuildSettings> }
  | { type: "set-output-mode"; outputMode: AuthoritiesOutputMode }
  | { type: "set-document-output"; enabled: boolean }
  | { type: "resolve-discrepancy"; id: string; action: AuthoritiesDiscrepancyAction }
  | { type: "refresh"; review: AuthoritiesFreshReview };

export class AuthoritiesDomainError extends Error {}

export function createAuthoritiesDraft(
  source: AuthoritiesImport,
  bindings: Record<string, WorkProductInput> = {},
  outputMode: AuthoritiesOutputMode = "book",
): AuthoritiesDraft {
  const profile = authoritiesProfile("general");
  const draft: AuthoritiesDraft = { schemaVersion: "beaver.authorities-draft.v1",
    stage: source.kind === "manual" ? "sources" : "citations",
    import: source, bindings: structuredClone(bindings), outputMode,
    settings: { profileId: "general", ...structuredClone(profile.defaults.settings) },
    cover: { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" },
    bookParts: { cover: null, index: null, supplements: [] },
    insertIntoDocument: false, ledger: null,
    units: [], occurrences: {}, authorities: {}, authorityOrder: [],
    discrepancyDecisions: {} };
  const errors = validateAuthoritiesDraft(draft);
  if (errors.length) throw new AuthoritiesDomainError(errors[0]);
  return draft;
}

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const exactSourceHash = (value: string) => /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
const sameSnapshot = (left: AuthoritiesDocumentSnapshot, right: AuthoritiesDocumentSnapshot) =>
  left.documentId === right.documentId && left.versionId === right.versionId &&
  left.sha256 === right.sha256;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const nonempty = (value: unknown, max = 4_000) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const trimmed = (value: unknown, max = 500) => typeof value === "string" &&
  value.length > 0 && value.length <= max && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const closed = (value: unknown, keys: string[]) => {
  const item = object(value);
  return item && exactKeys(item, keys) ? item : null;
};
const text = (value: unknown) => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const integer = (value: unknown) => Number.isSafeInteger(value);
const list = (value: unknown, valid: (item: unknown) => boolean, limit = 50_000) =>
  Array.isArray(value) && value.length <= limit && Array.from(value).every(valid);
const strings = (value: unknown) => list(value, text);
const pair = (value: unknown) => Array.isArray(value) && value.length === 2 &&
  Array.from(value).every(integer);
const oneOf = (value: unknown, choices: readonly string[]) =>
  typeof value === "string" && choices.includes(value);
const authoritySpan = (value: unknown) => {
  const item = closed(value, ["start", "end", "text"]);
  return !!item && integer(item.start) && integer(item.end) && text(item.text);
};
const buildSettings = (value: unknown) => {
  const keys = ["sourceMode", "tabStyle", "tableOrder", "tableDelivery", "tableLocation",
    "passageMarking", "scannedPdfPolicy", "missingSourcePolicy"];
  const item = object(value);
  if (!item || !exactKeys(item, ["profileId", ...keys], ["filingMedium", "bookRole", "tabStart", "tabPrefix", "tabLabels", "allowIncomplete"])) {
    return false;
  }
  const profile = typeof item.profileId === "string"
    ? AUTHORITIES_PROFILES.get(item.profileId) : undefined;
  const filingMedia = profile?.options?.filingMedium?.map(({ value }) => value);
  const bookRoles = profile?.options?.bookRole?.map(({ value }) => value);
  const context = filingMedia
    ? oneOf(item.filingMedium, filingMedia) : !Object.hasOwn(item, "filingMedium");
  const roleContext = bookRoles
    ? profile?.id === "federal-court" && !Object.hasOwn(item, "bookRole") ||
      oneOf(item.bookRole, bookRoles)
    : !Object.hasOwn(item, "bookRole");
  return !!profile && context && roleContext &&
    oneOf(item.sourceMode, ["automatic", "manual-originals", "render"]) &&
    oneOf(item.tabStyle, ["numeric", "alpha", "lower-alpha", "roman", "lower-roman"]) &&
    (item.tabStart === undefined || integer(item.tabStart) && Number(item.tabStart) >= 1 && Number(item.tabStart) <= 10_000) &&
    (item.tabPrefix === undefined || typeof item.tabPrefix === "string" && item.tabPrefix.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(item.tabPrefix)) &&
    (item.tabLabels === undefined || list(item.tabLabels, (label) => typeof label === "string" && label.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(label), 10_000)) &&
    (item.allowIncomplete === undefined || typeof item.allowIncomplete === "boolean") &&
    oneOf(item.tableOrder, ["first-reference", "alphabetical"]) &&
    oneOf(item.tableDelivery, ["native-marks", "native-append", "linked-append"]) &&
    oneOf(item.tableLocation, ["pages", "pinpoints", "combined"]) &&
    oneOf(item.passageMarking, ["none", "margin", "paragraph", "text", "sidelined"]) &&
    !(profile.requirements?.markedPassages && item.passageMarking === "none") &&
    oneOf(item.scannedPdfPolicy, ["page-margin", "cited-pages", "full"]) &&
    oneOf(item.missingSourcePolicy, ["placeholder", "omit"]);
};
const boundPdf = (value: unknown) => {
  const item = closed(value, ["bindingRole", "filename", "sourceSha256"]);
  return !!item && trimmed(item.bindingRole, 200) && trimmed(item.filename) &&
    typeof item.sourceSha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sourceSha256);
};
const bookSupplement = (value: unknown) => {
  const item = object(value);
  return !!item && exactKeys(item, ["id", "bindingRole", "filename", "sourceSha256"]) &&
    trimmed(item.id, 200) && boundPdf({ bindingRole: item.bindingRole,
      filename: item.filename, sourceSha256: item.sourceSha256 });
};
const bookParts = (value: unknown) => {
  const item = closed(value, ["cover", "index", "supplements"]);
  return !!item && (item.cover === null || boundPdf(item.cover)) &&
    (item.index === null || boundPdf(item.index)) && list(item.supplements, bookSupplement, 500);
};
const authoritiesCover = (value: unknown) => {
  const item = closed(value, ["courtFileNumber", "partyGroups", "applicationUnder", "title"]);
  const plain = (field: unknown, max: number) => typeof field === "string" &&
    field.length <= max && field.trim() === field && !/[\u0000-\u001f\u007f]/u.test(field);
  return !!item && plain(item.courtFileNumber, 100) && plain(item.applicationUnder, 2_000) &&
    plain(item.title, 500) && list(item.partyGroups, (value) => {
      const group = closed(value, ["role", "parties"]);
      return !!group && plain(group.role, 100) && list(group.parties,
        (party) => plain(party, 500), 50);
    }, 50);
};
const authorityKind = (value: unknown) => oneOf(value,
  ["case", "legislation", "commentary", "other"]);
const pinpoint = (value: unknown) => {
  const item = closed(value, ["kind", "text"]);
  return !!item && oneOf(item.kind, ["paragraph", "section", "page"]) &&
    text(item.text);
};
const locator = (value: unknown) => {
  const item = closed(value, ["kind", "label"]);
  return !!item && text(item.kind) && text(item.label);
};
const snapshot = (value: unknown) => {
  const item = closed(value, ["documentId", "versionId", "sha256"]);
  return !!item && nonempty(item.documentId, 200) && nonempty(item.versionId, 200) &&
    typeof item.sha256 === "string" && exactSourceHash(item.sha256);
};
const importedDocument = (value: unknown) => {
  const item = object(value);
  if (!item) return false;
  if (item.kind === "manual") return exactKeys(item, ["kind"]);
  return exactKeys(item, ["kind", "bindingRole", "filename", "fileType", "snapshot"]) &&
    item.kind === "document" && item.bindingRole === "source" &&
    nonempty(item.filename, 500) && oneOf(item.fileType, ["docx", "pdf"]) &&
    (item.snapshot === null || snapshot(item.snapshot));
};
const sourceIdentity = (value: unknown) => {
  const item = closed(value,
    ["provider", "stableSourceId", "sourceSha256", "version", "externalUrl"]);
  return !!item && text(item.provider) && text(item.stableSourceId) &&
    typeof item.sourceSha256 === "string" && exactSourceHash(item.sourceSha256) &&
    nullableText(item.version) && nullableText(item.externalUrl);
};
const attachedSource = (value: unknown) => {
  const item = closed(value, ["bindingRole", "filename", "sourceSha256", "sourceUrl",
    "origin", "language"]);
  return !!item && text(item.bindingRole) && text(item.filename) && text(item.sourceSha256) &&
    nullableText(item.sourceUrl) && oneOf(item.origin, ["manual", "original", "reconstructed"]) &&
    oneOf(item.language, ["en", "fr", "bilingual"]);
};
const sourceDecision = (value: unknown) => {
  const item = object(value);
  if (!item) return false;
  if (item.kind === "unresolved" || item.kind === "resolved") {
    return exactKeys(item, ["kind"]);
  }
  if (item.kind === "attached" && exactKeys(item, ["kind", "sources"]) &&
      Array.isArray(item.sources) && list(item.sources, attachedSource)) {
    const languages = item.sources.map((source) => object(source)?.language);
    return languages.length > 0 && languages.length <= 2 &&
      new Set(languages).size === languages.length &&
      (!languages.includes("bilingual") || languages.length === 1);
  }
  return item.kind === "pending-canlii" && exactKeys(item,
    ["kind", "authorityKey", "pageUrl", "pdfUrl"]) &&
    text(item.authorityKey) && text(item.pageUrl) && text(item.pdfUrl);
};
const seed = (value: unknown) => {
  const item = closed(value, ["key", "kind", "provider", "stableSourceId", "sourceSha256",
    "citation", "name", "version", "externalUrl", "evidenceIds", "locators"]);
  return !!item && text(item.key) && authorityKind(item.kind) && text(item.provider) &&
    text(item.stableSourceId) && text(item.sourceSha256) && text(item.citation) &&
    nullableText(item.name) && nullableText(item.version) && nullableText(item.externalUrl) &&
    strings(item.evidenceIds) && list(item.locators, locator);
};
const authority = (value: unknown) => {
  const item = object(value), keys = ["id", "key", "kind", "citation", "name", "displayName",
    "evidenceIds", "locators", "sourceIdentity", "excluded", "source"];
  return !!item && exactKeys(item, keys, ["highlightExclusions", "annotations", "scanOnly", "userAdded"]) &&
    (item.scanOnly === undefined || item.scanOnly === true) &&
    (item.userAdded === undefined || item.userAdded === true) &&
    !(item.scanOnly && item.userAdded) &&
    text(item.id) && text(item.key) && authorityKind(item.kind) &&
    text(item.citation) && nullableText(item.name) && nullableText(item.displayName) &&
    strings(item.evidenceIds) && list(item.locators, locator) &&
    (item.highlightExclusions === undefined || list(item.highlightExclusions, locator, 500)) &&
    (item.sourceIdentity === null || sourceIdentity(item.sourceIdentity)) &&
    typeof item.excluded === "boolean" && sourceDecision(item.source);
};
const reviewUnit = (value: unknown) => {
  const item = closed(value, ["id", "kind", "ordinal", "footnoteId", "footnoteRefs",
    "pageNumbers", "text", "occurrenceIds"]);
  return !!item && text(item.id) && oneOf(item.kind, ["body", "footnote"]) &&
    integer(item.ordinal) && (item.footnoteId === null || integer(item.footnoteId)) &&
    list(item.footnoteRefs, pair) && list(item.pageNumbers, integer) && text(item.text) &&
    strings(item.occurrenceIds);
};
const reference = (value: unknown) => {
  const item = closed(value, ["kind", "targetAuthorityId"]);
  return !!item && oneOf(item.kind, ["supra", "ibid"]) &&
    text(item.targetAuthorityId);
};
const occurrence = (value: unknown) => {
  const item = closed(value, ["id", "unitId", "start", "end", "text", "kind", "citation",
    "authorityId", "reference", "pinpoints", "evidenceIds", "sourceTextSha256",
    "localOrdinal", "reviewed", "authoritySpan", "coreSpan", "pinpointSpan"]);
  return !!item && text(item.id) && text(item.unitId) && integer(item.start) &&
    integer(item.end) && text(item.text) && authoritySpan(item.authoritySpan) &&
    authoritySpan(item.coreSpan) && (item.pinpointSpan === null || authoritySpan(item.pinpointSpan)) &&
    (authorityKind(item.kind) || item.kind === "reference") && text(item.citation) &&
    (item.authorityId === null || text(item.authorityId)) &&
    (item.reference === null || reference(item.reference)) && list(item.pinpoints, pinpoint) &&
    strings(item.evidenceIds) && text(item.sourceTextSha256) && integer(item.localOrdinal) &&
    typeof item.reviewed === "boolean";
};

function deriveStoredOccurrenceSpans(value: unknown, unitText: string | undefined) {
  const item = object(value);
  if (!item || !unitText || Object.hasOwn(item, "authoritySpan") ||
      !exactKeys(item, ["id", "unitId", "start", "end", "text", "kind", "citation",
        "authorityId", "reference", "pinpoints", "evidenceIds", "sourceTextSha256",
        "localOrdinal", "reviewed"]) || !integer(item.start) || !integer(item.end) ||
      typeof item.citation !== "string" || !Array.isArray(item.pinpoints)) return value;
  const start = Number(item.start), end = Number(item.end), source = unitText.slice(start, end);
  if (source !== item.text) return value;
  const coreAt = source.indexOf(item.citation), coreStart = coreAt < 0 ? start : start + coreAt,
    coreEnd = coreAt < 0 ? end : coreStart + item.citation.length;
  const pinpointText = [...item.pinpoints].reverse().map((pin) => object(pin)?.text)
    .find((pin): pin is string => typeof pin === "string" && source.lastIndexOf(pin) >= 0);
  const pinpointAt = pinpointText ? source.lastIndexOf(pinpointText) : -1,
    pinpointStart = pinpointAt < 0 ? null : start + pinpointAt;
  const authorityEnd = pinpointStart !== null && pinpointStart >= coreEnd ? pinpointStart : end;
  return { ...item,
    authoritySpan: { start, end: authorityEnd, text: unitText.slice(start, authorityEnd) },
    coreSpan: { start: coreStart, end: coreEnd, text: unitText.slice(coreStart, coreEnd) },
    pinpointSpan: pinpointStart === null ? null : { start: pinpointStart, end,
      text: unitText.slice(pinpointStart, end) } };
}
const ledgerUnit = (value: unknown) => {
  const item = closed(value, ["id", "kind", "ordinal", "footnoteId", "footnoteRefs",
    "pageNumbers", "text", "sourceTextSha256"]);
  return !!item && text(item.id) && oneOf(item.kind, ["body", "footnote"]) &&
    integer(item.ordinal) && (item.footnoteId === null || integer(item.footnoteId)) &&
    list(item.footnoteRefs, pair) && list(item.pageNumbers, integer) && text(item.text) &&
    text(item.sourceTextSha256);
};
const ledgerOccurrence = (value: unknown) => {
  const item = closed(value, ["id", "markerId", "targetId", "authorityKey", "unit", "start",
    "end", "text", "displayedForm", "pinpoints", "evidenceIds", "localOrdinal"]);
  return !!item && [item.id, item.markerId, item.targetId, item.authorityKey].every(text) &&
    ledgerUnit(item.unit) && integer(item.start) && integer(item.end) && text(item.text) &&
    oneOf(item.displayedForm, ["full", "short", "supra", "ibid"]) &&
    list(item.pinpoints, pinpoint) && strings(item.evidenceIds) && integer(item.localOrdinal);
};
const ledger = (value: unknown) => {
  const item = closed(value, ["schemaVersion", "document", "seeds", "occurrences"]);
  return !!item && item.schemaVersion === "beaver.authority-ledger.v1" &&
    snapshot(item.document) && list(item.seeds, seed) && list(item.occurrences, ledgerOccurrence);
};

/** Rejects malformed generic JSON before it can enter the typed Authorities reducer. */
export function decodeAuthoritiesDraft(value: unknown): AuthoritiesDraft | null {
  try {
    const keys = ["schemaVersion", "import", "bindings", "outputMode",
      "settings", "cover", "bookParts", "insertIntoDocument", "ledger", "units", "occurrences",
      "authorities", "authorityOrder", "discrepancyDecisions"];
    const candidate = object(value), withoutDecisions = keys.filter((key) =>
      key !== "discrepancyDecisions"), earlier = keys.filter((key) =>
      key !== "settings" && key !== "bookParts"), oldest = earlier.filter((key) =>
      key !== "discrepancyDecisions");
    const upgraded = candidate && exactKeys(candidate, withoutDecisions, ["stage"])
      ? { ...candidate, discrepancyDecisions: {} }
      : candidate && (exactKeys(candidate, earlier, ["stage"]) || exactKeys(candidate, oldest, ["stage"])) ? { ...candidate,
        settings: { profileId: "general",
          ...structuredClone(authoritiesProfile("general").defaults.settings) },
        bookParts: { cover: null, index: null, supplements: [] },
        discrepancyDecisions: candidate.discrepancyDecisions ?? {},
      } : value;
    const upgradedRecord = object(upgraded);
    const stored = upgradedRecord && exactKeys(upgradedRecord, keys, ["stage"])
      ? upgradedRecord : null;
    const unitText = new Map(Array.isArray(stored?.units) ? stored.units.flatMap((unit) => {
      const item = object(unit);
      return typeof item?.id === "string" && typeof item.text === "string"
        ? [[item.id, item.text] as const] : [];
    }) : []);
    const storedOccurrences = object(stored?.occurrences);
    const draft = stored && storedOccurrences ? { ...stored,
      occurrences: Object.fromEntries(Object.entries(storedOccurrences).map(([id, item]) =>
        [id, deriveStoredOccurrenceSpans(item, unitText.get(String(object(item)?.unitId))) ])) }
      : stored;
    const occurrences = object(draft?.occurrences), authorities = object(draft?.authorities);
    const normalized = draft,
      decisions = object(normalized?.discrepancyDecisions);
    if (!normalized || normalized.schemaVersion !== "beaver.authorities-draft.v1" ||
        !importedDocument(normalized.import) || !decodeWorkProductBindings(normalized.bindings) ||
        !oneOf(normalized.outputMode, ["table", "book", "both"]) ||
        (normalized.stage !== undefined && !oneOf(normalized.stage, ["citations", "sources", "highlights", "build"])) ||
        !buildSettings(normalized.settings) || !authoritiesCover(normalized.cover) ||
        !bookParts(normalized.bookParts) ||
        typeof normalized.insertIntoDocument !== "boolean" ||
        !(normalized.ledger === null || ledger(normalized.ledger)) ||
        !list(normalized.units, reviewUnit) ||
        !occurrences || !Object.values(occurrences).every(occurrence) || !authorities ||
        !Object.values(authorities).every(authority) || !list(normalized.authorityOrder,
          (id) => nonempty(id, 200)) || !decisions || Object.entries(decisions).some(
          ([id, action]) => !/^[a-f0-9]{64}$/u.test(id) || !oneOf(action,
            ["ignore", "pinpoint", "quote_exact", "quote_editorial"]))) return null;
    const result = normalized as unknown as AuthoritiesDraft;
    return validateAuthoritiesDraft(result).length ? null : result;
  } catch { return null; }
}

/** Projects already-grounded receipts using the Rust-owned authority key supplied by the caller. */
export function authoritySeedFromReceipts(
  key: string,
  receipts: readonly LegalEvidenceReceipt[],
): AuthoritySeed {
  if (!key.trim() || !receipts.length) {
    throw new AuthoritiesDomainError("Authority key and receipts are required.");
  }
  const first = receipts[0];
  const identity = (receipt: LegalEvidenceReceipt) => [receipt.provider,
    receipt.source_class, receipt.stable_source_id, receipt.source_sha256, receipt.citation,
    receipt.name, receipt.version, receipt.external_url];
  if (receipts.some((receipt) => !same(identity(receipt), identity(first)))) {
    throw new AuthoritiesDomainError("Evidence receipts must identify one exact source version.");
  }
  if (!exactSourceHash(first.source_sha256)) {
    throw new AuthoritiesDomainError("Evidence receipts require an exact source hash.");
  }
  const locatorKeys = uniqueSorted(receipts.map(({ locator }) => `${locator.kind}\0${locator.label}`));
  return {
    key,
    kind: first.source_class,
    provider: first.provider,
    stableSourceId: first.stable_source_id,
    sourceSha256: first.source_sha256,
    citation: first.citation,
    name: first.name,
    version: first.version,
    externalUrl: first.external_url,
    evidenceIds: uniqueSorted(receipts.map((receipt) => receipt.evidence_id)),
    locators: locatorKeys.map((value) => {
      const [kind, label] = value.split("\0");
      return { kind, label };
    }),
  };
}

const authorityFromSeed = (seed: AuthoritySeed): AuthorityIdentity => ({
  id: seed.key,
  key: seed.key,
  kind: seed.kind,
  citation: seed.citation,
  name: seed.name,
  displayName: null,
  evidenceIds: [...seed.evidenceIds],
  locators: structuredClone(seed.locators),
  sourceIdentity: { provider: seed.provider, stableSourceId: seed.stableSourceId,
    sourceSha256: seed.sourceSha256, version: seed.version, externalUrl: seed.externalUrl },
  excluded: false,
  source: { kind: "resolved" },
});

function ledgerSpans(item: AuthoritiesLedgerOccurrence, citation: string) {
  const local = item.text.toLocaleLowerCase().indexOf(citation.toLocaleLowerCase());
  const coreStart = local < 0 ? item.start : item.start + local;
  const coreEnd = local < 0 ? item.end : coreStart + citation.length;
  const coreSpan = { start: coreStart, end: coreEnd,
    text: item.unit.text.slice(coreStart, coreEnd) };
  const candidates = item.pinpoints.flatMap(({ text }) => {
    const at = item.text.lastIndexOf(text);
    return at < 0 ? [] : [{ start: item.start + at, end: item.start + at + text.length }];
  }).sort((left, right) => left.start - right.start);
  const pinpointSpan = candidates.length ? { start: candidates[0].start,
    end: candidates.at(-1)!.end,
    text: item.unit.text.slice(candidates[0].start, candidates.at(-1)!.end) } : null;
  return { authoritySpan: coreSpan, coreSpan, pinpointSpan };
}

function requireRecord<T>(record: Record<string, T>, id: string, label: string): T {
  const value = record[id];
  if (!value) throw new AuthoritiesDomainError(`Unknown ${label}: ${id}`);
  return value;
}

/** Citation forms observed for one authority, in filing order. */
export function authorityCitationForms(draft: AuthoritiesDraft, authorityId: string): string[] {
  const canonical = requireRecord(draft.authorities, authorityId, "authority").citation;
  const forms = new Set([canonical]);
  for (const unit of draft.units) for (const occurrenceId of unit.occurrenceIds) {
    const occurrence = draft.occurrences[occurrenceId];
    if (occurrence?.authorityId === authorityId && occurrence.kind !== "reference") {
      forms.add(occurrence.citation);
      if (occurrence.authoritySpan.text.trim()) forms.add(occurrence.authoritySpan.text.trim());
    }
  }
  return [...forms];
}

function ingestLedger(draft: AuthoritiesDraft, ledger: AuthorityCitationLedger) {
  if (ledger.schemaVersion !== "beaver.authority-ledger.v1") {
    throw new AuthoritiesDomainError("Invalid citation ledger schema version.");
  }
  if (draft.import.kind !== "document" || !draft.import.snapshot ||
      !sameSnapshot(draft.import.snapshot, ledger.document)) {
    throw new AuthoritiesDomainError("Citation ledger does not match the imported document version.");
  }
  const authorities = Object.fromEntries(ledger.seeds.map((seed) =>
    [seed.key, authorityFromSeed(seed)]));
  if (Object.keys(authorities).length !== ledger.seeds.length) {
    throw new AuthoritiesDomainError("Citation ledger has duplicate authority keys.");
  }
  const units = new Map<string, AuthoritiesReviewUnit>();
  const occurrences: Record<string, AuthorityOccurrence> = {};
  for (const item of ledger.occurrences) {
    const authority = requireRecord(authorities, item.authorityKey, "ledger authority");
    const unit = units.get(item.unit.id) ?? { id: item.unit.id, kind: item.unit.kind,
      ordinal: item.unit.ordinal, footnoteId: item.unit.footnoteId,
      footnoteRefs: item.unit.footnoteRefs, pageNumbers: item.unit.pageNumbers,
      text: item.unit.text, occurrenceIds: [] };
    if (units.has(item.unit.id) && !same({ ...unit, occurrenceIds: [] }, {
      id: item.unit.id, kind: item.unit.kind, ordinal: item.unit.ordinal,
      footnoteId: item.unit.footnoteId, footnoteRefs: item.unit.footnoteRefs,
      pageNumbers: item.unit.pageNumbers, text: item.unit.text, occurrenceIds: [],
    })) throw new AuthoritiesDomainError(`Citation ledger changes unit ${item.unit.id}.`);
    unit.occurrenceIds.push(item.id);
    units.set(unit.id, unit);
    occurrences[item.id] = {
      id: item.id, unitId: unit.id, start: item.start, end: item.end, text: item.text,
      ...ledgerSpans(item, authority.citation),
      kind: item.displayedForm === "supra" || item.displayedForm === "ibid"
        ? "reference" : authority.kind,
      citation: authority.citation,
      authorityId: item.authorityKey,
      reference: item.displayedForm === "supra" || item.displayedForm === "ibid"
        ? { kind: item.displayedForm, targetAuthorityId: item.authorityKey } : null,
      pinpoints: [...item.pinpoints], evidenceIds: [...item.evidenceIds],
      sourceTextSha256: item.unit.sourceTextSha256,
      localOrdinal: item.localOrdinal, reviewed: true,
    };
  }
  draft.ledger = structuredClone(ledger);
  const retained = new Set([draft.import.bindingRole,
    ...authoritiesBookPdfs(draft).map(({ bindingRole }) => bindingRole)]);
  draft.bindings = Object.fromEntries(Object.entries(draft.bindings)
    .filter(([role]) => retained.has(role)));
  draft.units = [...units.values()].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  draft.occurrences = occurrences;
  draft.authorities = authorities;
  draft.authorityOrder = ledger.seeds.map(({ key }) => key);
}

function replaceOccurrences(
  draft: AuthoritiesDraft,
  ids: string[],
  replacements: AuthorityOccurrence[],
  allowExpansion = false,
) {
  const first = requireRecord(draft.occurrences, ids[0], "occurrence");
  const unit = draft.units.find(({ id }) => id === first.unitId);
  if (!unit || ids.some((id) => draft.occurrences[id]?.unitId !== unit.id)) {
    throw new AuthoritiesDomainError("Occurrence edit must remain in one review unit.");
  }
  const positions = ids.map((id) => unit.occurrenceIds.indexOf(id));
  if (positions.some((position) => position < 0) ||
      positions.some((position, index) => index && position !== positions[0] + index)) {
    throw new AuthoritiesDomainError("Occurrence edit requires adjacent review items.");
  }
  const min = Math.min(...ids.map((id) => draft.occurrences[id].start));
  const max = Math.max(...ids.map((id) => draft.occurrences[id].end));
  if (replacements.some((item) => item.unitId !== unit.id || !allowExpansion &&
      (item.start < min || item.end > max))) {
    throw new AuthoritiesDomainError("Replacement occurrences must stay inside the original span.");
  }
  for (const id of ids) delete draft.occurrences[id];
  for (const item of replacements) draft.occurrences[item.id] = structuredClone(item);
  unit.occurrenceIds.splice(positions[0], ids.length, ...replacements.map(({ id }) => id));
}

export function unusedScanOnlyAuthority(draft: AuthoritiesDraft, id: string) {
  const authority = draft.authorities[id];
  return !!authority?.scanOnly &&
    !attachedAuthoritySources(authority.source).some(({ origin }) => origin === "manual") &&
    !authority.evidenceIds.length && !authority.displayName && !authority.excluded &&
    !authority.locators.length &&
    !Object.values(draft.occurrences).some(({ authorityId }) => authorityId === id);
}

function resolvedNameSpan(value: string, name: string) {
  const tokens = (text: string) => [...text.matchAll(/[\p{L}\p{M}\p{N}_’'-]+\.?/gu)].map((match) => ({
    value: match[0].normalize("NFKD").toLowerCase().replace(/\.$/u, ""),
    start: match.index, end: match.index + match[0].length,
  }));
  const source = tokens(value), wanted = tokens(name).map(({ value: token }) => token);
  for (let index = 0; wanted.length && index <= source.length - wanted.length; index += 1) {
    if (wanted.every((token, offset) => source[index + offset].value === token)) {
      return { start: source[index].start, end: source[index + wanted.length - 1].end };
    }
  }
  return null;
}

function resolveAuthority(
  draft: AuthoritiesDraft,
  action: Extract<AuthoritiesAction, { type: "resolve-authority" }>,
) {
  requireRecord(draft.authorities, action.authorityId, "authority");
  if (!action.citation.trim()) throw new AuthoritiesDomainError("Authority citation is required.");
  const aliases = draft.authorityOrder.map((id) => draft.authorities[id]).filter((authority) =>
    authority.id === action.authorityId || authority.sourceIdentity?.provider ===
      action.source.provider && authority.sourceIdentity.stableSourceId ===
      action.source.stableSourceId);
  const survivor = aliases[0];
  const aliasIds = new Set(aliases.map(({ id }) => id));
  const attached = aliases.flatMap(({ source }) => attachedAuthoritySources(source));
  const bilingual = attached.find(({ language }) => language === "bilingual");
  const preserved = bilingual ? [bilingual] : (["en", "fr"] as const).flatMap((language) =>
    attached.find((source) => source.language === language) ?? []);
  const roles = attached.map(({ bindingRole }) => bindingRole);
  survivor.citation = action.citation.trim();
  survivor.name = action.name?.trim() || null;
  survivor.displayName = aliases.find(({ displayName }) => displayName !== null)?.displayName ?? null;
  survivor.excluded = aliases.every(({ excluded }) => excluded);
  survivor.evidenceIds = uniqueSorted(aliases.flatMap(({ evidenceIds }) => evidenceIds));
  survivor.locators = uniqueSorted(aliases.flatMap(({ locators }) => locators)
    .map(({ kind, label }) => `${kind}\0${label}`)).map((value) => {
      const [kind, label] = value.split("\0");
      return { kind, label };
    });
  survivor.sourceIdentity = structuredClone(action.source);
  survivor.source = preserved.length
    ? { kind: "attached", sources: structuredClone(preserved) } : { kind: "resolved" };
  if (aliases.some((authority) => !authority.scanOnly)) delete survivor.scanOnly;
  if (aliases.some((authority) => authority.userAdded)) survivor.userAdded = true;
  for (const id of aliasIds) if (id !== survivor.id) delete draft.authorities[id];
  draft.authorityOrder = draft.authorityOrder.filter((id) => id === survivor.id || !aliasIds.has(id));
  const units = new Map(draft.units.map((unit) => [unit.id, unit]));
  for (const occurrence of Object.values(draft.occurrences)) {
    if (occurrence.authorityId && aliasIds.has(occurrence.authorityId)) {
      occurrence.authorityId = survivor.id;
    }
    if (occurrence.reference && aliasIds.has(occurrence.reference.targetAuthorityId)) {
      occurrence.reference.targetAuthorityId = survivor.id;
    }
    if (action.name && occurrence.kind === "case" && occurrence.authorityId === survivor.id) {
      const unit = units.get(occurrence.unitId);
      const local = unit?.text.slice(occurrence.start, occurrence.authoritySpan.end) ?? "";
      const span = resolvedNameSpan(local, action.name);
      const start = occurrence.start + (span?.start ?? 0);
      if (unit && span && start < occurrence.authoritySpan.start) {
        occurrence.authoritySpan = { start, end: occurrence.authoritySpan.end,
          text: unit.text.slice(start, occurrence.authoritySpan.end) };
        occurrence.start = Math.min(occurrence.start, start);
        occurrence.text = unit.text.slice(occurrence.start, occurrence.end);
      }
    }
  }
  for (const role of roles) removeUnusedBinding(draft, role);
}

function clearAutomaticSources(draft: AuthoritiesDraft) {
  for (const authority of Object.values(draft.authorities)) {
    if (authority.source.kind === "pending-canlii") {
      replaceSource(draft, authority,
        authority.sourceIdentity ? { kind: "resolved" } : { kind: "unresolved" });
    } else if (authority.source.kind === "attached") {
      const sources = authority.source.sources.filter(({ origin }) => origin === "manual");
      if (sources.length !== authority.source.sources.length) replaceSource(draft, authority,
        sources.length ? { kind: "attached", sources }
          : authority.sourceIdentity ? { kind: "resolved" } : { kind: "unresolved" });
    }
  }
}

const occurrenceCarryKey = ({ unitId, sourceTextSha256, localOrdinal }: AuthorityOccurrence) =>
  `${unitId}\0${sourceTextSha256}\0${localOrdinal}`;
const ignoredOccurrenceKey = (item: AuthorityOccurrence) =>
  sha256(`not-citation\0${occurrenceCarryKey(item)}`);

function groupOccurrences(items: AuthorityOccurrence[]) {
  const groups = new Map<string, AuthorityOccurrence[]>();
  for (const item of items) {
    const key = occurrenceCarryKey(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}

function groupUnits(draft: AuthoritiesDraft) {
  const groups = new Map<string, AuthoritiesReviewUnit[]>();
  for (const unit of draft.units) {
    const occurrences = unit.occurrenceIds.map((id) => draft.occurrences[id]);
    const hashes = new Set(occurrences.map((item) => item?.sourceTextSha256));
    const ordinals = new Set(occurrences.map((item) => item?.localOrdinal));
    if (!occurrences.length || occurrences.some((item) => !item) || hashes.size !== 1 ||
        ordinals.size !== occurrences.length) continue;
    const key = `${unit.id}\0${unit.ordinal}\0${[...hashes][0]}`;
    const group = groups.get(key);
    if (group) group.push(unit); else groups.set(key, [unit]);
  }
  return groups;
}

function refresh(draft: AuthoritiesDraft, review: AuthoritiesFreshReview) {
  const incoming = review.cover;
  const cover = incoming ? {
    courtFileNumber: draft.cover.courtFileNumber || incoming.courtFileNumber,
    partyGroups: draft.cover.partyGroups.length ? draft.cover.partyGroups : incoming.partyGroups,
    applicationUnder: draft.cover.applicationUnder || incoming.applicationUnder,
    title: draft.cover.title || incoming.title,
  } : draft.cover;
  const fresh: AuthoritiesDraft = { ...draft, ...structuredClone(review),
    cover: structuredClone(cover), ledger: null };
  for (const item of Object.values(fresh.occurrences)) {
    if (draft.discrepancyDecisions[ignoredOccurrenceKey(item)] === "ignore") {
      replaceOccurrences(fresh, [item.id], []);
    }
  }
  for (const { bindingRole } of authoritiesBookPdfs(draft)) {
    if (draft.bindings[bindingRole]) {
      fresh.bindings[bindingRole] = structuredClone(draft.bindings[bindingRole]);
    }
  }
  for (const id of draft.authorityOrder) {
    const old = draft.authorities[id];
    if (old.userAdded && !Object.values(fresh.authorities).some(({ key }) => key === old.key)) {
      fresh.authorities[id] = structuredClone(old);
      fresh.authorityOrder.push(id);
    }
  }
  const oldByKey = new Map(Object.values(draft.authorities).map((item) => [item.key, item]));
  const freshByKey = new Map(Object.values(fresh.authorities).map((item) => [item.key, item]));
  const remap = new Map<string, string>();
  for (const authority of Object.values(fresh.authorities)) {
    const old = oldByKey.get(authority.key);
    if (!old) continue;
    remap.set(old.id, authority.id);
    authority.displayName = old.displayName;
    authority.excluded = old.excluded;
    if (old.annotations) authority.annotations = structuredClone(old.annotations);
    if (old.highlightExclusions?.length) {
      authority.highlightExclusions = structuredClone(old.highlightExclusions);
    }
    if (old.userAdded) authority.userAdded = true;
    if (!old.scanOnly) delete authority.scanOnly;
    const changedIdentity = Boolean(authority.sourceIdentity) &&
      !same(authority.sourceIdentity, old.sourceIdentity);
    if (!changedIdentity) {
      authority.evidenceIds = uniqueSorted([...old.evidenceIds, ...authority.evidenceIds]);
      const locators = uniqueSorted([...old.locators, ...authority.locators]
        .map(({ kind, label }) => `${kind}\0${label}`));
      authority.locators = locators.map((value) => {
        const [kind, label] = value.split("\0");
        return { kind, label };
      });
      if (old.source.kind !== "unresolved") {
        authority.name ??= old.name;
        authority.source = structuredClone(old.source);
        authority.sourceIdentity = structuredClone(old.sourceIdentity);
      }
      attachedAuthoritySources(old.source).forEach(({ bindingRole }) => {
        if (draft.bindings[bindingRole]) fresh.bindings[bindingRole] =
          structuredClone(draft.bindings[bindingRole]);
      });
    }
  }
  fresh.authorityOrder = [...draft.authorityOrder
    .map((id) => freshByKey.get(draft.authorities[id]?.key ?? "")?.id)
    .filter((id): id is string => Boolean(id)),
    ...review.authorityOrder.filter((id) =>
      !draft.authorityOrder.some((oldId) => draft.authorities[oldId]?.key === fresh.authorities[id]?.key)),
  ];
  const carriedUnits = new Set<string>();
  const oldUnits = groupUnits(draft);
  for (const [key, units] of groupUnits(fresh)) {
    const oldMatches = oldUnits.get(key);
    if (units.length !== 1 || oldMatches?.length !== 1) continue;
    const unit = units[0], oldUnit = oldMatches[0];
    const replacements = oldUnit.occurrenceIds.map((id) => {
      const item = structuredClone(draft.occurrences[id]);
      const authorityId = item.authorityId ? remap.get(item.authorityId) ?? null : null;
      const targetAuthorityId = item.reference
        ? remap.get(item.reference.targetAuthorityId) ?? null : null;
      return item.authorityId && !authorityId || item.reference && !targetAuthorityId
        ? null : { ...item, unitId: unit.id, authorityId,
          reference: item.reference && targetAuthorityId
            ? { ...item.reference, targetAuthorityId } : null };
    });
    const currentIds = new Set(unit.occurrenceIds);
    if (replacements.some((item) => !item || fresh.occurrences[item.id] &&
        !currentIds.has(item.id))) continue;
    for (const id of unit.occurrenceIds) delete fresh.occurrences[id];
    unit.occurrenceIds = replacements.map((item) => item!.id);
    for (const item of replacements) fresh.occurrences[item!.id] = item!;
    carriedUnits.add(unit.id);
  }
  const oldGroups = groupOccurrences(Object.values(draft.occurrences));
  const newGroups = groupOccurrences(Object.values(fresh.occurrences));
  for (const [key, items] of newGroups) {
    if (carriedUnits.has(items[0].unitId)) continue;
    const oldItems = oldGroups.get(key);
    if (items.length !== 1 || oldItems?.length !== 1) continue;
    const old = oldItems[0];
    const target = old.authorityId ? remap.get(old.authorityId) : undefined;
    if (old.authorityId && !target) continue;
    items[0].reviewed = old.reviewed;
    items[0].authorityId = target ?? null;
    items[0].reference = old.reference && target
      ? { kind: old.reference.kind, targetAuthorityId: target } : null;
  }
  for (const id of fresh.authorityOrder) {
    if (unusedScanOnlyAuthority(fresh, id)) delete fresh.authorities[id];
  }
  fresh.authorityOrder = fresh.authorityOrder.filter((id) => fresh.authorities[id]);
  const usedBindings = new Set<string>(fresh.import.kind === "document"
    ? [fresh.import.bindingRole] : []);
  for (const authority of Object.values(fresh.authorities)) {
    attachedAuthoritySources(authority.source).forEach(({ bindingRole }) =>
      usedBindings.add(bindingRole));
  }
  for (const { bindingRole } of authoritiesBookPdfs(fresh)) usedBindings.add(bindingRole);
  fresh.bindings = Object.fromEntries(Object.entries(fresh.bindings)
    .filter(([role]) => usedBindings.has(role)));
  Object.assign(draft, fresh);
}

export function reduceAuthoritiesDraft(
  current: AuthoritiesDraft,
  action: AuthoritiesAction,
): AuthoritiesDraft {
  const priorErrors = validateAuthoritiesDraft(current);
  if (priorErrors.length) throw new AuthoritiesDomainError(priorErrors[0]);
  const draft = structuredClone(current);
  switch (action.type) {
    case "ingest-ledger": ingestLedger(draft, action.ledger); break;
    case "add-seed": {
      const authority = authorityFromSeed(action.seed);
      if (draft.authorities[authority.id]) throw new AuthoritiesDomainError("Authority already exists.");
      draft.authorities[authority.id] = authority;
      draft.authorityOrder.push(authority.id);
      break;
    }
    case "add-authority": {
      if (draft.authorities[action.authority.id]) throw new AuthoritiesDomainError("Authority already exists.");
      draft.authorities[action.authority.id] = structuredClone(action.authority);
      draft.authorityOrder.push(action.authority.id);
      break;
    }
    case "set-stage":
      if (!["citations", "sources", "highlights", "build"].includes(action.stage))
        throw new AuthoritiesDomainError("Unknown Authorities stage.");
      draft.stage = action.stage;
      break;
    case "move-authority": {
      const from = draft.authorityOrder.indexOf(action.authorityId);
      if (from < 0 || !Number.isSafeInteger(action.toIndex) || action.toIndex < 0 ||
          action.toIndex >= draft.authorityOrder.length)
        throw new AuthoritiesDomainError("Choose an existing authority slot.");
      draft.authorityOrder.splice(from, 1);
      draft.authorityOrder.splice(action.toIndex, 0, action.authorityId);
      break;
    }
    case "remove-authority":
      if (Object.values(draft.occurrences).some(({ authorityId }) => authorityId === action.authorityId)) {
        throw new AuthoritiesDomainError("Relink occurrences before removing their authority.");
      }
      {
      const removed = requireRecord(draft.authorities, action.authorityId, "authority");
      delete draft.authorities[action.authorityId];
      draft.authorityOrder = draft.authorityOrder.filter((id) => id !== action.authorityId);
      attachedAuthoritySources(removed.source).forEach(({ bindingRole }) =>
        removeUnusedBinding(draft, bindingRole));
      }
      break;
    case "exclude-authority":
      requireRecord(draft.authorities, action.authorityId, "authority").excluded = action.excluded;
      break;
    case "set-annotations": {
      if (!Array.isArray(action.entries) || !action.entries.length || action.entries.length > 2_000)
        throw new AuthoritiesDomainError("Annotation sources are invalid.");
      const seen = new Set<string>();
      for (const entry of action.entries) {
        const authority = requireRecord(draft.authorities, entry.authorityId, "authority");
        const source = attachedAuthoritySources(authority.source).find(item => item.bindingRole === entry.bindingRole);
        const key = `${entry.authorityId}\0${entry.bindingRole}`;
        if (!source || seen.has(key)) throw new AuthoritiesDomainError("Annotation source is no longer attached.");
        seen.add(key);
        const annotations = decodeAnnotationSet(entry.annotations);
        if (annotations.sourceSha256 !== source.sourceSha256)
          throw new AuthoritiesDomainError("This PDF changed. Reopen it before saving highlights.");
        authority.annotations = { ...authority.annotations, [source.bindingRole]: annotations };
      }
      break;
    }
    case "set-highlight-exclusion": {
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      const kind = action.locator.kind.trim(), label = action.locator.label.trim();
      if (!kind || !label || kind.length > 200 || label.length > 500) {
        throw new AuthoritiesDomainError("Invalid highlight passage.");
      }
      const key = `${kind}\0${label}`;
      const current = authority.highlightExclusions ?? [];
      const filtered = current.filter((item) => `${item.kind}\0${item.label}` !== key);
      if (action.excluded) filtered.push({ kind, label });
      if (filtered.length) authority.highlightExclusions = filtered
        .sort((left, right) => left.kind.localeCompare(right.kind) ||
          left.label.localeCompare(right.label));
      else delete authority.highlightExclusions;
      break;
    }
    case "edit-authority": {
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      if (draft.import.kind !== "manual" && !authority.userAdded) {
        throw new AuthoritiesDomainError("Only a manual authority can be edited directly.");
      }
      const citation = action.citation.trim();
      if (authority.source.kind === "pending-canlii" && citation !== authority.citation) {
        replaceSource(draft, authority,
          authority.sourceIdentity ? { kind: "resolved" } : { kind: "unresolved" });
      }
      authority.kind = action.kind;
      authority.citation = citation;
      authority.name = action.name?.trim() || null;
      authority.displayName = null;
      break;
    }
    case "rename-authority":
      requireRecord(draft.authorities, action.authorityId, "authority").displayName =
        action.displayName?.trim() || null;
      break;
    case "split-occurrence":
      replaceOccurrences(draft, [action.occurrenceId], action.replacements); break;
    case "merge-occurrences": {
      const items = action.occurrenceIds.map((id) =>
        requireRecord(draft.occurrences, id, "occurrence"));
      if (action.replacement.start !== items[0].start ||
          action.replacement.end !== items[1].end) {
        throw new AuthoritiesDomainError("Merged occurrence must cover both original spans.");
      }
      replaceOccurrences(draft, action.occurrenceIds, [action.replacement]); break;
    }
    case "replace-occurrence": {
      const current = requireRecord(draft.occurrences, action.occurrenceId, "occurrence");
      if (action.replacement.id !== current.id ||
          action.replacement.unitId !== current.unitId) {
        throw new AuthoritiesDomainError("Occurrence correction must retain its identity and unit.");
      }
      const absorbed = [...new Set(action.absorbed?.ids ?? [])]
        .filter((id) => id !== current.id);
      if (absorbed.length) {
        const span = action.absorbed!;
        if (span.start < action.replacement.start || span.end > action.replacement.end ||
            span.end <= span.start) throw new AuthoritiesDomainError(
          "The absorbed review span must stay inside the corrected citation.");
        if (absorbed.some((id) => {
          const item = requireRecord(draft.occurrences, id, "occurrence");
          return item.start < span.start || item.end > span.end;
        })) throw new AuthoritiesDomainError(
          "A corrected citation can absorb only review items inside the selected span.");
        const unit = draft.units.find(({ id }) => id === current.unitId)!;
        const ids = [current.id, ...absorbed].sort((left, right) =>
          unit.occurrenceIds.indexOf(left) - unit.occurrenceIds.indexOf(right));
        replaceOccurrences(draft, ids, [action.replacement], true);
      } else draft.occurrences[action.occurrenceId] = structuredClone(action.replacement);
      break;
    }
    case "remove-occurrence": {
      const occurrence = requireRecord(draft.occurrences, action.occurrenceId, "occurrence");
      draft.discrepancyDecisions[ignoredOccurrenceKey(occurrence)] = "ignore";
      replaceOccurrences(draft, [action.occurrenceId], []);
      break;
    }
    case "relink-occurrence": {
      const occurrence = requireRecord(draft.occurrences, action.occurrenceId, "occurrence");
      if (action.authorityId) requireRecord(draft.authorities, action.authorityId, "authority");
      occurrence.authorityId = action.authorityId;
      if (occurrence.reference) occurrence.reference = action.authorityId
        ? { ...occurrence.reference, targetAuthorityId: action.authorityId } : null;
      occurrence.reviewed = true;
      break;
    }
    case "set-reviewed":
      requireRecord(draft.occurrences, action.occurrenceId, "occurrence").reviewed = action.reviewed;
      break;
    case "set-reference": {
      const occurrence = requireRecord(draft.occurrences, action.occurrenceId, "occurrence");
      if (action.reference) requireRecord(draft.authorities,
        action.reference.targetAuthorityId, "authority");
      occurrence.reference = structuredClone(action.reference);
      occurrence.authorityId = action.reference?.targetAuthorityId ?? null;
      occurrence.kind = "reference";
      occurrence.reviewed = true;
      break;
    }
    case "resolve-authority": {
      resolveAuthority(draft, action);
      break;
    }
    case "attach-source": {
      if (!action.bindingRole) throw new AuthoritiesDomainError("Attachment binding role is required.");
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      attachAuthoritySource(draft, authority, {
        bindingRole: action.bindingRole, filename: action.filename,
        sourceSha256: action.sourceSha256, sourceUrl: action.sourceUrl,
        origin: action.origin ?? "manual", language: action.language,
      }, action.binding);
      break;
    }
    case "clear-authority-source": {
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      replaceSource(draft, authority,
        authority.sourceIdentity ? { kind: "resolved" } : { kind: "unresolved" });
      break;
    }
    case "begin-canlii-handoff": {
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      const pdfUrl = buildCanliiPdfUrl(action.pageUrl);
      if (!pdfUrl) throw new AuthoritiesDomainError("CanLII page URL is not canonical.");
      replaceSource(draft, authority, { kind: "pending-canlii", authorityKey: authority.key,
        pageUrl: pdfUrl.replace(/\.pdf$/u, ".html"), pdfUrl });
      break;
    }
    case "set-book-part": {
      const previous = draft.bookParts[action.slot];
      const pdf = { ...structuredClone(action.pdf),
        bindingRole: action.pdf.bindingRole.trim(), filename: action.pdf.filename.trim() };
      draft.bindings[pdf.bindingRole] = structuredClone(action.binding);
      draft.bookParts[action.slot] = pdf;
      removeUnusedBinding(draft, previous?.bindingRole);
      break;
    }
    case "clear-book-part": {
      const previous = draft.bookParts[action.slot];
      draft.bookParts[action.slot] = null;
      removeUnusedBinding(draft, previous?.bindingRole);
      break;
    }
    case "set-book-supplement": {
      const items = draft.bookParts.supplements;
      const index = items.findIndex(({ id }) => id === action.supplement.id);
      const previous = index < 0 ? null : items[index];
      const supplement = { ...structuredClone(action.supplement),
        id: action.supplement.id.trim(), bindingRole: action.supplement.bindingRole.trim(),
        filename: action.supplement.filename.trim() };
      draft.bindings[supplement.bindingRole] = structuredClone(action.binding);
      if (index < 0) items.push(supplement); else items[index] = supplement;
      removeUnusedBinding(draft, previous?.bindingRole);
      break;
    }
    case "remove-book-supplement": {
      const index = draft.bookParts.supplements.findIndex(({ id }) => id === action.id);
      if (index < 0) throw new AuthoritiesDomainError(`Unknown supplement: ${action.id}`);
      const [removed] = draft.bookParts.supplements.splice(index, 1);
      removeUnusedBinding(draft, removed.bindingRole);
      break;
    }
    case "set-cover":
      draft.cover = { ...structuredClone(action.cover),
        courtFileNumber: action.cover.courtFileNumber.trim(),
        applicationUnder: action.cover.applicationUnder.trim(),
        title: action.cover.title.trim(),
        partyGroups: action.cover.partyGroups.map(({ role, parties }) => ({
          role: role.trim(), parties: parties.map((party) => party.trim()),
        })) };
      break;
    case "set-profile": {
      const profile = authoritiesProfile(action.profileId);
      if (draft.import.kind === "manual" && profile.locked?.outputMode === "table") {
        throw new AuthoritiesDomainError("That court profile requires a filing document.");
      }
      const sourceModeChanged = profile.defaults.settings.sourceMode !== draft.settings.sourceMode;
      draft.outputMode = draft.import.kind === "manual" ? "book" : profile.defaults.outputMode;
      draft.settings = { profileId: action.profileId,
        ...structuredClone(profile.defaults.settings) };
      draft.insertIntoDocument = !!profile.requirements?.documentOutputDefault &&
        draft.import.kind === "document";
      if (sourceModeChanged) clearAutomaticSources(draft);
      break;
    }
    case "set-settings": {
      const locked = authoritiesProfile(draft.settings.profileId).locked?.settings ?? {};
      if (Object.entries(action.settings).some(([key, value]) =>
        key in locked && locked[key as keyof AuthoritiesBuildSettings] !== value)) {
        throw new AuthoritiesDomainError("That court profile fixes this output setting.");
      }
      const sourceModeChanged = action.settings.sourceMode !== undefined &&
        action.settings.sourceMode !== draft.settings.sourceMode;
      draft.settings = { ...draft.settings, ...structuredClone(action.settings) };
      if (sourceModeChanged) clearAutomaticSources(draft);
      break;
    }
    case "set-output-mode": {
      if (draft.import.kind === "manual" && action.outputMode !== "book") {
        throw new AuthoritiesDomainError("Manual PDF drafts produce a Book of Authorities.");
      }
      const locked = authoritiesProfile(draft.settings.profileId).locked?.outputMode;
      if (locked && action.outputMode !== locked) {
        throw new AuthoritiesDomainError("That court profile fixes the output type.");
      }
      draft.outputMode = action.outputMode;
      if (action.outputMode === "book") draft.insertIntoDocument = false;
      break;
    }
    case "set-document-output": {
      if (action.enabled && draft.outputMode === "book") {
        throw new AuthoritiesDomainError("A Book-only draft cannot create a source-document copy.");
      }
      draft.insertIntoDocument = action.enabled;
      break;
    }
    case "resolve-discrepancy":
      (draft.discrepancyDecisions ??= {})[action.id] = action.action;
      break;
    case "refresh": refresh(draft, action.review); break;
  }
  if (["clear-authority-source", "add-authority", "remove-authority",
    "edit-authority", "begin-canlii-handoff"].includes(action.type) && draft.stage !== "citations")
    draft.stage = "sources";
  if (action.type === "refresh") draft.stage = draft.import.kind === "manual" ? "sources" : "citations";
  const errors = validateAuthoritiesDraft(draft);
  if (errors.length) throw new AuthoritiesDomainError(errors[0]);
  return draft;
}

export function validateAuthoritiesDraft(draft: AuthoritiesDraft): string[] {
  const errors: string[] = [];
  if (draft.schemaVersion !== "beaver.authorities-draft.v1") errors.push("Invalid draft schema version.");
  if (!["table", "book", "both"].includes(draft.outputMode)) errors.push("Invalid output mode.");
  if (!buildSettings(draft.settings)) errors.push("Invalid Authorities settings.");
  if (!authoritiesCover(draft.cover)) errors.push("Invalid Authorities cover.");
  if (draft.discrepancyDecisions !== undefined && Object.entries(draft.discrepancyDecisions).some(
    ([id, action]) => !/^[a-f0-9]{64}$/u.test(id) ||
      !["ignore", "pinpoint", "quote_exact", "quote_editorial"].includes(action))) {
    errors.push("Invalid discrepancy decisions.");
  }
  const profile = AUTHORITIES_PROFILES.get(draft.settings?.profileId as AuthoritiesProfileId);
  if (profile?.locked?.outputMode && draft.outputMode !== profile.locked.outputMode) {
    errors.push("Output mode conflicts with the court profile.");
  }
  if (profile?.locked?.settings && Object.entries(profile.locked.settings).some(
    ([key, value]) => draft.settings[key as keyof AuthoritiesBuildSettings] !== value)) {
    errors.push("Output settings conflict with the court profile.");
  }
  if (typeof draft.insertIntoDocument !== "boolean" || draft.insertIntoDocument &&
      (draft.import.kind !== "document" || draft.outputMode === "book")) {
    errors.push("Filing output requires an imported document.");
  }
  if (draft.import.kind === "document" && !draft.bindings[draft.import.bindingRole]) {
    errors.push("Imported document binding is missing.");
  }
  const usedBindings = new Set<string>(draft.import.kind === "document"
    ? [draft.import.bindingRole] : []);
  if (!bookParts(draft.bookParts)) {
    errors.push("Invalid book parts.");
  } else {
    const claim = (pdf: AuthoritiesBoundPdf, label: string) => {
      if (!draft.bindings[pdf.bindingRole]) errors.push(`Binding is missing for ${label}.`);
      if (usedBindings.has(pdf.bindingRole)) {
        errors.push(`Binding is assigned more than once: ${pdf.bindingRole}`);
      }
      usedBindings.add(pdf.bindingRole);
    };
    if (draft.bookParts.cover) claim(draft.bookParts.cover, "the custom cover");
    if (draft.bookParts.index) claim(draft.bookParts.index, "the custom index");
    const ids = new Set<string>();
    for (const supplement of draft.bookParts.supplements) {
      if (ids.has(supplement.id)) errors.push(`Duplicate supplement: ${supplement.id}`);
      ids.add(supplement.id);
      claim(supplement, `supplement ${supplement.id}`);
    }
  }
  const authorityIds = Object.keys(draft.authorities);
  if (!same([...draft.authorityOrder].sort(), [...authorityIds].sort())) {
    errors.push("Authority order must contain every authority exactly once.");
  }
  const keys = new Set<string>();
  for (const [id, authority] of Object.entries(draft.authorities)) {
    if (id !== authority.id || !authority.key || keys.has(authority.key) ||
        !["case", "legislation", "commentary", "other"].includes(authority.kind) ||
        !authority.citation?.trim()) {
      errors.push(`Invalid or duplicate authority identity: ${id}`);
    }
    if (!Array.isArray(authority.evidenceIds) ||
        authority.evidenceIds.some((value) => !value?.trim()) ||
        new Set(authority.evidenceIds).size !== authority.evidenceIds.length ||
        !Array.isArray(authority.locators) || authority.locators.some((locator) =>
          !locator || !locator.kind?.trim() || !locator.label?.trim()) ||
        new Set(authority.locators.map(({ kind, label }) => `${kind}\0${label}`)).size !==
          authority.locators.length) {
      errors.push(`Invalid evidence receipts for authority: ${id}`);
    }
    if (authority.highlightExclusions !== undefined && (!Array.isArray(
        authority.highlightExclusions) || authority.highlightExclusions.length > 500 ||
        authority.highlightExclusions.some((item) => !item || !item.kind?.trim() ||
          !item.label?.trim()) ||
        new Set(authority.highlightExclusions.map(({ kind, label }) =>
          `${kind}\0${label}`)).size !== authority.highlightExclusions.length)) {
      errors.push(`Invalid highlight exclusions for authority: ${id}`);
    }
    if (authority.annotations !== undefined) {
      try {
        const values = object(authority.annotations);
        if (!values || Object.keys(values).length > 100) throw new Error();
        for (const [role, value] of Object.entries(values)) {
          if (!role.trim() || role.length > 300) throw new Error();
          decodeAnnotationSet(value);
        }
      } catch { errors.push(`Invalid annotations for authority: ${id}`); }
    }
    keys.add(authority.key);
    if (!sourceDecision(authority.source)) {
      errors.push(`Invalid attached source metadata for authority: ${id}`);
      continue;
    }
    const identity = authority.sourceIdentity;
    if (identity !== null && (!identity || !identity.provider?.trim() ||
        !identity.stableSourceId?.trim() || !exactSourceHash(identity.sourceSha256) ||
        !(identity.version === null || typeof identity.version === "string") ||
        !(identity.externalUrl === null || typeof identity.externalUrl === "string"))) {
      errors.push(`Invalid grounded source identity for authority: ${id}`);
    }
    if (authority.source.kind === "resolved" && !identity) {
      errors.push(`Resolved source identity is missing for authority: ${id}`);
    }
    if (authority.source.kind === "unresolved" && identity) {
      errors.push(`Unresolved authority has a grounded source identity: ${id}`);
    }
    if (authority.source.kind === "pending-canlii" &&
        (authority.source.authorityKey !== authority.key ||
         buildCanliiPdfUrl(authority.source.pageUrl) !== authority.source.pdfUrl)) {
      errors.push(`Invalid CanLII handoff for authority: ${id}`);
    }
    if (authority.source.kind === "attached") {
      for (const source of authority.source.sources) {
        if (!draft.bindings[source.bindingRole])
          errors.push(`Attached source binding is missing for authority: ${id}`);
        if (!/^[a-f0-9]{64}$/u.test(source.sourceSha256))
          errors.push(`Attached source hash is invalid for authority: ${id}`);
        if (usedBindings.has(source.bindingRole))
          errors.push(`Binding is assigned more than once: ${source.bindingRole}`);
        usedBindings.add(source.bindingRole);
      }
    }
  }
  for (const role of Object.keys(draft.bindings)) {
    if (!usedBindings.has(role)) errors.push(`Unused binding: ${role}`);
  }
  const seenUnits = new Set<string>();
  const seenOccurrences = new Set<string>();
  for (const unit of draft.units) {
    if (!unit.id || seenUnits.has(unit.id)) errors.push(`Duplicate review unit: ${unit.id}`);
    seenUnits.add(unit.id);
    if (!Array.isArray(unit.pageNumbers) || unit.pageNumbers.some((page) =>
      !Number.isSafeInteger(page) || page < 1) ||
      new Set(unit.pageNumbers).size !== unit.pageNumbers.length) {
      errors.push(`Invalid review-unit pages: ${unit.id}`);
    }
    if (unit.footnoteRefs.some(([footnoteId, offset]) =>
      !Number.isInteger(footnoteId) || !Number.isInteger(offset) ||
      footnoteId < 0 || offset < 0 || offset > unit.text.length)) {
      errors.push(`Invalid footnote reference anchor: ${unit.id}`);
    }
    let end = -1;
    for (const id of unit.occurrenceIds) {
      const occurrence = draft.occurrences[id];
      if (!occurrence || seenOccurrences.has(id) || occurrence.id !== id ||
          occurrence.unitId !== unit.id) {
        errors.push(`Invalid occurrence membership: ${id}`);
        continue;
      }
      seenOccurrences.add(id);
      if (!Number.isInteger(occurrence.start) || !Number.isInteger(occurrence.end) ||
          occurrence.start < end || occurrence.start < 0 || occurrence.end <= occurrence.start ||
          occurrence.text !== unit.text.slice(occurrence.start, occurrence.end)) {
        errors.push(`Invalid occurrence span: ${id}`);
      }
      const spans = [occurrence.authoritySpan, occurrence.coreSpan,
        ...(occurrence.pinpointSpan ? [occurrence.pinpointSpan] : [])];
      if (spans.some((span) => !span || !Number.isInteger(span.start) ||
          !Number.isInteger(span.end) || span.start < occurrence.start ||
          span.end <= span.start || span.end > occurrence.end ||
          span.text !== unit.text.slice(span.start, span.end)) ||
          occurrence.coreSpan.start < occurrence.authoritySpan.start ||
          occurrence.coreSpan.end > occurrence.authoritySpan.end) {
        errors.push(`Invalid reviewed citation boundaries: ${id}`);
      }
      end = occurrence.end;
      if (occurrence.authorityId && !draft.authorities[occurrence.authorityId]) {
        errors.push(`Unknown authority on occurrence: ${id}`);
      }
      if (occurrence.reference &&
          (occurrence.reference.targetAuthorityId !== occurrence.authorityId ||
           !draft.authorities[occurrence.reference.targetAuthorityId])) {
        errors.push(`Invalid reference target: ${id}`);
      }
      if (!occurrence.sourceTextSha256 || !Number.isInteger(occurrence.localOrdinal) ||
          occurrence.localOrdinal < 0) {
        errors.push(`Invalid carry-forward identity: ${id}`);
      }
    }
  }
  for (const id of Object.keys(draft.occurrences)) {
    if (!seenOccurrences.has(id)) errors.push(`Occurrence is outside a review unit: ${id}`);
  }
  if (draft.ledger && (draft.import.kind !== "document" || !draft.import.snapshot ||
      !sameSnapshot(draft.ledger.document, draft.import.snapshot))) {
    errors.push("Citation ledger is not bound to the imported version.");
  }
  return errors;
}
