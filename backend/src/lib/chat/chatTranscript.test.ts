import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "../chatStore";
import {
  projectChatTranscript,
  visibleChatMessages,
} from "./chatTranscript";
import { createTnaEvidence } from "./legalEvidence";

function message(
  role: "user" | "assistant",
  content: unknown,
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
  it("exposes durable turn identity and completion without internal events", () => {
    const turnId = randomUUID();

    const visible = visibleChatMessages([
      message("user", "Question", { turn_id: turnId }),
      message("assistant", [
        { type: "content", text: "Answer" },
        { type: "reasoning", text: "private reasoning" },
        { type: "future_private_receipt", secret: "private" },
        { type: "legal_evidence_receipt", status: "passed", evidence: [] },
        { type: "mcp_tool_call", connector_name: "Private connector" },
        {
          type: "subagent_run", id: "reader-1", agent: "scout", task: "Read",
          model: "private-model", effort: "high", status: "completed",
          grounding: { type: "legal_evidence_receipt" },
          resume: { continuation_id: "private-continuation" },
          error: "private failure detail",
        },
        { type: "local_turn_completed", schema_version: 1 },
      ], { turn_id: turnId }),
    ]);
    expect(visible).toMatchObject([
      { role: "user", turn_id: turnId },
      {
        role: "assistant",
        turn_id: turnId,
        turn_complete: true,
      },
    ]);
    expect(visible[1].content).toEqual([
      { type: "content", text: "Answer" },
      {
        type: "subagent_run", id: "reader-1", task: "Read",
        status: "completed",
      },
    ]);
  });

  it("keeps created documents and verified evidence in model history", () => {
    const evidence = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:1",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      citation: "2026 SCC 1",
      name: "Example v State",
      dataset: "fixture",
      externalUrl: "https://example.test/case",
      locatorKind: "paragraph",
      locatorLabel: "par12",
    });
    const projected = projectChatTranscript([message("assistant", [
      { type: "content", text: "The memo is ready." },
      {
        type: "document_artifact",
        filename: "Memo.docx",
        document_id: "document-1",
        version_id: "version-1",
      },
      {
        type: "legal_evidence_receipt",
        status: "passed",
        evidence: [evidence],
      },
    ])]);

    expect(projected).toHaveLength(1);
    expect(projected[0].content).toContain(
      '[Created document: "Memo.docx"; resource: document://document-1/version/version-1]',
    );
    expect(projected[0].content).toContain("VERIFIED EVIDENCE AVAILABLE FROM PRIOR TURNS");
    expect(projected[0].content).toContain(evidence.evidence_id);
    expect(projected[0].content).toContain('"exact_passage":"The appeal is allowed."');
  });
});
