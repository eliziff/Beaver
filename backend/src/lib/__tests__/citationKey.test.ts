import { describe, expect, it } from "vitest";

import { structureNative } from "../structureNative";
import oracle from "./fixtures/retrieval_gate/citation-key-oracle.json";

describe("native citation detection", () => {
  it("matches the frozen corpus identity oracle", () => {
    const native = structureNative();
    for (const row of oracle.citation_keys)
      expect(native.citationLookupKey(row.input)).toBe(row.oracle_key);
  });

  it("is not stateful across calls", () => {
    const native = structureNative();
    for (const _ of [0, 1, 2]) {
      expect(native.hasCitationInText("R. v. Jordan, 2016 SCC 27")).toBe(true);
      expect(native.hasCitationInText("no citation here at all")).toBe(false);
    }
  });
});
