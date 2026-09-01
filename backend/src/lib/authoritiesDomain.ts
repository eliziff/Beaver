import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { buildCanliiPdfUrl } from "./canliiUrls";
import { decodeWorkProductBindings, type WorkProductInput,
  type WorkProductState } from "./workProduct";

export type AuthorityKind = "case" | "legislation" | "commentary" | "other";
export type AuthoritiesOutputMode = "table" | "book" | "both";
export type AuthoritiesSourceMode = "automatic" | "manual-originals" | "render";
export type AuthoritiesProfileId = keyof typeof AUTHORITIES_PROFILES;
export type AuthoritiesBookRole = "applicant" | "respondent" | "joint" |
  "appellant" | "intervener";
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
export type AuthoritiesSettings = AuthoritiesBuildSettings & {
  profileId: AuthoritiesProfileId;
};

type AuthoritiesProfile = {
  defaults: { outputMode: AuthoritiesOutputMode; settings: AuthoritiesBuildSettings };
  locked?: { outputMode?: AuthoritiesOutputMode;
    settings?: Partial<AuthoritiesBuildSettings> };
};

/** Filing defaults only; source receipts remain in the repository audit data. */
const AUTHORITIES_PROFILES = {
  general: { defaults: { outputMode: "book", settings: {
    sourceMode: "automatic", tabStyle: "numeric", tableOrder: "alphabetical",
    tableDelivery: "native-append", tableLocation: "pages",
    passageMarking: "margin", scannedPdfPolicy: "page-margin",
    missingSourcePolicy: "placeholder",
  } } },
  "ab-court-of-kings-bench": { defaults: { outputMode: "book", settings: {
    sourceMode: "automatic", tabStyle: "numeric", tableOrder: "alphabetical",
    tableDelivery: "native-append", tableLocation: "pages",
    passageMarking: "margin", scannedPdfPolicy: "full", missingSourcePolicy: "omit",
  } }, locked: { settings: { missingSourcePolicy: "omit" } } },
  "ab-court-of-appeal": { defaults: { outputMode: "table", settings: {
    sourceMode: "automatic", tabStyle: "numeric", tableOrder: "first-reference",
    tableDelivery: "linked-append", tableLocation: "pinpoints",
    passageMarking: "none", scannedPdfPolicy: "page-margin",
    missingSourcePolicy: "omit",
  } }, locked: { outputMode: "table", settings: {
    tableDelivery: "linked-append", tableOrder: "first-reference", missingSourcePolicy: "omit",
  } } },
  "federal-court": { defaults: { outputMode: "book", settings: {
    sourceMode: "automatic", tabStyle: "numeric", tableOrder: "alphabetical",
    tableDelivery: "native-append", tableLocation: "pages",
    passageMarking: "margin", scannedPdfPolicy: "full", missingSourcePolicy: "omit",
    filingMedium: "electronic", bookRole: "applicant",
  } } },
  "federal-court-of-appeal": { defaults: { outputMode: "book", settings: {
    sourceMode: "automatic", tabStyle: "numeric", tableOrder: "alphabetical",
    tableDelivery: "native-append", tableLocation: "pages",
    passageMarking: "margin", scannedPdfPolicy: "full", missingSourcePolicy: "omit",
    filingMedium: "electronic", bookRole: "joint",
  } } },
} as const satisfies Record<string, AuthoritiesProfile>;
export const authoritiesProfileIds = Object.keys(AUTHORITIES_PROFILES) as AuthoritiesProfileId[];

export type AuthoritiesDocumentSnapshot = {
  documentId: string;
  versionId: string;
  sha256: string;
};

export type AuthoritiesImport =
  | { kind: "manual" }
  | { kind: "document"; bindingRole: "source"; filename: string;
      fileType: "docx" | "pdf"; snapshot: AuthoritiesDocumentSnapshot | null };

export type AuthoritySeed = {
  key: string;
  kind: AuthorityKind;
  provider: string;
  stableSourceId: string;
  sourceSha256: string;
  citation: string;
  name: string | null;
  version: string | null;
  externalUrl: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
};

