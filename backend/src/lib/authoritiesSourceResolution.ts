/** Every app's lookups of a draft's authorities: each source found (its text, never a PDF), and a case with no text
 *  handed to CanLII. The book of authorities' fetching and typesetting of PDFs is authoritiesBookSources.ts's. */
import { ApplicationError } from "./applicationError";
import { authorityCitationServices, caseNameMismatch, editAuthoritiesDraft } from "./authoritiesActions";
import { authorityCitationForms, authoritySourceRequirement, canliiCasePage, citationForms,
  type AuthoritiesDraft, type AuthorityCitedCase, type AuthorityIdentity, type AuthoritySourceIdentity,
  type AuthoritySourceLookupFailure } from "./authoritiesDomain";
import { buildCanliiPdfUrl } from "mike/shared/runtime/canliiPageUrls.mjs";
import { canonicalJsonSha256 } from "./hash";
import { A2AJUnavailable, a2ajLegalSourceProvider, stableA2AJSourceId } from "./legalSources/a2aj";
import { courtlistenerLegalSourceProvider } from "./legalSources/courtlistener";
import { foreignCaseProviders, foreignCaseSource, justiceLawsProvider, justiceLawsSource } from "./legalSources/foreign";
import { journalLegalSourceProvider } from "./legalSources/journal";
import { unitCitationParts } from "./quoteCitationSplit";
import { FOREIGN_CASE_PROVIDERS } from "./legalSources";
import { mapBounded } from "./mapBounded";
import { structureNative } from "./structureNative";

/**
 * Providers for citations the A2AJ corpus does not hold: UK neutral citations
 * through the National Archives, US reporter citations through the local
 * CourtListener bulk index, the Constitution Acts and annual statutes of Canada through Justice Laws, UK tribunal case
 * numbers through GOV.UK and US federal dockets through GovInfo. Each claims
 * only what its own citation grammar matches exactly and returns nothing when
 * the match is ambiguous.
 */
const foreignProviders = [
  { id: "tna", claims: foreignCaseProviders.tna, source: foreignCaseSource("tna") },
  { id: "courtlistener", claims: courtlistenerLegalSourceProvider,
    source: courtlistenerLegalSourceProvider.caseSource },
  { id: "justice-laws", claims: justiceLawsProvider, source: justiceLawsSource },
  { id: "govuk-et", claims: foreignCaseProviders["govuk-et"], source: foreignCaseSource("govuk-et") },
  { id: "govinfo", claims: foreignCaseProviders.govinfo, source: foreignCaseSource("govinfo") },
] as const;

const PROVIDER_NAMES: Record<typeof foreignProviders[number]["id"], string> = { tna: "The National Archives",
  courtlistener: "CourtListener", "justice-laws": "Justice Laws", "govuk-et": "GOV.UK", govinfo: "GovInfo" };

/** A provider that could not answer, as the authority's lookup failure: its own, never the run's. */
export class ProviderLookupFailure extends Error {
  constructor(readonly failure: AuthoritySourceLookupFailure) { super(failure.detail ?? failure.reason); }
}
const providerFailure = (provider: string, error: unknown): AuthoritySourceLookupFailure => {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = /rate limit|\b429\b/iu.test(detail) ? "rate-limited"
    : error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/iu.test(detail)) ? "timeout"
    : /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|cannot be reached/iu.test(detail) ? "unreachable" : "error";
  return { reason, retryAfter: null, detail, provider };
};
/** A lookup A2AJ did not answer, as its authority records it; a failure of our own is a defect named by its own
 *  message, never A2AJ's error. */
const lookupFailure = (error: unknown): AuthoritySourceLookupFailure => error instanceof A2AJUnavailable &&
  error.reason !== "local-only" ? { reason: error.reason, retryAfter: error.retryAt ? new Date(error.retryAt).toISOString() : null }
  : { reason: "defect", retryAfter: null, detail: error instanceof Error ? error.message : String(error) };

/** Resolves the first citation form a provider matches; never a best guess. Without `foreignCases`,
 *  US and UK decisions are not looked up. A provider that cannot answer leaves the others asked; where none
 *  finds the source, the first failure is the authority's (ProviderLookupFailure), never the run's. */
