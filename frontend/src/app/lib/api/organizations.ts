import { apiRequest, patch, post, put, remove, segment } from "./client";
export type Organization = { id: string; name: string; role: "admin" | "member" };
export type ResourceKind = "project" | "workflow" | "review" | "chat";
export type AccessRole = "viewer" | "editor" | "owner" | "deny";
export type Access = { role: AccessRole; org_id?: string | null; owner_id?: string;
  inherited?: { kind: ResourceKind; id: string }; grants: { email: string | null; user_id?: string; role: AccessRole; fixed?: number }[] };
export type OrganizationDetail = { organization: Organization;
  members: { user_id: string; email: string | null; display_name: string | null; role: "admin" | "member" }[];
  invitations: { id: string; email: string; role: "admin" | "member"; expires_at: string }[] };
const root = "/organizations";
export const listOrganizations = () => apiRequest<{ organizations: Organization[];
  invitations: { id: string; org_id: string; name: string; role: string; expires_at: string }[] }>(root);
export const createOrganization = (name: string) => post<Organization>(root, { name });
export const getOrganization = (id: string) => apiRequest<OrganizationDetail>(`${root}/${segment(id)}`);
export const renameOrganization = (id: string, name: string) => patch<void>(`${root}/${segment(id)}`, { name });
export const deleteOrganization = (id: string) => remove<void>(`${root}/${segment(id)}`);
export const changeOrganizationMember = (id: string, userId: string, role: "admin" | "member" | null) =>
  put<void>(`${root}/${segment(id)}/members/${segment(userId)}`, { role });
export const inviteOrganizationMember = (id: string, email: string, role: "admin" | "member") =>
  post<{ token: string }>(`${root}/${segment(id)}/invitations`, { email, role });
export const revokeOrganizationInvitation = (id: string, invitation: string) =>
  remove<void>(`${root}/${segment(id)}/invitations/${segment(invitation)}`);
export const acceptOrganizationInvitation = (token: string) => post<{ org_id: string }>(`${root}/invitations/accept`, { token });
const accessPath = (kind: ResourceKind, id: string) => `${root}/resources/${kind}/${segment(id)}`;
export const getResourceAccess = (kind: ResourceKind, id: string) => apiRequest<Access>(`${accessPath(kind, id)}/access`);
export const grantResourceAccess = (kind: ResourceKind, id: string, email: string, role: AccessRole | null) =>
  put<void>(`${accessPath(kind, id)}/access`, { email, role });
export const moveResourceToOrganization = (kind: "project" | "workflow", id: string, org_id: string | null) =>
  put<void>(`${accessPath(kind, id)}/organization`, { org_id });
