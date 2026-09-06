import { randomUUID } from "node:crypto";
import type { ApplicationScope } from "./applicationError";
import { patchChatEditEvents, type ChatCommitResult, type ChatMessageRecord, type ChatMutation, type ChatRecord, type CreateChatRepository } from "./chatStore";
import { decodeJson as decode, encodeJson as encode, relationalDatabase, sql, type RelationalDatabase } from "./relationalDatabase";
import { chatAccess, changes, documentAccess, now, one, rows, type Row } from "./relationalRepositorySupport";
import { parseAssistantEvent, type AssistantEvent } from "./chat/assistantEvents";

const chatRecord = (row: Row): ChatRecord => ({ ...row, id: String(row.id),
  user_id: String(row.user_id), project_id: typeof row.project_id === "string" ? row.project_id : null,
  tabular_review_id: typeof row.tabular_review_id === "string" ? row.tabular_review_id : null,
  research_file_id: typeof row.research_file_id === "string" ? row.research_file_id : null,
  title: typeof row.title === "string" ? row.title : null,
  model: typeof row.model === "string" ? row.model : null,
  reasoning_effort: typeof row.reasoning_effort === "string" ? row.reasoning_effort : null,
  draft: decode(row.draft, null),
  transcript_version: Number(row.transcript_version ?? 0) });
const chatMessage = (row: Row, content?: unknown[]): ChatMessageRecord => ({ ...row, id: String(row.id),
  chat_id: String(row.chat_id), ...(row.turn_id ? { turn_id: String(row.turn_id) } : {}),
  role: row.role === "user" ? "user" : "assistant",
  content: row.role === "user" ? decode<string>(row.content, "")
    : (content ?? []).flatMap((event) => parseAssistantEvent(event) ?? []),
  ...(row.files !== null ? { files: decode(row.files, null) } : {}),
  ...(row.workflow !== null ? { workflow: decode(row.workflow, null) } : {}),
  ...(row.citations !== null ? { citations: decode(row.citations, null) } : {}) });

type Sequenced = { message_id: string; sequence: number; value: unknown };
function grouped(values: Sequenced[]) {
  const result = new Map<string, unknown[]>();
  for (const row of values) {
    const items = result.get(row.message_id) ?? [];
    items[Number(row.sequence)] = decode(row.value, null);
    result.set(row.message_id, items);
  }
  return result;
}

