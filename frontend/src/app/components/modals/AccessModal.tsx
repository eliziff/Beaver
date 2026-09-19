import { useEffect, useState } from "react";
import { getResourceAccess, grantResourceAccess, listOrganizations, moveResourceToOrganization,
  type Access, type AccessRole, type Organization, type ResourceKind } from "@/app/lib/api/organizations";
import { errorMessage } from "@/app/lib/utils";
import { useMfaAction } from "../account/useMfaAction";
import { Button } from "../ui/button";
import { Modal } from "./Modal";

const field = "rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
export function AccessModal({ open, onClose, kind, resourceId, title, onChange }: {
  open: boolean; onClose(): void; kind: ResourceKind; resourceId: string;
  title: string; onChange?(): void | Promise<void>;
}) {
  const [target, setTarget] = useState({ kind, id: resourceId });
  const [access, setAccess] = useState<Access | null>(null), [organizations, setOrganizations] = useState<Organization[]>([]);
  const [revision, refresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { runMfa, mfaPopup } = useMfaAction();
  useEffect(() => { if (open) { setTarget({ kind, id: resourceId }); setError(""); } }, [open, kind, resourceId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false; setAccess(null);
    Promise.all([getResourceAccess(target.kind, target.id), listOrganizations()]).then(([data, list]) => {
      if (!cancelled) { setAccess(data); setOrganizations(list.organizations); }
    }).catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [open, target.kind, target.id, revision]);
  const mutate = (work: () => Promise<unknown>) => void runMfa(async () => {
    setBusy(true); setError("");
    try { await work(); refresh((value) => value + 1); await onChange?.(); }
    finally { setBusy(false); }
  }, { onError: (error) => setError(errorMessage(error)) });
  const owner = access?.role === "owner", roles: AccessRole[] = access?.org_id
    ? ["viewer", "editor", "owner", "deny"] : ["viewer", "editor", "owner"];
  return <><Modal open={open} onClose={onClose} breadcrumbs={[title, "Access"]}>
    <div className="space-y-4 p-5">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!access && !error && <p role="status">Loading access…</p>}
      {access?.inherited ? <div className="space-y-3">
        <p className="text-sm">This {target.kind} uses its parent’s access settings.</p>
        <Button onClick={() => setTarget(access.inherited!)}>Manage parent access</Button>
      </div> : access && <>
        <p className="text-sm">Your access: {access.role}</p>
        <ul className="divide-y divide-gray-200">
          {!access.org_id && <li className="flex justify-between py-3 text-sm"><span>Creator</span><span>Owner</span></li>}
          {access.grants.map((grant, index) => <li key={grant.email ?? grant.user_id ?? index} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <span className="min-w-0 break-all text-sm">{grant.email ?? "Local account"}</span>
            {owner && grant.email && !grant.fixed ? <div className="flex gap-2">
              <select aria-label={`Access for ${grant.email}`} value={grant.role} disabled={busy}
                className={field} onChange={(event) => mutate(() => grantResourceAccess(target.kind, target.id, grant.email!, event.target.value as AccessRole))}>
                {roles.map((role) => <option key={role} value={role}>{role === "deny" ? "No access" : role[0].toUpperCase() + role.slice(1)}</option>)}
              </select>
              <Button variant="outline" disabled={busy} onClick={() => mutate(() => grantResourceAccess(target.kind, target.id, grant.email!, null))}>
                {access.org_id ? "Reset" : "Remove"}</Button>
            </div> : <span className="text-sm">{grant.role}</span>}
          </li>)}
        </ul>
        {owner && !access.org_id && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
          mutate(async () => { await grantResourceAccess(target.kind, target.id, String(data.get("email")), String(data.get("role")) as AccessRole); form.reset(); });
        }}>
          <label className="grid flex-1 gap-1 text-sm">Email<input name="email" type="email" required maxLength={320} className={field} disabled={busy} /></label>
          <label className="grid gap-1 text-sm">Access<select name="role" className={field} defaultValue="viewer" disabled={busy}>
            {roles.map((role) => <option key={role}>{role}</option>)}</select></label>
          <Button type="submit" disabled={busy}>Share</Button>
        </form>}
        {owner && (target.kind === "project" || target.kind === "workflow") && <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault(); const next = String(new FormData(event.currentTarget).get("organization"));
          if (next !== (access.org_id ?? "")) mutate(() => moveResourceToOrganization(target.kind as "project" | "workflow", target.id, next || null));
        }}>
          <label className="grid gap-1 text-sm">Organization<select key={access.org_id ?? "personal"} name="organization" defaultValue={access.org_id ?? ""} className={field} disabled={busy}>
            <option value="">Personal</option>{organizations.filter((org) => org.role === "admin" || org.id === access.org_id)
              .map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select></label>
          <p className="text-xs text-gray-600">Moving clears existing direct shares and access overrides.</p>
          <Button type="submit" variant="outline" disabled={busy}>Move</Button>
        </form>}
      </>}
    </div>
  </Modal>{mfaPopup}</>;
}
