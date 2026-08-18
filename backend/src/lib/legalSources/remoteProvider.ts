import { cachedContent } from "../contentCache";
import { guardedRemoteFetch, normalizeRemoteHttpsUrl } from "../remoteUrlSafety";
import type { SourceDoc, SourceDocLookup } from "../sourceDoc";
import type { NativeMarkupRef } from "../sourceDocNativeMarkup";
import type { LegalSourceProvider } from ".";

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
  structure: SourceDoc;
  attachments: RemoteLegalSourceAttachment[];
  citedAuthorities?: NativeMarkupRef[];
  sourceSha256?: string;
};

export type RemoteLegalSourceNative = {
  document: RemoteLegalSourceDocument;
  lookup?: SourceDocLookup;
};

export type RemoteLegalSourceProvider = LegalSourceProvider<
  SourceDoc | string,
  RemoteLegalSourceNative
>;

export const objectValue = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;

export const arrayValue = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value) ? value : [value];

export function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const text = objectValue(value)?.["#text"];
  return typeof text === "string" ? text.trim() || null : null;
}

export function nonnegativeNumber(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
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
