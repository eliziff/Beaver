import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { applicationScope } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import type { createOrganizationApplication } from "../lib/organizationApplication";

const id = z.string().uuid(), name = z.string().trim().min(1).max(160);
const kind = z.enum(["project", "workflow", "chat", "review"]);
const orgRole = z.enum(["admin", "member"]);
const grant = z.object({ email: z.string().trim().email().max(320),
  role: z.enum(["viewer", "editor", "owner", "deny"]).nullable() }).strict();
export function createOrganizationRouter(application: ReturnType<typeof createOrganizationApplication>) {
  const router = Router();
  router.use(requireAuth);
  router.get("/", asyncRoute(async (_req, res) => res.json(await application.list(applicationScope(res)))));
  router.post("/", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const input = z.object({ name }).strict().parse(req.body);
    res.status(201).json(await application.create(applicationScope(res), input.name));
  }));
  router.post("/invitations/accept", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const input = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict().parse(req.body);
    res.json(await application.accept(applicationScope(res), input.token));
  }));
  router.get("/resources/:kind/:id/access", asyncRoute(async (req, res) =>
    res.json(await application.access(applicationScope(res), kind.parse(req.params.kind), id.parse(req.params.id)))));
  router.put("/resources/:kind/:id/access", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const input = grant.parse(req.body);
    await application.grant(applicationScope(res), kind.parse(req.params.kind), id.parse(req.params.id), input.email, input.role);
    res.sendStatus(204);
  }));
  router.put("/resources/:kind/:id/organization", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const input = z.object({ org_id: id.nullable() }).strict().parse(req.body);
    await application.setOrganization(applicationScope(res), z.enum(["project", "workflow"]).parse(req.params.kind),
      id.parse(req.params.id), input.org_id);
    res.sendStatus(204);
  }));
  router.get("/:id", asyncRoute(async (req, res) => res.json(await application.detail(applicationScope(res), id.parse(req.params.id)))));
  router.patch("/:id", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    await application.rename(applicationScope(res), id.parse(req.params.id), z.object({ name }).strict().parse(req.body).name);
    res.sendStatus(204);
  }));
  router.delete("/:id", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    await application.remove(applicationScope(res), id.parse(req.params.id)); res.sendStatus(204);
  }));
  router.put("/:id/members/:userId", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    await application.member(applicationScope(res), id.parse(req.params.id), id.parse(req.params.userId),
      z.object({ role: orgRole.nullable() }).strict().parse(req.body).role);
    res.sendStatus(204);
  }));
  router.post("/:id/invitations", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const input = z.object({ email: grant.shape.email, role: orgRole }).strict().parse(req.body);
    res.status(201).json(await application.invite(applicationScope(res), id.parse(req.params.id), input.email, input.role));
  }));
  router.delete("/:id/invitations/:invitationId", requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    await application.revokeInvitation(applicationScope(res), id.parse(req.params.id), id.parse(req.params.invitationId));
    res.sendStatus(204);
  }));
  return router;
}
