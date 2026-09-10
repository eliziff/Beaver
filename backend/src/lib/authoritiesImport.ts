import { ApplicationError, type ApplicationScope } from "./applicationError";
import {
  authoritySeedFromReceipts,
  createAuthoritiesDraft,
  reduceAuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthoritiesCover,
  type AuthoritiesImport,
  type AuthoritiesSourceMode,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
} from "./authoritiesDomain";
import { sourceDocumentFields } from "mike/shared/court-record-source-fields.mjs";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { structureNative, type NativeAuthorityReferenceOccurrence,
  type NativeAuthorityTextUnit, type NativeCitationOccurrence } from "./structureNative";
import type { WorkProductInput } from "./workProduct";
import { citationAliasKeysBatch } from "./caselawCitator";

type DocumentInput = Extract<WorkProductInput, { kind: "document" }>;
type ProjectionReader = Pick<typeof documentProjectionService, "read">;
type AuthoritiesNative = Pick<ReturnType<typeof structureNative>,
  "docxAuthorityTextUnits" | "pdfAuthorityTextUnits" | "citationOccurrencesInText" |
  "authorityReferencesInText" | "citationLookupKey">;

export type GroundedReceiptSeed = {
  authorityKey: string;
  receipts: readonly LegalEvidenceReceipt[];
};

export type AuthoritiesImportSource = { kind: "manual" } | DocumentInput |
  { kind: "receipts"; seeds: readonly GroundedReceiptSeed[] };

type Span = { start: number; end: number };
function occurrenceSpans(unitText: string, authority: Span, core: Span,
  pinpoints: Span[], offset = 0) {
  const span = ({ start, end }: Span) => ({
    start: offset + start, end: offset + end,
    text: unitText.slice(offset + start, offset + end),
  });
  const ordered = [...pinpoints].sort((left, right) => left.start - right.start);
  return { authoritySpan: span(authority), coreSpan: span(core),
    pinpointSpan: ordered.length ? span({ start: ordered[0].start,
      end: ordered.at(-1)!.end }) : null };
}

export const nativeOccurrenceSpans = (match: NativeCitationOccurrence, text: string, offset = 0) =>
  occurrenceSpans(text, match.styledCitation, match.coreCitation, match.pinpoints, offset);
const nativeReferenceSpans = (match: NativeAuthorityReferenceOccurrence, text: string) =>
  occurrenceSpans(text, match.token, match.token, match.pinpoints);

function parallelCaseKeys(matches: NativeCitationOccurrence[], native: AuthoritiesNative) {
  const candidates = matches.filter(({ kind }) => kind !== "statute" && kind !== "journal")
    .map((match) => ({ match, key: native.citationLookupKey(match.coreCitation.text) }))
    .filter(({ key }) => key);
  const groups = new Map<string, Array<typeof candidates[number] & { closure: string[] }>>();
  const signatures = new Map<string, Set<string>>();
  citationAliasKeysBatch(candidates.map(({ match }) => match.coreCitation.text))
    .forEach((aliases, index) => {
      const candidate = candidates[index], closure = [...new Set(aliases)].sort();
      if (!candidate || !closure.includes(candidate.key)) return;
      const signature = closure.join("\0");
      groups.set(signature, [...(groups.get(signature) ?? []), { ...candidate, closure }]);
      signatures.set(candidate.key,
        new Set([...(signatures.get(candidate.key) ?? []), signature]));
    });
  const canonical = new Map<string, string>(), observed = new Set(candidates.map(({ key }) => key));
  for (const [signature, group] of groups) {
    const keys = [...new Set(group.map(({ key }) => key))];
    if (keys.length < 2 || !group.some(({ match }) => match.kind === "case") ||
      group[0].closure.some((key) => observed.has(key) &&
        (signatures.get(key)?.size !== 1 || !signatures.get(key)?.has(signature)))) continue;
    keys.forEach((key) => canonical.set(key, group[0].key));
  }
  return canonical;
}

