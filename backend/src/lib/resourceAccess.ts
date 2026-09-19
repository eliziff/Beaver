import type { ApplicationScope } from "./applicationError";
import { sql } from "./relational";

export type ResourceRole = "viewer" | "editor" | "owner";
export type AccessLevel = "view" | "edit" | "owner";
export const roleFromRank = (rank: unknown): ResourceRole | null =>
  Number(rank) === 3 ? "owner" : Number(rank) === 2 ? "editor" : Number(rank) === 1 ? "viewer" : null;
const email = (scope: ApplicationScope) => scope.userEmail?.trim().toLowerCase() || "";
const rank = (column: ReturnType<typeof sql>) => sql`CASE ${column}
  WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END`;
const threshold = (level: AccessLevel) => ({ view: 1, edit: 2, owner: 3 })[level];

/** An organization is an exclusive audience: stale direct grants never bypass it. */
function organizationRole(scope: ApplicationScope, kind: "project" | "workflow") {
  const alias = kind === "project" ? "p" : "w";
  const id = sql.raw(`${alias}.id`), org = sql.raw(`${alias}.org_id`), creator = sql.raw(`${alias}.user_id`);
  return sql`COALESCE((SELECT CASE WHEN ${creator}=${scope.userId} OR om.role='admin' THEN 3
    ELSE COALESCE((SELECT ${rank(sql.raw("ov.role"))} FROM ${sql.raw(`${kind}_org_access_overrides`)} ov
      WHERE ov.${sql.raw(`${kind}_id`)}=${id} AND ov.org_id=${org} AND ov.user_id=om.user_id),2) END
    FROM org_members om WHERE om.org_id=${org} AND om.user_id=${scope.userId}),0)`;
}

export const projectRoleRank = (scope: ApplicationScope) => sql`(CASE
  WHEN p.org_id IS NOT NULL THEN ${organizationRole(scope, "project")}
  WHEN p.user_id=${scope.userId} THEN 3 ELSE COALESCE((SELECT ${rank(sql.raw("pm.role"))}
    FROM project_members pm WHERE pm.project_id=p.id AND pm.email=${email(scope)} AND ${email(scope)}<>''),0) END)`;
export const projectAccess = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`${projectRoleRank(scope)}>=${threshold(level)}`;

export const reviewRoleRank = (scope: ApplicationScope) => sql`(CASE
  WHEN r.project_id IS NOT NULL THEN COALESCE((SELECT ${projectRoleRank(scope)} FROM projects p WHERE p.id=r.project_id),0)
  WHEN r.user_id=${scope.userId} THEN 3 ELSE COALESCE((SELECT ${rank(sql.raw("rm.role"))}
    FROM tabular_review_members rm WHERE rm.review_id=r.id AND rm.email=${email(scope)} AND ${email(scope)}<>''),0) END)`;
export const reviewAccess = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`${reviewRoleRank(scope)}>=${threshold(level)}`;

export const documentAccess = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`(CASE WHEN d.project_id IS NOT NULL THEN COALESCE((SELECT ${projectRoleRank(scope)}
    FROM projects p WHERE p.id=d.project_id),0) WHEN d.user_id=${scope.userId} THEN 3 ELSE 0 END)>=${threshold(level)}`;

const workProductRoleRank = (scope: ApplicationScope) => sql`(CASE WHEN w.project_id IS NOT NULL
  THEN COALESCE((SELECT ${projectRoleRank(scope)} FROM projects p WHERE p.id=w.project_id),0)
  WHEN w.user_id=${scope.userId} THEN 3 ELSE 0 END)`;
export const workProductAccess = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`${workProductRoleRank(scope)}>=${threshold(level)}`;

export const chatRoleRank = (scope: ApplicationScope) => sql`(CASE
  WHEN c.project_id IS NOT NULL THEN COALESCE((SELECT ${projectRoleRank(scope)} FROM projects p WHERE p.id=c.project_id),0)
  WHEN c.tabular_review_id IS NOT NULL THEN COALESCE((SELECT ${reviewRoleRank(scope)} FROM tabular_reviews r WHERE r.id=c.tabular_review_id),0)
  WHEN EXISTS(SELECT 1 FROM work_products w WHERE w.id=c.work_product_id AND w.project_id IS NOT NULL)
    THEN COALESCE((SELECT ${workProductRoleRank(scope)} FROM work_products w WHERE w.id=c.work_product_id),0)
  WHEN c.user_id=${scope.userId} THEN 3 ELSE COALESCE((SELECT ${rank(sql.raw("cm.role"))}
    FROM chat_members cm WHERE cm.chat_id=c.id AND cm.email=${email(scope)} AND ${email(scope)}<>''),0) END)`;
export const chatAccess = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`${chatRoleRank(scope)}>=${threshold(level)}`;

export const workflowRoleRank = (scope: ApplicationScope) => sql`(CASE
  WHEN w.org_id IS NOT NULL THEN ${organizationRole(scope, "workflow")}
  WHEN w.user_id=${scope.userId} THEN 3 ELSE COALESCE((SELECT ${rank(sql.raw("ws.role"))}
    FROM workflow_shares ws WHERE ws.workflow_id=w.id AND ws.shared_with_email=${email(scope)} AND ${email(scope)}<>''),0) END)`;
export const workflowAccessPredicate = (scope: ApplicationScope, level: AccessLevel = "view") =>
  sql`${workflowRoleRank(scope)}>=${threshold(level)}`;
