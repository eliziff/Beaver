import type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId, AuthoritiesBookRole,
  AuthoritiesBuildSettings, AuthoritiesSettings, AuthoritiesDocumentSnapshot, AuthoritiesImport,
  AuthoritiesCover, AuthoritySourceIdentity, AuthorityHighlightExclusion, AuthoritiesProfile,
  AuthorityIdentity, AuthoritiesReviewUnit, AuthorityTextSpan, AuthorityCitationLedger,
  AuthorityOccurrence, AuthoritiesDiscrepancyAction, AuthoritiesDraft, AuthoritySeed,
  AuthoritiesLedgerOccurrence,
} from "mike/shared/authorities-contract.d.ts";
export type {
  AuthorityKind, AuthoritiesOutputMode, AuthoritiesSourceMode, AuthoritiesProfileId, AuthoritiesBookRole,
  AuthoritiesBuildSettings, AuthoritiesSettings, AuthoritiesDocumentSnapshot, AuthoritiesImport,
  AuthoritiesCover, AuthoritySourceIdentity, AuthorityHighlightExclusion, AuthoritiesProfile,
  AuthorityIdentity, AuthoritiesReviewUnit, AuthorityTextSpan, AuthorityCitationLedger,
  AuthorityOccurrence, AuthoritiesDiscrepancyAction, AuthoritiesDraft, AuthoritySeed,
  AuthoritiesLedgerOccurrence,
};

import { attachAuthoritySource, attachedAuthoritySources,
  authoritiesBookPdfs, removeUnusedBinding, replaceSource } from "mike/shared/authorities-sources.mjs";
import type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritySourceDecision,
  AuthoritiesBoundPdf, AuthoritiesBookParts,
  AuthoritiesBookSupplement } from "mike/shared/authorities-sources.mjs";
export { attachedAuthoritySources, federalEnactmentCitation, hasBilingualAuthoritySource,
  authoritiesBookPdfs, authorityBytesRequired, authorityReproducedInBook,
  authoritySourceRequirement, authoritySourceUrl,
  bilingualEnactmentRequired } from "mike/shared/authorities-sources.mjs";
export type { AuthoritySourceLanguage, AttachedAuthoritySource, AuthoritySourceDecision,
  AuthoritiesBoundPdf, AuthoritiesBookSupplement, AuthoritiesBookParts } from "mike/shared/authorities-sources.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { buildCanliiPdfUrl } from "./canliiUrls";
import { sha256 } from "./hash";
import { decodeWorkProductBindings, type WorkProductInput } from "./workProduct";
import { closed, dictionary, flag, hash, integer, isJsonRecord, jsonRecord, list, literal,
  maybe, nonempty, nullable, oneOf, plain, tagged, text, trimmed,
  type Check, type FieldTable } from "./value";
import profileValues from "mike/shared/authorities-profiles.json";

import { AUTHORITIES_ACTION_CHOICES, AUTHORITIES_SETTINGS_CHOICES, authorityKinds,
  decodeAuthoritiesInitialSettings } from "./authoritiesActionContract";
export { AUTHORITIES_BOOK_ROLES, authoritiesProfileIds } from "./authoritiesActionContract";
/** Filing defaults only; source receipts remain in the repository audit data. */
const authoritiesProfiles = profileValues as AuthoritiesProfile[];
const AUTHORITIES_PROFILES = new Map(authoritiesProfiles.map((profile) => [profile.id, profile]));
export function authoritiesProfile(id: AuthoritiesProfileId) {
  const profile = AUTHORITIES_PROFILES.get(id);
  if (!profile) throw new AuthoritiesDomainError(`Unknown Authorities profile: ${id}`);
  return profile;
}

import { decodeAnnotationSet, type PdfAnnotationSet } from "mike/shared/pdf-annotations.mjs";

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
  | { type: "add-occurrence"; occurrence: AuthorityOccurrence }
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
const sourceHash: Check = (value) => typeof value === "string" && exactSourceHash(value);
const strings = list(50_000, text);
const pair: Check = (value) => Array.isArray(value) && value.length === 2 &&
  Array.from(value).every(integer);
const choice = (key: keyof typeof AUTHORITIES_SETTINGS_CHOICES): Check =>
  oneOf(AUTHORITIES_SETTINGS_CHOICES[key]);