function scanReview(
  imported: AuthoritiesImport,
  bindings: Record<string, WorkProductInput>,
  units: NativeAuthorityTextUnit[],
  native: AuthoritiesNative,
): AuthoritiesFreshReview {
  const occurrences: Record<string, AuthorityOccurrence> = {};
  const authorities: Record<string, AuthorityIdentity> = {};
  const authorityOrder: string[] = [];
  const aliases = new Map<string, Set<string>>();
  const footnoteAuthorities = new Map<number, Set<string>>();
  let lastAuthorityId: string | null = null;
  const parsed = units.map((unit) => ({ unit, items: [
    ...native.citationOccurrencesInText(unit.text)
      .map((match) => ({ kind: "authority" as const, match })),
    ...native.authorityReferencesInText(unit.text)
      .map((match) => ({ kind: "reference" as const, match })),
  ].sort((left, right) => left.match.start - right.match.start ||
    left.match.end - right.match.end || left.kind.localeCompare(right.kind)) }));
  const parallelCases = parallelCaseKeys(parsed.flatMap(({ items }) => items.flatMap((item) =>
    item.kind === "authority" ? [item.match] : [])), native);
  const remember = (authorityId: string, footnoteId: number | null) => {
    lastAuthorityId = authorityId;
    if (footnoteId !== null) footnoteAuthorities.set(footnoteId,
      new Set([...(footnoteAuthorities.get(footnoteId) ?? []), authorityId]));
  };
  const addAlias = (authorityId: string, value: string | null | undefined) => {
    const alias = value ? native.citationLookupKey(value) : "";
    if (alias) aliases.set(authorityId, new Set([...(aliases.get(authorityId) ?? []), alias]));
  };
  const reviewUnits = parsed.map(({ unit, items }) => {
    const occurrenceIds: string[] = [];
    const sourceTextSha256 = sha256(unit.text);
    items.forEach((item, localOrdinal) => {
      if (item.kind === "reference") {
        const match = item.match;
        const prefix = native.citationLookupKey(unit.text.slice(0, match.token.start));
        const named = authorityOrder.filter((authorityId) =>
          [...(aliases.get(authorityId) ?? [])].some((alias) => prefix.endsWith(alias)));
        const noted = match.noteNumber === undefined ? []
          : [...(footnoteAuthorities.get(match.noteNumber) ?? [])];
        const candidates = match.kind === "ibid" ? (lastAuthorityId ? [lastAuthorityId] : [])
          : match.noteNumber === undefined ? named
          : named.length ? noted.filter((authorityId) => named.includes(authorityId)) : noted;
        const authorityId = candidates.length === 1 ? candidates[0] : null;
        const id = `${unit.key}:${localOrdinal}`;
        occurrenceIds.push(id);
        occurrences[id] = { id, unitId: unit.key, start: match.start, end: match.end,
          text: match.text, ...nativeReferenceSpans(match, unit.text), kind: "reference",
          citation: match.token.text, authorityId,
          reference: authorityId ? { kind: match.kind, targetAuthorityId: authorityId } : null,
          pinpoints: match.pinpoints.map(({ kind, text }) => ({ kind, text })),
          evidenceIds: [], sourceTextSha256, localOrdinal, reviewed: Boolean(authorityId) };
        if (authorityId) remember(authorityId, unit.footnote_id);
        return;
      }
      const match = item.match;
      const observedKey = native.citationLookupKey(match.coreCitation.text);
      const key = parallelCases.get(observedKey) ?? observedKey;
      if (!key) return;
      const kind: AuthorityKind = parallelCases.has(observedKey) ? "case"
        : match.kind === "statute" ? "legislation"
        : match.kind === "journal" || match.kind === "book" ? "commentary"
        : match.kind === "parliamentary" ? "other" : match.kind;
      const observedName = match.reasons.includes("same_text_style")
        ? match.shortForm?.trim() || null : null;
      if (!authorities[key]) {
        authorities[key] = { id: key, key, kind, citation: match.coreCitation.text,
          name: observedName, displayName: null, excluded: false,
          evidenceIds: [], locators: [], sourceIdentity: null,
          source: { kind: "unresolved" }, scanOnly: true };
        authorityOrder.push(key);
      } else if (!authorities[key].name && observedName) {
        authorities[key].name = observedName;
      }
      addAlias(key, match.shortForm);
      addAlias(key, match.explicitShortForm);
      addAlias(key, observedName);
      const id = `${unit.key}:${localOrdinal}`;
      occurrenceIds.push(id);
      occurrences[id] = { id, unitId: unit.key, start: match.start, end: match.end,
        text: match.text, ...nativeOccurrenceSpans(match, unit.text),
        kind, citation: match.coreCitation.text, authorityId: key,
        reference: null, pinpoints: match.pinpoints.map(({ kind, text }) => ({ kind, text })),
        evidenceIds: [],
        sourceTextSha256, localOrdinal, reviewed: false };
      remember(key, unit.footnote_id);
    });
    return { id: unit.key, kind: unit.kind, ordinal: unit.ordinal,
      footnoteId: unit.footnote_id, pageNumbers: unit.page_numbers, text: unit.text,
      footnoteRefs: unit.footnote_refs, occurrenceIds };
  });
  return { import: imported, bindings, cover: importedCover(units), units: reviewUnits,
    occurrences, authorities, authorityOrder };
}

