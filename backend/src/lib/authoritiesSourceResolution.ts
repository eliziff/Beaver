import { ApplicationError } from "./applicationError";
import { authorityCitationServices, updateAuthoritiesDraft as update } from "./authoritiesActions";
import { renderAuthoritySourcePdf } from "./authoritiesBuild";
import { attachedAuthoritySources, authorityCitationForms, authoritiesProfile,
  federalEnactmentCitation, hasBilingualAuthoritySource,
  type AuthoritiesDraft, type AuthorityIdentity } from "./authoritiesDomain";
import { buildCanliiCaseUrlFromCitation, buildCanliiPdfUrl } from "./canliiUrls";
import { canonicalJsonSha256, sha256 } from "./hash";
import { a2ajLegalSourceProvider, stableA2AJSourceId } from "./legalSources/a2aj";
import { courtlistenerLegalSourceProvider } from "./legalSources/courtlistener";
import { tnaCaseSource, tnaLegalSourceProvider } from "./legalSources/tna";
import { downloadProviderOriginalPdf } from "./providerPdfLibraryBridge";
import { structureNative } from "./structureNative";

/**
 * Case providers for citations the Canadian corpus does not hold: UK neutral
 * citations through the National Archives, US reporter citations through the
 * local CourtListener bulk index. Each claims only what its own citation
 * grammar matches exactly and returns nothing when the match is ambiguous.
 */
const foreignProviders = [
  { id: "tna", claims: tnaLegalSourceProvider, source: tnaCaseSource },
  { id: "courtlistener", claims: courtlistenerLegalSourceProvider,
    source: courtlistenerLegalSourceProvider.caseSource },
] as const;

/** Resolves the first citation form a provider matches; never a best guess. */
async function resolveForeignAuthoritySource(citations: readonly string[], signal?: AbortSignal) {
  for (const citation of citations.map((value) => value.trim()).filter(Boolean)) {
    signal?.throwIfAborted();
    for (const { id, claims, source } of foreignProviders) {
      if (!claims.canResolve?.({ text: citation, kind: "case" })) continue;
      let found: Awaited<ReturnType<typeof source>> = null;
      try { found = await source(citation, signal); } catch { signal?.throwIfAborted(); }
      if (!found || (!found.pdfUrl && !found.text.trim())) continue;
      return { ...found, provider: id, name: found.title, stableSourceId: `${id}:${found.id}`,
        sourceSha256: canonicalJsonSha256({ provider: id, id: found.id, text: found.text }) };
    }
  }
  return null;
}

export const authoritySourceServices = {
  resolve: (citation: string, kind: "case" | "legislation", signal?: AbortSignal,
    language?: "en" | "fr") =>
    a2ajLegalSourceProvider.document({ citation,
    docType: kind === "case" ? "cases" : "laws", language, signal }),
  resolveForeign: resolveForeignAuthoritySource,
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
      (["unresolved", "resolved", "pending-canlii"].includes(authority.source.kind) || incompleteEnactment)
      ? [{ id, authority }] : [];
  });
  const resolutions = await concurrentMap(candidates, async ({ id, authority }) => {
    signal?.throwIfAborted();
    if (authority.sourceIdentity && authority.sourceIdentity.provider !== "a2aj") return { source: null };
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
  type ResolvedSource = Pick<NonNullable<Awaited<ReturnType<SourceServices["resolve"]>>>,
    "citation" | "alternateCitation" | "name" | "date" | "url" | "dataset" | "language" |
    "searchText" | "verifiedPdf"> & { provider?: string; identity?: string };
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
  // Authorities the Canadian corpus does not hold: US reporter and UK neutral
  // citations resolve through their own providers into the same source pipeline.
  const foreign = await concurrentMap(candidates.flatMap(({ id, authority }, index) =>
    authority.kind === "case" && authority.sourceIdentity?.provider !== "a2aj" &&
      !("mismatch" in resolutions[index]) && !resolutions[index].source &&
      ["unresolved", "resolved"].includes(draft.authorities[id]?.source.kind) ? [id] : []), async (id) => {
    signal?.throwIfAborted();
    try { return [id, await sources.resolveForeign(authorityCitationForms(draft, id), signal)] as const; }
    catch { signal?.throwIfAborted(); return [id, null] as const; }
  });
  for (const [id, found] of foreign) {
    if (!found) continue;
    const previous = draft.authorities[id].sourceIdentity;
    if (previous && (previous.stableSourceId !== found.stableSourceId ||
        previous.sourceSha256 !== found.sourceSha256)) throw new ApplicationError(409,
      `The legal source for ${draft.authorities[id].citation} changed. Add the current PDF before trying again.`);
    resolvedSources.set(found.stableSourceId, { ...found, identity: found.stableSourceId,
      alternateCitation: null, dataset: found.provider, language: "en",
      searchText: found.text, verifiedPdf: found.pdfUrl
        ? { url: found.pdfUrl, pdfOnly: true } : null });
    draft = update(draft, { type: "resolve-authority", authorityId: id,
      citation: found.citation, name: found.name,
      source: { provider: found.provider, stableSourceId: found.stableSourceId,
        sourceSha256: found.sourceSha256, version: found.date, externalUrl: found.url } });
  }
  if (!needsPdf) return { draft, attachments };
  const unique = new Map<string, { authorityId: string; authority: AuthorityIdentity;
    source: ResolvedSource }>();
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id], identity = authority?.sourceIdentity;
    const source = identity ? resolvedSources.get(identity.stableSourceId) : undefined;
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
    const provider = source.provider ?? "a2aj";
    let original: Awaited<ReturnType<SourceServices["download"]>> | undefined;
    if (originals && (pdfUrl || sourceUrl)) try {
      original = await sources.download({ provider,
        identity: source.identity ?? stableA2AJSourceId(source), sourceUrl, pdfUrl,
        source: { provider, id: source.citation, kind: authority.kind as "case" | "legislation",
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
  for (const { authorityId, source, paired, original, bytes } of prepared) {
    if (!bytes) continue;
    attachments.push({ authorityId,
      filename: pdfFilename(`${source.name ?? source.citation}${paired
        ? ` (${source.language === "en" ? "English" : "French"})` : ""}`), bytes,
      sourceSha256: sha256(bytes), sourceUrl: original
        ? original.url ?? source.verifiedPdf?.url ?? source.url : source.url ?? null,
      origin: original ? "original" : "reconstructed", language: source.language });
  }
  // One CanLII handoff rule for every case left without bytes, whichever
  // provider identified it: the publisher's own page when it has one, else the
  // page CanLII publishes for the citation.
  const attached = new Set(attachments.map(({ authorityId }) => authorityId));
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id];
    if (authority?.kind !== "case" || attached.has(id) ||
        authority.source.kind === "attached") continue;
    const source = resolvedSources.get(authority.sourceIdentity?.stableSourceId ?? "");
    const external = authority.sourceIdentity?.externalUrl;
    const pageUrl = external && buildCanliiPdfUrl(external) ? external
      : buildCanliiCaseUrlFromCitation([source?.citation, source?.alternateCitation,
        ...authorityCitationForms(draft, id)].filter((value) => !!value), source?.language);
    if (pageUrl) draft = update(draft, { type: "begin-canlii-handoff", authorityId: id, pageUrl });
  }
  return { draft, attachments };
}
