import crypto from "node:crypto";
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

import { a2ajLegalSourceProvider } from "../legalSources/a2aj";
import {
  legalSourcePassageUrl,
  readLegalSourcePassage,
} from "../legalSourceRegistry";

beforeEach(() => {
  // This suite probes provider truncation, not the machine's local corpus.
  vi.stubEnv(
    "MIKE_A2AJ_BULK_DB",
    path.join(os.tmpdir(), `beaver-a2aj-fetch-test-${crypto.randomUUID()}.sqlite`),
  );
});

afterEach(() => {
  a2ajLegalSourceProvider.clearCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubA2AJText(text: string, citation: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "LEGISLATION-FED",
            citation_en: citation,
            name_en: "Criminal Code",
            source_url_en: "https://laws-lois.justice.gc.ca/eng/XML/C-46.xml",
            unofficial_text_en: text,
          },
        ],
      }),
    }),
  );
}

async function readDocument(text: string) {
  const citation = `RSC 1985, c C-${text.length}`;
  stubA2AJText(text, citation);
  return readLegalSourcePassage({
    source: {
      provider: "a2aj",
      id: citation,
      citation,
      kind: "legislation",
      collection: "LEGISLATION-FED",
    },
  });
}

describe("unified A2AJ document reads", () => {
  it("does not silently apply the deleted facade's 50,000-character slice", async () => {
    const read = await readDocument("c".repeat(60_000));
    expect(read.status).toBe("found");
    if (read.status !== "found") return;
    expect(read.values).toHaveLength(1);
    expect(read.values[0].role).toBe("document");
    expect(read.values[0].text).toHaveLength(60_000);
  });

  it("returns the complete small document", async () => {
    const read = await readDocument("c".repeat(1_200));
    expect(read.status).toBe("found");
    if (read.status === "found") expect(read.values[0].text).toHaveLength(1_200);
  });

  it("uses one canonical lookup-and-block native passage contract", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence and an exact governing rule.`,
    ).join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          dataset: "SCC",
          citation_en: "2099 SCC 9",
          source_url_en: "https://example.test/decision",
          unofficial_text_en: text,
        }],
      }),
    }));
    const read = await readLegalSourcePassage({
      source: {
        provider: "a2aj",
        id: "2099 SCC 9",
        citation: "2099 SCC 9",
        kind: "case",
        collection: "SCC",
      },
      locator: { kind: "paragraph", value: "2" },
    });

    expect(read.status).toBe("found");
    if (read.status !== "found") return;
    const selected = read.values.find(({ role }) => role === "selected")!;
    expect(Object.keys(selected.native as object).sort()).toEqual([
      "block",
      "lookup",
    ]);
    expect(selected.native).toMatchObject({
      lookup: { status: "found", citation: "2099 SCC 9" },
      block: { label: "par2", text: selected.text },
    });
    expect(legalSourcePassageUrl(selected, ["exact governing rule"]))
      .toMatch(/^https:\/\/www\.canlii\.org\/en\/ca\/scc\/doc\/2099\/2099scc9\//u);
  });
});
