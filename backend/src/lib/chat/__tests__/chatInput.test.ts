import { expect, it } from "vitest";
import { chatTurnInputSchema } from "../chatApplication";

it("bounds user messages before provider dispatch", () => {
  const input = (content: string) => ({
    current_turn: { kind: "message", content },
    expected_version: 0,
  });
  expect(chatTurnInputSchema.safeParse(input("x".repeat(200_000))).success).toBe(true);
  expect(chatTurnInputSchema.safeParse(input("x".repeat(200_001))).success).toBe(false);
});

it("accepts document IDs without trusting client-echoed filenames", () => {
  const input = (files: Record<string, string>[]) => ({
    current_turn: { kind: "message", content: "Read this", files },
    expected_version: 0,
  });
  expect(chatTurnInputSchema.safeParse(input([
    { document_id: "document-1" },
  ])).success).toBe(true);
  expect(chatTurnInputSchema.safeParse(input([
    { document_id: "document-1", filename: "spoofed.docx" },
  ])).success).toBe(false);
});

it("accepts workflow IDs without trusting client-echoed titles", () => {
  const input = (workflow: Record<string, string>) => ({
    current_turn: { kind: "message", content: "Run this", workflow },
    expected_version: 0,
  });
  expect(chatTurnInputSchema.safeParse(input({ id: "workflow-1" })).success).toBe(true);
  expect(chatTurnInputSchema.safeParse(input({
    id: "workflow-1", title: "Spoofed title",
  })).success).toBe(false);
});

it("rejects unsupported per-turn provider controls", () => {
  expect(chatTurnInputSchema.safeParse({
    current_turn: { kind: "message", content: "Run this" },
    expected_version: 0,
    service_tier: "priority",
  }).success).toBe(false);
});

it("rejects an explicit unknown model instead of silently rerouting it", () => {
  const turn = (model?: string) => chatTurnInputSchema.safeParse({
    current_turn: { kind: "message", content: "Run this" },
    expected_version: 0,
    ...(model ? { model } : {}),
  }).success;
  expect(turn()).toBe(true);
  expect(turn("gpt-3.5-turbo")).toBe(false);
});