async function syncMessageEvents(
  tx: RelationalDatabase,
  messageId: string,
  values: AssistantEvent[],
) {
  const prior = new Map((await tx.query<{ sequence: number; value: unknown }>(sql`
    SELECT ordinal AS sequence,event AS value FROM chat_message_events
    WHERE message_id=${messageId}`)).rows.map((row) =>
      [Number(row.sequence), encode(decode(row.value, null))] as const));
  for (let sequence = 0; sequence < values.length; sequence += 1) {
    const value = encode(values[sequence]);
    if (prior.get(sequence) === value) continue;
    await tx.query(sql`INSERT INTO chat_message_events(
      message_id,ordinal,event,created_at) VALUES(${messageId},${sequence},${value},${now()})
      ON CONFLICT(message_id,ordinal) DO UPDATE SET event=excluded.event`);
  }
  await tx.query(sql`DELETE FROM chat_message_events WHERE message_id=${messageId}
    AND ordinal>=${values.length}`);
}
async function findChat(scope: ApplicationScope, id: string, deleted = false,
  owner = false, db?: RelationalDatabase) {
  const row = await one(sql`SELECT c.*,(SELECT d.content FROM chat_drafts d WHERE d.chat_id=c.id AND d.user_id=${scope.userId}) AS draft FROM chats c WHERE c.id=${id}
    AND c.deleted_at IS ${deleted ? sql.raw("NOT NULL") : sql.raw("NULL")}
    AND ${chatAccess(scope, owner)}`, db);
  return row ? chatRecord(row) : null;
}
async function decorateMessages(scope: ApplicationScope, messages: ChatMessageRecord[]) {
  const editIds = new Set<string>(), versionIds = new Set<string>();
  for (const message of messages) for (const raw of Array.isArray(message.content) ? message.content : []) {
    if (raw.type !== "document_artifact" || raw.action !== "edited") continue;
    versionIds.add(raw.version_id);
    for (const annotation of raw.annotations ?? []) {
      editIds.add(annotation.edit_id);
      versionIds.add(annotation.version_id);
    }
  }
  const [edits, versions] = await Promise.all([
    editIds.size ? rows<{ id: string; status: "pending" | "accepted" | "rejected" }>(
      sql`SELECT e.id,e.status FROM document_edits e JOIN documents d ON d.id=e.document_id
        WHERE e.id IN(${sql.join([...editIds])}) AND ${documentAccess(scope)}`) : [],
    versionIds.size ? rows<{ id: string; version_number: number }>(
      sql`SELECT v.id,v.version_number FROM document_versions v JOIN documents d
        ON d.id=v.document_id WHERE v.id IN(${sql.join([...versionIds])})
          AND ${documentAccess(scope)}`) : [],
  ]);
  return patchChatEditEvents(messages, edits.map(({ id, status }) => [id, status] as const),
    versions.map(({ id, version_number }) => [id, Number(version_number)] as const));
}
async function commitChat(scope: ApplicationScope, id: string, mutation: ChatMutation) {
  const db = await relationalDatabase();
  return db.transaction(async (tx): Promise<ChatCommitResult> => {
    const current = await findChat(scope, id, false, false, tx);
    if (!current) return { status: "missing" };
    const expected = mutation.kind === "turn" ? mutation.turn.expectedVersion
      : current.transcript_version;
    if (expected !== current.transcript_version)
      return { status: "conflict", currentVersion: current.transcript_version };
    if (mutation.kind === "append") {
      const message = await one(sql`SELECT id FROM chat_messages WHERE id=${mutation.messageId}
        AND chat_id=${id} AND role='assistant'`, tx);
      if (!message) return { status: "missing" };
    }
    const version = current.transcript_version + 1, created = now();
    if (!await changes(sql`UPDATE chats SET updated_at=${created},transcript_version=${version}
      WHERE id=${id} AND transcript_version=${current.transcript_version}`, tx))
      return { status: "conflict", currentVersion: current.transcript_version };
    if (mutation.kind === "append") {
      const existing = (await tx.query<{ ordinal: number }>(sql`SELECT ordinal
        FROM chat_message_events WHERE message_id=${mutation.messageId}
        ORDER BY ordinal DESC LIMIT 1`)).rows[0];
      const sequence = existing ? Number(existing.ordinal) + 1 : 0;
      await tx.query(sql`INSERT INTO chat_message_events(message_id,ordinal,event,created_at)
        VALUES(${mutation.messageId},${sequence},${encode(mutation.event)},${created})`);
    } else {
      const { userMessage, assistantMessage } = mutation.turn;
      if (userMessage) await changes(sql`INSERT INTO chat_messages(id,chat_id,turn_id,role,
        content,files,workflow,citations,created_at) VALUES(${userMessage.id},${id},
        ${userMessage.turnId ?? null},'user',${encode(userMessage.content)},
        ${userMessage.files === undefined ? null : encode(userMessage.files)},
        ${userMessage.workflow === undefined ? null : encode(userMessage.workflow)},${null},${created})`, tx);
      if (assistantMessage) {
        await changes(sql`INSERT INTO chat_messages(id,chat_id,turn_id,role,
        content,files,workflow,citations,created_at) VALUES(${assistantMessage.id},${id},
        ${assistantMessage.turnId ?? null},'assistant',${encode([])},${null},${null},
        ${assistantMessage.citations === undefined ? null : encode(assistantMessage.citations)},${created})
        ON CONFLICT(id) DO UPDATE SET turn_id=COALESCE(excluded.turn_id,chat_messages.turn_id),
          content=excluded.content,citations=excluded.citations`, tx);
        await syncMessageEvents(tx, assistantMessage.id, assistantMessage.content);
      }
    }
    return { status: "committed", currentVersion: version };
  });
}