const COVER_ROLE = /^(applicants?|respondents?|appellants?|plaintiffs?|defendants?|petitioners?|interven(?:er|or)s?|moving part(?:y|ies)|responding part(?:y|ies))\s*:?$/iu;
/** The parties named in a filing's BETWEEN block, in the order and roles the cover prints them. */
function coverParties(opening: string): AuthoritiesCover["partyGroups"] {
  const lines = opening.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => /^between\s*:?$/iu.test(line));
  if (start < 0) return [];
  const groups: AuthoritiesCover["partyGroups"] = [];
  let names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (COVER_ROLE.test(line)) {
      const word = line.replace(/\s*:$/u, "").toLowerCase();
      const role = word.startsWith("interven") ? "Intervener" : word.replace(/s$|ies$/u, (end) => end === "ies" ? "y" : "")
        .replace(/^\w|\s\w/gu, (ch) => ch.toUpperCase());
      if (names.length) groups.push({ role, parties: names });
      names = [];
    } else if (/^(and|-\s*and\s*-|v\.?)$/iu.test(line)) continue;
    else if (/^[A-Z][A-Z\s]+$/u.test(line) && line.length > 12 && !names.length && groups.length) break;
    else names.push(line);
  }
  return groups;
}

function importedCover(units: NativeAuthorityTextUnit[]): AuthoritiesCover {
  const body = units.filter(({ kind }) => kind === "body");
  const firstPage = body.filter(({ page_numbers }) => page_numbers.includes(1));
  const opening = (firstPage.length ? firstPage : body.slice(0, 80))
    .map(({ text }) => text).join("\n");
  const fields = sourceDocumentFields(opening ? [opening] : []);
  return { courtFileNumber: fields?.cover.courtFileNumber ?? "",
    partyGroups: coverParties(opening),
    applicationUnder: fields?.cover.applicationUnder ?? "", title: "" };
}

