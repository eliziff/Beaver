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
    ? authority.source.sources.find(({ sourceUrl }) => sourceUrl)?.sourceUrl ?? null
    : authority.source.kind === "pending-canlii" ? authority.source.pageUrl
      : authority.sourceIdentity?.externalUrl ?? null;
/** A federal enactment the court wants in both official languages. */
export const bilingualEnactmentRequired = (authority, requirements) =>
  !!requirements?.bilingualEnactments && authority.kind === "legislation" &&
  federalEnactmentCitation(authority.citation);
/** Whether a build needs authority PDFs at all: a book reproduces every authority,
 *  and a PDF filing carries the table entries it cannot link to. */
export const authorityBytesRequired = (draft, requirements) =>
  draft.outputMode !== "table" || !!(draft.insertIntoDocument &&
    requirements?.unlinkedPdfTableSources && draft.import.kind === "document" &&
    draft.import.fileType === "pdf");
/** Whether the build puts this one authority's own PDF in front of the court. */
export const authorityPdfRequired = (draft, authority, requirements) =>
  draft.outputMode !== "table" || !!(requirements?.unlinkedPdfTableSources &&
    draft.import.kind === "document" && draft.import.fileType === "pdf" &&
    !authoritySourceUrl(authority));

/** The one rule for "does this authority still owe a source", asked by the builder
 *  (which throws), the resolver (which fetches) and the workspace (which warns).
 *  `requirements` names the obligations the caller enforces; `prepared` says whether
 *  a source decision nobody has acted on yet already counts as missing. */
export function authoritySourceRequirement(draft, authority, requirements, prepared = true) {
  const attached = authority.source.kind === "attached";
  if (!prepared && ["unresolved", "resolved"].includes(authority.source.kind)) return null;
  if (!authority.excluded) {
    if (attached && bilingualEnactmentRequired(authority, requirements) &&
        !hasBilingualAuthoritySource(authority.source)) return "incomplete-enactment";
    if (!attached && requirements?.completeBookSources) return "missing";
  }
  // A table links every authority it lists, one the book leaves out included; only
  // the authority's own PDF, appended to a PDF filing, stands in for the link.
  return requirements?.unlinkedPdfTableSources && !authoritySourceUrl(authority) &&
    !(attached && draft.insertIntoDocument && draft.import.kind === "document" &&
      draft.import.fileType === "pdf") ? "unlinked" : null;
}

export const authoritiesBookPdfs = (draft) => [
  ...(draft.bookParts.cover ? [draft.bookParts.cover] : []),
  ...(draft.bookParts.index ? [draft.bookParts.index] : []),
  ...draft.bookParts.supplements,
];

export function removeUnusedBinding(draft, role) {
  if (!role || draft.import.kind === "document" && draft.import.bindingRole === role ||
      Object.values(draft.authorities).some((authority) =>
        attachedAuthoritySources(authority.source).some(({ bindingRole }) => bindingRole === role)) ||
      authoritiesBookPdfs(draft).some(({ bindingRole }) => bindingRole === role)) return;
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
  const included = authoritySources.filter(({ authority }) => !authority.excluded);
  const needsBook = draft.outputMode !== "table";
  const bookPdfs = needsBook ? authoritiesBookPdfs(draft) : [];
  return {
    authoritySources, bookPdfs,
    bookRoles: new Set(needsBook ? included.map(({ source }) => source.bindingRole) : []),
    byteRoles: new Set([
      ...(authorityBytesRequired(draft, requirements)
        ? included.map(({ source }) => source.bindingRole) : []),
      ...(draft.insertIntoDocument && draft.import.kind === "document"
        ? [draft.import.bindingRole] : []),
      ...bookPdfs.map(({ bindingRole }) => bindingRole),
    ]),
  };
}
