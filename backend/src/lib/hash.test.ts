import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256, deterministicUuid } from "./hash";

describe("canonical JSON", () => {
  it("ignores nested object insertion order without reordering arrays", () => {
    const left = { z: { beta: 2, alpha: 1 }, values: [{ b: 2, a: 1 }, "last"] };
    const reordered = { values: [{ a: 1, b: 2 }, "last"], z: { alpha: 1, beta: 2 } };

    expect(canonicalJsonSha256(left)).toBe(canonicalJsonSha256(reordered));
    expect(canonicalJson(left)).toBe(
      '{"values":[{"a":1,"b":2},"last"],"z":{"alpha":1,"beta":2}}',
    );
    expect(canonicalJsonSha256({ values: [1, 2] }))
      .not.toBe(canonicalJsonSha256({ values: [2, 1] }));
  });

  it("derives stable namespaced UUIDs without a dependency", () => {
    expect(deterministicUuid("workflow\0court-records"))
      .toBe(deterministicUuid("workflow\0court-records"));
    expect(deterministicUuid("workflow\0court-records"))
      .not.toBe(deterministicUuid("workflow\0authorities"));
    expect(deterministicUuid("workflow\0court-records"))
      .toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/u);
  });
});
