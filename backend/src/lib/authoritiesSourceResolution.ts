import { ApplicationError } from "./applicationError";
import { authorityCitationServices, editAuthoritiesDraft } from "./authoritiesActions";
import { renderAuthoritySourcePdf } from "./authoritiesBuild";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { attachedAuthoritySources, authorityCitationForms, authoritiesProfile,
  authorityBytesRequired, authoritySourceRequirement, bilingualEnactmentRequired,
  type AuthoritiesDraft, type AuthorityCitedCase, type AuthorityIdentity, type AuthoritySourceLookupFailure } from "./authoritiesDomain";
import { buildCanliiCaseUrlFromCitation } from "./canliiUrls";
import { buildCanliiPdfUrl, isCanliiUrl } from "mike/shared/runtime/canliiPageUrls.mjs";
import { canonicalJsonSha256, sha256 } from "./hash";
import { A2AJUnavailable, a2ajLegalSourceProvider, stableA2AJSourceId } from "./legalSources/a2aj";
import { courtlistenerLegalSourceProvider } from "./legalSources/courtlistener";
import { tnaCaseSource, tnaLegalSourceProvider } from "./legalSources/tna";
import { justiceLawsLegalSourceProvider, justiceLawsSource } from "./legalSources/justiceLaws";
import { journalLegalSourceProvider } from "./legalSources/journal";
import { splitQuoteCitationUnits } from "./quoteCitationSplit";
import type { LegalSourceReference } from "./legalSources";
import { mapBounded } from "./mapBounded";
import { legislationPdfUrl, publisherOpenUrl, publisherPdfCandidate } from "./legalSourcePresentation";
import { downloadProviderOriginalPdf, PublisherDownloadFailure } from "./providerPdfLibraryBridge";
import { structureNative } from "./structureNative";

/**
 * Providers for citations the A2AJ corpus does not hold: UK neutral citations
 * through the National Archives, US reporter citations through the local
 * CourtListener bulk index, and federal annual statutes and the Constitution Acts
 * through Justice Laws. Each claims
 * only what its own citation grammar matches exactly and returns nothing when
 * the match is ambiguous.
 */
const foreignProviders = [
  { id: "tna", claims: tnaLegalSourceProvider, source: tnaCaseSource },
  { id: "courtlistener", claims: courtlistenerLegalSourceProvider,
    source: courtlistenerLegalSourceProvider.caseSource },
  { id: "justice-laws", claims: justiceLawsLegalSourceProvider, source: justiceLawsSource },
] as const;

/** Resolves the first citation form a provider matches; never a best guess. */
async function resolveForeignAuthoritySource(citations: readonly string[], signal?: AbortSignal,
  kind: "case" | "legislation" = "case") {
  for (const citation of citations.map((value) => value.trim()).filter(Boolean)) {
    signal?.throwIfAborted();
    for (const { id, claims, source } of foreignProviders) {
      if (!claims.canResolve?.({ text: citation, kind })) continue;
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
    docType: kind === "case" ? "cases" : "laws", language, signal, discoverPdf: false }),
  resolveForeign: resolveForeignAuthoritySource,
  /** Decisions of a court (an A2AJ dataset) between two dates whose names hold the words given. */
  findCases: async (words: string, dataset: string | null, from: string, to: string, signal?: AbortSignal) =>
    await a2ajLegalSourceProvider.search!({ text: words, kinds: ["case"], searchType: "name", collection: dataset ?? undefined,
      dateFrom: from, dateTo: to, limit: 20, signal }),
  /** The journal article a commentary citation names, by its citation or quoted title. */
  resolveJournal: async (citation: string, signal?: AbortSignal) =>
    (await journalLegalSourceProvider.resolve!({ text: citation, kind: "journal", signal }))[0] as LegalSourceReference | undefined ?? null,
  download: downloadProviderOriginalPdf,
  ...authorityCitationServices,
  revision: (document: Parameters<ReturnType<typeof structureNative>["documentRevision"]>[0]) =>
    structureNative().documentRevision(document),
};
export type SourceServices = typeof authoritySourceServices;

const pdfFilename = (value: string) => `${value.trim().replace(
  /[<>:"/\\|?*\u0000-\u001f]/gu, "-",
).replace(/[. ]+$/u, "").slice(0, 180) || "Authority"}.pdf`;

