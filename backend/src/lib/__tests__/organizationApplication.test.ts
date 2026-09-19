import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LocalDatabase } from "../localDatabase";
import { sql } from "../relational";
import { createOrganizationApplication } from "../organizationApplication";
import { projectAccess, documentAccess, chatAccess, reviewAccess } from "../resourceAccess";

const owner = { userId: randomUUID(), userEmail: "owner@example.test" },
  member = { userId: randomUUID(), userEmail: "member@example.test" },
  outsider = { userId: randomUUID(), userEmail: "outsider@example.test" };
let db: LocalDatabase, application: ReturnType<typeof createOrganizationApplication>;
beforeEach(() => {
  const native = new DatabaseSync(":memory:");
  native.exec("PRAGMA foreign_keys=ON");
  native.exec(/-- BEAVER_CORE_BEGIN\s*([\s\S]*?)\s*-- BEAVER_CORE_END/u.exec(readFileSync("schema.sql", "utf8"))![1]);
  db = new LocalDatabase(native); application = createOrganizationApplication(db);
});
afterEach(() => db.close());
async function fixture() {
  const organization = await application.create(owner, "Team");
  const orgId = String(organization.id), { token } = await application.invite(owner, orgId, member.userEmail, "member");
  await application.accept(member, token);
  const projectId = randomUUID();
  await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at)
    VALUES(${projectId},${owner.userId},'Matter','now','now')`);
  await application.setOrganization(owner, "project", projectId, orgId);
  return { orgId, projectId };
}
it("binds one-use invitations to the intended account and fences revoked links", async () => {
  const org = String((await application.create(owner, "Team")).id);
  const first = await application.invite(owner, org, member.userEmail, "member");
  await expect(application.accept(outsider, first.token)).rejects.toMatchObject({ status: 404 });
  const replacement = await application.invite(owner, org, member.userEmail, "member");
  await expect(application.accept(member, first.token)).rejects.toMatchObject({ status: 404 });
  await application.accept(member, replacement.token);
  await expect(application.accept(member, replacement.token)).rejects.toMatchObject({ status: 404 });
  expect((await application.list(member)).organizations).toHaveLength(1);
  expect((await application.list(outsider)).organizations).toHaveLength(0);
});
it("keeps an admin when two admins concurrently leave", async () => {
  const { orgId } = await fixture();
  await application.member(owner, orgId, member.userId, "admin");
  const results = await Promise.allSettled([application.member(owner, orgId, owner.userId, null),
    application.member(member, orgId, member.userId, null)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await db.query(sql`SELECT user_id FROM org_members WHERE org_id=${orgId} AND role='admin'`)).rows).toHaveLength(1);
});
it("enforces editor, viewer and deny through every descendant and ignores stale direct shares", async () => {
  const { orgId, projectId } = await fixture();
  const doc = randomUUID(), chat = randomUUID(), review = randomUUID();
  await db.query(sql`INSERT INTO documents(id,user_id,project_id,filename,current_version_id,created_at,updated_at)
    VALUES(${doc},${member.userId},${projectId},'Evidence.txt','v','now','now')`);
  await db.query(sql`INSERT INTO tabular_reviews(id,user_id,project_id,created_at,updated_at)
    VALUES(${review},${member.userId},${projectId},'now','now')`);
  await db.query(sql`INSERT INTO chats(id,user_id,project_id,tabular_review_id,created_at,updated_at)
    VALUES(${chat},${member.userId},${null},${review},'now','now')`);
  await db.query(sql`INSERT INTO project_members(project_id,email,role) VALUES(${projectId},${member.userEmail},'owner')`);
  const visible = async (edit = false) => Promise.all([
    db.query(sql`SELECT id FROM projects p WHERE ${projectAccess(member, edit ? "edit" : "view")}`),
    db.query(sql`SELECT id FROM documents d WHERE ${documentAccess(member, edit ? "edit" : "view")}`),
    db.query(sql`SELECT id FROM chats c WHERE ${chatAccess(member, edit ? "edit" : "view")}`),
    db.query(sql`SELECT id FROM tabular_reviews r WHERE ${reviewAccess(member, edit ? "edit" : "view")}`),
  ]).then((results) => results.map((result) => result.rows.length));
  expect(await visible(true)).toEqual([1, 1, 1, 1]);
  await application.grant(owner, "project", projectId, member.userEmail, "viewer");
  expect(await visible()).toEqual([1, 1, 1, 1]);
  expect(await visible(true)).toEqual([0, 0, 0, 0]);
  await application.grant(owner, "project", projectId, member.userEmail, "deny");
  expect(await visible()).toEqual([0, 0, 0, 0]);
  await application.grant(owner, "project", projectId, member.userEmail, null);
  await application.member(owner, orgId, member.userId, null);
  expect(await visible()).toEqual([0, 0, 0, 0]);
});
it("protects creator/admin ownership, rejects outsider grants and refuses to delete nonempty organizations", async () => {
  const { orgId, projectId } = await fixture();
  await expect(application.grant(owner, "project", projectId, owner.userEmail, "deny")).rejects.toMatchObject({ status: 409 });
  await expect(application.grant(member, "project", projectId, outsider.userEmail, "owner")).rejects.toMatchObject({ status: 403 });
  await expect(application.grant(owner, "project", projectId, outsider.userEmail, "viewer")).rejects.toMatchObject({ status: 400 });
  await expect(application.remove(owner, orgId)).rejects.toMatchObject({ status: 409 });
  await application.setOrganization(owner, "project", projectId, null);
  await application.remove(owner, orgId);
  expect((await application.list(owner)).organizations).toEqual([]);
});

it("exports only currently accessible content and omits encrypted credentials", async () => {
  const { buildUserDataExport } = await import("../userDataExport");
  const { orgId, projectId } = await fixture();
  const chat = randomUUID();
  await db.query(sql`INSERT INTO chats(id,user_id,project_id,created_at,updated_at)
    VALUES(${chat},${member.userId},${projectId},'now','now')`);
  await db.query(sql`INSERT INTO user_api_keys(user_id,provider,encrypted_key,iv,auth_tag,created_at,updated_at)
    VALUES(${member.userId},'openai','secret','secret','secret','now','now')`);
  const before = await buildUserDataExport(db, "account", member);
  expect(JSON.stringify(before.data)).toContain(chat);
  expect(JSON.stringify(before.data)).not.toContain("secret");
  await application.member(owner, orgId, member.userId, null);
  const after = await buildUserDataExport(db, "account", member);
  expect(JSON.stringify(after.data)).not.toContain(chat);
  expect(after.data.integrity.payload_sha256).not.toBe(before.data.integrity.payload_sha256);
});
it("clearing direct shares revokes access and retaining a member preserves their role", async () => {
  const { replaceMembers } = await import("../relationalRepositorySupport");
  const id = randomUUID();
  await db.query(sql`INSERT INTO projects(id,user_id,name,created_at,updated_at)
    VALUES(${id},${owner.userId},'Matter','now','now')`);
  await application.grant(owner, "project", id, member.userEmail, "viewer");
  await replaceMembers(db, "project_members", id, [member.userEmail]);
  expect((await application.access(member, "project", id)).role).toBe("viewer");
  await replaceMembers(db, "project_members", id, []);
  await expect(application.access(member, "project", id)).rejects.toMatchObject({ status: 404 });
});

it("keeps organization content when its creator deletes their account", async () => {
  const { prepareOrganizationAccountDeletion } = await import("../organizationApplication");
  const { orgId, projectId } = await fixture();
  await expect(prepareOrganizationAccountDeletion(db, owner)).rejects.toMatchObject({ status: 409 });
  await application.member(owner, orgId, member.userId, "admin");
  const doc = randomUUID(), review = randomUUID(), chat = randomUUID();
  await db.query(sql`INSERT INTO documents(id,user_id,project_id,filename,current_version_id,created_at,updated_at)
    VALUES(${doc},${owner.userId},${projectId},'Evidence.txt','v','now','now')`);
  await db.query(sql`INSERT INTO tabular_reviews(id,user_id,project_id,created_at,updated_at)
    VALUES(${review},${owner.userId},${projectId},'now','now')`);
  await db.query(sql`INSERT INTO chats(id,user_id,tabular_review_id,created_at,updated_at)
    VALUES(${chat},${owner.userId},${review},'now','now')`);
  await prepareOrganizationAccountDeletion(db, owner);
  for (const table of ["projects", "documents", "tabular_reviews", "chats"])
    expect((await db.query(sql`SELECT user_id FROM ${sql.raw(table)}`)).rows).toEqual([{ user_id: member.userId }]);
  expect((await application.list(owner)).organizations).toHaveLength(0);
});
