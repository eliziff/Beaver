import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

import type { LegalSourcePassage } from "../legalSources";
import { govInfoLegalSourceProvider } from "../legalSources/govInfo";
import {
  govUkEmploymentTribunalLegalSourceProvider,
} from "../legalSources/govUkEmploymentTribunal";
import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
import { tnaLegalSourceProvider } from "../legalSources/tna";

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, contentType = "application/json") {
  return new Response(
    contentType === "application/json" ? JSON.stringify(body) : String(body),
    { status: 200, headers: { "Content-Type": contentType } },
  );
}

function provider(id: "tna" | "govuk-et" | "govinfo") {
  return {
    tna: tnaLegalSourceProvider,
    "govuk-et": govUkEmploymentTribunalLegalSourceProvider,
    govinfo: govInfoLegalSourceProvider,
  }[id];
}

function native(passage: LegalSourcePassage) {
  return passage.native as RemoteLegalSourceDocument;
}

describe("remote legal-source providers", () => {
  it("stops before remote I/O when the read is cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tnaLegalSourceProvider.resolve!({
      text: "[2024] UKSC 1",
      kind: "case",
      signal: AbortSignal.abort(),
    })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