const settingsShape = closed<AuthoritiesSettings>({
  profileId: text, sourceMode: choice("sourceMode"), tabStyle: choice("tabStyle"),
  tabStart: maybe(integer), tabPrefix: maybe(text), tabLabels: maybe(list(10_000, text)),
  allowIncomplete: maybe(flag), tableOrder: choice("tableOrder"),
  tableDelivery: choice("tableDelivery"), tableLocation: choice("tableLocation"),
  passageMarking: choice("passageMarking"), scannedPdfPolicy: choice("scannedPdfPolicy"),
  missingSourcePolicy: choice("missingSourcePolicy"), filingMedium: maybe(choice("filingMedium")),
  bookRole: maybe(choice("bookRole")),
});
/** Settings the chosen profile actually offers, read back through its own decoder. */
const buildSettings: Check = (item) => {
  if (!settingsShape(item)) return false;
  const profile = AUTHORITIES_PROFILES.get(item.profileId);
  const filingMedia = profile?.options?.filingMedium?.map(({ value }) => value);
  const bookRoles = profile?.options?.bookRole?.map(({ value }) => value);
  const context = filingMedia
    ? oneOf(filingMedia)(item.filingMedium) : !Object.hasOwn(item, "filingMedium");
  const roleContext = bookRoles
    ? profile?.id === "federal-court" && !Object.hasOwn(item, "bookRole") ||
      oneOf(bookRoles)(item.bookRole)
    : !Object.hasOwn(item, "bookRole");
  if (!profile || !context || !roleContext ||
      profile.requirements?.markedPassages && item.passageMarking === "none") return false;
  try { decodeAuthoritiesInitialSettings(item); return true; }
  catch { return false; }
};

const boundPdfFields = { bindingRole: trimmed(200), filename: trimmed(500),
  sourceSha256: hash } satisfies FieldTable<AuthoritiesBoundPdf>;
const boundPdf = closed<AuthoritiesBoundPdf>(boundPdfFields);
const bookSupplement = closed<AuthoritiesBookSupplement>({ id: trimmed(200), ...boundPdfFields });
const bookParts = closed<AuthoritiesBookParts>({ cover: nullable(boundPdf),
  index: nullable(boundPdf), supplements: list(500, bookSupplement) });

const partyGroup = closed<AuthoritiesCover["partyGroups"][number]>({ role: plain(100),
  parties: list(50, plain(500)) });
const authoritiesCover = closed<AuthoritiesCover>({ courtFileNumber: plain(100),
  applicationUnder: plain(2_000), title: plain(500), partyGroups: list(50, partyGroup) });

const authorityKind = oneOf(authorityKinds);
const pinpoint = closed<AuthorityOccurrence["pinpoints"][number]>({
  kind: oneOf(AUTHORITIES_ACTION_CHOICES.locator), text });
const locator = closed<AuthorityHighlightExclusion>({ kind: text, label: text });
const snapshot = closed<AuthoritiesDocumentSnapshot>({ documentId: nonempty(200),
  versionId: nonempty(200), sha256: sourceHash });
const importedDocument = tagged<AuthoritiesImport>({ manual: {},
  document: { bindingRole: literal("source"), filename: nonempty(500),
    fileType: oneOf(["docx", "pdf"]), snapshot: nullable(snapshot) } });

const sourceIdentity = closed<AuthoritySourceIdentity>({ provider: text, stableSourceId: text,
  sourceSha256: sourceHash, version: nullable(text), externalUrl: nullable(text) });
const attachedSource = closed<AttachedAuthoritySource>({ bindingRole: text, filename: text,
  sourceSha256: text, sourceUrl: nullable(text),
  origin: oneOf(["manual", "original", "reconstructed"]),
  language: oneOf(["en", "fr", "bilingual"]) });
const decisionShape = tagged<AuthoritySourceDecision>({ unresolved: {}, resolved: {},
  attached: { sources: list(50_000, attachedSource) },
  "pending-canlii": { authorityKey: text, pageUrl: text, pdfUrl: text } });
/** One source per language, and a bilingual source stands alone. */
const sourceDecision: Check = (value) => {
  if (!decisionShape(value)) return false;
  if (value.kind !== "attached") return true;
  const languages = value.sources.map(({ language }) => language);
  return languages.length > 0 && languages.length <= 2 &&
    new Set(languages).size === languages.length &&
    (!languages.includes("bilingual") || languages.length === 1);
};

