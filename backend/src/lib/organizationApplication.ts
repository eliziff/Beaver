import { randomBytes, randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { sha256 } from "./hash";
import { sql, type RelationalDatabase } from "./relational";
import { chatRoleRank, projectRoleRank, reviewRoleRank, roleFromRank,
  workflowRoleRank, type ResourceRole } from "./resourceAccess";

export type AccessResource = "project" | "workflow" | "chat" | "review";
const resources = {
  project: { table: "projects", alias: "p", grants: "project_members", key: "project_id", email: "email", rank: projectRoleRank },
  workflow: { table: "workflows", alias: "w", grants: "workflow_shares", key: "workflow_id", email: "shared_with_email", rank: workflowRoleRank },
  chat: { table: "chats", alias: "c", grants: "chat_members", key: "chat_id", email: "email", rank: chatRoleRank },
  review: { table: "tabular_reviews", alias: "r", grants: "tabular_review_members", key: "review_id", email: "email", rank: reviewRoleRank },
} as const;
const fail = (status: number, detail: string): never => { throw new ApplicationError(status, detail); };
const normalizedEmail = (value?: string | null) => value?.trim().toLowerCase() || "";
const timestamp = () => new Date().toISOString();

export function createOrganizationApplication(database: RelationalDatabase) {
  const organization = async (db: RelationalDatabase, scope: ApplicationScope, id: string, admin = false) => {
    if (admin && db.engine === "postgres") await db.query(sql`SELECT id FROM organizations WHERE id=${id} FOR UPDATE`);
    const row = (await db.query(sql`SELECT o.*,m.role FROM organizations o JOIN org_members m ON m.org_id=o.id
      WHERE o.id=${id} AND m.user_id=${scope.userId}`)).rows[0];
    if (!row) return fail(404, "Organization not found.");
    if (admin && row.role !== "admin") return fail(403, "An organization admin must make this change.");
    return row;
  };
  const resource = async (db: RelationalDatabase, scope: ApplicationScope, kind: AccessResource, id: string, write = false) => {
    const config = resources[kind], alias = sql.raw(config.alias);
    const row = (await db.query(sql`SELECT ${alias}.*,${config.rank(scope)} access_rank
      FROM ${sql.raw(config.table)} ${alias} WHERE ${alias}.id=${id}
      ${write && db.engine === "postgres" ? sql.raw(`FOR UPDATE OF ${config.alias}`) : sql.raw("")}`)).rows[0];
    if (!row || !Number(row.access_rank)) return fail(404, "Resource not found.");
    if (write && Number(row.access_rank) < 3) return fail(403, "An owner must manage access.");
    if (kind === "chat" && !row.project_id && row.work_product_id) {
      row.project_id = (await db.query(sql`SELECT project_id FROM work_products WHERE id=${String(row.work_product_id)}`)).rows[0]?.project_id ?? null;
    }
    return row;
  };
  const inherited = (kind: AccessResource, row: Record<string, unknown>) =>
    (kind === "chat" || kind === "review") && (row.project_id || row.tabular_review_id);

  return {
    async list(scope: ApplicationScope) {
      const [organizations, invitations] = await Promise.all([
        database.query(sql`SELECT o.*,m.role FROM organizations o JOIN org_members m ON m.org_id=o.id
          WHERE m.user_id=${scope.userId} ORDER BY o.name,o.id`),
        database.query(sql`SELECT i.id,i.org_id,o.name,i.role,i.expires_at FROM org_invitations i
          JOIN organizations o ON o.id=i.org_id WHERE i.email=${normalizedEmail(scope.userEmail)}
          AND i.expires_at>${timestamp()} ORDER BY i.created_at`),
      ]);
      return { organizations: organizations.rows, invitations: invitations.rows };
    },
    async create(scope: ApplicationScope, name: string) {
      const id = randomUUID(), created = timestamp();
      return database.transaction(async (db) => {
        await db.query(sql`INSERT INTO organizations(id,name,created_by,created_at,updated_at)
          VALUES(${id},${name},${scope.userId},${created},${created})`);
        await db.query(sql`INSERT INTO org_members(org_id,user_id,email,role,created_at)
          VALUES(${id},${scope.userId},${normalizedEmail(scope.userEmail) || null},'admin',${created})`);
        return organization(db, scope, id);
      });
    },
    async detail(scope: ApplicationScope, id: string) {
      const org = await organization(database, scope, id);
      const members = (await database.query(sql`SELECT m.user_id,m.email,m.role,u.display_name
        FROM org_members m LEFT JOIN user_preferences u ON u.user_id=m.user_id
        WHERE m.org_id=${id} ORDER BY m.created_at,m.user_id`)).rows;
      const invitations = org.role === "admin" ? (await database.query(sql`
        SELECT id,email,role,expires_at FROM org_invitations WHERE org_id=${id} ORDER BY created_at`)).rows : [];
      return { organization: org, members, invitations };
    },
    rename: (scope: ApplicationScope, id: string, name: string) => database.transaction(async (db) => {
      await organization(db, scope, id, true);
      await db.query(sql`UPDATE organizations SET name=${name},updated_at=${timestamp()} WHERE id=${id}`);
    }),
    remove: (scope: ApplicationScope, id: string) => database.transaction(async (db) => {
      await organization(db, scope, id, true);
      const contents = (await db.query(sql`SELECT id FROM projects WHERE org_id=${id}
        UNION ALL SELECT id FROM workflows WHERE org_id=${id}`)).rows;
      if (contents.length) return fail(409, "Move or delete the organization's projects and workflows first.");
      await db.query(sql`DELETE FROM organizations WHERE id=${id}`);
    }),
    member: (scope: ApplicationScope, id: string, userId: string, role: "admin" | "member" | null) =>
      database.transaction(async (db) => {
        const actor = await organization(db, scope, id, scope.userId !== userId || role !== null);
        // Leaving also serializes against all role changes, including concurrent admin departures.
        if (db.engine === "postgres") await db.query(sql`SELECT id FROM organizations WHERE id=${id} FOR UPDATE`);
        const target = (await db.query(sql`SELECT role FROM org_members WHERE org_id=${id} AND user_id=${userId}`)).rows[0];
        if (!target) return fail(404, "Member not found.");
        if (role !== null && actor.role !== "admin") return fail(403, "An organization admin must make this change.");
        if (target.role === "admin" && role !== "admin" && !(await db.query(sql`
          SELECT 1 FROM org_members WHERE org_id=${id} AND role='admin' AND user_id<>${userId}`)).rows.length)
          return fail(409, "Keep at least one organization admin.");
        if (role === null) await db.query(sql`DELETE FROM org_members WHERE org_id=${id} AND user_id=${userId}`);
        else await db.query(sql`UPDATE org_members SET role=${role} WHERE org_id=${id} AND user_id=${userId}`);
      }),
    invite: (scope: ApplicationScope, id: string, email: string, role: "admin" | "member") =>
      database.transaction(async (db) => {
        await organization(db, scope, id, true);
        const normalized = normalizedEmail(email);
        if ((await db.query(sql`SELECT 1 FROM org_members WHERE org_id=${id} AND email=${normalized}`)).rows.length)
          return fail(409, "This person is already a member.");
        const token = randomBytes(32).toString("base64url"), invitationId = randomUUID();
        await db.query(sql`INSERT INTO org_invitations(id,org_id,email,role,token_hash,expires_at,created_by,created_at)
          VALUES(${invitationId},${id},${normalized},${role},${sha256(token)},
            ${new Date(Date.now() + 7 * 86_400_000).toISOString()},${scope.userId},${timestamp()})
          ON CONFLICT(org_id,email) DO UPDATE SET token_hash=excluded.token_hash,role=excluded.role,
            expires_at=excluded.expires_at,created_by=excluded.created_by`);
        return { token };
      }),
    revokeInvitation: (scope: ApplicationScope, id: string, invitationId: string) =>
      database.transaction(async (db) => {
        await organization(db, scope, id, true);
        await db.query(sql`DELETE FROM org_invitations WHERE id=${invitationId} AND org_id=${id}`);
      }),
    accept: (scope: ApplicationScope, token: string) => database.transaction(async (db) => {
      const row = (await db.query(sql`SELECT * FROM org_invitations WHERE token_hash=${sha256(token)}
        AND email=${normalizedEmail(scope.userEmail)} AND expires_at>${timestamp()}
        ${db.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`)).rows[0];
      if (!row) return fail(404, "Invitation is unavailable or belongs to another account.");
      await db.query(sql`INSERT INTO org_members(org_id,user_id,email,role,created_at)
        VALUES(${String(row.org_id)},${scope.userId},${normalizedEmail(scope.userEmail)},${String(row.role)},${timestamp()})
        ON CONFLICT(org_id,user_id) DO NOTHING`);
      await db.query(sql`DELETE FROM org_invitations WHERE id=${String(row.id)}`);
      return { org_id: String(row.org_id) };
    }),
    async access(scope: ApplicationScope, kind: AccessResource, id: string) {
      const row = await resource(database, scope, kind, id), config = resources[kind];
      if (inherited(kind, row)) return { role: roleFromRank(row.access_rank),
        inherited: { kind: row.project_id ? "project" : "review", id: row.project_id ?? row.tabular_review_id }, grants: [] };
      const grants = row.org_id ? (await database.query(sql`SELECT m.user_id,m.email,
        CASE WHEN m.user_id=${String(row.user_id)} OR m.role='admin' THEN 'owner' ELSE COALESCE(o.role,'editor') END role,
        CASE WHEN m.user_id=${String(row.user_id)} OR m.role='admin' THEN 1 ELSE 0 END fixed
        FROM org_members m LEFT JOIN ${sql.raw(`${kind}_org_access_overrides`)} o
          ON o.org_id=m.org_id AND o.user_id=m.user_id AND o.${sql.raw(config.key)}=${id}
        WHERE m.org_id=${String(row.org_id)} ORDER BY m.email`)).rows
        : (await database.query(sql`SELECT ${sql.raw(config.email)} email,role FROM ${sql.raw(config.grants)}
          WHERE ${sql.raw(config.key)}=${id} ORDER BY ${sql.raw(config.email)}`)).rows;
      return { role: roleFromRank(row.access_rank), org_id: row.org_id ?? null, owner_id: row.user_id, grants };
    },
    grant: (scope: ApplicationScope, kind: AccessResource, id: string, email: string, role: ResourceRole | "deny" | null) =>
      database.transaction(async (db) => {
        const row = await resource(db, scope, kind, id, true), config = resources[kind], normalized = normalizedEmail(email);
        if (inherited(kind, row)) return fail(409, "Manage access on the parent resource.");
        if (row.org_id) {
          const member = (await db.query(sql`SELECT user_id,role FROM org_members
            WHERE org_id=${String(row.org_id)} AND email=${normalized}`)).rows[0];
          if (!member) return fail(400, "Only organization members can receive access.");
          if (member.user_id === row.user_id || member.role === "admin") return fail(409, "Creators and organization admins retain owner access.");
          const table = sql.raw(`${kind}_org_access_overrides`), userId = String(member.user_id);
          if (role === null) await db.query(sql`DELETE FROM ${table} WHERE ${sql.raw(config.key)}=${id} AND user_id=${userId}`);
          else await db.query(sql`INSERT INTO ${table}(${sql.raw(config.key)},org_id,user_id,role)
            VALUES(${id},${String(row.org_id)},${userId},${role}) ON CONFLICT(${sql.raw(config.key)},user_id)
            DO UPDATE SET role=excluded.role`);
        } else {
          if (role === "deny") return fail(400, "Remove a direct grant to revoke access.");
          const table = sql.raw(config.grants), key = sql.raw(config.key), column = sql.raw(config.email);
          if (role === null) await db.query(sql`DELETE FROM ${table} WHERE ${key}=${id} AND ${column}=${normalized}`);
          else if (kind === "workflow") await db.query(sql`INSERT INTO workflow_shares(id,workflow_id,
            shared_by_user_id,shared_with_email,role,created_at) VALUES(${randomUUID()},${id},${scope.userId},
            ${normalized},${role},${timestamp()}) ON CONFLICT(workflow_id,shared_with_email) DO UPDATE SET role=excluded.role`);
          else await db.query(sql`INSERT INTO ${table}(${key},${column},role) VALUES(${id},${normalized},${role})
            ON CONFLICT(${key},${column}) DO UPDATE SET role=excluded.role`);
          if (kind === "project" || kind === "review") {
            const emails = (await db.query(sql`SELECT email FROM ${table} WHERE ${key}=${id} ORDER BY email`)).rows.map((grant) => grant.email);
            await db.query(sql`UPDATE ${sql.raw(config.table)} SET shared_with=${JSON.stringify(emails)} WHERE id=${id}`);
          }
        }
      }),
    setOrganization: (scope: ApplicationScope, kind: "project" | "workflow", id: string, orgId: string | null) =>
      database.transaction(async (db) => {
        const row = await resource(db, scope, kind, id, true), config = resources[kind];
        if ((row.org_id ?? null) === orgId) return;
        if (orgId) {
          await organization(db, scope, orgId, true);
          if (!(await db.query(sql`SELECT 1 FROM org_members WHERE org_id=${orgId} AND user_id=${String(row.user_id)}`)).rows.length)
            return fail(409, "The resource creator must join the destination organization first.");
        } else if (row.user_id !== scope.userId) return fail(403, "Only the creator can move this resource to personal ownership.");
        await db.query(sql`DELETE FROM ${sql.raw(`${kind}_org_access_overrides`)} WHERE ${sql.raw(config.key)}=${id}`);
        await db.query(sql`DELETE FROM ${sql.raw(config.grants)} WHERE ${sql.raw(config.key)}=${id}`);
        await db.query(sql`UPDATE ${sql.raw(config.table)} SET org_id=${orgId},updated_at=${timestamp()}
          ${kind === "project" ? sql`,shared_with='[]'` : sql.raw("")} WHERE id=${id}`);
      }),
  };
}

/** Retain organization work when an account is deleted, including work by former members. */
export async function prepareOrganizationAccountDeletion(database: RelationalDatabase, scope: ApplicationScope) {
  await database.transaction(async (db) => {
    // Common lock order with membership changes; no organization can lose its last admin.
    const organizations = (await db.query(sql`SELECT id FROM organizations ORDER BY id
      ${db.engine === "postgres" ? sql.raw("FOR UPDATE") : sql.raw("")}`)).rows;
    for (const organization of organizations) {
      const orgId = String(organization.id);
      const remaining = (await db.query(sql`SELECT user_id FROM org_members WHERE org_id=${orgId}
        AND role='admin' AND user_id<>${scope.userId} ORDER BY created_at,user_id LIMIT 1`)).rows[0];
      const membership = (await db.query(sql`SELECT role FROM org_members WHERE org_id=${orgId} AND user_id=${scope.userId}`)).rows[0];
      if (!remaining) {
        if (membership?.role === "admin") return fail(409, "Choose another organization admin before deleting your account.");
        continue;
      }
      const successor = String(remaining.user_id);
      // Content storage addresses are immutable; changing custodians does not move blobs or rewrite authorship.
      for (const table of ["documents", "project_subfolders", "tabular_reviews", "work_products"])
        await db.query(sql`UPDATE ${sql.raw(table)} SET user_id=${successor} WHERE user_id=${scope.userId}
          AND project_id IN(SELECT id FROM projects WHERE org_id=${orgId})`);
      await db.query(sql`UPDATE chats SET user_id=${successor} WHERE user_id=${scope.userId} AND
        (project_id IN(SELECT id FROM projects WHERE org_id=${orgId}) OR tabular_review_id IN(
          SELECT r.id FROM tabular_reviews r JOIN projects p ON p.id=r.project_id WHERE p.org_id=${orgId}) OR work_product_id IN(
          SELECT w.id FROM work_products w JOIN projects p ON p.id=w.project_id WHERE p.org_id=${orgId}))`);
      for (const table of ["projects", "workflows"])
        await db.query(sql`UPDATE ${sql.raw(table)} SET user_id=${successor} WHERE user_id=${scope.userId} AND org_id=${orgId}`);
    }
    await db.query(sql`DELETE FROM org_members WHERE user_id=${scope.userId}`);
  });
}
