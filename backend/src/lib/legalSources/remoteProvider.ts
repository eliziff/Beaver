import { cachedContent } from "../contentCache";
import { guardedRemoteFetch, normalizeRemoteHttpsUrl } from "../remoteUrlSafety";
import {
  type NativeDocument,
} from "../structureNative";
import { jsonRecord as objectValue } from "../value";
import { nativeDocumentPassages } from "./nativeDocumentPassages";
import type { LegalSourcePassageRequest, LegalSourceReference, LegalSourceProvider } from ".";

const DAY_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type JsonObject = Record<string, unknown>;

export type RemoteLegalSourceAttachment = {
  title: string | null;
  url: string;
  contentType: string | null;
  filename: string | null;
  pageCount: number | null;
};

export type RemoteLegalSourceDocument = {
  provider: "tna" | "govuk-et" | "govinfo";
  identity: string;
  title: string | null;
  url: string;
  native: NativeDocument;
  attachments: RemoteLegalSourceAttachment[];
};

export type RemoteLegalSourceProvider = LegalSourceProvider<RemoteLegalSourceDocument>;

export { objectValue };

export const arrayValue = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value) ? value : [value];

export function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const text = objectValue(value)?.["#text"];
  return typeof text === "string" ? text.trim() || null : null;
}

function nonnegativeNumber(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** One URL-checked attachment; each provider names its own metadata fields. */
export const remoteLegalSourceAttachment = (url: string | null, fields: {
  title: unknown; contentType: unknown; filename: unknown; pageCount: unknown;
}): RemoteLegalSourceAttachment[] => url ? [{
  title: stringValue(fields.title), url,
  contentType: stringValue(fields.contentType),
  filename: stringValue(fields.filename),
  pageCount: nonnegativeNumber(fields.pageCount),
}] : [];

/**
 * The passage path every remote provider shares: fetch the document for one
 * search result, then read it through the requested locator. The provider's own
 * reference wins over the stored one except for the freshly fetched title.
 */
export async function remoteLegalSourcePassages<Result>(
  request: LegalSourcePassageRequest,
  result: Result | null,
  fetchDocument: (result: Result, signal?: AbortSignal) => Promise<RemoteLegalSourceDocument>,
  reference: (result: Result) => LegalSourceReference,
) {
  if (!result) return [];
  const document = await fetchDocument(result, request.signal);
  return nativeDocumentPassages({
    request,
    reference: { ...request.source, ...reference(result), title: document.title },
    document: document.native,
    native: document,
  });
}

export function legalSourceUrl(
  raw: unknown,
  base: string,
  allowedHosts: readonly string[],
) {
  const value = stringValue(raw);
  if (!value) return null;
  try {
    const url = new URL(value, base);
    url.searchParams.delete("api_key");
    return normalizeRemoteHttpsUrl(url.toString(), {
      label: "Legal source URL",
      allowedHosts,
      defaultPortOnly: true,
      allowIpLiterals: false,
    }).url.toString();
  } catch {
    return null;
  }
}

export async function cachedLegalSourceJson(
  url: string,
  allowedHost: "www.gov.uk" | "api.govinfo.gov",
  init?: RequestInit,
): Promise<JsonObject> {
  init?.signal?.throwIfAborted();
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.delete("api_key");
  const body = typeof init?.body === "string" ? ` ${init.body}` : "";
  const value = await cachedContent({
    scope: "shared",
    kind: "legal-source-json",
    key: `${init?.method ?? "GET"} ${cacheUrl}${body}`,
    version: 1,
    ttlMs: DAY_MS,
    produce: async () => {
      const headers = new Headers(init?.headers);
      headers.set("Accept", "application/json");
      const response = await guardedRemoteFetch(
        url,
        { ...init, headers },
        {
          label: "Legal source request",
          allowedHosts: [allowedHost],
          defaultPortOnly: true,
          allowIpLiterals: false,
          timeoutMs: REQUEST_TIMEOUT_MS,
          response: {
            label: "Legal source response",
            maxBytes: 32 * 1024 * 1024,
            contentTypes: ["application/json", "application/*+json"],
          },
        },
      );
      if (!response.ok) {
        throw new Error(`Legal source request failed (${response.status})`);
      }
      return objectValue(await response.json()) ?? {};
    },
  });
  init?.signal?.throwIfAborted();
  return value;
}
