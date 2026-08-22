import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedRemoteFetch } = vi.hoisted(() => ({
  guardedRemoteFetch: vi.fn((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init)),
}));
vi.mock("../../remoteUrlSafety", () => ({ guardedRemoteFetch }));

import { RESOURCE_TOOLS } from "../resourceTools";
import { a2ajLegalSourceProvider } from "../../legalSources/a2aj";
import {
  assistantReadEvidenceActivityLabel,
  assistantToolActivityLabel,
  readA2AJReferenceNeighborhood,
} from "./a2ajTools";
import { createLibraryEvidence } from "../legalEvidence";

describe("legal-source assistant activity", () => {
  it("hides inventory reads and describes unified source operations", () => {
    expect(assistantToolActivityLabel("Glob", { pattern: "*" })).toBeNull();
    expect(
      assistantToolActivityLabel("Grep", { pattern: "termination clause" }),
    ).toBe('Searching all documents in your Library for “termination clause”');
    expect(
      assistantToolActivityLabel("Read", { file_path: "contracts/Lease.docx" }),
    ).toBe("Reading Lease.docx from your Library");
    expect(
      assistantToolActivityLabel("Read", {
        file_path:
          "source://a2aj/%5B%222012%20SCC%2045%22%2C%22cases%22%2C%22SCC%22%5D",
      }),
    ).toBe("Reading 2012 SCC 45 from A2AJ");
    expect(
      assistantToolActivityLabel("search_sources", {
        query: "fentanyl skin contact",
        source_types: ["case"],
        jurisdiction: "Canada",
        collection: "ONCA",
      }),
    ).toBe('Searching Ontario case law for “fentanyl skin contact”');
    expect(
      assistantToolActivityLabel("search_sources", {
        query: "Residential Tenancies Act tenancy agreement",
        source_types: ["legislation"],
        collection: "LEGISLATION-AB",
      }),
    ).toBe(
      'Searching Alberta legislation for “Residential Tenancies Act tenancy agreement”',
    );
  });

  it("keeps range and statutory reference inputs on unified Read", () => {
    const read = RESOURCE_TOOLS.find((entry) => entry.name === "Read")!;
    expect(read.inputSchema.properties.references).toMatchObject({
      enum: ["none", "inbound", "outbound", "both"],
    });
    expect(read.inputSchema.properties.end_locator).toBeDefined();
  });

  it("shows the requested scope of main-agent reads", () => {
    const source = "source://a2aj/%5B%222012%20SCC%2045%22%2C%22cases%22%2C%22SCC%22%5D";
    expect(assistantToolActivityLabel("Read", {
      file_path: source,
      pattern: "reasonable foreseeability",
      context_chars: 240,
    })).toBe('Searching 2012 SCC 45 for “reasonable foreseeability” with up to 240 characters of adjacent context');
    expect(assistantToolActivityLabel("Read", {
      file_path: source,
      locator_kind: "paragraph",
      locator: "42",
      end_locator: "44",
      context_blocks: 1,
    })).toBe("Reading paras 42–44 of 2012 SCC 45 with 1 adjacent context block");
    expect(assistantToolActivityLabel("Read", {
      file_path: source,
      locator_kind: "section",
      locator: "sec49(1)",
    })).toBe("Reading s 49(1) of 2012 SCC 45");
    expect(assistantToolActivityLabel("Read", {
      file_path: source,
      locator_kind: "section",
      locator: "sec49(1)",
      end_locator: "sec49(4)",
    })).toBe("Reading ss 49(1)–49(4) of 2012 SCC 45");
    expect(assistantToolActivityLabel("Read", {
      file_path: "document://record/version/v1",
      section: "Damages",
    }, "record.pdf")).toBe("Reading section Damages of record.pdf");
    expect(assistantToolActivityLabel("Read", {
      file_path: "document://record/version/v1",
      offset: 20,
      limit: 5,
    }, "record.pdf")).toBe("Reading lines 20–24 of record.pdf");
  });

  it("replaces an evidence handle with its returned locator", () => {
    const evidence = createLibraryEvidence({
      documentId: "document-1",
      versionId: "version-1",
      filename: "record.pdf",
      sourceText: "Exact passage.",
      spanText: "Exact passage.",
      start: 0,
      end: 14,
      blockId: "pdf:page-9",
      locator: { kind: "page", label: "page=9" },
    });
    expect(assistantToolActivityLabel("Read", {
      file_path: "document://record/version/v1",
      handle: "opaque-evidence-handle",
    }, "record.pdf")).toBe("Reading a saved passage of record.pdf");
    expect(assistantReadEvidenceActivityLabel([evidence], "record.pdf"))
      .toBe("Reading page 9 of record.pdf");
    expect(assistantReadEvidenceActivityLabel([{
      ...evidence,
      locator: { kind: "page", label: "[page 8]" },
    }], "1988canlii30.pdf")).toBe("Reading page 8 of 1988canlii30.pdf");
    expect(assistantReadEvidenceActivityLabel([{
      ...evidence,
      locator: { kind: "section", label: "sec49(1)–sec49(4)" },
    }], "Family Law Act")).toBe("Reading ss 49(1)–49(4) of Family Law Act");
    expect(assistantReadEvidenceActivityLabel([1, 2, 3].map((number) => ({
      ...evidence,
      locator: { kind: "paragraph" as const, label: `par${number}` },
    })), "Case")).toBe("Reading paras 1–3 of Case");
    expect(assistantReadEvidenceActivityLabel([1, 4].map((number) => ({
      ...evidence,
      locator: { kind: "paragraph" as const, label: `par${number}` },
    })), "Case")).toBe("Reading paras 1, 4 of Case");
    expect(assistantReadEvidenceActivityLabel([
      "17(1)", "17(1)(a)", "17(1)(b)", "17(1)(b)(i)",
      "17(2)", "17(2.1)", "17(3)", "17(4)", "17(4.1)", "17(5)",
      "17(6)", "17(7)", "17(8)", "17(9)", "17(10)", "17(11)",
    ].map((label) => ({
      ...evidence,
      locator: { kind: "section" as const, label: `sec${label}` },
    })), "Divorce Act")).toBe("Reading ss 17(1)–17(11) of Divorce Act");
    expect(assistantReadEvidenceActivityLabel([
      "49(1)", "49(2)", "49(2)(a)", "49(2)(b)", "49(3)", "49(4)",
    ].map((label) => ({
      ...evidence,
      locator: { kind: "section" as const, label: `sec${label}` },
    })), "Family Law Act")).toBe("Reading ss 49(1)–49(4) of Family Law Act");
  });
});

