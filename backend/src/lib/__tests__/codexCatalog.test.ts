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

describe("normalizeCodexCatalog", () => {
  it("deduplicates a mislabeled alias in favor of the canonical GPT slug", () => {
    const result = normalizeCodexCatalog([
        {
          ...luna,
          model: "codex-auto-review",
        },
        luna,
        { ...luna, model: "GPT-5.6-LUNA" },
      ],
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toEqual({
      slug: "gpt-5.6-luna",
      displayName: "GPT-5.6-Luna",
      defaultReasoningLevel: "medium",
      supportedReasoningLevels: [{ effort: "low" }, { effort: "max" }],
    });
  });

  it("keeps auto-review when the CLI reports it as a distinct model", () => {
    const result = normalizeCodexCatalog([
        luna,
        {
          ...luna,
          model: "codex-auto-review",
          displayName: "Codex Auto Review",
        },
      ],
    );

    expect(result.models.map((model) => model.slug)).toEqual([
      "gpt-5.6-luna",
      "codex-auto-review",
    ]);
  });
});