export type AuthoritySourceIdentity = Pick<AuthoritySeed,
  "provider" | "stableSourceId" | "sourceSha256" | "version" | "externalUrl">;

export type AuthoritiesLedgerOccurrence = {
  id: string;
  markerId: string;
  targetId: string;
  authorityKey: string;
  unit: { id: string; kind: "body" | "footnote"; ordinal: number;
    footnoteId: number | null; footnoteRefs: Array<[number, number]>;
    pageNumbers: number[]; text: string; sourceTextSha256: string };
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

export type AuthoritySourceDecision =
  | { kind: "unresolved" }
  | { kind: "resolved" }
  | { kind: "attached"; bindingRole: string; filename: string;
      sourceSha256: string; sourceUrl: string | null;
      origin: "manual" | "original" | "reconstructed" }
  | { kind: "pending-canlii"; authorityKey: string; pageUrl: string; pdfUrl: string };

export type AuthoritiesBoundPdf = {
  bindingRole: string;
  filename: string;
  sourceSha256: string;
};
export type AuthoritiesBookSupplement = AuthoritiesBoundPdf & {
  id: string;
  title: string;
  tab: string;
};
export type AuthoritiesBookParts = {
  cover: AuthoritiesBoundPdf | null;
  index: AuthoritiesBoundPdf | null;
  supplements: AuthoritiesBookSupplement[];
};

export type AuthorityTextSpan = { start: number; end: number; text: string };

export type AuthorityIdentity = {
  id: string;
  key: string;
  kind: AuthorityKind;
  citation: string;
  name: string | null;
  displayName: string | null;
  tabLabel: string | null;
  evidenceIds: string[];
  locators: Array<{ kind: string; label: string }>;
  sourceIdentity: AuthoritySourceIdentity | null;
  excluded: boolean;
  source: AuthoritySourceDecision;
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

export type AuthoritiesDraft = WorkProductState & {
  schemaVersion: "beaver.authorities-draft.v1";
  import: AuthoritiesImport;
  bindings: Record<string, WorkProductInput>;
  outputMode: AuthoritiesOutputMode;
  settings: AuthoritiesSettings;
  bookParts: AuthoritiesBookParts;
  insertIntoDocument: boolean;
  ledger: AuthorityCitationLedger | null;
  units: AuthoritiesReviewUnit[];
  occurrences: Record<string, AuthorityOccurrence>;
  authorities: Record<string, AuthorityIdentity>;
  authorityOrder: string[];
};

export type AuthoritiesFreshReview = Pick<AuthoritiesDraft,
  "import" | "bindings" | "units" | "occurrences" | "authorities" | "authorityOrder">;

export type AuthoritiesAction =
  | { type: "ingest-ledger"; ledger: AuthorityCitationLedger }
  | { type: "add-seed"; seed: AuthoritySeed }
  | { type: "add-authority"; authority: AuthorityIdentity; at?: number }
  | { type: "remove-authority"; authorityId: string }
  | { type: "exclude-authority"; authorityId: string; excluded: boolean }
  | { type: "rename-authority"; authorityId: string; displayName: string | null }
  | { type: "set-authority-tab"; authorityId: string; tabLabel: string | null }
  | { type: "reorder-authorities"; authorityIds: string[] }
  | { type: "split-occurrence"; occurrenceId: string;
      replacements: [AuthorityOccurrence, AuthorityOccurrence] }
  | { type: "merge-occurrences"; occurrenceIds: [string, string];
      replacement: AuthorityOccurrence }
  | { type: "replace-occurrence"; occurrenceId: string;
      replacement: AuthorityOccurrence }
  | { type: "relink-occurrence"; occurrenceId: string; authorityId: string | null }
  | { type: "set-reviewed"; occurrenceId: string; reviewed: boolean }
  | { type: "set-reference"; occurrenceId: string;
      reference: AuthorityOccurrence["reference"] }
  | { type: "resolve-authority"; authorityId: string; citation: string;
      name: string | null; source: AuthoritySourceIdentity }
  | { type: "attach-source"; authorityId: string; bindingRole: string;
      binding: WorkProductInput; filename: string; sourceSha256: string;
      sourceUrl: string | null; origin?: "manual" | "original" | "reconstructed" }
  | { type: "begin-canlii-handoff"; authorityId: string; pageUrl: string }
  | { type: "set-book-part"; slot: "cover" | "index"; pdf: AuthoritiesBoundPdf;
      binding: WorkProductInput }
  | { type: "clear-book-part"; slot: "cover" | "index" }
  | { type: "set-book-supplement"; supplement: AuthoritiesBookSupplement;
      binding: WorkProductInput; at?: number }
  | { type: "update-book-supplement"; id: string; title: string; tab: string }
  | { type: "reorder-book-supplements"; ids: string[] }
  | { type: "remove-book-supplement"; id: string }
  | { type: "set-profile"; profileId: AuthoritiesProfileId }
  | { type: "set-settings"; settings: Partial<AuthoritiesBuildSettings> }
  | { type: "set-output-mode"; outputMode: AuthoritiesOutputMode }
  | { type: "set-document-output"; enabled: boolean }
  | { type: "refresh"; review: AuthoritiesFreshReview };

export class AuthoritiesDomainError extends Error {}

export function createAuthoritiesDraft(
  source: AuthoritiesImport,
  bindings: Record<string, WorkProductInput> = {},
  outputMode: AuthoritiesOutputMode = "book",
): AuthoritiesDraft {
  const profile = AUTHORITIES_PROFILES.general;
  const draft: AuthoritiesDraft = { schemaVersion: "beaver.authorities-draft.v1",
    import: source, bindings: structuredClone(bindings), outputMode,
    settings: { profileId: "general", ...structuredClone(profile.defaults.settings) },
    bookParts: { cover: null, index: null, supplements: [] },
    insertIntoDocument: false, ledger: null,
    units: [], occurrences: {}, authorities: {}, authorityOrder: [] };
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
  if (!item || !exactKeys(item, ["profileId", ...keys], ["filingMedium", "bookRole"])) {
    return false;
  }
  const context = item.profileId === "federal-court"
    ? oneOf(item.filingMedium, ["electronic", "paper"]) &&
      oneOf(item.bookRole, ["applicant", "respondent", "joint"])
    : item.profileId === "federal-court-of-appeal"
      ? oneOf(item.filingMedium, ["electronic", "paper"]) &&
        oneOf(item.bookRole, ["joint", "appellant", "respondent", "intervener"])
      : !Object.hasOwn(item, "filingMedium") && !Object.hasOwn(item, "bookRole");
  return oneOf(item.profileId, authoritiesProfileIds) && context &&
    oneOf(item.sourceMode, ["automatic", "manual-originals", "render"]) &&
    oneOf(item.tabStyle, ["numeric", "alpha"]) &&
    oneOf(item.tableOrder, ["first-reference", "alphabetical"]) &&
    oneOf(item.tableDelivery, ["native-marks", "native-append", "linked-append"]) &&
    oneOf(item.tableLocation, ["pages", "pinpoints", "combined"]) &&
    oneOf(item.passageMarking, ["none", "margin", "paragraph", "text", "sidelined"]) &&
    oneOf(item.scannedPdfPolicy, ["page-margin", "cited-pages", "full"]) &&
    oneOf(item.missingSourcePolicy, ["placeholder", "omit"]);
};
const boundPdf = (value: unknown) => {
  const item = closed(value, ["bindingRole", "filename", "sourceSha256"]);
  return !!item && trimmed(item.bindingRole, 200) && trimmed(item.filename) &&
    typeof item.sourceSha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sourceSha256);
};
const bookSupplement = (value: unknown) => {
  const item = closed(value, ["id", "bindingRole", "filename", "sourceSha256", "title", "tab"]);
  return !!item && trimmed(item.id, 200) && boundPdf({ bindingRole: item.bindingRole,
    filename: item.filename, sourceSha256: item.sourceSha256 }) &&
    trimmed(item.title) && trimmed(item.tab, 80);
};
const bookParts = (value: unknown) => {
  const item = closed(value, ["cover", "index", "supplements"]);
  return !!item && (item.cover === null || boundPdf(item.cover)) &&
    (item.index === null || boundPdf(item.index)) &&
    list(item.supplements, bookSupplement, 500);
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
const sourceDecision = (value: unknown) => {
  const item = object(value);
  if (!item) return false;
  if (item.kind === "unresolved" || item.kind === "resolved") {
    return exactKeys(item, ["kind"]);
  }
  if (item.kind === "attached") return exactKeys(item,
    ["kind", "bindingRole", "filename", "sourceSha256", "sourceUrl", "origin"]) &&
    text(item.bindingRole) && text(item.filename) && text(item.sourceSha256) &&
    nullableText(item.sourceUrl) && oneOf(item.origin, ["manual", "original", "reconstructed"]);
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
  const item = closed(value, ["id", "key", "kind", "citation", "name", "displayName",
    "tabLabel", "evidenceIds", "locators", "sourceIdentity", "excluded", "source"]);
  return !!item && text(item.id) && text(item.key) && authorityKind(item.kind) &&
    text(item.citation) && nullableText(item.name) && nullableText(item.displayName) &&
    nullableText(item.tabLabel) &&
    strings(item.evidenceIds) && list(item.locators, locator) &&
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
    const draft = closed(value, ["schemaVersion", "import", "bindings", "outputMode",
      "settings", "bookParts", "insertIntoDocument", "ledger", "units", "occurrences",
      "authorities", "authorityOrder"]);
    const occurrences = object(draft?.occurrences), authorities = object(draft?.authorities);
    if (!draft || draft.schemaVersion !== "beaver.authorities-draft.v1" ||
        !importedDocument(draft.import) || !decodeWorkProductBindings(draft.bindings) ||
        !oneOf(draft.outputMode, ["table", "book", "both"]) ||
        !buildSettings(draft.settings) || !bookParts(draft.bookParts) ||
        typeof draft.insertIntoDocument !== "boolean" ||
        !(draft.ledger === null || ledger(draft.ledger)) || !list(draft.units, reviewUnit) ||
        !occurrences || !Object.values(occurrences).every(occurrence) || !authorities ||
        !Object.values(authorities).every(authority) || !list(draft.authorityOrder,
          (id) => nonempty(id, 200))) return null;
    const result = draft as unknown as AuthoritiesDraft;
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
  tabLabel: null,
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

export const authoritiesBookPdfs = (draft: AuthoritiesDraft): AuthoritiesBoundPdf[] => [
  ...(draft.bookParts.cover ? [draft.bookParts.cover] : []),
  ...(draft.bookParts.index ? [draft.bookParts.index] : []),
  ...draft.bookParts.supplements,
];

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
  if (replacements.some((item) => item.unitId !== unit.id || item.start < min || item.end > max)) {
    throw new AuthoritiesDomainError("Replacement occurrences must stay inside the original span.");
  }
  for (const id of ids) delete draft.occurrences[id];
  for (const item of replacements) draft.occurrences[item.id] = structuredClone(item);
  unit.occurrenceIds.splice(positions[0], ids.length, ...replacements.map(({ id }) => id));
}

function removeUnusedBinding(draft: AuthoritiesDraft, role: string | undefined) {
  if (!role || draft.import.kind === "document" && draft.import.bindingRole === role ||
      Object.values(draft.authorities).some((authority) =>
        authority.source.kind === "attached" && authority.source.bindingRole === role) ||
      authoritiesBookPdfs(draft).some(({ bindingRole }) => bindingRole === role)) return;
  delete draft.bindings[role];
}

function replaceSource(
  draft: AuthoritiesDraft,
  authority: AuthorityIdentity,
  source: AuthoritySourceDecision,
) {
  const oldRole = authority.source.kind === "attached" ? authority.source.bindingRole : undefined;
  authority.source = source;
  removeUnusedBinding(draft, oldRole);
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
  const roles = aliases.flatMap(({ source }) => source.kind === "attached"
    ? [source.bindingRole] : []);
  const attached = aliases.map(({ source }) => source).find(
    (source): source is Extract<AuthoritySourceDecision, { kind: "attached" }> =>
      source.kind === "attached");
  survivor.citation = action.citation.trim();
  survivor.name = action.name?.trim() || null;
  survivor.displayName = aliases.find(({ displayName }) => displayName !== null)?.displayName ?? null;
  survivor.tabLabel = aliases.find(({ tabLabel }) => tabLabel !== null)?.tabLabel ?? null;
  survivor.excluded = aliases.every(({ excluded }) => excluded);
  survivor.evidenceIds = uniqueSorted(aliases.flatMap(({ evidenceIds }) => evidenceIds));
  survivor.locators = uniqueSorted(aliases.flatMap(({ locators }) => locators)
    .map(({ kind, label }) => `${kind}\0${label}`)).map((value) => {
      const [kind, label] = value.split("\0");
      return { kind, label };
    });
  survivor.sourceIdentity = structuredClone(action.source);
  survivor.source = attached ? structuredClone(attached) : { kind: "resolved" };
  for (const id of aliasIds) if (id !== survivor.id) delete draft.authorities[id];
  draft.authorityOrder = draft.authorityOrder.filter((id) => id === survivor.id || !aliasIds.has(id));
  for (const occurrence of Object.values(draft.occurrences)) {
    if (occurrence.authorityId && aliasIds.has(occurrence.authorityId)) {
      occurrence.authorityId = survivor.id;
    }
    if (occurrence.reference && aliasIds.has(occurrence.reference.targetAuthorityId)) {
      occurrence.reference.targetAuthorityId = survivor.id;
    }
  }
  for (const role of roles) removeUnusedBinding(draft, role);
}

function resumeAutomaticSources(draft: AuthoritiesDraft) {
  for (const authority of Object.values(draft.authorities)) {
    if (authority.source.kind === "pending-canlii") replaceSource(draft, authority,
      authority.sourceIdentity ? { kind: "resolved" } : { kind: "unresolved" });
  }
}

const occurrenceCarryKey = ({ unitId, sourceTextSha256, localOrdinal }: AuthorityOccurrence) =>
  `${unitId}\0${sourceTextSha256}\0${localOrdinal}`;

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
  const fresh: AuthoritiesDraft = { ...draft, ...structuredClone(review), ledger: null };
  for (const { bindingRole } of authoritiesBookPdfs(draft)) {
    if (draft.bindings[bindingRole]) {
      fresh.bindings[bindingRole] = structuredClone(draft.bindings[bindingRole]);
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
    authority.tabLabel = old.tabLabel;
    authority.excluded = old.excluded;
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
        authority.source = structuredClone(old.source);
        authority.sourceIdentity = structuredClone(old.sourceIdentity);
      }
      if (old.source.kind === "attached" && draft.bindings[old.source.bindingRole]) {
        fresh.bindings[old.source.bindingRole] =
          structuredClone(draft.bindings[old.source.bindingRole]);
      }
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
  const usedBindings = new Set<string>(fresh.import.kind === "document"
    ? [fresh.import.bindingRole] : []);
  for (const authority of Object.values(fresh.authorities)) {
    if (authority.source.kind === "attached") usedBindings.add(authority.source.bindingRole);
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
      draft.authorityOrder.splice(action.at ?? draft.authorityOrder.length, 0, action.authority.id);
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
      removeUnusedBinding(draft,
        removed.source.kind === "attached" ? removed.source.bindingRole : undefined);
      }
      break;
    case "exclude-authority":
      requireRecord(draft.authorities, action.authorityId, "authority").excluded = action.excluded;
      break;
    case "rename-authority":
      requireRecord(draft.authorities, action.authorityId, "authority").displayName =
        action.displayName?.trim() || null;
      break;
    case "set-authority-tab":
      requireRecord(draft.authorities, action.authorityId, "authority").tabLabel =
        action.tabLabel?.trim() || null;
      break;
    case "reorder-authorities": draft.authorityOrder = [...action.authorityIds]; break;
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
      draft.occurrences[action.occurrenceId] = structuredClone(action.replacement);
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
      occurrence.authorityId = action.reference?.targetAuthorityId ?? occurrence.authorityId;
      occurrence.kind = action.reference ? "reference"
        : occurrence.authorityId ? draft.authorities[occurrence.authorityId].kind : "other";
      occurrence.reviewed = true;
      break;
    }
    case "resolve-authority": {
      resolveAuthority(draft, action);
      break;
    }
    case "attach-source": {
      if (!action.bindingRole) throw new AuthoritiesDomainError("Attachment binding role is required.");
      draft.bindings[action.bindingRole] = structuredClone(action.binding);
      replaceSource(draft, requireRecord(draft.authorities, action.authorityId, "authority"), {
        kind: "attached", bindingRole: action.bindingRole, filename: action.filename,
        sourceSha256: action.sourceSha256, sourceUrl: action.sourceUrl,
        origin: action.origin ?? "manual",
      });
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
      const supplements = draft.bookParts.supplements;
      const previousIndex = supplements.findIndex(({ id }) => id === action.supplement.id);
      const previous = previousIndex < 0 ? null : supplements.splice(previousIndex, 1)[0];
      const supplement = { ...structuredClone(action.supplement),
        id: action.supplement.id.trim(), bindingRole: action.supplement.bindingRole.trim(),
        filename: action.supplement.filename.trim(), title: action.supplement.title.trim(),
        tab: action.supplement.tab.trim() };
      const at = action.at ?? (previousIndex < 0 ? supplements.length : previousIndex);
      if (!Number.isSafeInteger(at) || at < 0 || at > supplements.length) {
        throw new AuthoritiesDomainError("Supplement position is invalid.");
      }
      draft.bindings[supplement.bindingRole] = structuredClone(action.binding);
      supplements.splice(at, 0, supplement);
      removeUnusedBinding(draft, previous?.bindingRole);
      break;
    }
    case "update-book-supplement": {
      const supplement = draft.bookParts.supplements.find(({ id }) => id === action.id);
      if (!supplement) throw new AuthoritiesDomainError(`Unknown supplement: ${action.id}`);
      supplement.title = action.title.trim();
      supplement.tab = action.tab.trim();
      break;
    }
    case "reorder-book-supplements": {
      const byId = new Map(draft.bookParts.supplements.map((item) => [item.id, item]));
      draft.bookParts.supplements = action.ids.map((id) => {
        const item = byId.get(id);
        if (!item) throw new AuthoritiesDomainError(`Unknown supplement: ${id}`);
        return item;
      });
      break;
    }
    case "remove-book-supplement": {
      const index = draft.bookParts.supplements.findIndex(({ id }) => id === action.id);
      if (index < 0) throw new AuthoritiesDomainError(`Unknown supplement: ${action.id}`);
      const [removed] = draft.bookParts.supplements.splice(index, 1);
      removeUnusedBinding(draft, removed.bindingRole);
      break;
    }
    case "set-profile": {
      const profile: AuthoritiesProfile = AUTHORITIES_PROFILES[action.profileId];
      const automatic = profile.defaults.settings.sourceMode !== "manual-originals" &&
        draft.settings.sourceMode === "manual-originals";
      draft.outputMode = profile.defaults.outputMode;
      draft.settings = { profileId: action.profileId,
        ...structuredClone(profile.defaults.settings) };
      draft.insertIntoDocument = action.profileId === "ab-court-of-appeal" &&
        draft.import.kind === "document";
      if (automatic) resumeAutomaticSources(draft);
      break;
    }
    case "set-settings": {
      const locked = (AUTHORITIES_PROFILES[draft.settings.profileId] as AuthoritiesProfile)
        .locked?.settings ?? {};
      if (Object.entries(action.settings).some(([key, value]) =>
        key in locked && locked[key as keyof AuthoritiesBuildSettings] !== value)) {
        throw new AuthoritiesDomainError("That court profile fixes this output setting.");
      }
      const automatic = action.settings.sourceMode !== undefined &&
        action.settings.sourceMode !== "manual-originals" &&
        draft.settings.sourceMode === "manual-originals";
      draft.settings = { ...draft.settings, ...structuredClone(action.settings) };
      if (automatic) resumeAutomaticSources(draft);
      break;
    }
    case "set-output-mode": {
      const locked = (AUTHORITIES_PROFILES[draft.settings.profileId] as AuthoritiesProfile)
        .locked?.outputMode;
      if (locked && action.outputMode !== locked) {
        throw new AuthoritiesDomainError("That court profile fixes the output type.");
      }
      draft.outputMode = action.outputMode;
      break;
    }
    case "set-document-output": draft.insertIntoDocument = action.enabled; break;
    case "refresh": refresh(draft, action.review); break;
  }
  const errors = validateAuthoritiesDraft(draft);
  if (errors.length) throw new AuthoritiesDomainError(errors[0]);
  return draft;
}

