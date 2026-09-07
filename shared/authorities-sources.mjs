export const attachedAuthoritySources = (source) =>
  source.kind === "attached" ? source.sources : [];
export const hasBilingualAuthoritySource = (source) => {
  const languages = attachedAuthoritySources(source).map(({ language }) => language);
  return languages.includes("bilingual") ||
    ["en", "fr"].every((language) => languages.includes(language));
};
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
  const needsFilingPdfs = draft.insertIntoDocument && requirements?.unlinkedPdfTableSources &&
    draft.import.kind === "document" && draft.import.fileType === "pdf";
  const bookPdfs = needsBook ? authoritiesBookPdfs(draft) : [];
  return {
    authoritySources, bookPdfs,
    bookRoles: new Set(needsBook ? included.map(({ source }) => source.bindingRole) : []),
    byteRoles: new Set([
      ...(needsBook || needsFilingPdfs ? included.map(({ source }) => source.bindingRole) : []),
      ...(draft.insertIntoDocument && draft.import.kind === "document"
        ? [draft.import.bindingRole] : []),
      ...bookPdfs.map(({ bindingRole }) => bindingRole),
    ]),
  };
}
