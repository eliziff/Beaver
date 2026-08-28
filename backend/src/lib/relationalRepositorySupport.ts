import type { ApplicationScope } from "./applicationError";
import { relationalDatabase, sql, type RelationalDatabase, type SqlStatement } from "./relationalDatabase";

export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const email = (scope: ApplicationScope) => scope.userEmail?.trim().toLowerCase() || "";
export const rows = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query<T>(statement)).rows;
export const one = async <T extends Row>(statement: SqlStatement, db?: RelationalDatabase) =>
  (await rows<T>(statement, db))[0] ?? null;
export const changes = async (statement: SqlStatement, db?: RelationalDatabase) =>
  (await (db ?? await relationalDatabase()).query(statement)).changes;

export const projectAccess = (scope: ApplicationScope, owner = false) => owner || !email(scope)
  ? sql`p.user_id=${scope.userId}`
  : sql`(p.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM project_members pm
      WHERE pm.project_id=p.id AND pm.email=${email(scope)}))`;
export const reviewAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`r.user_id=${scope.userId}`
  : sql`(r.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM tabular_review_members rm
      WHERE rm.review_id=r.id AND rm.email=${email(scope)}) OR EXISTS(
      SELECT 1 FROM projects p WHERE p.id=r.project_id AND ${projectAccess(scope)}))`;
export const documentAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`d.user_id=${scope.userId}`
  : sql`(d.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=d.project_id AND ${projectAccess(scope)}))`;
export const chatAccess = (scope: ApplicationScope, owner = false) => owner
  ? sql`c.user_id=${scope.userId}`
  : sql`(c.user_id=${scope.userId} OR EXISTS(SELECT 1 FROM projects p
      WHERE p.id=c.project_id AND ${projectAccess(scope)}) OR EXISTS(
      SELECT 1 FROM tabular_reviews r WHERE r.id=c.tabular_review_id
        AND ${reviewAccess(scope)}))`;

export async function missingProfileEmail(db: RelationalDatabase, emails: string[]) {
  if (db.engine === "sqlite") return emails[0] ?? null;
  const normalized = [...new Set(emails.map((value) => value.trim().toLowerCase()))];
  if (!normalized.length) return null;
  const found = new Set((await rows<{ email: string }>(sql`SELECT lower(email) email
    FROM user_profiles WHERE lower(email) IN(${sql.join(normalized)})`, db))
    .map(({ email: value }) => value));
  return normalized.find((value) => !found.has(value)) ?? null;
}
export async function replaceMembers(db: RelationalDatabase, table: "project_members" |
  "tabular_review_members", id: string, emails: string[]) {
  if (db.engine === "postgres") return;
  const foreignKey = table === "project_members" ? "project_id" : "review_id";
  await changes(sql`DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(foreignKey)}=${id}`, db);
  for (const value of [...new Set(emails.map((item) => item.trim().toLowerCase()))]) {
    await changes(sql`INSERT INTO ${sql.raw(table)}(${sql.raw(foreignKey)},email)
      VALUES(${id},${value})`, db);
  }
}
