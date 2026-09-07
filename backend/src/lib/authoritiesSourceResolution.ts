import { ApplicationError } from "./applicationError";
import { authorityCitationServices, updateAuthoritiesDraft as update } from "./authoritiesActions";
import { renderAuthoritySourcePdf } from "./authoritiesBuild";
import { attachedAuthoritySources, authorityCitationForms, authoritiesProfile,
  federalEnactmentCitation, hasBilingualAuthoritySource,
  type AuthoritiesDraft, type AuthorityIdentity } from "./authoritiesDomain";
import { buildCanliiCaseUrlFromCitation, buildCanliiPdfUrl } from "./canliiUrls";
import { sha256 } from "./hash";
import { a2ajLegalSourceProvider, stableA2AJSourceId } from "./legalSources/a2aj";
import { downloadProviderOriginalPdf } from "./providerPdfLibraryBridge";
import { structureNative } from "./structureNative";

export const authoritySourceServices = {
  resolve: (citation: string, kind: "case" | "legislation", signal?: AbortSignal,
    language?: "en" | "fr") =>
    a2ajLegalSourceProvider.document({ citation,
    docType: kind === "case" ? "cases" : "laws", language, signal }),
  download: downloadProviderOriginalPdf,
  ...authorityCitationServices,
  revision: (document: Parameters<ReturnType<typeof structureNative>["documentRevision"]>[0]) =>
    structureNative().documentRevision(document),
};
export type SourceServices = typeof authoritySourceServices;

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

const bilingualEnactments = (draft: AuthoritiesDraft) =>
  !!authoritiesProfile(draft.settings.profileId).requirements?.bilingualEnactments;
const sourceIdentityLanguage = (authority: AuthorityIdentity) =>
  authority.sourceIdentity?.stableSourceId.match(/^a2aj:(en|fr):/u)?.[1] as
    "en" | "fr" | undefined;

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

export type PreparedAuthoritySource = {
  authorityId: string;
  filename: string;
  bytes: Buffer;
  sourceSha256: string;
  sourceUrl: string | null;
  origin: "original" | "reconstructed";
  language: "en" | "fr";
};

