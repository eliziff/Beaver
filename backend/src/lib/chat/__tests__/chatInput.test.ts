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

it("accepts only typed Court Record and Authorities scopes", () => {
  const base = { current_turn: { kind: "message", content: "Connect the book" },
    expected_version: 0 };
  expect(chatTurnInputSchema.safeParse({ ...base, work_product: {
    kind: "court-record", id: "00000000-0000-4000-8000-000000000001",
    revision: 3,
  } }).success).toBe(true);
  expect(chatTurnInputSchema.safeParse({ ...base, work_product: {
    kind: "authorities", id: "00000000-0000-4000-8000-000000000001",
    revision: 3,
  } }).success).toBe(true);
  expect(chatTurnInputSchema.safeParse({ ...base, work_product: {
    kind: "other", id: "00000000-0000-4000-8000-000000000001", revision: 3,
  } }).success).toBe(false);
});

it("bounds work-product focus and its UTF-16 selection", () => {
  const base = { current_turn: { kind: "message", content: "Fix this citation" },
    expected_version: 0, work_product: { kind: "authorities",
      id: "00000000-0000-4000-8000-000000000001", revision: 3,
      focus: { item_id: "occurrence-1", selection: { start: 4, end: 18 } } } };
  expect(chatTurnInputSchema.safeParse(base).success).toBe(true);
  expect(chatTurnInputSchema.safeParse({ ...base, work_product: { ...base.work_product,
    focus: { item_id: "occurrence-1", selection: { start: 18, end: 4 } } } }).success).toBe(false);
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
