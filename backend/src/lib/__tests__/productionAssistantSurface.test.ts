import { describe, expect, it } from "vitest";
import { LOCAL_ASSISTANT_TOOLS } from "../chat/localAssistantTools";

describe("production assistant surface", () => {
  it("has one stable tool definition per production name", () => {
    const names = LOCAL_ASSISTANT_TOOLS.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "Glob",
      "Grep",
      "Read",
      "Edit",
      "generate_docx",
      "SearchSources",
    ]));
  });

  it("accepts the sole production DOCX creation contract", () => {
    const generate = LOCAL_ASSISTANT_TOOLS.find(
      (tool) => tool.function.name === "generate_docx",
    );
    expect(generate?.function.parameters).toMatchObject({
      type: "object",
      required: ["filename", "content"],
      properties: {
        filename: { type: "string" },
        content: { type: "string" },
      },
    });
  });
});