async function documentDraft(
  scope: ApplicationScope,
  binding: DocumentInput,
  documents: DocumentStore,
  projection: ProjectionReader,
  native: AuthoritiesNative,
) {
  const latest = binding.version === "latest";
  const requestedVersion = binding.version === "latest" ? null : binding.version.versionId;
  const [source, current, history] = await Promise.all([
    documents.projectionSource(scope, binding.documentId, requestedVersion),
    latest ? documents.metadata(scope, binding.documentId) : null,
    latest ? null : documents.versions(scope, binding.documentId),
  ]);
  if (!source) throw new ApplicationError(404, "Document not found");
  const filename = current?.current_version_id === source.versionId
    ? current.filename : history?.versions.find(({ id }) => id === source.versionId)?.filename;
  if (typeof filename !== "string") {
    throw new ApplicationError(404, "Document version not found");
  }
  if (binding.version !== "latest" && source.sourceSha256 !== binding.version.sha256) {
    throw new ApplicationError(409, "Document version hash does not match its source");
  }
  const fileType = source.fileType.trim().toLowerCase();
  if (fileType !== "docx" && fileType !== "pdf") {
    throw new ApplicationError(409, "Authorities sources must be PDF or Word documents");
  }
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename, fileType, snapshot: { documentId: source.documentId,
      versionId: source.versionId, sha256: source.sourceSha256 } };
  const bindings = { source: binding };
  const storedLedger = source.provenance?.actor === "assistant"
    ? source.provenance.generation?.authorityLedger : undefined;
  if (storedLedger) {
    try {
      return reduceAuthoritiesDraft(createAuthoritiesDraft(imported, bindings), {
        type: "ingest-ledger", ledger: { ...storedLedger, document: imported.snapshot! },
      });
    } catch { /* Untrusted or stale provenance falls back to the Rust scan. */ }
  }
  let units: NativeAuthorityTextUnit[];
  if (fileType === "docx") {
    const bytes = await source.readBytes();
    if (sha256(bytes) !== source.sourceSha256) {
      throw new ApplicationError(409, "Document bytes do not match their version");
    }
    units = await native.docxAuthorityTextUnits(bytes);
  } else {
    units = native.pdfAuthorityTextUnits(await projection.read(source));
  }
  return reduceAuthoritiesDraft(createAuthoritiesDraft(imported, bindings), {
    type: "refresh", review: scanReview(imported, bindings, units, native),
  });
}

function receiptDraft(seeds: readonly GroundedReceiptSeed[]) {
  if (!seeds.length || seeds.some(({ authorityKey, receipts }) =>
    !authorityKey || !receipts.length)) {
    throw new ApplicationError(400, "Grounded receipt seeds are required");
  }
  let draft = createAuthoritiesDraft({ kind: "manual" });
  for (const { authorityKey, receipts } of seeds) {
    draft = reduceAuthoritiesDraft(draft, {
      type: "add-seed", seed: authoritySeedFromReceipts(authorityKey, receipts),
    });
  }
  return draft;
}

export function createAuthoritiesImporter(
  documents: DocumentStore,
  projection: ProjectionReader = documentProjectionService,
  native?: AuthoritiesNative,
) {
  return Object.freeze({
    async draft(scope: ApplicationScope, source: AuthoritiesImportSource) {
      return source.kind === "manual" ? createAuthoritiesDraft(source)
        : source.kind === "document"
        ? documentDraft(scope, source, documents, projection,
          native ?? structureNative())
        : receiptDraft(source.seeds);
    },
  });
}

/** Stateless local-runtime import; the browser remains the draft/file owner. */
export async function importStandaloneAuthoritiesFile(input: {
  filename: string; fileType: "docx" | "pdf"; bytes: Buffer; modified: number;
  sourceMode?: AuthoritiesSourceMode;
}, projection: ProjectionReader = documentProjectionService,
native: AuthoritiesNative = structureNative()) {
  const sourceSha256 = sha256(input.bytes);
  const binding: WorkProductInput = { kind: "local-file", handleId: "standalone",
    lastSeen: { name: input.filename, size: input.bytes.length,
      modified: input.modified, sha256: sourceSha256 } };
  let units: NativeAuthorityTextUnit[];
  if (input.fileType === "docx") units = await native.docxAuthorityTextUnits(input.bytes);
  else units = native.pdfAuthorityTextUnits(await projection.read({
    documentId: `standalone-${sourceSha256}`, versionId: sourceSha256,
    sourceSha256, fileType: input.fileType, readBytes: () => input.bytes,
  }));
  const imported: AuthoritiesImport = { kind: "document", bindingRole: "source",
    filename: input.filename, fileType: input.fileType, snapshot: null };
  const bindings = { source: binding };
  let initial = createAuthoritiesDraft(imported, bindings);
  if (input.sourceMode) initial = reduceAuthoritiesDraft(initial, { type: "set-settings",
    settings: { sourceMode: input.sourceMode } });
  return reduceAuthoritiesDraft(initial, {
    type: "refresh", review: scanReview(imported, bindings, units, native),
  });
}

export type AuthoritiesImporter = ReturnType<typeof createAuthoritiesImporter>;