const sourceIdentityLanguage = (authority: AuthorityIdentity) =>
  authority.sourceIdentity?.stableSourceId.match(/^a2aj:(en|fr):/u)?.[1] as
    "en" | "fr" | undefined;

export type PreparedAuthoritySource = {
  authorityId: string;
  filename: string;
  bytes: Buffer;
  sourceSha256: string;
  sourceUrl: string | null;
  origin: "original" | "reconstructed";
  language: "en" | "fr" | "bilingual";
  pageCount?: number;
};

/** Whether names written for a case can name the case another name names: the engine's reading. */
const caseNamesAgree = (written: string[], other: string) => structureNative().citationEngineCall("caseNamesAgree",
  JSON.stringify({ written, other })) as { agrees: boolean; written: string[]; other: string[] };

/** The case A2AJ holds at a decision's citation, when it shares no party's name with the names the brief
 *  gives the decision, and the one case those names find near it in the same court, when exactly one
 *  does (2021 SCC 4 is R v Murtaza; the brief's Parranto is 2021 SCC 46). Null when the names agree.
 *  A short form alone ("Main Decision") names no party: it can agree with the case, never set it apart. */
async function citedCaseMismatch(authority: AuthorityIdentity, source: { citation: string; name: string | null;
  date: string | null; dataset: string | null }, sources: SourceServices, signal?: AbortSignal): Promise<AuthorityCitedCase | null> {
  const styled = [authority.name, authority.mentionedAs].filter((name): name is string => !!name?.trim());
  const written = [...styled, ...authority.shortNames ?? []];
  if (authority.kind !== "case" || !source.name || !styled.length) return null;
  const agreement = caseNamesAgree(written, source.name);
  if (agreement.agrees) return null;
  const year = Number((source.date ?? "").slice(0, 4)), words = caseNamesAgree(styled, source.name).written;
  let hits: Awaited<ReturnType<SourceServices["findCases"]>> | null = [];
  if (Number.isInteger(year) && year > 0) try {
    hits = await sources.findCases(words.join(" "), source.dataset, `${year - 1}-01-01`, `${year + 1}-12-31`, signal);
  } catch { signal?.throwIfAborted(); }
  // A case whose parties are named by exactly the brief's words is the one meant ("R. v. Shah" over
  // "Barta v. Shah"); else the one case that shares any of them.
  const agreeing = [...new Map((hits ?? []).flatMap((hit) => {
    const agreement = hit.citation && hit.title && hit.citation !== source.citation ? caseNamesAgree(written, hit.title) : null;
    return agreement?.agrees ? [[hit.citation!, { citation: hit.citation!, name: hit.title!,
      exact: agreement.other.length === words.length && words.every((word) => agreement.other.includes(word)) }] as const] : [];
  })).values()];
  const exact = agreeing.filter(({ exact }) => exact), pool = exact.length ? exact : agreeing;
  return { id: canonicalJsonSha256(["beaver.authorities-cited-case.v1", authority.id, source.citation, source.name]),
    citation: source.citation, name: source.name,
    named: pool.length === 1 ? { citation: pool[0].citation, name: pool[0].name } : null };
}

/** A single-authority retry asks again for a publisher PDF or for a lookup that went unanswered. */
export const retryableAuthoritySource = (draft: AuthoritiesDraft, id: string) =>
  !!draft.authorities[id]?.sourceVerificationUrl || !!draft.authorities[id]?.sourceLookupFailure;

/** A2AJ's text of a case the draft found through A2AJ, to tell its PDF apart; "" otherwise. */
export async function authorityReferenceText(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  sources: SourceServices = authoritySourceServices, signal?: AbortSignal) {
  if (authority.sourceIdentity?.provider !== "a2aj") return "";
  for (const citation of authorityCitationForms(draft, authority.id)) try {
    const found = await sources.resolve(citation, "case", signal, sourceIdentityLanguage(authority));
    if (found) return found.searchText;
  } catch { signal?.throwIfAborted(); }
  return "";
}

/** A statute's text from A2AJ, for the provisions its PDF does not place; null where A2AJ holds
 *  none. */
