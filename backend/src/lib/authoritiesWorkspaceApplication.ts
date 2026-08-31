import { ApplicationError, type ApplicationScope } from "./applicationError";
import { buildAuthorities, type AuthoritiesBuildResult } from "./authoritiesBuild";
import {
  AuthoritiesDomainError,
  decodeAuthoritiesDraft,
  reduceAuthoritiesDraft,
  type AuthoritiesAction,
  type AuthoritiesDraft,
  type AuthoritiesFreshReview,
  type AuthorityIdentity,
  type AuthorityKind,
  type AuthorityOccurrence,
} from "./authoritiesDomain";
import {
  createAuthoritiesImporter,
  type AuthoritiesImporter,
  type AuthoritiesImportSource,
  type GroundedReceiptSeed,
} from "./authoritiesImport";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";
import type { DocumentFile, DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import {
  a2ajLegalSourceProvider,
  stableA2AJSourceId,
} from "./legalSources/a2aj";
import { downloadProviderPdfAttachment } from "./providerPdfLibraryBridge";
import { structureNative } from "./structureNative";
import type { ResolvedWorkProductInput, WorkProduct, WorkProductOutputRef,
  WorkProductState } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

type AuthoritiesProduct = Extract<WorkProduct, { kind: "authorities" }>;
type PublicDomainAction = Exclude<AuthoritiesAction, {
  type: "ingest-ledger" | "add-seed" | "add-authority" | "resolve-authority" |
    "attach-source" | "begin-canlii-handoff" | "split-occurrence" |
    "merge-occurrences" | "refresh";
}>;
export type AuthoritiesUserAction = PublicDomainAction |
  { type: "add-authority"; kind: AuthorityKind; citation: string; name?: string | null } |
  { type: "begin-canlii-handoff"; authorityId: string } |
  { type: "split-occurrence"; occurrenceId: string; cursor: number } |
  { type: "merge-occurrence"; occurrenceId: string };

const sourceServices = {
  resolve: (citation: string, kind: "case" | "legislation") =>
    a2ajLegalSourceProvider.document({ citation,
    docType: kind === "case" ? "cases" : "laws" }),
  download: downloadProviderPdfAttachment,
  key: (value: string) => structureNative().citationLookupKey(value),
  occurrences: (value: string) => structureNative().citationOccurrencesInText(value),
  revision: (document: Parameters<ReturnType<typeof structureNative>["documentRevision"]>[0]) =>
    structureNative().documentRevision(document),
};
type SourceServices = typeof sourceServices;
type CitationServices = Pick<SourceServices, "key" | "occurrences">;

function draftState(state: WorkProductState): AuthoritiesDraft {
  const draft = decodeAuthoritiesDraft(state);
  if (!draft) throw new ApplicationError(409, "Authorities draft state is invalid");
  return draft;
}

const review = (draft: AuthoritiesDraft): AuthoritiesFreshReview => ({
  import: draft.import, bindings: draft.bindings, units: draft.units,
  occurrences: draft.occurrences, authorities: draft.authorities,
  authorityOrder: draft.authorityOrder,
});

function update(draft: AuthoritiesDraft, action: AuthoritiesAction) {
  try { return reduceAuthoritiesDraft(draft, action); }
  catch (error) {
    if (error instanceof AuthoritiesDomainError) throw new ApplicationError(400, error.message);
    throw error;
  }
}

const pdfFilename = (value: string) => `${value.trim().replace(
  /[<>:"/\\|?*\u0000-\u001f]/gu, "-",
).replace(/[. ]+$/u, "").slice(0, 180) || "Authority"}.pdf`;

function isCanliiUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.+$/u, "");
    return ["canlii.ca", "canlii.org"].some((domain) =>
      host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

async function concurrentMap<T, R>(items: T[], operation: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

const sameValue = (values: unknown[]) => values.length > 0 &&
  values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));

