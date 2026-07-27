import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendPublicLegalPinpointLinks,
  createPublicLegalSourceState,
} from "../chat/publicLegalSourceState";
import { runLocalAssistantTools } from "../chat/localAssistantTools";
import {
  PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT,
  PUBLIC_LEGAL_SOURCE_TOOL_NAMES,
} from "../chat/tools/publicLegalSourceTools";
import { createCitation, parseCitations } from "../chat/citations";
import { runToolCalls } from "../chat/tools/toolDispatcher";

afterEach(() => {
  vi.unstubAllGlobals();
});

function providerFetch() {
  const atom = `
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Example v Secretary of State</title>
        <identifier type="ukncn">[2024] UKSC 1</identifier>
        <link rel="alternate" type="text/html" href="/uksc/2024/1" />
        <link rel="alternate" type="application/akn+xml" href="/trusted/source.xml" />
      </entry>
    </feed>`;
  const judgment = `
    <akomaNtoso>
      <judgment>
        <paragraph eId="para_24">
          <num>24.</num>
          <content>First exact proposition appears here. Second exact holding appears here.</content>
        </paragraph>
      </judgment>
    </akomaNtoso>`;
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    return new Response(url.includes("atom.xml") ? atom : judgment, {
      status: 200,
      headers: {
        "Content-Type": url.includes("atom.xml")
          ? "application/atom+xml"
          : "application/akn+xml",
      },
    });
  });
}

describe("public legal source tool integration", () => {
  it("keeps URLs and anchors private while building a verified multi-text citation", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const state = createPublicLegalSourceState();
    const [toolResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "tna",
            identifier: "[2024] UKSC 1",
            locator_type: "paragraph",
            locator: "24",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      state,
    );
    const modelPayload = JSON.parse(toolResult.content);

    expect(modelPayload.ok).toBe(true);
    expect(modelPayload).not.toHaveProperty("url");
    expect(modelPayload.block).not.toHaveProperty("anchor");
    expect(state.documents.size).toBeGreaterThan(0);
    expect(state.lookups[0]?.lookup.anchor).toBe("para_24");

    const [parsed] = parseCitations(
      `<CITATIONS>${JSON.stringify([
        {
          ref: 1,
          source: "public_legal",
          provider: "tna",
          identifier: "[2024] UKSC 1",
          url: "https://attacker.invalid/fake",
          quotes: [
            { quote: "First exact proposition appears here." },
            { quote: "Second exact holding appears here." },
          ],
        },
      ])}</CITATIONS>`,
    );
    const citation = createCitation(parsed, {}, undefined, [], [], state) as {
      url: string;
    };

    expect(citation.url).toContain(
      "https://caselaw.nationalarchives.gov.uk/uksc/2024/1#para_24",
    );
    expect(citation.url).not.toContain("attacker.invalid");
    expect(citation.url.match(/text=/gu)).toHaveLength(2);

    const withoutCitationJson = appendPublicLegalPinpointLinks(
      'The court said "First exact proposition appears here" and "Second exact holding appears here" [1].',
      state,
    );
    expect(withoutCitationJson).toContain(
      "https://caselaw.nationalarchives.gov.uk/uksc/2024/1#para_24",
    );
    expect(withoutCitationJson.match(/text=/gu)).toHaveLength(2);
  });

  it("is available through the authenticated dispatcher with a URL-free model result", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const state = createPublicLegalSourceState();
    const output = await runToolCalls(
      [
        {
          id: "call-1",
          function: {
            name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
            arguments: JSON.stringify({
              provider: "tna",
              identifier: "[2024] UKSC 1",
            }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as Parameters<typeof runToolCalls>[3],
      () => {},
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      state,
    );
    const modelPayload = JSON.parse(
      String(
        (output.toolResults[0] as { content: string | undefined }).content,
      ),
    );

    expect(modelPayload.ok).toBe(true);
    expect(modelPayload).not.toHaveProperty("url");
    expect(state.documents.size).toBeGreaterThan(0);
    expect(PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT).toContain(
      "never invent, request, copy, or include a URL",
    );
  });
});
