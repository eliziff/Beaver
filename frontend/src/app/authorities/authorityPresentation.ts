import { authorityPdfRequired, authoritySourceRequirement,
  bilingualEnactmentRequired } from "../../../../shared/authorities-sources.mjs";
import type { AuthorityIdentity, AuthorityOccurrence, AuthoritiesProduct, AuthoritySourceLanguage } from "./types";
import type { AuthoritiesSourceIssue } from "./host";
import { authoritiesProfile } from "./profiles";

export function authorityName(item: AuthorityIdentity) {
  return item.displayName || item.name || item.citation || "Untitled authority";
}
export function authorityLabel(item: AuthorityIdentity) {
  const name = authorityName(item), citation = item.citation.trim();
  return !citation || name.toLocaleLowerCase().includes(citation.toLocaleLowerCase())
    ? name : `${name}, ${citation}`;
}
export function authorityCitationForms(item: AuthorityIdentity, occurrences: AuthorityOccurrence[]) {
  const forms = [...new Set([item.citation, ...occurrences.filter(({ authorityId, kind }) =>
    authorityId === item.id && kind !== "reference").map(({ citation }) => citation)]
    .map((citation) => citation.trim()).filter(Boolean))];
  // "1954 CanLII 3" is "1954 CanLII 3 (SCC)" without the court it is cited with: one form.
  return forms.filter((form) => !forms.some((other) => other.startsWith(`${form} (`)));
}
const courtRequirements = (state: AuthoritiesProduct["state"]) =>
  authoritiesProfile(state.settings.profileId).requirements;
export function requiresBilingualSources(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  return bilingualEnactmentRequired(item, courtRequirements(state));
}
export function sourceLanguageLabel(language: AuthoritySourceLanguage) {
  return language === "en" ? "English" : language === "fr" ? "French" : "English and French";
}
export function requiresPdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  return authorityPdfRequired(state, item, courtRequirements(state));
}
/** The sources step warns about every PDF the build would use, whatever leeway the
 *  court allows; `prepared` is when a source decision nobody has acted on counts. */
export function missingSource(state: AuthoritiesProduct["state"], item: AuthorityIdentity,
  prepared = false) {
  const owed = requiresPdf(state, item);
  return !!authoritySourceRequirement(state, item, { completeBookSources: owed,
    bilingualEnactments: owed && !!courtRequirements(state)?.bilingualEnactments }, prepared);
}
/** A changed file is relinked automatically; only a permission problem needs the reader. */
export function relinkable(issue?: AuthoritiesSourceIssue | null): issue is AuthoritiesSourceIssue {
  return issue?.status === "missing" && issue.reason === "permission";
}