export function validateAuthoritiesDraft(draft: AuthoritiesDraft): string[] {
  const errors: string[] = [];
  if (draft.schemaVersion !== "beaver.authorities-draft.v1") errors.push("Invalid draft schema version.");
  if (!["table", "book", "both"].includes(draft.outputMode)) errors.push("Invalid output mode.");
  if (!buildSettings(draft.settings)) errors.push("Invalid Authorities settings.");
  const profile = AUTHORITIES_PROFILES[draft.settings?.profileId as AuthoritiesProfileId] as
    AuthoritiesProfile | undefined;
  if (profile?.locked?.outputMode && draft.outputMode !== profile.locked.outputMode) {
    errors.push("Output mode conflicts with the court profile.");
  }
  if (profile?.locked?.settings && Object.entries(profile.locked.settings).some(
    ([key, value]) => draft.settings[key as keyof AuthoritiesBuildSettings] !== value)) {
    errors.push("Output settings conflict with the court profile.");
  }
  if (typeof draft.insertIntoDocument !== "boolean" || draft.insertIntoDocument &&
      draft.import.kind !== "document") {
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
    const ids = new Set<string>(), tabs = new Set<string>();
    for (const supplement of draft.bookParts.supplements) {
      if (ids.has(supplement.id)) errors.push(`Duplicate supplement: ${supplement.id}`);
      ids.add(supplement.id);
      const tab = supplement.tab.toLocaleLowerCase("en-CA");
      if (tabs.has(tab)) errors.push(`Duplicate supplement tab: ${supplement.tab}`);
      tabs.add(tab);
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
    if (!(authority.tabLabel === null || typeof authority.tabLabel === "string" &&
        authority.tabLabel.trim() === authority.tabLabel && authority.tabLabel.length <= 80 &&
        !/[\u0000-\u001f\u007f]/u.test(authority.tabLabel))) {
      errors.push(`Invalid authority tab label: ${id}`);
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
    keys.add(authority.key);
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
      if (!draft.bindings[authority.source.bindingRole])
        errors.push(`Attached source binding is missing for authority: ${id}`);
      if (!/^[a-f0-9]{64}$/u.test(authority.source.sourceSha256))
        errors.push(`Attached source hash is invalid for authority: ${id}`);
      if (usedBindings.has(authority.source.bindingRole))
        errors.push(`Binding is assigned more than once: ${authority.source.bindingRole}`);
      usedBindings.add(authority.source.bindingRole);
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
