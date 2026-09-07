import { buildA2AJDocumentPinpointUrl, buildA2AJParagraphRangeUrl,
  buildLegalSourcePinpointUrl, legalSourceLocatorAnchor } from "../legalSourceLinks";
import { buildCanliiCaseUrl } from "../canliiUrls";
import { plainInlineText } from "../legalSourcePresentation";
import type { RegisteredEvidence } from "./legalEvidence";

export type CitationPresentation = {
  authority: string;
  shortAuthority: string;
  locator: { separator: " at " | ", "; text: string; label: string } | null;
  sourceUrl: string | null;
  passageUrl: string | null;
};

function locatorValue(label: string) {
  return label
    .trim()
    .replace(/^(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/iu, "")
    .replace(/\s*[-\u2013\u2014]\s*/gu, "\u2013")
    .replace(/\u2013(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/giu, "\u2013");
}

function presentLegalEvidenceLocator(
  kind: RegisteredEvidence["receipt"]["locator"]["kind"],
  labels: readonly string[],
): CitationPresentation["locator"] {
  if (kind === "document") return null;
  const values = [...new Set(labels.map(locatorValue).filter(Boolean))];
  if (!values.length) return null;
  const value = values.join(", ");
  const plural = values.length > 1 || value.includes("\u2013");
  const pluralProvision = plural && !(kind === "section" && /\u2013\(/u.test(value));
  return {
    separator: kind === "section" ? ", " : " at ",
    label: value,
    text: kind === "page" || kind === "sheet" || kind === "cell"
      ? value
      : `${kind === "paragraph" ? plural ? "paras" : "para" : kind === "section" ? pluralProvision ? "ss" : "s" : plural ? "nn" : "n"} ${value}`,
  };
}

export function presentLegalEvidence(
  entry: RegisteredEvidence,
  quotes: string[] = entry.receipt.span_text ? [entry.receipt.span_text] : [],
  locatorLabels: readonly string[] = [entry.receipt.locator.label],
  // The citation group's locator system, which its unpinpointed members share.
  locatorKind: RegisteredEvidence["receipt"]["locator"]["kind"] = entry.receipt.locator.kind,
): CitationPresentation {
  const { receipt, document } = entry;
  const source = entry.source ?? document?.native ?? null;
  const retrievedSourceUrl = document?.url ?? receipt.external_url;
  // The ordinary authority link may use CanLII. Passage links must stay on the
  // provider document whose text was actually used to verify the fragment.
  const citationUrl =
    (receipt.source_class === "case"
      ? buildCanliiCaseUrl({
          dataset: receipt.dataset,
          citations: [receipt.citation],
          language: receipt.language,
        })
      : null) ?? retrievedSourceUrl;
  const fragmentSourceUrl = receipt.provider === "a2aj"
    ? retrievedSourceUrl
    : citationUrl;
  const range = receipt.locator.kind === "paragraph"
    ? receipt.locator.label.match(/^par(\d+)(?:-|\u2013|\u2014)par(\d+)$/iu)
    : null;
  const rangeUrl = range
    ? buildA2AJParagraphRangeUrl(
          receipt.citation,
          range[1],
          range[2],
          document,
        )
    : null;
  const a2ajLocator = ["paragraph", "page", "section"].includes(
    receipt.locator.kind,
  ) ? receipt.locator as {
      kind: "paragraph" | "page" | "section";
      label: string;
    } : null;
  const a2ajUrl = receipt.provider === "a2aj" && receipt.span_text && a2ajLocator
    ? document
      ? buildA2AJDocumentPinpointUrl(
          document,
          a2ajLocator,
          receipt.span_text,
          quotes,
        )
      : null
    : null;
  const passageUrl = fragmentSourceUrl && receipt.span_text
    ? rangeUrl ?? a2ajUrl ?? buildLegalSourcePinpointUrl(
          {
            url: fragmentSourceUrl,
            anchor: a2ajLocator
              ? legalSourceLocatorAnchor(
                  fragmentSourceUrl,
                  a2ajLocator.kind,
                  a2ajLocator.label,
                )
              : undefined,
            blockText: receipt.span_text,
            ...(source && { documentText: source }),
          },
          quotes,
        )
    : citationUrl;
  const name = receipt.name?.trim() ?? "";
  const citation = receipt.citation.trim();
  const authority = receipt.provider === "journal"
    ? citation || name || "Source"
    : name && !name.toLocaleLowerCase("en-CA").includes(citation.toLocaleLowerCase("en-CA"))
      ? `${name}, ${citation}`
      : citation || name || "Source";
  return {
    authority: plainInlineText(authority),
    shortAuthority: plainInlineText(name || citation || "Source"),
    locator: presentLegalEvidenceLocator(locatorKind, locatorLabels),
    sourceUrl: citationUrl,
    passageUrl,
  };
}
