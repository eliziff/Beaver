import { describe, expect, it } from "vitest";
import {
  parseAnonymousCurrentTurn,
  parseExpectedTranscriptVersion,
} from "./anonymousCurrentTurn";

describe("anonymous current-turn parsing", () => {
  it("makes the user role implicit and keeps only bounded references", () => {
    expect(
      parseAnonymousCurrentTurn({
        kind: "message",
        role: "assistant",
        content: "  Current request  ",
        files: [{ filename: " Evidence.png ", document_id: " document-1 " }],
        workflow: { id: " review ", title: " Review evidence " },
      }),
    ).toEqual({
      ok: true,
      turn: {
        kind: "message",
        message: {
          role: "user",
          content: "Current request",
          files: [
            { filename: "Evidence.png", document_id: "document-1" },
          ],
          workflow: { id: "review", title: "Review evidence" },
        },
      },
    });
  });

  it("validates ask-input responses and transcript versions", () => {
    expect(
      parseAnonymousCurrentTurn({
        kind: "ask_inputs_response",
        content: "Ontario",
        responses: [
          {
            id: "forum",
            kind: "choice",
            question: "Forum?",
            answer: "Ontario",
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      turn: { kind: "ask_inputs_response", content: "Ontario" },
    });
    expect(parseExpectedTranscriptVersion(0)).toEqual({
      ok: true,
      version: 0,
    });
    expect(parseExpectedTranscriptVersion(-1)).toEqual({
      ok: false,
      detail: "expected_version must be a non-negative integer",
    });
  });

  it("keeps bounded document identities for local structured responses", () => {
    expect(
      parseAnonymousCurrentTurn({
        kind: "ask_inputs_response",
        content: "Attached",
        files: [{ filename: "Record.pdf", document_id: "document-1" }],
        responses: [
          {
            id: "record",
            kind: "documents",
            filenames: ["Browser name.pdf"],
            documents: [
              {
                filename: "Browser name.pdf",
                document_id: " document-1 ",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      turn: {
        response: {
          responses: [
            {
              id: "record",
              kind: "documents",
              documents: [
                {
                  filename: "Browser name.pdf",
                  document_id: "document-1",
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("rejects raw or malformed attachment payloads", () => {
    expect(
      parseAnonymousCurrentTurn({
        kind: "message",
        content: "Inspect this",
        files: [{ filename: "raw.png", data: "base64" }],
      }),
    ).toEqual({
      ok: false,
      detail: "current_turn.files must contain Library document references",
    });
  });

  it("accepts an optional bounded replay identity for normal messages", () => {
    expect(
      parseAnonymousCurrentTurn({
        kind: "message",
        turn_id: "10000000-0000-4000-8000-000000000001",
        content: "Create the draft",
      }),
    ).toMatchObject({
      ok: true,
      turn: { turnId: "10000000-0000-4000-8000-000000000001" },
    });
    expect(
      parseAnonymousCurrentTurn({
        kind: "message",
        turn_id: "browser-label",
        content: "Create the draft",
      }),
    ).toEqual({
      ok: false,
      detail: "current_turn.turn_id must be a UUID",
    });
  });
});
