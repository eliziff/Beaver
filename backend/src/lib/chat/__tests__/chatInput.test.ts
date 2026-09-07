import { expect, it } from "vitest";
import { chatTurnInputSchema } from "../chatApplication";

const input = (turn: Record<string, unknown> = {}) => ({
  current_turn: { kind: "message", content: "Run this", ...turn }, expected_version: 0,
});
const defaults = { edit_mode: "manual", subagent_mode: "none", activity_detail: "auto" };

it("bounds user messages before provider dispatch", () => {
  const content = "x".repeat(200_000);
  expect(chatTurnInputSchema.parse(input({ content }))).toEqual({
    current_turn: { kind: "message", content }, expected_version: 0, ...defaults,
  });
  expect(chatTurnInputSchema.safeParse(input({ content: content + "x" })).success).toBe(false);
});

it("accepts document IDs without trusting client-echoed filenames", () => {
  const files = [{ document_id: "document-1" }];
  expect(chatTurnInputSchema.parse(input({ content: "Read this", files }))).toEqual({
    current_turn: { kind: "message", content: "Read this", files: [{ document_id: "document-1" }] },
    expected_version: 0, ...defaults,
  });
  expect(chatTurnInputSchema.safeParse(input({ content: "Read this",
    files: [{ document_id: "document-1", filename: "spoofed.docx" }] })).success).toBe(false);
});

it("accepts workflow IDs without trusting client-echoed titles", () => {
  expect(chatTurnInputSchema.parse(input({ workflow: { id: "workflow-1" } }))).toEqual({
    current_turn: { kind: "message", content: "Run this", workflow: { id: "workflow-1" } },
    expected_version: 0, ...defaults,
  });
  expect(chatTurnInputSchema.safeParse(input({ workflow: {
    id: "workflow-1", title: "Spoofed title",
  } })).success).toBe(false);
});

it("rejects unsupported per-turn provider controls", () => {
  expect(chatTurnInputSchema.parse(input())).toEqual({
    current_turn: { kind: "message", content: "Run this" }, expected_version: 0, ...defaults,
  });
  expect(chatTurnInputSchema.safeParse({ ...input(), service_tier: "priority" }).success).toBe(false);
});

it("accepts only typed Court Record and Authorities scopes", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const kind of ["court-record", "authorities"]) {
    expect(chatTurnInputSchema.parse({ ...input({ content: "Connect the book" }),
      work_product: { kind, id, revision: 3 } })).toEqual({
      current_turn: { kind: "message", content: "Connect the book" }, expected_version: 0, ...defaults,
      work_product: { kind, id, revision: 3 },
    });
  }
  expect(chatTurnInputSchema.safeParse({ ...input({ content: "Connect the book" }),
    work_product: { kind: "other", id, revision: 3 } }).success).toBe(false);
});

it("bounds work-product focus and its UTF-16 selection", () => {
  const work_product = { kind: "authorities", id: "00000000-0000-4000-8000-000000000001", revision: 3,
    focus: { item_id: "occurrence-1", selection: { start: 4, end: 18 } } };
  const expected = structuredClone(work_product);
  expect(chatTurnInputSchema.parse({ ...input({ content: "Fix this citation" }), work_product })).toEqual({
    current_turn: { kind: "message", content: "Fix this citation" }, expected_version: 0, ...defaults,
    work_product: expected,
  });
  expect(chatTurnInputSchema.safeParse({ ...input({ content: "Fix this citation" }),
    work_product: { ...work_product,
      focus: { item_id: "occurrence-1", selection: { start: 18, end: 4 } } } }).success).toBe(false);
});

it("rejects an explicit unknown model instead of silently rerouting it", () => {
  expect(chatTurnInputSchema.parse(input())).toEqual({
    current_turn: { kind: "message", content: "Run this" }, expected_version: 0, ...defaults,
  });
  expect(chatTurnInputSchema.safeParse({ ...input(), model: "gpt-3.5-turbo" }).success).toBe(false);
});
