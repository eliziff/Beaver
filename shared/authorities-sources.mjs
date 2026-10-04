import profiles from "./authorities-profiles.json" with { type: "json" };

/** The courts whose preset, not the user, says what a filed book does with a missing PDF. */
const COURT_SOURCE_POLICY = new Set(profiles.filter((profile) =>
  !profile.options?.missingSourcePolicy).map(({ id }) => id));

export const attachedAuthoritySources = (source) =>
  source.kind === "attached" ? source.sources : [];
/** A federal enactment citation, which some courts require in both official languages. */
export const federalEnactmentCitation = (citation) =>
  /\b(?:R\.?S\.?C\.?|S\.?C\.?|C\.?R\.?C\.?|SOR|SI|DORS|TR)\b/iu.test(citation);
export const hasBilingualAuthoritySource = (source) => {
  const languages = attachedAuthoritySources(source).map(({ language }) => language);
  return languages.includes("bilingual") ||
    ["en", "fr"].every((language) => languages.includes(language));
};
/** The public link an authority offers a table, before any host canonicalization. */
export const authoritySourceUrl = (authority) =>
  authority.source.kind === "attached"
    ? authority.source.sources.find(({ sourceUrl }) => sourceUrl)?.sourceUrl ??
      authority.sourceIdentity?.externalUrl ?? authority.sourceUrl ?? null
    : authority.source.kind === "pending-canlii" ? authority.source.pageUrl
      : authority.sourceIdentity?.externalUrl ?? authority.sourceUrl ?? null;
/** A federal enactment the court wants in both official languages. */
export const bilingualEnactmentRequired = (authority, requirements) =>
  !!requirements?.bilingualEnactments && authority.kind === "legislation" &&
  federalEnactmentCitation(authority.citation);
/** Whether a build needs authority PDFs at all: a book reproduces every authority,
 *  and a PDF filing carries the table entries it cannot link to. */
export const authorityBytesRequired = (draft, requirements) => !draft.settings?.sourceText &&
  (draft.outputMode !== "table" || !!draft.settings?.finalPdf || !!(draft.insertIntoDocument &&
    requirements?.unlinkedPdfTableSources && draft.import.kind === "document" &&
    draft.import.fileType === "pdf"));
/** Where sources need text, not PDFs: a case or statute no provider gave text for. */
const textMissing = (authority) => ["case", "legislation"].includes(authority.kind) && !authority.excluded &&
  authority.source.kind !== "attached" && !authority.sourceIdentity;
/** Whether the build puts this one authority's own PDF in front of the court; where sources need
 *  text, whether a PDF is its only text. */
export const authorityPdfRequired = (draft, authority, requirements) => draft.settings?.sourceText ? textMissing(authority) :
  draft.outputMode !== "table" || !!draft.settings?.finalPdf || !!(requirements?.unlinkedPdfTableSources &&
    draft.import.kind === "document" && draft.import.fileType === "pdf" &&
    !authoritySourceUrl(authority));

/** Whether an authority stands in the book on its own: not left out, and not a decision of
 *  subsequent history printed with the case it follows ("with-case"). */
export const authorityTabbed = (draft, authority) => !authority.excluded &&
  !(draft.settings?.subsequentHistory === "with-case" && authority.historyOf &&
    draft.authorities?.[authority.historyOf] && !draft.authorities[authority.historyOf].excluded);

/** The one rule for "does this authority still owe a source", asked by the builder
 *  (which throws), the resolver (which fetches) and the workspace (which warns).
 *  `requirements` names the obligations the caller enforces; `prepared` says whether
 *  a source decision nobody has acted on yet already counts as missing. */
export function authoritySourceRequirement(draft, authority, requirements, prepared = true) {
  if (draft.settings?.sourceText) return textMissing(authority) &&
    (prepared || !["unresolved", "resolved"].includes(authority.source.kind)) ? "missing" : null;
  const attached = authority.source.kind === "attached";
  if (!prepared && ["unresolved", "resolved"].includes(authority.source.kind)) return null;
  if (authorityTabbed(draft, authority)) {
    if (attached && bilingualEnactmentRequired(authority, requirements) &&
        !hasBilingualAuthoritySource(authority.source)) return "incomplete-enactment";
    if (!attached && requirements?.completeBookSources) return "missing";
  }
  // A table links every authority it lists, one the book leaves out included; only
  // the authority's own PDF, appended to a PDF filing, stands in for the link.
  return requirements?.unlinkedPdfTableSources && !authoritySourceUrl(authority) &&
    !(attached && (draft.settings?.finalPdf || draft.insertIntoDocument &&
      draft.import.kind === "document" && draft.import.fileType === "pdf")) ? "unlinked" : null;
}

/** A statute whose PDF runs longer than this goes in the book as an excerpt unless chosen whole. */
export const STATUTE_EXCERPT_PAGES = 30;
/** Whether a statute goes in the book as an excerpt: as chosen, else by the length of its longest
 *  PDF (`pageCounts`, by default as recorded when each was attached); undefined while one is unknown. */
