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
  return passage.native as {
    document: RemoteLegalSourceDocument;
    lookup?: { status: string; block?: { text: string; origin: string } | null };
  };
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

  it("follows TNA alternate links and preserves native paragraph and section eIds", async () => {
    const atom = `
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:tna="https://caselaw.nationalarchives.gov.uk">
        <entry>
          <title>Example v Secretary of State</title>
          <tna:identifier type="ukncn">[2024] UKFTT 943 (GRC)</tna:identifier>
          <tna:uri>tna:case-law/ukftt/grc/2024/943</tna:uri>
          <link rel="alternate" type="text/html" href="/ukftt/grc/2024/943" />
          <link rel="alternate" type="application/akn+xml" href="/exports/example.xml" />
        </entry>
      </feed>`;
    const judgment = `
      <akomaNtoso>
        <judgment>
          <section eId="section_2">
            <num>2.</num>
            <subsection eId="section_2__subsection_1">
              <num>(1)</num>
              <paragraph eId="para_24">
                <num>24.</num>
                <content>The exact native paragraph has distinctive legal words.</content>
              </paragraph>
            </subsection>
          </section>
        </judgment>
      </akomaNtoso>`;
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("atom.xml")
        ? response(atom, "application/atom+xml")
        : response(judgment, "application/akn+xml"));
    vi.stubGlobal("fetch", fetchMock);

    const tna = provider("tna");
    const [source] = await tna.resolve!({
      text: "[2024] UKFTT 943 (GRC)",
      kind: "case",
    });
    expect(source).toMatchObject({
      url: "https://caselaw.nationalarchives.gov.uk/ukftt/grc/2024/943",
    });
    const [paragraph] = await tna.readPassage!({
      source,
      locator: { kind: "paragraph", value: "24" },
    });
    const [subsection] = await tna.readPassage!({
      source,
      locator: { kind: "section", value: "2(1)" },
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://caselaw.nationalarchives.gov.uk/exports/example.xml",
    );
    expect(paragraph).toMatchObject({
      locator: { anchor: "para_24" },
      role: "selected",
    });
    expect(native(paragraph).lookup).toMatchObject({
      status: "found",
      block: { origin: "native" },
    });
    expect(paragraph.text).toContain("distinctive legal words");
    expect(subsection.locator.anchor).toBe("section_2__subsection_1");
  });

  it("rejects ambiguous exact TNA citation matches", async () => {
    const entry = (path: string) => `
      <entry>
        <identifier type="ukncn">[2025] UKSC 1</identifier>
        <link rel="alternate" type="text/html" href="/uksc/2025/${path}" />
        <link rel="alternate" type="application/akn+xml" href="/xml/${path}.xml" />
      </entry>`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(
            `<feed>${entry("1")}${entry("other")}</feed>`,
            "application/atom+xml",
          ),
        ),
    );

    await expect(
      provider("tna").resolve!({ text: "[2025] UKSC 1", kind: "case" }),
    ).resolves.toEqual([]);
  });

  it("fetches all ET attachment metadata and reconstructs only heuristic structure", async () => {
    const hidden = Array.from(
      { length: 5 },
      (_, index) =>
        `<p>[${index + 1}] Tribunal paragraph ${index + 1} contains enough distinctive legal language and factual findings for reliable local structural reconstruction.</p>`,
    ).join("");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          results: [
            {
              format: "employment_tribunal_decision",
              title: "A v B: 2200123/2024",
              link: "/employment-tribunal-decisions/a-v-b-2200123-slash-2024",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          title: "A v B: 2200123/2024",
          description: "Employment Tribunal decision",
          details: {
            hidden_indexable_content: hidden,
            attachments: [
              {
                title: "Judgment",
                url: "https://assets.publishing.service.gov.uk/media/judgment.pdf",
                content_type: "application/pdf",
                filename: "judgment.pdf",
                number_of_pages: 9,
              },
              {
                title: "Reasons",
                url: "/media/reasons.pdf",
                content_type: "application/pdf",
                filename: "reasons.pdf",
              },
              {
                title: "Untrusted mirror",
                url: "https://attacker.example/judgment.pdf",
                content_type: "application/pdf",
              },
            ],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const et = provider("govuk-et");
    const [source] = await et.resolve!({
      text: "A v B, 2200123/2024",
      kind: "case",
    });
    const [paragraph] = await et.readPassage!({
      source,
      locator: { kind: "paragraph", value: "4" },
    });
    const document = native(paragraph).document;

    expect(document.attachments).toHaveLength(2);
    expect(document.attachments[0]).toMatchObject({
      filename: "judgment.pdf",
      pageCount: 9,
    });
    expect(document.structure.ranges.page.count).toBe(0);
    expect(native(paragraph).lookup).toMatchObject({
      status: "found",
      block: { origin: "heuristic" },
    });
    expect(
      document.structure.blocks.every(({ origin }) => origin === "heuristic"),
    ).toBe(true);
  });

  it("selects one exact GovInfo package, exposes PDF metadata, and rejects ambiguity", async () => {
    const searchResponse = {
      results: [
        {
          collectionCode: "USCOURTS",
          packageId: "USCOURTS-cod-1_22-cv-00930",
          title: "Schwartz v. Adams",
        },
        {
          collectionCode: "USCOURTS",
          packageId: "USCOURTS-cod-1_22-cv-00931",
          title: "Different docket",
        },
        {
          collectionCode: "FR",
          packageId: "USCOURTS-other-1_22-cv-00930",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(searchResponse))
      .mockResolvedValueOnce(
        response({
          title: "Schwartz v. Adams",
          caseNumber: "1:22-cv-00930",
          courtName:
            "United States District Court for the District of Colorado",
          docketText: "Order of consolidation.",
          pageCount: 7,
          download: {
            pdfLink:
              "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          results: [
            {
              collectionCode: "USCOURTS",
              packageId: "USCOURTS-cod-1_22-cv-00931",
              title: "First matching court",
            },
            {
              collectionCode: "USCOURTS",
              packageId: "USCOURTS-nyed-1_22-cv-00931",
              title: "Same docket in another court",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const govinfo = provider("govinfo");
    const [source] = await govinfo.resolve!({
      text: "United States District Court case 1:22-cv-00930",
      kind: "case",
    });
    const [passage] = await govinfo.readPassage!({ source });
    const document = native(passage).document;

    expect(source.id).toBe("USCOURTS-cod-1_22-cv-00930");
    expect(document.attachments).toEqual([
      expect.objectContaining({
        contentType: "application/pdf",
        pageCount: 7,
      }),
    ]);
    expect(document.structure.ranges.page.count).toBe(0);
    await expect(govinfo.resolve!({
      text: "United States case 1:22-cv-00931",
      kind: "case",
    })).resolves.toEqual([]);
  });
});