function manualOccurrence(draft: AuthoritiesDraft, unit: AuthoritiesDraft["units"][number],
  start: number, end: number, donors: AuthorityOccurrence[], sources: CitationServices) {
  while (start < end && /\s/u.test(unit.text[start])) start += 1;
  while (end > start && /\s/u.test(unit.text[end - 1])) end -= 1;
  if (start >= end) throw new ApplicationError(400,
    "The edit must leave citation text on both sides");
  const text = unit.text.slice(start, end);
  const matches = sources.occurrences(text), match = matches.length === 1 ? matches[0] : null;
  const key = match ? sources.key(match.coreCitation.text) : null;
  const authority = key ? Object.values(draft.authorities).find((item) => item.key === key) : null;
  const donorIds = donors.map(({ authorityId }) => authorityId);
  const authorityId = authority?.id ?? (sameValue(donorIds) ? donorIds[0] : null);
  const donorReferences = donors.map(({ reference }) => reference);
  const reference = sameValue(donorReferences) && /\b(?:ibid|supra)\b/iu.test(text)
    ? structuredClone(donorReferences[0]) : null;
  const occurrence: AuthorityOccurrence = {
    id: `${unit.id}:manual:${start}:${end}`, unitId: unit.id, start, end, text,
    kind: reference ? "reference" : match
      ? match.kind === "statute" ? "legislation"
        : match.kind === "journal" ? "commentary" : match.kind
      : sameValue(donors.map(({ kind }) => kind)) ? donors[0].kind : "other",
    citation: match?.coreCitation.text ??
      (sameValue(donors.map(({ citation }) => citation)) ? donors[0].citation : text.trim()),
    authorityId, reference,
    pinpoints: match?.pinpoints.map(({ kind, text }) => ({ kind, text })) ?? [],
    evidenceIds: [...new Set(donors.flatMap(({ evidenceIds }) => evidenceIds))].sort(),
    sourceTextSha256: donors[0].sourceTextSha256, localOrdinal: start, reviewed: true,
  };
  const discovered: AuthorityIdentity | null = match && key && !authority ? {
    id: key, key,
    kind: match.kind === "statute" ? "legislation"
      : match.kind === "journal" ? "commentary" : match.kind,
    citation: match.coreCitation.text,
    name: match.reasons.includes("same_text_style") ? match.shortForm?.trim() || null : null,
    displayName: null, excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
    source: { kind: "unresolved" },
  } : null;
  if (discovered) occurrence.authorityId = discovered.id;
  return { occurrence, discovered };
}

function editOccurrences(draft: AuthoritiesDraft,
  action: Extract<AuthoritiesUserAction,
    { type: "split-occurrence" | "merge-occurrence" }>, sources: CitationServices) {
  const occurrence = draft.occurrences[action.occurrenceId];
  const unit = occurrence && draft.units.find(({ id }) => id === occurrence.unitId);
  if (!occurrence || !unit || unit.kind !== "footnote") {
    throw new ApplicationError(400, "Only a footnote citation can be split or merged");
  }
  let replacements: ReturnType<typeof manualOccurrence>[], ids: [string, string];
  if (action.type === "split-occurrence") {
    if (!Number.isSafeInteger(action.cursor) || action.cursor <= occurrence.start ||
        action.cursor >= occurrence.end) throw new ApplicationError(400,
      "Place the cursor inside this footnote citation");
    replacements = [manualOccurrence(draft, unit, occurrence.start, action.cursor,
      [occurrence], sources), manualOccurrence(draft, unit, action.cursor, occurrence.end,
      [occurrence], sources)];
    ids = [occurrence.id, occurrence.id];
  } else {
    const position = unit.occurrenceIds.indexOf(occurrence.id);
    const previous = position > 0 ? draft.occurrences[unit.occurrenceIds[position - 1]] : null;
    if (!previous) throw new ApplicationError(400,
      "This is the first citation in the footnote");
    replacements = [manualOccurrence(draft, unit, previous.start, occurrence.end,
      [previous, occurrence], sources)];
    ids = [previous.id, occurrence.id];
  }
  let changed = draft;
  for (const { discovered } of replacements) {
    if (discovered && !changed.authorities[discovered.id]) changed = update(changed,
      { type: "add-authority", authority: discovered });
  }
  return action.type === "split-occurrence"
    ? update(changed, { type: "split-occurrence", occurrenceId: action.occurrenceId,
      replacements: [replacements[0].occurrence, replacements[1].occurrence] })
    : update(changed, { type: "merge-occurrences", occurrenceIds: ids,
      replacement: replacements[0].occurrence });
}

