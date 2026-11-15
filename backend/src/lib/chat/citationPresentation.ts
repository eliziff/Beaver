import { a2ajDocumentLink, buildLegalSourcePinpoint } from "../legalSourceLinks";
import { structureNative } from "../structureNative";
import { plainInlineText } from "../legalSourcePresentation";
import type { RegisteredEvidence } from "./legalEvidence";

export type CitationPresentation = {
  authority: string;
  shortAuthority: string;
  locator: { separator: " at " | ", "; text: string; label: string } | null;
  sourceUrl: string | null;
  passageUrl: string | null;
};

/** A locator's label as a citation prints it: as the document prints it, a range's dash an en dash. */
function locatorValue(label: string) {
  return label.trim().replace(/\s*[-\u2013\u2014]\s*/gu, "\u2013");
}

function presentLegalEvidenceLocator(
  kind: RegisteredEvidence["receipt"]["locator"]["kind"],
  labels: readonly string[],
): CitationPresentation["locator"] {
  if (kind === "document") return null;
  const values = [...new Set(labels.map((label) => kind === "cell" || kind === "sheet" ? label.trim() : locatorValue(label)).filter(Boolean))];
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

/** The authority an entry names (style of cause and citation), without planning a passage link. */
export function legalEvidenceAuthority(receipt: RegisteredEvidence["receipt"]) {
  const name = receipt.name?.trim() ?? "";
  const citation = receipt.citation.trim();
  return plainInlineText(receipt.provider === "journal"
    ? citation || name || "Source"
    : name && !name.toLocaleLowerCase("en-CA").includes(citation.toLocaleLowerCase("en-CA"))
      ? `${name}, ${citation}`
      : citation || name || "Source");
}

/** The pinpoint text an entry presents on its own, without planning a passage link. */
export function legalEvidenceLocatorText(entry: RegisteredEvidence) {
  return legalEvidenceLocator(entry, [entry.receipt.locator.label], entry.receipt.locator.kind)?.text ?? null;
}

function legalEvidenceLocator(entry: RegisteredEvidence, locatorLabels: readonly string[],
  locatorKind: RegisteredEvidence["receipt"]["locator"]["kind"]) {
  const { receipt } = entry;
  return receipt.provider === "library" && locatorKind === "document" && receipt.locator.label !== "document"
    ? { separator: " at " as const, text: receipt.locator.label, label: receipt.locator.label }
    : presentLegalEvidenceLocator(locatorKind, locatorLabels);
}

export function presentLegalEvidence(
  entry: RegisteredEvidence,
  members: readonly RegisteredEvidence[] = [entry],
  locatorLabels: readonly string[] = [entry.receipt.locator.label],
  // The citation group's locator system, which its unpinpointed members share.
  locatorKind: RegisteredEvidence["receipt"]["locator"]["kind"] = entry.receipt.locator.kind,
): CitationPresentation {
  const { receipt, document } = entry;
  const quotes = [...new Set(members.flatMap(({ receipt }) => receipt.span_text ? [receipt.span_text] : []))];
  // Each quotation keeps its own island; joining the search scope does not
  // authorize painting the text between disjoint receipts.
  const blockText = quotes.join("\n\n");
  // The paragraphs the members cite, each one node's label; the group's labels are their runs.
  const paragraphCount = locatorKind === "paragraph" ? new Set(members.flatMap(({ receipt }) =>
    receipt.locator.kind === "paragraph" ? [receipt.locator.label] : [])).size : quotes.length;
  const bounded = quotes.length <= 5 && paragraphCount <= 5 &&
    (blockText.match(/\S+/gu)?.length ?? 0) <= 1_500 &&
    members.every(({ receipt: member }) => member.source_sha256 === receipt.source_sha256);
  const source = entry.source ?? document?.native ?? null;
  const retrievedSourceUrl = document?.url ?? receipt.external_url;
  // The ordinary authority link may use CanLII. Passage links must stay on the
  // provider document whose text was actually used to verify the fragment.
  const citationUrl =
    (receipt.source_class === "case"
      ? document?.canliiUrl
      : null) ?? retrievedSourceUrl;
  const fragmentSourceUrl = receipt.provider === "a2aj"
    ? retrievedSourceUrl
    : citationUrl;
  const a2ajLocator = ["paragraph", "page", "section"].includes(
    receipt.locator.kind,
  ) ? receipt.locator as {
      kind: "paragraph" | "page" | "section";
      label: string;
    } : null;
  // A fragment is only ever built against the document whose text verified
  // the quote. Without it the directive would be spelled blind and paint
  // whichever passage happens to match first, so fall back to the plain
  // authority link instead.
  let passageUrl = citationUrl;
  if (bounded && fragmentSourceUrl && blockText && source) {
    if (receipt.provider === "a2aj" && document && a2ajLocator) {
      passageUrl = a2ajDocumentLink(document, a2ajLocator, blockText, quotes) ?? citationUrl;
    } else {
      const planned = buildLegalSourcePinpoint(
          {
            url: fragmentSourceUrl,
            anchor: a2ajLocator
              ? structureNative().sourceAnchor(fragmentSourceUrl, a2ajLocator.kind, [a2ajLocator.label])[0] ?? undefined
              : undefined,
            blockText,
            documentText: source,
          },
          quotes,
        );
      if (planned?.plan?.sourceSafeComplete) passageUrl = planned.target;
    }
  }
  const name = receipt.name?.trim() ?? "";
  const citation = receipt.citation.trim();
  return {
    authority: legalEvidenceAuthority(receipt),
    shortAuthority: plainInlineText(
      receipt.provider === "journal" ? citation.split(/, “/u)[0] || name || "Source"
        : name || citation || "Source",
    ),
    locator: legalEvidenceLocator(entry, locatorLabels, locatorKind),
    sourceUrl: citationUrl,
    passageUrl: passageUrl && passageUrl.length <= 8_192 ? passageUrl : citationUrl,
  };
}
