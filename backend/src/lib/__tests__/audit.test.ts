import { describe, expect, it } from "vitest";

import { recordChatTurn } from "../audit";

function makeDb() {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { db: db as never, inserts };
}

const base = {
  userId: "u1",
  userEmail: "u1@example.com",
  chatId: "chat1",
  projectId: null,
  title: "My chat",
  model: "claude-x",
};

describe("recordChatTurn", () => {
  it("records the turn and its generated artifacts", async () => {
    const { db, inserts } = makeDb();
    await recordChatTurn(db, base, [
      { type: "doc_created", filename: "brief.docx", document_id: "d1" },
      { type: "doc_edited", filename: "memo.docx", document_id: "d2" },
      { type: "workflow_applied", workflow_id: "wf1", title: "Cleanup" },
    ]);

    expect(inserts.map((row) => row.action)).toEqual([
      "chat.message",
      "document.generated",
      "document.edited",
      "workflow.applied",
    ]);
    expect(inserts[1]).toMatchObject({
      title: "brief.docx",
      document_id: "d1",
    });
    expect(inserts[3]).toMatchObject({ detail: { workflow_id: "wf1" } });
  });

  it("records each replicated copy rather than the source", async () => {
    const { db, inserts } = makeDb();
    await recordChatTurn(db, base, [
      {
        type: "doc_replicated",
        filename: "source.docx",
        copies: [
          { new_filename: "copy-a.docx", document_id: "da" },
          { new_filename: "copy-b.docx", document_id: "db" },
        ],
      },
    ]);

    const artifacts = inserts.filter(
      (row) => row.action === "document.generated",
    );
    expect(artifacts.map((row) => row.title)).toEqual([
      "copy-a.docx",
      "copy-b.docx",
    ]);
    expect(inserts.some((row) => row.title === "source.docx")).toBe(false);
  });
});
