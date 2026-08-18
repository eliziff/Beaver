import { describe, expect, it, vi } from "vitest";
import {
  createLegalSourceRegistry,
  type LegalSourceProvider,
} from "../legalSources";

const reference = (provider: string, id: string) => ({
  provider,
  id,
  kind: "case" as const,
  citation: id,
});

describe("legal source registry", () => {
  it("runs minimal search providers and round-robins their results", async () => {
    const providers: LegalSourceProvider[] = [
      {
        id: "first",
        search: vi.fn(async () => [reference("first", "a"), reference("first", "b")]),
      },
      {
        id: "second",
        search: vi.fn(async () => [reference("second", "c")]),
      },
    ];
    const result = await createLegalSourceRegistry(providers).search({
      text: "duty",
      kinds: ["case"],
      limit: 3,
    });

    expect(result.results.map(({ id }) => id)).toEqual(["a", "c", "b"]);
    expect(result.unavailable).toEqual([]);
  });

  it("deduplicates aliases of one source but preserves real ambiguity", async () => {
    const registry = createLegalSourceRegistry([
      {
        id: "cases",
        resolve: vi.fn(async ({ text }) => [
          reference("cases", text === "alias" ? "1" : "1"),
          reference("cases", "1"),
        ]),
      },
    ]);
    await expect(
      registry.resolve({ text: "alias", kind: "case" }),
    ).resolves.toEqual({
      status: "found",
      value: reference("cases", "1"),
    });

    const ambiguous = createLegalSourceRegistry([
      { id: "a", resolve: async () => [reference("a", "1")] },
      { id: "b", resolve: async () => [reference("b", "1")] },
    ]);
    await expect(
      ambiguous.resolve({ text: "same words", kind: "case" }),
    ).resolves.toEqual({ status: "ambiguous", providers: ["a", "b"] });
  });

  it("routes passage reads only to the source provider", async () => {
    const passage = {
      source: reference("journal", "42"),
      locator: {
        requested: { kind: "footnote" as const, value: "7" },
        label: "fn7",
      },
      role: "selected" as const,
      text: "Exact passage",
      textSha256: "text-hash",
      documentSha256: "document-hash",
      revision: "revision",
    };
    const readPassage = vi.fn(async () => [passage]);
    const registry = createLegalSourceRegistry([
      { id: "journal", readPassage },
      { id: "other", readPassage: vi.fn(async () => []) },
    ]);

    await expect(
      registry.readPassage({
        source: reference("journal", "42"),
        locator: { kind: "footnote", value: "7" },
      }),
    ).resolves.toEqual({ status: "found", values: [passage] });
    expect(readPassage).toHaveBeenCalledOnce();
  });
});
