/** The book of authorities' sources: every app's lookups (authoritiesSourceResolution.ts), then each authority's PDF
 *  fetched from its publisher or, where there is none, typeset from its provider's text to stand in the book, kept by
 *  the host and attached with its page count and printed page numbers. Only a host that builds a book loads this: a PDF
 *  typeset from a provider's text is never a source anything is checked against. */
import { ApplicationError } from "./applicationError";
import { attachAuthorityPdf, editAuthoritiesDraft } from "./authoritiesActions";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { attachedAuthoritySources, authorityCitationForms, authoritiesProfile, authorityBytesRequired,
  authoritySourceRequirement, bilingualEnactmentRequired, type AuthoritiesDraft,
  type AuthorityIdentity } from "./authoritiesDomain";
import type { KeptPdf } from "./authoritiesCore";
import { sourcePageLabels, type SourcePdfReference } from "./authoritiesPageLabels";
import { authoritySourceServices, canliiHandoffs, lookUpAuthorities, sourceIdentityLanguage,
  type ResolvedSource } from "./authoritiesSourceResolution";
import { isCanliiUrl } from "mike/shared/runtime/canliiPageUrls.mjs";
import { sha256 } from "./hash";
import { stableA2AJSourceId } from "./legalSources/a2aj";
import { mapBounded } from "./mapBounded";
import { legislationPdfUrl, publisherOpenUrl, publisherPdfCandidate } from "./legalSourcePresentation";
import { downloadProviderOriginalPdf, publisherOriginalUrls, PublisherDownloadFailure } from "./providerPdfLibraryBridge";
import type { structureNative } from "./structureNative";

export const bookSourceServices = {
  ...authoritySourceServices,
  download: downloadProviderOriginalPdf,
  /** A publisher's original the host has kept, by the address it was fetched at; never fetched here. */
  stored: undefined as ((url: string) => Promise<Uint8Array | null>) | undefined,
  /** A PDF typeset from a provider's text: it stands in the book for an original there is none of. */
  render: undefined as ReturnType<typeof structureNative>["renderSourcePdf"] | undefined,
};
export type BookSourceServices = typeof bookSourceServices;

const pdfFilename = (value: string) => `${value.trim().replace(
  /[<>:"/\\|?*\u0000-\u001f]/gu, "-",
).replace(/[. ]+$/u, "").slice(0, 180) || "Authority"}.pdf`;

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

/** A single-authority retry asks again for a publisher PDF or for a lookup that went unanswered. */
const retryableAuthoritySource = (draft: AuthoritiesDraft, id: string) =>
  !!draft.authorities[id]?.sourceVerificationUrl || !!draft.authorities[id]?.sourceLookupFailure;

/** A statute's text from A2AJ, for the provisions its PDF does not place; null where A2AJ holds
 *  none. */
export async function authorityStatuteText(draft: AuthoritiesDraft, authority: AuthorityIdentity,
  sources: BookSourceServices = bookSourceServices, signal?: AbortSignal) {
  const citations = authorityCitationForms(draft, authority.id);
  for (const citation of citations) try {
    const found = await sources.resolve(citation, "legislation", signal, sourceIdentityLanguage(authority));
    const text = found?.searchText() ?? "";
    if (text.trim()) return { text, provider: "A2AJ" };
  } catch { signal?.throwIfAborted(); }
  return null;
}

/** The first original the host has kept at one of a publisher's addresses: its store is read, nothing is fetched. */
async function keptOriginal(urls: string[], stored: (url: string) => Promise<Uint8Array | null>) {
  for (const url of urls) {
    const kept = await stored(url);
    if (kept) { const bytes = Buffer.from(kept); return { bytes, sourceSha256: sha256(bytes), url }; }
  }
  return null;
}

/** A reopened draft's decisions rebuilt from text because their publisher blocked the original, each
 *  given the original the host has kept since: the host's store is read, nothing is fetched. */
async function keptOriginals(initial: AuthoritiesDraft, sources: BookSourceServices) {
  const editor = editAuthoritiesDraft(initial), attachments: PreparedAuthoritySource[] = [];
  for (const id of initial.authorityOrder) {
    const authority = initial.authorities[id], rebuilt = attachedAuthoritySources(authority.source);
    if (!sources.stored || !authority.sourceVerificationUrl || !rebuilt.length ||
        rebuilt.some(({ origin }) => origin !== "reconstructed")) continue;
    let found = false;
    for (const source of rebuilt) {
      const kept = await keptOriginal(publisherOriginalUrls(source.sourceUrl ?? authority.sourceIdentity?.externalUrl,
        authority.sourceVerificationUrl), (url) => sources.stored!(url).catch(() => null));
      if (!kept) continue;
      attachments.push({ authorityId: id, filename: source.filename, bytes: kept.bytes, sourceSha256: kept.sourceSha256,
        sourceUrl: kept.url, origin: "original", language: source.language });
      found = true;
    }
    if (found) editor.apply({ type: "set-source-verification", authorityId: id, pageUrl: null });
  }
  return { draft: editor.result(), attachments };
}

/** Resolves canonical identities and prepares source bytes. `warn` flags a different case while retaining
 *  the cited source for quotation checks; `resolve` waits for the user's choice and looks for the named case. */