export async function authorityStatuteText(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  sources: SourceServices = authoritySourceServices, signal?: AbortSignal) {
  const citations = authorityCitationForms(draft, authority.id);
  for (const citation of citations) try {
    const found = await sources.resolve(citation, "legislation", signal, sourceIdentityLanguage(authority));
    if (found?.searchText.trim()) return { text: found.searchText, provider: "A2AJ" };
  } catch { signal?.throwIfAborted(); }
  return null;
}

/** Resolves canonical identities and prepares source bytes without choosing a persistence adapter. */
export async function resolveAuthoritiesSources(
  initial: AuthoritiesDraft, sources: SourceServices = authoritySourceServices,
  signal?: AbortSignal,
  onlyAuthorityId?: string,
  progress?: (message: string) => void,
) {
  if (onlyAuthorityId && !retryableAuthoritySource(initial, onlyAuthorityId))
    throw new ApplicationError(409, "This authority has nothing to retry.");
  // Retrying an unanswered lookup retries every unanswered lookup: one request, not one per row.
  const retrying = !onlyAuthorityId ? null : new Set(initial.authorities[onlyAuthorityId].sourceLookupFailure
    ? initial.authorityOrder.filter((id) => initial.authorities[id]?.sourceLookupFailure) : [onlyAuthorityId]);
  // Resolution applies one or two actions per authority: one working copy, validated on return.
  const editor = editAuthoritiesDraft(initial), draft = editor.draft;
  const attachments: PreparedAuthoritySource[] = [];
  const reconstruct = draft.settings.sourceMode !== "manual-originals";
  const originals = draft.settings.sourceMode !== "render";
  const requirements = authoritiesProfile(draft.settings.profileId).requirements;
  const needsPdf = authorityBytesRequired(draft, requirements);
  // Resolution fetches every source a filing could want, whatever this court
  // enforces at build time; an attached PDF is final but for a missing language.
  const owed = { completeBookSources: true,
    bilingualEnactments: !!requirements?.bilingualEnactments };
  const candidates = draft.authorityOrder.flatMap((id) => {
    if (retrying && !retrying.has(id)) return [];
    const authority = draft.authorities[id];
    if (!onlyAuthorityId && authority?.sourceVerificationUrl) return [];
    const fetchable = !!authority && ["case", "legislation"].includes(authority.kind) &&
      (authority.source.kind !== "attached" || authority.sourceIdentity?.provider === "a2aj");
    return fetchable && authoritySourceRequirement(draft, authority, owed)
      ? [{ id, authority }] : [];
  });
  // A lookup A2AJ did not answer is recorded on the authority, never taken for a miss; one it
  // asked us to hold off is not asked again before its retry time.
  let looked = 0;
  const lookup = () => candidates.length && progress?.(`Looking up authorities · ${looked} of ${candidates.length}`);
  lookup();
  const resolutions = await mapBounded(candidates, async (candidate) => {
    const resolved = await resolveCandidate(candidate);
    looked += 1; lookup();
    return resolved;
  });
  async function resolveCandidate({ id, authority }: typeof candidates[number]) {
    signal?.throwIfAborted();
    if (authority.sourceIdentity && authority.sourceIdentity.provider !== "a2aj") return { source: null };
    const held = authority.sourceLookupFailure;
    if (held?.retryAfter && Date.parse(held.retryAfter) > Date.now()) return { failure: held };
    let failure: AuthoritySourceLookupFailure | undefined;
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
    } catch (error) {
      signal?.throwIfAborted();
      // Working locally only, a source the local store lacks is a miss: A2AJ is not asked.
      if (error instanceof A2AJUnavailable && error.reason === "local-only") continue;
      // A failure of our own is a defect named by its own message, never A2AJ's error.
      failure = error instanceof A2AJUnavailable && error.reason !== "local-only" ? { reason: error.reason,
        retryAfter: error.retryAt ? new Date(error.retryAt).toISOString() : null }
        : { reason: "defect", retryAfter: null, detail: error instanceof Error ? error.message : String(error) };
      // Another form of the citation would meet the same outage; ask again on retry instead.
      // An error answer or a defect concerns this form alone, so the next form is still asked.
      if (error instanceof A2AJUnavailable && error.reason !== "error") break;
    }
    return failure ? { failure } : { source: null };
  }
  type ResolvedSource = Pick<NonNullable<Awaited<ReturnType<SourceServices["resolve"]>>>,
    "citation" | "alternateCitation" | "name" | "date" | "url" | "publisherUrl" | "dataset" | "language" |
    "searchText" | "verifiedPdf"> & { provider?: string; identity?: string };
  const resolvedSources = new Map<string, ResolvedSource>();
  for (let index = 0; index < candidates.length; index += 1) {
    signal?.throwIfAborted();
    const { id, authority } = candidates[index], resolved = resolutions[index];
    // An earlier resolution can merge this authority into another with the same source.
    if (!draft.authorities[id]) continue;
    if ("mismatch" in resolved) throw new ApplicationError(409,
      `The legal source for ${authority.name ?? authority.citation} changed since this draft was saved. Add the current PDF before trying again.`, {
        authority_id: id, source_issue: "changed", source_provider: "a2aj",
        saved_source_sha256: authority.sourceIdentity?.sourceSha256,
        current_source_sha256: resolved.revision,
      });
    if (resolved.failure || authority.sourceLookupFailure) editor.apply({
      type: "set-source-lookup-failure", authorityId: id, failure: resolved.failure ?? null });
    if (!resolved.source) continue;
    const source = resolved.source;
    // A citation that names a different case keeps the brief's name and citation, and no source,
    // until the user decides.
    const mismatch = await citedCaseMismatch(draft.authorities[id], source, sources, signal);
    if (mismatch || draft.authorities[id].citedCase)
      editor.apply({ type: "set-cited-case", authorityId: id, citedCase: mismatch });
    if (mismatch) continue;
    resolvedSources.set(stableA2AJSourceId(source), source);
    editor.apply({ type: "resolve-authority", authorityId: id,
      citation: source.citation, name: source.name,
      source: { provider: "a2aj", stableSourceId: stableA2AJSourceId(source),
        citationForms: [...new Set([...authorityCitationForms(initial, id), source.citation,
          source.alternateCitation].filter((value): value is string => !!value?.trim()))].slice(0, 50),
        sourceSha256: resolved.revision, version: source.date, externalUrl: source.url } });
  }
  // Authorities A2AJ does not hold: US reporter and UK neutral citations, and Quebec
  // legislation, resolve through their own providers into the same source pipeline.
  const foreign = await mapBounded(candidates.flatMap(({ id, authority }, index) =>
    authority.sourceIdentity?.provider !== "a2aj" &&
      !("mismatch" in resolutions[index]) && !resolutions[index].source &&
      ["unresolved", "resolved"].includes(draft.authorities[id]?.source.kind) ? [id] : []), async (id) => {
    signal?.throwIfAborted();
    try { return [id, await sources.resolveForeign(authorityCitationForms(draft, id), signal,
      draft.authorities[id].kind as "case" | "legislation")] as const; }
    catch { signal?.throwIfAborted(); return [id, null] as const; }
  });
  for (const [id, found] of foreign) {
    if (!found || !draft.authorities[id]) continue;
    const previous = draft.authorities[id].sourceIdentity;
    if (previous && (previous.stableSourceId !== found.stableSourceId ||
        previous.sourceSha256 !== found.sourceSha256)) throw new ApplicationError(409,
      `The legal source for ${draft.authorities[id].citation} changed. Add the current PDF before trying again.`);
    resolvedSources.set(found.stableSourceId, { ...found, identity: found.stableSourceId,
      alternateCitation: null, dataset: found.provider, language: "en",
      searchText: found.text, verifiedPdf: found.pdfUrl
        ? { url: found.pdfUrl, pdfOnly: true } : null });
    editor.apply({ type: "resolve-authority", authorityId: id,
      citation: found.citation, name: "titleIfUnnamed" in found && found.titleIfUnnamed
        ? draft.authorities[id].name || found.name : found.name,
      source: { provider: found.provider, stableSourceId: found.stableSourceId,
        citationForms: [...new Set([...authorityCitationForms(initial, id), found.citation])].slice(0, 50),
        sourceSha256: found.sourceSha256, version: found.date, externalUrl: found.url } });
  }
  // Commentary the journals database holds: its article, and the article's link. An article is
  // found by its title, which the whole citation part carries and the authority's citation may not.
  for (const id of draft.authorityOrder) {
    const authority = draft.authorities[id];
    if (authority?.kind !== "commentary" || authority.sourceIdentity || (retrying && !retrying.has(id))) continue;
    signal?.throwIfAborted();
    const occurrence = Object.values(draft.occurrences).find((item) => item.authorityId === id);
    const unit = occurrence && draft.units.find((item) => item.id === occurrence.unitId);
    const [split] = unit ? await splitQuoteCitationUnits([unit.text], signal) : [];
    const part = split?.parts.find((item) => occurrence!.start >= item.start && occurrence!.start < item.end);
    let article: Awaited<ReturnType<SourceServices["resolveJournal"]>> = null;
    try { article = await sources.resolveJournal(part?.text ?? authority.citation, signal); } catch { signal?.throwIfAborted(); }
    if (!article?.url) continue;
    editor.apply({ type: "resolve-authority", authorityId: id, citation: authority.citation, name: authority.name,
      source: { provider: "journal", stableSourceId: `journal:${article.id}`,
        sourceSha256: canonicalJsonSha256({ provider: "journal", id: article.id }),
        version: article.date ?? null, externalUrl: article.url } });
  }
  // A case left without a source goes to CanLII: one without bytes, or, where sources need text,
  // one no provider gave text for.
  const textOnly = !!draft.settings.sourceText;
  function canliiHandoffs(attached: ReadonlySet<string>) {
    // One CanLII handoff rule for every case left without bytes, whichever
    // provider identified it: the publisher's own page when it has one, else the
    // page CanLII publishes for the citation. A publisher that did not give its
    // original says why on its own row instead.
    for (const id of draft.authorityOrder) {
      if (retrying && !retrying.has(id)) continue;
      const authority = draft.authorities[id];
      if (authority?.kind !== "case" || authority.sourceVerificationUrl || attached.has(id) ||
          authority.source.kind === "attached" || (textOnly && authority.sourceIdentity)) continue;
      const source = resolvedSources.get(authority.sourceIdentity?.stableSourceId ?? "");
      const external = authority.sourceIdentity?.externalUrl ?? authority.sourceUrl;
      const pageUrl = external && buildCanliiPdfUrl(external) ? external
        : buildCanliiCaseUrlFromCitation([source?.citation, source?.alternateCitation,
          ...authorityCitationForms(draft, id)].filter((value) => !!value), source?.language);
      if (pageUrl) editor.apply({ type: "begin-canlii-handoff", authorityId: id, pageUrl });
    }
  }
  if (!needsPdf) {
    if (textOnly) canliiHandoffs(new Set());
    return { draft: editor.result(), attachments };
  }
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
  const languageSources = (await mapBounded([...unique.values()], async (item) => {
    const { authority, source } = item;
    const existing = new Set(attachedAuthoritySources(authority.source)
      .map(({ language }) => language));
    if (!bilingualEnactmentRequired({ kind: authority.kind,
      citation: source.citation || authority.citation }, requirements)) return [{ ...item,
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
  const locations = (source: ResolvedSource) => {
    const publisherUrl = source.publisherUrl ?? source.url;
    return { pdfUrl: source.verifiedPdf && !isCanliiUrl(source.verifiedPdf.url) ? source.verifiedPdf.url : null,
      sourceUrl: publisherUrl && !isCanliiUrl(publisherUrl) ? publisherUrl : null };
  };
  // A publisher that blocked the downloader, or a download service that refused this page, is not
  // asked again in this run.
  const blockedPublishers = new Map<string, PublisherDownloadFailure["reason"]>();
  let started = 0;
  const prepareSource = async (item: typeof languageSources[number]) => {
    signal?.throwIfAborted();
    const { authority, source } = item;
    const { pdfUrl, sourceUrl } = locations(source);
    started += 1;
    progress?.(`Fetching ${source.name ?? source.citation} · ${started} of ${languageSources.length}`);
    const provider = source.provider ?? "a2aj";
    let publisher: string | undefined;
    let original: Awaited<ReturnType<SourceServices["download"]>> | undefined;
    let stopped: { url: string; reason: PublisherDownloadFailure["reason"] } | undefined;
    // A statute comes as its official PDF wherever its jurisdiction publishes one, as a decision
    // does; one published only as web pages is rebuilt from its text.
    const takesOriginal = authority.kind !== "legislation" || !!(pdfUrl ??
      (sourceUrl && (publisherPdfCandidate(sourceUrl) ?? legislationPdfUrl(sourceUrl))));
    if (originals && takesOriginal && (pdfUrl || sourceUrl)) try {
      publisher = new URL(sourceUrl ?? pdfUrl!).origin;
      const held = blockedPublishers.get(publisher);
      if (held) throw new PublisherDownloadFailure(sourceUrl ?? pdfUrl!, held);
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
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PublisherDownloadFailure) {
        const url = publisherOpenUrl(sourceUrl ?? error.pageUrl, error.pdfUrl ?? pdfUrl);
        if (url) stopped = { url, reason: error.reason };
        if (publisher && error.reason !== "failed") blockedPublishers.set(publisher, error.reason);
      }
    }
    let reconstructed: Awaited<ReturnType<typeof renderAuthoritySourcePdf>> | null = null;
    if (reconstruct && !original && source.searchText.trim()) try {
      reconstructed = await renderAuthoritySourcePdf({ kind: authority.kind,
        name: source.name, citation: source.citation, date: source.date,
        sourceUrl: source.publisherUrl ?? source.url, text: source.searchText,
        provider: (source.provider ?? "a2aj") === "a2aj" ? "A2AJ" : source.provider,
        retrieved: new Date().toISOString().slice(0, 10), federal: !!requirements?.federalFormatting });
    } catch { signal?.throwIfAborted(); }
    // A text rebuild stands in for the original, and the row still says why the original is not there.
    // A statute's length decides how its book copy is made, so it is recorded with it.
    return { ...item, original, stopped, bytes: original?.bytes ?? reconstructed?.bytes,
      pageCount: !original ? reconstructed?.pageCount : authority.kind === "legislation"
        ? await validateAuthoritiesPdf(original.bytes).catch(() => undefined) : undefined };
  };
  // A few publishers are fetched at once, each publisher's PDFs one after another: no site is
  // asked more often than before, and one that challenges is not asked again in this run.
  const publishers = new Map<string, number[]>();
  languageSources.forEach(({ source }, index) => {
    const { pdfUrl, sourceUrl } = locations(source);
    let key = `source:${index}`;
    try { if (sourceUrl ?? pdfUrl) key = new URL(sourceUrl ?? pdfUrl!).origin; } catch { /* its own queue */ }
    publishers.set(key, [...publishers.get(key) ?? [], index]);
  });
  const prepared = new Array<Awaited<ReturnType<typeof prepareSource>>>(languageSources.length);
  await mapBounded([...publishers.values()], async (indices) => {
    for (const index of indices) prepared[index] = await prepareSource(languageSources[index]);
  }, 3);
  for (const { authorityId, source, paired, original, bytes, pageCount } of prepared) {
    if (!bytes) continue;
    const digest = sha256(bytes);
    const sameOriginal = original && paired && attachments.find(item =>
      item.authorityId === authorityId && item.origin === "original" &&
      item.sourceSha256 === digest && item.language !== source.language);
    if (sameOriginal) {
      sameOriginal.language = "bilingual";
      sameOriginal.filename = pdfFilename(source.name ?? source.citation);
      continue;
    }
    attachments.push({ authorityId,
      filename: pdfFilename(`${source.name ?? source.citation}${paired
        ? ` (${source.language === "en" ? "English" : "French"})` : ""}`), bytes,
      sourceSha256: digest, sourceUrl: original
        ? original.url ?? source.verifiedPdf?.url ?? source.publisherUrl ?? source.url
        : source.publisherUrl ?? source.url ?? null,
      origin: original ? "original" : "reconstructed", language: source.language, ...(pageCount && { pageCount }) });
  }
  for (const authorityId of new Set(prepared.map(item => item.authorityId))) {
    const stopped = prepared.find(item => item.authorityId === authorityId && item.stopped)?.stopped;
    editor.apply({ type: "set-source-verification", authorityId, pageUrl: stopped?.url ?? null,
      ...(stopped && stopped.reason !== "blocked" ? { reason: stopped.reason } : {}) });
  }
  canliiHandoffs(new Set(attachments.map(({ authorityId }) => authorityId)));
  return { draft: editor.result(), attachments };
}
