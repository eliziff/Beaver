import { describe, expect, it } from "vitest";
import { normalizeCodexCatalog } from "../codexCatalog";

const luna = {
  slug: "gpt-5.6-luna",
  display_name: "GPT-5.6-Luna",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low" },
    { effort: "max" },
    { effort: "LOW" },
  ],
  service_tiers: [
    { id: "priority", name: "Fast", description: "1.5x speed" },
    { id: "PRIORITY", name: "Duplicate" },
    { id: "" },
  ],
  default_service_tier: "default",
  additional_speed_tiers: ["fast", "FAST", ""],
};

describe("normalizeCodexCatalog", () => {
  it("deduplicates a mislabeled alias in favor of the canonical GPT slug", () => {
    const result = normalizeCodexCatalog({
      models: [
        {
          ...luna,
          slug: "codex-auto-review",
        },
        luna,
        { ...luna, slug: "GPT-5.6-LUNA" },
      ],
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      slug: "gpt-5.6-luna",
      supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }],
      serviceTiers: [
        { id: "priority", name: "Fast", description: "1.5x speed" },
      ],
      defaultServiceTier: "default",
      additionalSpeedTiers: ["fast"],
    });
  });

  it("keeps auto-review when the CLI reports it as a distinct model", () => {
    const result = normalizeCodexCatalog({
      models: [
        luna,
        {
          ...luna,
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
        },
      ],
    });

    expect(result.models.map((model) => model.slug)).toEqual([
      "gpt-5.6-luna",
      "codex-auto-review",
    ]);
  });
});