describe("A2AJ reference neighborhoods", () => {
  it("has no production dependency on the text-only structure sidecar", () => {
    for (const file of [
      path.join(__dirname, "a2ajTools.ts"),
      path.join(__dirname, "..", "..", "legalSources", "a2aj.ts"),
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/legalStructureSidecar/u);
    }
  });

  beforeEach(() => {
    guardedRemoteFetch.mockClear();
    vi.stubEnv(
      "MIKE_A2AJ_BULK_DB",
      path.join(os.tmpdir(), `beaver-a2aj-tools-${crypto.randomUUID()}.sqlite`),
    );
  });

  afterEach(() => {
    a2ajLegalSourceProvider.clearCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses captured provider blocks for inbound, outbound, and both", async () => {
    const fixture = JSON.parse(readFileSync(path.join(
      __dirname,
      "..",
      "..",
      "__tests__",
      "fixtures",
      "sourcedoc",
      "a2aj-laws-on-occupiers-liability.json",
    ), "utf8")) as {
      citation: string;
      dataset: string;
      name: string;
      url: string;
      text: string;
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{
        dataset: fixture.dataset,
        citation_en: fixture.citation,
        name_en: fixture.name,
        url_en: fixture.url,
        unofficial_text_en: fixture.text,
      }] }),
    }));
    const seed = await a2ajLegalSourceProvider.lookup({
      citation: fixture.citation,
      docType: "laws",
      dataset: fixture.dataset,
      kind: "section",
      locator: "6.1(2)",
    });
    expect(seed?.block?.label).toBe("sec6.1(2)");

    const inbound = await readA2AJReferenceNeighborhood(seed!, "inbound");
    const outbound = await readA2AJReferenceNeighborhood(seed!, "outbound");
    const both = await readA2AJReferenceNeighborhood(seed!, "both");
    const labels = (result: typeof inbound) =>
      result.lookups.map(({ block }) => block!.label);

    expect(labels(inbound)).toEqual(expect.arrayContaining([
      "sec6.1(1)",
      "sec6.1(7)",
    ]));
    expect(labels(outbound)).toEqual(["sec6.1(1)"]);
    expect(new Set(labels(both))).toEqual(new Set([
      ...labels(inbound),
      ...labels(outbound),
    ]));
    const source = a2ajLegalSourceProvider.source(seed!);
    expect(source).not.toBeNull();
    for (const related of both.lookups) {
      expect(a2ajLegalSourceProvider.source(related)).toBe(source);
      expect(source!.blocks.find(({ label }) => label === related.block!.label))
        .toMatchObject({
          label: related.block!.label,
          start: related.block!.start,
          end: related.block!.end,
        });
    }
  });
});
