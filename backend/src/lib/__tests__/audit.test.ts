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
      { type: "document_artifact", action: "created", filename: "brief.docx",
        document_id: "d1", download_url: "/documents/d1", version_id: "v1",
        version_number: 1 },
      { type: "document_artifact", action: "edited", filename: "memo.docx",
        document_id: "d2", download_url: "/documents/d2", version_id: "v2",
        version_number: 2 },
    ]);

    expect(inserts.map((row) => row.action)).toEqual([
      "chat.message",
      "document.generated",
      "document.edited",
    ]);
    expect(inserts[1]).toMatchObject({
      title: "brief.docx",
      document_id: "d1",
    });
  });

});