const seed = closed<AuthoritySeed>({ key: text, kind: authorityKind, provider: text,
  stableSourceId: text, sourceSha256: text, citation: text, name: nullable(text),
  version: nullable(text), externalUrl: nullable(text), evidenceIds: strings,
  locators: list(50_000, locator) });
const authorityShape = closed<AuthorityIdentity>({ id: text, key: text, kind: authorityKind,
  citation: text, name: nullable(text), displayName: nullable(text), evidenceIds: strings,
  locators: list(50_000, locator), sourceIdentity: nullable(sourceIdentity), excluded: flag,
  source: sourceDecision, highlightExclusions: maybe(list(500, locator)),
  annotations: maybe(isJsonRecord), userAdded: maybe(literal(true)),
  scanOnly: maybe(literal(true)) });
/** Import provenance and hand entry are exclusive: one authority is only ever one of them. */
const authority: Check = (value) =>
  authorityShape(value) && !(value.scanOnly && value.userAdded);

const spanFields = { start: integer, end: integer, text } satisfies FieldTable<AuthorityTextSpan>;
const authoritySpan = closed<AuthorityTextSpan>(spanFields);
const unitFields = { id: text, kind: oneOf(["body", "footnote"]), ordinal: integer,
  footnoteId: nullable(integer), footnoteRefs: list(50_000, pair),
  pageNumbers: list(50_000, integer), text,
} satisfies FieldTable<Omit<AuthoritiesReviewUnit, "occurrenceIds">>;
const reviewUnit = closed<AuthoritiesReviewUnit>({ ...unitFields, occurrenceIds: strings });
const reference = closed<NonNullable<AuthorityOccurrence["reference"]>>({
  kind: oneOf(AUTHORITIES_ACTION_CHOICES.reference), targetAuthorityId: text });
const occurrence = closed<AuthorityOccurrence>({ id: text, unitId: text, ...spanFields,
  authoritySpan, coreSpan: authoritySpan, pinpointSpan: nullable(authoritySpan),
  kind: (value) => authorityKind(value) || value === "reference", citation: text,
  authorityId: nullable(text), reference: nullable(reference),
  pinpoints: list(50_000, pinpoint), evidenceIds: strings, sourceTextSha256: text,
  localOrdinal: integer, reviewed: flag });
const ledgerOccurrence = closed<AuthoritiesLedgerOccurrence>({ id: text, markerId: text,
  targetId: text, authorityKey: text,
  unit: closed<AuthoritiesLedgerOccurrence["unit"]>({ ...unitFields, sourceTextSha256: text }),
  ...spanFields, displayedForm: oneOf(["full", "short", "supra", "ibid"]),
  pinpoints: list(50_000, pinpoint), evidenceIds: strings, localOrdinal: integer });
const ledger = closed<AuthorityCitationLedger>({
  schemaVersion: literal("beaver.authority-ledger.v1"), document: snapshot,
  seeds: list(50_000, seed), occurrences: list(50_000, ledgerOccurrence) });

const draftShape = closed<AuthoritiesDraft>({
  schemaVersion: literal("beaver.authorities-draft.v1"), import: importedDocument,
  bindings: (value) => !!decodeWorkProductBindings(value),
  outputMode: oneOf(AUTHORITIES_ACTION_CHOICES.outputMode),
  stage: maybe(oneOf(AUTHORITIES_ACTION_CHOICES.stage)),
  settings: buildSettings, cover: authoritiesCover, bookParts,
  insertIntoDocument: flag, ledger: nullable(ledger), units: list(50_000, reviewUnit),
  occurrences: dictionary(occurrence), authorities: dictionary(authority),
  authorityOrder: list(50_000, nonempty(200)),
  discrepancyDecisions: dictionary(oneOf(AUTHORITIES_ACTION_CHOICES.discrepancy), hash),
});

