import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { buildCanliiPdfUrl } from "./canliiUrls";
import { decodeWorkProductBindings, type WorkProductInput,
  type WorkProductState } from "./workProduct";

export type AuthorityKind = "case" | "legislation" | "commentary" | "other";
export type AuthoritiesOutputMode = "table" | "book" | "both";

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
      sourceSha256: string; sourceUrl: string | null }
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
  | { type: "reorder-authorities"; authorityIds: string[] }
  | { type: "split-occurrence"; occurrenceId: string;
      replacements: [AuthorityOccurrence, AuthorityOccurrence] }
  | { type: "merge-occurrences"; occurrenceIds: [string, string];
      replacement: AuthorityOccurrence }
  | { type: "relink-occurrence"; occurrenceId: string; authorityId: string | null }
  | { type: "set-reference"; occurrenceId: string;
      reference: AuthorityOccurrence["reference"] }
  | { type: "resolve-authority"; authorityId: string; citation: string;
      name: string | null; source: AuthoritySourceIdentity }
  | { type: "attach-source"; authorityId: string; bindingRole: string;
      binding: WorkProductInput; filename: string; sourceSha256: string;
      sourceUrl: string | null }
  | { type: "begin-canlii-handoff"; authorityId: string; pageUrl: string }
  | { type: "set-output-mode"; outputMode: AuthoritiesOutputMode }
  | { type: "set-document-output"; enabled: boolean }
  | { type: "refresh"; review: AuthoritiesFreshReview };

export class AuthoritiesDomainError extends Error {}

export function createAuthoritiesDraft(
  source: AuthoritiesImport,
  bindings: Record<string, WorkProductInput> = {},
  outputMode: AuthoritiesOutputMode = "both",
): AuthoritiesDraft {
  const draft: AuthoritiesDraft = { schemaVersion: "beaver.authorities-draft.v1",
    import: source, bindings: structuredClone(bindings), outputMode,
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
    ["kind", "bindingRole", "filename", "sourceSha256", "sourceUrl"]) &&
    text(item.bindingRole) && text(item.filename) && text(item.sourceSha256) &&
    nullableText(item.sourceUrl);
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
    "evidenceIds", "locators", "sourceIdentity", "excluded", "source"]);
  return !!item && text(item.id) && text(item.key) && authorityKind(item.kind) &&
    text(item.citation) && nullableText(item.name) && nullableText(item.displayName) &&
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
    "localOrdinal", "reviewed"]);
  return !!item && text(item.id) && text(item.unitId) && integer(item.start) &&
    integer(item.end) && text(item.text) &&
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
      "insertIntoDocument", "ledger", "units", "occurrences", "authorities",
      "authorityOrder"]);
    const occurrences = object(draft?.occurrences), authorities = object(draft?.authorities);
    if (!draft || draft.schemaVersion !== "beaver.authorities-draft.v1" ||
        !importedDocument(draft.import) || !decodeWorkProductBindings(draft.bindings) ||
        !oneOf(draft.outputMode, ["table", "book", "both"]) ||
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
  evidenceIds: [...seed.evidenceIds],
  locators: structuredClone(seed.locators),
  sourceIdentity: { provider: seed.provider, stableSourceId: seed.stableSourceId,
    sourceSha256: seed.sourceSha256, version: seed.version, externalUrl: seed.externalUrl },
  excluded: false,
  source: { kind: "resolved" },
});

function requireRecord<T>(record: Record<string, T>, id: string, label: string): T {
  const value = record[id];
  if (!value) throw new AuthoritiesDomainError(`Unknown ${label}: ${id}`);
  return value;
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
    requireRecord(authorities, item.authorityKey, "ledger authority");
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
      kind: item.displayedForm === "supra" || item.displayedForm === "ibid"
        ? "reference" : authorities[item.authorityKey].kind,
      citation: authorities[item.authorityKey].citation,
      authorityId: item.authorityKey,
      reference: item.displayedForm === "supra" || item.displayedForm === "ibid"
        ? { kind: item.displayedForm, targetAuthorityId: item.authorityKey } : null,
      pinpoints: [...item.pinpoints], evidenceIds: [...item.evidenceIds],
      sourceTextSha256: item.unit.sourceTextSha256,
      localOrdinal: item.localOrdinal, reviewed: true,
    };
  }
  draft.ledger = structuredClone(ledger);
  draft.bindings = { [draft.import.bindingRole]: draft.bindings[draft.import.bindingRole] };
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
        authority.source.kind === "attached" && authority.source.bindingRole === role)) return;
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

function refresh(draft: AuthoritiesDraft, review: AuthoritiesFreshReview) {
  const fresh: AuthoritiesDraft = { ...draft, ...structuredClone(review), ledger: null };
  const oldByKey = new Map(Object.values(draft.authorities).map((item) => [item.key, item]));
  const freshByKey = new Map(Object.values(fresh.authorities).map((item) => [item.key, item]));
  const remap = new Map<string, string>();
  for (const authority of Object.values(fresh.authorities)) {
    const old = oldByKey.get(authority.key);
    if (!old) continue;
    remap.set(old.id, authority.id);
    authority.displayName = old.displayName;
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
  const oldGroups = groupOccurrences(Object.values(draft.occurrences));
  const newGroups = groupOccurrences(Object.values(fresh.occurrences));
  for (const [key, items] of newGroups) {
    const oldItems = oldGroups.get(key);
    if (items.length !== 1 || oldItems?.length !== 1) continue;
    const old = oldItems[0];
    const target = old.authorityId ? remap.get(old.authorityId) : undefined;
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
    case "relink-occurrence": {
      const occurrence = requireRecord(draft.occurrences, action.occurrenceId, "occurrence");
      if (action.authorityId) requireRecord(draft.authorities, action.authorityId, "authority");
      occurrence.authorityId = action.authorityId;
      if (occurrence.reference) occurrence.reference = action.authorityId
        ? { ...occurrence.reference, targetAuthorityId: action.authorityId } : null;
      occurrence.reviewed = true;
      break;
    }
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
      const authority = requireRecord(draft.authorities, action.authorityId, "authority");
      if (!action.citation.trim()) throw new AuthoritiesDomainError("Authority citation is required.");
      authority.citation = action.citation.trim();
      authority.name = action.name?.trim() || null;
      authority.sourceIdentity = structuredClone(action.source);
      replaceSource(draft, authority, { kind: "resolved" });
      break;
    }
    case "attach-source": {
      if (!action.bindingRole) throw new AuthoritiesDomainError("Attachment binding role is required.");
      draft.bindings[action.bindingRole] = structuredClone(action.binding);
      replaceSource(draft, requireRecord(draft.authorities, action.authorityId, "authority"), {
        kind: "attached", bindingRole: action.bindingRole, filename: action.filename,
        sourceSha256: action.sourceSha256, sourceUrl: action.sourceUrl,
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
    case "set-output-mode": draft.outputMode = action.outputMode; break;
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
  if (typeof draft.insertIntoDocument !== "boolean" || draft.insertIntoDocument &&
      (draft.import.kind !== "document" || draft.import.fileType !== "docx")) {
    errors.push("Word document output requires an imported Word document.");
  }
  if (draft.import.kind === "document" && !draft.bindings[draft.import.bindingRole]) {
    errors.push("Imported document binding is missing.");
  }
  const usedBindings = new Set<string>(draft.import.kind === "document"
    ? [draft.import.bindingRole] : []);
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