export function applyAuthoritiesUserAction(
  draft: AuthoritiesDraft,
  action: AuthoritiesUserAction,
  sources: CitationServices = sourceServices,
) {
  if (action.type === "add-authority") {
    const citation = action.citation.trim(), key = sources.key(citation);
    return update(draft, { type: action.type, authority: { id: key, key,
      kind: action.kind, citation, name: action.name?.trim() || null,
      displayName: null, excluded: false, evidenceIds: [], locators: [],
      sourceIdentity: null, source: { kind: "unresolved" } } });
  }
  if (action.type === "begin-canlii-handoff") {
    const authority = draft.authorities[action.authorityId];
    const pageUrl = authority && buildCanliiCaseUrlFromCitation([authority.citation]);
    if (!authority || !pageUrl) throw new ApplicationError(409,
      "A canonical CanLII link is not available for this authority");
    return update(draft, { ...action, pageUrl });
  }
  return action.type === "split-occurrence" || action.type === "merge-occurrence"
    ? editOccurrences(draft, action, sources) : update(draft, action);
}

export function createAuthoritiesWorkspaceApplication(
  documents: DocumentStore,
  workProducts: WorkProductApplication,
  files: WorkflowFiles,
  builder: typeof buildAuthorities = buildAuthorities,
  importer: AuthoritiesImporter = createAuthoritiesImporter(documents),
  sources: SourceServices = sourceServices,
) {
  async function open(scope: ApplicationScope, id: string) {
    const found = await workProducts.get(scope, id);
    if (found.kind !== "authorities") throw new ApplicationError(404,
      "Authorities draft not found");
    return { product: found, draft: draftState(found.state) };
  }

  async function edit(scope: ApplicationScope, id: string, revision: number) {
    const current = await open(scope, id);
    if (current.product.revision !== revision) throw new ApplicationError(409,
      "This draft changed. Reload it before saving.", {
        current_revision: String(current.product.revision),
      });
    return current;
  }

  async function withRollback<T>(scope: ApplicationScope, ids: string[], save: () => Promise<T>) {
    try { return await save(); }
    catch (error) {
      await Promise.all(ids.map((id) => documents.deleteDocument(scope, id)));
      throw error;
    }
  }

  async function resolveSources(scope: ApplicationScope, initial: AuthoritiesDraft,
    projectId?: string | null) {
    let draft = initial;
    const created: string[] = [];
    const candidates = draft.authorityOrder.flatMap((id) => {
      const authority = draft.authorities[id];
      return authority && ["case", "legislation"].includes(authority.kind) &&
        ["unresolved", "resolved"].includes(authority.source.kind) &&
        !(authority.sourceIdentity && authority.sourceIdentity.provider !== "a2aj")
        ? [{ id, authority }] : [];
    });
    const resolutions = await concurrentMap(candidates, async ({ authority }) => {
      try {
        const source = await sources.resolve(authority.citation,
          authority.kind as "case" | "legislation");
        if (!source) return { source: null };
        const revision = sources.revision(source.native);
        if (authority.sourceIdentity &&
            authority.sourceIdentity.sourceSha256 !== revision) return { mismatch: true as const };
        const verifiedPdf = source.verifiedPdf && !isCanliiUrl(source.verifiedPdf.url)
          ? source.verifiedPdf : null;
        let downloaded: Awaited<ReturnType<SourceServices["download"]>> | undefined;
        if (verifiedPdf) {
          try {
            downloaded = await sources.download({ provider: "a2aj",
              identity: stableA2AJSourceId(source), url: verifiedPdf.url,
              canonicalUrl: source.url, filename: pdfFilename(source.name ?? source.citation),
              title: source.name, version: source.date });
            if (sha256(downloaded.bytes) !== downloaded.sourceSha256) downloaded = undefined;
          } catch { /* A verified PDF can be retried on refresh. */ }
        }
        return { source: verifiedPdf === source.verifiedPdf ? source
          : { ...source, verifiedPdf }, revision, downloaded };
      } catch { return { unavailable: true as const }; }
    });
    for (let index = 0; index < candidates.length; index += 1) {
      const { id, authority } = candidates[index], resolved = resolutions[index];
      if ("unavailable" in resolved || "mismatch" in resolved) continue;
      if (!resolved.source) {
        const pageUrl = authority.kind === "case"
          ? buildCanliiCaseUrlFromCitation([authority.citation]) : null;
        if (pageUrl && authority.source.kind === "unresolved") {
          draft = update(draft, { type: "begin-canlii-handoff", authorityId: id, pageUrl });
        }
        continue;
      }
      const source = resolved.source;
      draft = update(draft, { type: "resolve-authority", authorityId: id,
        citation: source.citation, name: source.name,
        source: { provider: "a2aj",
          stableSourceId: stableA2AJSourceId(source), sourceSha256: resolved.revision,
          version: source.date, externalUrl: source.url } });
      if (source.verifiedPdf) {
        let saved: Awaited<ReturnType<WorkflowFiles["create"]>> | null = null;
        try {
          const filename = pdfFilename(source.name ?? source.citation);
          if (!resolved.downloaded) continue;
          saved = await files.create(scope, "authorities", {
            filename, fileType: "pdf", bytes: resolved.downloaded.bytes,
          }, { projectId });
          draft = update(draft, { type: "attach-source", authorityId: id,
            bindingRole: `authority:${sha256(authority.key).slice(0, 24)}`,
            binding: { kind: "document", documentId: saved.id,
              version: { versionId: saved.current_version_id,
                sha256: saved.source_sha256 } },
            filename: saved.filename, sourceSha256: saved.source_sha256,
            sourceUrl: source.url ?? source.verifiedPdf.url });
          created.push(saved.id);
          continue;
        } catch {
          if (saved) await documents.deleteDocument(scope, saved.id).catch(() => false);
        }
        continue;
      }
      const pageUrl = authority.kind === "case" ? buildCanliiCaseUrlFromCitation([
        source.citation, source.alternateCitation, authority.citation,
      ], source.language) : null;
      if (pageUrl) draft = update(draft,
        { type: "begin-canlii-handoff", authorityId: id, pageUrl });
    }
    return { draft, created };
  }

  async function buildSources(scope: ApplicationScope, draft: AuthoritiesDraft) {
    const result: Record<string, { bytes?: Uint8Array;
      resolved?: ResolvedWorkProductInput }> = {};
    if (draft.import.kind === "document" && draft.import.snapshot) {
      const { bindingRole, snapshot, filename } = draft.import;
      const binding = draft.bindings[bindingRole];
      if (binding?.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
      const requested = binding.version === "latest" ? null : binding.version.versionId;
      const [source, history] = await Promise.all([
        documents.projectionSource(scope, binding.documentId, requested),
        documents.versions(scope, binding.documentId),
      ]);
      const version = history?.versions.find(({ id }) => id === source?.versionId);
      if (!source || !version || source.documentId !== snapshot.documentId ||
          source.versionId !== snapshot.versionId || source.sourceSha256 !== snapshot.sha256 ||
          version.source_sha256 !== snapshot.sha256) {
        throw new ApplicationError(409, "The imported document changed. Refresh before building.");
      }
      result[bindingRole] = { resolved: { kind: "document",
        documentId: source.documentId, versionId: source.versionId,
        filename: version.filename || filename, sha256: source.sourceSha256 } };
      if (draft.insertIntoDocument) {
        const file = await documents.read(scope, binding.documentId, source.versionId, false);
        if (!file || file.fileType.toLowerCase() !== "docx" ||
            file.version.source_sha256 !== snapshot.sha256 ||
            sha256(file.bytes) !== snapshot.sha256) {
          throw new ApplicationError(409, "The imported Word document changed. Refresh before building.");
        }
        result[bindingRole].bytes = file.bytes;
      }
    }
    const attached = Object.values(draft.authorities).flatMap(({ source }) =>
      source.kind === "attached" ? [source] : []);
    const needsBook = draft.outputMode !== "table";
    const bookRoles = new Set(Object.values(draft.authorities).flatMap(({ excluded, source }) =>
      needsBook && !excluded && source.kind === "attached" ? [source.bindingRole] : []));
    const preparation = new Map(bookRoles.size
      ? (await documents.parseStates(scope, [...bookRoles].flatMap((role) => {
        const binding = draft.bindings[role];
        return binding?.kind === "document" ? [binding.documentId] : [];
      }))).map((state) => [state.id, state.parse_state])
      : []);
    await Promise.all(attached.map(async (source) => {
      const binding = draft.bindings[source.bindingRole];
      if (binding?.kind !== "document") {
        throw new ApplicationError(409, `Attached PDF is unavailable: ${source.filename}`);
      }
      const versionId = binding.version === "latest" ? null : binding.version.versionId;
      const file = await documents.read(scope, binding.documentId, versionId, false);
      if (!file || file.fileType.toLowerCase() !== "pdf" ||
          file.version.source_sha256 !== source.sourceSha256 ||
          sha256(file.bytes) !== source.sourceSha256) {
        throw new ApplicationError(409, `Attached PDF changed: ${source.filename}`);
      }
      const forBook = bookRoles.has(source.bindingRole);
      if (forBook && !file.pdfProfile) {
        const state = preparation.get(binding.documentId);
        const pending = state?.status === "queued" || state?.status === "parsing";
        throw new ApplicationError(409, pending
          ? `${source.filename} is still being prepared.`
          : state?.error?.includes("password-protected")
            ? `${source.filename}: ${state.error}`
            : `${source.filename} could not be prepared. Remove any password or usage restrictions, then add it again.`,
        { document_id: binding.documentId,
          pdf_status: state?.status ?? "unprepared",
          pdf_phase: state?.phase,
          pdf_pages: state?.pages?.join(",") });
      }
      result[source.bindingRole] = { ...(forBook ? { bytes: file.bytes } : {}),
        resolved: { kind: "document",
        documentId: binding.documentId, versionId: file.version.id,
        filename: file.filename, sha256: file.version.source_sha256 } };
    }));
    return result;
  }

  return Object.freeze({
    list: (scope: ApplicationScope, options: { projectId?: string; limit?: number } = {}) =>
      workProducts.list(scope, { kind: "authorities", ...options }),
    async get(scope: ApplicationScope, id: string) {
      return (await open(scope, id)).product;
    },
    async saveFile(scope: ApplicationScope, file: DocumentFile, projectId?: string | null) {
      if (!["pdf", "docx"].includes(file.fileType.toLowerCase())) {
        throw new ApplicationError(400, "Add a PDF or Word document");
      }
      return files.create(scope, "authorities", file, { projectId });
    },
    async importDraft(scope: ApplicationScope, input: {
      source: AuthoritiesImportSource; title?: string; projectId?: string | null;
    }) {
      const resolved = await resolveSources(scope, await importer.draft(scope, input.source),
        input.projectId);
      const title = input.title ?? (resolved.draft.import.kind === "document"
        ? resolved.draft.import.filename.replace(/\.[^.]+$/u, "") || "Authorities"
        : "Authorities");
      return withRollback(scope, resolved.created, () => workProducts.create(scope,
        { kind: "authorities", title, projectId: input.projectId, state: resolved.draft }));
    },
    async addReceipts(scope: ApplicationScope, id: string, revision: number,
      seeds: readonly GroundedReceiptSeed[]) {
      const { product, draft } = await edit(scope, id, revision);
      const incoming = review(await importer.draft(scope, { kind: "receipts", seeds }));
      const current = review(draft);
      const changed = update(draft, { type: "refresh", review: {
        ...current,
        authorities: { ...current.authorities, ...incoming.authorities },
        authorityOrder: [...current.authorityOrder, ...incoming.authorityOrder.filter(
          (authorityId) => !current.authorities[authorityId],
        )],
      } });
      const resolved = await resolveSources(scope, changed, product.projectId);
      return withRollback(scope, resolved.created, () =>
        workProducts.save(scope, id, { revision, state: resolved.draft }));
    },
    async act(scope: ApplicationScope, id: string, revision: number,
      action: AuthoritiesUserAction) {
      const { product, draft } = await edit(scope, id, revision);
      const changed = applyAuthoritiesUserAction(draft, action, sources);
      const resolved = await resolveSources(scope, changed, product.projectId);
      return withRollback(scope, resolved.created, () =>
        workProducts.save(scope, id, { revision, state: resolved.draft }));
    },
    async refresh(scope: ApplicationScope, id: string, revision: number,
      receiptSeeds?: readonly GroundedReceiptSeed[]) {
      const { product, draft } = await edit(scope, id, revision);
      const binding = draft.import.kind === "document"
        ? draft.bindings[draft.import.bindingRole] : null;
      if (binding && binding.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
      if (!binding && !receiptSeeds?.length) return product;
      const source: AuthoritiesImportSource = binding ??
        { kind: "receipts", seeds: receiptSeeds! };
      const fresh = await importer.draft(scope, source);
      const resolved = await resolveSources(scope,
        update(draft, { type: "refresh", review: review(fresh) }), product.projectId);
      return withRollback(scope, resolved.created, () =>
        workProducts.save(scope, id, { revision, state: resolved.draft }));
    },
    async attachPdf(scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; file: DocumentFile;
    }) {
      if (input.file.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(400, "Attach a PDF file");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      const authority = draft.authorities[input.authorityId];
      if (!authority || authority.source.kind === "attached") {
        throw new ApplicationError(409, "This authority cannot accept that PDF");
      }
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId });
      try {
        const bindingRole = `authority:${sha256(authority.key).slice(0, 24)}`;
        const state = update(draft, { type: "attach-source", authorityId: authority.id,
          bindingRole, binding: { kind: "document", documentId: created.id,
            version: { versionId: created.current_version_id,
              sha256: created.source_sha256 } },
          filename: created.filename, sourceSha256: created.source_sha256,
          sourceUrl: authority.source.kind === "pending-canlii" ? authority.source.pdfUrl
            : authority.sourceIdentity?.externalUrl ?? null });
        return await workProducts.save(scope, id, { revision: input.revision, state });
      } catch (error) {
        try {
          if (!await documents.deleteDocument(scope, created.id)) {
            throw new Error("Created PDF could not be removed");
          }
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Attaching the PDF could not be completed");
        }
        throw error;
      }
    },
    async build(scope: ApplicationScope, id: string, revision: number):
      Promise<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildResult["receipt"] }> {
      const { product, draft } = await edit(scope, id, revision);
      let built: AuthoritiesBuildResult;
      try {
        built = await builder({ draft, title: product.title,
          workProduct: { id, revision }, sources: await buildSources(scope, draft) });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(409,
          error instanceof Error ? error.message : "Authorities could not be built");
      }
      const refs: Record<string, WorkProductOutputRef> = {};
      const rollback: Array<{ documentId: string; versionId?: string }> = [];
      try {
        for (const artifact of Object.values(built.artifacts).filter(
          (item): item is NonNullable<typeof item> => Boolean(item))) {
          const file = { filename: artifact.filename,
            fileType: artifact.role === "book" ? "pdf" : "docx", bytes: artifact.bytes,
            provenance: { schemaVersion: 1 as const, actor: "work-product" as const,
              action: "built" as const, receipt: artifact.receipt } };
          const existing = product.outputs[artifact.role];
          const version = existing
            ? await documents.addVersion(scope, existing.documentId, file) : null;
          if (version) {
            rollback.push({ documentId: existing!.documentId, versionId: version.id });
            if (version.source_sha256 !== artifact.sha256) {
              throw new Error("Saved Authorities output hash does not match its build");
            }
            refs[artifact.role] = { documentId: existing!.documentId, versionId: version.id };
          } else {
            const created = await files.create(scope, "authorities", file,
              { projectId: product.projectId });
            rollback.push({ documentId: created.id });
            if (created.source_sha256 !== artifact.sha256) {
              throw new Error("Saved Authorities output hash does not match its build");
            }
            refs[artifact.role] = { documentId: created.id,
              versionId: created.current_version_id };
          }
        }
        const saved = await workProducts.save(scope, id, { revision, outputs: refs });
        if (saved.kind !== "authorities") throw new ApplicationError(409,
          "Authorities draft state is invalid");
        return { product: saved, receipt: built.receipt };
      } catch (error) {
        const failures: unknown[] = [];
        for (const item of rollback.reverse()) {
          try {
            if (item.versionId) await documents.deleteVersion(scope,
              item.documentId, item.versionId);
            else await documents.deleteDocument(scope, item.documentId);
          } catch (cleanup) { failures.push(cleanup); }
        }
        if (failures.length) throw new AggregateError([error, ...failures],
          "Authorities output could not be saved or rolled back");
        throw error;
      }
    },
  });
}

export type AuthoritiesWorkspaceApplication =
  ReturnType<typeof createAuthoritiesWorkspaceApplication>;