async function resolveForeignAuthoritySource(citations: readonly string[], signal?: AbortSignal,
  kind: "case" | "legislation" = "case", foreignCases = true) {
  let failure: AuthoritySourceLookupFailure | undefined;
  for (const citation of citations.map((value) => value.trim()).filter(Boolean)) {
    signal?.throwIfAborted();
    const read = structureNative().providerCitationsInText(citation);
    for (const { id, claims, source } of foreignProviders) {
      if (!foreignCases && FOREIGN_CASE_PROVIDERS.has(id)) continue;
      if (!claims.canResolve?.({ text: citation, kind }, read)) continue;
      let found: Awaited<ReturnType<typeof source>>;
      try { found = await source(citation, signal); }
      catch (error) {
        signal?.throwIfAborted();
        failure ??= providerFailure(PROVIDER_NAMES[id], error);
        continue;
      }
      if (!found || (!found.pdfUrl && !found.text.trim())) continue;
      return { ...found, provider: id, name: found.title, stableSourceId: `${id}:${found.id}`,
        sourceSha256: canonicalJsonSha256({ provider: id, id: found.id, text: found.text }) };
    }
  }
  if (failure) throw new ProviderLookupFailure(failure);
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
    journalLegalSourceProvider.canResolve!({ text: citation, kind: "journal" }, [])
      ? (await journalLegalSourceProvider.resolve!({ text: citation, kind: "journal", signal }, []))[0] ?? null : null,
  ...authorityCitationServices,
  revision: (document: Parameters<ReturnType<typeof structureNative>["documentRevision"]>[0]) =>
    structureNative().documentRevision(document),
};
export type SourceServices = typeof authoritySourceServices;

export const sourceIdentityLanguage = (authority: AuthorityIdentity) =>
  authority.sourceIdentity?.stableSourceId.match(/^a2aj:(en|fr):/u)?.[1] as
    "en" | "fr" | undefined;

/** Whether names written for a case can name the case another name names: the engine's reading. */
const caseNamesAgree = (written: string[], other: string) => structureNative().caseNamesAgree(written, other);

/** The case A2AJ holds at a decision's citation, when it shares no party's name with the names the brief
 *  gives the decision, and the one case those names find near it in the same court, when exactly one
 *  does (2021 SCC 4 is R v Murtaza; the brief's Parranto is 2021 SCC 46). Null when the names agree.
 *  A short form alone ("Main Decision") names no party: it can agree with the case, never set it apart. */
async function citedCaseMismatch(authority: AuthorityIdentity, source: { citation: string; name: string | null;
  date: string | null; dataset: string | null; searchText: () => string }, sources: SourceServices, signal?: AbortSignal,
  mode: "resolve" | "warn" = "resolve"): Promise<AuthorityCitedCase | null> {
  const mismatch = caseNameMismatch(authority, source);
  if (!mismatch || mode === "warn") return mismatch;
  const styled = [authority.name, authority.mentionedAs].filter((name): name is string => !!name?.trim());
  const written = [...styled, ...authority.shortNames ?? []];
  const year = Number((source.date ?? "").slice(0, 4)), words = caseNamesAgree(styled, mismatch.name).written;
  // A search that fails is no search that found nothing: the error goes to the caller, which records
  // the lookup as unanswered, to be asked again. Working locally only, a store that cannot be searched
  // finds nothing.
  const hits = Number.isInteger(year) && year > 0
    ? await sources.findCases(words.join(" "), source.dataset, `${year - 1}-01-01`, `${year + 1}-12-31`, signal)
      .catch((error) => { if (error instanceof A2AJUnavailable && error.reason === "local-only") return []; throw error; }) : [];
  // A case whose parties are named by exactly the brief's words is the one meant ("R. v. Shah" over
  // "Barta v. Shah"); else the one case that shares any of them.
  const agreeing = [...new Map((hits ?? []).flatMap((hit) => {
    const agreement = hit.citation && hit.title && hit.citation !== source.citation ? caseNamesAgree(written, hit.title) : null;
    return agreement?.agrees ? [[hit.citation!, { citation: hit.citation!, name: hit.title!,
      exact: agreement.other.length === words.length && words.every((word) => agreement.other.includes(word)) }] as const] : [];
  })).values()];
  const exact = agreeing.filter(({ exact }) => exact), pool = exact.length ? exact : agreeing;
  return { ...mismatch,
    named: pool.length === 1 ? { citation: pool[0].citation, name: pool[0].name } : null };
}

