import { describe, expect, it } from "vitest";
import { RESOURCE_TOOLS } from "../resourceTools";
import { assistantToolActivityLabel } from "./a2ajTools";

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
});
