import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendPublicLegalPinpointLinks,
  createPublicLegalSourceState,
} from "../chat/publicLegalSourceState";
import { runLocalAssistantTools } from "../chat/localAssistantTools";
import {
  PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT,
  PUBLIC_LEGAL_SOURCE_TOOL_NAMES,
} from "../chat/tools/publicLegalSourceTools";
import { runToolCalls } from "../chat/tools/toolDispatcher";
import { readPublicLegalEvidenceReceipt } from "../publicLegalSources";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "beaver-provider-evidence-"),
  );
  vi.stubEnv(
    "OPEN_LEGAL_DATA_HOME",
    path.join(temporaryDirectory, "legal-data"),
  );
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", path.join(temporaryDirectory, "beaver-data"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(temporaryDirectory, { force: true, recursive: true });
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

function subsectionProviderFetch(text: string) {
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
        <section eId="section_2">
          <num>2.</num>
          <subsection eId="section_2__subsection_1">
            <num>(1)</num>
            <content>${text}</content>
          </subsection>
        </section>
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

    const withoutCitationJson = appendPublicLegalPinpointLinks(
      'The court said "First exact proposition appears here" and "Second exact holding appears here" [1].',
      state,
    );
    expect(withoutCitationJson).toContain(
      "https://caselaw.nationalarchives.gov.uk/uksc/2024/1#para_24",
    );
    expect(withoutCitationJson.match(/text=/gu)).toHaveLength(2);
  });

  it("persists native evidence through the authenticated dispatcher without exposing URLs", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const state = createPublicLegalSourceState();
    const output = await runToolCalls(
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
    const modelPayload = JSON.parse(output.toolResults[0].content);

    expect(modelPayload.ok).toBe(true);
    expect(modelPayload).not.toHaveProperty("url");
    expect(modelPayload.evidence.handle).toMatch(
      /^mike-provider-evidence:v2:[0-9a-f]{64}$/u,
    );
    expect(state.documents.size).toBeGreaterThan(0);
    expect(PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT).toContain(
      "never invent, request, copy, or include a URL",
    );
  });

  it("does not expose local paths when provider evidence cannot be rehydrated", async () => {
    const [result] = await runLocalAssistantTools("local-user", [
      {
        id: "missing-evidence",
        name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
        input: {
          provider: "tna",
          identifier: "[2024] UKSC 1",
          evidence_handle: `mike-provider-evidence:v2:${"0".repeat(64)}`,
        },
      },
    ]);
    const payload = JSON.parse(result.content);

    expect(payload).toMatchObject({
      ok: false,
      error:
        "Provider evidence is unavailable or failed integrity verification.",
    });
    expect(result.content).not.toContain(temporaryDirectory);
  });

  it("refuses superseded v1 evidence handles with the typed recapture error", async () => {
    const [result] = await runLocalAssistantTools("local-user", [
      {
        id: "v1-evidence",
        name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
        input: {
          provider: "tna",
          identifier: "[2024] UKSC 1",
          evidence_handle: `mike-provider-evidence:v1:${"0".repeat(64)}`,
        },
      },
    ]);
    const payload = JSON.parse(result.content);

    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("superseded v1 structure schema");
    expect(result.content).not.toContain(temporaryDirectory);
  });

  it("rehydrates a native TNA subsection from its exact source version after restart and upstream drift", async () => {
    vi.stubGlobal(
      "fetch",
      subsectionProviderFetch(
        "The original exact subsection governs this application.",
      ),
    );
    const firstState = createPublicLegalSourceState();
    const [firstResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "native-lookup",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "tna",
            identifier: "[2024] UKSC 1",
            locator_type: "section",
            locator: "2(1)",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      firstState,
    );
    const first = JSON.parse(firstResult.content);
    const handle = String(first.evidence.handle);
    const receipt = await readPublicLegalEvidenceReceipt(handle);

    expect(first.block).toMatchObject({
      label: "sec2(1)",
      kind: "section",
      origin: "native",
    });
    expect(first.block).not.toHaveProperty("anchor");
    expect(receipt).toMatchObject({
      handle,
      source: {
        provider: "tna",
        identifier: "[2024] UKSC 1",
        source_sha256: first.evidence.source_sha256,
      },
      lookup: {
        locator_kind: "section",
        locator: "sec2(1)",
        provider_locator: "section_2__subsection_1",
      },
    });

    const unexpectedFetch = vi.fn(() => {
      throw new Error("Rehydration must use the bound source snapshot");
    });
    vi.stubGlobal("fetch", unexpectedFetch);
    const restartedState = createPublicLegalSourceState();
    const [restoredResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "native-rehydrate",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "tna",
            identifier: "[2024] UKSC 1",
            evidence_handle: handle,
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      restartedState,
    );
    const restored = JSON.parse(restoredResult.content);

    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(restored.evidence.handle).toBe(handle);
    expect(restored.block.text).toContain("original exact subsection");
    expect(
      appendPublicLegalPinpointLinks(
        'The court held that "The original exact subsection governs this application." [1].',
        restartedState,
      ),
    ).toContain(
      "https://caselaw.nationalarchives.gov.uk/uksc/2024/1#section_2__subsection_1",
    );

    vi.stubGlobal(
      "fetch",
      subsectionProviderFetch(
        "The amended exact subsection now governs a different application.",
      ),
    );
    const changedState = createPublicLegalSourceState();
    const [changedResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "native-changed",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "tna",
            identifier: "[2024] UKSC 1",
            locator_type: "section",
            locator: "2(1)",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      changedState,
    );
    const changed = JSON.parse(changedResult.content);

    expect(changed.block.text).toContain("amended exact subsection");
    expect(changed.evidence.handle).not.toBe(handle);
    expect(changed.evidence.source_sha256).not.toBe(
      first.evidence.source_sha256,
    );
    expect(
      (await readPublicLegalEvidenceReceipt(handle)).evidence.block_text_sha256,
    ).toBe(receipt.evidence.block_text_sha256);
  });
});