/** Rejects malformed generic JSON before it can enter the typed Authorities reducer. */
export function decodeAuthoritiesDraft(value: unknown): AuthoritiesDraft | null {
  try {
    return draftShape(value) && !validateAuthoritiesDraft(value).length ? value : null;
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

/**
 * A detection nothing points at any more: the scan's leavings once the user has
 * rejected or re-spanned the citation it came from. An authority an occurrence
 * still cites - directly or as the target of a supra or ibid - is in the
 * document, so it is never swept away.
 */
export function unusedScanOnlyAuthority(draft: AuthoritiesDraft, id: string) {
  const authority = draft.authorities[id];
  return !!authority?.scanOnly &&
    !attachedAuthoritySources(authority.source).some(({ origin }) => origin === "manual") &&
    !authority.evidenceIds.length && !authority.displayName && !authority.excluded &&
    !authority.locators.length &&
    !Object.values(draft.occurrences).some(({ authorityId, reference }) =>
      authorityId === id || reference?.targetAuthorityId === id);
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

/** Carries a source identity or a source PDF: the user's resolution, not scan leavings. */
const resolvedAuthority = (authority: AuthorityIdentity) => !!authority.sourceIdentity ||
  attachedAuthoritySources(authority.source).length > 0;

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
    cover: structuredClone(cover), ledger: null,
    discrepancyDecisions: { ...draft.discrepancyDecisions } };
  // "Not a citation" holds only while the user leaves that text alone. A citation
  // put back over the same words - by hand, by a span correction, by a split -
  // withdraws the decision, which is otherwise unreachable: its id is a digest of
  // the detection's own ordinal, which no later gesture can name.
  const restored = (item: AuthorityOccurrence) => Object.values(draft.occurrences).some(
    (kept) => kept.unitId === item.unitId && kept.sourceTextSha256 === item.sourceTextSha256 &&
      kept.start < item.end && item.start < kept.end);
  for (const item of Object.values(fresh.occurrences)) {
    const decision = ignoredOccurrenceKey(item);
    if (draft.discrepancyDecisions[decision] !== "ignore") continue;
    if (restored(item)) delete fresh.discrepancyDecisions[decision];
    else replaceOccurrences(fresh, [item.id], []);
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
  // Two entries for one citation key are one authority: the resolved one - the
  // one carrying a source identity or a source PDF - is the survivor the fresh
  // scan inherits from, never an unresolved twin listed beside it.
  const byKey = (items: AuthorityIdentity[]) => {
    const map = new Map<string, AuthorityIdentity>();
    for (const item of items) {
      const held = map.get(item.key);
      if (!held || !resolvedAuthority(held) && resolvedAuthority(item)) map.set(item.key, item);
    }
    return map;
  };
  const oldByKey = byKey(Object.values(draft.authorities));
  const freshByKey = byKey(Object.values(fresh.authorities));
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
  // A re-scan sweeps up its own leavings, never the user's resolutions: rejecting
  // a citation is a decision they make, not something a refresh makes for them.
  for (const id of fresh.authorityOrder) {
    if (unusedScanOnlyAuthority(fresh, id) && !resolvedAuthority(fresh.authorities[id])) {
      delete fresh.authorities[id];
    }
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
    case "add-occurrence": {
      const item = structuredClone(action.occurrence);
      const unit = draft.units.find(({ id }) => id === item.unitId);
      if (!unit) throw new AuthoritiesDomainError(`Unknown unit: ${item.unitId}`);
      if (draft.occurrences[item.id]) throw new AuthoritiesDomainError("This citation is already on the review list.");
      if (item.start < 0 || item.end <= item.start || item.end > unit.text.length ||
          unit.occurrenceIds.some((id) => draft.occurrences[id] &&
            item.start < draft.occurrences[id].end && draft.occurrences[id].start < item.end)) {
        throw new AuthoritiesDomainError("A new citation must cover free text inside its review unit.");
      }
      const after = unit.occurrenceIds.findIndex((id) => draft.occurrences[id]?.start >= item.end);
      draft.occurrences[item.id] = item;
      unit.occurrenceIds.splice(after < 0 ? unit.occurrenceIds.length : after, 0, item.id);
      break;
    }
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
  if (draft.import.kind === "document" && ["add-occurrence", "split-occurrence", "merge-occurrences", "replace-occurrence", "remove-occurrence",
    "relink-occurrence", "set-reference"].includes(action.type)) draft.stage = "citations";
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
        const values = jsonRecord(authority.annotations);
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
