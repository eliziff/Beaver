import { describe, expect, it } from "vitest";
import { normalizeCodexCatalog } from "../codexCatalog";

const luna = {
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "max" },
    { reasoningEffort: "LOW" },
  ],
  description: "Unused backend prose",
  serviceTiers: [{ id: "priority", name: "Fast" }],
  defaultServiceTier: "default",
  hidden: true,
};

const expectedLuna = {
  slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", defaultReasoningLevel: "medium",
  supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }],
};

describe("normalizeCodexCatalog", () => {
  

  it.each([undefined, {}])("ignores a non-array catalogue: %j", (value) => {
    expect(normalizeCodexCatalog(value)).toEqual({ models: [], source: "live" });
  });

  it("ignores malformed rows and normalizes model identifiers and fallback names", () => {
    const result = normalizeCodexCatalog([
      null, false, 42, "gpt-model", [], {}, { model: 42 }, { model: " CoDeX: " },
      { model: " CODEX:GPT-RESERVE ", displayName: "Internal" },
      { model: " CoDeX:GPT-EXAMPLE ", displayName: " ", defaultReasoningEffort: " HIGH " },
      { model: "second", displayName: " Friendly Name ", defaultReasoningEffort: 42 },
      { model: "third", displayName: null, defaultReasoningEffort: "" },
    ]);
    expect(result).toEqual({ source: "live", models: [
      { slug: "gpt-example", displayName: "gpt-example", defaultReasoningLevel: " HIGH ", supportedReasoningLevels: [] },
      { slug: "second", displayName: "Friendly Name", supportedReasoningLevels: [] },
      { slug: "third", displayName: "third", defaultReasoningLevel: "", supportedReasoningLevels: [] },
    ] });
  });

  it.each([
    ["luna-alias", "gpt-luna", "gpt-luna", "LUNA--MODEL!"],
    ["gpt-luna", "luna-alias", "gpt-luna", "Luna Model"],
    ["first-alias", "second-alias", "first-alias", "Luna Model"],
    ["gpt-first", "gpt-second", "gpt-first", "Luna Model"],
  ])("resolves equivalent display names for %s then %s", (first, second, winner, displayName) => {
    const result = normalizeCodexCatalog([
      { ...luna, model: first, displayName: "Luna Model" },
      { ...luna, model: second, displayName: "LUNA--MODEL!" },
    ]);
    expect(result).toEqual({ source: "live", models: [{ ...expectedLuna, slug: winner, displayName }] });
  });

  

  

  it.each([undefined, {}])("ignores non-array reasoning efforts: %j", (value) => {
    const result = normalizeCodexCatalog([{ ...luna, supportedReasoningEfforts: value }]);
    expect(result).toEqual({ source: "live", models: [{ ...expectedLuna, supportedReasoningLevels: [] }] });
  });

  it("does not mutate or expose the input's reasoning-effort objects", () => {
    const input = Object.freeze([Object.freeze({ ...luna,
      supportedReasoningEfforts: Object.freeze([Object.freeze({ reasoningEffort: " low " })]),
    })]);
    const before = structuredClone(input);
    const result = normalizeCodexCatalog(input);
    result.models[0].supportedReasoningLevels[0].effort = "changed";
    expect(input).toEqual(before);
    expect(normalizeCodexCatalog(input).models[0].supportedReasoningLevels).toEqual([{ effort: "low" }]);
  });
});