export function statuteExcerpt(authority, pageCounts = attachedAuthoritySources(authority.source)
  .map(({ pageCount }) => pageCount)) {
  if (authority.kind !== "legislation" || authority.source.kind !== "attached") return false;
  return authority.excerpt ?? (pageCounts.includes(undefined) ? undefined
    : Math.max(...pageCounts) > STATUTE_EXCERPT_PAGES);
}

/** Whether the book reproduces this authority, asked by the builder (which loads the
 *  PDF or a stub) and the workspace (which plans the same book). An authority whose PDF
 *  never arrived keeps its tab with a page naming it where missing sources keep their
 *  tabs, and is left out, its tab number kept, where they are left out. An incomplete
 *  draft for a court that leaves them out of a filed book keeps the page too: the draft is
 *  finished in Acrobat, where Replace Pages puts the PDF under its tab, index line and bookmark. */
export const authorityReproducedInBook = (draft, authority) =>
  authorityTabbed(draft, authority) && !authoritySourceRequirement(draft, authority, {
    completeBookSources: draft.settings.missingSourcePolicy !== "placeholder" &&
      !(draft.settings.allowIncomplete && COURT_SOURCE_POLICY.has(draft.settings.profileId)) });

export const authoritiesBookPdfs = (draft) => [
  ...(draft.bookParts.cover ? [draft.bookParts.cover] : []),
  ...(draft.bookParts.index ? [draft.bookParts.index] : []),
  ...draft.bookParts.supplements,
];
/** Where an uploaded PDF goes when it is not an authority's own source. */
export const AUTHORITIES_BOOK_SLOTS = ["cover", "index", "supplemental", "brief"];
/** A PDF the user saved from their Word brief: the final PDF's brief when no converter runs. */
export const authoritiesBriefPdf = (draft) => draft.settings?.finalPdf && draft.import.kind === "document" &&
  draft.import.fileType === "docx" && draft.bookParts.brief || null;

export function removeUnusedBinding(draft, role) {
  if (!role || draft.import.kind === "document" && draft.import.bindingRole === role ||
      Object.values(draft.authorities).some((authority) =>
        attachedAuthoritySources(authority.source).some(({ bindingRole }) => bindingRole === role)) ||
      authoritiesBookPdfs(draft).some(({ bindingRole }) => bindingRole === role) ||
      draft.bookParts.brief?.bindingRole === role) return;
  delete draft.bindings[role];
}

export function replaceSource(draft, authority, source) {
  const oldRoles = attachedAuthoritySources(authority.source).map(({ bindingRole }) => bindingRole);
  authority.source = source;
  oldRoles.forEach((role) => removeUnusedBinding(draft, role));
}

/** Mutates the caller's working copy; hosts validate/retain bytes and select their binding first. */
export function attachAuthoritySource(draft, authority, source, binding) {
  const previous = attachedAuthoritySources(authority.source);
  const sources = source.language === "bilingual" ? [source]
    : [...previous.filter(({ language }) => language !== "bilingual" &&
      language !== source.language), source].sort((left, right) =>
      left.language === "en" ? -1 : right.language === "en" ? 1 : 0);
  draft.bindings[source.bindingRole] = structuredClone(binding);
  replaceSource(draft, authority, { kind: "attached", sources });
  if (draft.stage !== "citations") draft.stage = "sources";
}

/** All authority references remain available for verification/receipts, even without output bytes.
 * Standalone uploads byteRoles; Library also verifies the referenced versions before publication.
 * Text/OCR requirements are added by the server's existing authoritiesTextRoles calculation. */
export function authoritiesInputPlan(draft, requirements) {
  const authoritySources = Object.values(draft.authorities).flatMap((authority) =>
    attachedAuthoritySources(authority.source).map((source) => ({ authority, source })));
  const included = authoritySources.filter(({ authority }) => authorityTabbed(draft, authority));
  const needsBook = draft.outputMode !== "table" || !!draft.settings?.finalPdf;
  const bookPdfs = needsBook ? authoritiesBookPdfs(draft) : [], briefPdf = authoritiesBriefPdf(draft);
  return {
    authoritySources, bookPdfs, briefPdf,
    bookRoles: new Set(needsBook ? included.map(({ source }) => source.bindingRole) : []),
    byteRoles: new Set([
      ...(authorityBytesRequired(draft, requirements)
        ? included.map(({ source }) => source.bindingRole) : []),
      ...((draft.insertIntoDocument || draft.settings?.finalPdf || (draft.settings?.citationSuffix ?? "none") !== "none") &&
        draft.import.kind === "document"
        ? [draft.import.bindingRole] : []),
      ...[...bookPdfs, ...briefPdf ? [briefPdf] : []].map(({ bindingRole }) => bindingRole),
    ]),
  };
}
