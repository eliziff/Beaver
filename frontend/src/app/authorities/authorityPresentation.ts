import { hasBilingualAuthoritySource } from "../../../../shared/authorities-sources.mjs";
import type { AuthorityIdentity, AuthorityOccurrence, AuthoritiesProduct, AuthoritySourceLanguage } from "./types";
import type { AuthoritiesSourceIssue } from "./host";
import { authoritiesProfile } from "./profiles";
import type { Citation } from "@/app/lib/citations";

export function authoritySourceCitation(state: AuthoritiesProduct["state"], item: AuthorityIdentity): Citation | null {
  const source = item.source.kind === "attached" ? item.source.sources[0] : null,
    binding = source && state.bindings[source.bindingRole], locator = item.locators[0] ?? Object.values(state.occurrences)
      .find(occurrence => occurrence.authorityId === item.id && occurrence.pinpoints.length)?.pinpoints
      .map(point => ({ kind: point.kind, label: point.text }))[0],
    external_url = item.sourceIdentity?.externalUrl ?? (item.source.kind === "pending-canlii" ? item.source.pageUrl : source?.sourceUrl),
    mark = source && item.annotations?.[source.bindingRole]?.marks[0];
  if (item.sourceIdentity?.provider === "a2aj") return { kind: "a2aj", ref: 1, citation: item.citation,
    name: authorityName(item), external_url, locator: locator?.label, quotes: [] };
  if (binding?.kind === "document") return { kind: "document", ref: 1, document_id: binding.documentId,
    version_id: binding.version === "latest" ? undefined : binding.version.versionId,
    filename: authorityName(item), authority: authorityLabel(item), external_url, locator: locator?.label,
    quotes: mark ? [{ quote: mark.excerpt, page: mark.fragments[0]?.pageNumber }]
      : locator?.kind === "page" ? [{ quote: "", page: Number(locator.label.replace(/^page\s*/iu, "")) }] : [] };
  const identity = item.sourceIdentity;
  return identity && ["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"].includes(identity.provider)
    ? { kind: "public_legal", ref: 1, provider: identity.provider as Extract<Citation, { kind: "public_legal" }>["provider"],
      identifier: identity.stableSourceId, citation: item.citation, title: authorityName(item), external_url, locator: locator?.label, quotes: [] } : null;
}

export function authorityName(item: AuthorityIdentity) {
  return item.displayName || item.name || item.citation || "Untitled authority";
}
export function authorityLabel(item: AuthorityIdentity) {
  const name = authorityName(item), citation = item.citation.trim();
  return !citation || name.toLocaleLowerCase().includes(citation.toLocaleLowerCase())
    ? name : `${name}, ${citation}`;
}
export function authorityCitationForms(item: AuthorityIdentity, occurrences: AuthorityOccurrence[]) {
  return [...new Set([item.citation, ...occurrences.filter(({ authorityId, kind }) =>
    authorityId === item.id && kind !== "reference").map(({ citation }) => citation)]
    .map((citation) => citation.trim()).filter(Boolean))];
}
export function requiresBilingualSources(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  return !!authoritiesProfile(state.settings.profileId).requirements?.bilingualEnactments &&
    item.kind === "legislation" && /\b(?:R\.?S\.?C\.?|S\.?C\.?|C\.?R\.?C\.?|SOR|SI|DORS|TR)\b/iu.test(item.citation);
}
export function hasRequiredSources(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  if (item.source.kind !== "attached" || !item.source.sources.length) return false;
  return !requiresBilingualSources(state, item) || hasBilingualAuthoritySource(item.source);
}
export function sourceLanguageLabel(language: AuthoritySourceLanguage) {
  return language === "en" ? "English" : language === "fr" ? "French" : "English and French";
}
export function requiresPdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  return state.outputMode !== "table" || requiresUnlinkedTablePdf(state, item);
}
export function missingSource(state: AuthoritiesProduct["state"], item: AuthorityIdentity,
  prepared = false) {
  if (!requiresPdf(state, item)) return false;
  if (item.source.kind === "attached") return !hasRequiredSources(state, item);
  return item.source.kind === "pending-canlii" || prepared &&
    (item.source.kind === "unresolved" || item.source.kind === "resolved");
}
function requiresUnlinkedTablePdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  const sourceUrl = item.source.kind === "attached"
    ? item.source.sources.find(({ sourceUrl }) => sourceUrl)?.sourceUrl
    : item.source.kind === "pending-canlii" ? item.source.pageUrl
      : item.sourceIdentity?.externalUrl;
  return !!authoritiesProfile(state.settings.profileId).requirements?.unlinkedPdfTableSources &&
    state.import.kind === "document" && state.import.fileType === "pdf" && !sourceUrl;
}
export function sourceAction(issue: AuthoritiesSourceIssue, label: string) {
  return issue.status === "changed" ? `Use updated ${label}` : "Allow file access";
}
export function relinkable(issue?: AuthoritiesSourceIssue | null): issue is AuthoritiesSourceIssue {
  return issue?.status === "changed" ||
    (issue?.status === "missing" && issue.reason === "permission");
}
