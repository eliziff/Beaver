/** CanLII statute or regulation page for an A2AJ legislation record; publishers' own links are XML feeds, API endpoints or PDFs. */
export function buildCanliiLawUrl({ dataset, citation, language }: { dataset: string; citation: string | null; language: "en" | "fr" }) {
  const match = /^(LEGISLATION|REGULATIONS)-(FED|AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/u.exec(dataset.trim().toUpperCase());
  const slug = citation?.trim().toLowerCase().replace(/[^a-z0-9.]+/gu, "-").replace(/^-|-$/gu, "");
  if (!match || !slug) return null;
  const jurisdiction = match[2] === "FED" ? "ca" : match[2].toLowerCase(), kind = match[1] === "LEGISLATION" ? "stat" : "regu";
  return `https://www.canlii.org/${language}/${jurisdiction}/laws/${kind}/${slug}/latest/${slug}.html`;
}
