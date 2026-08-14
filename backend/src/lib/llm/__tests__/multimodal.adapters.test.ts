import { describe, expect, it } from "vitest";
import { toNativeMessages } from "../claude";
import { toNativeContents } from "../gemini";
import { toResponseInput } from "../openai";
import type { LlmMessage } from "../types";

const messages: LlmMessage[] = [{
  role: "user",
  content: "Read this image.",
  images: [{
    filename: "scan.png",
    mimeType: "image/png",
    data: "aW1hZ2U=",
  }],
}];

describe("multimodal provider adapters", () => {
  it("uses each provider's native image shape", () => {
    expect(toResponseInput(messages)[0]).toMatchObject({
      content: [
        { type: "input_text", text: "Read this image." },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
    expect(toNativeMessages(messages)[0]).toMatchObject({
      content: [
        { type: "text", text: "Read this image." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
        },
      ],
    });
    expect(toNativeContents(messages)[0]).toEqual({
      role: "user",
      parts: [
        { text: "Read this image." },
        { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
      ],
    });
  });

  it("preserves Claude compaction blocks only on models that support them", () => {
    const checkpoint: LlmMessage[] = [{
      role: "assistant",
      content: "[Conversation checkpoint]\nsummary",
      contextCheckpoint: { provider: "claude", content: "summary" },
    }];
    expect(toNativeMessages(checkpoint, true)[0]).toEqual({
      role: "assistant",
      content: [{ type: "compaction", content: "summary" }],
    });
    expect(toNativeMessages(checkpoint, false)[0]).toEqual({
      role: "assistant",
      content: "[Conversation checkpoint]\nsummary",
    });

    const item = {
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque",
    };
    expect(toResponseInput([{
      role: "assistant",
      content: "",
      contextCheckpoint: { provider: "openai", item },
    }])).toEqual([item]);
  });
});
