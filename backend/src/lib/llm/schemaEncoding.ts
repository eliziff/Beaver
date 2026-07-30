// V3 tool-schema encoding. The six-harness survey priced today's JSON
// Schema scaffolding at 58% of the tool mass (4,051 of 6,964 tokens at
// pricing time) while carrying no tool-description text — the weight is
// structure plus per-parameter prose. V3 keeps every word of the
// tool-level description, renders the parameters as one compact call
// signature appended to it, and sends the API a permissive object
// schema. Argument validation stays where it already lives — the
// dispatchers' typed refusals — so the open question this encoding
// exists to A/B is argument correctness: do malformed-call rounds rise
// when the model loses schema structure? Enable per run with
// MIKE_SCHEMA_ENCODING=v3.

import type { OpenAIToolSchema } from "./types";

type JsonSchema = Record<string, unknown>;

function renderType(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== "object") return "any";
  const node = schema as JsonSchema;
  if (Array.isArray(node.enum)) {
    return (node.enum as unknown[]).map((v) => JSON.stringify(v)).join("|");
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  const variants = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    return variants.map((v) => renderType(v, depth)).join("|");
  }
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${renderType(node.items, depth)}[]`;
    case "object": {
      if (depth >= 4) return "object";
      const props = (node.properties ?? {}) as Record<string, unknown>;
      const required = new Set((node.required as string[]) ?? []);
      const fields = Object.entries(props).map(
        ([key, value]) =>
          `${key}${required.has(key) ? "" : "?"}: ${renderType(value, depth + 1)}`,
      );
      return fields.length ? `{${fields.join(", ")}}` : "object";
    }
    default:
      return "any";
  }
}

/** The one-line signature V3 appends to the tool description. */
export function renderToolSignature(tool: OpenAIToolSchema): string {
  const params = (tool.function.parameters ?? {}) as JsonSchema;
  const props = (params.properties ?? {}) as Record<string, unknown>;
  const required = new Set((params.required as string[]) ?? []);
  const fields = Object.entries(props).map(
    ([key, value]) =>
      `${key}${required.has(key) ? "" : "?"}: ${renderType(value, 1)}`,
  );
  return `${tool.function.name}(${fields.join(", ")})`;
}

export type EncodedTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function encodeToolV3(tool: OpenAIToolSchema): EncodedTool {
  const description = [
    tool.function.description ?? "",
    `Call as ${renderToolSignature(tool)} — parameters marked ? are optional; quoted values are exact literals.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    name: tool.function.name,
    description,
    parameters: { type: "object", additionalProperties: true },
  };
}

export function schemaEncodingVariant(): "v0" | "v3" {
  return process.env.MIKE_SCHEMA_ENCODING === "v3" ? "v3" : "v0";
}