/** A2AJ's text of a case the draft found through A2AJ, to tell its PDF apart; "" otherwise. */
export async function authorityReferenceText(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  sources: SourceServices = authoritySourceServices, signal?: AbortSignal) {
  if (authority.sourceIdentity?.provider !== "a2aj") return "";
  for (const citation of authorityCitationForms(draft, authority.id)) try {
    const found = await sources.resolve(citation, "case", signal, sourceIdentityLanguage(authority));
    if (found) return found.searchText();
  } catch { signal?.throwIfAborted(); }
  return "";
}

/** A source a lookup found, as the draft's later steps read it. */
export type ResolvedSource = Pick<NonNullable<Awaited<ReturnType<SourceServices["resolve"]>>>,
  "citation" | "alternateCitation" | "name" | "date" | "url" | "publisherUrl" | "dataset" | "language" |
  "searchText" | "verifiedPdf"> & { provider?: string; identity?: string; canliiUrl?: string | null };

/** The authorities `wanted` of a draft looked up, each found or not: a decision or statute in A2AJ (a different case than
 *  cited flagged, `citedCases`), one A2AJ does not hold by its own provider, and an article in the journals database.
 *  A lookup a provider did not answer is recorded on its authority, to be asked again. */
export async function lookUpAuthorities(initial: AuthoritiesDraft, sources: SourceServices, signal: AbortSignal | undefined,
  onlyAuthorityId: string | undefined, progress: ((message: string) => void) | undefined, citedCases: "resolve" | "warn",
  wanted: (draft: AuthoritiesDraft, authority: AuthorityIdentity, id: string) => boolean) {
  // Retrying an unanswered lookup retries every unanswered lookup: one request, not one per row.
  const retrying = !onlyAuthorityId ? null : new Set(initial.authorities[onlyAuthorityId].sourceLookupFailure
    ? initial.authorityOrder.filter((id) => initial.authorities[id]?.sourceLookupFailure) : [onlyAuthorityId]);
  // Resolution applies one or two actions per authority: one working copy, validated on return.
  const editor = editAuthoritiesDraft(initial), draft = editor.draft;
  // Each authority's citation forms as the draft came, read once for its lookups and its source's identity.
  const formsIn = citationForms(initial), forms = new Map<string, string[]>();
  const formsOf = (id: string) => forms.get(id) ?? forms.set(id, formsIn(id)).get(id)!;
  // An authority takes the source found for it. Where a different case is only warned of, the source it cites is kept,
  // and the authority the source resolves to says which case its citation names, as the brief wrote its name.
  const resolveWarned = (id: string, citation: string, name: string | null, mismatch: AuthorityCitedCase | null,
    source: AuthoritySourceIdentity) => {
    const prior = citedCases === "warn" ? Object.values(draft.authorities).find((authority) => authority.id !== id &&
      authority.sourceIdentity?.stableSourceId === source.stableSourceId && authority.citedCase) : undefined;
    const warning = mismatch ?? prior?.citedCase, warned = mismatch ? draft.authorities[id] : prior;
    const writtenName = warned?.mentionedAs || warned?.name;
    editor.apply({ type: "resolve-authority", authorityId: id, citation, name: warning ? warned?.name ?? null : name, source });
    if (!warning) return;
    const target = draft.authorityOrder.find((other) => draft.authorities[other].sourceIdentity?.stableSourceId === source.stableSourceId)!;
    if (writtenName) draft.authorities[target].mentionedAs = writtenName;
    editor.apply({ type: "set-cited-case", authorityId: target, citedCase: warning });
  };
  const candidates = draft.authorityOrder.flatMap((id) => {
    if (retrying && !retrying.has(id)) return [];
    const authority = draft.authorities[id];
    const fetchable = !!authority && ["case", "legislation"].includes(authority.kind) &&
      (authority.source.kind !== "attached" || authority.sourceIdentity?.provider === "a2aj");
    return fetchable && wanted(draft, authority, id) ? [{ id, authority }] : [];
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
    for (const citation of formsOf(id)) try {
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
      failure = lookupFailure(error);
      // Another form of the citation would meet the same outage; ask again on retry instead.
      // An error answer or a defect concerns this form alone, so the next form is still asked.
      if (error instanceof A2AJUnavailable && error.reason !== "error") break;
    }
    return failure ? { failure } : { source: null };
  }
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
    let mismatch: AuthorityCitedCase | null;
    try { mismatch = await citedCaseMismatch(draft.authorities[id], source, sources, signal, citedCases); }
    catch (error) {
      signal?.throwIfAborted();
      editor.apply({ type: "set-source-lookup-failure", authorityId: id, failure: lookupFailure(error) });
      continue;
    }
    if (mismatch || draft.authorities[id].citedCase)
      editor.apply({ type: "set-cited-case", authorityId: id, citedCase: mismatch });
    if (mismatch && citedCases === "resolve") continue;
    resolvedSources.set(stableA2AJSourceId(source), source);
    resolveWarned(id, source.citation, source.name, mismatch, { provider: "a2aj", stableSourceId: stableA2AJSourceId(source),
      citationForms: [...new Set([...formsOf(id), source.citation,
        source.alternateCitation].filter((value): value is string => !!value?.trim()))].slice(0, 50),
      sourceSha256: resolved.revision, version: source.date, externalUrl: source.url, canliiUrl: source.canliiUrl });
  }
  // Authorities A2AJ does not hold: US reporter and UK neutral citations, and Quebec
  // legislation, resolve through their own providers into the same source pipeline.
  const formsNow = citationForms(draft);
  const foreign = await mapBounded(candidates.flatMap(({ id, authority }, index) =>
    authority.sourceIdentity?.provider !== "a2aj" &&
      !("mismatch" in resolutions[index]) && !resolutions[index].source &&
      ["unresolved", "resolved"].includes(draft.authorities[id]?.source.kind) ? [id] : []), async (id) => {
    signal?.throwIfAborted();
    try {
      return [id, await sources.resolveForeign(formsNow(id), signal,
        draft.authorities[id].kind as "case" | "legislation", draft.settings.foreignCaseLookup !== false)] as const;
    } catch (error) {
      // A provider that could not answer leaves this authority unchecked, marked for a retry; the others go on.
      signal?.throwIfAborted();
      editor.apply({ type: "set-source-lookup-failure", authorityId: id,
        failure: error instanceof ProviderLookupFailure ? error.failure : lookupFailure(error) });
      return [id, null] as const;
    }
  });
  for (const [id, found] of foreign) {
    if (!found || !draft.authorities[id]) continue;
    const mismatch = caseNameMismatch(draft.authorities[id], { ...found, searchText: () => found.text });
    const previous = draft.authorities[id].sourceIdentity;
    if (previous && (previous.stableSourceId !== found.stableSourceId ||
        previous.sourceSha256 !== found.sourceSha256)) throw new ApplicationError(409,
      `The legal source for ${draft.authorities[id].citation} changed. Add the current PDF before trying again.`);
    if (mismatch && citedCases === "resolve") {
      editor.apply({ type: "set-cited-case", authorityId: id, citedCase: mismatch });
      continue;
    }
    resolvedSources.set(found.stableSourceId, { ...found, identity: found.stableSourceId,
      alternateCitation: null, dataset: found.provider, language: "en",
      searchText: () => found.text, verifiedPdf: found.pdfUrl
        ? { url: found.pdfUrl, pdfOnly: true } : null });
    resolveWarned(id, found.citation, "titleIfUnnamed" in found && found.titleIfUnnamed ? draft.authorities[id].name || found.name
      : found.name, mismatch, { provider: found.provider, stableSourceId: found.stableSourceId,
      citationForms: [...new Set([...formsOf(id), found.citation])].slice(0, 50),
      sourceSha256: found.sourceSha256, version: found.date, externalUrl: found.url });
  }
  // Commentary the journals database holds: its article, and the article's link. An article is
  // found by its title, which the whole citation part carries and the authority's citation may not.
  const articles = draft.authorityOrder.flatMap((id) => {
    const authority = draft.authorities[id];
    if (authority?.kind !== "commentary" || authority.sourceIdentity || (retrying && !retrying.has(id))) return [];
    const occurrence = Object.values(draft.occurrences).find((item) => item.authorityId === id);
    return [{ id, occurrence, unit: occurrence && draft.units.find((item) => item.id === occurrence.unitId) }];
  });
  // The parts of the units citing them: a note's as the import split it, a body unit's split here.
  const splits = await unitCitationParts(articles.flatMap(({ unit }) => unit ? [unit] : []), signal);
  let splitAt = 0;
  for (const { id, occurrence, unit } of articles) {
    const authority = draft.authorities[id];
    signal?.throwIfAborted();
    const split = unit ? splits[splitAt++] : undefined;
    const part = split?.parts.find((item) => occurrence!.start >= item.start && occurrence!.start < item.end);
    let article: Awaited<ReturnType<SourceServices["resolveJournal"]>>;
    try { article = await sources.resolveJournal(part?.text ?? authority.citation, signal); }
    catch (error) {
      // The journals database failing leaves this article unchecked, marked for a retry; the others go on.
      signal?.throwIfAborted();
      editor.apply({ type: "set-source-lookup-failure", authorityId: id, failure: providerFailure("The journals database", error) });
      continue;
    }
    if (authority.sourceLookupFailure) editor.apply({ type: "set-source-lookup-failure", authorityId: id, failure: null });
    if (!article?.url) continue;
    editor.apply({ type: "resolve-authority", authorityId: id, citation: authority.citation, name: authority.name,
      source: { provider: "journal", stableSourceId: `journal:${article.id}`,
        sourceSha256: canonicalJsonSha256({ provider: "journal", id: article.id }),
        version: article.date ?? null, externalUrl: article.url } });
  }
  return { editor, draft, retrying, resolvedSources };
}

