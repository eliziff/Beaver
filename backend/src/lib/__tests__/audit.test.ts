import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createAuditStore } from "../audit";
import { LocalDatabase } from "../relationalDatabase";

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
    const db = new LocalDatabase(new DatabaseSync(":memory:"));
    await db.query({ text: `CREATE TABLE audit_events(id text primary key,user_id text,
      user_email text,action text,status text,title text,surface text,project_id text,
      chat_id text,document_id text,review_id text,model text,detail text,created_at text)`, params: [] });
    const audit = createAuditStore(db);
    await audit.recordChatTurn(base, [
      { type: "document_artifact", action: "created", filename: "brief.docx",
        document_id: "d1", download_url: "/documents/d1", version_id: "v1",
        version_number: 1 },
      { type: "document_artifact", action: "edited", filename: "memo.docx",
        document_id: "d2", download_url: "/documents/d2", version_id: "v2",
        version_number: 2 },
    ]);

    const inserts = (await db.query<Record<string, unknown>>({
      text: "SELECT * FROM audit_events ORDER BY created_at,id", params: [],
    })).rows;
    expect(inserts.map((row) => row.action).sort()).toEqual([
      "chat.message",
      "document.edited",
      "document.generated",
    ].sort());
    expect(inserts.find((row) => row.document_id === "d1")).toMatchObject({
      title: "brief.docx",
      document_id: "d1",
    });
    await audit.record({ userId: "someone-else", action: "chat.message" });
    const page = await audit.list({ userId: "u1" }, {
      q: "brief.docx", sortBy: "created_at", sortDirection: "desc", page: 1, limit: 50,
    });
    expect(page).toMatchObject({ total: 1,
      events: [{ user_id: "u1", document_id: "d1" }] });
    await db.close();
  });

});
