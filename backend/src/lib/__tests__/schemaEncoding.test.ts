import { afterEach, describe, expect, it } from "vitest";

import {
  encodeToolV3,
  renderToolSignature,
  schemaEncodingVariant,
} from "../llm/schemaEncoding";
import type { OpenAIToolSchema } from "../llm/types";

const tool: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "library_read",
    description: "Read a document.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "dropped in v3" },
        mode: { type: "string", enum: ["text", "drafting", "redline"] },
        window: {
          type: "object",
          properties: {
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["offset"],
        },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["document_id"],
    },
  },
};

describe("V3 schema encoding", () => {
  afterEach(() => {
    delete process.env.MIKE_SCHEMA_ENCODING;
  });

  it("renders a compact signature with optionality, enums, nesting", () => {
    expect(renderToolSignature(tool)).toBe(
      'library_read(document_id: string, mode?: "text"|"drafting"|"redline", window?: {offset: number, limit?: number}, ids?: string[])',
    );
  });

  it("keeps the tool description verbatim and sends a permissive schema", () => {
    const encoded = encodeToolV3(tool);
    expect(encoded.description.startsWith("Read a document.")).toBe(true);
    expect(encoded.description).toContain("Call as library_read(");
    expect(encoded.description).not.toContain("dropped in v3");
    expect(encoded.parameters).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("is off unless MIKE_SCHEMA_ENCODING=v3", () => {
    expect(schemaEncodingVariant()).toBe("v0");
    process.env.MIKE_SCHEMA_ENCODING = "v3";
    expect(schemaEncodingVariant()).toBe("v3");
  });
});
