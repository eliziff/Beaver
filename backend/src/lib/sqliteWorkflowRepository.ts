import { randomUUID } from "node:crypto";
import { sqliteDatabase, sqliteTransaction } from "./sqliteDatabase";
import type {
  CreateWorkflowRepository,
  WorkflowRecord,
} from "./workflowRepository";

type Row = Record<string, unknown>;
const db = () => sqliteDatabase();
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
};
const record = (row: Row): WorkflowRecord => ({
  ...parse<WorkflowRecord>(row.payload_json, {} as WorkflowRecord),
  id: String(row.id), user_id: String(row.user_id), title: String(row.title),
  type: row.type === "tabular" ? "tabular" : "assistant",
  created_at: String(row.created_at),
});
const find = (userId: string, workflowId: string) => {
  const row = db().prepare(`SELECT * FROM workflows WHERE id=? AND user_id=?`)
    .get(workflowId, userId) as Row | undefined;
  return row ? record(row) : null;
};

export const sqliteWorkflowRepository: CreateWorkflowRepository = (scope) => ({
  async page(options) {
    const parameters: (string | number | null)[] = [scope.userId];
    const where = ["user_id=?"];
    if (options.type) { where.push("type=?"); parameters.push(options.type); }
    if (options.q) { where.push("instr(lower(title),?)>0"); parameters.push(options.q); }
    if (options.after) {
      where.push("(created_at<? OR (created_at=? AND id<?))");
      parameters.push(options.after[0], options.after[0], options.after[1]);
    }
    const rows = db().prepare(`SELECT * FROM workflows WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...parameters, options.limit + 1) as Row[];
    const page = rows.slice(0, options.limit).map(record), last = page.at(-1);
    return { items: page, nextAfter: rows.length > options.limit && last
      ? [last.created_at, last.id] : null };
  },
  async hidden() {
    return (db().prepare(`SELECT workflow_id FROM hidden_workflows WHERE user_id=?`)
      .all(scope.userId) as { workflow_id: string }[]).map(({ workflow_id }) => workflow_id);
  },
  async hide(workflowId) {
    db().prepare(`INSERT OR IGNORE INTO hidden_workflows(user_id,workflow_id) VALUES(?,?)`)
      .run(scope.userId, workflowId);
  },
  async unhide(workflowId) {
    db().prepare(`DELETE FROM hidden_workflows WHERE user_id=? AND workflow_id=?`)
      .run(scope.userId, workflowId);
  },
  async create(input) {
    const id = randomUUID(), now = new Date().toISOString();
    const payload = { prompt_md: input.promptMd, columns_config: input.columns,
      language: input.language, version: null, practice: input.practice,
      jurisdictions: input.jurisdictions, contributors: null };
    db().prepare(`INSERT INTO workflows
      (id,user_id,title,type,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, scope.userId, input.title, input.type, JSON.stringify(payload), now, now);
    return record(db().prepare(`SELECT * FROM workflows WHERE id=?`).get(id) as Row);
  },
  async get(workflowId) {
    const workflow = find(scope.userId, workflowId);
    return workflow ? { workflow, allowEdit: true, isOwner: true } : null;
  },
  async update(workflowId, input) {
    return sqliteTransaction((database) => {
      const workflow = find(scope.userId, workflowId);
      if (!workflow) return null;
      const payload = { prompt_md: input.promptMd === undefined
        ? workflow.prompt_md : input.promptMd,
      columns_config: input.columns === undefined ? workflow.columns_config : input.columns,
      language: input.language === undefined ? workflow.language : input.language,
      version: workflow.version,
      practice: input.practice === undefined ? workflow.practice : input.practice,
      jurisdictions: input.jurisdictions === undefined
        ? workflow.jurisdictions : input.jurisdictions,
      contributors: workflow.contributors };
      database.prepare(`UPDATE workflows SET title=?,payload_json=?,updated_at=?
        WHERE id=? AND user_id=?`).run(input.title ?? workflow.title,
          JSON.stringify(payload), new Date().toISOString(), workflowId, scope.userId);
      const updated = find(scope.userId, workflowId)!;
      return { workflow: updated, allowEdit: true, isOwner: true };
    });
  },
  async remove(workflowId) {
    return sqliteTransaction((database) => {
      const removed = database.prepare(`DELETE FROM workflows WHERE id=? AND user_id=?`)
        .run(workflowId, scope.userId).changes > 0;
      if (removed) database.prepare(`DELETE FROM hidden_workflows WHERE workflow_id=?`)
        .run(workflowId);
      return removed;
    });
  },
  async assistants() {
    const rows = db().prepare(`SELECT * FROM workflows WHERE user_id=? AND type='assistant'`)
      .all(scope.userId) as Row[];
    return new Map(rows.flatMap((row) => {
      const workflow = record(row);
      return workflow.prompt_md ? [[workflow.id, {
        title: workflow.title, skill_md: workflow.prompt_md,
      }] as const] : [];
    }));
  },
});
