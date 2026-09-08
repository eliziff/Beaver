// Synthetic SQLite benchmark; never opens the user's store or calls a provider.
// Run from backend: node --import tsx scripts/measure-chat-search.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beaver-search-bench-"));
  process.env.AUTH_MODE = "local";
  process.env.MIKE_LOCAL_DATA_DIR = directory;
  const { relationalDatabase, closeRelationalDatabase, sql } = await import("../src/lib/relationalDatabase");
  try {
    const db = await relationalDatabase();
    const owner = { userId: "00000000-0000-0000-0000-000000000001", userEmail: "fixture@example.test" };
    await db.query(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
      INSERT INTO chats(id,user_id,title,created_at,updated_at)
      SELECT 'chat-'||i,${owner.userId},'Matter '||i,'2026-01-01','2026-01-01' FROM n`);
    await db.query(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<24)
      INSERT INTO chat_messages(id,chat_id,role,content,created_at)
      SELECT c.id||'-message-'||printf('%02d',i),c.id,'assistant','[]',printf('2026-01-%02d',i)
      FROM chats c CROSS JOIN n`);
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      await db.query(sql`INSERT INTO chat_message_events(message_id,ordinal,event,created_at)
        SELECT id,${ordinal},${JSON.stringify({ type: "content", text: "A synthetic lease renewal clause. ".repeat(20) })},created_at FROM chat_messages`);
    }
    const { chatRepository } = await import("../src/lib/relationalChatRepository");
    const repository = chatRepository(owner);
    for (const search of ["lease", "no-such-term"]) {
      const elapsed: number[] = [];
      for (let sample = 0; sample < 6; sample++) {
        const start = performance.now();
        const result = await repository.list({ search, searchScope: "transcripts", limit: 21 });
        elapsed.push(performance.now() - start);
        assert.equal(result.length, search === "lease" ? 21 : 0);
        if (result.length) assert.ok(result.every(chat => chat.search_hit?.message_id?.endsWith("-message-01")));
      }
      console.log(JSON.stringify({ chats: 1000, messages: 24000, events: 48000, search,
        medianMs: elapsed.slice(1).sort((a, b) => a - b)[2] }));
    }
  } finally {
    await closeRelationalDatabase();
    await rm(directory, { recursive: true, force: true });
  }
}
void main();
