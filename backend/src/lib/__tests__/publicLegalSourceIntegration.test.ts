import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

import {
  legalSourcePassageUrl,
  readLegalSourcePassage,
} from "../legalSourceRegistry";
import { resourceReference } from "../resourceReferences";
import { runLocalAssistantTools } from "./support/localAssistantTools";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-public-source-"));
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", path.join(temporaryDirectory, "legal-data"));
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
        <paragraph eId="para_25">
          <num>25.</num>
          <content>The next exact proposition appears here.</content>
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

const tnaResource = resourceReference.source("tna", "[2024] UKSC 1");

describe("unified public legal-source reads", () => {
  it("keeps provider URLs private while returning exact citable passages", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const [toolResult] = await runLocalAssistantTools("local-user", [{
      id: "public-locator",
      name: "Read",
      input: {
        file_path: tnaResource,
        locator_kind: "paragraph",
        locator: "24",
      },
    }]);
    const payload = JSON.parse(toolResult.content);
    expect(payload.ok).toBe(true);
    expect(payload.passages).toMatchObject([{
      role: "selected",
      locator: "par24",
      evidence_id: expect.stringMatching(/^e_/u),
    }]);
    expect(payload.passages[0].text_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(toolResult.content).not.toContain("caselaw.nationalarchives.gov.uk");
  });

  it("does not mint document-wide evidence for an unlocated public-source Read", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const [toolResult] = await runLocalAssistantTools("local-user", [{
      id: "public-document",
      name: "Read",
      input: { file_path: tnaResource },
    }]);
    const payload = JSON.parse(toolResult.content);
    expect(payload.ok).toBe(true);
    expect(payload.evidence_ids).toEqual([]);
    expect(payload.passages[0]).not.toHaveProperty("evidence_id");
    expect(payload.next_required_action).toContain("native locator");
  });

  it("keeps the native document and lookup needed for a canonical pinpoint", async () => {
    vi.stubGlobal("fetch", providerFetch());
    const read = await readLegalSourcePassage({
      source: { provider: "tna", id: "[2024] UKSC 1", kind: "case" },
      locator: { kind: "paragraph", value: "24" },
    });
    expect(read.status).toBe("found");
    if (read.status !== "found") return;
    expect(read.values).toHaveLength(1);
    const passage = read.values[0];
    expect(passage.native).toMatchObject({
      document: { provider: "tna", identity: "[2024] UKSC 1" },
      lookup: { status: "found", block: { label: "par24" } },
    });
    expect(
      legalSourcePassageUrl(passage, ["First exact proposition appears here"]),
    ).toContain("#para_24:~:text=");
  });
});
