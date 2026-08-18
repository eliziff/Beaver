import {
  buildA2AJParagraphRangeUrl,
  buildLegalSourcePinpointUrl,
} from "../legalSourceLinks";
import { buildCanliiCaseUrl } from "../canliiUrls";
import {
  tokenizeLegalInline,
  type LegalInlineToken,
} from "../legalSourcePresentation";
import type { RegisteredEvidence } from "./legalEvidence";

export type CitationPresentation = {
  authority: LegalInlineToken[];
  shortAuthority: LegalInlineToken[];
  locator: { separator: " at " | ", "; text: string } | null;
  sourceUrl: string | null;
  passageUrl: string | null;
};

export function citationPresentationText(tokens: LegalInlineToken[]) {
  return tokens.map(({ text }) => text).join("");
}

function receiptLocator(entry: RegisteredEvidence): CitationPresentation["locator"] {
  const { kind, label } = entry.receipt.locator;
  if (kind === "document") return null;
  const value = label
    .trim()
    .replace(/^(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/iu, "")
    .replace(/\s*[-\u2013\u2014]\s*/gu, "\u2013")
    .replace(/\u2013(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/giu, "\u2013");
  const range = value.includes("\u2013");
  return {
    separator: kind === "section" ? ", " : " at ",
    text: kind === "page"
      ? value
      : `${kind === "paragraph" ? range ? "paras" : "para" : kind === "section" ? range ? "ss" : "s" : range ? "nn" : "n"} ${value}`,
  };
}

function receiptAnchor(entry: RegisteredEvidence) {
  const { kind, label } = entry.receipt.locator;
  if (kind === "paragraph") {
    const number = label.match(/^par(\d+)/iu)?.[1];
    return number ? `par${Number(number)}` : undefined;
  }
  if (kind === "section") return label.match(/^sec[\w.-]+/iu)?.[0];
  if (kind === "page") {
    const number = label.match(/(?:page=?|^)(\d+)/iu)?.[1];
    return number ? `page=${Number(number)}` : undefined;
  }
  return undefined;
}

export function presentLegalEvidence(
  entry: RegisteredEvidence,
  quotes: string[] = entry.receipt.span_text ? [entry.receipt.span_text] : [],
): CitationPresentation {
  const { receipt, lookup, document } = entry;
  const sourceUrl =
    (receipt.source_class === "case"
      ? buildCanliiCaseUrl({
          dataset: receipt.dataset,
          citations: [receipt.citation],
          language: receipt.language,
        })
      : null) ?? receipt.external_url;
  const range = receipt.locator.kind === "paragraph"
    ? receipt.locator.label.match(/^par(\d+)(?:-|\u2013|\u2014)par(\d+)$/iu)
    : null;
  const rangeUrl = range
    ? buildA2AJParagraphRangeUrl(
          receipt.citation,
          range[1],
          range[2],
          lookup ? [lookup] : [],
          document ? [document] : [],
        )
    : null;
  const passageUrl = sourceUrl && receipt.span_text
    ? rangeUrl ?? buildLegalSourcePinpointUrl(
          { url: sourceUrl, anchor: receiptAnchor(entry), blockText: receipt.span_text },
          quotes,
        )
    : sourceUrl;
  const name = receipt.name?.trim() ?? "";
  const citation = receipt.citation.trim();
  const authority = receipt.provider === "journal"
    ? citation || name || "Source"
    : name && !name.toLocaleLowerCase("en-CA").includes(citation.toLocaleLowerCase("en-CA"))
      ? `${name}, ${citation}`
      : citation || name || "Source";
  return {
    authority: tokenizeLegalInline(authority),
    shortAuthority: tokenizeLegalInline(name || citation || "Source"),
    locator: receiptLocator(entry),
    sourceUrl,
    passageUrl,
  };
}
