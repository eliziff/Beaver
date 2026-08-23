import { deriveDocumentNative } from "../structureNative";
import type { LegalSourceReference } from ".";
import {
  arrayValue,
  cachedLegalSourceJson,
  legalSourceUrl,
  nonnegativeNumber,
  objectValue,
  stringValue,
  type RemoteLegalSourceAttachment,
  type RemoteLegalSourceDocument,
  type RemoteLegalSourceProvider,
} from "./remoteProvider";
import { nativeDocumentPassages } from "./sourceDocPassages";
import { escapeXmlText } from "../text";

const ORIGIN = "https://www.gov.uk";
const HOST = "www.gov.uk";
const CASE_NUMBER = /(?<![\w/])(?:[A-Z]\/)?\d{6,8}\/(?:19|20)\d{2}(?![\w/])/giu;

type EmploymentTribunalSearchResult = {
  caseNumber: string;
  title: string;
  url: string;
};

function caseNumberFrom(value: string) {
  const matches = new Set(
    [...value.matchAll(CASE_NUMBER)].map(([match]) => match.toUpperCase()),
  );
  return matches.size === 1 ? [...matches][0] : "";
}

async function searchEmploymentTribunalCase(
  text: string,
  signal?: AbortSignal,
) {
  const caseNumber = caseNumberFrom(text);
  if (!caseNumber) return null;
  const query = new URLSearchParams({
    q: caseNumber,
    filter_format: "employment_tribunal_decision",
    count: "50",
  });
  const body = await cachedLegalSourceJson(
    `${ORIGIN}/api/search.json?${query}`,
    HOST,
    { signal },
  );
  const matches = new Map<string, EmploymentTribunalSearchResult>();
  for (const value of arrayValue(body.results)) {
    const item = objectValue(value);
    const title = stringValue(item?.title);
    const link = stringValue(item?.link);
    if (
      stringValue(item?.format) !== "employment_tribunal_decision" ||
      !title || !link || !link.startsWith("/employment-tribunal-decisions/") ||
      ![...title.matchAll(CASE_NUMBER)].some(
        ([match]) => match.toUpperCase() === caseNumber,
      )
    ) continue;
    const url = legalSourceUrl(link, ORIGIN, [HOST]);
    if (url) matches.set(url, { caseNumber, title, url });
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function hiddenMarkup(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value.map(hiddenMarkup).filter(Boolean).join("\n")
    : "";
}

function attachments(value: unknown): RemoteLegalSourceAttachment[] {
  const hosts = [HOST, "assets.publishing.service.gov.uk"];
  return arrayValue(value).flatMap((raw) => {
    const attachment = objectValue(raw);
    const url = legalSourceUrl(attachment?.url, ORIGIN, hosts);
    return url ? [{
      title: stringValue(attachment?.title),
      url,
      contentType: stringValue(attachment?.content_type ?? attachment?.contentType),
      filename: stringValue(attachment?.filename),
      pageCount: nonnegativeNumber(
        attachment?.number_of_pages ?? attachment?.page_count,
      ),
    }] : [];
  });
}

async function fetchEmploymentTribunalCase(
  result: EmploymentTribunalSearchResult,
  signal?: AbortSignal,
): Promise<RemoteLegalSourceDocument> {
  const url = legalSourceUrl(result.url, ORIGIN, [HOST]);
  if (!url) throw new Error("Invalid GOV.UK case URL");
  const path = new URL(url).pathname;
  if (!path.startsWith("/employment-tribunal-decisions/")) {
    throw new Error("Invalid GOV.UK Employment Tribunal path");
  }
  const body = await cachedLegalSourceJson(
    `${ORIGIN}/api/content${path}`,
    HOST,
    { signal },
  );
  const details = objectValue(body.details) ?? {};
  const title = stringValue(body.title) ?? result.title;
  const description = stringValue(body.description);
  const text = [title, description]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const hiddenHtml = hiddenMarkup(details.hidden_indexable_content);
  const markup = hiddenHtml
    ? [title, description]
        .filter((value): value is string => Boolean(value))
        .map((value) => `<p>${escapeXmlText(value)}</p>`)
        .join("") + hiddenHtml
    : null;
  const native = await deriveDocumentNative({
    kind: "native_markup",
    input: {
      provider: "govuk-et",
      id: result.caseNumber,
      url,
      text,
      markup,
      scope: { kind: "excerpt", excerptOf: result.caseNumber },
    },
  });
  return {
    provider: "govuk-et",
    identity: result.caseNumber,
    title,
    url,
    native,
    attachments: attachments(details.attachments),
  };
}

const reference = (result: EmploymentTribunalSearchResult) => ({
  provider: "govuk-et",
  id: result.caseNumber,
  kind: "case",
  title: result.title,
  citation: result.caseNumber,
  url: result.url,
}) satisfies LegalSourceReference;

export const govUkEmploymentTribunalLegalSourceProvider: RemoteLegalSourceProvider = {
  id: "govuk-et",
  canResolve: ({ kind, text }) => kind === "case" && Boolean(caseNumberFrom(text)),
  async resolve({ text, signal }) {
    const result = await searchEmploymentTribunalCase(text, signal);
    return result ? [reference(result)] : [];
  },
  async readPassage(request) {
    const { source, signal } = request;
    const result = source.url
      ? {
          caseNumber: source.citation || source.id,
          title: source.title || source.citation || source.id,
          url: source.url,
        }
      : await searchEmploymentTribunalCase(source.citation || source.id, signal);
    if (!result) return [];
    const document = await fetchEmploymentTribunalCase(result, signal);
    return nativeDocumentPassages({
      request,
      reference: { ...source, ...reference(result), title: document.title },
      document: document.native,
      native: document,
    });
  },
};
