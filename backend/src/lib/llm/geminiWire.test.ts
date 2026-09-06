import { afterEach, expect, it, vi } from "vitest";
import { WRITE_TOOL } from "../chat/tools/toolSchemas";
import type { Tool } from "./types";

afterEach(() => vi.unstubAllGlobals());

it("transmits Write maps and composed JSON Schema through the installed Gemini SDK", async () => {
  const composition: Tool = {
    name: "choose", description: "Choose values", inputSchema: {
      type: "object", additionalProperties: false, required: ["values"],
      properties: {
        values: { type: "object", additionalProperties: { anyOf: [
          { type: "integer", minimum: 0 }, { type: "string", enum: ["auto"] },
        ] } },
        label: { $ref: "#/$defs/label" },
      },
      $defs: { label: { type: ["string", "null"] } },
    },
  };
  const tools = [WRITE_TOOL, composition, {
    name: "ready", inputSchema: { type: "object", additionalProperties: false },
  } satisfies Tool];
  const bodies: Array<{ tools: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: {
      role: "model", parts: [{ text: "Ready." }],
    }, finishReason: "STOP" }] })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }));
  const { streamGemini } = await import("./gemini");
  const result = await streamGemini({ model: "gemini-test", systemPrompt: "",
    messages: [{ role: "user", content: "Prepare the document." }], tools,
    apiKeys: { gemini: "test" } });
  expect(result.fullText).toBe("Ready.");
  expect(bodies).toHaveLength(1);
  expect(bodies[0].tools).toEqual([{ functionDeclarations: tools.map((tool) => ({
    name: tool.name, description: tool.description ?? "",
    parametersJsonSchema: tool.inputSchema,
  })) }]);
});