export async function resolveAuthoritiesSources(
  initial: AuthoritiesDraft, sources: BookSourceServices = bookSourceServices,
  signal?: AbortSignal,
  onlyAuthorityId?: string,
  progress?: (message: string) => void,
  keptOnly = false,
  citedCases: "resolve" | "warn" = "resolve",
) {
  if (keptOnly) return keptOriginals(initial, sources);
  if (onlyAuthorityId && !retryableAuthoritySource(initial, onlyAuthorityId))
    throw new ApplicationError(409, "This authority has nothing to retry.");
  const attachments: PreparedAuthoritySource[] = [];
  const reconstruct = !!sources.render && initial.settings.sourceMode !== "manual-originals";
  const originals = initial.settings.sourceMode !== "render";
  const requirements = authoritiesProfile(initial.settings.profileId).requirements;
  const needsPdf = authorityBytesRequired(initial, requirements);
  // Resolution fetches every source a filing could want, whatever this court
  // enforces at build time; an attached PDF is final but for a missing language, and for a
  // rebuild from text whose publisher blocked the original, which a retry asks for again.
  const owed = { completeBookSources: true,
    bilingualEnactments: !!requirements?.bilingualEnactments };
  const { editor, draft, retrying, resolvedSources } = await lookUpAuthorities(initial, sources, signal, onlyAuthorityId,
    progress, citedCases, (draft, authority, id) => (!!onlyAuthorityId || !authority.sourceVerificationUrl) &&
      (!!authoritySourceRequirement(draft, authority, owed) || onlyAuthorityId === id && !!authority.sourceVerificationUrl));
  const textOnly = !!draft.settings.sourceText, lookups = { editor, draft, retrying, resolvedSources };
  if (!needsPdf) {
    if (textOnly) canliiHandoffs(lookups, new Set());
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
    let original: Awaited<ReturnType<BookSourceServices["download"]>> | undefined;
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
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof PublisherDownloadFailure) {
        const url = publisherOpenUrl(sourceUrl ?? error.pageUrl, error.pdfUrl ?? pdfUrl);
        if (url) stopped = { url, reason: error.reason };
        if (publisher && error.reason !== "failed") blockedPublishers.set(publisher, error.reason);
      }
    }
    // A publisher that blocked the download, now or earlier in this run, still yields the original the
    // host kept from an earlier fetch of it; the host's store is read, the publisher never asked.
    if (stopped && !original && sources.stored) try {
      const kept = await keptOriginal(publisherOriginalUrls(sourceUrl, pdfUrl), sources.stored);
      if (kept) { original = kept; stopped = undefined; }
    } catch { signal?.throwIfAborted(); }
    let reconstructed: { bytes: Buffer; pageCount: number } | null = null;
    const text = reconstruct && !original ? source.searchText() : "";
    if (text.trim()) try {
      reconstructed = await sources.render!({ kind: authority.kind,
        name: source.name, citation: source.citation, text,
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
  canliiHandoffs(lookups, new Set(attachments.map(({ authorityId }) => authorityId)));
  return { draft: editor.result(), attachments };
}

/** What every host keeps with a fetched source as it attaches it: its printed page numbers, and its length, by which a
 *  preview of the book counts its pages. Reading the numbers reads the whole PDF, so a few are read at once, and the
 *  step says which it is reading. */
async function preparedSourcePages<T extends PreparedAuthoritySource>(draft: AuthoritiesDraft,
  attachments: readonly T[], progress?: (message: string) => void,
  reference?: (attachment: T) => SourcePdfReference) {
  const labels = new Map<T, Array<string | null>>();
  let read = 0;
  await mapBounded(attachments, async (attachment) => {
    progress?.(`Reading the page numbers of ${attachment.filename.replace(/\.pdf$/iu, "")} · ${read + 1} of ${attachments.length}`);
    labels.set(attachment, await sourcePageLabels(draft, attachment.authorityId, attachment, attachment.bytes,
      reference?.(attachment)));
    read += 1;
  }, 3);
  return new Map(attachments.map((attachment) => {
    const pageLabels = labels.get(attachment)!;
    return [attachment, { pageLabels, pageCount: attachment.pageCount ?? pageLabels.length }];
  }));
}

/** The sources the draft's authorities resolve to, each fetched PDF kept by the host and attached with its page count
 *  and printed page numbers. Finding sources is no step the user takes: a PDF found, or a case handed to CanLII, would
 *  send a draft past Citations back to Sources as one the user attaches does, so the draft stays at its step. */
export async function gatherAuthoritySources(current: AuthoritiesDraft, options: {
  resolve: (draft: AuthoritiesDraft) => Promise<{ draft: AuthoritiesDraft; attachments: PreparedAuthoritySource[] }>;
  keep: (attachments: readonly PreparedAuthoritySource[]) => Promise<KeptPdf[]>;
  progress?: (message: string) => void; signal?: AbortSignal;
}) {
  const prepared = await options.resolve(current);
  options.signal?.throwIfAborted();
  const kept = await options.keep(prepared.attachments);
  const keptBy = new Map(prepared.attachments.map((attachment, index) => [attachment, kept[index]!]));
  const pages = await preparedSourcePages(prepared.draft, prepared.attachments, options.progress,
    (attachment) => keptBy.get(attachment)!.reference ?? { documentId: `standalone-authority:${attachment.sourceSha256}`,
      versionId: attachment.sourceSha256 });
  let draft = prepared.draft;
  for (const attachment of prepared.attachments) {
    const pdf = keptBy.get(attachment)!;
    draft = attachAuthorityPdf(draft, draft.authorities[attachment.authorityId], pdf.binding,
      pdf.filename ?? attachment.filename, attachment.sourceSha256, attachment.language,
      { ...attachment, ...pages.get(attachment) });
  }
  return { draft: draft.stage === current.stage ? draft : { ...draft, stage: current.stage },
    attachments: prepared.attachments };
}
