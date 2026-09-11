import { structureNative } from "../structureNative";
import {
  arrayValue,
  cachedLegalSourceJson,
  legalSourceUrl,
  objectValue,
  remoteCaseProvider,
  remoteLegalSourceAttachment,
  stringValue,
  type RemoteLegalSourceAttachment,
  type RemoteLegalSourceDocument,
} from "./remoteProvider";
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
    return remoteLegalSourceAttachment(legalSourceUrl(attachment?.url, ORIGIN, hosts), {
      title: attachment?.title,
      contentType: attachment?.content_type ?? attachment?.contentType,
      filename: attachment?.filename,
      pageCount: attachment?.number_of_pages ?? attachment?.page_count });
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
  const native = await structureNative().deriveDocumentStructure({
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

export const govUkEmploymentTribunalLegalSourceProvider = remoteCaseProvider({
  id: "govuk-et",
  matches: caseNumberFrom,
  search: searchEmploymentTribunalCase,
  fetch: fetchEmploymentTribunalCase,
  reference: (result: EmploymentTribunalSearchResult) => ({
    id: result.caseNumber,
    title: result.title,
    citation: result.caseNumber,
    url: result.url,
  }),
  fromSource: (source) => source.url
    ? {
        caseNumber: source.citation || source.id,
        title: source.title || source.citation || source.id,
        url: source.url,
      }
    : null,
});