export const chatRepository: CreateChatRepository = (scope) => ({
  async list(options) {
    const db = await relationalDatabase();
    const assistantContext = sql`c.project_id IS NULL AND c.tabular_review_id IS NULL AND c.user_id=${scope.userId}`;
    const reviewContext = sql`c.project_id IS NULL AND EXISTS(SELECT 1 FROM tabular_reviews r
      WHERE r.id=c.tabular_review_id AND r.project_id IS NULL)`;
    const context = options.projectId ? sql`c.project_id=${options.projectId}`
      : options.tabularReviewId ? sql`c.tabular_review_id=${options.tabularReviewId}`
        : options.searchContext === "reviews" ? reviewContext
          : options.searchContext === "all" ? sql`(${assistantContext} OR ${reviewContext})` : assistantContext;
    const scoped = sql`SELECT c.* FROM chats c WHERE ${context} AND ${chatAccess(scope)}
      AND c.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id)
        OR EXISTS(SELECT 1 FROM chat_drafts d WHERE d.chat_id=c.id AND d.user_id=${scope.userId}))
      ${options.createdFrom ? sql`AND c.created_at>=${options.createdFrom}` : sql.raw("")}
      ${options.createdTo ? sql`AND c.created_at<${options.createdTo}` : sql.raw("")}`;
    const order = options.sort === "oldest" ? sql.raw("c.updated_at ASC,c.created_at ASC,c.id")
      : sql.raw("c.updated_at DESC,c.created_at DESC,c.id");
    const paging = options.limit ? sql`LIMIT ${options.limit} OFFSET ${options.offset ?? 0}` : sql.raw("");
    const search = options.search?.trim().toLowerCase();
    if (!search) return (await rows(sql`${scoped} ORDER BY ${order} ${paging}`, db)).map(chatRecord);
    const pattern = `%${search.replace(/[\\%_]/gu, "\\$&")}%`;
    const titleMatch = sql`LOWER(COALESCE(c.title,'')) LIKE ${pattern} ESCAPE '\\'`;
    if (options.searchScope === "titles") return (await rows(sql`${scoped}
      AND ${titleMatch} ORDER BY ${order} ${paging}`, db)).map((row) => ({
      ...chatRecord(row), search_hit: { message_id: null, snippet: String(row.title ?? "") } }));
    const userText = db.engine === "postgres" ? sql.raw("m.content #>> '{}'") : sql.raw("m.content ->> '$'");
    const assistantText = db.engine === "postgres"
      ? sql.raw("STRING_AGG(e.event ->> 'text', '' ORDER BY e.ordinal)")
      : sql.raw("GROUP_CONCAT(e.event ->> 'text', '' ORDER BY e.ordinal)");
    const position = db.engine === "postgres" ? sql`STRPOS(LOWER(h.body),${search})`
      : sql`INSTR(LOWER(h.body),${search})`;
    // ponytail: scans the scoped transcript; add a text index only when measured history size requires one.
    return (await rows(sql`WITH scoped AS (${scoped}), message_text AS (
      SELECT m.chat_id,m.id,m.created_at,CASE WHEN m.role='user' THEN ${userText}
        ELSE (SELECT ${assistantText} FROM chat_message_events e
          WHERE e.message_id=m.id AND e.event ->> 'type'='content') END AS body
      FROM chat_messages m JOIN scoped c ON c.id=m.chat_id
    ), hits AS (
      SELECT chat_id,id,body,ROW_NUMBER() OVER(PARTITION BY chat_id ORDER BY created_at,id) AS rank
      FROM message_text WHERE LOWER(body) LIKE ${pattern} ESCAPE '\\'
    ) SELECT c.*,h.id AS search_message_id,
      SUBSTR(h.body,CASE WHEN ${position}>80 THEN ${position}-80 ELSE 1 END,360) AS search_snippet
      FROM scoped c LEFT JOIN hits h ON h.chat_id=c.id AND h.rank=1
      WHERE ${options.searchScope === "transcripts" ? sql`h.id IS NOT NULL` : sql`(${titleMatch} OR h.id IS NOT NULL)`}
      ORDER BY ${order} ${paging}`, db)).map(({ search_message_id, search_snippet, ...row }) => ({
      ...chatRecord(row), search_hit: { message_id: search_message_id ? String(search_message_id) : null,
        snippet: String(search_snippet ?? row.title ?? "") } }));
  },
  async deleted() {
    return (await rows(sql`SELECT c.* FROM chats c WHERE c.user_id=${scope.userId}
      AND c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC,c.id`)).map(chatRecord);
  },
  async purge(cutoff) {
    return (await rows<{ id: string }>(sql`DELETE FROM chats WHERE user_id=${scope.userId}
      AND deleted_at IS NOT NULL AND deleted_at<=${cutoff} RETURNING id`)).map(({ id }) => id);
  },
  async create(input) {
    const id = randomUUID(), created = now();
    await changes(sql`INSERT INTO chats(id,user_id,project_id,tabular_review_id,research_file_id,title,
      created_at,updated_at,deleted_at,transcript_version) VALUES(${id},${scope.userId},
      ${input.projectId},${input.tabularReviewId},${input.researchFileId ?? null},${null},${created},${created},${null},0)`);
    return (await findChat(scope, id, false, true))!;
  },
  async read(id, messages = false, deleted = false) {
    const chat = await findChat(scope, id, deleted);
    if (!chat) return null;
    let values: ChatMessageRecord[] = [];
    if (messages) {
      const raw = await rows(sql`SELECT * FROM chat_messages WHERE chat_id=${id}
        ORDER BY created_at,id`);
      const events = grouped(await rows<Sequenced>(sql`SELECT e.message_id,
        e.ordinal AS sequence,e.event AS value FROM chat_message_events e
        JOIN chat_messages m ON m.id=e.message_id WHERE m.chat_id=${id}
        ORDER BY e.message_id,e.ordinal`));
      values = raw.map((row) => chatMessage(row, events.get(String(row.id))));
    }
    return { chat, messages: values };
  },
  async owns(id) { return !!await findChat(scope, id, false, true); },
  commit(id, mutation) { return commitChat(scope, id, mutation); },
  async update(id, input) {
    const current = await findChat(scope, id, false, true);
    if (!current) return null;
    if (input.draft !== undefined) {
      if (input.draft === null) await changes(sql`DELETE FROM chat_drafts WHERE chat_id=${id} AND user_id=${scope.userId}`);
      else await changes(sql`INSERT INTO chat_drafts(chat_id,user_id,content) VALUES(${id},${scope.userId},${encode(input.draft)})
        ON CONFLICT(chat_id,user_id) DO UPDATE SET content=excluded.content`);
      const title = typeof input.draft?.content === "string" ? input.draft.content.trim().slice(0, 80) : "";
      await changes(sql`UPDATE chats SET updated_at=${now()},title=CASE WHEN transcript_version=0 AND ${title}<>'' THEN ${title} ELSE title END
        WHERE id=${id} AND user_id=${scope.userId} AND deleted_at IS NULL`);
      return findChat(scope, id, false, true);
    }
    await changes(sql`UPDATE chats SET title=${input.title ?? current.title},
      project_id=${input.projectId === undefined ? current.project_id : input.projectId},
      research_file_id=${input.researchFileId === undefined ? current.research_file_id ?? null : input.researchFileId},
      model=${input.model === undefined ? current.model : input.model},
      reasoning_effort=${input.reasoningEffort === undefined
        ? current.reasoning_effort : input.reasoningEffort},
      updated_at=${now()} WHERE id=${id} AND user_id=${scope.userId} AND deleted_at IS NULL`);
    return findChat(scope, id, false, true);
  },
  async trash(id, at) {
    return await changes(sql`UPDATE chats SET deleted_at=${at},updated_at=${at}
      WHERE id=${id} AND user_id=${scope.userId} AND deleted_at IS NULL`) > 0;
  },
  async restore(id, cutoff, at) {
    return await changes(sql`UPDATE chats SET deleted_at=${null},updated_at=${at}
      WHERE id=${id} AND user_id=${scope.userId} AND deleted_at>${cutoff}`) > 0;
  },
  async remove(id) {
    return await changes(sql`DELETE FROM chats WHERE id=${id} AND user_id=${scope.userId}
      AND deleted_at IS NOT NULL`) > 0;
  },
  async removeAll() {
    return (await rows<{ id: string }>(sql`DELETE FROM chats WHERE user_id=${scope.userId}
      RETURNING id`)).map(({ id }) => id);
  },
  decorate(messages) { return decorateMessages(scope, messages); },
});
