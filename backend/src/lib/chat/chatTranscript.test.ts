import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../chatStore";
import {
  projectChatTranscript, workflowForContinuation,
} from "./chatTranscript";

function message(
  role: "user" | "assistant",
  content: ChatMessageRecord["content"],
  extra: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  return {
    id: randomUUID(),
    chat_id: "00000000-0000-0000-0000-000000000001",
    role,
    content,
    created_at: "2026-07-27T00:00:00.000Z",
    ...extra,
  };
}

describe("projectChatTranscript", () => {
  it("reconstructs provider input from durable rows", () => {
    expect(
      projectChatTranscript([
        message("user", "Question", {
          files: [
            { filename: "Evidence.png", document_id: "document-1" },
            { filename: "", document_id: "ignored" },
            { filename: "orphan.pdf", document_id: "" },
          ],
          workflow: { id: "workflow-1", variant_id: "variant-1", title: "Review" },
        }),
        message("assistant", [
          { type: "content", text: "Answer" },
          { type: "local_mutation_committed", schema_version: 1 },
        ]),
      ]),
    ).toEqual([
      {
        role: "user",
        content: "Question",
        files: [
          { filename: "Evidence.png", document_id: "document-1" },
        ],
        workflow: { id: "workflow-1", variant_id: "variant-1", title: "Review" },
      },
      { role: "assistant", content: "Answer" },
    ]);
  });

  it("preserves ask-input turn order without promoting event metadata", () => {
    expect(
      projectChatTranscript([
        message("assistant", [
          { type: "content", text: "Choose." },
          {
            type: "ask_inputs",
            items: [
              {
                id: "forum",
                kind: "choice",
                question: "Forum?",
                options: [{ value: "Ontario" }],
              },
            ],
          },
          {
            type: "ask_inputs_response",
            responses: [
              {
                id: "forum",
                kind: "choice",
                answer: "Ontario",
              },
            ],
          },
          { type: "content", text: "Ontario selected." },
          { type: "reasoning", text: "not provider history" },
        ]),
      ]),
    ).toEqual([
      { role: "assistant", content: "Choose." },
      {
        role: "user",
        content: "[User responses to requested inputs]\n- Forum?: Ontario",
      },
      { role: "assistant", content: "Ontario selected." },
    ]);
  });

  it("retains document-request context and durable document identities", () => {
    expect(
      projectChatTranscript([
        message("assistant", [
          {
            type: "ask_inputs",
            items: [
              {
                id: "record",
                kind: "documents",
                document_types: ["Appeal record", "Factum"],
              },
            ],
          },
          {
            type: "ask_inputs_response",
            responses: [
              {
                id: "record",
                kind: "documents",
                documents: [
                  {
                    document_id: "document-1",
                    filename: "record.pdf",
                  },
                ],
              },
            ],
          },
        ]),
      ]),
    ).toEqual([
      {
        role: "user",
        content:
          "[User responses to requested inputs]\n" +
          "- Documents requested for Appeal record, Factum: record.pdf",
        files: [
          {
            document_id: "document-1",
            filename: "record.pdf",
          },
        ],
      },
    ]);
  });

  it("keeps failures visible to the model and operation state out of its transcript", () => {
    expect(
      projectChatTranscript([
        message("assistant", [
          { type: "content", text: "Partial answer." },
          { type: "error", message: "private provider detail" },
        ]),
        message("assistant", [
          { type: "content", text: "Another partial." },
          { type: "turn_status", status: "cancelled" },
        ]),
      ]),
    ).toEqual([
      {
        role: "assistant",
        content:
          "Partial answer.\n\n" +
          "[The previous assistant response ended before completion.]",
      },
      {
        role: "assistant",
        content: "Another partial.",
      },
    ]);
  });
});

describe("visibleChatMessages", () => {
  it("keeps created documents without replaying private checkpoint payloads", () => {
    const projected = projectChatTranscript([message("assistant", [
      { type: "content", text: "The memo is ready." },
      {
        type: "document_artifact",
        filename: "Memo.docx",
        document_id: "document-1",
        version_id: "version-1",
        action: "created", version_number: 1, download_url: "/documents/document-1/download",
      },
      {
        type: "context_checkpoint", schema_version: 1, keep_current: false,
        payload: { evidence_id: "e_hidden", span_text: "hidden passage" },
      },
    ])]);

    expect(projected).toHaveLength(1);
    expect(projected[0].content).toContain(
      '[Created document: "Memo.docx"; resource: document://document-1/version/version-1]',
    );
    expect(projected[0].content).not.toContain("e_hidden");
    expect(projected[0].content).not.toContain("hidden passage");
  });
});


it("replays tool pairs and steering without duplicating the display answer or leaking private events", async () => {
  const { parseAssistantEvent, publicAssistantEvent } = await import("./assistantEvents");
  const step = { type: "model_messages" as const, id: "step", model: "gemini-3-flash-preview", messages: [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "r1", toolName: "Read", input: { file: "A" } }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "r1", toolName: "Read",
      output: { type: "text" as const, value: "Evidence" } }] },
  ] };
  expect(parseAssistantEvent(step)).not.toBeNull();
  expect(publicAssistantEvent(step)).toBeNull();
  const projected = projectChatTranscript([message("assistant", [step,
    { type: "steering", id: "s1", text: "Do not change the indemnity clause." },
    { type: "content", text: "Display-only answer" },
  ])]);
  expect(projected).toHaveLength(2);
  expect(projected[0].modelState?.messages).toEqual(step.messages);
  expect(projected[1]).toEqual({ role: "user", content: "Do not change the indemnity clause." });
  expect(JSON.stringify(projected)).not.toContain("Display-only answer");
});

it("recovers the workflow that asked the pending question, rather than a later or earlier workflow", () => {
  const original = message("user", "Review", { workflow: { id: "review", variant_id: "detailed", title: "Detailed review" } });
  const pending = message("assistant", []), later = message("user", "Other task", {
    workflow: { id: "other", title: "Other" },
  });
  expect(workflowForContinuation([original, pending, later], pending.id)).toEqual(original.workflow);
  expect(workflowForContinuation([message("user", "No workflow"), pending], pending.id)).toBeUndefined();
});

it("native compaction replaces only the history of the same model", () => {
  const model = "gpt-5.5", rows = [message("user", "Earlier instruction"), message("assistant", [{
    type: "model_messages", id: "compact", model, compacted: true, messages: [{ role: "assistant", content: [
      { type: "custom", kind: "openai.compaction", providerOptions: { openai: { itemId: "c1", encryptedContent: "opaque" } } },
      { type: "text", text: "After compaction" },
    ] }],
  }, { type: "content", text: "Display-only answer" }])];
  const native = projectChatTranscript(rows, "openai", model);
  expect(native).toHaveLength(1);
  expect(native[0].modelState?.compacted).toBe(true);
  expect(projectChatTranscript(rows, "openai", "gpt-5.4")[0].content).toBe("Earlier instruction");
});
