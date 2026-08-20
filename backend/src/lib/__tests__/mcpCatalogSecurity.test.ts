import { describe, expect, it } from "vitest";
import { validateMcpCatalog } from "../mcp/servers";

const tool = (description: string) => ({
  name: "read", description, inputSchema: { type: "object" as const },
});

describe("remote MCP catalog bounds", () => {
  it("accepts ordinary tools and rejects context-exhausting contracts", () => {
    expect(() => validateMcpCatalog([tool("Read a record")])).not.toThrow();
    expect(() => validateMcpCatalog([tool("x".repeat(8_193))]))
      .toThrow("oversized tool contract");
    expect(() => validateMcpCatalog(Array.from({ length: 257 }, () => tool("read"))))
      .toThrow("too many tools");
  });
});