/** A case left without a source goes to CanLII: one without bytes, or, where sources need text, one no provider gave
 *  text for. One CanLII handoff rule for every case left without bytes, whichever provider identified it: the
 *  publisher's own page when it has one, else the page CanLII publishes for the citation. A publisher that did not give
 *  its original says why on its own row instead. `attached`: the authorities given a PDF in this pass. */
export function canliiHandoffs({ editor, draft, retrying, resolvedSources }: Awaited<ReturnType<typeof lookUpAuthorities>>,
  attached: ReadonlySet<string>) {
  const textOnly = !!draft.settings.sourceText;
  for (const id of draft.authorityOrder) {
    if (retrying && !retrying.has(id)) continue;
    const authority = draft.authorities[id];
    if (authority?.kind !== "case" || authority.sourceVerificationUrl || attached.has(id) ||
        authority.source.kind === "attached" || (textOnly && authority.sourceIdentity)) continue;
    const source = resolvedSources.get(authority.sourceIdentity?.stableSourceId ?? "");
    const external = authority.sourceIdentity?.externalUrl ?? authority.sourceUrl;
    const pageUrl = external && buildCanliiPdfUrl(external) ? external : source?.canliiUrl ?? canliiCasePage(authority, source?.language);
    if (pageUrl) editor.apply({ type: "begin-canlii-handoff", authorityId: id, pageUrl });
  }
}

/** The draft's authorities looked up, as a host that builds no book needs them: their sources found, a case with no text
 *  handed to CanLII, and no PDF fetched, made or attached (a quotation is checked against the provider's text, or a PDF
 *  the user attaches). */
export async function resolveAuthoritySources(initial: AuthoritiesDraft, sources: SourceServices = authoritySourceServices,
  signal?: AbortSignal, onlyAuthorityId?: string, progress?: (message: string) => void,
  citedCases: "resolve" | "warn" = "resolve") {
  if (onlyAuthorityId && !initial.authorities[onlyAuthorityId]?.sourceLookupFailure)
    throw new ApplicationError(409, "This authority has nothing to retry.");
  const lookups = await lookUpAuthorities(initial, sources, signal, onlyAuthorityId, progress, citedCases,
    (draft, authority) => !!authoritySourceRequirement(draft, authority, undefined));
  // A case no provider gave text for is handed to CanLII, where the user may take its PDF.
  canliiHandoffs(lookups, new Set());
  return lookups.editor.result();
}