/** Resolves canonical identities and prepares source bytes without choosing a persistence adapter. */
export async function resolveAuthoritiesSources(
  initial: AuthoritiesDraft, sources: SourceServices = authoritySourceServices,
  signal?: AbortSignal,
) {
  let draft = initial;
  const attachments: PreparedAuthoritySource[] = [];
  const reconstruct = draft.settings.sourceMode !== "manual-originals";
  const originals = draft.settings.sourceMode !== "render";
  const needsPdf = draft.outputMode !== "table" || draft.insertIntoDocument &&
    !!authoritiesProfile(draft.settings.profileId).requirements?.unlinkedPdfTableSources &&
    draft.import.kind === "document" && draft.import.fileType === "pdf";
  const candidates = draft.authorityOrder.flatMap((id) => {
    const authority = draft.authorities[id];
    const incompleteEnactment = !!authority && bilingualEnactments(draft) &&
      authority.kind === "legislation" && federalEnactmentCitation(authority.citation) &&
      authority.sourceIdentity?.provider === "a2aj" &&
      !hasBilingualAuthoritySource(authority.source);
    return authority && !authority.excluded && ["case", "legislation"].includes(authority.kind) &&
      (["unresolved", "resolved", "pending-canlii"].includes(authority.source.kind) || incompleteEnactment) &&
      !(authority.sourceIdentity && authority.sourceIdentity.provider !== "a2aj")
      ? [{ id, authority }] : [];
  });
  const resolutions = await concurrentMap(candidates, async ({ id, authority }) => {
    signal?.throwIfAborted();
    let unavailable = false;
    for (const citation of authorityCitationForms(initial, id)) try {
      const source = await sources.resolve(citation,
        authority.kind as "case" | "legislation", signal, sourceIdentityLanguage(authority));
      if (!source) continue;
      const revision = sources.revision(source.native);
      if (authority.sourceIdentity &&
          authority.sourceIdentity.sourceSha256 !== revision) return {
        mismatch: true as const, revision,
      };
      return { source, revision };
    } catch { signal?.throwIfAborted(); unavailable = true; }
    return unavailable ? { unavailable: true as const } : { source: null };
  });
  type ResolvedSource = NonNullable<Awaited<ReturnType<SourceServices["resolve"]>>>;
  const resolvedSources = new Map<string, ResolvedSource>();
  for (let index = 0; index < candidates.length; index += 1) {
    signal?.throwIfAborted();
    const { id, authority } = candidates[index], resolved = resolutions[index];
    if ("mismatch" in resolved) throw new ApplicationError(409,
      `The legal source for ${authority.name ?? authority.citation} changed since this draft was saved. Add the current PDF before trying again.`, {
        authority_id: id, source_issue: "changed", source_provider: "a2aj",
        saved_source_sha256: authority.sourceIdentity?.sourceSha256,
        current_source_sha256: resolved.revision,
      });
    if ("unavailable" in resolved || !resolved.source) continue;
    const source = resolved.source;
    resolvedSources.set(stableA2AJSourceId(source), source);
    draft = update(draft, { type: "resolve-authority", authorityId: id,
      citation: source.citation, name: source.name,
      source: { provider: "a2aj", stableSourceId: stableA2AJSourceId(source),
        sourceSha256: resolved.revision, version: source.date, externalUrl: source.url } });
  }
  if (!needsPdf) return { draft, attachments };
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id], identity = authority?.sourceIdentity;
    if (authority?.kind === "case" && authority.source.kind === "resolved" &&
        identity?.provider !== "a2aj" && identity?.externalUrl &&
        buildCanliiPdfUrl(identity.externalUrl)) {
      draft = update(draft, { type: "begin-canlii-handoff", authorityId: id,
        pageUrl: identity.externalUrl });
    }
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const { id, authority } = candidates[index], current = draft.authorities[id],
      resolution = resolutions[index];
    if (!current || "mismatch" in resolution ||
        ("source" in resolution && resolution.source !== null) ||
        current.source.kind !== "unresolved") continue;
    const pageUrl = authority.kind === "case"
      ? buildCanliiCaseUrlFromCitation(authorityCitationForms(draft, id)) : null;
    if (pageUrl) draft = update(draft,
      { type: "begin-canlii-handoff", authorityId: id, pageUrl });
  }
  const unique = new Map<string, { authorityId: string; authority: AuthorityIdentity;
    source: ResolvedSource }>();
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id], identity = authority?.sourceIdentity;
    const source = identity?.provider === "a2aj"
      ? resolvedSources.get(identity.stableSourceId) : undefined;
    if (authority && ["resolved", "attached"].includes(authority.source.kind) && source &&
        !unique.has(identity!.stableSourceId)) {
      unique.set(identity!.stableSourceId, { authorityId: id, authority, source });
    }
  }
  const languageSources = (await concurrentMap([...unique.values()], async (item) => {
    const { authority, source } = item;
    const existing = new Set(attachedAuthoritySources(authority.source)
      .map(({ language }) => language));
    if (!bilingualEnactments(draft) || authority.kind !== "legislation" ||
        !federalEnactmentCitation(source.citation || authority.citation)) return [{ ...item,
          paired: false }];
    const language = source.language === "en" ? "fr" : "en";
    let companion: ResolvedSource | null = null;
    for (const citation of [source.citation, source.alternateCitation].filter(
      (value): value is string => !!value?.trim())) try {
      const resolved = await sources.resolve(citation, "legislation", signal, language);
      if (resolved?.language === language) { companion = resolved; break; }
    } catch { signal?.throwIfAborted(); }
    const documents = companion ? [source, companion].sort((left, right) =>
      left.language === "en" ? -1 : right.language === "en" ? 1 : 0) : [source];
    return documents.filter(({ language: found }) => !existing.has(found))
      .map((document) => ({ ...item, source: document,
        paired: documents.length === 2 || existing.size > 0 }));
  })).flat();
  const prepared = await concurrentMap(languageSources, async (item) => {
    signal?.throwIfAborted();
    const { authority, source } = item;
    const pdfUrl = source.verifiedPdf && !isCanliiUrl(source.verifiedPdf.url)
      ? source.verifiedPdf.url : null;
    const sourceUrl = source.url && !isCanliiUrl(source.url) ? source.url : null;
    let original: Awaited<ReturnType<SourceServices["download"]>> | undefined;
    if (originals && (pdfUrl || sourceUrl)) try {
      original = await sources.download({ provider: "a2aj",
        identity: stableA2AJSourceId(source), sourceUrl, pdfUrl,
        source: { provider: "a2aj", id: source.citation, kind: authority.kind as "case" | "legislation",
          citation: source.citation, alternateCitation: source.alternateCitation,
          title: source.name, date: source.date, collection: source.dataset,
          language: source.language, url: source.url },
        filename: pdfFilename(source.name ?? source.citation), title: source.name,
        version: source.date }, signal) ?? undefined;
      if (original && sha256(original.bytes) !== original.sourceSha256) {
        original = undefined;
      }
    } catch { signal?.throwIfAborted(); }
    let reconstructed: Buffer | null = null;
    if (reconstruct && !original && source.searchText.trim()) try {
      reconstructed = await renderAuthoritySourcePdf({ kind: authority.kind,
        name: source.name, citation: source.citation, date: source.date,
        sourceUrl: source.url, text: source.searchText });
    } catch { signal?.throwIfAborted(); }
    return { ...item, original, bytes: original?.bytes ?? reconstructed };
  });
  for (const { authorityId, authority, source, paired, original, bytes } of prepared) {
    if (!bytes) {
      const pageUrl = authority.kind === "case" && source.url && buildCanliiPdfUrl(source.url)
        ? source.url : authority.kind === "case" ? buildCanliiCaseUrlFromCitation([
          source.citation, source.alternateCitation,
          ...authorityCitationForms(draft, authorityId),
        ], source.language) : null;
      if (pageUrl) draft = update(draft,
        { type: "begin-canlii-handoff", authorityId, pageUrl });
      continue;
    }
    attachments.push({ authorityId,
      filename: pdfFilename(`${source.name ?? source.citation}${paired
        ? ` (${source.language === "en" ? "English" : "French"})` : ""}`), bytes,
      sourceSha256: sha256(bytes), sourceUrl: original
        ? original.url ?? source.verifiedPdf?.url ?? source.url : source.url ?? null,
      origin: original ? "original" : "reconstructed", language: source.language });
  }
  return { draft, attachments };
}
