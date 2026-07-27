import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AnonymousChatMessage } from "../anonymousChatStore";
import { projectAnonymousTranscript } from "./anonymousTranscript";

function message(
  role: "user" | "assistant",
  content: unknown,
  extra: Partial<AnonymousChatMessage> = {},
): AnonymousChatMessage {
  return {
    id: randomUUID(),
    chat_id: "00000000-0000-0000-0000-000000000001",
    role,
    content,
    created_at: "2026-07-27T00:00:00.000Z",
    ...extra,
  };
}

describe("projectAnonymousTranscript", () => {
  it("reconstructs provider input from durable rows", () => {
    expect(
      projectAnonymousTranscript([
        message("user", "Question", {
          files: [
            { filename: "Evidence.png", document_id: "document-1" },
            { filename: "", document_id: "ignored" },
          ],
          workflow: { id: "workflow-1", title: "Review" },
        }),
        message("assistant", [
          { type: "content", text: "Answer" },
          { type: "local_pdf_evidence_handles", handles: ["hidden"] },
        ]),
      ]),
    ).toEqual([
      {
        role: "user",
        content: "Question",
        files: [
          { filename: "Evidence.png", document_id: "document-1" },
        ],
        workflow: { id: "workflow-1", title: "Review" },
      },
      { role: "assistant", content: "Answer" },
    ]);
  });

  it("preserves ask-input turn order without promoting event metadata", () => {
    expect(
      projectAnonymousTranscript([
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
                allow_other: false,
                other_label: "Other",
              },
            ],
          },
          {
            type: "ask_inputs_response",
            content: "Browser-authored display text",
            responses: [
              {
                id: "forum",
                kind: "choice",
                question: "Forum?",
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
      projectAnonymousTranscript([
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
                filenames: ["record.pdf"],
                documents: [
                  {
                    document_id: "document-1",
                    filename: "record.pdf",
                  },
                ],
              },
            ],
            files: [
              {
                document_id: "document-1",
                filename: "record.pdf",
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
          "- Documents requested for Appeal record, Factum: record.pdf (document_id: document-1)",
        files: [
          {
            document_id: "document-1",
            filename: "record.pdf",
          },
        ],
      },
    ]);
  });

  it("marks failed and cancelled assistant output as incomplete", () => {
    expect(
      projectAnonymousTranscript([
        message("assistant", [
          { type: "content", text: "Partial answer." },
          { type: "error", message: "private provider detail" },
        ]),
        message("assistant", [
          { type: "content", text: "Another partial." },
          { type: "content", text: "Cancelled by user." },
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
        content: "Another partial.\n\nCancelled by user.",
      },
    ]);
  });
});
